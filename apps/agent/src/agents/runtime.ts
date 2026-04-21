import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, AgentResult } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";
import { buildOrderPreservingBatches } from "../tools/batch-scheduler.js";
import type { DeferredRegistry } from "../tools/deferred-registry.js";
import { formatToolForApi } from "../tools/format-for-api.js";

export interface SessionMessage {
  role: string;
  content: unknown;
}

export interface SessionCallbacks {
  onMessage: (message: SessionMessage) => void;
}

export interface AgentRuntime {
  /**
   * Phase 5d: `userContent` lets the caller override the user-message body
   * with a multi-block array (e.g. text + Anthropic vision block for an
   * annotated frame). When provided, it replaces the string `input` in the
   * outgoing first user message. When omitted, `input` is used as a plain
   * string — same behavior as before Phase 5d.
   */
  run(
    config: AgentConfig,
    input: string,
    history?: Anthropic.MessageParam[],
    userContent?: Anthropic.MessageParam["content"],
  ): Promise<AgentResult>;
  setToolExecutor(fn: (name: string, input: unknown) => Promise<unknown>): void;
  setToolRegistry?(registry: Map<string, ToolDefinition>): void;
  setOnTurnComplete?(fn: (tokens: { input: number; output: number }) => void): void;
  setSessionCallbacks?(callbacks: SessionCallbacks): void;
  setDeferredRegistry?(registry: DeferredRegistry): void;
}

