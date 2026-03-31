import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { creatorToolDefinitions } from "../tools/creator-tools.js";
import type { ToolDefinition } from "../tools/types.js";

export class CreatorAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    runtime.setToolExecutor(this.toolExecutor);

    const config: AgentConfig = {
      agentType: "creator",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: this.formatTools(),
      tokenBudget: TOKEN_BUDGETS.creator,
      maxIterations: MAX_ITERATIONS.creator,
    };

    const result = await runtime.run(config, input.task);

    return {
      result: result.text,
      needsAssistance: result.needsAssistance,
      toolCallCount: result.toolCalls.length,
      tokensUsed: result.tokensUsed.input + result.tokensUsed.output,
    };
  }

  buildSystemPrompt(input: DispatchInput): string {
    const lines: string[] = [
      "You are the Creator Agent. Your job is to generate video/image content.",
      "",
      "## Rules",
      "- Use generate_video or generate_image to create new AI-generated media.",
      "- Poll check_generation_status until the generation is complete.",
      "- Use replace_segment to place generated content into the timeline.",
      "- Use compare_before_after to verify the result looks correct.",
      "",
      "## Task",
      input.task,
    ];

    if (input.context && Object.keys(input.context).length > 0) {
      lines.push("", "## Context", JSON.stringify(input.context, null, 2));
    }

    return lines.join("\n");
  }

  private formatTools(): unknown[] {
    return creatorToolDefinitions.map((def: ToolDefinition) => ({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }
}
