import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { audioToolDefinitions } from "../tools/audio-tools.js";
import type { ToolDefinition } from "../tools/types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";

export class AudioAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    runtime.setToolExecutor(this.toolExecutor);

    const config: AgentConfig = {
      agentType: "audio",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: this.formatTools(),
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

  private formatTools(): unknown[] {
    return audioToolDefinitions.map((def: ToolDefinition) => ({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }
}
