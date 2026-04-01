import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../session-manager.js";
import { SessionStore } from "../session-store.js";
import type { SessionMessage } from "../types.js";

const TEST_PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_PROJECT_ID = "660e8400-e29b-41d4-a716-446655440001";

function makeMessage(role: SessionMessage["role"] = "user"): SessionMessage {
  return { role, content: "hello", timestamp: Date.now() };
}

let store: SessionStore;
let manager: SessionManager;

beforeEach(() => {
  store = new SessionStore();
  manager = new SessionManager(store);
});

describe("SessionManager", () => {
  describe("createSession", () => {
    it("returns new session with unique ID, status 'active', empty messages, turnCount 0", () => {
      const session = manager.createSession({ projectId: TEST_PROJECT_ID });
      expect(session.sessionId).toBeTypeOf("string");
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.status).toBe("active");
      expect(session.messages).toEqual([]);
      expect(session.turnCount).toBe(0);
      expect(session.projectId).toBe(TEST_PROJECT_ID);
      expect(session.totalTokens).toEqual({ input: 0, output: 0 });
    });

    it("stores session in store (retrievable via getSession)", () => {
      const session = manager.createSession({ projectId: TEST_PROJECT_ID });
      const retrieved = manager.getSession(session.sessionId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe(session.sessionId);
    });

    it("generates unique IDs for each session", () => {
      const a = manager.createSession({ projectId: TEST_PROJECT_ID });
      const b = manager.createSession({ projectId: TEST_PROJECT_ID });
      expect(a.sessionId).not.toBe(b.sessionId);
    });

    it("stores provided metadata", () => {
      const session = manager.createSession({
        projectId: TEST_PROJECT_ID,
        metadata: { source: "api" },
      });
      expect(session.metadata).toEqual({ source: "api" });
    });
  });

  describe("getSession", () => {
    it("returns undefined for unknown session", () => {
      const result = manager.getSession("non-existent-id");
      expect(result).toBeUndefined();
    });
  });

  describe("appendMessage", () => {
    it("adds message to session", () => {
      const session = manager.createSession({ projectId: TEST_PROJECT_ID });
      const msg = makeMessage("user");
      manager.appendMessage(session.sessionId, msg);
      const updated = manager.getSession(session.sessionId)!;
      expect(updated.messages).toHaveLength(1);
      expect(updated.messages[0].role).toBe("user");
    });

    it("throws for unknown session", () => {
      expect(() =>
        manager.appendMessage("no-such-id", makeMessage())
      ).toThrow("Session not found: no-such-id");
    });
  });

  describe("updateStatus", () => {
    it("updates session status", () => {
      const session = manager.createSession({ projectId: TEST_PROJECT_ID });
      manager.updateStatus(session.sessionId, "paused");
      const updated = manager.getSession(session.sessionId)!;
      expect(updated.status).toBe("paused");
    });

    it("throws for unknown session", () => {
      expect(() => manager.updateStatus("no-such-id", "completed")).toThrow(
        "Session not found: no-such-id"
      );
    });
  });

  describe("incrementTurn", () => {
    it("increments turnCount and accumulates tokens", () => {
      const session = manager.createSession({ projectId: TEST_PROJECT_ID });
      manager.incrementTurn(session.sessionId, { input: 100, output: 50 });
      const updated = manager.getSession(session.sessionId)!;
      expect(updated.turnCount).toBe(1);
      expect(updated.totalTokens).toEqual({ input: 100, output: 50 });
    });

    it("accumulates across multiple turns", () => {
      const session = manager.createSession({ projectId: TEST_PROJECT_ID });
      manager.incrementTurn(session.sessionId, { input: 100, output: 50 });
      manager.incrementTurn(session.sessionId, { input: 200, output: 75 });
      const updated = manager.getSession(session.sessionId)!;
      expect(updated.turnCount).toBe(2);
      expect(updated.totalTokens).toEqual({ input: 300, output: 125 });
    });

    it("throws for unknown session", () => {
      expect(() =>
        manager.incrementTurn("no-such-id", { input: 1, output: 1 })
      ).toThrow("Session not found: no-such-id");
    });
  });

  describe("forkSession", () => {
    it("creates new session with parentSessionId and copies messages", () => {
      const parent = manager.createSession({ projectId: TEST_PROJECT_ID });
      manager.appendMessage(parent.sessionId, makeMessage("user"));
      manager.appendMessage(parent.sessionId, makeMessage("assistant"));

      const forked = manager.forkSession(parent.sessionId);

      expect(forked.sessionId).not.toBe(parent.sessionId);
      expect(forked.parentSessionId).toBe(parent.sessionId);
      expect(forked.messages).toHaveLength(2);
      expect(forked.status).toBe("active");
      expect(forked.turnCount).toBe(0);
      expect(forked.totalTokens).toEqual({ input: 0, output: 0 });
    });

    it("forked messages are independent copies (no shared reference)", () => {
      const parent = manager.createSession({ projectId: TEST_PROJECT_ID });
      manager.appendMessage(parent.sessionId, makeMessage("user"));
      const forked = manager.forkSession(parent.sessionId);

      // Append to forked — parent should be unaffected
      manager.appendMessage(forked.sessionId, makeMessage("assistant"));
      const updatedParent = manager.getSession(parent.sessionId)!;
      const updatedForked = manager.getSession(forked.sessionId)!;
      expect(updatedParent.messages).toHaveLength(1);
      expect(updatedForked.messages).toHaveLength(2);
    });

    it("throws for unknown parent session", () => {
      expect(() => manager.forkSession("no-such-id")).toThrow(
        "Session not found: no-such-id"
      );
    });
  });

  describe("listSessions", () => {
    it("filters by projectId", () => {
      manager.createSession({ projectId: TEST_PROJECT_ID });
      manager.createSession({ projectId: TEST_PROJECT_ID });
      manager.createSession({ projectId: OTHER_PROJECT_ID });

      const results = manager.listSessions(TEST_PROJECT_ID);
      expect(results).toHaveLength(2);
      expect(results.every((s) => s.projectId === TEST_PROJECT_ID)).toBe(true);
    });

    it("returns empty array when no sessions for project", () => {
      const results = manager.listSessions(TEST_PROJECT_ID);
      expect(results).toEqual([]);
    });
  });

  describe("saveSession / restoreSession", () => {
    it("roundtrip serialization preserves all fields", () => {
      const session = manager.createSession({
        projectId: TEST_PROJECT_ID,
        metadata: { foo: "bar" },
      });
      manager.appendMessage(session.sessionId, makeMessage("user"));
      manager.incrementTurn(session.sessionId, { input: 10, output: 5 });
      manager.updateStatus(session.sessionId, "paused");

      const serialized = manager.saveSession(session.sessionId);
      expect(typeof serialized).toBe("string");

      // Restore into a fresh manager
      const freshStore = new SessionStore();
      const freshManager = new SessionManager(freshStore);
      const restored = freshManager.restoreSession(serialized);

      expect(restored.sessionId).toBe(session.sessionId);
      expect(restored.projectId).toBe(TEST_PROJECT_ID);
      expect(restored.status).toBe("paused");
      expect(restored.messages).toHaveLength(1);
      expect(restored.turnCount).toBe(1);
      expect(restored.totalTokens).toEqual({ input: 10, output: 5 });
      expect(restored.metadata).toEqual({ foo: "bar" });
    });

    it("saveSession throws for unknown session", () => {
      expect(() => manager.saveSession("no-such-id")).toThrow(
        "Session not found: no-such-id"
      );
    });

    it("restored session is retrievable via getSession", () => {
      const session = manager.createSession({ projectId: TEST_PROJECT_ID });
      const serialized = manager.saveSession(session.sessionId);

      const freshManager = new SessionManager(new SessionStore());
      freshManager.restoreSession(serialized);
      const retrieved = freshManager.getSession(session.sessionId);
      expect(retrieved).toBeDefined();
    });
  });
});
