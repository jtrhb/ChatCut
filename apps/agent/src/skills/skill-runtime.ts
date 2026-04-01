import type { ParsedMemory } from "../memory/types.js";
import type { SkillFrontmatter, SkillContract } from "./types.js";

const EFFORT_BUDGETS: Record<string, { input: number; output: number }> = {
  low: { input: 10_000, output: 2_000 },
  medium: { input: 30_000, output: 4_000 },
  high: { input: 50_000, output: 8_000 },
};

export class SkillRuntime {
  private availableTools: string[];
  private defaultModel: string;

  constructor(opts: { availableTools: string[]; defaultModel: string }) {
    this.availableTools = opts.availableTools;
    this.defaultModel = opts.defaultModel;
  }

  resolve(skill: ParsedMemory, frontmatter?: SkillFrontmatter): SkillContract {
    const fm = frontmatter ?? {};

    // Resolve tools
    let tools = [...this.availableTools];
    if (fm.allowed_tools && fm.allowed_tools.length > 0) {
      const allowSet = new Set(fm.allowed_tools);
      tools = tools.filter((t) => allowSet.has(t));
    }
    if (fm.denied_tools && fm.denied_tools.length > 0) {
      const denySet = new Set(fm.denied_tools);
      tools = tools.filter((t) => !denySet.has(t));
    }

    const effort = fm.effort ?? "medium";
    const budget = EFFORT_BUDGETS[effort] ?? EFFORT_BUDGETS.medium;
    const model = fm.model ?? this.defaultModel;

    return {
      skillId: skill.skill_id ?? skill.memory_id,
      name: skill.semantic_key,
      frontmatter: fm,
      content: skill.content,
      resolvedTools: tools,
      resolvedTokenBudget: budget,
      resolvedModel: model,
    };
  }

  matchesIntent(intent: string, frontmatter: SkillFrontmatter): boolean {
    if (!frontmatter.when_to_use || frontmatter.when_to_use.length === 0) {
      return false;
    }
    const lower = intent.toLowerCase();
    return frontmatter.when_to_use.some((pattern) => {
      const patternLower = pattern.toLowerCase();
      // Try exact substring first
      if (lower.includes(patternLower)) return true;
      // Fall back to word-level matching: all words in pattern must appear in intent
      const words = patternLower.split(/\s+/).filter((w) => w.length > 0);
      return words.length > 0 && words.every((word) => lower.includes(word));
    });
  }
}
