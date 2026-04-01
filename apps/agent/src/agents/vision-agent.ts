import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { visionToolDefinitions } from "../tools/vision-tools.js";
import type { ToolDefinition } from "../tools/types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";

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
    const builder = new PromptBuilder({ builtins: false });
    builder.register(identitySection);
    builder.register(taskSection);
    const promptCtx: PromptContext = {
      agentIdentity: {
        role: "Vision Agent",
        description: "You analyze and understand video content.",
        rules: [
          "Use analyze_video for whole-video analysis from a URL.",
          "Use locate_scene to find specific moments matching a natural-language description.",
          "Use describe_frame to inspect a specific timeline frame.",
          "Return structured, factual observations; do not speculate beyond what is visible.",
        ],
      },
      task: input,
    };
    return builder.build(promptCtx);
  }

  private formatTools(): unknown[] {
    return visionToolDefinitions.map((def: ToolDefinition) => ({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }
}
