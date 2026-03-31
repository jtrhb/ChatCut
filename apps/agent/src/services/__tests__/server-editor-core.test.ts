import { describe, it, expect, beforeEach } from "vitest";
import { ServerEditorCore } from "../server-editor-core.js";
import type { SerializedEditorState } from "@opencut/core";

// Minimal valid serialized state
const emptyState: SerializedEditorState = {
  project: null,
  scenes: [],
  activeSceneId: null,
};

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
});
