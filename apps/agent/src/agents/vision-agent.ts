import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { visionToolDefinitions } from "../tools/vision-tools.js";
import type { ToolDefinition } from "../tools/types.js";

export class VisionAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    runtime.setToolExecutor(this.toolExecutor);

    const config: AgentConfig = {
      agentType: "vision",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: this.formatTools(),
      tokenBudget: TOKEN_BUDGETS.vision,
      maxIterations: MAX_ITERATIONS.vision,
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
      "You are the Vision Agent. Your job is to analyze and understand video content.",
      "",
      "## Rules",
      "- Use analyze_video for whole-video analysis from a URL.",
      "- Use locate_scene to find specific moments matching a natural-language description.",
      "- Use describe_frame to inspect a specific timeline frame.",
      "- Return structured, factual observations; do not speculate beyond what is visible.",
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
    return visionToolDefinitions.map((def: ToolDefinition) => ({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }
}
