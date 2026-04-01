import { describe, it, expect, beforeEach } from "vitest";
import { MemoryIndex } from "../memory-index.js";
import type { ParsedMemory } from "../types.js";

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

describe("MemoryIndex", () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex();
  });

  // 1. add() and getAll() stores entries
  it("add() stores entries and getAll() returns them", () => {
    const m1 = makeMemory({ memory_id: "a", semantic_key: "k-a" });
    const m2 = makeMemory({ memory_id: "b", semantic_key: "k-b" });
    index.add(m1);
    index.add(m2);
    const all = index.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.memory_id)).toContain("a");
    expect(all.map((m) => m.memory_id)).toContain("b");
  });

  // 2. add() deduplicates by memory_id
  it("add() deduplicates by memory_id", () => {
    const original = makeMemory({ memory_id: "dup", content: "original" });
    const updated = makeMemory({ memory_id: "dup", content: "updated" });
    index.add(original);
    index.add(updated);
    const all = index.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("updated");
  });

  // 3. findByTags() returns memories matching any given tag
  it("findByTags() returns memories matching any of the given tags", () => {
    const m1 = makeMemory({ memory_id: "t1", semantic_key: "k1", tags: ["color", "style"] });
    const m2 = makeMemory({ memory_id: "t2", semantic_key: "k2", tags: ["pacing"] });
    const m3 = makeMemory({ memory_id: "t3", semantic_key: "k3", tags: ["unrelated"] });
    index.add(m1);
    index.add(m2);
    index.add(m3);
    const results = index.findByTags(["color", "pacing"]);
    expect(results.map((m) => m.memory_id)).toContain("t1");
    expect(results.map((m) => m.memory_id)).toContain("t2");
    expect(results.map((m) => m.memory_id)).not.toContain("t3");
  });

  // 4. findByScope() returns memories matching scope level
  it("findByScope() returns only memories with the given scope_level", () => {
    const g = makeMemory({ memory_id: "g1", semantic_key: "sk-g", scope_level: "global" });
    const b = makeMemory({ memory_id: "b1", semantic_key: "sk-b", scope_level: "brand" });
    const p = makeMemory({ memory_id: "p1", semantic_key: "sk-p", scope_level: "project" });
    index.add(g);
    index.add(b);
    index.add(p);
    const globals = index.findByScope("global");
    expect(globals).toHaveLength(1);
    expect(globals[0].memory_id).toBe("g1");
    const brands = index.findByScope("brand");
    expect(brands).toHaveLength(1);
    expect(brands[0].memory_id).toBe("b1");
  });

  // 5. findBySemanticKey() returns memory or undefined
  it("findBySemanticKey() returns the matching memory or undefined", () => {
    const m = makeMemory({ memory_id: "sk1", semantic_key: "my-key" });
    index.add(m);
    expect(index.findBySemanticKey("my-key")).toBe(m);
    expect(index.findBySemanticKey("nonexistent")).toBeUndefined();
  });

  // 6. remove() removes by ID
  it("remove() removes the entry with the given memory_id", () => {
    const m1 = makeMemory({ memory_id: "r1", semantic_key: "rk1" });
    const m2 = makeMemory({ memory_id: "r2", semantic_key: "rk2" });
    index.add(m1);
    index.add(m2);
    index.remove("r1");
    const all = index.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].memory_id).toBe("r2");
  });
});
