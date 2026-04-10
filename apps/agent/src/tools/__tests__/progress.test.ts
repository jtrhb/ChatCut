import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { ToolPipeline } from "../tool-pipeline.js";
import type { ToolDefinition, ToolCallResult, ToolProgressEvent } from "../types.js";
import type { AgentType } from "../types.js";
import { EventBus } from "../../events/event-bus.js";

const readTool: ToolDefinition = {
  name: "read_value",
  description: "Read a value",
  inputSchema: z.object({ value: z.string() }),
  agentTypes: ["editor", "master"],
  accessMode: "read",
};

const ctx = { agentType: "editor" as AgentType, taskId: "task-1" };

describe("ToolPipeline progress support", () => {
  // 1. execute() with onProgress callback receives events when executor calls onProgress
  it("execute() with onProgress callback receives events when executor calls onProgress", async () => {
    const receivedEvents: ToolProgressEvent[] = [];
    const onProgress = (event: ToolProgressEvent) => {
      receivedEvents.push(event);
    };

    const executorFn = vi.fn(
      async (
        _name: string,
        _input: unknown,
        _ctx: unknown,
        onProg?: (event: ToolProgressEvent) => void,
      ): Promise<ToolCallResult> => {
        onProg?.({
          type: "tool.progress",
          toolName: "read_value",
          toolCallId: "",
          step: 1,
          totalSteps: 3,
          text: "Starting...",
        });
        onProg?.({
          type: "tool.progress",
          toolName: "read_value",
          toolCallId: "",
          step: 2,
          totalSteps: 3,
          text: "Processing...",
        });
        return { success: true, data: { done: true } };
      },
    );

    const pipeline = new ToolPipeline(executorFn);
    pipeline.registerTool(readTool);

    await pipeline.execute(
      "read_value",
      { value: "hello" },
      { ...ctx, toolCallId: "tc-123" },
      undefined,
      onProgress,
    );

    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[0].step).toBe(1);
    expect(receivedEvents[1].step).toBe(2);
  });

  // 2. toolCallId is auto-injected by the pipeline wrapper
  it("toolCallId is auto-injected by the pipeline wrapper", async () => {
    const receivedEvents: ToolProgressEvent[] = [];
    const onProgress = (event: ToolProgressEvent) => {
      receivedEvents.push(event);
    };

    const executorFn = vi.fn(
      async (
        _name: string,
        _input: unknown,
        _ctx: unknown,
        onProg?: (event: ToolProgressEvent) => void,
      ): Promise<ToolCallResult> => {
        // Executor emits with empty toolCallId - pipeline should inject the real one
        onProg?.({
          type: "tool.progress",
          toolName: "read_value",
          toolCallId: "",
          step: 1,
        });
        return { success: true, data: {} };
      },
    );

    const pipeline = new ToolPipeline(executorFn);
    pipeline.registerTool(readTool);

    await pipeline.execute(
      "read_value",
      { value: "test" },
      { ...ctx, toolCallId: "tc-auto-inject" },
      undefined,
      onProgress,
    );

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].toolCallId).toBe("tc-auto-inject");
    expect(receivedEvents[0].toolName).toBe("read_value");
  });

  // 3. execute() without onProgress works identically to before (backward compatible)
  it("execute() without onProgress works identically to before", async () => {
    const executorFn = vi.fn(
      async (
        _name: string,
        _input: unknown,
        _ctx: unknown,
        _onProg?: (event: ToolProgressEvent) => void,
      ): Promise<ToolCallResult> => {
        return { success: true, data: { executed: true } };
      },
    );

    const pipeline = new ToolPipeline(executorFn);
    pipeline.registerTool(readTool);

    const result = await pipeline.execute("read_value", { value: "hello" }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { executed: boolean }).executed).toBe(true);
  });

  // 4. EventBus receives tool.progress events when eventBus is configured
  it("EventBus receives tool.progress events when eventBus is configured", async () => {
    const eventBus = new EventBus();
    const busEvents: unknown[] = [];
    eventBus.on("tool.progress", (event) => {
      busEvents.push(event);
    });

    const executorFn = vi.fn(
      async (
        _name: string,
        _input: unknown,
        _ctx: unknown,
        onProg?: (event: ToolProgressEvent) => void,
      ): Promise<ToolCallResult> => {
        onProg?.({
          type: "tool.progress",
          toolName: "read_value",
          toolCallId: "",
          step: 1,
          totalSteps: 2,
          text: "Working...",
        });
        return { success: true, data: {} };
      },
    );

    const pipeline = new ToolPipeline(executorFn, { eventBus });
    pipeline.registerTool(readTool);

    await pipeline.execute(
      "read_value",
      { value: "test" },
      { ...ctx, toolCallId: "tc-bus" },
      undefined,
      () => {}, // onProgress callback provided but we care about EventBus
    );

    expect(busEvents).toHaveLength(1);
    const emitted = busEvents[0] as Record<string, unknown>;
    expect(emitted.type).toBe("tool.progress");
    expect(emitted.taskId).toBe("task-1");
    const data = emitted.data as Record<string, unknown>;
    expect(data.toolName).toBe("read_value");
    expect(data.toolCallId).toBe("tc-bus");
    expect(data.step).toBe(1);
    expect(data.totalSteps).toBe(2);
    expect(data.text).toBe("Working...");
  });

  // 5. visualHints field on ToolCallResult is preserved through the pipeline
  it("visualHints field on ToolCallResult is preserved through the pipeline", async () => {
    const executorFn = vi.fn(
      async (): Promise<ToolCallResult> => {
        return {
          success: true,
          data: { trimmed: true },
          visualHints: {
            affectedElements: ["clip-1", "clip-2"],
            operationType: "trim",
            previewAvailable: true,
          },
        };
      },
    );

    const pipeline = new ToolPipeline(executorFn);
    pipeline.registerTool(readTool);

    const result = await pipeline.execute("read_value", { value: "test" }, ctx);
    expect(result.success).toBe(true);
    expect(result.visualHints).toBeDefined();
    expect(result.visualHints?.affectedElements).toEqual(["clip-1", "clip-2"]);
    expect(result.visualHints?.operationType).toBe("trim");
    expect(result.visualHints?.previewAvailable).toBe(true);
  });

  // Additional: EventBus NOT receiving events when no onProgress callback provided
  it("EventBus does not receive progress events when no onProgress callback", async () => {
    const eventBus = new EventBus();
    const busEvents: unknown[] = [];
    eventBus.on("tool.progress", (event) => {
      busEvents.push(event);
    });

    const executorFn = vi.fn(
      async (
        _name: string,
        _input: unknown,
        _ctx: unknown,
        onProg?: (event: ToolProgressEvent) => void,
      ): Promise<ToolCallResult> => {
        // Even though executor has the param, no wrapper is created when onProgress is not passed
        onProg?.({
          type: "tool.progress",
          toolName: "read_value",
          toolCallId: "",
          step: 1,
        });
        return { success: true, data: {} };
      },
    );

    const pipeline = new ToolPipeline(executorFn, { eventBus });
    pipeline.registerTool(readTool);

    await pipeline.execute("read_value", { value: "test" }, ctx);

    // No onProgress was passed, so wrappedProgress is undefined, so executor's onProg is undefined
    // so the optional chaining means nothing is called
    expect(busEvents).toHaveLength(0);
  });
});
