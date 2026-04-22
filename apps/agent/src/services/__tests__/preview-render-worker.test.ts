import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { RuntimeEvent } from "../../events/types.js";
import {
  GpuServiceError,
  type GpuServiceClient,
  type JobStatusResult,
} from "../gpu-service-client.js";
import { handlePreviewRender } from "../preview-render-worker.js";
import type { PreviewWriteback } from "../preview-writeback.js";

function fakeWriteback(opts?: {
  successThrows?: Error;
  failureThrows?: Error;
}): PreviewWriteback & {
  recordSuccess: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
} {
  return {
    recordSuccess: vi.fn(async () => {
      if (opts?.successThrows) throw opts.successThrows;
    }),
    recordFailure: vi.fn(async () => {
      if (opts?.failureThrows) throw opts.failureThrows;
    }),
  };
}

const PAYLOAD = {
  explorationId: "exp-1",
  candidateId: "cand-1",
  snapshotStorageKey: "explorations/exp-1/abc.json",
};

function fakeClient(opts: {
  enqueueResult?: { jobId: string };
  enqueueThrows?: Error;
  statuses?: JobStatusResult[];
}): GpuServiceClient {
  let i = 0;
  return {
    async enqueueRender() {
      if (opts.enqueueThrows) throw opts.enqueueThrows;
      return opts.enqueueResult ?? { jobId: "j-default" };
    },
    async getJobStatus(): Promise<JobStatusResult> {
      const seq = opts.statuses ?? [];
      const next = seq[Math.min(i, seq.length - 1)] ?? {
        job_id: "j-default",
        state: "done",
        progress: 100,
      };
      i++;
      return next;
    },
  } as unknown as GpuServiceClient;
}

const NEVER_SLEEP = { sleep: vi.fn().mockResolvedValue(undefined), now: () => 0 };

