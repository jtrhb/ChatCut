import { describe, it, expect, vi, beforeEach } from "vitest";
import { PatternObserver } from "../pattern-observer.js";
import type { ParsedMemory } from "../types.js";

// ---------------------------------------------------------------------------
// Mock MemoryStore
// ---------------------------------------------------------------------------

function makeMockStore() {
  return {
    readParsed: vi.fn<(path: string) => Promise<ParsedMemory>>(),
    listDir: vi.fn<(path: string) => Promise<string[]>>(),
    writeMemory: vi.fn<(path: string, memory: ParsedMemory) => Promise<void>>(),
  };
}

type MockStore = ReturnType<typeof makeMockStore>;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeMemory(overrides: Partial<ParsedMemory> = {}): ParsedMemory {
  return {
    memory_id: "mem-001",
    type: "preference",
    status: "active",
    confidence: "high",
    source: "explicit",
    created: "2025-01-01T00:00:00.000Z",
    updated: "2025-01-02T00:00:00.000Z",
    reinforced_count: 1,
    last_reinforced_at: "2025-01-02T00:00:00.000Z",
    source_change_ids: [],
    used_in_changeset_ids: [],
    created_session_id: "sess-1",
    scope: "global",
    scope_level: "global",
    semantic_key: "test-key",
    tags: ["editing", "pacing"],
    content: "Some content here.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PatternObserver", () => {
  let mockStore: MockStore;
  let observer: PatternObserver;

  beforeEach(() => {
    mockStore = makeMockStore();
    observer = new PatternObserver({ memoryStore: mockStore as any });
    mockStore.listDir.mockResolvedValue([]);
    mockStore.readParsed.mockResolvedValue(makeMemory());
    mockStore.writeMemory.mockResolvedValue(undefined);
  });

  // ── 1. analyzePatterns groups memories by shared tags ────────────────────
  it("analyzePatterns groups memories by shared tags", async () => {
    const memories = [
      makeMemory({ memory_id: "m1", tags: ["editing", "pacing"] }),
      makeMemory({ memory_id: "m2", tags: ["editing", "pacing"] }),
      makeMemory({ memory_id: "m3", tags: ["color", "grading"] }),
    ];

    const result = await observer.analyzePatterns(memories);

    expect(result.clusters.length).toBeGreaterThan(0);
    // The editing+pacing cluster should contain m1 and m2
    const editingCluster = result.clusters.find((c) =>
      c.tags.includes("editing") && c.tags.includes("pacing")
    );
    expect(editingCluster).toBeDefined();
    expect(editingCluster!.memories.map((m) => m.memory_id)).toContain("m1");
    expect(editingCluster!.memories.map((m) => m.memory_id)).toContain("m2");
  });

  // ── 2. analyzePatterns identifies high-confidence clusters ───────────────
  it("analyzePatterns identifies high-confidence clusters", async () => {
    const highConfMemories = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ memory_id: `high-${i}`, confidence: "high", tags: ["audio", "mix"] })
    );
    const lowConfMemory = makeMemory({ memory_id: "low-0", confidence: "low", tags: ["audio", "mix"] });

    const result = await observer.analyzePatterns([...highConfMemories, lowConfMemory]);

    const audioCluster = result.clusters.find((c) =>
      c.tags.includes("audio") && c.tags.includes("mix")
    );
    expect(audioCluster).toBeDefined();
    expect(audioCluster!.confidence).toBe("high");
  });

  // ── 3. shouldCrystallize returns true for 5+ high-confidence memories with shared tags ──
  it("shouldCrystallize returns true for 5+ high-confidence memories sharing 2+ tags", () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ memory_id: `hc-${i}`, confidence: "high", tags: ["brand", "style"] })
    );

    const result = observer.shouldCrystallize(memories);

    expect(result.should).toBe(true);
  });

  // ── 4. shouldCrystallize returns false for fewer than 5 memories ─────────
  it("shouldCrystallize returns false when fewer than 5 memories", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      makeMemory({ memory_id: `hc-${i}`, confidence: "high", tags: ["brand", "style"] })
    );

    const result = observer.shouldCrystallize(memories);

    expect(result.should).toBe(false);
  });

  // ── 5. shouldCrystallize returns false when no shared tags ───────────────
  it("shouldCrystallize returns false when memories share no common tags", () => {
    const memories = [
      makeMemory({ memory_id: "a", confidence: "high", tags: ["alpha"] }),
      makeMemory({ memory_id: "b", confidence: "high", tags: ["beta"] }),
      makeMemory({ memory_id: "c", confidence: "high", tags: ["gamma"] }),
      makeMemory({ memory_id: "d", confidence: "high", tags: ["delta"] }),
      makeMemory({ memory_id: "e", confidence: "high", tags: ["epsilon"] }),
    ];

    const result = observer.shouldCrystallize(memories);

    expect(result.should).toBe(false);
  });

  // ── 6. shouldCrystallize returns correct cluster and sharedTags ──────────
  it("shouldCrystallize returns the cluster and sharedTags when condition is met", () => {
    const sharedMemories = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ memory_id: `shared-${i}`, confidence: "high", tags: ["voice", "tone"] })
    );
    const unrelatedMemory = makeMemory({ memory_id: "unrelated", confidence: "high", tags: ["unrelated"] });

    const result = observer.shouldCrystallize([...sharedMemories, unrelatedMemory]);

    expect(result.should).toBe(true);
    expect(result.cluster).toBeDefined();
    expect(result.cluster!.length).toBeGreaterThanOrEqual(5);
    expect(result.sharedTags).toBeDefined();
    expect(result.sharedTags).toContain("voice");
    expect(result.sharedTags).toContain("tone");
  });

  // ── 7. crystallizeSkill writes skill file to _skills/ path ───────────────
  it("crystallizeSkill writes the skill memory to a _skills/ path", async () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ memory_id: `src-${i}`, tags: ["editing", "cuts"] })
    );

    await observer.crystallizeSkill({
      memories,
      name: "quick-cuts-preference",
      agentType: "editor",
      scopeLevel: "brand",
      scopeRef: "brand:coffee-lab",
    });

    expect(mockStore.writeMemory).toHaveBeenCalledOnce();
    const [writtenPath] = mockStore.writeMemory.mock.calls[0];
    expect(writtenPath).toContain("_skills/");
  });

  // ── 8. crystallizeSkill sets skill_status to "draft" ─────────────────────
  it("crystallizeSkill sets skill_status to 'draft'", async () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ memory_id: `src-${i}`, tags: ["editing", "cuts"] })
    );

    const skill = await observer.crystallizeSkill({
      memories,
      name: "quick-cuts-preference",
      agentType: "editor",
      scopeLevel: "brand",
      scopeRef: "brand:coffee-lab",
    });

    expect(skill.skill_status).toBe("draft");
  });

  // ── 9. crystallizeSkill includes source_memories from input memories ──────
  it("crystallizeSkill records source memory paths in content", async () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ memory_id: `src-${i}`, tags: ["editing", "cuts"] })
    );

    const skill = await observer.crystallizeSkill({
      memories,
      name: "quick-cuts-preference",
      agentType: "editor",
      scopeLevel: "brand",
      scopeRef: "brand:coffee-lab",
    });

    // source_memories should reference the ids of the input memories
    const sourceMemoryIds = memories.map((m) => m.memory_id);
    for (const id of sourceMemoryIds) {
      expect(skill.content).toContain(id);
    }
  });

  // ── 10. crystallizeSkill sets correct agent_type and scope ───────────────
  it("crystallizeSkill sets agent_type and scope from params", async () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ memory_id: `src-${i}`, tags: ["audio", "music"] })
    );

    const skill = await observer.crystallizeSkill({
      memories,
      name: "audio-preference-skill",
      agentType: "audio",
      scopeLevel: "series",
      scopeRef: "series:summer-2025",
    });

    expect(skill.agent_type).toBe("audio");
    expect(skill.scope_level).toBe("series");
    expect(skill.scope).toBe("series:summer-2025");
  });

  // ── 11. runAnalysis creates skills when patterns found ───────────────────
  it("runAnalysis creates skills when crystallization threshold is met", async () => {
    const highConfMemories = Array.from({ length: 6 }, (_, i) =>
      makeMemory({ memory_id: `run-${i}`, confidence: "high", tags: ["motion", "transition"] })
    );

    mockStore.listDir.mockResolvedValue(highConfMemories.map((m) => `${m.memory_id}.md`));
    mockStore.readParsed.mockImplementation(async (path: string) => {
      const id = path.replace(".md", "");
      return highConfMemories.find((m) => m.memory_id === id) ?? makeMemory();
    });

    const result = await observer.runAnalysis({ brand: "test-brand" });

    expect(result.skillsCreated).toBeGreaterThan(0);
    expect(mockStore.writeMemory).toHaveBeenCalled();
  });

  // ── 12. runAnalysis returns 0 when no patterns found ─────────────────────
  it("runAnalysis returns 0 skillsCreated when no memories meet crystallization threshold", async () => {
    const lowCountMemories = Array.from({ length: 3 }, (_, i) =>
      makeMemory({ memory_id: `few-${i}`, confidence: "high", tags: ["misc"] })
    );

    mockStore.listDir.mockResolvedValue(lowCountMemories.map((m) => `${m.memory_id}.md`));
    mockStore.readParsed.mockImplementation(async (path: string) => {
      const id = path.replace(".md", "");
      return lowCountMemories.find((m) => m.memory_id === id) ?? makeMemory();
    });

    const result = await observer.runAnalysis({ brand: "test-brand" });

    expect(result.skillsCreated).toBe(0);
    expect(mockStore.writeMemory).not.toHaveBeenCalled();
  });
});
