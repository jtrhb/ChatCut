import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServerEditorCore } from "../server-editor-core.js";
import { commitMutation, type MutationDB, type MutationTx } from "../commit-mutation.js";
import type { SerializedEditorState, Command } from "@opencut/core";

const emptyState: SerializedEditorState = {
  project: null,
  scenes: [],
  activeSceneId: null,
};

function stubCommand(): Command {
  return { execute: () => {}, undo: () => {} } as unknown as Command;
}

function throwingCommand(message: string): Command {
  return { execute: () => { throw new Error(message); }, undo: () => {} } as unknown as Command;
}

function makeDB(opts: {
  insertedId?: string;
  failOn?: "insert" | "update";
} = {}): {
  db: MutationDB;
  insertSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
} {
  const insertSpy = vi.fn(async () => ({ id: opts.insertedId ?? "change-1" }));
  const updateSpy = vi.fn(async () => {});
  if (opts.failOn === "insert") {
    insertSpy.mockRejectedValue(new Error("insert failed"));
  } else if (opts.failOn === "update") {
    updateSpy.mockRejectedValue(new Error("update failed"));
  }
  const db: MutationDB = {
    transaction: async (fn) => {
      const tx: MutationTx = {
        insertChangeLogEntry: insertSpy,
        updateProjectSnapshot: updateSpy,
      };
      return fn(tx);
    },
  };
  return { db, insertSpy, updateSpy };
}

