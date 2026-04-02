import type { AgentRuntime } from "./runtime.js";
import type {
  AgentConfig,
  DispatchInput,
  DispatchOutput,
} from "./types.js";
import type {
  ProjectContext,
  ProjectContextManager,
} from "../context/project-context.js";
import type { ProjectWriteLock } from "../context/write-lock.js";
import { masterToolDefinitions } from "../tools/master-tools.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import type { PromptContext } from "../prompt/types.js";
import { delegationContractSection } from "../prompt/delegation-contract.js";
import { ToolPipeline } from "../tools/tool-pipeline.js";
import type { ToolHook } from "../tools/hooks.js";
import { SkillRuntime } from "../skills/skill-runtime.js";
import type { SkillContract } from "../skills/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { formatToolsForApi } from "../tools/format-for-api.js";
import type { ChangesetManager } from "../changeset/changeset-manager.js";
import type { ExplorationEngine } from "../exploration/exploration-engine.js";
import type { TaskRegistry } from "../tasks/task-registry.js";

// ---------------------------------------------------------------------------
// Tool-name → sub-agent mapping
// ---------------------------------------------------------------------------

/** Maps a dispatch_* tool name to its sub-agent key and default access mode. */
const DISPATCH_ROUTES: Record<string, { agentKey: string; defaultAccessMode: DispatchInput["accessMode"] }> = {
  dispatch_editor:       { agentKey: "editor",       defaultAccessMode: "read_write" },
  dispatch_vision:       { agentKey: "vision",       defaultAccessMode: "read" },
  dispatch_creator:      { agentKey: "creator",      defaultAccessMode: "read_write" },
  dispatch_audio:        { agentKey: "audio",        defaultAccessMode: "read_write" },
  dispatch_asset:        { agentKey: "asset",        defaultAccessMode: "read" },
  dispatch_verification: { agentKey: "verification", defaultAccessMode: "read" },
};

// ---------------------------------------------------------------------------
// MasterAgent
// ---------------------------------------------------------------------------

export class MasterAgent {
  private runtime: AgentRuntime;
  private contextManager: ProjectContextManager;
  private writeLock: ProjectWriteLock;
  private subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;
  private pipeline: ToolPipeline;
  private skillContracts: SkillContract[];
  private changesetManager?: ChangesetManager;
  private explorationEngine?: ExplorationEngine;
  private taskRegistry?: TaskRegistry;

  constructor(deps: {
    runtime: AgentRuntime;
    contextManager: ProjectContextManager;
    writeLock: ProjectWriteLock;
    subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;
    hooks?: ToolHook[];
    skillContracts?: SkillContract[];
    changesetManager?: ChangesetManager;
    explorationEngine?: ExplorationEngine;
    taskRegistry?: TaskRegistry;
  }) {
    this.runtime = deps.runtime;
    this.contextManager = deps.contextManager;
    this.writeLock = deps.writeLock;
    this.subAgentDispatchers = deps.subAgentDispatchers;
    this.skillContracts = deps.skillContracts ?? [];
    this.changesetManager = deps.changesetManager;
    this.explorationEngine = deps.explorationEngine;
    this.taskRegistry = deps.taskRegistry;

    // Create ToolPipeline wrapping the raw tool handler
    this.pipeline = new ToolPipeline(
      async (name, input) => {
        const result = await this.handleToolCall(name, input);
        // Detect business-level failures (handleToolCall returns { error: ... })
        if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
          return { success: false, error: String((result as Record<string, unknown>).error) };
        }
        return { success: true, data: result };
      },
    );

    // Register all master tools with the pipeline
    for (const tool of masterToolDefinitions) {
      this.pipeline.registerTool(tool);
    }

    // Register any provided hooks
    if (deps.hooks) {
      for (const hook of deps.hooks) {
        this.pipeline.registerHook(hook);
      }
    }

