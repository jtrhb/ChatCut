import { describe, it, expect, vi, beforeEach } from "vitest";
import { NativeAPIRuntime } from "../runtime.js";
import type { AgentConfig } from "../types.js";

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

function makeEndTurnResponse(text: string, inputTokens = 10, outputTokens = 20) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function makeToolUseResponse(
  tools: Array<{ id: string; name: string; input: unknown }>,
  inputTokens = 10,
  outputTokens = 20
) {
  return {
    stop_reason: "tool_use",
    content: tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NativeAPIRuntime", () => {
  let runtime: NativeAPIRuntime;

  beforeEach(() => {
    mockCreate.mockReset();
    runtime = new NativeAPIRuntime("test-api-key");
    // Patch the internal client's create with the hoisted mock
    (runtime as unknown as { client: { messages: { create: CreateFn } } }).client.messages.create =
      mockCreate;
  });

  // 1. Returns text when model responds without tool use
  it("returns text when model responds with end_turn and no tools", async () => {
    mockCreate.mockResolvedValueOnce(makeEndTurnResponse("Hello from model"));

    const result = await runtime.run(baseConfig, "Say hello");

    expect(result.text).toBe("Hello from model");
    expect(result.toolCalls).toHaveLength(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // 2. Executes tool-use loop: first call returns tool_use, second returns end_turn
  it("executes one round of tool use then returns final text", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([{ id: "t1", name: "get_info", input: { q: "test" } }])
      )
      .mockResolvedValueOnce(makeEndTurnResponse("Done after tool"));

    runtime.setToolExecutor(async (_name, _input) => ({ result: "tool output" }));

    const result = await runtime.run(baseConfig, "Do something");

    expect(result.text).toBe("Done after tool");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("get_info");
    expect(result.toolCalls[0].input).toEqual({ q: "test" });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // 3. Stops at maxIterations when model keeps requesting tools
  it("stops at maxIterations and returns 'Max iterations reached'", async () => {
    const toolResponse = makeToolUseResponse([
      { id: "t1", name: "loop_tool", input: {} },
    ]);
    // Always return tool_use — never ends
    mockCreate.mockResolvedValue(toolResponse);

    runtime.setToolExecutor(async () => "ok");

    const config = { ...baseConfig, maxIterations: 3 };
    const result = await runtime.run(config, "Loop forever");

    expect(result.text).toBe("Max iterations reached");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  // 4. Records toolCalls in result
  it("records all tool calls in result.toolCalls", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([{ id: "t1", name: "tool_a", input: { x: 1 } }])
      )
      .mockResolvedValueOnce(
        makeToolUseResponse([{ id: "t2", name: "tool_b", input: { y: 2 } }])
      )
      .mockResolvedValueOnce(makeEndTurnResponse("All done"));

    runtime.setToolExecutor(async (name) => `output_of_${name}`);

    const result = await runtime.run(baseConfig, "Multi tool");

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("tool_a");
    expect(result.toolCalls[1].toolName).toBe("tool_b");
    expect(result.toolCalls[0].output).toBe("output_of_tool_a");
    expect(result.toolCalls[1].output).toBe("output_of_tool_b");
  });

  // 5. Calls setToolExecutor function for each tool_use block
  it("invokes the toolExecutor with correct name and input", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([{ id: "t1", name: "my_tool", input: { key: "value" } }])
      )
      .mockResolvedValueOnce(makeEndTurnResponse("result"));

    const executor = vi.fn().mockResolvedValue("executor result");
    runtime.setToolExecutor(executor);

    await runtime.run(baseConfig, "call tool");

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith("my_tool", { key: "value" });
  });

  // 6. Handles multiple tool_use blocks in single response
  it("handles multiple tool_use blocks in a single response", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: "t1", name: "alpha", input: { a: 1 } },
          { id: "t2", name: "beta", input: { b: 2 } },
          { id: "t3", name: "gamma", input: { c: 3 } },
        ])
      )
      .mockResolvedValueOnce(makeEndTurnResponse("multi done"));

    const executor = vi.fn().mockImplementation(async (name: string) => `res_${name}`);
    runtime.setToolExecutor(executor);

    const result = await runtime.run(baseConfig, "multiple tools at once");

    expect(executor).toHaveBeenCalledTimes(3);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls.map((tc) => tc.toolName)).toEqual(["alpha", "beta", "gamma"]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // 7. Returns accumulated token usage
  it("accumulates token usage across multiple API calls", async () => {
    mockCreate
      .mockResolvedValueOnce(
        // first call: tool_use with 15 input, 25 output tokens
        { ...makeToolUseResponse([{ id: "t1", name: "tok_tool", input: {} }], 15, 25) }
      )
      .mockResolvedValueOnce(
        // second call: end_turn with 20 input, 30 output tokens
        makeEndTurnResponse("token test done", 20, 30)
      );

    runtime.setToolExecutor(async () => "ok");

    const result = await runtime.run(baseConfig, "token test");

    expect(result.tokensUsed.input).toBe(35);   // 15 + 20
    expect(result.tokensUsed.output).toBe(55);  // 25 + 30
  });

  describe("session-aware run", () => {
    it("calls onTurnComplete callback with token usage after each turn", async () => {
      mockCreate.mockResolvedValueOnce(makeEndTurnResponse("Done"));

      const onTurnComplete = vi.fn();
      runtime.setOnTurnComplete(onTurnComplete);

      await runtime.run(baseConfig, "Hello");

      expect(onTurnComplete).toHaveBeenCalledWith({
        input: expect.any(Number),
        output: expect.any(Number),
      });
    });

    it("does not fail when onTurnComplete is not set", async () => {
      mockCreate.mockResolvedValueOnce(makeEndTurnResponse("Done"));
      const result = await runtime.run(baseConfig, "Hello");
      expect(result.text).toBe("Done");
    });
  });
});
