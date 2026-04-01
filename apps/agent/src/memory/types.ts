export interface ParsedMemory {
  memory_id: string;
  type: "preference" | "rule" | "pattern" | "knowledge" | "decision";
  status: "draft" | "active" | "stale" | "deprecated";
  confidence: "high" | "medium" | "low";
  source: "implicit" | "explicit" | "observed";
  created: string; // ISO date
  updated: string;
  reinforced_count: number;
  last_reinforced_at: string;
  last_used_at?: string;
  source_change_ids: string[];
  used_in_changeset_ids: string[];
  created_session_id: string;
  last_reinforced_session_id?: string;
  scope: string; // "global" | "brand:x" | "platform:y" | "series:z" | "project:w"
  scope_level: "global" | "brand" | "platform" | "series" | "project";
  activation_scope?: { project_id?: string; batch_id?: string; session_id?: string };
  semantic_key: string;
  tags: string[];
  // Skill fields (optional)
  skill_id?: string;
  skill_status?: "draft" | "validated" | "deprecated";
  agent_type?: string;
  applies_to?: string[];
  // Content
  content: string;
}

import type { AgentType } from "../agents/types.js";

export interface TaskContext {
  brand: string;
  series?: string;
  platform?: string;
  projectId?: string;
  batchId?: string;
  sessionId: string;
  agentType: AgentType;
  tokenBudget?: number; // default 4000
}

export interface MemoryContext {
  promptText: string;
  injectedMemoryIds: string[];
  injectedSkillIds: string[];
}
