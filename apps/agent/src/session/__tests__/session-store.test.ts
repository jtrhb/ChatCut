import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../session-store.js";
import type { AgentSession } from "../types.js";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: "sess-1",
    projectId: "proj-1",
    status: "active",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as AgentSession;
}

describe("SessionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic get/set/delete", () => {
    it("get returns undefined when id is unknown", () => {
      const store = new SessionStore();
      expect(store.get("nope")).toBeUndefined();
    });

    it("set + get round-trips the session", () => {
      const store = new SessionStore();
      store.set(makeSession({ sessionId: "s1" }));
      expect(store.get("s1")?.sessionId).toBe("s1");
    });

    it("delete removes the entry", () => {
      const store = new SessionStore();
      store.set(makeSession({ sessionId: "s1" }));
      expect(store.delete("s1")).toBe(true);
      expect(store.get("s1")).toBeUndefined();
    });
  });

  describe("B6: TTL eviction", () => {
    it("get returns undefined after maxIdleMs has elapsed", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "s1" }));

      vi.advanceTimersByTime(10_001);

      expect(store.get("s1")).toBeUndefined();
    });

    it("get returns the session when within maxIdleMs", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "s1" }));

      vi.advanceTimersByTime(5_000);

      expect(store.get("s1")?.sessionId).toBe("s1");
    });

    it("get cleans up the expired record (size decreases)", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "s1" }));
      expect(store.size()).toBe(1);

      vi.advanceTimersByTime(10_001);
      store.get("s1");

      expect(store.size()).toBe(0);
    });

    it("set triggers an opportunistic sweep of expired entries", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "s1" }));
      store.set(makeSession({ sessionId: "s2" }));
      expect(store.size()).toBe(2);

      vi.advanceTimersByTime(10_001);
      // Fresh write: sweep should drop s1 and s2, leaving just s3
      store.set(makeSession({ sessionId: "s3" }));

      expect(store.size()).toBe(1);
      expect(store.get("s3")?.sessionId).toBe("s3");
    });

    it("countByStatus and listByProject skip expired entries", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "s1", status: "active", projectId: "p1" }));
      store.set(makeSession({ sessionId: "s2", status: "active", projectId: "p1" }));

      vi.advanceTimersByTime(10_001);

      expect(store.countByStatus("active")).toBe(0);
      expect(store.listByProject("p1")).toEqual([]);
    });

    it("sweepExpired removes all expired in one pass", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "s1" }));
      store.set(makeSession({ sessionId: "s2" }));
      store.set(makeSession({ sessionId: "s3" }));

      vi.advanceTimersByTime(10_001);
      const removed = store.sweepExpired();

      expect(removed).toBe(3);
      expect(store.size()).toBe(0);
    });

    it("review D5: EXACTLY at maxIdleMs does NOT evict (uses `>`, not `>=`)", async () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "s1" }));

      // Advance exactly to the boundary: idle === maxIdleMs.
      // Implementation uses `> maxIdleMs` so equality must still survive.
      vi.advanceTimersByTime(10_000);
      expect(store.get("s1")?.sessionId).toBe("s1");

      // One more ms → evict.
      vi.advanceTimersByTime(1);
      expect(store.get("s1")).toBeUndefined();
    });

    it("review D5: listByProject and countByStatus INCLUDE fresh entries (mixed with expired)", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "stale", status: "active", projectId: "p1" }));

      vi.advanceTimersByTime(8_000);
      store.set(makeSession({ sessionId: "fresh", status: "active", projectId: "p1" }));

      vi.advanceTimersByTime(3_000);
      // `stale` now 11s idle (expired); `fresh` 3s (alive).

      expect(store.countByStatus("active")).toBe(1);
      const projectSessions = store.listByProject("p1");
      expect(projectSessions).toHaveLength(1);
      expect(projectSessions[0].sessionId).toBe("fresh");
    });

    it("does not evict recently-touched entries when other entries expire", () => {
      const store = new SessionStore({ maxIdleMs: 10_000 });
      store.set(makeSession({ sessionId: "old" }));

      vi.advanceTimersByTime(8_000);
      store.set(makeSession({ sessionId: "fresh" }));

      vi.advanceTimersByTime(3_000);
      // Now "old" has been idle 11s (expired), "fresh" 3s (alive).
      store.sweepExpired();

      expect(store.get("old")).toBeUndefined();
      expect(store.get("fresh")?.sessionId).toBe("fresh");
    });
  });

  describe("B6: maxEntries ceiling", () => {
    it("evicts the oldest-updated entry when capacity is exceeded", () => {
      const store = new SessionStore({ maxIdleMs: 3600_000, maxEntries: 2 });
      store.set(makeSession({ sessionId: "s1" }));
      vi.advanceTimersByTime(100);
      store.set(makeSession({ sessionId: "s2" }));
      vi.advanceTimersByTime(100);
      store.set(makeSession({ sessionId: "s3" }));

      // s1 was the oldest at the time of s3's arrival → evicted
      expect(store.get("s1")).toBeUndefined();
      expect(store.get("s2")?.sessionId).toBe("s2");
      expect(store.get("s3")?.sessionId).toBe("s3");
    });
  });
});
