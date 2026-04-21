import { describe, it, expect, vi } from "vitest";
import {
  GpuServiceError,
  type GpuServiceClient,
  type JobStatusResult,
} from "../gpu-service-client.js";
import { handlePreviewRender } from "../preview-render-worker.js";

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