    // Wire pipeline into runtime — all tool calls now go through the pipeline
    this.runtime.setToolExecutor(async (name: string, input: unknown) => {
      const result = await this.pipeline.execute(name, input, {
        agentType: "master",
        taskId: "master-session",
      });
      if (!result.success) {
        return { error: result.error };
      }
      return result.data;
    });
  }

  /** Access the pipeline for trace inspection or hook registration. */
  getPipeline(): ToolPipeline {
    return this.pipeline;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async handleUserMessage(message: string): Promise<string> {
    const ctx = this.contextManager.get();

    // Match skills to intent and use as active skills for this message
    const matchedSkills = this.matchSkillsForIntent(message);
    const activeSkills = matchedSkills.length > 0 ? matchedSkills : this.skillContracts;

    const systemPrompt = this.buildSystemPrompt(ctx, activeSkills);

    // Apply skill constraints to runtime config
    const resolvedModel = this.resolveModel(activeSkills);
    const resolvedTools = this.resolveTools(activeSkills);

    const config: AgentConfig = {
      agentType: "master",
      model: resolvedModel,
      system: systemPrompt,
      tools: formatToolsForApi(resolvedTools),
      tokenBudget: TOKEN_BUDGETS.master,
      maxIterations: MAX_ITERATIONS.master,
    };

    const result = await this.runtime.run(config, message);
    return result.text;
  }

  /**
   * Resolve model from active skills. If any skill specifies a model
   * different from default, use it. Falls back to claude-opus-4-6.
   */
  private resolveModel(activeSkills: SkillContract[]): string {
    for (const skill of activeSkills) {
      if (skill.frontmatter.model) {
        return skill.resolvedModel;
      }
    }
    return "claude-opus-4-6";
  }

  /**
   * Resolve tools from active skills. Applies both allowed_tools (whitelist)
   * and denied_tools (blacklist) from skill contracts.
   */
  private resolveTools(activeSkills: SkillContract[]): ToolDefinition[] {
    let tools = [...masterToolDefinitions];

    // Collect allowed_tools from active skills (union = any skill can enable a tool)
    const allowedSets = activeSkills
      .filter((s) => s.frontmatter.allowed_tools && s.frontmatter.allowed_tools.length > 0)
      .map((s) => new Set(s.resolvedTools));

    if (allowedSets.length > 0) {
      const allowed = new Set<string>();
      for (const set of allowedSets) {
        for (const tool of set) allowed.add(tool);
      }
      tools = tools.filter((t) => allowed.has(t.name));
    }

    // Collect denied_tools from active skills (union = any skill can deny a tool)
    const deniedTools = new Set<string>();
    for (const skill of activeSkills) {
      if (skill.frontmatter.denied_tools) {
        for (const tool of skill.frontmatter.denied_tools) {
          deniedTools.add(tool);
        }
      }
    }
    if (deniedTools.size > 0) {
      tools = tools.filter((t) => !deniedTools.has(t.name));
    }

    return tools;
  }

  // ── System Prompt Builder ─────────────────────────────────────────────────

  buildSystemPrompt(ctx: Readonly<ProjectContext>, activeSkills?: SkillContract[]): string {
    const builder = new PromptBuilder();
    builder.register(delegationContractSection);

    const contracts = activeSkills ?? this.skillContracts;
    if (contracts.length > 0) {
      builder.register({
        key: "activeSkills",
        priority: 40,
        isStatic: false,
        render: () => {
          const lines = ["## Active Skills"];
          for (const contract of contracts) {
            lines.push(`### ${contract.name}`);
            lines.push(contract.content);
            if (contract.resolvedTools.length > 0) {
              lines.push(`Allowed tools: ${contract.resolvedTools.join(", ")}`);
            }
            lines.push(`Effort: ${contract.frontmatter.effort ?? "medium"}`);
            lines.push("");
          }
          return lines.join("\n");
        },
      });
    }

    const promptCtx: PromptContext = {
      projectContext: ctx,
      agentIdentity: {
        role: "Master Agent",
        description:
          "You are the Master Agent for OpenCut, an AI-powered video editor. " +
          "You coordinate sub-agents (editor, vision, creator, audio, asset) to fulfill user requests.",
        rules: [
          "Analyze the user's intent before dispatching to sub-agents.",
          "Follow the Sub-Agent Delegation Contract exactly.",
          "For destructive edits, use propose_changes to get user approval first.",
        ],
      },
    };
    return builder.build(promptCtx);
  }

  /**
   * Return all skill contracts whose `when_to_use` patterns match the given intent.
   */
  matchSkillsForIntent(intent: string): SkillContract[] {
    const runtime = new SkillRuntime({ availableTools: [], defaultModel: "" });
    return this.skillContracts.filter((contract) =>
      runtime.matchesIntent(intent, contract.frontmatter),
    );
  }

  // ── Tool Call Handler ─────────────────────────────────────────────────────

  private async handleToolCall(name: string, input: unknown): Promise<unknown> {
    // Dispatch tools
    const route = DISPATCH_ROUTES[name];
    if (route) {
      return this.handleDispatch(route, input as Record<string, unknown>);
    }

    switch (name) {
      case "propose_changes": {
        if (this.changesetManager) {
          const params = input as { summary: string; affectedElements: string[]; projectId?: string };
          return this.changesetManager.propose(params);
        }
        return { status: "pending", input };
      }

      case "explore_options": {
        if (this.explorationEngine) {
          const params = input as {
            intent: string;
            baseSnapshotVersion: number;
            timelineSnapshot: string;
            candidates: Array<{
              label: string;
              summary: string;
              candidateType: string;
              commands: unknown[];
              expectedMetrics: { durationChange: string; affectedElements: number };
            }>;
          };
          return this.explorationEngine.explore(params);
        }
        return { status: "queued", input };
      }

      case "export_video": {
        if (this.taskRegistry) {
          const params = input as Record<string, unknown>;
          const task = this.taskRegistry.createTask({
            type: "export",
            description: `Export video: ${params.format ?? "mp4"} ${params.quality ?? "standard"}`,
          });
          return { task_id: task.taskId };
        }
        return { task_id: crypto.randomUUID(), input };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ── Dispatch Helpers ──────────────────────────────────────────────────────

  private async handleDispatch(
    route: { agentKey: string; defaultAccessMode: DispatchInput["accessMode"] },
    rawInput: Record<string, unknown>,
  ): Promise<unknown> {
    const dispatcher = this.subAgentDispatchers.get(route.agentKey);
    if (!dispatcher) {
      return { error: `No dispatcher registered for sub-agent: ${route.agentKey}` };
    }

    const accessMode = (rawInput.accessMode as DispatchInput["accessMode"]) ?? route.defaultAccessMode;

    const dispatchInput: DispatchInput = {
      task: rawInput.task as string,
      accessMode,
      context: rawInput.context as Record<string, unknown> | undefined,
      constraints: rawInput.constraints as DispatchInput["constraints"],
    };

    const needsLock = accessMode === "write" || accessMode === "read_write";

    if (needsLock) {
      await this.writeLock.acquire();
      try {
        return await dispatcher(dispatchInput);
      } finally {
        this.writeLock.release();
      }
    }

    return dispatcher(dispatchInput);
  }
}
