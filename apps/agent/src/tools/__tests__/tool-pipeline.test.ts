import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { ToolPipeline } from "../tool-pipeline.js";
import type { ToolDefinition, ToolCallResult } from "../types.js";
import type { ToolHook } from "../hooks.js";

// ── Shared tool definitions ────────────────────────────────────────────────

const readTool: ToolDefinition = {
  name: "read_value",
  description: "Read a value",
  inputSchema: z.object({ value: z.string() }),
  agentTypes: ["editor", "master"],
  accessMode: "read",
};

const writeTool: ToolDefinition = {
  name: "write_value",
  description: "Write a value",
  inputSchema: z.object({ value: z.string() }),
  agentTypes: ["editor"],
  accessMode: "write",
};

const ctx = { agentType: "editor" as const, taskId: "task-1" };

describe("ToolPipeline", () => {
  let executorFn: ReturnType<typeof vi.fn>;
  let pipeline: ToolPipeline;

  beforeEach(() => {
    executorFn = vi.fn(async (_name: string, _input: unknown, _ctx: unknown): Promise<ToolCallResult> => ({
      success: true,
      data: { executed: true },
    }));
    pipeline = new ToolPipeline(executorFn);
    pipeline.registerTool(readTool);
    pipeline.registerTool(writeTool);
  });

  // 1. execute() runs executor and returns result
  it("execute() runs the executor and returns its result", async () => {
    const result = await pipeline.execute("read_value", { value: "hello" }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { executed: boolean }).executed).toBe(true);
    expect(executorFn).toHaveBeenCalledOnce();
  });

  // 2. execute() rejects unknown tools
  it("execute() returns an error for unknown tools", async () => {
    const result = await pipeline.execute("ghost_tool", { value: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
    expect(executorFn).not.toHaveBeenCalled();
  });

  // 3. execute() rejects unauthorized agent types
  it("execute() rejects unauthorized agent types", async () => {
    const result = await pipeline.execute(
      "read_value",
      { value: "x" },
      { agentType: "audio", taskId: "t-auth" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
    expect(executorFn).not.toHaveBeenCalled();
  });

  // 4. execute() rejects invalid input via Zod
  it("execute() rejects invalid input via Zod with classified validation_error", async () => {
    const result = await pipeline.execute(
      "read_value",
      { value: 42 }, // should be string
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.classified?.type).toBe("validation_error");
    expect(executorFn).not.toHaveBeenCalled();
  });

  // 5. pre-hook is called before execution
  it("pre-hook is called before the executor", async () => {
    const preSpy = vi.fn(async () => ({}));
    const hook: ToolHook = { name: "spy-hook", pre: preSpy };
    pipeline.registerHook(hook);

    await pipeline.execute("read_value", { value: "hi" }, ctx);

    expect(preSpy).toHaveBeenCalledOnce();
    expect(executorFn).toHaveBeenCalledOnce();
    // pre must be called before executor
    expect(preSpy.mock.invocationCallOrder[0]).toBeLessThan(
      executorFn.mock.invocationCallOrder[0],
    );
  });

  // 6. pre-hook with block:true prevents execution
  it("pre-hook with block:true prevents execution", async () => {
    const hook: ToolHook = {
      name: "blocker",
      pre: async () => ({ block: true, reason: "rate limit" }),
    };
    pipeline.registerHook(hook);

    const result = await pipeline.execute("read_value", { value: "hi" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked by hook");
    expect(executorFn).not.toHaveBeenCalled();
  });

  // 7. pre-hook can rewrite input
  it("pre-hook can rewrite the input passed to the executor", async () => {
    const hook: ToolHook = {
      name: "rewriter",
      pre: async () => ({ rewrittenInput: { value: "rewritten" } }),
    };
    pipeline.registerHook(hook);

    await pipeline.execute("read_value", { value: "original" }, ctx);

    expect(executorFn).toHaveBeenCalledWith(
      "read_value",
      { value: "rewritten" },
      ctx,
    );
  });

  // 8. post-hook called after successful execution
  it("post-hook is called after successful execution", async () => {
    const postSpy = vi.fn(async (_ctx: unknown, result: ToolCallResult) => ({
      transformedResult: { ...result, data: { transformed: true } },
    }));
    const hook: ToolHook = { name: "post-hook", post: postSpy };
    pipeline.registerHook(hook);

    const result = await pipeline.execute("read_value", { value: "hi" }, ctx);

    expect(postSpy).toHaveBeenCalledOnce();
    expect((result.data as { transformed: boolean }).transformed).toBe(true);
  });

  // 9. onFailure hook called when execution fails
  it("onFailure hook is called when the executor returns a failure", async () => {
    executorFn.mockResolvedValueOnce({ success: false, error: "execution_error happened" });

    const failureSpy = vi.fn(async () => {});
    const hook: ToolHook = { name: "failure-hook", onFailure: failureSpy };
    pipeline.registerHook(hook);

    const result = await pipeline.execute("read_value", { value: "hi" }, ctx);

    expect(result.success).toBe(false);
    expect(failureSpy).toHaveBeenCalledOnce();
  });

  // 10. duplicate idempotency keys rejected (only for write tools)
  it("duplicate idempotency keys are rejected for write tools", async () => {
    await pipeline.execute("write_value", { value: "x" }, ctx, "key-abc");
    const second = await pipeline.execute("write_value", { value: "y" }, ctx, "key-abc");

    expect(second.success).toBe(false);
    expect(second.error).toContain("idempotency");
    expect(executorFn).toHaveBeenCalledOnce(); // only first call goes through
  });

  // 11. different idempotency keys are allowed
  it("different idempotency keys are each allowed once", async () => {
    await pipeline.execute("write_value", { value: "x" }, ctx, "key-1");
    const result = await pipeline.execute("write_value", { value: "y" }, ctx, "key-2");

    expect(result.success).toBe(true);
    expect(executorFn).toHaveBeenCalledTimes(2);
  });

  // 12. traces recorded for all executions
  it("traces are recorded for successful and failed executions", async () => {
    // successful
    await pipeline.execute("read_value", { value: "ok" }, ctx);
    // failed (unknown tool)
    await pipeline.execute("ghost_tool", { value: "x" }, ctx);

    const traces = pipeline.getTraces();
    expect(traces).toHaveLength(2);
    expect(traces[0].success).toBe(true);
    expect(traces[0].toolName).toBe("read_value");
    expect(traces[1].success).toBe(false);
    expect(traces[1].toolName).toBe("ghost_tool");
    expect(typeof traces[0].durationMs).toBe("number");
    expect(typeof traces[0].timestamp).toBe("number");
  });
});
