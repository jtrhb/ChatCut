import { describe, it, expect, vi, beforeEach } from "vitest";
import { NativeAPIRuntime } from "../runtime.js";
import type { AgentConfig } from "../types.js";
import type { ToolDefinition } from "../../tools/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk
// ---------------------------------------------------------------------------

type CreateFn = ReturnType<typeof vi.fn>;

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts: unknown) {}
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: AgentConfig = {
  agentType: "editor",
  model: "claude-3-5-sonnet-20241022",
  system: "You are a test agent.",
  tools: [],
  tokenBudget: { input: 10_000, output: 2_000 },
  maxIterations: 5,
};

function makeTool(name: string, isConcurrencySafe: boolean): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({}),
    agentTypes: ["master"],
    accessMode: "read",
    isConcurrencySafe,
  };
}

function makeEndTurnResponse(text: string) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function makeToolUseResponse(tools: Array<{ id: string; name: string; input: unknown }>) {
  return {
    stop_reason: "tool_use",
    content: tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function makeRegistry(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NativeAPIRuntime parallel execution", () => {
  let runtime: NativeAPIRuntime;

  beforeEach(() => {
    mockCreate.mockReset();
    runtime = new NativeAPIRuntime("test-api-key");
    (runtime as unknown as { client: { messages: { create: CreateFn } } }).client.messages.create =
      mockCreate;
  });

  it("executes two isConcurrencySafe:true tools in parallel via Promise.all", async () => {
    const tools = [makeTool("read_a", true), makeTool("read_b", true)];
    runtime.setToolRegistry(makeRegistry(tools));

    // Track execution ordering to verify parallelism
    const executionLog: string[] = [];

    runtime.setToolExecutor(async (name: string) => {
      executionLog.push(`start:${name}`);
      // Simulate async work — in parallel, both starts happen before either finishes
      await new Promise((r) => setTimeout(r, 10));
      executionLog.push(`end:${name}`);
      return `result_${name}`;
    });

    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: "t1", name: "read_a", input: {} },
          { id: "t2", name: "read_b", input: {} },
        ])
      )
      .mockResolvedValueOnce(makeEndTurnResponse("done"));

    const result = await runtime.run(baseConfig, "parallel test");

    expect(result.toolCalls).toHaveLength(2);
    // Both should start before either ends (parallel execution)
    expect(executionLog[0]).toBe("start:read_a");
    expect(executionLog[1]).toBe("start:read_b");
    expect(executionLog[2]).toMatch(/^end:/);
    expect(executionLog[3]).toMatch(/^end:/);
  });

  it("isConcurrencySafe:false tool forms barrier — preceding batch completes before it starts", async () => {
    const tools = [
      makeTool("read_a", true),
      makeTool("read_b", true),
      makeTool("write_c", false),
    ];
    runtime.setToolRegistry(makeRegistry(tools));

    const executionLog: string[] = [];

    runtime.setToolExecutor(async (name: string) => {
      executionLog.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 5));
      executionLog.push(`end:${name}`);
      return `result_${name}`;
    });

    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: "t1", name: "read_a", input: {} },
          { id: "t2", name: "read_b", input: {} },
          { id: "t3", name: "write_c", input: {} },
        ])
      )
      .mockResolvedValueOnce(makeEndTurnResponse("done"));

    const result = await runtime.run(baseConfig, "barrier test");

    expect(result.toolCalls).toHaveLength(3);
    // read_a and read_b should both start before write_c starts
    const writeStartIdx = executionLog.indexOf("start:write_c");
    const readAEndIdx = executionLog.indexOf("end:read_a");
    const readBEndIdx = executionLog.indexOf("end:read_b");
    // write_c must start AFTER both reads have ended
    expect(writeStartIdx).toBeGreaterThan(readAEndIdx);
    expect(writeStartIdx).toBeGreaterThan(readBEndIdx);
  });

  it("without toolRegistry, all tools execute sequentially (backward compatible)", async () => {
    // No setToolRegistry call — should fall back to sequential

    const executionLog: string[] = [];

    runtime.setToolExecutor(async (name: string) => {
      executionLog.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 5));
      executionLog.push(`end:${name}`);
      return `result_${name}`;
    });

    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: "t1", name: "read_a", input: {} },
          { id: "t2", name: "read_b", input: {} },
        ])
      )
      .mockResolvedValueOnce(makeEndTurnResponse("done"));

    const result = await runtime.run(baseConfig, "sequential test");

    expect(result.toolCalls).toHaveLength(2);
    // Sequential: first tool fully completes before second starts
    expect(executionLog).toEqual([
      "start:read_a",
      "end:read_a",
      "start:read_b",
      "end:read_b",
    ]);
  });
});
