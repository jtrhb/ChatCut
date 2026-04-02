import type { AgentType, ToolCallResult } from "./types.js";
import type { EventBus } from "../events/event-bus.js";

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

/**
 * Creates a ToolHook that emits tool.called and tool.result events to an EventBus.
 */
export function createEventBusHook(eventBus: EventBus): ToolHook {
  return {
    name: "event-bus-emitter",
    pre: (ctx) => {
      eventBus.emit({
        type: "tool.called",
        timestamp: Date.now(),
        taskId: ctx.taskId,
        data: {
          toolName: ctx.toolName,
          agentType: ctx.agentType,
          idempotencyKey: ctx.idempotencyKey,
        },
      });
      return {};
    },
    post: (ctx, result) => {
      eventBus.emit({
        type: "tool.result",
        timestamp: Date.now(),
        taskId: ctx.taskId,
        data: {
          toolName: ctx.toolName,
          agentType: ctx.agentType,
          success: result.success,
          error: result.error,
        },
      });
      return {};
    },
    onFailure: (ctx, error) => {
      eventBus.emit({
        type: "tool.result",
        timestamp: Date.now(),
        taskId: ctx.taskId,
        data: {
          toolName: ctx.toolName,
          agentType: ctx.agentType,
          success: false,
          error: error.error,
        },
      });
    },
  };
}
