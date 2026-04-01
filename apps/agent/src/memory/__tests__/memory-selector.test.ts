import { describe, it, expect } from "vitest";
import { MemorySelector } from "../memory-selector.js";
import type { ParsedMemory, TaskContext } from "../types.js";

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
    tags: [],
    content: "Some content.",
    ...overrides,
  };
}

const BASE_TASK: TaskContext = {
  brand: "acme",
  sessionId: "sess-1",
  agentType: "editor",
};

describe("MemorySelector", () => {
  const selector = new MemorySelector();

  // 1. excludes stale and deprecated
  it("excludes stale and deprecated memories", () => {
    const active = makeMemory({ memory_id: "a1", semantic_key: "sk-a", status: "active", content: "Active." });
    const stale = makeMemory({ memory_id: "s1", semantic_key: "sk-s", status: "stale", content: "Stale." });
    const deprecated = makeMemory({ memory_id: "d1", semantic_key: "sk-d", status: "deprecated", content: "Deprecated." });

    const result = selector.selectRelevant([active, stale, deprecated], BASE_TASK);
    const ids = result.map((m) => m.memory_id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("s1");
    expect(ids).not.toContain("d1");
  });

  // 2. prefers higher scope_level when semantic_key conflicts
  it("prefers higher scope_level when semantic_key conflicts", () => {
    const globalMem = makeMemory({
      memory_id: "g1",
      scope_level: "global",
      semantic_key: "shared",
      content: "Global version.",
    });
    const projectMem = makeMemory({
      memory_id: "p1",
      scope_level: "project",
      semantic_key: "shared",
      content: "Project version.",
    });

    const result = selector.selectRelevant([globalMem, projectMem], BASE_TASK);
    expect(result).toHaveLength(1);
    expect(result[0].memory_id).toBe("p1");
  });

  // 3. filters draft memories not in current session activation scope
  it("filters out draft memories whose activation_scope.session_id does not match task.sessionId", () => {
    const draftMatch = makeMemory({
      memory_id: "dm1",
      semantic_key: "sk-dm",
      status: "draft",
      activation_scope: { session_id: "sess-1" },
      content: "Draft match.",
    });
    const draftNoMatch = makeMemory({
      memory_id: "dm2",
      semantic_key: "sk-dm2",
      status: "draft",
      activation_scope: { session_id: "sess-OTHER" },
      content: "Draft no match.",
    });

    const result = selector.selectRelevant([draftMatch, draftNoMatch], BASE_TASK);
    const ids = result.map((m) => m.memory_id);
    expect(ids).toContain("dm1");
    expect(ids).not.toContain("dm2");
  });

  // 4. respects token budget
  it("respects token budget and returns fewer memories when budget is tight", () => {
    // 20 memories with ~500 char content each, budget 2000 chars = 500 tokens
    // 2000 chars / 4 chars per token = 500 tokens budget → 2000 char total
    // Each memory ~500 chars, so at most ~4 should fit
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMemory({
        memory_id: `mem-${i}`,
        semantic_key: `key-${i}`,
        content: "X".repeat(500),
      })
    );
    const task: TaskContext = { ...BASE_TASK, tokenBudget: 500 }; // 500 * 4 = 2000 chars

    const result = selector.selectRelevant(memories, task);
    expect(result.length).toBeLessThan(20);
    // With 2000 char budget and 500 chars per memory, at most 4 should fit
    expect(result.length).toBeLessThanOrEqual(4);
  });
});
