import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { ToolPipeline } from "../tool-pipeline.js";
import type { ToolDefinition, ToolCallResult } from "../types.js";
import type { ToolHook } from "../hooks.js";
import type { AgentType } from "../types.js";

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

// ── Helper factories ───────────────────────────────────────────────────────

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    description: "Test tool",
    inputSchema: z.object({ value: z.string() }),
    agentTypes: ["editor"],
    accessMode: "read",
    ...overrides,
  };
}

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
    expect(executorFn).toHaveBeenCalledTimes(1);
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

    expect(preSpy).toHaveBeenCalledTimes(1);
    expect(executorFn).toHaveBeenCalledTimes(1);
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

    expect(executorFn).toHaveBeenCalledTimes(1);
    const callArgs = executorFn.mock.calls[0];
    expect(callArgs[0]).toBe("read_value");
    expect(callArgs[1]).toEqual({ value: "rewritten" });
    expect(callArgs[2]).toEqual(ctx);
  });

  // 8. post-hook called after successful execution
  it("post-hook is called after successful execution", async () => {
    const postSpy = vi.fn(async (_ctx: unknown, result: ToolCallResult) => ({
      transformedResult: { ...result, data: { transformed: true } },
    }));
    const hook: ToolHook = { name: "post-hook", post: postSpy };
    pipeline.registerHook(hook);

    const result = await pipeline.execute("read_value", { value: "hi" }, ctx);

    expect(postSpy).toHaveBeenCalledTimes(1);
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
    expect(failureSpy).toHaveBeenCalledTimes(1);
  });

  // 10. duplicate idempotency keys rejected (only for write tools)
  it("duplicate idempotency keys are rejected for write tools", async () => {
    await pipeline.execute("write_value", { value: "x" }, ctx, "key-abc");
    const second = await pipeline.execute("write_value", { value: "y" }, ctx, "key-abc");

    expect(second.success).toBe(false);
    expect(second.error).toContain("idempotency");
    expect(executorFn).toHaveBeenCalledTimes(1); // only first call goes through
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

  // 13. pre-hook throwing returns structured failure, not reject
  it("returns structured failure when pre-hook throws", async () => {
    const hook: ToolHook = {
      name: "thrower",
      pre: async () => { throw new Error("hook crashed"); },
    };
    pipeline.registerHook(hook);

    const result = await pipeline.execute("read_value", { value: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("pre-hook");
  });

  // 14. post-hook throwing returns structured failure and releases idempotency key for retry
  it("releases idempotency key when post-hook throws, allowing retry on same pipeline", async () => {
    let shouldThrow = true;
    const hook: ToolHook = {
      name: "post-thrower",
      post: async () => {
        if (shouldThrow) throw new Error("post crash");
        return {};
      },
    };
    pipeline.registerHook(hook);

    const r1 = await pipeline.execute("write_value", { value: "x" }, ctx, "post-fail-key");
    expect(r1.success).toBe(false);
    expect(r1.error).toContain("post-hook");

    // Same pipeline, same key — retry should be allowed because the key was released
    shouldThrow = false;
    const r2 = await pipeline.execute("write_value", { value: "x" }, ctx, "post-fail-key");
    expect(r2.success).toBe(true);
  });

  // 15. onFailure hook throwing does not crash execute()
  it("swallows onFailure hook errors without crashing", async () => {
    executorFn.mockResolvedValueOnce({ success: false, error: "exec failed" });
    const hook: ToolHook = {
      name: "bad-failure-hook",
      onFailure: async () => { throw new Error("failure hook crashed"); },
    };
    pipeline.registerHook(hook);

    const result = await pipeline.execute("read_value", { value: "x" }, ctx);
    expect(result.success).toBe(false);
    // Should not throw — returns normally
  });

  // 16. failed execution does not permanently occupy idempotency key
  it("allows retry with same idempotency key after execution failure", async () => {
    // First call fails
    executorFn.mockResolvedValueOnce({ success: false, error: "temporary error" });
    const r1 = await pipeline.execute("write_value", { value: "x" }, ctx, "retry-key");
    expect(r1.success).toBe(false);

    // Retry with same key should be allowed (key was not committed)
    executorFn.mockResolvedValueOnce({ success: true, data: "ok" });
    const r2 = await pipeline.execute("write_value", { value: "x" }, ctx, "retry-key");
    expect(r2.success).toBe(true);
  });

  // 17. pre-hook failure triggers onFailure hooks
  it("pre-hook failure triggers onFailure hooks", async () => {
    const failureSpy = vi.fn(async () => {});
    const preHook: ToolHook = {
      name: "crashing-pre",
      pre: async () => { throw new Error("pre crash"); },
    };
    const failureHook: ToolHook = {
      name: "failure-observer",
      onFailure: failureSpy,
    };
    pipeline.registerHook(preHook);
    pipeline.registerHook(failureHook);

    const result = await pipeline.execute("read_value", { value: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("pre-hook");
    expect(failureSpy).toHaveBeenCalledTimes(1);
  });

  // 18. post-hook failure triggers onFailure hooks
  it("post-hook failure triggers onFailure hooks", async () => {
    const failureSpy = vi.fn(async () => {});
    const postHook: ToolHook = {
      name: "crashing-post",
      post: async () => { throw new Error("post crash"); },
    };
    const failureHook: ToolHook = {
      name: "failure-observer",
      onFailure: failureSpy,
    };
    pipeline.registerHook(postHook);
    pipeline.registerHook(failureHook);

    const result = await pipeline.execute("read_value", { value: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("post-hook");
    expect(failureSpy).toHaveBeenCalledTimes(1);
  });

  // 19. onFailure hooks are always awaited (async side effects complete before return)
  it("onFailure hooks are fully awaited before execute returns", async () => {
    let sideEffectComplete = false;
    executorFn.mockResolvedValueOnce({ success: false, error: "exec failed" });

    const hook: ToolHook = {
      name: "async-failure-hook",
      onFailure: async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        sideEffectComplete = true;
      },
    };
    pipeline.registerHook(hook);

    await pipeline.execute("read_value", { value: "x" }, ctx);
    // If onFailure were fire-and-forget, sideEffectComplete would still be false
    expect(sideEffectComplete).toBe(true);
  });

  // 20. onFailure hook throwing does not crash pipeline (across all failure paths)
  it("onFailure hook throwing during post-hook failure does not crash pipeline", async () => {
    const postHook: ToolHook = {
      name: "crashing-post",
      post: async () => { throw new Error("post crash"); },
    };
    const badFailureHook: ToolHook = {
      name: "crashing-failure-hook",
      onFailure: async () => { throw new Error("failure hook also crashed"); },
    };
    pipeline.registerHook(postHook);
    pipeline.registerHook(badFailureHook);

    const result = await pipeline.execute("read_value", { value: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("post-hook");
    // Should not throw — returns normally
  });

  // 21. pre-hook block releases idempotency key for retry
  it("pre-hook block releases idempotency key allowing retry", async () => {
    let shouldBlock = true;
    const hook: ToolHook = {
      name: "conditional-blocker",
      pre: async () => shouldBlock ? { block: true, reason: "temp block" } : {},
    };
    pipeline.registerHook(hook);

    const r1 = await pipeline.execute("write_value", { value: "x" }, ctx, "block-key");
    expect(r1.success).toBe(false);
    expect(r1.error).toContain("blocked by hook");

    // Same key retry after block is lifted
    shouldBlock = false;
    const r2 = await pipeline.execute("write_value", { value: "x" }, ctx, "block-key");
    expect(r2.success).toBe(true);
  });

  // 22. pre-hook throw releases idempotency key for retry
  it("pre-hook throw releases idempotency key allowing retry", async () => {
    let shouldThrow = true;
    const hook: ToolHook = {
      name: "conditional-thrower",
      pre: async () => {
        if (shouldThrow) throw new Error("pre crash");
        return {};
      },
    };
    pipeline.registerHook(hook);

    const r1 = await pipeline.execute("write_value", { value: "x" }, ctx, "pre-throw-key");
    expect(r1.success).toBe(false);

    shouldThrow = false;
    const r2 = await pipeline.execute("write_value", { value: "x" }, ctx, "pre-throw-key");
    expect(r2.success).toBe(true);
  });

  // 23. executor throw releases idempotency key for retry
  it("executor throw releases idempotency key allowing retry", async () => {
    executorFn.mockRejectedValueOnce(new Error("executor exploded"));

    const r1 = await pipeline.execute("write_value", { value: "x" }, ctx, "exec-throw-key");
    expect(r1.success).toBe(false);

    // Retry with same key succeeds
    executorFn.mockResolvedValueOnce({ success: true, data: "ok" });
    const r2 = await pipeline.execute("write_value", { value: "x" }, ctx, "exec-throw-key");
    expect(r2.success).toBe(true);
  });

  // 24. successfully committed key still rejects duplicates
  it("committed idempotency key rejects subsequent calls", async () => {
    const r1 = await pipeline.execute("write_value", { value: "x" }, ctx, "committed-key");
    expect(r1.success).toBe(true);

    const r2 = await pipeline.execute("write_value", { value: "x" }, ctx, "committed-key");
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("idempotency");
  });

  describe("resource limits", () => {
    it("evicts oldest traces when maxTraces exceeded", async () => {
      pipeline = new ToolPipeline(executorFn, { maxTraces: 3 });
      pipeline.registerTool(makeTool());
      const ctx = { agentType: "editor" as AgentType, taskId: "t1" };

      for (let i = 0; i < 5; i++) {
        await pipeline.execute("test_tool", { value: `v${i}` }, ctx);
      }

      const traces = pipeline.getTraces();
      expect(traces).toHaveLength(3);
    });

    it("evicts oldest idempotency keys when maxIdempotencyKeys exceeded", async () => {
      pipeline = new ToolPipeline(executorFn, { maxIdempotencyKeys: 3 });
      pipeline.registerTool(makeTool({ accessMode: "write" }));
      const ctx = { agentType: "editor" as AgentType, taskId: "t1" };

      await pipeline.execute("test_tool", { value: "a" }, ctx, "key-1");
      await pipeline.execute("test_tool", { value: "b" }, ctx, "key-2");
      await pipeline.execute("test_tool", { value: "c" }, ctx, "key-3");
      // key-4 evicts key-1
      await pipeline.execute("test_tool", { value: "d" }, ctx, "key-4");
      // key-1 should be allowed again (evicted)
      const result = await pipeline.execute("test_tool", { value: "e" }, ctx, "key-1");
      expect(result.success).toBe(true);
    });
  });
});
