import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { EDITOR_TOOL_DEFINITIONS } from "../tools/editor-tools.js";
import type { ToolDefinition } from "../tools/types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";
import { createAgentPipeline } from "./create-agent-pipeline.js";

export class EditorAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    const { executor } = createAgentPipeline(this.toolExecutor, EDITOR_TOOL_DEFINITIONS, "editor");
    runtime.setToolExecutor(executor);

    const config: AgentConfig = {
      agentType: "editor",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: this.formatTools(),
      tokenBudget: TOKEN_BUDGETS.editor,
      maxIterations: MAX_ITERATIONS.editor,
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
        role: "Editor Agent",
        description: "You modify the video timeline using editing tools.",
        rules: [
          "Use read tools to inspect the timeline before making changes.",
          "Use write tools to apply mutations; prefer atomic batch operations when possible.",
          "Never exceed the token budget; be concise in tool calls.",
        ],
      },
      task: input,
    };
    return builder.build(promptCtx);
  }

  private formatTools(): unknown[] {
    return EDITOR_TOOL_DEFINITIONS.map((def: ToolDefinition) => ({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }
}
