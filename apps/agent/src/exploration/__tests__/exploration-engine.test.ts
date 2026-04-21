import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExplorationEngine } from "../exploration-engine.js";
import { CandidateGenerator } from "../candidate-generator.js";

// ---------------------------------------------------------------------------
// Helpers / stubs
// ---------------------------------------------------------------------------

function makeCloneMock() {
  const cloneInstance = {
    serialize: vi.fn(() => ({ project: null, scenes: [], activeSceneId: null })),
    executeAgentCommand: vi.fn(),
    snapshotVersion: 0,
  };
  return cloneInstance;
}

function makeServerCoreMock() {
  const cloneInstance = makeCloneMock();
  const serverCore = {
    clone: vi.fn(() => cloneInstance),
    serialize: vi.fn(() => ({ project: null, scenes: [], activeSceneId: null })),
    snapshotVersion: 1,
  };
  return { serverCore, cloneInstance };
}

function makeJobQueueMock() {
  return { enqueue: vi.fn(async (_name: string, _data: any) => "job-id-123") };
}

function makeObjectStorageMock() {
  return {
    upload: vi.fn(async () => "explorations/snapshot-key"),
  };
}

function makeDbMock() {
  return { insert: vi.fn().mockReturnValue({ values: vi.fn(async () => {}) }) };
}

function buildCandidate(label: string) {
  return {
    label,
    summary: `Summary for ${label}`,
    candidateType: "edit",
    commands: [{ type: "trim", targetId: "el-1" }],
    expectedMetrics: { durationChange: "-2s", affectedElements: 1 },
  };
}

const BASE_PARAMS = {
  intent: "make it shorter",
  baseSnapshotVersion: 1,
  timelineSnapshot: "snap-abc",
  projectId: "proj-test",
  candidates: [buildCandidate("Option A"), buildCandidate("Option B")],
};

// ---------------------------------------------------------------------------
// ExplorationEngine tests
// ---------------------------------------------------------------------------