describe("commitMutation", () => {
  describe("happy path (agent command)", () => {
    let liveCore: ServerEditorCore;
    beforeEach(() => {
      liveCore = ServerEditorCore.fromSnapshot(emptyState, 4);
    });

    it("returns the inserted changeId and the post-swap snapshotVersion", async () => {
      const { db, insertSpy } = makeDB({ insertedId: "ch-42" });
      const result = await commitMutation({
        liveCore,
        projectId: "proj-A",
        command: stubCommand(),
        agentId: "agent-1",
        taskId: "task-A",
        changeEntry: {
          projectId: "proj-A",
          source: "agent",
          actionType: "stub",
          targetType: "track",
          targetId: "t1",
        },
        db,
      });

      expect(result.changeId).toBe("ch-42");
      expect(result.snapshotVersion).toBe(5);
      expect(insertSpy).toHaveBeenCalledTimes(1);
    });

    it("bumps the live core's version exactly once (atomic swap, not double-bump)", async () => {
      const { db } = makeDB();
      await commitMutation({
        liveCore,
        projectId: "proj-A",
        command: stubCommand(),
        agentId: "agent-1",
        changeEntry: { projectId: "proj-A", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
        db,
      });
      expect(liveCore.snapshotVersion).toBe(5);
    });

    it("calls updateProjectSnapshot with the post-execute snapshot + new version + changeId", async () => {
      const { db, updateSpy } = makeDB({ insertedId: "ch-99" });
      await commitMutation({
        liveCore,
        projectId: "proj-A",
        command: stubCommand(),
        agentId: "agent-1",
        changeEntry: { projectId: "proj-A", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
        db,
      });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [pid, opts] = updateSpy.mock.calls[0];
      expect(pid).toBe("proj-A");
      expect(opts.snapshotVersion).toBe(5);
      expect(opts.lastCommittedChangeId).toBe("ch-99");
      expect(opts.snapshot).toBeDefined();
    });

    it("uses executeAgentCommand path when isAgent is true (default), tagged with taskId", async () => {
      const { db } = makeDB();
      const cmd = stubCommand();
      const cmdSpy = vi.spyOn(cmd, "execute");
      await commitMutation({
        liveCore,
        projectId: "proj-A",
        command: cmd,
        agentId: "agent-1",
        taskId: "task-X",
        changeEntry: { projectId: "proj-A", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
        db,
      });
      expect(cmdSpy).toHaveBeenCalled();
    });
  });

  describe("human command path", () => {
    it("uses executeHumanCommand when isAgent is false", async () => {
      const liveCore = ServerEditorCore.fromSnapshot(emptyState, 0);
      const { db } = makeDB();
      const cmd = stubCommand();
      const cmdSpy = vi.spyOn(cmd, "execute");
      await commitMutation({
        liveCore,
        projectId: "proj-A",
        command: cmd,
        isAgent: false,
        changeEntry: { projectId: "proj-A", source: "human", actionType: "x", targetType: "track", targetId: "t1" },
        db,
      });
      expect(cmdSpy).toHaveBeenCalled();
      expect(liveCore.snapshotVersion).toBe(1);
    });
  });

  describe("rollback semantics", () => {
    it("DB tx failure: live core untouched (version unchanged, snapshot unchanged)", async () => {
      const liveCore = ServerEditorCore.fromSnapshot(emptyState, 7);
      const liveStateBefore = liveCore.serialize();
      const { db, updateSpy } = makeDB({ failOn: "update" });

      await expect(
        commitMutation({
          liveCore,
          projectId: "proj-A",
          command: stubCommand(),
          agentId: "agent-1",
          changeEntry: { projectId: "proj-A", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
          db,
        }),
      ).rejects.toThrowError("update failed");

      expect(liveCore.snapshotVersion).toBe(7);
      expect(liveCore.serialize()).toEqual(liveStateBefore);
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    it("insert failure: live core untouched, update never attempted", async () => {
      const liveCore = ServerEditorCore.fromSnapshot(emptyState, 7);
      const { db, updateSpy } = makeDB({ failOn: "insert" });

      await expect(
        commitMutation({
          liveCore,
          projectId: "proj-A",
          command: stubCommand(),
          agentId: "agent-1",
          changeEntry: { projectId: "proj-A", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
          db,
        }),
      ).rejects.toThrow();

      expect(liveCore.snapshotVersion).toBe(7);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("command throws on clone before tx: live core untouched, no DB calls", async () => {
      const liveCore = ServerEditorCore.fromSnapshot(emptyState, 3);
      const { db, insertSpy, updateSpy } = makeDB();

      await expect(
        commitMutation({
          liveCore,
          projectId: "proj-A",
          command: throwingCommand("bad command"),
          agentId: "agent-1",
          changeEntry: { projectId: "proj-A", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
          db,
        }),
      ).rejects.toThrowError("bad command");

      expect(liveCore.snapshotVersion).toBe(3);
      expect(insertSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe("same-project serialization (per-project mutex)", () => {
    it("two parallel commits on the same liveCore serialize: snapshotVersion advances by 2, both txs run", async () => {
      const liveCore = ServerEditorCore.fromSnapshot(emptyState, 0);
      const { db, insertSpy, updateSpy } = makeDB({ insertedId: "ch-X" });

      const callP = (n: number) =>
        commitMutation({
          liveCore,
          projectId: "proj-shared",
          command: stubCommand(),
          agentId: `agent-${n}`,
          changeEntry: { projectId: "proj-shared", source: "agent", actionType: "x", targetType: "track", targetId: `t${n}` },
          db,
        });

      const [r1, r2] = await Promise.all([callP(1), callP(2)]);

      // Both txs ran (mutex serialized them, did not skip)
      expect(insertSpy).toHaveBeenCalledTimes(2);
      expect(updateSpy).toHaveBeenCalledTimes(2);

      // Live core advanced by exactly 2 (no interleaving lost a bump)
      expect(liveCore.snapshotVersion).toBe(2);

      // Returned versions are distinct and monotonic
      const versions = [r1.snapshotVersion, r2.snapshotVersion].sort();
      expect(versions).toEqual([1, 2]);
    });

    it("a failed commit does not block the next commit (mutex chain swallows rejections)", async () => {
      const liveCore = ServerEditorCore.fromSnapshot(emptyState, 0);
      const { db: failingDb } = makeDB({ failOn: "update" });
      const { db: okDb } = makeDB({ insertedId: "ch-OK" });

      const failure = commitMutation({
        liveCore,
        projectId: "proj-shared",
        command: stubCommand(),
        agentId: "agent-1",
        changeEntry: { projectId: "proj-shared", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
        db: failingDb,
      });
      const success = commitMutation({
        liveCore,
        projectId: "proj-shared",
        command: stubCommand(),
        agentId: "agent-2",
        changeEntry: { projectId: "proj-shared", source: "agent", actionType: "x", targetType: "track", targetId: "t2" },
        db: okDb,
      });

      await expect(failure).rejects.toThrow();
      const result = await success;

      expect(result.changeId).toBe("ch-OK");
      // First call did not bump; second call bumped exactly once
      expect(liveCore.snapshotVersion).toBe(1);
    });
  });

  describe("cross-project isolation", () => {
    it("two parallel commits on different live cores don't bleed state", async () => {
      const coreA = ServerEditorCore.fromSnapshot(emptyState, 0);
      const coreB = ServerEditorCore.fromSnapshot(emptyState, 0);
      const { db: dbA } = makeDB({ insertedId: "ch-A" });
      const { db: dbB } = makeDB({ insertedId: "ch-B" });

      const [resA, resB] = await Promise.all([
        commitMutation({
          liveCore: coreA,
          projectId: "proj-A",
          command: stubCommand(),
          agentId: "agent-1",
          changeEntry: { projectId: "proj-A", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
          db: dbA,
        }),
        commitMutation({
          liveCore: coreB,
          projectId: "proj-B",
          command: stubCommand(),
          agentId: "agent-1",
          changeEntry: { projectId: "proj-B", source: "agent", actionType: "x", targetType: "track", targetId: "t1" },
          db: dbB,
        }),
      ]);

      expect(resA.changeId).toBe("ch-A");
      expect(resB.changeId).toBe("ch-B");
      expect(coreA.snapshotVersion).toBe(1);
      expect(coreB.snapshotVersion).toBe(1);
    });
  });
});
