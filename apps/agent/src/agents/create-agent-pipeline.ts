import { ToolPipeline } from "../tools/tool-pipeline.js";
import type { ToolContext, ToolDefinition, AgentType } from "../tools/types.js";
import type { ToolHook } from "../tools/hooks.js";

/** Raw tool executor signature with optional context forwarding.
 * Existing callers that pass `(name, input)` continue to work — the ctx
 * argument is optional and only consumed by executors that need it. */
export type RawToolExecutor = (
  name: string,
  input: unknown,
  context?: ToolContext,
) => Promise<unknown>;

/**
 * Wrap a raw tool executor function with a ToolPipeline that provides
 * hooks, idempotency, failure classification, and tracing.
 *
 * Used by all sub-agents to ensure tool calls go through the pipeline.
 */
export function createAgentPipeline(
  rawExecutor: RawToolExecutor,
  tools: ToolDefinition[],
  agentType: AgentType,
  hooks?: ToolHook[],
  identity?: { userId?: string; sessionId?: string; projectId?: string; taskId?: string },
): { pipeline: ToolPipeline; executor: (name: string, input: unknown) => Promise<unknown> } {
  const pipeline = new ToolPipeline(async (name, input, ctx, _onProgress) => {
    const result = await rawExecutor(name, input, ctx);
    if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
      return { success: false, error: String((result as Record<string, unknown>).error) };
    }
    return { success: true, data: result };
  });

  for (const tool of tools) {
    pipeline.registerTool(tool);
  }

  if (hooks) {
    for (const hook of hooks) {
      pipeline.registerHook(hook);
    }
  }

  const executor = async (name: string, input: unknown): Promise<unknown> => {
    const result = await pipeline.execute(name, input, {
      agentType,
      taskId: identity?.taskId ?? `${agentType}-dispatch`,
      sessionId: identity?.sessionId,
      userId: identity?.userId,
    });
    if (!result.success) {
      return { error: result.error };
    }
    return result.data;
  };

  return { pipeline, executor };
}
