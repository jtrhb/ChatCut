import type { AgentType } from "../tools/types.js";

export interface SkillFrontmatter {
  agent_type?: AgentType | AgentType[];
  allowed_tools?: string[];
  denied_tools?: string[];
  model?: string;
  effort?: "low" | "medium" | "high";
  when_to_use?: string[];
  execution_context?: "inline" | "forked";
  hooks?: string[];
}

export interface SkillContract {
  skillId: string;
  name: string;
  frontmatter: SkillFrontmatter;
  content: string;
  resolvedTools: string[];
  resolvedTokenBudget: { input: number; output: number };
  resolvedModel: string;
}
