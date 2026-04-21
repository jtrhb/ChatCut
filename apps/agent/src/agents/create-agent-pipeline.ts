import { ToolPipeline } from "../tools/tool-pipeline.js";
import type {
  ToolContext,
  ToolDefinition,
  AgentType,
  ToolProgressEvent,
} from "../tools/types.js";
import type { ToolHook } from "../tools/hooks.js";

/** Raw tool executor signature with optional context + progress forwarding.
 * Existing callers that pass `(name, input)` continue to work — both `ctx`
 * and `onProgress` are optional. `onProgress` is the pipeline-supplied
 * progress sink (Phase 5a HIGH-1 fix); long-running tool implementations
 * (Gemini analyze, generation polling) thread it through to their
 * downstream client so `tool.progress` events reach the EventBus → SSE. */
export type RawToolExecutor = (
  name: string,
  input: unknown,
  context?: ToolContext,
  onProgress?: (event: ToolProgressEvent) => void,
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
  const pipeline = new ToolPipeline(async (name, input, ctx, onProgress) => {
    // Phase 5a HIGH-1 fix: thread the pipeline's wrappedProgress through
    // to the raw executor so long-running tools (analyze_video and
    // future generation/transcription) can emit `tool.progress` events.
    const result = await rawExecutor(name, input, ctx, onProgress);
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
