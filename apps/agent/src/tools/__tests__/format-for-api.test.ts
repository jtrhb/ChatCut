import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { formatToolsForApi } from "../format-for-api.js";
import type { ToolDefinition, ToolFormatContext } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: z.object({ value: z.string() }),
    agentTypes: ["master"],
    accessMode: "read",
    ...overrides,
  };
}

const baseCtx: ToolFormatContext = {
  filterContext: {},
  descriptionContext: {
    activeSkills: [],
    agentType: "master",
  },
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("formatToolsForApi", () => {
  describe("sorting", () => {
    it("returns tools sorted by name alphabetically", () => {
      const tools = [
        makeTool({ name: "zebra_tool" }),
        makeTool({ name: "alpha_tool" }),
        makeTool({ name: "middle_tool" }),
      ];

      const result = formatToolsForApi(tools);
      expect(result.map((t) => t.name)).toEqual([
        "alpha_tool",
        "middle_tool",
        "zebra_tool",
      ]);
    });

    it("output order is deterministic regardless of registration order", () => {
      const tools = [
        makeTool({ name: "c_tool" }),
        makeTool({ name: "a_tool" }),
        makeTool({ name: "b_tool" }),
      ];
      const reversed = [...tools].reverse();

      const result1 = formatToolsForApi(tools);
      const result2 = formatToolsForApi(reversed);

      expect(result1.map((t) => t.name)).toEqual(result2.map((t) => t.name));
    });

    it("two calls with the same tools produce identical JSON serialization", () => {
      const tools = [
        makeTool({ name: "z_tool" }),
        makeTool({ name: "a_tool" }),
      ];

      const json1 = JSON.stringify(formatToolsForApi(tools));
      const json2 = JSON.stringify(formatToolsForApi(tools));

      expect(json1).toBe(json2);
    });
  });

  describe("backward compatibility (no ctx)", () => {
    it("works without context argument", () => {
      const tools = [makeTool({ name: "b_tool" }), makeTool({ name: "a_tool" })];
      const result = formatToolsForApi(tools);

      // Should still sort and return API format
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("a_tool");
      expect(result[1].name).toBe("b_tool");
    });

    it("does not filter tools when ctx is omitted", () => {
      const tools = [
        makeTool({
          name: "conditional_tool",
          isEnabled: () => false,
        }),
        makeTool({ name: "always_on" }),
      ];

      const result = formatToolsForApi(tools);
      // isEnabled not invoked when ctx is absent — both tools returned
      expect(result).toHaveLength(2);
    });
  });

  describe("isEnabled filtering", () => {
    it("excludes tools where isEnabled returns false", () => {
      const tools = [
        makeTool({ name: "enabled_tool" }),
        makeTool({
          name: "disabled_tool",
          isEnabled: () => false,
        }),
      ];

      const result = formatToolsForApi(tools, baseCtx);
      expect(result.map((t) => t.name)).toEqual(["enabled_tool"]);
    });

    it("includes tools where isEnabled returns true", () => {
      const tools = [
        makeTool({
          name: "allowed_tool",
          isEnabled: () => true,
        }),
      ];

      const result = formatToolsForApi(tools, baseCtx);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("allowed_tool");
    });

    it("includes tools that have no isEnabled (always on)", () => {
      const tool = makeTool({ name: "no_guard_tool" });
      const result = formatToolsForApi([tool], baseCtx);
      expect(result).toHaveLength(1);
    });
  });

  describe("isEnabled fail-closed", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("excludes a tool when isEnabled throws", () => {
      const tools = [
        makeTool({
          name: "throwing_tool",
          isEnabled: () => {
            throw new Error("guard exploded");
          },
        }),
        makeTool({ name: "safe_tool" }),
      ];

      const result = formatToolsForApi(tools, baseCtx);
      expect(result.map((t) => t.name)).toEqual(["safe_tool"]);
    });

    it("logs a warning when isEnabled throws", () => {
      const tools = [
        makeTool({
          name: "throwing_tool",
          isEnabled: () => {
            throw new Error("boom");
          },
        }),
      ];

      formatToolsForApi(tools, baseCtx);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("throwing_tool"),
      );
    });
  });

  describe("descriptionSuffix", () => {
    it("appends suffix to description when descriptionSuffix returns a string", () => {
      const tools = [
        makeTool({
          name: "suffixed_tool",
          description: "Base description.",
          descriptionSuffix: () => "Extra context.",
        }),
      ];

      const result = formatToolsForApi(tools, baseCtx);
      expect(result[0].description).toBe("Base description. Extra context.");
    });

    it("leaves description unchanged when descriptionSuffix returns undefined", () => {
      const tools = [
        makeTool({
          name: "no_suffix_tool",
          description: "Base description.",
          descriptionSuffix: () => undefined,
        }),
      ];

      const result = formatToolsForApi(tools, baseCtx);
      expect(result[0].description).toBe("Base description.");
    });

    it("does not call descriptionSuffix when ctx is omitted", () => {
      const suffixFn = vi.fn(() => "should not be called");
      const tools = [
        makeTool({
          name: "suffix_tool",
          descriptionSuffix: suffixFn,
        }),
      ];

      formatToolsForApi(tools);
      expect(suffixFn).not.toHaveBeenCalled();
    });
  });
});
