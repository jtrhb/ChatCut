/**
 * Phase 3 Stage E.7 — fan-out end-to-end integration test.
 *
 * Acceptance (per plan §E):
 *   simulated ExplorationEngine produces 4 candidates, mock GPU service
 *   end-to-end, assert all 4 storage keys in DB + 4 SSE candidate_ready
 *   + 4 progress streams.
 *
 * Architecture under test (vertical slice):
 *
 *   ExplorationEngine.explore(4 candidates)
 *      → jobQueue.enqueue("preview-render", payload)         × 4
 *      → for each: handlePreviewRender({data}, {gpuClient,
 *           writeback, signer, eventBus})
 *           ↓
 *      gpuClient.enqueueRender + pollUntilTerminal
 *      eventBus.emit("tool.progress")                        ×≥4 per candidate
 *      writeback.recordSuccess({explorationId, candidateId, storageKey})
 *      signer.getSignedUrl(storageKey)
 *      eventBus.emit("exploration.candidate_ready", {previewUrl, ...})
 *
 * The pg-boss layer is faked — `enqueue` collects payloads, the test
 * drains each through `handlePreviewRender` directly. Same shape, no
 * Postgres dep.
 */

import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../events/event-bus.js";
import type { RuntimeEvent } from "../events/types.js";
import { ExplorationEngine } from "../exploration/exploration-engine.js";
import type {
  GpuServiceClient,
  JobStatusResult,
} from "../services/gpu-service-client.js";
import {
  handlePreviewRender,
  type PreviewRenderJobData,
} from "../services/preview-render-worker.js";
import type { PreviewWriteback } from "../services/preview-writeback.js";

function fakeServerCore() {
  const clone = vi.fn(() => fakeClone());
  return {
    clone,
    serialize: vi.fn(() => ({ tracks: [] })),
    executeAgentCommand: vi.fn(),
  } as any;
}

function fakeClone() {
  return {
    executeAgentCommand: vi.fn(),
    serialize: vi.fn(() => ({ tracks: [] })),
  };
}

function fakeObjectStorage() {
  let i = 0;
  const upload = vi.fn(async (_buf: Buffer, opts: { prefix: string }) => {
    i++;
    return `${opts.prefix}/snap-${i}.json`;
  });
  return { upload, delete: vi.fn() };
}

function fakeJobQueue(captured: PreviewRenderJobData[]) {
  return {
    enqueue: vi.fn(async (_name: string, data: PreviewRenderJobData) => {
      captured.push(data);
    }),
  } as any;
}

function fakeDbInsert(captured: Array<Record<string, unknown>>) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(async (data: Record<string, unknown>) => {
        captured.push(data);
      }),
    })),
  } as any;
}

/**
 * GPU client that mints a unique jobId per candidate enqueue and serves
 * a per-job [running 0, 25, 50, 75 → done] status sequence. Each
 * candidate's storage_key matches `previews/{exp}/{cand}.mp4`.
 */
function fakeGpuClient(): GpuServiceClient {
  const sequences = new Map<string, JobStatusResult[]>();
  const callIdx = new Map<string, number>();
  let jobCounter = 0;
  return {
    async enqueueRender(args: {
      explorationId: string;
      candidateId: string;
      snapshotStorageKey: string;
    }) {
      jobCounter++;
      const jobId = `gpu-job-${jobCounter}`;
      sequences.set(jobId, [
        { job_id: jobId, state: "running", progress: 0 },
        { job_id: jobId, state: "running", progress: 25 },
        { job_id: jobId, state: "running", progress: 50 },
        { job_id: jobId, state: "running", progress: 75 },
        {
          job_id: jobId,
          state: "done",
          progress: 100,
          result: {
            storage_key: `previews/${args.explorationId}/${args.candidateId}.mp4`,
          },
        },
      ]);
      callIdx.set(jobId, 0);
      return { jobId };
    },
    async getJobStatus(jobId: string) {
      const seq = sequences.get(jobId);
      if (!seq) throw new Error(`unknown jobId ${jobId}`);
      const i = callIdx.get(jobId)!;
      const next = seq[Math.min(i, seq.length - 1)]!;
      callIdx.set(jobId, i + 1);
      return next;
    },
  } as unknown as GpuServiceClient;
}

const NEVER_SLEEP = { sleep: vi.fn().mockResolvedValue(undefined), now: () => 0 };

