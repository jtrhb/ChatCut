import { describe, it, expect, beforeEach } from "vitest";
import { ChangeLog } from "@opencut/core";
import { ServerEditorCore } from "../../services/server-editor-core.js";
import { ChangesetManager } from "../changeset-manager.js";
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
});
