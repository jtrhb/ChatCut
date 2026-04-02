import { ToolPipeline } from "../tools/tool-pipeline.js";
import type { ToolDefinition, AgentType } from "../tools/types.js";
import type { ToolHook } from "../tools/hooks.js";

/**
 * Wrap a raw tool executor function with a ToolPipeline that provides
 * hooks, idempotency, failure classification, and tracing.
 *
 * Used by all sub-agents to ensure tool calls go through the pipeline.
 */
export function createAgentPipeline(
  rawExecutor: (name: string, input: unknown) => Promise<unknown>,
  tools: ToolDefinition[],
  agentType: AgentType,
  hooks?: ToolHook[],
): { pipeline: ToolPipeline; executor: (name: string, input: unknown) => Promise<unknown> } {
  const pipeline = new ToolPipeline(async (name, input) => {
    const result = await rawExecutor(name, input);
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
      taskId: `${agentType}-dispatch`,
    });
    if (!result.success) {
      return { error: result.error };
    }
    return result.data;
  };

  return { pipeline, executor };
}
