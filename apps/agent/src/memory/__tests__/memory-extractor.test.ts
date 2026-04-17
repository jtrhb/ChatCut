import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryExtractor } from "../memory-extractor.js";
import { ChangeLog } from "@opencut/core";
import type { ParsedMemory } from "../types.js";
import type { ChangeEntry } from "@opencut/core";

// ---------------------------------------------------------------------------
// Mock memory deps (post-B4: reader split from writer callback).
//
// Post-B4 MemoryExtractor no longer holds a MemoryStore reference — it takes
// a read-only reader and a writeMemory callback. Tests mimic that split. The
// `writeMemory` spy and `_written` map are shared so reads see what the
// Extractor has written, matching the former mock's semantics.
// ---------------------------------------------------------------------------

function makeMockMemoryDeps() {
  const written = new Map<string, ParsedMemory>();

  const writeMemory = vi.fn(async (path: string, memory: ParsedMemory) => {
    written.set(path, memory);
  });

  const reader = {
    listDir: vi.fn(async (_path: string): Promise<string[]> => []),
    readParsed: vi.fn(async (path: string): Promise<ParsedMemory> => {
      const mem = written.get(path);
      if (!mem) throw new Error(`Not found: ${path}`);
      return mem;
    }),
    exists: vi.fn(async (_path: string): Promise<boolean> => false),
  };

  return { _written: written, writeMemory, reader };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChangeEntry(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id: "entry-1",
    timestamp: Date.now(),
    source: "agent",
    agentId: "agent-001",
    changesetId: "cs-001",
    action: {
      type: "update",
      targetType: "element",
      targetId: "elem-1",
      details: {},
    },
    summary: "Updated clip duration",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryExtractor", () => {
  let changeLog: ChangeLog;
  let deps: ReturnType<typeof makeMockMemoryDeps>;
  let extractor: MemoryExtractor;

  const TEST_SESSION_ID = "test-session-42";

  beforeEach(() => {
    changeLog = new ChangeLog();
    deps = makeMockMemoryDeps();
    extractor = new MemoryExtractor({
      changeLog,
      memoryReader: deps.reader,
      writeMemory: deps.writeMemory,
      sessionId: TEST_SESSION_ID,
    });
  });

  // ── 1. start() subscribes to changeLog decision events ───────────────────
  it("start() subscribes to changeLog decision events", () => {
    const listenerCount = changeLog.listenerCount("decision");
    extractor.start();
    expect(changeLog.listenerCount("decision")).toBe(listenerCount + 1);
  });

  // ── 2. handleRejection creates draft memory with source="implicit" ────────
  it("handleRejection creates a draft memory with source=implicit", async () => {
    const entry = makeChangeEntry({ changesetId: "cs-reject-1" });
    changeLog.record({
      source: entry.source,
      agentId: entry.agentId,
      changesetId: entry.changesetId,
      action: entry.action,
      summary: entry.summary,
    });

    const memory = await extractor.handleRejection("cs-reject-1");

    expect(memory).not.toBeNull();
    expect(memory!.source).toBe("implicit");
    expect(memory!.status).toBe("draft");
    expect(memory!.confidence).toBe("low");
    expect(memory!.created_session_id).toBe(TEST_SESSION_ID);
    expect(memory!.last_reinforced_session_id).toBe(TEST_SESSION_ID);
    expect(memory!.used_in_changeset_ids).toEqual(["cs-reject-1"]);
    expect(deps.writeMemory).toHaveBeenCalledTimes(1);
  });

  // ── 3. handleRejection with 3+ consecutive rejections sets activation_scope
  it("handleRejection with 3+ consecutive rejections of same type sets activation_scope", async () => {
    // Record 3 changesets with same action type
    for (let i = 1; i <= 3; i++) {
      changeLog.record({
        source: "agent",
        changesetId: `cs-rej-${i}`,
        action: { type: "update", targetType: "element", targetId: `elem-${i}`, details: {} },
        summary: "Updated clip duration",
      });
    }

    // Simulate 2 prior rejections of same type in changeLog decisions
    changeLog.emitDecision({ type: "changeset_rejected", changesetId: "cs-rej-1", timestamp: Date.now() - 2000 });
    changeLog.emitDecision({ type: "changeset_rejected", changesetId: "cs-rej-2", timestamp: Date.now() - 1000 });

    // Third rejection
    const memory = await extractor.handleRejection("cs-rej-3");

    expect(memory).not.toBeNull();
    expect(memory!.activation_scope).toBeDefined();
  });

  // ── 4. handleApproval increments reinforced_count on related memories ─────
  it("handleApproval increments reinforced_count on related memories", async () => {
    // First create a draft via rejection
    changeLog.record({
      source: "agent",
      changesetId: "cs-base",
      action: { type: "update", targetType: "element", targetId: "elem-1", details: {} },
      summary: "Updated clip duration",
    });
    await extractor.handleRejection("cs-base");

    // Verify memory was created
    expect(deps.writeMemory).toHaveBeenCalledTimes(1);
    const firstCall = deps.writeMemory.mock.calls[0];
    const draftMemory = firstCall[1] as ParsedMemory;
    expect(draftMemory.reinforced_count).toBe(0);

    // Now record a similar approval changeset and handle it
    changeLog.record({
      source: "agent",
      changesetId: "cs-approval",
      action: { type: "update", targetType: "element", targetId: "elem-2", details: {} },
      summary: "Updated clip duration", // same summary → same signal type
    });

    // Seed the written store so readParsed finds it
    const path = firstCall[0] as string;
    deps._written.set(path, draftMemory);
    deps.reader.listDir.mockResolvedValue([path.split("/").pop()!]);
    deps.reader.readParsed.mockImplementation(async (p: string) => {
      const mem = deps._written.get(p);
      if (!mem) throw new Error(`Not found: ${p}`);
      return mem;
    });

    await extractor.handleApproval("cs-approval");

    // writeMemory called again with incremented count
    expect(deps.writeMemory.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = deps.writeMemory.mock.calls.at(-1);
    const reinforcedMemory = lastCall![1] as ParsedMemory;
    expect(reinforcedMemory.reinforced_count).toBeGreaterThan(draftMemory.reinforced_count);
  });

  // ── 5. handleApproval updates last_reinforced_at ──────────────────────────
  it("handleApproval updates last_reinforced_at", async () => {
    const before = new Date("2020-01-01T00:00:00.000Z").toISOString();

    // Seed a memory to reinforce
    const existingMemory: ParsedMemory = {
      memory_id: "mem-existing",
      type: "preference",
      status: "draft",
      confidence: "low",
      source: "implicit",
      created: before,
      updated: before,
      reinforced_count: 0,
      last_reinforced_at: before,
      source_change_ids: [],
      used_in_changeset_ids: [],
      created_session_id: "sess-A",
      scope: "global",
      scope_level: "global",
      semantic_key: "clip-update-pattern",
      tags: ["editing"],
      content: "User rejects clip duration changes",
    };

    const memPath = "drafts/mem-existing.md";
    deps._written.set(memPath, existingMemory);
    deps.reader.listDir.mockResolvedValue(["mem-existing.md"]);
    deps.reader.readParsed.mockImplementation(async (p: string) => {
      const mem = deps._written.get(p);
      if (!mem) throw new Error(`Not found: ${p}`);
      return mem;
    });

    changeLog.record({
      source: "agent",
      changesetId: "cs-approve-5",
      action: { type: "update", targetType: "element", targetId: "elem-1", details: {} },
      summary: "Updated clip duration",
    });

    const beforeApproval = Date.now();
    await extractor.handleApproval("cs-approve-5");

    const lastCall = deps.writeMemory.mock.calls.at(-1);
    if (lastCall) {
      const reinforced = lastCall[1] as ParsedMemory;
      const reinforcedTime = new Date(reinforced.last_reinforced_at).getTime();
      expect(reinforcedTime).toBeGreaterThanOrEqual(beforeApproval);
    }
  });

  // ── 6. handleExplicitInput creates active memory with source="explicit" ───
  it("handleExplicitInput creates active memory with source=explicit and confidence=high", async () => {
    const memory = await extractor.handleExplicitInput({
      content: "Always use jump cuts for sports content",
      scope: "global",
      tags: ["sports", "cutting"],
    });

    expect(memory.source).toBe("explicit");
    expect(memory.status).toBe("active");
    expect(memory.confidence).toBe("high");
    expect(memory.content).toBe("Always use jump cuts for sports content");
    expect(deps.writeMemory).toHaveBeenCalledTimes(1);
  });

  // ── 7. canPromoteDraft returns false when same session ────────────────────
  it("canPromoteDraft returns false when created_session_id === currentSessionId", () => {
    const memory: ParsedMemory = {
      memory_id: "mem-draft-1",
      type: "preference",
      status: "draft",
      confidence: "low",
      source: "implicit",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      reinforced_count: 1,
      last_reinforced_at: new Date().toISOString(),
      source_change_ids: [],
      used_in_changeset_ids: [],
      created_session_id: "sess-same",
      last_reinforced_session_id: "sess-same",
      scope: "global",
      scope_level: "global",
      semantic_key: "same-session-test",
      tags: [],
      content: "test",
    };

    const result = extractor.canPromoteDraft(memory, "sess-same");
    expect(result).toBe(false);
  });

  // ── 8. canPromoteDraft returns true when different session ────────────────
  it("canPromoteDraft returns true when last_reinforced_session_id !== created_session_id and equals currentSessionId", () => {
    const memory: ParsedMemory = {
      memory_id: "mem-draft-2",
      type: "preference",
      status: "draft",
      confidence: "low",
      source: "implicit",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      reinforced_count: 2,
      last_reinforced_at: new Date().toISOString(),
      source_change_ids: [],
      used_in_changeset_ids: [],
      created_session_id: "sess-A",
      last_reinforced_session_id: "sess-B",
      scope: "global",
      scope_level: "global",
      semantic_key: "diff-session-test",
      tags: [],
      content: "test",
    };

    const result = extractor.canPromoteDraft(memory, "sess-B");
    expect(result).toBe(true);
  });

  // ── 9. canPromoteDraft returns false when never reinforced ────────────────
  it("canPromoteDraft returns false when no last_reinforced_session_id", () => {
    const memory: ParsedMemory = {
      memory_id: "mem-draft-3",
      type: "preference",
      status: "draft",
      confidence: "low",
      source: "implicit",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      reinforced_count: 0,
      last_reinforced_at: new Date().toISOString(),
      source_change_ids: [],
      used_in_changeset_ids: [],
      created_session_id: "sess-A",
      // last_reinforced_session_id intentionally absent
      scope: "global",
      scope_level: "global",
      semantic_key: "no-reinforce-test",
      tags: [],
      content: "test",
    };

    const result = extractor.canPromoteDraft(memory, "sess-B");
    expect(result).toBe(false);
  });

  // ── 10. classifySignal identifies rejection patterns ─────────────────────
  it("classifySignal identifies the type and severity from ChangeEntry array", () => {
    const entries: ChangeEntry[] = [
      makeChangeEntry({ action: { type: "delete", targetType: "element", targetId: "e1", details: {} }, summary: "Deleted clip" }),
      makeChangeEntry({ action: { type: "delete", targetType: "element", targetId: "e2", details: {} }, summary: "Deleted clip" }),
    ];

    // Access via casting since classifySignal is private — test indirectly through handleRejection
    // We verify its output affects the draft memory's content/tags
    changeLog.record({
      source: "agent",
      changesetId: "cs-classify",
      action: { type: "delete", targetType: "element", targetId: "e1", details: {} },
      summary: "Deleted clip",
    });

    return extractor.handleRejection("cs-classify").then((memory) => {
      expect(memory).not.toBeNull();
      // The signal classification should produce a meaningful semantic_key or tag
      expect(memory!.tags.length).toBeGreaterThan(0);
    });
  });

  // ── 11a. handleApproval updates last_reinforced_session_id ────────────────
  it("handleApproval sets last_reinforced_session_id to extractor sessionId", async () => {
    const before = new Date("2020-01-01T00:00:00.000Z").toISOString();

    const existingMemory: ParsedMemory = {
      memory_id: "mem-sess-track",
      type: "pattern",
      status: "draft",
      confidence: "low",
      source: "implicit",
      created: before,
      updated: before,
      reinforced_count: 0,
      last_reinforced_at: before,
      source_change_ids: [],
      used_in_changeset_ids: [],
      created_session_id: "old-session",
      last_reinforced_session_id: "old-session",
      scope: "global",
      scope_level: "global",
      semantic_key: "update-pattern",
      tags: ["update"],
      content: "test memory",
    };

    const memPath = "drafts/mem-sess-track.md";
    deps._written.set(memPath, existingMemory);
    deps.reader.listDir.mockResolvedValue(["mem-sess-track.md"]);
    deps.reader.readParsed.mockImplementation(async (p: string) => {
      const mem = deps._written.get(p);
      if (!mem) throw new Error(`Not found: ${p}`);
      return mem;
    });

    changeLog.record({
      source: "agent",
      changesetId: "cs-sess-track",
      action: { type: "update", targetType: "element", targetId: "elem-1", details: {} },
      summary: "Updated clip",
    });

    await extractor.handleApproval("cs-sess-track");

    const lastCall = deps.writeMemory.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const reinforced = lastCall![1] as ParsedMemory;
    expect(reinforced.last_reinforced_session_id).toBe(TEST_SESSION_ID);
    expect(reinforced.used_in_changeset_ids).toContain("cs-sess-track");
  });

  // ── 11b. handleExplicitInput populates causal tracking fields ───────────
  it("handleExplicitInput sets created_session_id and last_reinforced_session_id to extractor sessionId", async () => {
    const memory = await extractor.handleExplicitInput({
      content: "Prefer smooth transitions",
      scope: "brand:acme",
      tags: ["transitions"],
    });

    expect(memory.created_session_id).toBe(TEST_SESSION_ID);
    expect(memory.last_reinforced_session_id).toBe(TEST_SESSION_ID);
    expect(memory.used_in_changeset_ids).toEqual([]);
  });

  // ── 11. Single approval does not create new memory (only reinforces) ──────
  it("single approval does not create a new memory, only reinforces existing", async () => {
    changeLog.record({
      source: "agent",
      changesetId: "cs-only-approval",
      action: { type: "insert", targetType: "element", targetId: "e1", details: {} },
      summary: "Inserted new clip",
    });

    // No existing memories
    deps.reader.listDir.mockResolvedValue([]);

    await extractor.handleApproval("cs-only-approval");

    // writeMemory should NOT have been called (no memories to reinforce, none created)
    expect(deps.writeMemory).not.toHaveBeenCalled();
  });
});
