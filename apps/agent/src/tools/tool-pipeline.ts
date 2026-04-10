import type { AgentType, ToolCallResult, ToolDefinition, ToolProgressEvent } from "./types.js";
import type { ToolHook, ToolHookContext } from "./hooks.js";
import { classifyFailure, type ClassifiedFailure } from "./failure-classifier.js";
import type { OverflowStore } from "./overflow-store.js";
import { summarizeJson } from "./json-summarizer.js";
import type { EventBus } from "../events/event-bus.js";

export interface PipelineResult extends ToolCallResult {
  classified?: ClassifiedFailure;
}

export interface ToolPipelineOptions {
  maxTraces?: number;
  maxIdempotencyKeys?: number;
  overflowStore?: OverflowStore;
  eventBus?: EventBus;
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
  ctx: { agentType: AgentType; taskId: string; toolCallId?: string },
  onProgress?: (event: ToolProgressEvent) => void,
) => Promise<ToolCallResult>;

/**
 * Pipeline state machine:
 *   validated → reserved → executed → post_processed → committed
 *
 * On failure at any stage after reservation, the idempotency key is
 * released so legitimate retries are accepted.
 */
type PipelineStage =
  | "validated"
  | "reserved"
  | "executed"
  | "post_processed"
  | "committed";

export class ToolPipeline {
  private tools = new Map<string, ToolDefinition>();
  private hooks: ToolHook[] = [];
  private committedKeys: string[] = [];
  private committedKeySet = new Set<string>();
  private reservedKeys = new Set<string>();
  private traces: TraceEntry[] = [];
  private executor: ExecutorFn;
  private maxTraces: number;
  private maxIdempotencyKeys: number;
  private overflowStore?: OverflowStore;
  private eventBus?: EventBus;
  private refCounter = 0;

  constructor(executor: ExecutorFn, opts?: ToolPipelineOptions) {
    this.executor = executor;
    this.maxTraces = opts?.maxTraces ?? 1000;
    this.maxIdempotencyKeys = opts?.maxIdempotencyKeys ?? 10000;
    this.overflowStore = opts?.overflowStore;
    this.eventBus = opts?.eventBus;
  }

