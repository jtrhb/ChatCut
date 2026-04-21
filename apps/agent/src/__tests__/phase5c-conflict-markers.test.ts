import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryStore } from "../memory/memory-store.js";
import { MemoryLoader } from "../memory/memory-loader.js";
import { MemoryExtractor } from "../memory/memory-extractor.js";
import type { ConflictMarker } from "../memory/types.js";
import { parseConflictMarker } from "../utils/frontmatter.js";

/**
 * Phase 5c — conflict marker `_conflicts/` flow.
 *
 * Verifies the four moving parts:
 *   1. MemoryStore.writeConflictMarker writes a parseable marker to _conflicts/
 *   2. MemoryStore.readConflictMarker / listConflictMarkers round-trip cleanly
 *   3. MemoryLoader.loadConflictMarkers returns active markers, newest-first
 *   4. MemoryExtractor.handleRejection writes a marker only on the 3rd+
 *      consecutive same-signal-type rejection (5c-Q1 = a)
 */

// ────────────────────────────────────────────────────────────────────────────
// Mock R2 / ObjectStorage
// ────────────────────────────────────────────────────────────────────────────

function makeMockStorage() {
  const objects = new Map<string, string>();

  return {
    _objects: objects,
    client: {
      send: vi.fn(async (command: any) => {
        const ctorName = command.constructor?.name;
        const input = command.input ?? command._input ?? {};

        if (ctorName === "GetObjectCommand") {
          const content = objects.get(input.Key);
          if (content === undefined) {
            const err = new Error("NoSuchKey") as any;
            err.name = "NoSuchKey";
            throw err;
          }
          return {
            Body: { transformToString: async () => content },
          };
        }
        if (ctorName === "ListObjectsV2Command") {
          const prefix: string = input.Prefix;
          const keys: string[] = [];
          for (const k of objects.keys()) {
            if (k.startsWith(prefix)) keys.push(k);
          }
          return { Contents: keys.map((k) => ({ Key: k })) };
        }
        if (ctorName === "PutObjectCommand") {
          const body = input.Body;
          objects.set(
            input.Key,
            typeof body === "string" ? body : body.toString("utf-8"),
          );
          return {};
        }
        return {};
      }),
    },
  };
}

const USER_ID = "user-5c-test";

