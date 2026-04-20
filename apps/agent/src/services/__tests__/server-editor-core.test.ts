import { describe, it, expect, beforeEach } from "vitest";
import { ServerEditorCore } from "../server-editor-core.js";
import type { SerializedEditorState, TimelineTrack, TScene } from "@opencut/core";

// Minimal valid serialized state
const emptyState: SerializedEditorState = {
  project: null,
  scenes: [],
  activeSceneId: null,
};

function makeTrack(id: string, type: "video" | "audio" = "video"): TimelineTrack {
  return {
    id,
    type,
    elements: [],
    name: id,
    muted: false,
    hidden: false,
  } as unknown as TimelineTrack;
}

function stateWithTracks(tracks: TimelineTrack[]): SerializedEditorState {
  const scene: TScene = {
    id: "scene-1",
    name: "Scene 1",
    tracks,
    durationSec: 0,
  } as unknown as TScene;
  return { project: null, scenes: [scene], activeSceneId: "scene-1" };
}

describe("ServerEditorCore", () => {
  describe("fromSnapshot()", () => {
    it("creates an instance from serialized state", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState);
      expect(sec).toBeInstanceOf(ServerEditorCore);
    });

    it("snapshotVersion defaults to 0 when not provided", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState);
      expect(sec.snapshotVersion).toBe(0);
    });

    it("uses the provided version when given", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 5);
      expect(sec.snapshotVersion).toBe(5);
    });
  });

  describe("snapshotVersion", () => {
    it("starts at 0 by default", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState);
      expect(sec.snapshotVersion).toBe(0);
    });
  });

  describe("editorCore", () => {
    it("exposes the underlying EditorCore", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState);
      // Should have CommandManager etc
      expect(sec.editorCore).toBeDefined();
      expect(sec.editorCore.command).toBeDefined();
      expect(sec.editorCore.project).toBeDefined();
    });
  });

  describe("validateVersion()", () => {
    it("passes (does not throw) when expected version matches current", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 3);
      expect(() => sec.validateVersion(3)).not.toThrow();
    });

    it("throws 'Stale snapshot version' when versions don't match", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 3);
      expect(() => sec.validateVersion(4)).toThrowError("Stale snapshot version");
    });

    it("throws when expected is lower than current", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 3);
      expect(() => sec.validateVersion(2)).toThrowError("Stale snapshot version");
    });
  });

  describe("executeAgentCommand()", () => {
    it("increments snapshotVersion by 1", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 0);
      // Use a no-op command by directly accessing the internal core
      // We need a real Command — use AddTrackCommand or similar from core.
      // Since we don't want deep coupling, we create a minimal stub command.
      const stubCommand = {
        execute: () => {},
        undo: () => {},
      } as unknown as import("@opencut/core").Command;

      sec.executeAgentCommand(stubCommand, "agent-001");
      expect(sec.snapshotVersion).toBe(1);
    });

    it("increments snapshotVersion again on second call", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 0);
      const stubCommand = {
        execute: () => {},
        undo: () => {},
      } as unknown as import("@opencut/core").Command;

      sec.executeAgentCommand(stubCommand, "agent-001");
      sec.executeAgentCommand(stubCommand, "agent-001");
      expect(sec.snapshotVersion).toBe(2);
    });
  });

  describe("executeHumanCommand()", () => {
    it("increments snapshotVersion by 1", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 0);
      const stubCommand = {
        execute: () => {},
        undo: () => {},
      } as unknown as import("@opencut/core").Command;

      sec.executeHumanCommand(stubCommand);
      expect(sec.snapshotVersion).toBe(1);
    });

    it("increments snapshotVersion again on second call", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 0);
      const stubCommand = {
        execute: () => {},
        undo: () => {},
      } as unknown as import("@opencut/core").Command;

      sec.executeHumanCommand(stubCommand);
      sec.executeHumanCommand(stubCommand);
      expect(sec.snapshotVersion).toBe(2);
    });
  });

  describe("replaceRuntime()", () => {
    it("swaps in the donor's state — target.serialize() then equals donor.serialize()", () => {
      // Build the donor state via applyTracksAsCommand so it routes through
      // CommandManager (matches the production path where commitMutation
      // executes a command on a clone, then hands the clone to replaceRuntime).
      const v0 = [makeTrack("t1")];
      const v1 = [makeTrack("t1"), makeTrack("t2", "audio")];
      const target = ServerEditorCore.fromSnapshot(stateWithTracks(v0), 5);
      const donor = ServerEditorCore.fromSnapshot(stateWithTracks(v0), 5);
      donor.applyTracksAsCommand(v0, v1, "editor", "task-A");

      target.replaceRuntime(donor);

      expect(target.snapshotVersion).toBe(donor.snapshotVersion);
      expect(target.serialize()).toEqual(donor.serialize());
    });

    it("preserves the target instance identity (caller's reference still valid)", () => {
      const target = ServerEditorCore.fromSnapshot(emptyState, 0);
      const donor = ServerEditorCore.fromSnapshot(emptyState, 3);

      const before = target;
      target.replaceRuntime(donor);

      expect(target).toBe(before);
    });

    it("after replaceRuntime, executing a command bumps the donor's version (not the original)", () => {
      const target = ServerEditorCore.fromSnapshot(emptyState, 0);
      const donor = ServerEditorCore.fromSnapshot(emptyState, 10);
      target.replaceRuntime(donor);

      const stub = { execute: () => {}, undo: () => {} } as unknown as import("@opencut/core").Command;
      target.executeAgentCommand(stub, "agent-1");

      expect(target.snapshotVersion).toBe(11);
    });

    it("does not mutate the donor (donor's state remains usable independently)", () => {
      const v0 = [makeTrack("t1")];
      const v1 = [makeTrack("t1"), makeTrack("t2", "audio")];
      const target = ServerEditorCore.fromSnapshot(stateWithTracks(v0), 1);
      const donor = ServerEditorCore.fromSnapshot(stateWithTracks(v0), 2);
      donor.applyTracksAsCommand(v0, v1, "editor", "task-A");
      const donorVersionBeforeSwap = donor.snapshotVersion;
      const donorStateBeforeSwap = donor.serialize();

      target.replaceRuntime(donor);

      expect(donor.snapshotVersion).toBe(donorVersionBeforeSwap);
      expect(donor.serialize()).toEqual(donorStateBeforeSwap);
    });
  });

  describe("clone()", () => {
    it("creates an independent copy at the same version", () => {
      const original = ServerEditorCore.fromSnapshot(emptyState, 7);
      const cloned = original.clone();
      expect(cloned.snapshotVersion).toBe(7);
    });

    it("modifying clone's version does not affect the original", () => {
      const original = ServerEditorCore.fromSnapshot(emptyState, 2);
      const cloned = original.clone();

      const stubCommand = {
        execute: () => {},
        undo: () => {},
      } as unknown as import("@opencut/core").Command;

      cloned.executeHumanCommand(stubCommand);

      expect(cloned.snapshotVersion).toBe(3);
      expect(original.snapshotVersion).toBe(2);
    });

    it("clone is a separate ServerEditorCore instance", () => {
      const original = ServerEditorCore.fromSnapshot(emptyState, 1);
      const cloned = original.clone();
      expect(cloned).not.toBe(original);
    });
  });

  describe("serialize()", () => {
    it("returns the serialized state from the underlying EditorCore", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState);
      const state = sec.serialize();
      expect(state).toHaveProperty("project");
      expect(state).toHaveProperty("scenes");
      expect(state).toHaveProperty("activeSceneId");
    });

    it("scenes is an array", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState);
      const state = sec.serialize();
      expect(Array.isArray(state.scenes)).toBe(true);
    });
  });

  describe("B3: applyTracksAsCommand + rollbackByTaskId", () => {
    it("applyTracksAsCommand applies the new tracks and bumps snapshotVersion", () => {
      const before = [makeTrack("t1")];
      const after = [makeTrack("t1"), makeTrack("t2", "audio")];
      const sec = ServerEditorCore.fromSnapshot(stateWithTracks(before), 0);

      sec.applyTracksAsCommand(before, after, "editor", "task-A");

      expect(sec.editorCore.timeline.getTracks().map((t) => t.id)).toEqual(["t1", "t2"]);
      expect(sec.snapshotVersion).toBe(1);
    });

    it("rollbackByTaskId undoes every command tagged with that taskId and bumps version once", () => {
      const v0 = [makeTrack("t1")];
      const v1 = [makeTrack("t1"), makeTrack("t2", "audio")];
      const v2 = [makeTrack("t1"), makeTrack("t2", "audio"), makeTrack("t3")];
      const sec = ServerEditorCore.fromSnapshot(stateWithTracks(v0), 0);

      sec.applyTracksAsCommand(v0, v1, "editor", "task-A");
      sec.applyTracksAsCommand(v1, v2, "editor", "task-A");
      expect(sec.snapshotVersion).toBe(2);
      expect(sec.editorCore.timeline.getTracks()).toHaveLength(3);

      const undone = sec.rollbackByTaskId("task-A");

      expect(undone).toBe(2);
      // Single post-rollback version bump (3), not 2 + 2 = 4
      expect(sec.snapshotVersion).toBe(3);
      expect(sec.editorCore.timeline.getTracks().map((t) => t.id)).toEqual(["t1"]);
    });

    it("rollbackByTaskId leaves commands tagged with other taskIds in place (documents LIFO limitation)", () => {
      const v0 = [makeTrack("t1")];
      const v1 = [makeTrack("t1"), makeTrack("t2", "audio")];
      const v2 = [makeTrack("t1"), makeTrack("t2", "audio"), makeTrack("t3")];
      const sec = ServerEditorCore.fromSnapshot(stateWithTracks(v0), 0);

      sec.applyTracksAsCommand(v0, v1, "editor", "task-A");
      sec.applyTracksAsCommand(v1, v2, "editor", "task-B");

      const undone = sec.rollbackByTaskId("task-A");

      // Exactly 1 command tagged with task-A was undone.
      expect(undone).toBe(1);

      // Concrete post-state: task-A's recorded `before` was v0, so undoing it
      // restores the tracks to v0. task-B's command is removed from history
      // as well (LIFO limitation) — its earlier "before" ref held v1, which
      // is now lost from the live state. This test pins the documented
      // behavior as an executable contract rather than a prose comment.
      const postRollback = sec.editorCore.timeline.getTracks();
      expect(postRollback.map((t) => t.id)).toEqual(["t1"]);
      expect(postRollback).not.toEqual(v2);
    });

    it("rollbackByTaskId returns 0 and does not bump version when nothing matches", () => {
      const v0 = [makeTrack("t1")];
      const sec = ServerEditorCore.fromSnapshot(stateWithTracks(v0), 5);

      const undone = sec.rollbackByTaskId("never-used");

      expect(undone).toBe(0);
      expect(sec.snapshotVersion).toBe(5);
    });

    it("executeAgentCommand without taskId still works (opt-in)", () => {
      const sec = ServerEditorCore.fromSnapshot(emptyState, 0);
      const stub = { execute: () => {}, undo: () => {} } as unknown as import("@opencut/core").Command;

      sec.executeAgentCommand(stub, "agent-001");

      expect(sec.snapshotVersion).toBe(1);
      expect(sec.rollbackByTaskId("anything")).toBe(0);
    });
  });
});