describe("handlePreviewRender", () => {
  it("logs stub + returns when gpuClient is null", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: null, log, warn },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[preview-render stub\] explorationId=exp-1 candidateId=cand-1/),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns + skips when snapshotStorageKey missing (legacy payload)", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({});
    const enqueueSpy = vi.spyOn(client, "enqueueRender");
    await handlePreviewRender(
      {
        data: { explorationId: "e", candidateId: "c" } as any,
      },
      { gpuClient: client, log, warn },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/missing snapshotStorageKey for e\/c/),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("happy path: enqueue → poll done → log storage_key", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueResult: { jobId: "j-42" },
      statuses: [
        {
          job_id: "j-42",
          state: "done",
          progress: 100,
          result: { storage_key: "previews/exp/cand.mp4" },
        },
      ],
    });
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: client, log, warn, pollOpts: NEVER_SLEEP },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("enqueued explorationId=exp-1"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("→ previews/exp/cand.mp4"),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("polls through queued → running → done", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      enqueueResult: { jobId: "j-1" },
      statuses: [
        { job_id: "j-1", state: "queued", progress: 0 },
        { job_id: "j-1", state: "running", progress: 50 },
        {
          job_id: "j-1",
          state: "done",
          progress: 100,
          result: { storage_key: "previews/x/y.mp4" },
        },
      ],
    });
    await handlePreviewRender(
      { data: PAYLOAD },
      {
        gpuClient: client,
        log,
        warn,
        pollOpts: { sleep, now: () => 0, intervalMs: 50 },
      },
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("→ previews/x/y.mp4"),
    );
  });

  it("warns when poll terminates with state=failed", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueResult: { jobId: "j-99" },
      statuses: [
        {
          job_id: "j-99",
          state: "failed",
          progress: 30,
          error: "melt subprocess crashed",
        },
      ],
    });
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: client, log, warn, pollOpts: NEVER_SLEEP },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("melt subprocess crashed"),
    );
  });

  it("warns when poll synthesizes failure on timeout", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const now = vi.fn(() => {
      const v = t;
      t += 600;
      return v;
    });
    const client = fakeClient({
      enqueueResult: { jobId: "j-slow" },
      statuses: [
        { job_id: "j-slow", state: "running", progress: 25 },
        { job_id: "j-slow", state: "running", progress: 25 },
      ],
    });
    await handlePreviewRender(
      { data: PAYLOAD },
      {
        gpuClient: client,
        log,
        warn,
        pollOpts: { sleep, now, intervalMs: 50, timeoutMs: 1000 },
      },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("polling timeout after 1000ms"),
    );
  });

  it("warns when enqueueRender throws (network / 4xx / 5xx)", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueThrows: new Error("invalid X-API-Key"),
    });
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: client, log, warn },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid X-API-Key"),
    );
  });

  it("warns gracefully when getJobStatus throws mid-poll", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = {
      async enqueueRender() {
        return { jobId: "j-1" };
      },
      async getJobStatus() {
        throw new Error("network error");
      },
    } as unknown as GpuServiceClient;
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: client, log, warn, pollOpts: NEVER_SLEEP },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
    );
  });

  it("forwards exact snapshotStorageKey to enqueueRender", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueResult: { jobId: "j" },
      statuses: [
        {
          job_id: "j",
          state: "done",
          progress: 100,
          result: { storage_key: "previews/x/y.mp4" },
        },
      ],
    });
    const enqueueSpy = vi.spyOn(client, "enqueueRender");
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: client, log, warn, pollOpts: NEVER_SLEEP },
    );
    expect(enqueueSpy).toHaveBeenCalledWith({
      explorationId: "exp-1",
      candidateId: "cand-1",
      snapshotStorageKey: "explorations/exp-1/abc.json",
    });
  });

  // Reviewer Stage C HIGH #3: transient errors (5xx + network) must
  // re-throw so pg-boss retries them; permanent errors (4xx + GPU
  // state="failed") must be swallowed.

  it("re-throws GpuServiceError with status >= 500 (pg-boss retries)", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueThrows: new GpuServiceError(502, "bad gateway"),
    });
    await expect(
      handlePreviewRender(
        { data: PAYLOAD },
        { gpuClient: client, log, warn },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("transient failure (will retry)"),
    );
  });

  it("re-throws TypeError (network failure) for pg-boss retry", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueThrows: new TypeError("fetch failed"),
    });
    await expect(
      handlePreviewRender(
        { data: PAYLOAD },
        { gpuClient: client, log, warn },
      ),
    ).rejects.toThrow("fetch failed");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("transient failure (will retry)"),
    );
  });

  it("swallows GpuServiceError with status 4xx (no retry)", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueThrows: new GpuServiceError(401, "invalid X-API-Key"),
    });
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: client, log, warn },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid X-API-Key"),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("transient"),
    );
  });

  it("does NOT re-throw on real GPU failure (state=failed); pg-boss moves on", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const client = fakeClient({
      enqueueResult: { jobId: "j" },
      statuses: [
        {
          job_id: "j",
          state: "failed",
          progress: 50,
          error: "melt subprocess crashed",
        },
      ],
    });
    // Should NOT throw — real GPU failures aren't transient
    await handlePreviewRender(
      { data: PAYLOAD },
      { gpuClient: client, log, warn, pollOpts: NEVER_SLEEP },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("melt subprocess crashed"),
    );
  });

  it("flags synthesized timeout failures with [synthesized] in log line", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const now = vi.fn(() => {
      const v = t;
      t += 600;
      return v;
    });
    const client = fakeClient({
      enqueueResult: { jobId: "j-slow" },
      statuses: [
        { job_id: "j-slow", state: "running", progress: 25 },
        { job_id: "j-slow", state: "running", progress: 25 },
      ],
    });
    await handlePreviewRender(
      { data: PAYLOAD },
      {
        gpuClient: client,
        log,
        warn,
        pollOpts: { sleep, now, intervalMs: 50, timeoutMs: 1000 },
      },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[synthesized]"),
    );
  });

  // ── Stage D.2: EventBus emission ─────────────────────────────────────

  describe("EventBus emission (D.2)", () => {
    function collectEvents(bus: EventBus): RuntimeEvent[] {
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      return events;
    }

    it("emits tool.progress per poll cycle with sanitized pct + stable toolCallId", async () => {
      const bus = new EventBus();
      const events = collectEvents(bus);
      const client = fakeClient({
        enqueueResult: { jobId: "j-1" },
        statuses: [
          { job_id: "j-1", state: "queued", progress: 0 },
          { job_id: "j-1", state: "running", progress: 25 },
          { job_id: "j-1", state: "running", progress: 50 },
          { job_id: "j-1", state: "running", progress: 75 },
          {
            job_id: "j-1",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const progressEvents = events.filter((e) => e.type === "tool.progress");
      // 5 polls (queued, running×3, done) → 5 progress emissions.
      expect(progressEvents.length).toBe(5);
      const allHaveExpectedShape = progressEvents.every(
        (e) =>
          e.data.toolName === "render_preview" &&
          e.data.toolCallId === "preview-render:exp-1:cand-1" &&
          typeof e.data.step === "number" &&
          e.data.totalSteps === 100 &&
          typeof e.data.text === "string",
      );
      expect(allHaveExpectedShape).toBe(true);
      // Pct should march 0 → 25 → 50 → 75 → 100.
      const steps = progressEvents.map((e) => e.data.step as number);
      expect(steps).toEqual([0, 25, 50, 75, 100]);
    });

    it("emits exploration.candidate_ready with storage_key on done", async () => {
      const bus = new EventBus();
      const events = collectEvents(bus);
      const client = fakeClient({
        enqueueResult: { jobId: "j-1" },
        statuses: [
          {
            job_id: "j-1",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(1);
      expect(ready[0]!.data).toMatchObject({
        explorationId: "exp-1",
        candidateId: "cand-1",
        storageKey: "previews/exp-1/cand-1.mp4",
      });
    });

    it("does NOT emit candidate_ready on real GPU failure", async () => {
      const bus = new EventBus();
      const events = collectEvents(bus);
      const client = fakeClient({
        enqueueResult: { jobId: "j-1" },
        statuses: [
          {
            job_id: "j-1",
            state: "failed",
            progress: 30,
            error: "melt subprocess crashed",
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(0);
      // The failure DOES surface on tool.progress so the SSE consumer
      // can flip the card into a "render failed" state.
      const progress = events.filter((e) => e.type === "tool.progress");
      expect(progress.length).toBe(1);
      expect(progress[0]!.data.text).toContain("melt subprocess crashed");
    });

    it("does NOT emit candidate_ready on synthesized timeout failure", async () => {
      const bus = new EventBus();
      const events = collectEvents(bus);
      let t = 0;
      const now = vi.fn(() => {
        const v = t;
        t += 600;
        return v;
      });
      const client = fakeClient({
        enqueueResult: { jobId: "j-slow" },
        statuses: [
          { job_id: "j-slow", state: "running", progress: 25 },
          { job_id: "j-slow", state: "running", progress: 25 },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: {
            sleep: vi.fn().mockResolvedValue(undefined),
            now,
            intervalMs: 50,
            timeoutMs: 1000,
          },
        },
      );
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(0);
      const progress = events.filter((e) => e.type === "tool.progress");
      // Final synthesized progress event surfaces the timeout error.
      const lastProgress = progress[progress.length - 1]!;
      expect(lastProgress.data.text).toContain("polling timeout");
    });

    it("clamps garbage progress to 0..100", async () => {
      const bus = new EventBus();
      const events = collectEvents(bus);
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          // -50 should clamp to 0; 200 should clamp to 100.
          { job_id: "j", state: "running", progress: -50 as number },
          { job_id: "j", state: "running", progress: 200 as number },
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const progressEvents = events.filter((e) => e.type === "tool.progress");
      const steps = progressEvents.map((e) => e.data.step as number);
      expect(steps[0]).toBe(0);
      expect(steps[1]).toBe(100);
      expect(steps[2]).toBe(100);
    });

    it("survives EventBus throwing on emit (best-effort)", async () => {
      const brokenBus = {
        emit: vi.fn(() => {
          throw new Error("bus down");
        }),
      } as unknown as EventBus;
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      // Must not throw despite a broken bus.
      await expect(
        handlePreviewRender(
          { data: PAYLOAD },
          {
            gpuClient: client,
            log: vi.fn(),
            warn: vi.fn(),
            eventBus: brokenBus,
            pollOpts: NEVER_SLEEP,
          },
        ),
      ).resolves.toBeUndefined();
    });

    it("composes caller pollOpts.onProgress alongside EventBus emission", async () => {
      const bus = new EventBus();
      const events = collectEvents(bus);
      const callerOnProgress = vi.fn();
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          { job_id: "j", state: "running", progress: 25 },
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: { ...NEVER_SLEEP, onProgress: callerOnProgress },
        },
      );
      // Caller's onProgress fires for both polls.
      expect(callerOnProgress).toHaveBeenCalledTimes(2);
      // EventBus also got the progress events.
      const progressEvents = events.filter((e) => e.type === "tool.progress");
      expect(progressEvents.length).toBe(2);
    });
  });

  // ── Stage D.4: full SSE event sequence integration test ──────────────

  describe("SSE event sequence (D.4)", () => {
    it("running 0,25,50,75 → done emits ≥4 progress + 1 candidate_ready in order", async () => {
      const bus = new EventBus();
      const sequence: RuntimeEvent[] = [];
      bus.onAll((e) => sequence.push(e));
      const client = fakeClient({
        enqueueResult: { jobId: "j-fanout" },
        statuses: [
          { job_id: "j-fanout", state: "running", progress: 0 },
          { job_id: "j-fanout", state: "running", progress: 25 },
          { job_id: "j-fanout", state: "running", progress: 50 },
          { job_id: "j-fanout", state: "running", progress: 75 },
          {
            job_id: "j-fanout",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      // Acceptance §D: ≥4 progress events between enqueue and done + 1
      // candidate_ready.
      const progress = sequence.filter((e) => e.type === "tool.progress");
      const ready = sequence.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(progress.length).toBeGreaterThanOrEqual(4);
      expect(ready.length).toBe(1);
      // Strict order: every progress event appears before candidate_ready.
      let lastProgressIdx = -1;
      for (let i = sequence.length - 1; i >= 0; i--) {
        if (sequence[i]!.type === "tool.progress") {
          lastProgressIdx = i;
          break;
        }
      }
      const readyIdx = sequence.findIndex(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(lastProgressIdx).toBeLessThan(readyIdx);
      // candidate_ready carries the right ids + storage key.
      expect(ready[0]!.data).toMatchObject({
        explorationId: "exp-1",
        candidateId: "cand-1",
        storageKey: "previews/exp-1/cand-1.mp4",
      });
    });
  });

  // ── Stage E.2: writeback to exploration_sessions ──────────────────────

  describe("writeback (E.2)", () => {
    it("calls writeback.recordSuccess on terminal done with the storage key", async () => {
      const wb = fakeWriteback();
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          writeback: wb,
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(wb.recordSuccess).toHaveBeenCalledTimes(1);
      expect(wb.recordSuccess).toHaveBeenCalledWith({
        explorationId: "exp-1",
        candidateId: "cand-1",
        storageKey: "previews/exp-1/cand-1.mp4",
      });
      expect(wb.recordFailure).not.toHaveBeenCalled();
    });

    it("calls writeback.recordFailure on real GPU failure with error message", async () => {
      const wb = fakeWriteback();
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "failed",
            progress: 30,
            error: "melt subprocess crashed",
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          writeback: wb,
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(wb.recordFailure).toHaveBeenCalledTimes(1);
      expect(wb.recordFailure).toHaveBeenCalledWith({
        explorationId: "exp-1",
        candidateId: "cand-1",
        message: "melt subprocess crashed",
        synthesized: undefined,
      });
      expect(wb.recordSuccess).not.toHaveBeenCalled();
    });

    it("calls writeback.recordFailure with synthesized=true on poll timeout", async () => {
      const wb = fakeWriteback();
      let t = 0;
      const now = vi.fn(() => {
        const v = t;
        t += 600;
        return v;
      });
      const client = fakeClient({
        enqueueResult: { jobId: "j-slow" },
        statuses: [
          { job_id: "j-slow", state: "running", progress: 25 },
          { job_id: "j-slow", state: "running", progress: 25 },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          writeback: wb,
          pollOpts: {
            sleep: vi.fn().mockResolvedValue(undefined),
            now,
            intervalMs: 50,
            timeoutMs: 1000,
          },
        },
      );
      expect(wb.recordFailure).toHaveBeenCalledTimes(1);
      const args = wb.recordFailure.mock.calls[0]![0];
      expect(args.synthesized).toBe(true);
      expect(args.message).toContain("polling timeout");
    });

    it("warns but does NOT abort the SSE path when writeback.recordSuccess throws", async () => {
      const warn = vi.fn();
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const wb = fakeWriteback({
        successThrows: new Error("connection refused"),
      });
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn,
          writeback: wb,
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("writeback recordSuccess failed"),
      );
      // candidate_ready STILL emitted — in-flight viewers see the preview.
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(1);
    });

    it("warns when writeback.recordFailure throws (does not re-throw)", async () => {
      const warn = vi.fn();
      const wb = fakeWriteback({
        failureThrows: new Error("connection refused"),
      });
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "failed",
            progress: 30,
            error: "boom",
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn,
          writeback: wb,
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("writeback recordFailure failed"),
      );
    });

    it("no-op when writeback is null (boot without DATABASE_URL)", async () => {
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      // Must not throw.
      await expect(
        handlePreviewRender(
          { data: PAYLOAD },
          {
            gpuClient: client,
            log: vi.fn(),
            warn: vi.fn(),
            writeback: null,
            pollOpts: NEVER_SLEEP,
          },
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ── Stage E.5: signed URL mint + enriched candidate_ready ────────────

  describe("signed URL mint (E.5)", () => {
    function fakeSigner(opts?: {
      url?: string;
      throws?: Error;
    }): { getSignedUrl: ReturnType<typeof vi.fn> } {
      return {
        getSignedUrl: vi.fn(async () => {
          if (opts?.throws) throw opts.throws;
          return opts?.url ?? "https://r2.example/signed-url";
        }),
      };
    }

    it("mints signed URL with default 24h TTL on done + enriches candidate_ready", async () => {
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const signer = fakeSigner({ url: "https://r2.example/signed?sig=abc" });
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          signer,
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(signer.getSignedUrl).toHaveBeenCalledWith(
        "previews/exp-1/cand-1.mp4",
        24 * 60 * 60,
      );
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(1);
      expect(ready[0]!.data).toMatchObject({
        explorationId: "exp-1",
        candidateId: "cand-1",
        storageKey: "previews/exp-1/cand-1.mp4",
        previewUrl: "https://r2.example/signed?sig=abc",
      });
    });

    it("respects custom signedUrlTtlSec", async () => {
      const signer = fakeSigner();
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          signer,
          signedUrlTtlSec: 3600,
          eventBus: new EventBus(),
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(signer.getSignedUrl).toHaveBeenCalledWith(
        "previews/x/y.mp4",
        3600,
      );
    });

    it("does not call signer on failed states", async () => {
      const signer = fakeSigner();
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "failed",
            progress: 30,
            error: "boom",
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          signer,
          eventBus: new EventBus(),
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(signer.getSignedUrl).not.toHaveBeenCalled();
    });

    it("emits candidate_ready WITHOUT previewUrl when signing throws", async () => {
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const warn = vi.fn();
      const signer = fakeSigner({ throws: new Error("R2 down") });
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn,
          signer,
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("signed URL mint failed"),
      );
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(1);
      // storageKey present, previewUrl ABSENT — web falls back to route.
      expect(ready[0]!.data.previewUrl).toBeUndefined();
      expect(ready[0]!.data.storageKey).toBe("previews/x/y.mp4");
    });

    it("emits candidate_ready WITHOUT previewUrl when signer is null", async () => {
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const client = fakeClient({
        enqueueResult: { jobId: "j" },
        statuses: [
          {
            job_id: "j",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/x/y.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          signer: null,
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(1);
      expect(ready[0]!.data.previewUrl).toBeUndefined();
    });
  });

  // ── NEW-1: sessionId threading for per-session SSE delivery ──────────
  //
  // The events route filter (apps/agent/src/routes/events.ts:37) drops
  // events whose top-level `sessionId` doesn't match the connected
  // subscriber. Worker emits without a sessionId silently never reach
  // any subscriber. These tests pin the threading so a future regression
  // (drop the field at the type, forget to spread, accidentally bury it
  // inside `data`) breaks the build instead of breaking SSE silently.
  describe("sessionId threading (NEW-1)", () => {
    it("stamps top-level sessionId on tool.progress when supplied", async () => {
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const client = fakeClient({
        enqueueResult: { jobId: "j-sess" },
        statuses: [
          { job_id: "j-sess", state: "running", progress: 50 },
          {
            job_id: "j-sess",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: { ...PAYLOAD, sessionId: "sess-abc" } },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const progress = events.filter((e) => e.type === "tool.progress");
      expect(progress.length).toBeGreaterThan(0);
      // Top-level (NOT inside `data`) — events.ts reads event.sessionId.
      expect(progress.every((e) => e.sessionId === "sess-abc")).toBe(true);
    });

    it("stamps top-level sessionId on exploration.candidate_ready when supplied", async () => {
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const client = fakeClient({
        enqueueResult: { jobId: "j-sess2" },
        statuses: [
          {
            job_id: "j-sess2",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: { ...PAYLOAD, sessionId: "sess-xyz" } },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const ready = events.filter(
        (e) => e.type === "exploration.candidate_ready",
      );
      expect(ready.length).toBe(1);
      expect(ready[0]!.sessionId).toBe("sess-xyz");
    });

    it("stamps top-level sessionId on terminal-failed tool.progress emit", async () => {
      // Reviewer MED-1: pollUntilTerminal fires onProgress on the
      // terminal status before returning (poll-job.ts:94 for real
      // failures, :106 for synthesized timeouts). That emit IS the
      // user's only signal that the candidate failed — without
      // sessionId, the per-session SSE filter drops it and the card
      // hangs in "rendering" forever.
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const client = fakeClient({
        enqueueResult: { jobId: "j-fail" },
        statuses: [
          {
            job_id: "j-fail",
            state: "failed",
            progress: 30,
            error: "melt subprocess crashed",
          },
        ],
      });
      await handlePreviewRender(
        { data: { ...PAYLOAD, sessionId: "sess-fail" } },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      const progress = events.filter((e) => e.type === "tool.progress");
      expect(progress.length).toBeGreaterThan(0);
      // The terminal-failed emit must carry sessionId so the SSE filter
      // routes it to the originating tab (the only place that can
      // surface "render failed: ..." to the user).
      expect(progress.every((e) => e.sessionId === "sess-fail")).toBe(true);
      // No candidate_ready on failure — sanity check that the failure
      // path didn't accidentally fire the success event.
      expect(
        events.some((e) => e.type === "exploration.candidate_ready"),
      ).toBe(false);
    });

    it("stamps top-level sessionId on synthesized-timeout tool.progress emit", async () => {
      // Re-review MED follow-up: the real-failure path is pinned above,
      // but pollUntilTerminal also fires onProgress on the synthetic
      // terminal it builds when timeoutMs elapses without a state
      // change (poll-job.ts:99-107). A future refactor that
      // special-cases that branch in emitProgress would silently break
      // the timeout-after-no-response case for the per-session
      // subscriber. Pin it.
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      let t = 0;
      const now = vi.fn(() => {
        const v = t;
        t += 600;
        return v;
      });
      const client = fakeClient({
        enqueueResult: { jobId: "j-slow" },
        statuses: [
          { job_id: "j-slow", state: "running", progress: 25 },
          { job_id: "j-slow", state: "running", progress: 25 },
        ],
      });
      await handlePreviewRender(
        { data: { ...PAYLOAD, sessionId: "sess-timeout" } },
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: {
            sleep: vi.fn().mockResolvedValue(undefined),
            now,
            intervalMs: 50,
            timeoutMs: 1000,
          },
        },
      );
      const progress = events.filter((e) => e.type === "tool.progress");
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((e) => e.sessionId === "sess-timeout")).toBe(true);
      // Confirm we're actually exercising the synthesized-timeout
      // branch (not just hitting some other terminal that happened to
      // fire onProgress).
      const lastProgress = progress[progress.length - 1]!;
      expect(lastProgress.data.text).toContain("polling timeout");
    });

    it("omits sessionId entirely when payload has none", async () => {
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.onAll((e) => events.push(e));
      const client = fakeClient({
        enqueueResult: { jobId: "j-legacy" },
        statuses: [
          {
            job_id: "j-legacy",
            state: "done",
            progress: 100,
            result: { storage_key: "previews/exp-1/cand-1.mp4" },
          },
        ],
      });
      await handlePreviewRender(
        { data: PAYLOAD }, // no sessionId
        {
          gpuClient: client,
          log: vi.fn(),
          warn: vi.fn(),
          eventBus: bus,
          pollOpts: NEVER_SLEEP,
        },
      );
      // No `sessionId: undefined` either — the field is absent so the
      // events.ts strict-equality filter (`event.sessionId !== sessionId`)
      // can be reasoned about (undefined !== "sess-x" → drop) without
      // an explicit-undefined surprise.
      const all = events.filter(
        (e) =>
          e.type === "tool.progress" ||
          e.type === "exploration.candidate_ready",
      );
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((e) => !("sessionId" in e))).toBe(true);
    });
  });

  // Reviewer Stage C MED #9: log-injection defense.
  it("scrubs unsafe characters in IDs from log lines", async () => {
    const log = vi.fn();
    const warn = vi.fn();
    await handlePreviewRender(
      {
        data: {
          explorationId: "exp\nINJECTED",
          candidateId: "cand\r\nINJECTED",
          snapshotStorageKey: "explorations/x/y.json",
        },
      },
      { gpuClient: null, log, warn },
    );
    const logged = log.mock.calls[0]![0] as string;
    expect(logged).not.toContain("\n");
    expect(logged).toContain("<invalid-id>");
  });
});
