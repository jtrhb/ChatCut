import type { AgentType, ToolCallResult, ToolDefinition } from "./types.js";
import type { ToolHook, ToolHookContext } from "./hooks.js";
import { classifyFailure, type ClassifiedFailure } from "./failure-classifier.js";

export interface PipelineResult extends ToolCallResult {
  classified?: ClassifiedFailure;
}

export interface ToolPipelineOptions {
  maxTraces?: number;
  maxIdempotencyKeys?: number;
}

export interface TraceEntry {
  toolName: string;
  agentType: AgentType;
  taskId: string;
  success: boolean;
  durationMs: number;
  classified?: ClassifiedFailure;
  timestamp: number;
}

type ExecutorFn = (
  name: string,
  input: unknown,
  ctx: { agentType: AgentType; taskId: string },
) => Promise<ToolCallResult>;

export class ToolPipeline {
  private tools = new Map<string, ToolDefinition>();
  private hooks: ToolHook[] = [];
  private idempotencyKeys: string[] = [];
  private idempotencyKeySet = new Set<string>();
  private traces: TraceEntry[] = [];
  private executor: ExecutorFn;
  private maxTraces: number;
  private maxIdempotencyKeys: number;

  constructor(executor: ExecutorFn, opts?: ToolPipelineOptions) {
    this.executor = executor;
    this.maxTraces = opts?.maxTraces ?? 1000;
    this.maxIdempotencyKeys = opts?.maxIdempotencyKeys ?? 10000;
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerHook(hook: ToolHook): void {
    this.hooks.push(hook);
  }

  getTraces(): readonly TraceEntry[] {
    return this.traces;
  }

  /** Run onFailure hooks with error isolation — no hook can crash the pipeline. */
  private async runFailureHooks(
    hookCtx: ToolHookContext,
    effectiveInput: unknown,
    result: PipelineResult,
  ): Promise<void> {
    for (const h of this.hooks) {
      if (!h.onFailure) continue;
      try {
        await h.onFailure({ ...hookCtx, input: effectiveInput }, result);
      } catch {
        // onFailure hook errors are silently swallowed
      }
    }
  }

  private pushTrace(entry: TraceEntry): void {
    this.traces.push(entry);
    while (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }
  }

  async execute(
    toolName: string,
    input: unknown,
    ctx: { agentType: AgentType; taskId: string },
    idempotencyKey?: string,
  ): Promise<PipelineResult> {
    const start = Date.now();

    const fail = (error: string): PipelineResult => {
      const classified = classifyFailure(error);
      this.pushTrace({
        toolName,
        agentType: ctx.agentType,
        taskId: ctx.taskId,
        success: false,
        durationMs: Date.now() - start,
        classified,
        timestamp: start,
      });
      return { success: false, error, classified };
    };

    // ── Stage 1: Preflight ─────────────────────────────────────────────────

    const tool = this.tools.get(toolName);
    if (!tool) {
      return fail(`Unknown tool: "${toolName}"`);
    }

    if (!tool.agentTypes.includes(ctx.agentType)) {
      return fail(
        `Agent type "${ctx.agentType}" is not authorized to use tool "${toolName}"`,
      );
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return fail(parsed.error.message);
    }

    // Idempotency guard — only enforced for write/read_write tools
    const isWrite = tool.accessMode === "write" || tool.accessMode === "read_write";
    if (idempotencyKey && isWrite) {
      if (this.idempotencyKeySet.has(idempotencyKey)) {
        return fail(`idempotency conflict: key "${idempotencyKey}" already used`);
      }
      // Key is committed AFTER successful execution (see Stage 3 below)
    }

    let effectiveInput: unknown = parsed.data;

    const hookCtx: ToolHookContext = {
      toolName,
      input: effectiveInput,
      agentType: ctx.agentType,
      taskId: ctx.taskId,
      idempotencyKey,
    };

    // ── Stage 2: Pre-hooks ─────────────────────────────────────────────────

    for (const hook of this.hooks) {
      if (!hook.pre) continue;
      try {
        const preResult = await hook.pre({ ...hookCtx, input: effectiveInput });
        if (preResult.block) {
          const reason = preResult.reason ?? `blocked by hook "${hook.name}"`;
          const result = fail(`blocked by hook: ${reason}`);
          await this.runFailureHooks(hookCtx, effectiveInput, result);
          return result;
        }
        if (preResult.rewrittenInput !== undefined) {
          effectiveInput = preResult.rewrittenInput;
        }
      } catch {
        const result = fail(`pre-hook "${hook.name}" threw an error`);
        await this.runFailureHooks(hookCtx, effectiveInput, result);
        return result;
      }
    }

    // ── Stage 3: Execute ───────────────────────────────────────────────────

    let execResult: ToolCallResult;
    try {
      execResult = await this.executor(toolName, effectiveInput, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const result = fail(msg);
      await this.runFailureHooks(hookCtx, effectiveInput, result);
      return result;
    }

    if (!execResult.success) {
      const classified = classifyFailure(execResult.error ?? "execution_error");
      const result: PipelineResult = { ...execResult, classified };
      await this.runFailureHooks(hookCtx, effectiveInput, result);
      this.pushTrace({
        toolName,
        agentType: ctx.agentType,
        taskId: ctx.taskId,
        success: false,
        durationMs: Date.now() - start,
        classified,
        timestamp: start,
      });
      return result;
    }

    // ── Stage 4: Post-hooks ────────────────────────────────────────────────

    let finalResult: ToolCallResult = execResult;
    for (const hook of this.hooks) {
      if (!hook.post) continue;
      try {
        const postResult = await hook.post(
          { ...hookCtx, input: effectiveInput },
          finalResult,
        );
        if (postResult.transformedResult !== undefined) {
          finalResult = postResult.transformedResult;
        }
      } catch {
        // Post-hook error: do NOT commit idempotency key, trigger onFailure, return failure
        const result = fail(`post-hook "${hook.name}" threw an error`);
        await this.runFailureHooks(hookCtx, effectiveInput, result);
        return result;
      }
    }

    // ── Stage 5: Commit idempotency key (only after ALL post-hooks succeed) ──

    if (idempotencyKey && isWrite) {
      this.idempotencyKeys.push(idempotencyKey);
      this.idempotencyKeySet.add(idempotencyKey);
      while (this.idempotencyKeys.length > this.maxIdempotencyKeys) {
        const evicted = this.idempotencyKeys.shift()!;
        this.idempotencyKeySet.delete(evicted);
      }
    }

    // ── Stage 6: Trace ─────────────────────────────────────────────────────

    this.pushTrace({
      toolName,
      agentType: ctx.agentType,
      taskId: ctx.taskId,
      success: true,
      durationMs: Date.now() - start,
      timestamp: start,
    });

    return finalResult;
  }
}
