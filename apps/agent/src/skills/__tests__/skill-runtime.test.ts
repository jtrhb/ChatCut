import { describe, it, expect, beforeEach } from "vitest";
import { SkillRuntime } from "../skill-runtime.js";
import type { SkillFrontmatter } from "../types.js";
import type { ParsedMemory } from "../../memory/types.js";

function makeSkillMemory(overrides: Partial<ParsedMemory> = {}): ParsedMemory {
  return {
    memory_id: "skill-1",
    type: "pattern",
    status: "active",
    confidence: "high",
    source: "observed",
    created: "2026-01-01",
    updated: "2026-03-01",
    reinforced_count: 5,
    last_reinforced_at: "2026-03-01",
    source_change_ids: [],
    used_in_changeset_ids: [],
    created_session_id: "s1",
    scope: "global",
    scope_level: "global",
    semantic_key: "beat-sync-skill",
    tags: ["skill", "audio", "sync"],
    skill_id: "beat-sync",
    skill_status: "validated",
    agent_type: "editor",
    content: "Cut on beat drops for music videos.",
    ...overrides,
  };
}

describe("SkillRuntime", () => {
  let runtime: SkillRuntime;

  beforeEach(() => {
    runtime = new SkillRuntime({
      availableTools: ["trim_element", "split_element", "add_transition", "generate_video", "search_bgm"],
      defaultModel: "claude-sonnet-4-6",
    });
  });

  describe("resolve()", () => {
    it("creates a SkillContract from a ParsedMemory skill", () => {
      const contract = runtime.resolve(makeSkillMemory());
      expect(contract.skillId).toBe("beat-sync");
      expect(contract.content).toBe("Cut on beat drops for music videos.");
    });

    it("filters tools by allowed_tools frontmatter", () => {
      const contract = runtime.resolve(makeSkillMemory(), {
        allowed_tools: ["trim_element", "split_element"],
      });
      expect(contract.resolvedTools).toEqual(["trim_element", "split_element"]);
    });

    it("removes tools listed in denied_tools", () => {
      const contract = runtime.resolve(makeSkillMemory(), {
        denied_tools: ["generate_video"],
      });
      expect(contract.resolvedTools).not.toContain("generate_video");
      expect(contract.resolvedTools).toContain("trim_element");
    });

    it("resolves token budget from effort level", () => {
      const lowEffort = runtime.resolve(makeSkillMemory(), { effort: "low" });
      const highEffort = runtime.resolve(makeSkillMemory(), { effort: "high" });
      expect(lowEffort.resolvedTokenBudget.output).toBeLessThan(highEffort.resolvedTokenBudget.output);
    });

    it("overrides model when frontmatter specifies one", () => {
      const contract = runtime.resolve(makeSkillMemory(), { model: "claude-haiku-4-5" });
      expect(contract.resolvedModel).toBe("claude-haiku-4-5");
    });

    it("uses default model when frontmatter omits model", () => {
      const contract = runtime.resolve(makeSkillMemory());
      expect(contract.resolvedModel).toBe("claude-sonnet-4-6");
    });
  });

  describe("matchesIntent()", () => {
    it("returns true when intent matches when_to_use patterns", () => {
      const result = runtime.matchesIntent("sync cuts to the beat", {
        when_to_use: ["beat sync", "cut on beat", "music video editing"],
      });
      expect(result).toBe(true);
    });

    it("returns false when no pattern matches", () => {
      const result = runtime.matchesIntent("add a title card", {
        when_to_use: ["beat sync", "cut on beat"],
      });
      expect(result).toBe(false);
    });

    it("returns false when when_to_use is empty or absent", () => {
      expect(runtime.matchesIntent("anything", {})).toBe(false);
      expect(runtime.matchesIntent("anything", { when_to_use: [] })).toBe(false);
    });
  });
});
