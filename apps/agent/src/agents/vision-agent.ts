import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { visionToolDefinitions } from "../tools/vision-tools.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { formatToolsForApi } from "../tools/format-for-api.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";
import { createAgentPipeline } from "./create-agent-pipeline.js";

export class VisionAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;
  private apiKey: string;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown>; apiKey: string }) {
    this.toolExecutor = deps.toolExecutor;
    this.apiKey = deps.apiKey;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const runtime = new NativeAPIRuntime(this.apiKey);
    const { executor } = createAgentPipeline(this.toolExecutor, visionToolDefinitions, "vision");
    runtime.setToolExecutor(executor);

    const config: AgentConfig = {
      agentType: "vision",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: formatToolsForApi(visionToolDefinitions),
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

}
