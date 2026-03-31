import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, AgentResult } from "./types.js";

export interface AgentRuntime {
  run(config: AgentConfig, input: string): Promise<AgentResult>;
}

export class NativeAPIRuntime implements AgentRuntime {
  private client: Anthropic;
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.toolExecutor = async (_name: string, _input: unknown) => {
      throw new Error("No tool executor set");
    };
  }

  setToolExecutor(fn: (name: string, input: unknown) => Promise<unknown>): void {
    this.toolExecutor = fn;
  }

  async run(config: AgentConfig, input: string): Promise<AgentResult> {
    const maxIterations = config.maxIterations ?? 10;
    const tokenBudget = config.tokenBudget ?? { input: 30_000, output: 4_000 };

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: input },
    ];

    const toolCalls: AgentResult["toolCalls"] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.client.messages.create({
        model: config.model,
        system: config.system,
        messages,
        tools: config.tools as Anthropic.Tool[],
        max_tokens: tokenBudget.output,
      });

      totalInputTokens += response.usage?.input_tokens ?? 0;
      totalOutputTokens += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === "end_turn") {
        // Extract text from content blocks
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === "text"
        );
        const text = textBlocks.map((b) => b.text).join("\n");

        return {
          text,
          toolCalls,
          tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        };
      }

      // Process tool_use blocks
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        // No tool use and not end_turn — extract text and return
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === "text"
        );
        const text = textBlocks.map((b) => b.text).join("\n");

        return {
          text,
          toolCalls,
          tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        };
      }

      // Append assistant message
      messages.push({ role: "assistant", content: response.content });

      // Execute all tool calls and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const output = await this.toolExecutor(toolUse.name, toolUse.input);
        toolCalls.push({ toolName: toolUse.name, input: toolUse.input, output });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      }

      // Append tool results as user message
      messages.push({ role: "user", content: toolResults });
    }

    // Max iterations reached
    return {
      text: "Max iterations reached",
      toolCalls,
      tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
    };
  }
}
