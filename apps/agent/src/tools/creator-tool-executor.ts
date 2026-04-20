import type { ContentEditor } from "../services/content-editor.js";
import type { AgentType, ToolCallResult } from "./types.js";
import { GenerateIntoSegmentSchema } from "./creator-tools.js";

/**
 * Phase 1C executor for the Creator agent. Currently exposes a single
 * tool, `generate_into_segment`, which is the first call site for the
 * previously-dormant ContentEditor pipeline (audit §B.ContentEditor).
 *
 * The executor follows the same shape as EditorToolExecutor and
 * AssetToolExecutor: hasToolName + execute, with a per-call ctx that
 * carries agentType + taskId. Schema validation runs inside execute()
 * so a malformed model output yields a structured ToolCallResult error
 * instead of throwing through to the runtime.
 */
export interface CreatorToolExecutorDeps {
  contentEditor: ContentEditor;
}

export interface CreatorToolContext {
  agentType?: AgentType;
  taskId: string;
  sessionId?: string;
  userId?: string;
}

const TOOL_NAMES = new Set(["generate_into_segment"]);

export class CreatorToolExecutor {
  private readonly contentEditor: ContentEditor;

  constructor(deps: CreatorToolExecutorDeps) {
    this.contentEditor = deps.contentEditor;
  }

  hasToolName(name: string): boolean {
    return TOOL_NAMES.has(name);
  }

  async execute(
    name: string,
    input: unknown,
    ctx: CreatorToolContext,
  ): Promise<ToolCallResult> {
    if (name !== "generate_into_segment") {
      return {
        success: false,
        error: `Unknown creator tool: ${name}`,
      };
    }

    const parsed = GenerateIntoSegmentSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: `generate_into_segment input failed schema validation: ${parsed.error.message}`,
      };
    }

    try {
      // ContentEditor uses agentId for change attribution; the per-call
      // taskId is the right value here (mirrors how EditorToolExecutor
      // forwards taskId into ServerEditorCore command execution).
      const result = await this.contentEditor.replaceWithGenerated({
        elementId: parsed.data.element_id,
        prompt: parsed.data.prompt,
        timeRange: parsed.data.time_range,
        provider: parsed.data.provider,
        agentId: ctx.taskId,
      });
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