// ────────────────────────────────────────────────────────────────────────────
// MemoryStore.writeConflictMarker
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5c — MemoryStore conflict markers", () => {
  let storage: ReturnType<typeof makeMockStorage>;
  let store: MemoryStore;
  let writerToken: symbol;

  beforeEach(() => {
    storage = makeMockStorage();
    store = new MemoryStore(storage as any, USER_ID);
    writerToken = store.grantWriterToken();
  });

  it("writeConflictMarker rejects when called without the writer token", async () => {
    await expect(
      store.writeConflictMarker(Symbol("not the token"), {
        actionType: "delete",
        severity: "high",
        reason: "x",
      }),
    ).rejects.toThrow(/writer token is required/);
  });

  it("writeConflictMarker writes to _conflicts/ with the expected filename shape", async () => {
    const { path, marker } = await store.writeConflictMarker(writerToken, {
      actionType: "delete",
      target: "clip-abc",
      severity: "high",
      conflictsWith: ["drafts/mem-xyz.md"],
      reason: "User rejected delete 3 times in a row.",
    });

    // Filename: _conflicts/{ISO-with-`:`-replaced-by-`-`}-{actionType}-{shortHash}.md
    expect(path).toMatch(
      /^_conflicts\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-delete-[a-f0-9]{8}\.md$/,
    );
    expect(marker.action_type).toBe("delete");
    expect(marker.target).toBe("clip-abc");
    expect(marker.severity).toBe("high");
    expect(marker.conflicts_with).toEqual(["drafts/mem-xyz.md"]);
    expect(marker.marker_id).toMatch(/^conflict-[a-f0-9]{8}$/);
    expect(marker.first_seen_at).toBe(marker.last_seen_at);
  });

  it("writeConflictMarker → readConflictMarker round-trips parseable content", async () => {
    const { path } = await store.writeConflictMarker(writerToken, {
      actionType: "trim",
      target: "*",
      severity: "medium",
      reason: "User wants to trim a different way.",
    });

    const round = await store.readConflictMarker(path);
    expect(round.action_type).toBe("trim");
    expect(round.target).toBe("*");
    expect(round.severity).toBe("medium");
    expect(round.reason).toBe("User wants to trim a different way.");
  });

  it("listConflictMarkers returns filenames (not full keys) under _conflicts/", async () => {
    await store.writeConflictMarker(writerToken, {
      actionType: "delete",
      severity: "high",
      reason: "first",
    });
    await store.writeConflictMarker(writerToken, {
      actionType: "split",
      severity: "high",
      reason: "second",
    });

    const filenames = await store.listConflictMarkers();
    expect(filenames).toHaveLength(2);
    // Should not include the bucket prefix or _conflicts/ path
    for (const fn of filenames) {
      expect(fn).not.toContain("/");
      expect(fn).toMatch(/\.md$/);
    }
  });

  it("writeConflictMarker handles actionType chars that are filename-unsafe", async () => {
    const { path } = await store.writeConflictMarker(writerToken, {
      actionType: "weird/type:with*chars",
      severity: "low",
      reason: "x",
    });
    // Special chars should be replaced with `_` in the filename slug
    expect(path).toMatch(/-weird_type_with_chars-/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseConflictMarker (frontmatter helper)
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5c — parseConflictMarker", () => {
  it("parses required fields from frontmatter + reason from body", () => {
    const raw = `---
marker_id: conflict-abcd1234
action_type: delete
target: clip-1
severity: high
conflicts_with: ["drafts/mem-1.md"]
first_seen_at: 2026-04-21T10:00:00.000Z
last_seen_at: 2026-04-21T10:05:00.000Z
---
User repeatedly rejected delete actions on clip-1.`;

    const m = parseConflictMarker(raw);
    expect(m.marker_id).toBe("conflict-abcd1234");
    expect(m.action_type).toBe("delete");
    expect(m.target).toBe("clip-1");
    expect(m.severity).toBe("high");
    expect(m.conflicts_with).toEqual(["drafts/mem-1.md"]);
    expect(m.first_seen_at).toBe("2026-04-21T10:00:00.000Z");
    expect(m.last_seen_at).toBe("2026-04-21T10:05:00.000Z");
    expect(m.reason).toBe("User repeatedly rejected delete actions on clip-1.");
  });

  it("throws on missing frontmatter delimiters (loader catches and skips)", () => {
    expect(() => parseConflictMarker("no frontmatter here")).toThrow(
      /missing frontmatter opening/,
    );
    expect(() =>
      parseConflictMarker("---\nfield: value\nno close"),
    ).toThrow(/missing frontmatter closing/);
  });

  it("falls back to safe defaults for missing optional fields", () => {
    const raw = `---
marker_id: conflict-xxx
action_type: delete
---
reason text`;
    const m = parseConflictMarker(raw);
    expect(m.target).toBe("*");
    expect(m.severity).toBe("low");
    expect(m.conflicts_with).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// MemoryLoader.loadConflictMarkers
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5c — MemoryLoader.loadConflictMarkers", () => {
  it("returns markers newest-first (sorted by last_seen_at)", async () => {
    const storage = makeMockStorage();
    const store = new MemoryStore(storage as any, USER_ID);
    const token = store.grantWriterToken();

    // Sequential writes with a tiny delay so each gets a distinct ISO
    // timestamp (bun's vitest doesn't support vi.setSystemTime, so we use
    // real time with a 5ms gap — adds ~10ms total to the test, acceptable).
    await store.writeConflictMarker(token, {
      actionType: "delete",
      severity: "high",
      reason: "oldest",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.writeConflictMarker(token, {
      actionType: "trim",
      severity: "medium",
      reason: "middle",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.writeConflictMarker(token, {
      actionType: "split",
      severity: "high",
      reason: "newest",
    });

    const loader = new MemoryLoader(store);
    const markers = await loader.loadConflictMarkers();
    expect(markers.map((m) => m.reason)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("returns [] when the store doesn't support conflict markers", async () => {
    // Test double without listConflictMarkers/readConflictMarker
    const minimalStore = {
      readParsed: vi.fn(),
      listDir: vi.fn(),
    };
    const loader = new MemoryLoader(minimalStore as any);
    const markers = await loader.loadConflictMarkers();
    expect(markers).toEqual([]);
  });

  it("returns [] when listConflictMarkers throws (best-effort)", async () => {
    const failingStore = {
      readParsed: vi.fn(),
      listDir: vi.fn(),
      listConflictMarkers: vi.fn().mockRejectedValue(new Error("R2 down")),
      readConflictMarker: vi.fn(),
    };
    const loader = new MemoryLoader(failingStore as any);
    const markers = await loader.loadConflictMarkers();
    expect(markers).toEqual([]);
  });

  it("skips individual files that fail to parse but returns the rest", async () => {
    const storage = makeMockStorage();
    const store = new MemoryStore(storage as any, USER_ID);
    const token = store.grantWriterToken();

    await store.writeConflictMarker(token, {
      actionType: "delete",
      severity: "high",
      reason: "valid one",
    });
    // Write a corrupt file directly into the mock store
    storage._objects.set(
      `chatcut-memory/${USER_ID}/_conflicts/garbage.md`,
      "not a valid frontmatter file at all",
    );

    const loader = new MemoryLoader(store);
    const markers = await loader.loadConflictMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].reason).toBe("valid one");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// MemoryExtractor.handleRejection — 3+ consecutive trigger
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5c — MemoryExtractor conflict-marker trigger", () => {
  /** Build a minimal ChangeLog stub that satisfies what handleRejection touches. */
  function makeChangeLog(opts: {
    /** Decisions, oldest-first. Each entry maps to a changeset id. */
    decisions: Array<{ type: "changeset_rejected" | "changeset_committed"; changesetId: string }>;
    /** Per-changeset action entries. */
    entriesByChangeset: Record<string, Array<{ id: string; action: { type: string } }>>;
  }) {
    return {
      on: vi.fn(),
      getDecisions: () => opts.decisions,
      getByChangeset: (cid: string) => opts.entriesByChangeset[cid] ?? [],
    } as any;
  }

  function makeReader() {
    return {
      listDir: vi.fn().mockResolvedValue([]),
      readParsed: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
    };
  }

  it("does NOT call writeConflictMarker on the 1st rejection", async () => {
    const writeMemory = vi.fn().mockResolvedValue(undefined);
    const writeConflictMarker = vi.fn().mockResolvedValue(undefined);
    const extractor = new MemoryExtractor({
      changeLog: makeChangeLog({
        decisions: [],
        entriesByChangeset: {
          "cs-1": [{ id: "ch-1", action: { type: "delete" } }],
        },
      }),
      memoryReader: makeReader(),
      writeMemory,
      writeConflictMarker,
    });
    await extractor.handleRejection("cs-1");

    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(writeConflictMarker).not.toHaveBeenCalled();
  });

  it("does NOT call writeConflictMarker on the 2nd rejection", async () => {
    const writeMemory = vi.fn().mockResolvedValue(undefined);
    const writeConflictMarker = vi.fn().mockResolvedValue(undefined);
    const extractor = new MemoryExtractor({
      changeLog: makeChangeLog({
        decisions: [
          { type: "changeset_rejected", changesetId: "cs-1" },
        ],
        entriesByChangeset: {
          "cs-1": [{ id: "ch-1", action: { type: "delete" } }],
          "cs-2": [{ id: "ch-2", action: { type: "delete" } }],
        },
      }),
      memoryReader: makeReader(),
      writeMemory,
      writeConflictMarker,
    });
    await extractor.handleRejection("cs-2");

    expect(writeConflictMarker).not.toHaveBeenCalled();
  });

  it("CALLS writeConflictMarker on the 3rd consecutive same-type rejection", async () => {
    const writeMemory = vi.fn().mockResolvedValue(undefined);
    const writeConflictMarker = vi.fn().mockResolvedValue(undefined);
    const extractor = new MemoryExtractor({
      changeLog: makeChangeLog({
        decisions: [
          { type: "changeset_rejected", changesetId: "cs-1" },
          { type: "changeset_rejected", changesetId: "cs-2" },
        ],
        entriesByChangeset: {
          "cs-1": [{ id: "ch-1", action: { type: "delete" } }],
          "cs-2": [{ id: "ch-2", action: { type: "delete" } }],
          "cs-3": [{ id: "ch-3", action: { type: "delete" } }],
        },
      }),
      memoryReader: makeReader(),
      writeMemory,
      writeConflictMarker,
    });
    await extractor.handleRejection("cs-3");

    expect(writeConflictMarker).toHaveBeenCalledTimes(1);
    const callArg = writeConflictMarker.mock.calls[0][0] as Parameters<
      typeof writeConflictMarker
    >[0];
    expect(callArg.actionType).toBe("delete");
    expect(callArg.severity).toBe("high");
    expect(callArg.conflictsWith).toEqual([expect.stringMatching(/^drafts\/mem-/)]);
    expect(callArg.reason).toMatch(/3 consecutive/);
  });

  it("does NOT trigger when the 3 rejections are different signal types", async () => {
    const writeMemory = vi.fn().mockResolvedValue(undefined);
    const writeConflictMarker = vi.fn().mockResolvedValue(undefined);
    const extractor = new MemoryExtractor({
      changeLog: makeChangeLog({
        decisions: [
          { type: "changeset_rejected", changesetId: "cs-1" },
          { type: "changeset_rejected", changesetId: "cs-2" },
        ],
        entriesByChangeset: {
          "cs-1": [{ id: "ch-1", action: { type: "delete" } }],
          "cs-2": [{ id: "ch-2", action: { type: "trim" } }],
          "cs-3": [{ id: "ch-3", action: { type: "split" } }],
        },
      }),
      memoryReader: makeReader(),
      writeMemory,
      writeConflictMarker,
    });
    await extractor.handleRejection("cs-3");

    expect(writeConflictMarker).not.toHaveBeenCalled();
  });

  it("a writeConflictMarker failure does NOT prevent the draft-memory write", async () => {
    const writeMemory = vi.fn().mockResolvedValue(undefined);
    const writeConflictMarker = vi
      .fn()
      .mockRejectedValue(new Error("R2 down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const extractor = new MemoryExtractor({
      changeLog: makeChangeLog({
        decisions: [
          { type: "changeset_rejected", changesetId: "cs-1" },
          { type: "changeset_rejected", changesetId: "cs-2" },
        ],
        entriesByChangeset: {
          "cs-1": [{ id: "ch-1", action: { type: "delete" } }],
          "cs-2": [{ id: "ch-2", action: { type: "delete" } }],
          "cs-3": [{ id: "ch-3", action: { type: "delete" } }],
        },
      }),
      memoryReader: makeReader(),
      writeMemory,
      writeConflictMarker,
    });
    await extractor.handleRejection("cs-3");

    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(writeConflictMarker).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("works without writeConflictMarker wired (legacy/minimal boots)", async () => {
    const writeMemory = vi.fn().mockResolvedValue(undefined);
    const extractor = new MemoryExtractor({
      changeLog: makeChangeLog({
        decisions: [
          { type: "changeset_rejected", changesetId: "cs-1" },
          { type: "changeset_rejected", changesetId: "cs-2" },
        ],
        entriesByChangeset: {
          "cs-1": [{ id: "ch-1", action: { type: "delete" } }],
          "cs-2": [{ id: "ch-2", action: { type: "delete" } }],
          "cs-3": [{ id: "ch-3", action: { type: "delete" } }],
        },
      }),
      memoryReader: makeReader(),
      writeMemory,
      // writeConflictMarker omitted — must not throw
    });
    await expect(extractor.handleRejection("cs-3")).resolves.toBeDefined();
    expect(writeMemory).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// End-to-end: rejection → marker file → next-turn loader sees it
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5c — end-to-end (rejection → marker → loader)", () => {
  it("3 consecutive delete rejections produce a marker the loader returns", async () => {
    const storage = makeMockStorage();
    const store = new MemoryStore(storage as any, USER_ID);
    const token = store.grantWriterToken();

    // Wire the master-bound writeConflictMarker callback shape (this is what
    // index.ts does in production via masterAgent.getConflictMarkerWriter()).
    const writeConflictMarker = (params: Parameters<
      typeof store.writeConflictMarker
    >[1]) => store.writeConflictMarker(token, params).then(() => undefined);

    const writeMemory = (path: string, memory: Parameters<typeof store.writeMemory>[2]) =>
      store.writeMemory(token, path, memory);

    const decisions: Array<{
      type: "changeset_rejected" | "changeset_committed";
      changesetId: string;
    }> = [];
    const entriesByChangeset: Record<
      string,
      Array<{ id: string; action: { type: string } }>
    > = {};

    const changeLog = {
      on: vi.fn(),
      getDecisions: () => decisions,
      getByChangeset: (cid: string) => entriesByChangeset[cid] ?? [],
    };

    const extractor = new MemoryExtractor({
      changeLog: changeLog as any,
      memoryReader: store,
      writeMemory: writeMemory as any,
      writeConflictMarker,
    });

    // Simulate three rejections of "delete" in sequence.
    for (let i = 1; i <= 3; i++) {
      const cid = `cs-${i}`;
      entriesByChangeset[cid] = [
        { id: `ch-${i}`, action: { type: "delete" } },
      ];
      await extractor.handleRejection(cid);
      decisions.push({ type: "changeset_rejected", changesetId: cid });
    }

    // Loader should now find exactly one marker (only the 3rd rejection wrote it)
    const loader = new MemoryLoader(store);
    const markers = await loader.loadConflictMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].action_type).toBe("delete");
    expect(markers[0].severity).toBe("high");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5c.3 regression: ensure _conflicts/* is NOT in the regular memory
// templates anymore (we route it through the dedicated path).
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5c.3 — _conflicts/* is no longer in QUERY_TEMPLATES", () => {
  it("loadMemories does NOT call listConflictMarkers via template expansion", async () => {
    const listConflictMarkers = vi.fn().mockResolvedValue([]);
    const readConflictMarker = vi.fn();
    const listDir = vi.fn().mockResolvedValue([]);
    // Reject so the loader's per-file try/catch skips cleanly. Returning
    // undefined would let the loader push a malformed candidate into the
    // index — masking the actual contract we're testing.
    const readParsed = vi.fn().mockRejectedValue(new Error("NoSuchKey"));

    const fakeStore = {
      readParsed,
      listDir,
      listConflictMarkers,
      readConflictMarker,
    };
    const loader = new MemoryLoader(fakeStore as any);
    await loader.loadMemories(
      {
        brand: "TestBrand",
        sessionId: "sess-1",
        agentType: "master",
      },
      "batch-production",
    );

    // Templates expand to listDir calls; conflicts go through their own path.
    // listConflictMarkers should NOT have fired during loadMemories.
    expect(listConflictMarkers).not.toHaveBeenCalled();
    // Sanity: listDir WAS called for the other template entries
    expect(listDir.mock.calls.length).toBeGreaterThan(0);
    // And none of those listDir calls were for the conflicts dir
    for (const call of listDir.mock.calls) {
      expect(call[0]).not.toBe("_conflicts/");
    }
  });
});
