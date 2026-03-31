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
  return { enqueue: vi.fn(async () => "job-id-123") };
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
    // Each call should use the preview-render job name
    for (const call of jobQueue.enqueue.mock.calls) {
      expect(call[0]).toBe("preview-render");
    }
  });

  it("stores exploration session in DB", async () => {
    await engine.explore(BASE_PARAMS);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insert().values).toHaveBeenCalledTimes(1);
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
