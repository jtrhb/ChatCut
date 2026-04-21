import { describe, it, expect, vi } from "vitest";
import type {
  GpuServiceClient,
  JobStatusResult,
} from "../gpu-service-client.js";
import { pollUntilTerminal } from "../poll-job.js";

function makeClient(
  statusSequence: JobStatusResult[],
): { client: GpuServiceClient; calls: { jobId: string }[] } {
  const calls: { jobId: string }[] = [];
  let i = 0;
  const client = {
    async getJobStatus(jobId: string): Promise<JobStatusResult> {
      calls.push({ jobId });
      const next = statusSequence[Math.min(i, statusSequence.length - 1)]!;
      i++;
      return next;
    },
  } as unknown as GpuServiceClient;
  return { client, calls };
}

const QUEUED: JobStatusResult = { job_id: "j1", state: "queued", progress: 0 };
const RUNNING_50: JobStatusResult = {
  job_id: "j1",
  state: "running",
  progress: 50,
};
const DONE: JobStatusResult = {
  job_id: "j1",
  state: "done",
  progress: 100,
  result: { storage_key: "previews/exp/cand.mp4" },
};
const FAILED: JobStatusResult = {
  job_id: "j1",
  state: "failed",
  progress: 30,
  error: "render boom",
};

describe("pollUntilTerminal", () => {
  it("returns immediately when first poll is done", async () => {
    const { client, calls } = makeClient([DONE]);
    const result = await pollUntilTerminal(client, "j1", {
      sleep: vi.fn(),
      now: () => 0,
    });
    expect(result).toEqual(DONE);
    expect(calls).toHaveLength(1);
  });

  it("returns immediately when first poll is failed", async () => {
    const { client, calls } = makeClient([FAILED]);
    const result = await pollUntilTerminal(client, "j1", {
      sleep: vi.fn(),
      now: () => 0,
    });
    expect(result).toEqual(FAILED);
    expect(calls).toHaveLength(1);
  });

  it("polls through queued → running → done", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { client, calls } = makeClient([QUEUED, RUNNING_50, DONE]);
    const result = await pollUntilTerminal(client, "j1", {
      sleep,
      now: () => 0,
      intervalMs: 100,
    });
    expect(result).toEqual(DONE);
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("synthesizes failed status with synthesized=true when timeout exceeded", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const now = vi.fn(() => {
      const v = t;
      t += 600;
      return v;
    });
    const { client, calls } = makeClient([RUNNING_50, RUNNING_50, RUNNING_50]);
    const result = await pollUntilTerminal(client, "j1", {
      sleep,
      now,
      intervalMs: 50,
      timeoutMs: 1000,
    });
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error).toContain("polling timeout after 1000ms");
      // Reviewer Stage C HIGH #2: callers can distinguish real failure
      // ("GPU said failed") from synthesized timeout ("agent gave up;
      // GPU may still be running").
      expect(result.synthesized).toBe(true);
    }
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("real-failure (GPU-reported) sets synthesized=undefined (not a flag)", async () => {
    const { client } = makeClient([FAILED]);
    const result = await pollUntilTerminal(client, "j1", {
      sleep: vi.fn(),
      now: () => 0,
    });
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.synthesized).toBeUndefined();
    }
  });

  it("propagates errors from getJobStatus", async () => {
    const client = {
      async getJobStatus() {
        throw new Error("network error");
      },
    } as unknown as GpuServiceClient;
    await expect(
      pollUntilTerminal(client, "j1", { sleep: vi.fn(), now: () => 0 }),
    ).rejects.toThrow("network error");
  });

  it("uses default interval (1500ms) and timeout (90000ms) when omitted", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { client } = makeClient([RUNNING_50, DONE]);
    await pollUntilTerminal(client, "j1", { sleep, now: () => 0 });
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  // ── Stage D.1: backoff (1.5s → 5s after 30s no-change) ─────────────────

  describe("backoff (D.1)", () => {
    it("ramps from initialIntervalMs to maxIntervalMs after no-change window", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      // Time stream: each now() bumps clock by 10s. After 4 calls of the
      // same progress (0, 10s, 20s, 30s), backoff should kick in on the
      // 5th sleep.
      let t = 0;
      const now = vi.fn(() => {
        const v = t;
        t += 10_000;
        return v;
      });
      // 5 consecutive RUNNING_50 polls (progress doesn't change) then DONE.
      const { client } = makeClient([
        RUNNING_50,
        RUNNING_50,
        RUNNING_50,
        RUNNING_50,
        RUNNING_50,
        DONE,
      ]);
      await pollUntilTerminal(client, "j1", {
        sleep,
        now,
        intervalMs: 1500,
        maxIntervalMs: 5000,
        noChangeBackoffMs: 30_000,
        timeoutMs: 1_000_000,
      });
      // First few sleeps are at the initial interval, later sleeps clamp
      // to the max interval once stagnation crosses the threshold.
      const sleepArgs = sleep.mock.calls.map((c) => c[0]);
      expect(sleepArgs).toContain(1500);
      expect(sleepArgs).toContain(5000);
    });

    it("snaps interval back to initial when progress moves", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      let t = 0;
      const now = vi.fn(() => {
        const v = t;
        t += 10_000;
        return v;
      });
      // Stagnate, ramp, then progress finally moves → next sleep should
      // drop back to initial because the stagnation timer resets.
      const RUNNING_75: JobStatusResult = {
        job_id: "j1",
        state: "running",
        progress: 75,
      };
      const { client } = makeClient([
        RUNNING_50,
        RUNNING_50,
        RUNNING_50,
        RUNNING_50, // stagnant — backoff kicks in
        RUNNING_75, // progress moved — should snap back
        DONE,
      ]);
      await pollUntilTerminal(client, "j1", {
        sleep,
        now,
        intervalMs: 1500,
        maxIntervalMs: 5000,
        noChangeBackoffMs: 30_000,
        timeoutMs: 1_000_000,
      });
      const sleepArgs = sleep.mock.calls.map((c) => c[0]);
      // Last sleep before DONE should be the initial interval (post-snap-back).
      expect(sleepArgs[sleepArgs.length - 1]).toBe(1500);
    });

    it("never sleeps longer than maxIntervalMs", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      let t = 0;
      const now = vi.fn(() => {
        const v = t;
        t += 60_000;
        return v;
      });
      const { client } = makeClient([
        RUNNING_50,
        RUNNING_50,
        RUNNING_50,
        DONE,
      ]);
      await pollUntilTerminal(client, "j1", {
        sleep,
        now,
        intervalMs: 1500,
        maxIntervalMs: 5000,
        noChangeBackoffMs: 30_000,
        timeoutMs: 1_000_000,
      });
      const sleepArgs = sleep.mock.calls.map((c) => c[0]);
      for (const s of sleepArgs) {
        expect(s).toBeLessThanOrEqual(5000);
      }
    });
  });

  // ── Stage D.2: onProgress callback ─────────────────────────────────────

  describe("onProgress (D.2)", () => {
    it("fires once per poll cycle including the terminal state", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const RUNNING_25: JobStatusResult = {
        job_id: "j1",
        state: "running",
        progress: 25,
      };
      const { client } = makeClient([RUNNING_25, RUNNING_50, DONE]);
      const onProgress = vi.fn();
      await pollUntilTerminal(client, "j1", {
        sleep,
        now: () => 0,
        intervalMs: 100,
        onProgress,
      });
      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress.mock.calls[0]![0].progress).toBe(25);
      expect(onProgress.mock.calls[1]![0].progress).toBe(50);
      expect(onProgress.mock.calls[2]![0].state).toBe("done");
    });

    it("fires onProgress with the synthesized terminal status on timeout", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      let t = 0;
      const now = vi.fn(() => {
        const v = t;
        t += 600;
        return v;
      });
      const { client } = makeClient([RUNNING_50, RUNNING_50, RUNNING_50]);
      const onProgress = vi.fn();
      await pollUntilTerminal(client, "j1", {
        sleep,
        now,
        intervalMs: 50,
        timeoutMs: 1000,
        onProgress,
      });
      // Last call should be the synthesized failed status.
      const last = onProgress.mock.calls[onProgress.mock.calls.length - 1]![0];
      expect(last.state).toBe("failed");
      expect(last.synthesized).toBe(true);
    });

    it("swallows onProgress errors (best-effort)", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const { client } = makeClient([RUNNING_50, DONE]);
      const onProgress = vi.fn(() => {
        throw new Error("sse disconnected");
      });
      // Must not throw.
      const result = await pollUntilTerminal(client, "j1", {
        sleep,
        now: () => 0,
        intervalMs: 100,
        onProgress,
      });
      expect(result.state).toBe("done");
      expect(onProgress).toHaveBeenCalled();
    });
  });

  it("preserves last status fields when synthesizing timeout failure", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const now = vi.fn(() => {
      const v = t;
      t += 600;
      return v;
    });
    const partialRun: JobStatusResult = {
      job_id: "j-special",
      state: "running",
      progress: 73,
    };
    const { client } = makeClient([partialRun, partialRun]);
    const result = await pollUntilTerminal(client, "j-special", {
      sleep,
      now,
      timeoutMs: 500,
    });
    expect(result.job_id).toBe("j-special");
    expect(result.progress).toBe(73);
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.synthesized).toBe(true);
    }
  });
});
