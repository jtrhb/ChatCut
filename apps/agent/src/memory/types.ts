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
  agent_type?: string | string[];
  applies_to?: string[];
  // Skill runtime frontmatter (optional — parsed from skill files)
  allowed_tools?: string[];
  denied_tools?: string[];
  skill_model?: string;
  effort?: "low" | "medium" | "high";
  when_to_use?: string[];
  execution_context?: "inline" | "forked";
  skill_hooks?: string[];
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
  /**
   * Phase 5c: active conflict markers loaded from `_conflicts/*` for this turn.
   * Surfaced as a dedicated "Active conflicts (do not repeat)" section in the
   * system prompt — kept separate from regular memory so the LLM doesn't
   * weigh past rejections like positive guidance.
   */
  conflictMarkers?: ConflictMarker[];
}

/**
 * Phase 5c: marker file written when the user rejects the same action class
 * 3+ times in a row. Lives at `_conflicts/{ISO-ts}-{actionType}-{shortHash}.md`.
 * Surfaced in the system prompt so the agent stops re-proposing the rejected
 * action without first acknowledging it. Manual cleanup only — markers stay
 * until removed (5c-Q4 = out-of-scope for auto-aging in this phase).
 */
export interface ConflictMarker {
  marker_id: string;
  action_type: string;
  /** Free-form identifier of what the rejected action targeted. May be "*" when
   *  the rejection signal is action-class-only (no specific entity). */
  target: string;
  severity: "high" | "medium" | "low";
  /** Memory file paths this marker contradicts (e.g. drafts/* that the user
   *  was rejecting). Empty if the marker isn't paired with a draft memory. */
  conflicts_with: string[];
  first_seen_at: string;
  last_seen_at: string;
  /** Free-text body explaining why this conflict was raised. */
  reason: string;
}
