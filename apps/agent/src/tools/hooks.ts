import type { AgentType, ToolCallResult } from "./types.js";

export interface ToolHookContext {
  toolName: string;
  input: unknown;
  agentType: AgentType;
  taskId: string;
  idempotencyKey?: string;
}

export interface PreToolHookResult {
  block?: boolean;
  reason?: string;
  rewrittenInput?: unknown;
}

export interface PostToolHookResult {
  transformedResult?: ToolCallResult;
}

export interface ToolHook {
  name: string;
  pre?: (ctx: ToolHookContext) => Promise<PreToolHookResult> | PreToolHookResult;
  post?: (
    ctx: ToolHookContext,
    result: ToolCallResult,
  ) => Promise<PostToolHookResult> | PostToolHookResult;
  onFailure?: (ctx: ToolHookContext, error: ToolCallResult) => Promise<void> | void;
}
