import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { assetToolDefinitions } from "../tools/asset-tools.js";
import type { ToolDefinition } from "../tools/types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";
import { createAgentPipeline } from "./create-agent-pipeline.js";

export class AssetAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    const { executor } = createAgentPipeline(this.toolExecutor, assetToolDefinitions, "asset");
    runtime.setToolExecutor(executor);

    const config: AgentConfig = {
      agentType: "asset",
      model: "claude-haiku-4-5",
      system: this.buildSystemPrompt(input),
      tools: this.formatTools(),
      tokenBudget: TOKEN_BUDGETS.asset,
      maxIterations: MAX_ITERATIONS.asset,
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
        role: "Asset Agent",
        description: "You manage media assets — search, save, tag, and retrieve.",
        rules: [
          "Use search_assets to find existing assets before saving new ones.",
          "Use get_asset_info to retrieve full metadata for a specific asset.",
          "Use save_asset to persist newly generated or uploaded media.",
          "Use tag_asset to categorize assets for future retrieval.",
          "Use find_similar to locate visually or semantically related assets.",
          "Use get_character and get_brand_assets for identity-consistent content.",
        ],
      },
      task: input,
    };
    return builder.build(promptCtx);
  }

  private formatTools(): unknown[] {
    return assetToolDefinitions.map((def: ToolDefinition) => ({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }
}
