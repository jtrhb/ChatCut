import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { ToolPipeline } from "../tool-pipeline.js";
import { OverflowStore } from "../overflow-store.js";
import type { ToolDefinition, ToolCallResult } from "../types.js";

const ctx = { agentType: "editor" as const, taskId: "task-1" };

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

describe("Result budget integration", () => {
  let executorFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executorFn = vi.fn(
      async (
        _name: string,
        _input: unknown,
        _ctx: unknown,
      ): Promise<ToolCallResult> => ({
        success: true,
        data: { executed: true },
      }),
    );
  });

  // 1. Tool result under maxResultSizeChars returns normally (no overflow)
  it("tool result under maxResultSizeChars returns normally", async () => {
    const overflowStore = new OverflowStore();
    const pipeline = new ToolPipeline(executorFn, { overflowStore });

    const tool = makeTool({ maxResultSizeChars: 1000 });
    pipeline.registerTool(tool);

    // Return small data
    executorFn.mockResolvedValueOnce({
      success: true,
      data: { small: "result" },
    });

    const result = await pipeline.execute("test_tool", { value: "hi" }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ small: "result" });
    // No overflow ref
    expect((result.data as Record<string, unknown>).ref).toBeUndefined();
    expect(overflowStore.size).toBe(0);
  });

  // 2. Tool result over maxResultSizeChars with summarize() stores full result, returns preview from summarize()
  it("tool result over maxResultSizeChars with summarize() stores full result and returns custom preview", async () => {
    const overflowStore = new OverflowStore();
    const pipeline = new ToolPipeline(executorFn, { overflowStore });

    const tool = makeTool({
      maxResultSizeChars: 50,
      summarize: (result: unknown) => "custom summary of result",
    });
    pipeline.registerTool(tool);

    // Return large data
    const largeData = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` })) };
    executorFn.mockResolvedValueOnce({
      success: true,
      data: largeData,
    });

    const result = await pipeline.execute("test_tool", { value: "hi" }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { preview: string; ref: string; size_bytes: number };
    expect(data.preview).toBe("custom summary of result");
    expect(data.ref).toBeDefined();
    expect(typeof data.ref).toBe("string");
    expect(data.size_bytes).toBeGreaterThan(0);

    // Full result should be stored in overflow
    expect(overflowStore.size).toBeGreaterThan(0);
    const full = overflowStore.read(data.ref);
    expect(full).not.toBeNull();
    expect(JSON.parse(full!.content)).toEqual(largeData);
  });

  // 3. Tool result over maxResultSizeChars without summarize() uses default JSON summarizer
  it("tool result over maxResultSizeChars without summarize() uses default JSON summarizer", async () => {
    const overflowStore = new OverflowStore();
    const pipeline = new ToolPipeline(executorFn, { overflowStore });

    // Use a reasonable maxResultSizeChars so the preview can include truncation hints
    const tool = makeTool({ maxResultSizeChars: 500 });
    pipeline.registerTool(tool);

    const largeData = {
      topKey: "value",
      items: Array.from({ length: 100 }, (_, i) => `item-${i}`),
      nested: { deep: true },
    };
    executorFn.mockResolvedValueOnce({
      success: true,
      data: largeData,
    });

    const result = await pipeline.execute("test_tool", { value: "hi" }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { preview: string; ref: string; size_bytes: number };
    expect(data.ref).toBeDefined();
    expect(data.size_bytes).toBeGreaterThan(0);
    // Default summarizer should preserve structure hints
    expect(data.preview).toContain("topKey");
    expect(data.preview).toContain("items");
    expect(data.preview).toContain("...and");
  });

  // 4. Pipeline without overflowStore behaves identically to current (backward compatible)
  it("pipeline without overflowStore returns results as-is regardless of size", async () => {
    const pipeline = new ToolPipeline(executorFn);

    const tool = makeTool({ maxResultSizeChars: 50 });
    pipeline.registerTool(tool);

    const largeData = { items: Array.from({ length: 100 }, (_, i) => `item-${i}`) };
    executorFn.mockResolvedValueOnce({
      success: true,
      data: largeData,
    });

    const result = await pipeline.execute("test_tool", { value: "hi" }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(largeData);
  });

  // 5. Overflow store touch() is called on every tool call
  it("touches the overflow store on every tool call", async () => {
    const overflowStore = new OverflowStore();
    const touchSpy = vi.spyOn(overflowStore, "touch");
    const pipeline = new ToolPipeline(executorFn, { overflowStore });

    const tool = makeTool();
    pipeline.registerTool(tool);

    await pipeline.execute("test_tool", { value: "a" }, ctx);
    await pipeline.execute("test_tool", { value: "b" }, ctx);

    expect(touchSpy).toHaveBeenCalledTimes(2);
  });

  // 6. Failed tool results are NOT stored in overflow
  it("failed tool results are not stored in overflow", async () => {
    const overflowStore = new OverflowStore();
    const pipeline = new ToolPipeline(executorFn, { overflowStore });

    const tool = makeTool({ maxResultSizeChars: 50 });
    pipeline.registerTool(tool);

    executorFn.mockResolvedValueOnce({
      success: false,
      error: "something went wrong with a lot of detail ".repeat(10),
    });

    const result = await pipeline.execute("test_tool", { value: "hi" }, ctx);

    expect(result.success).toBe(false);
    expect(overflowStore.size).toBe(0);
  });

  // 7. When overflow store rejects (>maxBytes), return preview with error hint
  it("returns preview with error hint when overflow store rejects entry", async () => {
    const overflowStore = new OverflowStore({ maxBytes: 50 });
    const pipeline = new ToolPipeline(executorFn, { overflowStore });

    const tool = makeTool({ maxResultSizeChars: 10 });
    pipeline.registerTool(tool);

    // Data that serializes to >50 bytes (exceeds overflow maxBytes)
    const largeData = { content: "x".repeat(100) };
    executorFn.mockResolvedValueOnce({
      success: true,
      data: largeData,
    });

    const result = await pipeline.execute("test_tool", { value: "hi" }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { preview: string; error?: string };
    expect(data.preview).toBeDefined();
    expect(data.error).toContain("result too large for overflow");
  });
});