describe("ExplorationEngine", () => {
  let serverCore: ReturnType<typeof makeServerCoreMock>["serverCore"];
  let cloneInstance: ReturnType<typeof makeServerCoreMock>["cloneInstance"];
  let jobQueue: ReturnType<typeof makeJobQueueMock>;
  let objectStorage: ReturnType<typeof makeObjectStorageMock>;
  let db: ReturnType<typeof makeDbMock>;
  let engine: ExplorationEngine;

  beforeEach(() => {
    const mocks = makeServerCoreMock();
    serverCore = mocks.serverCore;
    cloneInstance = mocks.cloneInstance;
    jobQueue = makeJobQueueMock();
    objectStorage = makeObjectStorageMock();
    db = makeDbMock();
    engine = new ExplorationEngine({ serverCore: serverCore as any, jobQueue: jobQueue as any, objectStorage: objectStorage as any, db });
  });

  // --- Core materialization ---

  it("materializes all candidates — clone called once per candidate", async () => {
    await engine.explore(BASE_PARAMS);
    expect(serverCore.clone).toHaveBeenCalledTimes(BASE_PARAMS.candidates.length);
  });

  it("returns explorationId and candidate metadata", async () => {
    const result = await engine.explore(BASE_PARAMS);
    expect(result.explorationId).toBeTruthy();
    expect(typeof result.explorationId).toBe("string");
    expect(result.candidates).toHaveLength(BASE_PARAMS.candidates.length);
    expect(result.candidates[0]).toMatchObject({
      candidateId: expect.any(String),
      label: "Option A",
      summary: "Summary for Option A",
      expectedMetrics: { durationChange: "-2s", affectedElements: 1 },
    });
    expect(result.candidates[1]).toMatchObject({
      candidateId: expect.any(String),
      label: "Option B",
      summary: "Summary for Option B",
    });
  });

  it("enqueues one pg-boss job per candidate", async () => {
    await engine.explore(BASE_PARAMS);
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(BASE_PARAMS.candidates.length);
    for (const call of jobQueue.enqueue.mock.calls) {
      expect(call[0]).toBe("preview-render");
    }
  });

  it("stores exploration session in DB", async () => {
    await engine.explore(BASE_PARAMS);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insert().values).toHaveBeenCalledTimes(1);
  });

  // Audit §A.7 / §B.ExplorationEngine: the persisted row hardcoded
  // projectId: "default" with a TODO. Multi-project deployments would
  // therefore have every exploration collide on a single key. This test
  // asserts the projectId from ExploreParams reaches the DB row.
  it("persists projectId from params (not hardcoded default)", async () => {
    const projectId = "proj-abc-123";
    await engine.explore({ ...BASE_PARAMS, projectId });
    const valuesCall = db.insert.mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(valuesCall).toBeDefined();
    expect(valuesCall.projectId).toBe(projectId);
    expect(valuesCall.projectId).not.toBe("default");
  });

  it("handles 3 candidates correctly", async () => {
    const params = {
      ...BASE_PARAMS,
      candidates: [buildCandidate("A"), buildCandidate("B"), buildCandidate("C")],
    };
    const result = await engine.explore(params);
    expect(serverCore.clone).toHaveBeenCalledTimes(3);
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(3);
    expect(result.candidates).toHaveLength(3);
  });

  it("handles 4 candidates correctly", async () => {
    const params = {
      ...BASE_PARAMS,
      candidates: [buildCandidate("A"), buildCandidate("B"), buildCandidate("C"), buildCandidate("D")],
    };
    const result = await engine.explore(params);
    expect(serverCore.clone).toHaveBeenCalledTimes(4);
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(4);
    expect(result.candidates).toHaveLength(4);
  });

  // --- Command application (bug fix: commands no longer discarded) ---

  it("applies commands on each clone via executeAgentCommand", async () => {
    await engine.explore(BASE_PARAMS);
    // Each candidate has 1 command, 2 candidates total
    expect(cloneInstance.executeAgentCommand).toHaveBeenCalledTimes(2);
    const firstCall = cloneInstance.executeAgentCommand.mock.calls[0]!;
    expect(firstCall[0]).toEqual({ type: "trim", targetId: "el-1" });
    expect(firstCall[1]).toBe("exploration-engine");
  });

  it("includes commands in the preview-render job payload", async () => {
    await engine.explore(BASE_PARAMS);
    for (const call of jobQueue.enqueue.mock.calls) {
      const payload = call[1]!;
      expect(payload).toHaveProperty("commands");
      expect(payload.commands).toEqual([{ type: "trim", targetId: "el-1" }]);
    }
  });

  // Stage C.1 / C-Q1 — the GPU renderer will fetch the candidate
  // snapshot from R2 via this storage key. Legacy timelineSnapshot is
  // kept side-by-side until Stage C.5 rewires the worker.
  it("includes snapshotStorageKey from objectStorage.upload return in payload", async () => {
    await engine.explore(BASE_PARAMS);
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(BASE_PARAMS.candidates.length);
    for (const call of jobQueue.enqueue.mock.calls) {
      const payload = call[1]!;
      expect(payload).toHaveProperty("snapshotStorageKey");
      // Mock objectStorage.upload returns "explorations/snapshot-key" — the
      // engine captures it from the upload() promise and threads through.
      expect(payload.snapshotStorageKey).toBe("explorations/snapshot-key");
    }
    // upload() called once per candidate (each candidate produces a
    // post-command snapshot and uploads it before enqueuing the job)
    expect(objectStorage.upload).toHaveBeenCalledTimes(BASE_PARAMS.candidates.length);
  });

  it("each candidate gets its own captured snapshotStorageKey (no shared state leak)", async () => {
    // Make objectStorage return distinct keys per call so we'd catch a
    // bug where the engine shares one key across candidates
    let n = 0;
    objectStorage.upload.mockImplementation(async () => `explorations/key-${++n}`);
    await engine.explore(BASE_PARAMS);
    const keys = jobQueue.enqueue.mock.calls.map((c) => (c[1] as any).snapshotStorageKey);
    expect(new Set(keys).size).toBe(BASE_PARAMS.candidates.length);
  });

  it("retains timelineSnapshot in payload for legacy worker (Stage C.5 will drop)", async () => {
    await engine.explore(BASE_PARAMS);
    for (const call of jobQueue.enqueue.mock.calls) {
      const payload = call[1]!;
      expect(payload).toHaveProperty("timelineSnapshot");
      expect(payload.timelineSnapshot).toBe(BASE_PARAMS.timelineSnapshot);
    }
  });

  // --- State machine ---

  it("returns completed status after explore() finishes", async () => {
    const result = await engine.explore(BASE_PARAMS);
    expect(result.status).toBe("completed");
  });

  it("getStatus returns completed after explore()", async () => {
    const result = await engine.explore(BASE_PARAMS);
    expect(engine.getStatus(result.explorationId)).toBe("completed");
  });

  it("getStatus returns undefined for unknown explorationId", () => {
    expect(engine.getStatus("nonexistent-id")).toBeUndefined();
  });

  it("selectCandidate transitions to user_selected", async () => {
    const result = await engine.explore(BASE_PARAMS);
    const candidateId = result.candidates[0]!.candidateId;
    engine.selectCandidate(result.explorationId, candidateId);
    expect(engine.getStatus(result.explorationId)).toBe("user_selected");
  });

  it("selectCandidate throws for unknown exploration", () => {
    expect(() => engine.selectCandidate("bad-id", "c1")).toThrow(
      "Unknown exploration"
    );
  });

  it("selectCandidate throws for unknown candidate", async () => {
    const result = await engine.explore(BASE_PARAMS);
    expect(() =>
      engine.selectCandidate(result.explorationId, "nonexistent-candidate")
    ).toThrow("Unknown candidate");
  });

  it("applySelection transitions from user_selected to applied", async () => {
    const result = await engine.explore(BASE_PARAMS);
    const candidateId = result.candidates[0]!.candidateId;
    engine.selectCandidate(result.explorationId, candidateId);
    engine.applySelection(result.explorationId);
    expect(engine.getStatus(result.explorationId)).toBe("applied");
  });

  it("applySelection throws when no candidate selected", async () => {
    const result = await engine.explore(BASE_PARAMS);
    // status is "completed", no candidate selected — should throw
    expect(() => engine.applySelection(result.explorationId)).toThrow(
      "No candidate selected"
    );
  });

  it("applySelection throws for unknown exploration", () => {
    expect(() => engine.applySelection("bad-id")).toThrow(
      "Unknown exploration"
    );
  });

  it("cancel transitions to cancelled from completed", async () => {
    const result = await engine.explore(BASE_PARAMS);
    engine.cancel(result.explorationId);
    expect(engine.getStatus(result.explorationId)).toBe("cancelled");
  });

  it("cancel throws for unknown exploration", () => {
    expect(() => engine.cancel("bad-id")).toThrow("Unknown exploration");
  });

  it("cancel throws from terminal state (applied)", async () => {
    const result = await engine.explore(BASE_PARAMS);
    const candidateId = result.candidates[0]!.candidateId;
    engine.selectCandidate(result.explorationId, candidateId);
    engine.applySelection(result.explorationId);
    expect(() => engine.cancel(result.explorationId)).toThrow(
      "Invalid transition"
    );
  });

  it("cancel throws from terminal state (cancelled)", async () => {
    const result = await engine.explore(BASE_PARAMS);
    engine.cancel(result.explorationId);
    expect(() => engine.cancel(result.explorationId)).toThrow(
      "Invalid transition"
    );
  });

  it("selectCandidate throws from cancelled state", async () => {
    const result = await engine.explore(BASE_PARAMS);
    engine.cancel(result.explorationId);
    const candidateId = result.candidates[0]!.candidateId;
    expect(() =>
      engine.selectCandidate(result.explorationId, candidateId)
    ).toThrow("Invalid transition");
  });

  it("getSession returns a snapshot of the session", async () => {
    const result = await engine.explore(BASE_PARAMS);
    const session = engine.getSession(result.explorationId);
    expect(session).toBeDefined();
    expect(session!.status).toBe("completed");
    expect(session!.candidates).toHaveLength(2);
    expect(session!.selectedCandidateId).toBeNull();
    expect(session!.createdAt).toBeGreaterThan(0);
  });

  it("getSession returns undefined for unknown id", () => {
    expect(engine.getSession("nonexistent")).toBeUndefined();
  });

  it("single candidate skips partial, goes running -> completed", async () => {
    const params = {
      ...BASE_PARAMS,
      candidates: [buildCandidate("Solo")],
    };
    const result = await engine.explore(params);
    expect(result.status).toBe("completed");
    expect(engine.getStatus(result.explorationId)).toBe("completed");
  });

  // --- Full lifecycle ---

  it("full lifecycle: explore -> select -> apply", async () => {
    const result = await engine.explore(BASE_PARAMS);
    expect(engine.getStatus(result.explorationId)).toBe("completed");

    const candidateId = result.candidates[1]!.candidateId;
    engine.selectCandidate(result.explorationId, candidateId);
    expect(engine.getStatus(result.explorationId)).toBe("user_selected");

    const session = engine.getSession(result.explorationId);
    expect(session!.selectedCandidateId).toBe(candidateId);

    engine.applySelection(result.explorationId);
    expect(engine.getStatus(result.explorationId)).toBe("applied");
  });

  it("DB row status matches final session status", async () => {
    await engine.explore(BASE_PARAMS);
    const dbValues = db.insert().values.mock.calls[0]![0];
    expect(dbValues.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// CandidateGenerator tests
// ---------------------------------------------------------------------------

describe("CandidateGenerator", () => {
  let gen: CandidateGenerator;

  beforeEach(() => {
    gen = new CandidateGenerator();
  });

  // --- calculateOverlap ---

  it("calculateOverlap returns 0 for completely different elements", () => {
    const a = { resultTimeline: { elements: ["e1", "e2", "e3"] } };
    const b = { resultTimeline: { elements: ["e4", "e5", "e6"] } };
    expect(gen.calculateOverlap(a, b)).toBe(0);
  });

  it("calculateOverlap returns 1 for identical elements", () => {
    const a = { resultTimeline: { elements: ["e1", "e2", "e3"] } };
    const b = { resultTimeline: { elements: ["e1", "e2", "e3"] } };
    expect(gen.calculateOverlap(a, b)).toBe(1);
  });

  it("calculateOverlap returns correct value for partial overlap (3 shared out of 5 union = 0.6)", () => {
    // a={e1,e2,e3}, b={e1,e2,e3,e4,e5} → intersection=3, union=5 → 0.6
    const a = { resultTimeline: { elements: ["e1", "e2", "e3"] } };
    const b = { resultTimeline: { elements: ["e1", "e2", "e3", "e4", "e5"] } };
    expect(gen.calculateOverlap(a, b)).toBeCloseTo(0.6);
  });

  // --- validateDispersion ---

  it("validateDispersion returns true when all pairs have overlap < 0.7", () => {
    const candidates = [
      { resultTimeline: { elements: ["e1", "e2", "e3"] } },
      { resultTimeline: { elements: ["e4", "e5", "e6"] } },
      { resultTimeline: { elements: ["e7", "e8", "e9"] } },
    ];
    expect(gen.validateDispersion(candidates)).toBe(true);
  });

  it("validateDispersion returns false when any pair has overlap > 0.7", () => {
    // a and b share 4 out of 5 elements → overlap = 4/5 = 0.8 > 0.7
    const candidates = [
      { resultTimeline: { elements: ["e1", "e2", "e3", "e4"] } },
      { resultTimeline: { elements: ["e1", "e2", "e3", "e4", "e5"] } }, // 4/5 = 0.8
      { resultTimeline: { elements: ["e9", "e10"] } },
    ];
    expect(gen.validateDispersion(candidates)).toBe(false);
  });

  it("validateDispersion returns true for empty candidate list", () => {
    expect(gen.validateDispersion([])).toBe(true);
  });

  it("validateDispersion returns true for a single candidate", () => {
    const candidates = [{ resultTimeline: { elements: ["e1", "e2"] } }];
    expect(gen.validateDispersion(candidates)).toBe(true);
  });
});
