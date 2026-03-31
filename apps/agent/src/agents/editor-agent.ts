import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { EDITOR_TOOL_DEFINITIONS } from "../tools/editor-tools.js";
import type { ToolDefinition } from "../tools/types.js";

export class EditorAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    runtime.setToolExecutor(this.toolExecutor);

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
    const lines: string[] = [
      "You are the Editor Agent. Your job is to modify the video timeline.",
      "",
      "## Rules",
      "- Use read tools to inspect the timeline before making changes.",
      "- Use write tools to apply mutations; prefer atomic batch operations when possible.",
      "- Never exceed the token budget; be concise in tool calls.",
      "",
      `## Task`,
      input.task,
    ];

    if (input.context && Object.keys(input.context).length > 0) {
      lines.push("", "## Context", JSON.stringify(input.context, null, 2));
    }

    return lines.join("\n");
  }

  private formatTools(): unknown[] {
    return EDITOR_TOOL_DEFINITIONS.map((def: ToolDefinition) => ({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }
}
