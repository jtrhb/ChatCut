import type { ProjectContext } from "../context/project-context.js";
import type { DispatchInput } from "../agents/types.js";

/** A single prompt section with a stable key for ordering and caching. */
export interface PromptSection {
  /** Unique key for dedup and ordering. */
  key: string;
  /** Rendered markdown content. Empty string = section omitted. */
  render: (ctx: PromptContext) => string;
  /** Lower = earlier in prompt. Default: 50. */
  priority?: number;
  /** If true, content is stable across turns (cache-friendly). */
  isStatic?: boolean;
}

/** Everything a prompt section might need to render. */
export interface PromptContext {
  /** Project runtime context. Required when using built-in timeline/memory/recentChanges sections. */
  projectContext?: Readonly<ProjectContext>;
  agentIdentity: AgentIdentity;
  task?: DispatchInput;
  extras?: Record<string, unknown>;
}

export interface AgentIdentity {
  role: string;
  description: string;
  rules: string[];
}
