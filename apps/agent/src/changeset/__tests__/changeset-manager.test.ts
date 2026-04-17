import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChangeLog } from "@opencut/core";
import { ServerEditorCore } from "../../services/server-editor-core.js";
import {
  ChangesetManager,
  StaleStateError,
  ChangesetOwnerMismatchError,
} from "../changeset-manager.js";
import type { SerializedEditorState } from "@opencut/core";

const emptyState: SerializedEditorState = {
  project: null,
  scenes: [],
  activeSceneId: null,
};

function makeManager() {
  const changeLog = new ChangeLog();
  const serverCore = ServerEditorCore.fromSnapshot(emptyState);
  const manager = new ChangesetManager({ changeLog, serverCore });
  return { changeLog, serverCore, manager };
}

describe("ChangesetManager", () => {
  describe("propose()", () => {
    it("records boundary cursor from changeLog length", async () => {
      const { changeLog, manager } = makeManager();
      // Add two entries first so length = 2, boundaryCursor should be 1
      changeLog.record({
        source: "agent",
        action: { type: "insert", targetType: "element", targetId: "e1", details: {} },
        summary: "entry 1",
      });
      changeLog.record({
        source: "agent",
        action: { type: "insert", targetType: "element", targetId: "e2", details: {} },
        summary: "entry 2",
      });

      const cs = await manager.propose({ summary: "test", affectedElements: [] });
      expect(cs.boundaryCursor).toBe(1); // length(2) - 1
    });

    it("returns PendingChangeset with status 'pending'", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "my change", affectedElements: ["el-1"] });

      expect(cs.status).toBe("pending");
      expect(cs.changesetId).toBeTruthy();
      expect(cs.summary).toBe("my change");
      expect(cs.fingerprint.elementIds).toEqual(["el-1"]);
      expect(cs.createdAt).toBeGreaterThan(0);
      expect(cs.decidedAt).toBeUndefined();
    });

    it("records boundaryCursor as -1 when changeLog is empty", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "empty log", affectedElements: [] });
      expect(cs.boundaryCursor).toBe(-1);
    });
  });

  describe("approve()", () => {
    it("emits changeset_committed decision to changeLog", async () => {
      const { changeLog, manager } = makeManager();
      const cs = await manager.propose({ summary: "approve me", affectedElements: [] });

      await manager.approve(cs.changesetId);

      const decisions = changeLog.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("changeset_committed");
      expect(decisions[0].changesetId).toBe(cs.changesetId);
      expect(decisions[0].timestamp).toBeGreaterThan(0);
    });

    it("sets status to 'approved' with decidedAt", async () => {
      const { manager } = makeManager();
      const before = Date.now();
      const cs = await manager.propose({ summary: "approve me", affectedElements: [] });
      await manager.approve(cs.changesetId);

      const updated = manager.getChangeset(cs.changesetId)!;
      expect(updated.status).toBe("approved");
      expect(updated.decidedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("reject()", () => {
    it("emits changeset_rejected decision to changeLog", async () => {
      const { changeLog, manager } = makeManager();
      const cs = await manager.propose({ summary: "reject me", affectedElements: [] });

      await manager.reject(cs.changesetId);

      const decisions = changeLog.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("changeset_rejected");
      expect(decisions[0].changesetId).toBe(cs.changesetId);
    });

    it("sets status to 'rejected'", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "reject me", affectedElements: [] });
      await manager.reject(cs.changesetId);

      const updated = manager.getChangeset(cs.changesetId)!;
      expect(updated.status).toBe("rejected");
      expect(updated.decidedAt).toBeDefined();
    });
  });

  describe("approveWithMods()", () => {
    it("records human modifications to changeLog before approving", async () => {
      const { changeLog, manager } = makeManager();
      const cs = await manager.propose({ summary: "approve with mods", affectedElements: ["el-1"] });

      await manager.approveWithMods(cs.changesetId, [
        { type: "trim", targetId: "el-1", details: { start: 0, end: 5 } },
        { type: "update", targetId: "el-2", details: { volume: 0.8 } },
      ]);

      const entries = changeLog.getAll();
      expect(entries).toHaveLength(2);
      expect(entries[0].source).toBe("human");
      expect(entries[0].changesetId).toBe(cs.changesetId);
      expect(entries[1].source).toBe("human");
    });

    it("approves the changeset after recording modifications", async () => {
      const { changeLog, manager } = makeManager();
      const cs = await manager.propose({ summary: "approve with mods", affectedElements: [] });

      await manager.approveWithMods(cs.changesetId, [
        { type: "trim", targetId: "el-1", details: {} },
      ]);

      const updated = manager.getChangeset(cs.changesetId)!;
      expect(updated.status).toBe("approved");

      const decisions = changeLog.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("changeset_committed");
    });
  });

  describe("getPending()", () => {
    it("returns current pending changeset", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "pending", affectedElements: [] });

      const pending = manager.getPending();
      expect(pending).not.toBeNull();
      expect(pending!.changesetId).toBe(cs.changesetId);
      expect(pending!.status).toBe("pending");
    });

    it("returns null when no changeset is pending", () => {
      const { manager } = makeManager();
      expect(manager.getPending()).toBeNull();
    });

    it("returns null after the pending changeset is approved", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "will be approved", affectedElements: [] });
      await manager.approve(cs.changesetId);

      expect(manager.getPending()).toBeNull();
    });

    it("returns null after the pending changeset is rejected", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "will be rejected", affectedElements: [] });
      await manager.reject(cs.changesetId);

      expect(manager.getPending()).toBeNull();
    });
  });

  describe("error cases", () => {
    it("cannot approve an already-rejected changeset (throws)", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "double decision", affectedElements: [] });
      await manager.reject(cs.changesetId);

      await expect(manager.approve(cs.changesetId)).rejects.toThrow(
        'Cannot approve changeset with status "rejected"'
      );
    });

    it("cannot reject an already-approved changeset (throws)", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "double decision", affectedElements: [] });
      await manager.approve(cs.changesetId);

      await expect(manager.reject(cs.changesetId)).rejects.toThrow(
        'Cannot reject changeset with status "approved"'
      );
    });
  });

  describe("B5: propose stores review-lock metadata", () => {
    it("records baseSnapshotVersion from serverCore at propose time", async () => {
      const { manager, serverCore } = makeManager();
      const versionAtPropose = serverCore.snapshotVersion;

      const cs = await manager.propose({ summary: "test", affectedElements: [] });

      expect(cs.baseSnapshotVersion).toBe(versionAtPropose);
    });

    it("reviewLock starts true; flips to false after approve", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({
        summary: "r",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });
      expect(cs.reviewLock).toBe(true);

      await manager.approve(cs.changesetId, { userId: "alice", projectId: "proj-1" });

      const after = manager.getChangeset(cs.changesetId)!;
      expect(after.reviewLock).toBe(false);
    });

    it("reviewLock flips to false after reject too", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({
        summary: "r",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });
      await manager.reject(cs.changesetId, { userId: "alice", projectId: "proj-1" });
      expect(manager.getChangeset(cs.changesetId)!.reviewLock).toBe(false);
    });

    it("records owner userId (defaults to 'unscoped' when not provided)", async () => {
      const { manager } = makeManager();
      const cs1 = await manager.propose({ summary: "a", affectedElements: [] });
      expect(cs1.userId).toBe("unscoped");

      const cs2 = await manager.propose({
        summary: "b",
        affectedElements: [],
        userId: "alice",
      });
      expect(cs2.userId).toBe("alice");
    });

    it("C1: stores injectedMemoryIds / injectedSkillIds when provided", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        injectedMemoryIds: ["mem-a", "mem-b"],
        injectedSkillIds: ["skill-1"],
      });
      expect(cs.injectedMemoryIds).toEqual(["mem-a", "mem-b"]);
      expect(cs.injectedSkillIds).toEqual(["skill-1"]);
    });

    it("C1: defaults injected IDs to empty arrays when omitted", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "s", affectedElements: [] });
      expect(cs.injectedMemoryIds).toEqual([]);
      expect(cs.injectedSkillIds).toEqual([]);
    });
  });

  describe("B5: owner (IDOR) check", () => {
    it("approve rejects an actor whose userId doesn't match the owner", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });

      await expect(
        manager.approve(cs.changesetId, { userId: "eve", projectId: "proj-1" }),
      ).rejects.toThrowError(ChangesetOwnerMismatchError);
      // And didn't terminate the changeset
      expect(manager.getChangeset(cs.changesetId)!.status).toBe("pending");
    });

    it("approve rejects an actor whose projectId doesn't match", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });

      await expect(
        manager.approve(cs.changesetId, { userId: "alice", projectId: "proj-2" }),
      ).rejects.toThrowError(ChangesetOwnerMismatchError);
    });

    it("reject also enforces owner check", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });
      await expect(
        manager.reject(cs.changesetId, { userId: "eve", projectId: "proj-1" }),
      ).rejects.toThrowError(ChangesetOwnerMismatchError);
    });

    it("approve allowed without actor for legacy callers (backward compat)", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({ summary: "s", affectedElements: [] });
      // No actor — owner check skipped
      await expect(manager.approve(cs.changesetId)).resolves.toBeUndefined();
    });
  });

  describe("B5: staleness / StaleStateError", () => {
    it("throws StaleStateError when snapshotVersion has advanced during review", async () => {
      const { manager, serverCore } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });

      // Simulate a concurrent mutation bumping snapshotVersion
      (serverCore as unknown as { _version: number })._version++;

      await expect(
        manager.approve(cs.changesetId, { userId: "alice", projectId: "proj-1" }),
      ).rejects.toThrowError(StaleStateError);
    });

    it("StaleStateError carries baseSnapshotVersion / currentSnapshotVersion details", async () => {
      const { manager, serverCore } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });
      (serverCore as unknown as { _version: number })._version = 42;

      try {
        await manager.approve(cs.changesetId, { userId: "alice", projectId: "proj-1" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(StaleStateError);
        const e = err as StaleStateError;
        expect(e.details.baseSnapshotVersion).toBe(0);
        expect(e.details.currentSnapshotVersion).toBe(42);
      }
    });

    it("throws StaleStateError when a human ChangeLog entry lands after boundary", async () => {
      const { manager, changeLog } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });

      changeLog.record({
        source: "human",
        action: { type: "update", targetType: "element", targetId: "e1", details: {} },
        summary: "human edit during review",
      });

      await expect(
        manager.approve(cs.changesetId, { userId: "alice", projectId: "proj-1" }),
      ).rejects.toThrowError(StaleStateError);
    });

    it("tolerates agent ChangeLog entries after boundary (only human entries count)", async () => {
      const { manager, changeLog } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });

      changeLog.record({
        source: "agent",
        agentId: "editor",
        action: { type: "update", targetType: "element", targetId: "e1", details: {} },
        summary: "agent edit within the changeset",
      });

      await expect(
        manager.approve(cs.changesetId, { userId: "alice", projectId: "proj-1" }),
      ).resolves.toBeUndefined();
    });

    it("rejects the StaleStateError shape: changesetId + snapshot versions + count", async () => {
      const { manager, serverCore, changeLog } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });
      (serverCore as unknown as { _version: number })._version++;
      changeLog.record({
        source: "human",
        action: { type: "update", targetType: "element", targetId: "e1", details: {} },
        summary: "h",
      });

      try {
        await manager.reject(cs.changesetId, { userId: "alice", projectId: "proj-1" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(StaleStateError);
        const e = err as StaleStateError;
        expect(e.details.changesetId).toBe(cs.changesetId);
        expect(e.details.interveningHumanEntries).toBe(1);
        expect(e.kind).toBe("stale-state");
      }
    });
  });

  describe("B5: approveWithMods enforces gates", () => {
    it("approveWithMods throws StaleStateError without recording human mods when stale", async () => {
      const { manager, serverCore, changeLog } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });
      const entriesBefore = changeLog.length;
      (serverCore as unknown as { _version: number })._version++;

      await expect(
        manager.approveWithMods(
          cs.changesetId,
          [{ type: "trim", targetId: "e1", details: {} }],
          { userId: "alice", projectId: "proj-1" },
        ),
      ).rejects.toThrowError(StaleStateError);

      // No mods recorded
      expect(changeLog.length).toBe(entriesBefore);
      expect(manager.getChangeset(cs.changesetId)!.status).toBe("pending");
    });

    it("approveWithMods throws owner-mismatch when actor doesn't match", async () => {
      const { manager } = makeManager();
      const cs = await manager.propose({
        summary: "s",
        affectedElements: [],
        userId: "alice",
        projectId: "proj-1",
      });
      await expect(
        manager.approveWithMods(
          cs.changesetId,
          [{ type: "trim", targetId: "e1", details: {} }],
          { userId: "eve", projectId: "proj-1" },
        ),
      ).rejects.toThrowError(ChangesetOwnerMismatchError);
    });
  });

  describe("B6: terminal-state retention", () => {
    it("evicts approved/rejected changesets past terminalRetentionMs on next propose", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      try {
        const changeLog = new ChangeLog();
        const serverCore = ServerEditorCore.fromSnapshot(emptyState);
        const manager = new ChangesetManager({
          changeLog,
          serverCore,
          terminalRetentionMs: 10_000,
        });

        const approved = await manager.propose({
          summary: "a",
          affectedElements: [],
          userId: "alice",
          projectId: "p1",
        });
        await manager.approve(approved.changesetId, { userId: "alice", projectId: "p1" });

        const rejected = await manager.propose({
          summary: "r",
          affectedElements: [],
          userId: "alice",
          projectId: "p1",
        });
        await manager.reject(rejected.changesetId, { userId: "alice", projectId: "p1" });

        // Both are terminal; wait past retention window
        vi.advanceTimersByTime(10_001);

        // Triggering propose should sweep them
        await manager.propose({
          summary: "fresh",
          affectedElements: [],
          userId: "alice",
          projectId: "p1",
        });

        expect(manager.getChangeset(approved.changesetId)).toBeUndefined();
        expect(manager.getChangeset(rejected.changesetId)).toBeUndefined();
        expect(manager.size()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps pending changesets regardless of age", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      try {
        const changeLog = new ChangeLog();
        const serverCore = ServerEditorCore.fromSnapshot(emptyState);
        const manager = new ChangesetManager({
          changeLog,
          serverCore,
          terminalRetentionMs: 10_000,
        });

        const pending = await manager.propose({
          summary: "stays",
          affectedElements: [],
          userId: "alice",
          projectId: "p1",
        });

        vi.advanceTimersByTime(60_000);
        await manager.propose({
          summary: "trigger",
          affectedElements: [],
          userId: "alice",
          projectId: "p1",
        });

        expect(manager.getChangeset(pending.changesetId)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
