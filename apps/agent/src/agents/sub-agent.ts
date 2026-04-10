import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, AgentType, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import type { ToolDefinition, ToolFormatContext } from "../tools/types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { formatToolsForApi } from "../tools/format-for-api.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";
import { createAgentPipeline } from "./create-agent-pipeline.js";
import type { ToolHook } from "../tools/hooks.js";

export interface SubAgentIdentity {
  role: string;
  description: string;
  rules: string[];
}

export interface SubAgentConfig {
  agentType: AgentType;
  model: string;
  tools: ToolDefinition[];
  identity: SubAgentIdentity;
}

export interface SubAgentDeps {
  toolExecutor: (name: string, input: unknown) => Promise<unknown>;
  apiKey: string;
  hooks?: ToolHook[];
  projectContext?: Readonly<Record<string, unknown>>;
}

export class SubAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;
  private apiKey: string;
  private hooks: ToolHook[];
  protected agentConfig: SubAgentConfig;
  protected projectContext?: Readonly<Record<string, unknown>>;

  constructor(config: SubAgentConfig, deps: SubAgentDeps) {
    this.agentConfig = config;
    this.toolExecutor = deps.toolExecutor;
    this.apiKey = deps.apiKey;
    this.hooks = deps.hooks ?? [];
    this.projectContext = deps.projectContext;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const runtime = new NativeAPIRuntime(this.apiKey);
    const { executor } = createAgentPipeline(
      this.toolExecutor,
      this.agentConfig.tools,
      this.agentConfig.agentType,
      this.hooks,
    );
    runtime.setToolExecutor(executor);

    // Wire tool registry for order-preserving parallel execution
    const toolRegistryMap = new Map(this.agentConfig.tools.map((t) => [t.name, t]));
    if (runtime.setToolRegistry) {
      runtime.setToolRegistry(toolRegistryMap);
    }

    const formatCtx: ToolFormatContext | undefined = this.projectContext
      ? {
          filterContext: { projectContext: this.projectContext },
          descriptionContext: {
            projectContext: this.projectContext,
            activeSkills: [],
            agentType: this.agentConfig.agentType,
          },
        }
      : undefined;

    const config: AgentConfig = {
      agentType: this.agentConfig.agentType,
      model: this.agentConfig.model,
      system: this.buildSystemPrompt(input),
      tools: formatToolsForApi(this.agentConfig.tools, formatCtx),
      tokenBudget: TOKEN_BUDGETS[this.agentConfig.agentType],
      maxIterations: MAX_ITERATIONS[this.agentConfig.agentType],
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
      agentIdentity: this.agentConfig.identity,
      task: input,
    };
    return builder.build(promptCtx);
  }
}
