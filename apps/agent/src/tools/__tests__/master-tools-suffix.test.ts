import { describe, it, expect } from "vitest";
import { masterToolDefinitions } from "../master-tools.js";
import type { ToolDescriptionContext } from "../types.js";

function makeCtx(overrides?: Partial<ToolDescriptionContext>): ToolDescriptionContext {
  return {
    activeSkills: [],
    agentType: "master",
    ...overrides,
  };
}

describe("masterToolDefinitions – descriptionSuffix", () => {
  const dispatchEditor = masterToolDefinitions.find((t) => t.name === "dispatch_editor")!;
  const exploreOptions = masterToolDefinitions.find((t) => t.name === "explore_options")!;
  const proposeChanges = masterToolDefinitions.find((t) => t.name === "propose_changes")!;

  // ── dispatch_editor ──────────────────────────────────────────────────────────

  describe("dispatch_editor", () => {
    it("has a descriptionSuffix function", () => {
      expect(typeof dispatchEditor.descriptionSuffix).toBe("function");
    });

    it("returns undefined when no activeExplorationId", () => {
      const ctx = makeCtx({ projectContext: {} });
      expect(dispatchEditor.descriptionSuffix!(ctx)).toBeUndefined();
    });

    it("returns undefined when projectContext is absent", () => {
      const ctx = makeCtx();
      expect(dispatchEditor.descriptionSuffix!(ctx)).toBeUndefined();
    });

    it("appends exploration note when activeExplorationId is set", () => {
      const ctx = makeCtx({
        projectContext: { activeExplorationId: "exp-123" },
      });
      expect(dispatchEditor.descriptionSuffix!(ctx)).toBe(
        "(Note: edits will be queued during exploration)"
      );
    });
  });

  // ── explore_options ──────────────────────────────────────────────────────────

  describe("explore_options", () => {
    it("has a descriptionSuffix function", () => {
      expect(typeof exploreOptions.descriptionSuffix).toBe("function");
    });

    it("returns undefined when no activeExplorationId", () => {
      const ctx = makeCtx({ projectContext: {} });
      expect(exploreOptions.descriptionSuffix!(ctx)).toBeUndefined();
    });

    it("returns undefined when projectContext is absent", () => {
      const ctx = makeCtx();
      expect(exploreOptions.descriptionSuffix!(ctx)).toBeUndefined();
    });

    it("appends limit note when activeExplorationId is set", () => {
      const ctx = makeCtx({
        projectContext: { activeExplorationId: "exp-456" },
      });
      expect(exploreOptions.descriptionSuffix!(ctx)).toBe(
        "(Note: per-project limit: 1 concurrent exploration)"
      );
    });
  });

  // ── propose_changes ──────────────────────────────────────────────────────────

  describe("propose_changes", () => {
    it("has a descriptionSuffix function", () => {
      expect(typeof proposeChanges.descriptionSuffix).toBe("function");
    });

    it("returns undefined when no pendingChangesetId", () => {
      const ctx = makeCtx({ projectContext: {} });
      expect(proposeChanges.descriptionSuffix!(ctx)).toBeUndefined();
    });

    it("returns undefined when projectContext is absent", () => {
      const ctx = makeCtx();
      expect(proposeChanges.descriptionSuffix!(ctx)).toBeUndefined();
    });

    it("appends changeset note when pendingChangesetId is set", () => {
      const ctx = makeCtx({
        projectContext: { pendingChangesetId: "cs-789" },
      });
      expect(proposeChanges.descriptionSuffix!(ctx)).toBe(
        "(Note: another changeset awaiting review)"
      );
    });
  });
});