export class NativeAPIRuntime implements AgentRuntime {
  private client: Anthropic;
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;
  private toolRegistry?: Map<string, ToolDefinition>;
  private onTurnComplete?: (tokens: { input: number; output: number }) => void;
  private sessionCallbacks?: SessionCallbacks;
  private deferredRegistry?: DeferredRegistry;
  private maxResolveLoops = 3;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.toolExecutor = async (_name: string, _input: unknown) => {
      throw new Error("No tool executor set");
    };
  }

  setToolExecutor(fn: (name: string, input: unknown) => Promise<unknown>): void {
    this.toolExecutor = fn;
  }

  setToolRegistry(registry: Map<string, ToolDefinition>): void {
    this.toolRegistry = registry;
  }

  setOnTurnComplete(fn: (tokens: { input: number; output: number }) => void): void {
    this.onTurnComplete = fn;
  }

  setSessionCallbacks(callbacks: SessionCallbacks): void {
    this.sessionCallbacks = callbacks;
  }

  setDeferredRegistry(registry: DeferredRegistry): void {
    this.deferredRegistry = registry;
  }

  async run(
    config: AgentConfig,
    input: string,
    history?: Anthropic.MessageParam[],
    userContent?: Anthropic.MessageParam["content"],
  ): Promise<AgentResult> {
    const maxIterations = config.maxIterations ?? 10;
    const tokenBudget = config.tokenBudget ?? { input: 30_000, output: 4_000 };

    // Phase 5d: when a multi-block userContent is provided (text + image
    // for an annotated frame), it replaces the string `input` in the
    // outgoing user message. Un-annotated turns pass `input` as a plain
    // string and the wire format is bit-for-bit identical to pre-5d.
    //
    // MED-2 guard: `??` only short-circuits null/undefined. Without the
    // empty-array check, a future caller that defensively filtered blocks
    // down to `[]` would replace the meaningful `input` string with an
    // empty content array and 400 the Anthropic API deep in the runtime
    // loop, miles from the actual root cause. Treating `[]` as "absent"
    // matches the intent of `userContent ?? input` semantically.
    const firstUserContent =
      Array.isArray(userContent) && userContent.length === 0
        ? input
        : (userContent ?? input);

    // Start from conversation history if provided (multi-turn session),
    // otherwise start fresh (single-turn or sub-agent dispatch)
    const messages: Anthropic.MessageParam[] = history
      ? [...history, { role: "user" as const, content: firstUserContent }]
      : [{ role: "user", content: firstUserContent }];

    // Session callback always sees the textual `input` so transcripts /
    // history slicing continue to operate on plain text. The image block
    // is for the model only — it doesn't get persisted into session.messages.
    this.sessionCallbacks?.onMessage({ role: "user", content: input });

    const toolCalls: AgentResult["toolCalls"] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let resolveLoopCount = 0;

    // Mutable tools list — starts with config.tools, grows as deferred tools are resolved
    let currentTools = [...(config.tools as Anthropic.Tool[])];

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.client.messages.create({
        model: config.model,
        system: config.system,
        messages,
        tools: currentTools,
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

        this.sessionCallbacks?.onMessage({ role: "assistant", content: text });
        this.onTurnComplete?.({ input: totalInputTokens, output: totalOutputTokens });
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

        this.sessionCallbacks?.onMessage({ role: "assistant", content: text });
        this.onTurnComplete?.({ input: totalInputTokens, output: totalOutputTokens });
        return {
          text,
          toolCalls,
          tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        };
      }

      // Append assistant message
      messages.push({ role: "assistant", content: response.content });

      // Execute tool calls — with order-preserving parallelism when registry is available
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Execute a single tool_use block, catching any thrown executor error
      // and converting it into an is_error tool_result. This is critical:
      // Anthropic's API requires every tool_use in the assistant message to
      // have a matching tool_result in the next user message. An unhandled
      // throw leaves an orphan tool_use and 400s the next API call.
      const runSingle = async (block: Anthropic.ToolUseBlock): Promise<void> => {
        try {
          const output = await this.toolExecutor(block.name, block.input);
          toolCalls.push({ toolName: block.name, input: block.input, output });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: typeof output === "string" ? output : JSON.stringify(output),
          });
        } catch (err) {
          const errorResult = { error: err instanceof Error ? err.message : String(err) };
          toolCalls.push({ toolName: block.name, input: block.input, output: errorResult });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(errorResult),
            is_error: true,
          });
        }
      };

      if (this.toolRegistry && toolUseBlocks.length > 1) {
        const batches = buildOrderPreservingBatches(toolUseBlocks, this.toolRegistry);
        for (const batch of batches) {
          if (batch.length === 1) {
            await runSingle(batch[0]);
          } else {
            const settled = await Promise.allSettled(
              batch.map(async (block) => {
                const output = await this.toolExecutor(block.name, block.input);
                return { block, output };
              })
            );
            for (let j = 0; j < settled.length; j++) {
              const s = settled[j];
              const block = batch[j];
              if (s.status === "fulfilled") {
                const { output } = s.value;
                toolCalls.push({ toolName: block.name, input: block.input, output });
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: typeof output === "string" ? output : JSON.stringify(output),
                });
              } else {
                const errorResult = { error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
                toolCalls.push({ toolName: block.name, input: block.input, output: errorResult });
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: JSON.stringify(errorResult),
                  is_error: true,
                });
              }
            }
          }
        }
      } else {
        for (const toolUse of toolUseBlocks) {
          await runSingle(toolUse);
        }
      }

      // Notify session of tool results
      this.sessionCallbacks?.onMessage({ role: "tool_result", content: toolResults });

      // Append tool results as user message
      messages.push({ role: "user", content: toolResults });

      // Check if resolve_tools was called and update tool list
      if (this.deferredRegistry && resolveLoopCount < this.maxResolveLoops) {
        const hadResolveCall = toolUseBlocks.some((b) => b.name === "resolve_tools");
        if (hadResolveCall && this.deferredRegistry.hasNewResolutions()) {
          const resolvedDefs = this.deferredRegistry.getResolvedTools();
          const existingNames = new Set(currentTools.map((t) => t.name));
          for (const def of resolvedDefs) {
            if (!existingNames.has(def.name)) {
              currentTools.push(formatToolForApi(def) as unknown as Anthropic.Tool);
            }
          }

          // Prune resolve_tools result to short confirmation in the last user message
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
            lastMsg.content = (lastMsg.content as Anthropic.ToolResultBlockParam[]).map((block) => {
              if (block.type === "tool_result") {
                const matchingToolUse = toolUseBlocks.find((b) => b.id === block.tool_use_id);
                if (matchingToolUse?.name === "resolve_tools") {
                  return { ...block, content: `Resolved ${resolvedDefs.length} tool(s). They are now available.` };
                }
              }
              return block;
            });
          }

          resolveLoopCount++;
        }
      }
    }

    // Max iterations reached. Messages array is internally consistent — every
    // appended tool_use has a matching tool_result — but the conversation was
    // cut short. Report what progress happened so the caller can decide whether
    // to retry with a higher maxIterations or treat the partial result.
    this.onTurnComplete?.({ input: totalInputTokens, output: totalOutputTokens });
    return {
      text: `Max iterations (${maxIterations}) reached after ${toolCalls.length} tool call(s)`,
      toolCalls,
      tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
    };
  }
}
