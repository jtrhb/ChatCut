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

// ---------------------------------------------------------------------------
// Tool-name → sub-agent mapping
// ---------------------------------------------------------------------------

/** Maps a dispatch_* tool name to its sub-agent key and default access mode. */
const DISPATCH_ROUTES: Record<string, { agentKey: string; defaultAccessMode: DispatchInput["accessMode"] }> = {
  dispatch_editor:  { agentKey: "editor",  defaultAccessMode: "read_write" },
  dispatch_vision:  { agentKey: "vision",  defaultAccessMode: "read" },
  dispatch_creator: { agentKey: "creator", defaultAccessMode: "read_write" },
  dispatch_audio:   { agentKey: "audio",   defaultAccessMode: "read_write" },
  dispatch_asset:   { agentKey: "asset",   defaultAccessMode: "read" },
};

// ---------------------------------------------------------------------------
// MasterAgent
// ---------------------------------------------------------------------------

export class MasterAgent {
  private runtime: AgentRuntime;
  private contextManager: ProjectContextManager;
  private writeLock: ProjectWriteLock;
  private subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;

  constructor(deps: {
    runtime: AgentRuntime;
    contextManager: ProjectContextManager;
    writeLock: ProjectWriteLock;
    subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;
  }) {
    this.runtime = deps.runtime;
    this.contextManager = deps.contextManager;
    this.writeLock = deps.writeLock;
    this.subAgentDispatchers = deps.subAgentDispatchers;

    // Wire up tool executor
    this.runtime.setToolExecutor(this.handleToolCall.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async handleUserMessage(message: string): Promise<string> {
    const ctx = this.contextManager.get();
    const systemPrompt = this.buildSystemPrompt(ctx);

    const config: AgentConfig = {
      agentType: "master",
      model: "claude-opus-4-6",
      system: systemPrompt,
      tools: masterToolDefinitions,
      tokenBudget: TOKEN_BUDGETS.master,
      maxIterations: MAX_ITERATIONS.master,
    };

    const result = await this.runtime.run(config, message);
    return result.text;
  }

  // ── System Prompt Builder ─────────────────────────────────────────────────

  buildSystemPrompt(ctx: Readonly<ProjectContext>): string {
    const sections: string[] = [];

    sections.push(
      "You are the Master Agent for OpenCut, an AI-powered video editor.",
      "You coordinate sub-agents (editor, vision, creator, audio, asset) to fulfill user requests.",
      "",
    );

    // Timeline state
    sections.push("## Current Timeline State");
    sections.push(ctx.timelineState || "(empty timeline)");
    sections.push(`Snapshot version: ${ctx.snapshotVersion}`);
    sections.push("");

    // Memory context
    if (ctx.memoryContext.promptText) {
      sections.push("## Memory Context");
      sections.push(ctx.memoryContext.promptText);
      if (ctx.memoryContext.injectedMemoryIds.length > 0) {
        sections.push(`Active memory IDs: ${ctx.memoryContext.injectedMemoryIds.join(", ")}`);
      }
      sections.push("");
    }

    // Recent changes
    if (ctx.recentChanges.length > 0) {
      sections.push("## Recent Changes");
      for (const change of ctx.recentChanges) {
        sections.push(`- [${change.source}] ${change.summary}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  // ── Tool Call Handler ─────────────────────────────────────────────────────

  private async handleToolCall(name: string, input: unknown): Promise<unknown> {
    // Dispatch tools
    const route = DISPATCH_ROUTES[name];
    if (route) {
      return this.handleDispatch(route, input as Record<string, unknown>);
    }

    // Stub tools
    switch (name) {
      case "propose_changes":
        return { status: "pending", input };

      case "explore_options":
        return { status: "queued", input };

      case "export_video":
        return { task_id: crypto.randomUUID(), input };

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
