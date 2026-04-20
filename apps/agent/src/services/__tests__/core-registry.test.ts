import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoreRegistry, type ProjectSnapshotSource } from "../core-registry.js";
import type { SerializedEditorState } from "@opencut/core";

const emptyState: SerializedEditorState = {
  project: null,
  scenes: [],
  activeSceneId: null,
};

function makeSource(
  rows: Record<
    string,
    { snapshot: SerializedEditorState; snapshotVersion: number; lastCommittedChangeId: string | null } | null
  >,
): { source: ProjectSnapshotSource; loadSnapshot: ReturnType<typeof vi.fn> } {
  const loadSnapshot = vi.fn(async (projectId: string) => rows[projectId] ?? null);
  return { source: { loadSnapshot }, loadSnapshot };
}

describe("CoreRegistry", () => {
  describe("get()", () => {
    it("loads from source on first call and returns a hydrated ServerEditorCore at the right version", async () => {
      const { source } = makeSource({
        "p1": { snapshot: emptyState, snapshotVersion: 7, lastCommittedChangeId: "c-7" },
      });
      const registry = new CoreRegistry({ source });

      const core = await registry.get("p1");

      expect(core.snapshotVersion).toBe(7);
      expect(core.serialize()).toEqual(emptyState);
    });

    it("caches: second call returns the same instance, source loader called once", async () => {
      const { source, loadSnapshot } = makeSource({
        "p1": { snapshot: emptyState, snapshotVersion: 0, lastCommittedChangeId: null },
      });
      const registry = new CoreRegistry({ source });

      const a = await registry.get("p1");
      const b = await registry.get("p1");

      expect(a).toBe(b);
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent loads for the same projectId (single source call)", async () => {
      const { source, loadSnapshot } = makeSource({
        "p1": { snapshot: emptyState, snapshotVersion: 0, lastCommittedChangeId: null },
      });
      const registry = new CoreRegistry({ source });

      const [a, b, c] = await Promise.all([
        registry.get("p1"),
        registry.get("p1"),
        registry.get("p1"),
      ]);

      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    });

    it("isolates state between projectIds (different cores)", async () => {
      const { source } = makeSource({
        "p1": { snapshot: emptyState, snapshotVersion: 1, lastCommittedChangeId: null },
        "p2": { snapshot: emptyState, snapshotVersion: 2, lastCommittedChangeId: null },
      });
      const registry = new CoreRegistry({ source });

      const a = await registry.get("p1");
      const b = await registry.get("p2");

      expect(a).not.toBe(b);
      expect(a.snapshotVersion).toBe(1);
      expect(b.snapshotVersion).toBe(2);
    });

    it("throws when loader returns null (project not found)", async () => {
      const { source } = makeSource({});
      const registry = new CoreRegistry({ source });

      await expect(registry.get("missing")).rejects.toThrowError(/missing/);
    });

    it("does not cache failed loads (next get retries the source)", async () => {
      const { source, loadSnapshot } = makeSource({});
      const registry = new CoreRegistry({ source });

      await expect(registry.get("p1")).rejects.toThrow();
      await expect(registry.get("p1")).rejects.toThrow();

      expect(loadSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe("has()", () => {
    it("returns false before first get, true after a successful get", async () => {
      const { source } = makeSource({
        "p1": { snapshot: emptyState, snapshotVersion: 0, lastCommittedChangeId: null },
      });
      const registry = new CoreRegistry({ source });

      expect(registry.has("p1")).toBe(false);
      await registry.get("p1");
      expect(registry.has("p1")).toBe(true);
    });
  });

  describe("invalidate()", () => {
    it("drops cached entry; next get reloads from source", async () => {
      const { source, loadSnapshot } = makeSource({
        "p1": { snapshot: emptyState, snapshotVersion: 0, lastCommittedChangeId: null },
      });
      const registry = new CoreRegistry({ source });

      const a = await registry.get("p1");
      registry.invalidate("p1");
      const b = await registry.get("p1");

      expect(a).not.toBe(b);
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe("evictIdle()", () => {
    it("drops projects whose lastAccessed is older than the threshold and returns evicted ids", async () => {
      const { source } = makeSource({
        "cold": { snapshot: emptyState, snapshotVersion: 0, lastCommittedChangeId: null },
        "hot": { snapshot: emptyState, snapshotVersion: 0, lastCommittedChangeId: null },
      });
      const registry = new CoreRegistry({ source });

      const t0 = 1_000_000;
      // Load both at t0
      await registry.get("cold");
      // Spy on Date.now to advance for the second load
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(t0);
      await registry.get("cold"); // touches cold at t0
      now.mockReturnValue(t0 + 60_000);
      await registry.get("hot"); // touches hot at t0+60s

      const evicted = registry.evictIdle(30_000, t0 + 60_000);

      expect(evicted).toEqual(["cold"]);
      expect(registry.has("cold")).toBe(false);
      expect(registry.has("hot")).toBe(true);

      now.mockRestore();
    });

    it("does not interrupt an in-flight load (concurrent evictIdle + get for same id)", async () => {
      // Hold the loader open until we explicitly release it.
      let release!: (row: {
        snapshot: SerializedEditorState;
        snapshotVersion: number;
        lastCommittedChangeId: string | null;
      }) => void;
      const pending = new Promise<{
        snapshot: SerializedEditorState;
        snapshotVersion: number;
        lastCommittedChangeId: string | null;
      }>((resolve) => {
        release = resolve;
      });
      const loadSnapshot = vi.fn(() => pending);
      const registry = new CoreRegistry({ source: { loadSnapshot } });

      const getPromise = registry.get("p1");
      // Eviction with a tight window — there's no lastAccessed entry yet
      // because the load hasn't resolved, so nothing should be evicted.
      const evicted = registry.evictIdle(0, Date.now() + 1_000);
      expect(evicted).toEqual([]);

      release({ snapshot: emptyState, snapshotVersion: 3, lastCommittedChangeId: null });
      const core = await getPromise;
      expect(core.snapshotVersion).toBe(3);
      expect(registry.has("p1")).toBe(true);
    });

    it("returns empty array when nothing is stale", async () => {
      const { source } = makeSource({
        "p1": { snapshot: emptyState, snapshotVersion: 0, lastCommittedChangeId: null },
      });
      const registry = new CoreRegistry({ source });

      const t0 = 2_000_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(t0);
      await registry.get("p1");

      const evicted = registry.evictIdle(60_000, t0 + 10_000);

      expect(evicted).toEqual([]);
      expect(registry.has("p1")).toBe(true);

      now.mockRestore();
    });
  });
});
