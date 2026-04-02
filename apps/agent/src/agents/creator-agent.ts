import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { creatorToolDefinitions } from "../tools/creator-tools.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { formatToolsForApi } from "../tools/format-for-api.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";
import { createAgentPipeline } from "./create-agent-pipeline.js";

export class CreatorAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;
  private apiKey: string;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown>; apiKey: string }) {
    this.toolExecutor = deps.toolExecutor;
    this.apiKey = deps.apiKey;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const runtime = new NativeAPIRuntime(this.apiKey);
    const { executor } = createAgentPipeline(this.toolExecutor, creatorToolDefinitions, "creator");
    runtime.setToolExecutor(executor);

    const config: AgentConfig = {
      agentType: "creator",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: formatToolsForApi(creatorToolDefinitions),
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
    const builder = new PromptBuilder({ builtins: false });
    builder.register(identitySection);
    builder.register(taskSection);
    const promptCtx: PromptContext = {
      agentIdentity: {
        role: "Creator Agent",
        description: "You generate video and image content using AI generation tools.",
        rules: [
          "Use generate_video or generate_image to create new AI-generated media.",
          "Poll check_generation_status until the generation is complete.",
          "Use replace_segment to place generated content into the timeline.",
          "Use compare_before_after to verify the result looks correct.",
        ],
      },
      task: input,
    };
    return builder.build(promptCtx);
  }

}
