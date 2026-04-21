import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryLoader } from "../memory-loader.js";
import type { ParsedMemory, TaskContext } from "../types.js";

// ---------------------------------------------------------------------------
// Mock MemoryStore
// ---------------------------------------------------------------------------

function makeMockStore() {
  return {
    readParsed: vi.fn<(path: string) => Promise<ParsedMemory>>(),
    listDir: vi.fn<(path: string) => Promise<string[]>>(),
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
    tags: [],
    content: "Some content here.",
    ...overrides,
  };
}

const BASE_TASK: TaskContext = {
  brand: "acme",
  platform: "youtube",
  sessionId: "sess-1",
  agentType: "editor",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryLoader", () => {
  let mockStore: MockStore;
  let loader: MemoryLoader;

  beforeEach(() => {
    mockStore = makeMockStore();
    loader = new MemoryLoader(mockStore as any);
    // Default: listDir returns empty, readParsed returns a basic memory
    mockStore.listDir.mockResolvedValue([]);
    mockStore.readParsed.mockResolvedValue(makeMemory());
  });

  // ── 1. loadMemories uses correct template for "single-edit" ──────────────
  it("loadMemories uses single-edit template patterns", async () => {
    const task: TaskContext = { ...BASE_TASK, projectId: "proj-42" };

    // listDir is called for wildcard patterns; track which dirs are queried
    mockStore.listDir.mockResolvedValue([]);

    await loader.loadMemories(task, "single-edit");

    const listDirCalls = mockStore.listDir.mock.calls.map((c) => c[0]);
    expect(listDirCalls).toContain("global/aesthetic/");
    expect(listDirCalls).toContain("brands/acme/identity/");
    expect(listDirCalls).toContain("projects/proj-42/");

    // Exact file paths are read directly (no listDir)
    const readCalls = mockStore.readParsed.mock.calls.map((c) => c[0]);
    expect(readCalls).toContain("global/quality/approval-criteria.md");
  });

  // ── 2. loadMemories uses correct template for "batch-production" ──────────
  it("loadMemories uses batch-production template patterns", async () => {
    const task: TaskContext = {
      ...BASE_TASK,
      series: "summer-series",
      projectId: "proj-42",
    };

    mockStore.listDir.mockResolvedValue([]);

    await loader.loadMemories(task, "batch-production");

    const listDirCalls = mockStore.listDir.mock.calls.map((c) => c[0]);
    expect(listDirCalls).toContain("global/aesthetic/");
    expect(listDirCalls).toContain("brands/acme/identity/");
    expect(listDirCalls).toContain("brands/acme/platforms/");
    expect(listDirCalls).toContain("brands/acme/_skills/");
    expect(listDirCalls).toContain("brands/acme/series/summer-series/");
    expect(listDirCalls).toContain("brands/acme/series/summer-series/_skills/");
    expect(listDirCalls).toContain("projects/proj-42/");
    // Phase 5c: _conflicts/* is no longer loaded via QUERY_TEMPLATES — it
    // routes through MemoryLoader.loadConflictMarkers() instead so the
    // shape difference (target/severity vs ParsedMemory) doesn't pollute
    // the regular memory pipeline. See phase5c-conflict-markers.test.ts.
    expect(listDirCalls).not.toContain("_conflicts/");

    const readCalls = mockStore.readParsed.mock.calls.map((c) => c[0]);
    expect(readCalls).toContain("global/quality/approval-criteria.md");
  });

  // ── 3. expandPattern calls listDir for wildcard patterns ─────────────────
  it("expandPattern calls store.listDir for wildcard glob patterns", async () => {
    mockStore.listDir.mockResolvedValue(["file-a.md", "file-b.md"]);

    await loader.loadMemories(BASE_TASK, "single-edit");

    expect(mockStore.listDir).toHaveBeenCalledWith("global/aesthetic/");
  });

  // ── 4. expandPattern returns single file path for non-wildcard ────────────
  it("expandPattern reads the file directly for non-wildcard paths", async () => {
    mockStore.listDir.mockResolvedValue([]);

    await loader.loadMemories(BASE_TASK, "single-edit");

    // approval-criteria.md is a concrete path — should be read directly
    const readCalls = mockStore.readParsed.mock.calls.map((c) => c[0]);
    expect(readCalls).toContain("global/quality/approval-criteria.md");
  });

  // ── 5. postLoadPipeline excludes stale memories ───────────────────────────
  it("postLoadPipeline excludes memories with status=stale", async () => {
    const activeMemory = makeMemory({ memory_id: "active-1", status: "active", content: "Active content." });
    const staleMemory = makeMemory({ memory_id: "stale-1", status: "stale", content: "Stale content." });

    mockStore.listDir.mockResolvedValueOnce(["active-1.md", "stale-1.md"]);
    mockStore.readParsed
      .mockResolvedValueOnce(activeMemory)
      .mockResolvedValueOnce(staleMemory);

    const result = await loader.loadMemories(BASE_TASK, "single-edit");

    expect(result.promptText).toContain("Active content.");
    expect(result.promptText).not.toContain("Stale content.");
    expect(result.injectedMemoryIds).toContain("active-1");
    expect(result.injectedMemoryIds).not.toContain("stale-1");
  });

  // ── 6. postLoadPipeline excludes deprecated memories ─────────────────────
  it("postLoadPipeline excludes memories with status=deprecated", async () => {
    const activeMemory = makeMemory({ memory_id: "active-2", status: "active", content: "Active." });
    const deprecatedMemory = makeMemory({ memory_id: "dep-1", status: "deprecated", content: "Deprecated." });

    mockStore.listDir.mockResolvedValueOnce(["active-2.md", "dep-1.md"]);
    mockStore.readParsed
      .mockResolvedValueOnce(activeMemory)
      .mockResolvedValueOnce(deprecatedMemory);

    const result = await loader.loadMemories(BASE_TASK, "single-edit");

    expect(result.promptText).toContain("Active.");
    expect(result.promptText).not.toContain("Deprecated.");
  });

  // ── 7. draft passes when activation_scope matches project ─────────────────
  it("postLoadPipeline includes draft memory when activation_scope.project_id matches task projectId", async () => {
    const task: TaskContext = { ...BASE_TASK, projectId: "proj-99" };
    const draftMemory = makeMemory({
      memory_id: "draft-pass",
      status: "draft",
      activation_scope: { project_id: "proj-99" },
      content: "Draft passes.",
    });

    mockStore.listDir.mockResolvedValueOnce(["draft-pass.md"]);
    mockStore.readParsed.mockResolvedValueOnce(draftMemory);

    const result = await loader.loadMemories(task, "single-edit");

    expect(result.promptText).toContain("Draft passes.");
    expect(result.injectedMemoryIds).toContain("draft-pass");
  });

  // ── 8. draft excluded when activation_scope.session_id does not match ───────
  // MemorySelector filters drafts by session_id only (not project_id).
  it("postLoadPipeline excludes draft memory when activation_scope.session_id does not match", async () => {
    const task: TaskContext = { ...BASE_TASK, sessionId: "sess-current" };
    const draftMemory = makeMemory({
      memory_id: "draft-fail",
      status: "draft",
      activation_scope: { session_id: "sess-OTHER" },
      content: "Draft excluded.",
    });

    mockStore.listDir.mockResolvedValueOnce(["draft-fail.md"]);
    mockStore.readParsed.mockResolvedValueOnce(draftMemory);

    const result = await loader.loadMemories(task, "single-edit");

    expect(result.promptText).not.toContain("Draft excluded.");
    expect(result.injectedMemoryIds).not.toContain("draft-fail");
  });

  // ── 9. mergeByScope: project overrides global for same semantic_key ───────
  it("mergeByScope: project-level memory wins over global for same semantic_key", async () => {
    const globalMem = makeMemory({
      memory_id: "global-1",
      scope_level: "global",
      semantic_key: "shared-key",
      content: "Global version.",
    });
    const projectMem = makeMemory({
      memory_id: "project-1",
      scope_level: "project",
      semantic_key: "shared-key",
      content: "Project version.",
    });

    mockStore.listDir.mockResolvedValueOnce(["global-1.md", "project-1.md"]);
    mockStore.readParsed
      .mockResolvedValueOnce(globalMem)
      .mockResolvedValueOnce(projectMem);

    const result = await loader.loadMemories(BASE_TASK, "single-edit");

    expect(result.promptText).toContain("Project version.");
    expect(result.promptText).not.toContain("Global version.");
    expect(result.injectedMemoryIds).toContain("project-1");
    expect(result.injectedMemoryIds).not.toContain("global-1");
  });

  // ── 10. mergeByScope: higher scope_level wins over lower scope_level ────────
  // MemorySelector deduplicates by scope_level only; at equal scope the first
  // encountered (insertion order) is kept.
  it("mergeByScope: higher scope_level wins when semantic_key collides", async () => {
    const brandMem = makeMemory({
      memory_id: "brand-mem",
      scope_level: "brand",
      semantic_key: "shared-key",
      content: "Brand version.",
    });
    const projectMem = makeMemory({
      memory_id: "project-mem",
      scope_level: "project",
      semantic_key: "shared-key",
      content: "Project version.",
    });

    // brand loaded first, then project — project wins because scope_level is higher
    mockStore.listDir.mockResolvedValueOnce(["brand-mem.md", "project-mem.md"]);
    mockStore.readParsed
      .mockResolvedValueOnce(brandMem)
      .mockResolvedValueOnce(projectMem);

    const result = await loader.loadMemories(BASE_TASK, "single-edit");

    expect(result.promptText).toContain("Project version.");
    expect(result.promptText).not.toContain("Brand version.");
  });

  // ── 11. Token budget truncation limits output ─────────────────────────────
  it("token budget truncation stops adding memories once budget is exhausted", async () => {
    // Each memory ~100 chars, budget = 200 chars ≈ 50 tokens
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({
        memory_id: `mem-${i}`,
        semantic_key: `key-${i}`,
        content: "X".repeat(100),
      })
    );

    const task: TaskContext = { ...BASE_TASK, tokenBudget: 50 }; // 50 tokens ≈ 200 chars

    mockStore.listDir.mockResolvedValueOnce(memories.map((m) => `${m.memory_id}.md`));
    for (const m of memories) {
      mockStore.readParsed.mockResolvedValueOnce(m);
    }

    const result = await loader.loadMemories(task, "single-edit");

    // Should not contain all 10 memories worth of content
    expect(result.injectedMemoryIds.length).toBeLessThan(10);
  });

  // ── 12. serializeForPrompt returns promptText, injectedMemoryIds, injectedSkillIds ──
  it("serializeForPrompt includes all three fields in MemoryContext", async () => {
    const mem = makeMemory({ memory_id: "mem-serialize", content: "Serialized content." });
    mockStore.listDir.mockResolvedValueOnce(["mem-serialize.md"]);
    mockStore.readParsed.mockResolvedValueOnce(mem);

    const result = await loader.loadMemories(BASE_TASK, "single-edit");

    expect(result).toHaveProperty("promptText");
    expect(result).toHaveProperty("injectedMemoryIds");
    expect(result).toHaveProperty("injectedSkillIds");
    expect(typeof result.promptText).toBe("string");
    expect(Array.isArray(result.injectedMemoryIds)).toBe(true);
    expect(Array.isArray(result.injectedSkillIds)).toBe(true);
  });

  // ── 13. Skill IDs tracked separately from memory IDs ─────────────────────
  it("skill memories are tracked in injectedSkillIds, not injectedMemoryIds", async () => {
    const regularMem = makeMemory({
      memory_id: "regular-mem",
      semantic_key: "regular",
      content: "Regular memory.",
    });
    const skillMem = makeMemory({
      memory_id: "skill-mem",
      skill_id: "skill-001",
      skill_status: "validated",
      semantic_key: "skill",
      content: "Skill content.",
    });

    mockStore.listDir.mockResolvedValueOnce(["regular-mem.md", "skill-mem.md"]);
    mockStore.readParsed
      .mockResolvedValueOnce(regularMem)
      .mockResolvedValueOnce(skillMem);

    const result = await loader.loadMemories(BASE_TASK, "single-edit");

    expect(result.injectedMemoryIds).toContain("regular-mem");
    expect(result.injectedMemoryIds).not.toContain("skill-mem");
    expect(result.injectedSkillIds).toContain("skill-001");
    expect(result.injectedSkillIds).not.toContain("regular-mem");
  });
});