  registerTool(tool: ToolDefinition): void {
    if (tool.isReadOnly === true) {
      if (tool.accessMode === "write" || tool.accessMode === "read_write") {
        throw new Error(
          `Tool "${tool.name}" declares isReadOnly:true but accessMode:"${tool.accessMode}" — conflict`,
        );
      }
      if (!tool.accessMode) {
        tool.accessMode = "read";
      }
    }
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
        // onFailure hook errors are silently swallowed — never crash the pipeline
      }
    }
  }

  /**
   * Reserve an idempotency key to prevent concurrent duplicates.
   * Returns false if the key is already reserved or committed.
   */
  private reserveKey(key: string): boolean {
    if (this.committedKeySet.has(key) || this.reservedKeys.has(key)) {
      return false;
    }
    this.reservedKeys.add(key);
    return true;
  }

  /** Release a reserved key so retries are accepted after failure. */
  private releaseKey(key: string): void {
    this.reservedKeys.delete(key);
  }

  /** Permanently commit a reserved key after full pipeline success. */
  private commitKey(key: string): void {
    this.reservedKeys.delete(key);
    this.committedKeys.push(key);
    this.committedKeySet.add(key);
    while (this.committedKeys.length > this.maxIdempotencyKeys) {
      const evicted = this.committedKeys.shift()!;
      this.committedKeySet.delete(evicted);
    }
  }

  private pushTrace(entry: TraceEntry): void {
    this.traces.push(entry);
    while (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }
  }

  /**
   * Check if a successful result exceeds the tool's maxResultSizeChars.
   * If so, store the full result in overflow and return a preview.
   */
  private applyResultBudget(
    tool: ToolDefinition,
    result: ToolCallResult,
  ): ToolCallResult {
    if (!this.overflowStore) return result;

    const maxChars = tool.maxResultSizeChars ?? 30000;
    const serialized = typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data);

    if (serialized.length <= maxChars) {
      return result;
    }

    // Generate preview
    const preview = tool.summarize
      ? tool.summarize(result.data)
      : summarizeJson(result.data, maxChars);

    const sizeBytes = Buffer.byteLength(serialized);

    // Try to store in overflow
    const ref = `overflow_${tool.name}_${++this.refCounter}`;
    const stored = this.overflowStore.store(ref, serialized);

    if (stored) {
      return {
        success: true,
        data: { preview, ref, size_bytes: sizeBytes },
      };
    }

    // Overflow store rejected (single entry > maxBytes) — return preview only with error hint
    return {
      success: true,
      data: {
        preview,
        error: "result too large for overflow (>10MB), only preview available",
        size_bytes: sizeBytes,
      },
    };
  }

  async execute(
    toolName: string,
    input: unknown,
    ctx: { agentType: AgentType; taskId: string; toolCallId?: string },
    idempotencyKey?: string,
    onProgress?: (event: ToolProgressEvent) => void,
  ): Promise<PipelineResult> {
    // Touch overflow store on every tool call to prevent idle cleanup
    this.overflowStore?.touch();

    const start = Date.now();
    let stage: PipelineStage = "validated";
    let keyReserved = false;

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

    // ── Stage 1: Validate ──────────────────────────────────────────────────

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

    // ── Stage 2: Reserve idempotency key ───────────────────────────────────
    // Reserve the key to block concurrent duplicates. If the pipeline fails
    // at any later stage, the key is released so retries are accepted.

    const isWrite = tool.accessMode === "write" || tool.accessMode === "read_write";
    if (idempotencyKey && isWrite) {
      if (!this.reserveKey(idempotencyKey)) {
        return fail(`idempotency conflict: key "${idempotencyKey}" already used`);
      }
      keyReserved = true;
    }
    stage = "reserved";

    let effectiveInput: unknown = parsed.data;

    const hookCtx: ToolHookContext = {
      toolName,
      input: effectiveInput,
      agentType: ctx.agentType,
      taskId: ctx.taskId,
      idempotencyKey,
    };

    // ── Stage 3: Pre-hooks ─────────────────────────────────────────────────

    for (const hook of this.hooks) {
      if (!hook.pre) continue;
      try {
        const preResult = await hook.pre({ ...hookCtx, input: effectiveInput });
        if (preResult.block) {
          const reason = preResult.reason ?? `blocked by hook "${hook.name}"`;
          const result = fail(`blocked by hook: ${reason}`);
          if (keyReserved) this.releaseKey(idempotencyKey!);
          await this.runFailureHooks(hookCtx, effectiveInput, result);
          return result;
        }
        if (preResult.rewrittenInput !== undefined) {
          effectiveInput = preResult.rewrittenInput;
        }
      } catch {
        const result = fail(`pre-hook "${hook.name}" threw an error`);
        if (keyReserved) this.releaseKey(idempotencyKey!);
        await this.runFailureHooks(hookCtx, effectiveInput, result);
        return result;
      }
    }

    // ── Stage 4: Execute ───────────────────────────────────────────────────

    // Wrap onProgress to auto-inject toolCallId and forward to EventBus
    const wrappedProgress = onProgress
      ? (event: ToolProgressEvent): void => {
          const enriched: ToolProgressEvent = {
            ...event,
            toolCallId: ctx.toolCallId ?? event.toolCallId,
            toolName,
          };
          onProgress(enriched);
          if (this.eventBus) {
            this.eventBus.emit({
              type: "tool.progress",
              timestamp: Date.now(),
              taskId: ctx.taskId,
              data: {
                toolName: enriched.toolName,
                toolCallId: enriched.toolCallId,
                step: enriched.step,
                totalSteps: enriched.totalSteps,
                text: enriched.text,
              },
            });
          }
        }
      : undefined;

    let execResult: ToolCallResult;
    try {
      execResult = await this.executor(toolName, effectiveInput, ctx, wrappedProgress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const result = fail(msg);
      if (keyReserved) this.releaseKey(idempotencyKey!);
      await this.runFailureHooks(hookCtx, effectiveInput, result);
      return result;
    }

    if (!execResult.success) {
      const classified = classifyFailure(execResult.error ?? "execution_error");
      const result: PipelineResult = { ...execResult, classified };
      if (keyReserved) this.releaseKey(idempotencyKey!);
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
    stage = "executed";

    // ── Stage 5: Post-hooks ────────────────────────────────────────────────

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
        const result = fail(`post-hook "${hook.name}" threw an error`);
        if (keyReserved) this.releaseKey(idempotencyKey!);
        await this.runFailureHooks(hookCtx, effectiveInput, result);
        return result;
      }
    }
    stage = "post_processed";

    // ── Stage 5b: Result budget check ─────────────────────────────────────
    // If an overflow store is configured and the result exceeds the tool's
    // maxResultSizeChars, store the full result and return a preview.

    if (this.overflowStore && finalResult.success && finalResult.data !== undefined) {
      finalResult = this.applyResultBudget(tool, finalResult);
    }

    // ── Stage 6: Commit idempotency key ────────────────────────────────────
    // Only permanently commit after the full pipeline succeeds (exec + all
    // post-hooks). This ensures failed pipelines release the key for retries.

    if (keyReserved) {
      this.commitKey(idempotencyKey!);
    }
    stage = "committed";

    // ── Stage 7: Trace ─────────────────────────────────────────────────────

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