describe("Phase 3 Stage E.7 — fan-out end-to-end", () => {
  it("4 candidates → 4 enqueues → 4 candidate_ready + 4 progress streams + 4 DB writeback", async () => {
    // ── 1. Wiring ────────────────────────────────────────────────────────
    const enqueued: PreviewRenderJobData[] = [];
    const dbInserts: Array<Record<string, unknown>> = [];
    const eventBus = new EventBus({ historySize: 500 });
    const events: RuntimeEvent[] = [];
    eventBus.onAll((e) => events.push(e));

    const writeback: PreviewWriteback = {
      recordSuccess: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
    };

    const signer = {
      getSignedUrl: vi.fn(
        async (key: string) => `https://r2.example/${key}?sig=fake`,
      ),
    };

    const engine = new ExplorationEngine({
      serverCore: fakeServerCore(),
      jobQueue: fakeJobQueue(enqueued),
      objectStorage: fakeObjectStorage() as any,
      db: fakeDbInsert(dbInserts),
    });

    // ── 2. Drive ExplorationEngine with 4 candidates ─────────────────────
    const candidates = [0, 1, 2, 3].map((i) => ({
      label: `Variant ${i}`,
      summary: `Cut variant #${i}`,
      candidateType: "variant",
      commands: [],
      expectedMetrics: { durationChange: "-2s", affectedElements: 3 },
    }));

    const result = await engine.explore({
      intent: "shorten",
      baseSnapshotVersion: 1,
      timelineSnapshot: "snap",
      candidates,
      projectId: "11111111-1111-1111-1111-111111111111",
    });

    expect(result.candidates).toHaveLength(4);
    expect(enqueued).toHaveLength(4);
    // Each enqueued job carries the snapshot storage key written by the
    // engine — sanity check the contract.
    for (const job of enqueued) {
      expect(job.snapshotStorageKey).toMatch(
        /^explorations\/.+\/snap-\d+\.json$/,
      );
    }

    // ── 3. Drain each enqueued job through the worker (parallel — same
    //      as production where pg-boss runs ≥1 worker). ─────────────────
    const gpuClient = fakeGpuClient();

    await Promise.all(
      enqueued.map((data) =>
        handlePreviewRender(
          { data },
          {
            gpuClient,
            eventBus,
            writeback,
            signer,
            log: vi.fn(),
            warn: vi.fn(),
            pollOpts: NEVER_SLEEP,
          },
        ),
      ),
    );

    // ── 4. Assertions ────────────────────────────────────────────────────

    // 4 candidate_ready events, one per candidate, each with previewUrl.
    const ready = events.filter((e) => e.type === "exploration.candidate_ready");
    expect(ready).toHaveLength(4);
    for (const r of ready) {
      expect(r.data.previewUrl).toMatch(/^https:\/\/r2\.example\//);
      expect(r.data.previewUrl as string).toContain("?sig=fake");
      expect(r.data.storageKey as string).toMatch(/^previews\/.+\/.+\.mp4$/);
    }
    // Every result.candidate appears in the candidate_ready set exactly once.
    const readyIds = new Set(ready.map((r) => r.data.candidateId as string));
    expect(readyIds.size).toBe(4);
    for (const c of result.candidates) {
      expect(readyIds.has(c.candidateId)).toBe(true);
    }

    // 4 progress streams: ≥4 progress events per candidate (the running
    // 0/25/50/75 sequence emitted by pollUntilTerminal). Group by the
    // synthetic toolCallId the worker stamps.
    const progressByCandidate = new Map<string, RuntimeEvent[]>();
    for (const e of events) {
      if (e.type !== "tool.progress") continue;
      const tcid = e.data.toolCallId as string;
      const bucket = progressByCandidate.get(tcid) ?? [];
      bucket.push(e);
      progressByCandidate.set(tcid, bucket);
    }
    expect(progressByCandidate.size).toBe(4);
    for (const [, bucket] of progressByCandidate) {
      // Acceptance: ≥4 progress events between enqueue and done. Our
      // sequence above emits 5 (0, 25, 50, 75, 100) per candidate.
      expect(bucket.length).toBeGreaterThanOrEqual(4);
    }

    // Writeback called 4×, once per candidate, each with its own storage
    // key. (The engine itself writes the row via dbInserts; per-candidate
    // updates flow through writeback.recordSuccess.)
    expect(writeback.recordSuccess).toHaveBeenCalledTimes(4);
    const writebackArgs = (writeback.recordSuccess as ReturnType<typeof vi.fn>)
      .mock.calls
      .map((c) => c[0] as { candidateId: string; storageKey: string });
    const writebackIds = new Set(writebackArgs.map((a) => a.candidateId));
    expect(writebackIds.size).toBe(4);
    for (const a of writebackArgs) {
      expect(a.storageKey).toBe(
        `previews/${result.explorationId}/${a.candidateId}.mp4`,
      );
    }
    expect(writeback.recordFailure).not.toHaveBeenCalled();

    // Signer called 4×, once per storage key.
    expect(signer.getSignedUrl).toHaveBeenCalledTimes(4);

    // dbInserts: ExplorationEngine writes the parent row exactly once.
    expect(dbInserts).toHaveLength(1);
    expect(dbInserts[0]!.candidates).toBeDefined();
    expect((dbInserts[0]!.candidates as unknown[]).length).toBe(4);
  });

  it("mixed outcomes: 2 done + 1 real-failure + 1 timeout-synthesized", async () => {
    const enqueued: PreviewRenderJobData[] = [];
    const eventBus = new EventBus({ historySize: 500 });
    const events: RuntimeEvent[] = [];
    eventBus.onAll((e) => events.push(e));

    const writeback: PreviewWriteback = {
      recordSuccess: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
    };
    const signer = {
      getSignedUrl: vi.fn(async (k: string) => `https://r2.example/${k}`),
    };

    const engine = new ExplorationEngine({
      serverCore: fakeServerCore(),
      jobQueue: fakeJobQueue(enqueued),
      objectStorage: fakeObjectStorage() as any,
      db: fakeDbInsert([]),
    });
    await engine.explore({
      intent: "shorten",
      baseSnapshotVersion: 1,
      timelineSnapshot: "snap",
      projectId: "11111111-1111-1111-1111-111111111111",
      candidates: [0, 1, 2, 3].map((i) => ({
        label: `V${i}`,
        summary: "",
        candidateType: "variant",
        commands: [],
        expectedMetrics: { durationChange: "0s", affectedElements: 0 },
      })),
    });

    expect(enqueued).toHaveLength(4);

    // Custom client: jobs 1+2 succeed, job 3 fails for real, job 4 hits
    // a synthesized timeout via the poll loop.
    let n = 0;
    const customClient: GpuServiceClient = {
      async enqueueRender(args) {
        n++;
        return { jobId: `j-${n}` };
      },
      async getJobStatus(jobId: string) {
        if (jobId === "j-1" || jobId === "j-2") {
          return {
            job_id: jobId,
            state: "done",
            progress: 100,
            result: { storage_key: `previews/x/${jobId}.mp4` },
          };
        }
        if (jobId === "j-3") {
          return {
            job_id: jobId,
            state: "failed",
            progress: 50,
            error: "melt subprocess crashed",
          };
        }
        // j-4 → keep returning running so pollUntilTerminal synthesizes
        return { job_id: jobId, state: "running", progress: 25 };
      },
    } as any;

    let t = 0;
    const now = vi.fn(() => {
      const v = t;
      t += 600;
      return v;
    });

    await Promise.all(
      enqueued.map((data) =>
        handlePreviewRender(
          { data },
          {
            gpuClient: customClient,
            eventBus,
            writeback,
            signer,
            log: vi.fn(),
            warn: vi.fn(),
            pollOpts: { sleep: vi.fn().mockResolvedValue(undefined), now, intervalMs: 50, timeoutMs: 1000 },
          },
        ),
      ),
    );

    const ready = events.filter((e) => e.type === "exploration.candidate_ready");
    // Only 2 successes emit candidate_ready.
    expect(ready).toHaveLength(2);
    expect(writeback.recordSuccess).toHaveBeenCalledTimes(2);
    expect(writeback.recordFailure).toHaveBeenCalledTimes(2);
    // One of the failures should carry synthesized=true.
    const failureCalls = (writeback.recordFailure as ReturnType<typeof vi.fn>)
      .mock.calls
      .map((c) => c[0] as { synthesized?: boolean });
    const synthCount = failureCalls.filter((f) => f.synthesized === true).length;
    const realCount = failureCalls.filter((f) => !f.synthesized).length;
    expect(synthCount).toBe(1);
    expect(realCount).toBe(1);
  });
});
