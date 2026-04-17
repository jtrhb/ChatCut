import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryStore } from "../memory-store.js";
import type { ParsedMemory } from "../types.js";

// ---------------------------------------------------------------------------
// Mock ObjectStorage
// ---------------------------------------------------------------------------

function makeMockStorage() {
  const store = new Map<string, string>();

  return {
    _store: store,
    upload: vi.fn(async (data: Buffer, options: { prefix: string; contentType: string; extension?: string }) => {
      // Extract key from prefix + we track by prefix directly in tests
      const key = options.prefix;
      store.set(key, data.toString("utf-8"));
      return key;
    }),
    // We need a way to download — use a custom send mock via GetObjectCommand
    _getContent: (key: string) => store.get(key),
    client: {
      send: vi.fn(async (command: any) => {
        if (command.constructor?.name === "GetObjectCommand" || command._input?.Key !== undefined) {
          const key = command.input?.Key ?? command._input?.Key;
          const content = store.get(key);
          if (content === undefined) {
            const err = new Error("NoSuchKey") as any;
            err.name = "NoSuchKey";
            throw err;
          }
          // Return a body that can be converted to string
          const body = {
            transformToString: async () => content,
          };
          return { Body: body };
        }
        if (command.constructor?.name === "ListObjectsV2Command" || command._input?.Prefix !== undefined) {
          const prefix = command.input?.Prefix ?? command._input?.Prefix;
          const keys: string[] = [];
          for (const k of store.keys()) {
            if (k.startsWith(prefix)) {
              keys.push(k);
            }
          }
          return {
            Contents: keys.map((k) => ({ Key: k })),
          };
        }
        if (command.constructor?.name === "PutObjectCommand") {
          const key = command.input?.Key ?? command._input?.Key;
          const body = command.input?.Body ?? command._input?.Body;
          store.set(key, typeof body === "string" ? body : body.toString("utf-8"));
          return {};
        }
        return {};
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Sample memory fixture
// ---------------------------------------------------------------------------

const SAMPLE_MEMORY: ParsedMemory = {
  memory_id: "mem-001",
  type: "preference",
  status: "active",
  confidence: "high",
  source: "explicit",
  created: "2025-01-01T00:00:00.000Z",
  updated: "2025-01-02T00:00:00.000Z",
  reinforced_count: 3,
  last_reinforced_at: "2025-01-02T00:00:00.000Z",
  last_used_at: "2025-01-03T00:00:00.000Z",
  source_change_ids: ["ch-1", "ch-2"],
  used_in_changeset_ids: ["cs-1"],
  created_session_id: "sess-abc",
  last_reinforced_session_id: "sess-def",
  scope: "global",
  scope_level: "global",
  semantic_key: "user-prefers-quick-cuts",
  tags: ["editing", "pacing"],
  content: "User prefers quick cuts with no more than 3 seconds per clip.",
};

const SAMPLE_FRONTMATTER = `---
memory_id: mem-001
type: preference
status: active
confidence: high
source: explicit
created: 2025-01-01T00:00:00.000Z
updated: 2025-01-02T00:00:00.000Z
reinforced_count: 3
last_reinforced_at: 2025-01-02T00:00:00.000Z
last_used_at: 2025-01-03T00:00:00.000Z
source_change_ids: ["ch-1","ch-2"]
used_in_changeset_ids: ["cs-1"]
created_session_id: sess-abc
last_reinforced_session_id: sess-def
scope: global
scope_level: global
semantic_key: user-prefers-quick-cuts
tags: ["editing","pacing"]
---
User prefers quick cuts with no more than 3 seconds per clip.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
  let storage: ReturnType<typeof makeMockStorage>;
  let store: MemoryStore;
  let writerToken: symbol;
  const USER_ID = "user-123";

  beforeEach(() => {
    storage = makeMockStorage();
    store = new MemoryStore(storage as any, USER_ID);
    // Tests act as the sole writer (MasterAgent stand-in).
    writerToken = store.grantWriterToken();
  });

  // ── 1. readFile downloads from correct R2 path ───────────────────────────
  it("readFile downloads from the correct R2 path", async () => {
    const key = `chatcut-memory/${USER_ID}/preferences/mem-001.md`;
    storage._store.set(key, "hello world");

    const content = await store.readFile("preferences/mem-001.md");
    expect(content).toBe("hello world");
  });

  // ── 2. readParsed parses frontmatter correctly ───────────────────────────
  it("readParsed parses memory_id, type, status, confidence, and content", async () => {
    const key = `chatcut-memory/${USER_ID}/preferences/mem-001.md`;
    storage._store.set(key, SAMPLE_FRONTMATTER);

    const mem = await store.readParsed("preferences/mem-001.md");

    expect(mem.memory_id).toBe("mem-001");
    expect(mem.type).toBe("preference");
    expect(mem.status).toBe("active");
    expect(mem.confidence).toBe("high");
    expect(mem.content).toBe(
      "User prefers quick cuts with no more than 3 seconds per clip."
    );
  });

  // ── 3. readParsed handles all field types ────────────────────────────────
  it("readParsed handles strings, numbers, booleans, and arrays", async () => {
    const key = `chatcut-memory/${USER_ID}/preferences/mem-001.md`;
    storage._store.set(key, SAMPLE_FRONTMATTER);

    const mem = await store.readParsed("preferences/mem-001.md");

    expect(mem.reinforced_count).toBe(3);
    expect(Array.isArray(mem.source_change_ids)).toBe(true);
    expect(mem.source_change_ids).toEqual(["ch-1", "ch-2"]);
    expect(Array.isArray(mem.tags)).toBe(true);
    expect(mem.tags).toEqual(["editing", "pacing"]);
  });

  // ── 4. writeMemory serializes and uploads correct markdown ───────────────
  it("writeMemory uploads valid markdown with frontmatter to R2", async () => {
    await store.writeMemory(writerToken, "preferences/mem-001.md", SAMPLE_MEMORY);

    const key = `chatcut-memory/${USER_ID}/preferences/mem-001.md`;
    const raw = storage._store.get(key);
    expect(raw).toBeDefined();
    expect(raw).toContain("---");
    expect(raw).toContain("memory_id: mem-001");
    expect(raw).toContain("type: preference");
    expect(raw).toContain(
      "User prefers quick cuts with no more than 3 seconds per clip."
    );
  });

  // ── 5. writeMemory roundtrips ────────────────────────────────────────────
  it("writeMemory roundtrip: write then readParsed returns same data", async () => {
    await store.writeMemory(writerToken, "preferences/mem-001.md", SAMPLE_MEMORY);
    const mem = await store.readParsed("preferences/mem-001.md");

    expect(mem.memory_id).toBe(SAMPLE_MEMORY.memory_id);
    expect(mem.type).toBe(SAMPLE_MEMORY.type);
    expect(mem.status).toBe(SAMPLE_MEMORY.status);
    expect(mem.confidence).toBe(SAMPLE_MEMORY.confidence);
    expect(mem.source).toBe(SAMPLE_MEMORY.source);
    expect(mem.reinforced_count).toBe(SAMPLE_MEMORY.reinforced_count);
    expect(mem.source_change_ids).toEqual(SAMPLE_MEMORY.source_change_ids);
    expect(mem.tags).toEqual(SAMPLE_MEMORY.tags);
    expect(mem.content).toBe(SAMPLE_MEMORY.content);
  });

  // ── 6. listDir returns filenames from R2 ────────────────────────────────
  it("listDir returns filenames within the given subdirectory", async () => {
    const base = `chatcut-memory/${USER_ID}/preferences/`;
    storage._store.set(base + "mem-001.md", "a");
    storage._store.set(base + "mem-002.md", "b");
    // A file in a different path should NOT appear
    storage._store.set(`chatcut-memory/${USER_ID}/rules/rule-001.md`, "c");

    const files = await store.listDir("preferences/");
    expect(files).toContain("mem-001.md");
    expect(files).toContain("mem-002.md");
    expect(files).not.toContain("rule-001.md");
  });

  // ── 7. exists returns true for existing file ────────────────────────────
  it("exists returns true when file is present in R2", async () => {
    const key = `chatcut-memory/${USER_ID}/preferences/mem-001.md`;
    storage._store.set(key, "something");

    const result = await store.exists("preferences/mem-001.md");
    expect(result).toBe(true);
  });

  // ── 8. exists returns false for missing file ────────────────────────────
  it("exists returns false when file is not present in R2", async () => {
    const result = await store.exists("preferences/nonexistent.md");
    expect(result).toBe(false);
  });

  // ── 9. parseFrontmatter handles nested activation_scope object ──────────
  it("parseFrontmatter handles nested activation_scope object", async () => {
    const raw = `---
memory_id: mem-scope
type: rule
status: active
confidence: medium
source: implicit
created: 2025-01-01T00:00:00.000Z
updated: 2025-01-01T00:00:00.000Z
reinforced_count: 1
last_reinforced_at: 2025-01-01T00:00:00.000Z
source_change_ids: []
used_in_changeset_ids: []
created_session_id: sess-xyz
scope: project:proj-1
scope_level: project
activation_scope: {"project_id":"proj-1","session_id":"sess-xyz"}
semantic_key: some-rule
tags: []
---
Rule content here.`;

    const key = `chatcut-memory/${USER_ID}/rules/mem-scope.md`;
    storage._store.set(key, raw);

    const mem = await store.readParsed("rules/mem-scope.md");
    expect(mem.activation_scope).toBeDefined();
    expect(mem.activation_scope?.project_id).toBe("proj-1");
    expect(mem.activation_scope?.session_id).toBe("sess-xyz");
  });

  // ── 10. serializeToMarkdown produces valid frontmatter format ────────────
  it("serializeToMarkdown produces --- delimited frontmatter followed by content", async () => {
    await store.writeMemory(writerToken, "preferences/mem-001.md", SAMPLE_MEMORY);

    const key = `chatcut-memory/${USER_ID}/preferences/mem-001.md`;
    const raw = storage._store.get(key)!;

    // Must start with ---
    expect(raw.startsWith("---\n")).toBe(true);

    // Must have closing --- before content
    const parts = raw.split("---\n");
    // parts[0] = "" (before opening ---), parts[1] = yaml block, parts[2] = content
    expect(parts.length).toBeGreaterThanOrEqual(3);

    const yamlBlock = parts[1];
    expect(yamlBlock).toContain("memory_id:");
    expect(yamlBlock).toContain("type:");
    expect(yamlBlock).not.toContain("\ncontent:"); // content NOT in frontmatter

    const contentPart = parts.slice(2).join("---\n").trim();
    expect(contentPart).toBe(
      "User prefers quick cuts with no more than 3 seconds per clip."
    );
  });

  describe("B4: writer token gate", () => {
    it("writeMemory throws when called with an unrelated symbol", async () => {
      const bogus = Symbol("not-the-real-token");
      await expect(
        store.writeMemory(bogus, "preferences/x.md", SAMPLE_MEMORY),
      ).rejects.toThrow(/writer token is required/);
    });

    it("writeMemory throws when called with no matching per-instance token", async () => {
      // A fresh store has its own token — the writerToken from beforeEach is
      // for a different store instance and must not be accepted here.
      const otherStorage = makeMockStorage();
      const otherStore = new MemoryStore(otherStorage as any, "user-other");
      await expect(
        otherStore.writeMemory(writerToken, "preferences/x.md", SAMPLE_MEMORY),
      ).rejects.toThrow(/writer token is required/);
    });

    it("grantWriterToken throws if called twice on the same store", () => {
      // beforeEach already granted once; a second grant must be refused.
      expect(() => store.grantWriterToken()).toThrow(/already granted/);
    });

    it("read methods do NOT require the token", async () => {
      const key = `chatcut-memory/${USER_ID}/preferences/read-only.md`;
      storage._store.set(key, "raw content");
      // No token here — reads are open
      await expect(store.readFile("preferences/read-only.md")).resolves.toBe("raw content");
      await expect(store.exists("preferences/read-only.md")).resolves.toBe(true);
      await expect(store.listDir("preferences/")).resolves.toContain("read-only.md");
    });
  });
});
