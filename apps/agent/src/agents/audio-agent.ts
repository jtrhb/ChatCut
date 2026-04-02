import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { audioToolDefinitions } from "../tools/audio-tools.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { formatToolsForApi } from "../tools/format-for-api.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";
import { createAgentPipeline } from "./create-agent-pipeline.js";

export class AudioAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;
  private apiKey: string;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown>; apiKey: string }) {
    this.toolExecutor = deps.toolExecutor;
    this.apiKey = deps.apiKey;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const runtime = new NativeAPIRuntime(this.apiKey);
    const { executor } = createAgentPipeline(this.toolExecutor, audioToolDefinitions, "audio");
    runtime.setToolExecutor(executor);

    const config: AgentConfig = {
      agentType: "audio",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: formatToolsForApi(audioToolDefinitions),
      tokenBudget: TOKEN_BUDGETS.audio,
      maxIterations: MAX_ITERATIONS.audio,
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
        role: "Audio Agent",
        description: "You handle audio operations for the video timeline.",
        rules: [
          "Use search_bgm to find suitable background music before adding it.",
          "Use transcribe to get captions from speech, then auto_subtitle to place them.",
          "Adjust volumes carefully — keep dialogue audible over background music.",
          "Use generate_voiceover for text-to-speech narration.",
        ],
      },
      task: input,
    };
    return builder.build(promptCtx);
  }

}
