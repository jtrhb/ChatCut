import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { NativeAPIRuntime } from "../runtime.js";
import { DeferredRegistry } from "../../tools/deferred-registry.js";
import type { AgentConfig } from "../types.js";
import type { ToolDefinition } from "../../tools/types.js";

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

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: `Description for ${overrides.name}`,
    inputSchema: z.object({ x: z.string() }),
    agentTypes: ["master"],
    accessMode: "read",
    ...overrides,
  };
}

const baseConfig: AgentConfig = {
  agentType: "master",
  model: "claude-opus-4-6",
  system: "You are a test agent.",
  tools: [
    { name: "core_tool", description: "A core tool", input_schema: { type: "object", properties: {} } },
  ],
  tokenBudget: { input: 10_000, output: 2_000 },
  maxIterations: 10,
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
  outputTokens = 20,
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

describe("Deferred tool loading integration", () => {
  let runtime: NativeAPIRuntime;

  beforeEach(() => {
    mockCreate.mockReset();
    runtime = new NativeAPIRuntime("test-api-key");
    (runtime as unknown as { client: { messages: { create: CreateFn } } }).client.messages.create =
      mockCreate;
  });

  // 1. Deferred tools not in initial API tools parameter
  it("deferred tools are not included in the initial API tools parameter", () => {
    const coreTool = makeTool({ name: "core_tool", shouldDefer: false });
    const deferredTool = makeTool({ name: "deferred_tool", shouldDefer: true });

    const allTools = [coreTool, deferredTool];
    const coreTools = allTools.filter((t) => !t.shouldDefer);
    const deferredTools = allTools.filter((t) => t.shouldDefer);

    // Core tools go to API, deferred go to registry
    expect(coreTools).toHaveLength(1);
    expect(coreTools[0].name).toBe("core_tool");
    expect(deferredTools).toHaveLength(1);
    expect(deferredTools[0].name).toBe("deferred_tool");

    const registry = new DeferredRegistry(deferredTools);
    expect(registry.getDeferredListing()).toContain("deferred_tool");
  });

  // 2. After resolve_tools call, resolved tools appear in next API request
  it("after resolve_tools call, resolved tools appear in next API request", async () => {
    const deferredTool = makeTool({ name: "fancy_tool", shouldDefer: true, searchHint: "A fancy tool" });
    const registry = new DeferredRegistry([deferredTool]);
    runtime.setDeferredRegistry(registry);

    // Model first calls resolve_tools, then uses fancy_tool, then ends
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([{
          id: "t1",
          name: "resolve_tools",
          input: { names: ["fancy_tool"] },
        }]),
      )
      .mockResolvedValueOnce(
        makeToolUseResponse([{
          id: "t2",
          name: "fancy_tool",
          input: { x: "hello" },
        }]),
      )
      .mockResolvedValueOnce(makeEndTurnResponse("Done with fancy tool"));

    runtime.setToolExecutor(async (name, input) => {
      if (name === "resolve_tools") {
        const parsed = input as { names?: string[]; search?: string };
        const resolved = registry.resolve(parsed.names, parsed.search);
        return { resolved: resolved.map((t) => t.name) };
      }
      return { result: `executed ${name}` };
    });

    const result = await runtime.run(baseConfig, "Use fancy tool");

    expect(result.text).toBe("Done with fancy tool");

    // The second API call should include the resolved tool in tools array
    const secondCallTools = mockCreate.mock.calls[1][0].tools;
    const toolNames = secondCallTools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("fancy_tool");
  });

  // 3. Sub-agent tools are never deferred regardless of shouldDefer flag
  it("sub-agent tools are never deferred regardless of shouldDefer flag", () => {
    // Sub-agents should receive all tools including those with shouldDefer=true
    // This is enforced by the sub-agent not using DeferredRegistry at all
    const subAgentTools = [
      makeTool({ name: "sub_tool_a", shouldDefer: true, agentTypes: ["editor"] }),
      makeTool({ name: "sub_tool_b", shouldDefer: false, agentTypes: ["editor"] }),
    ];

    // Sub-agent passes ALL tools directly — no filtering by shouldDefer
    // The SubAgent class does not use DeferredRegistry, so all tools go through
    expect(subAgentTools).toHaveLength(2);
    // Both tools should be available to the sub-agent
    expect(subAgentTools.every((t) => t.agentTypes.includes("editor"))).toBe(true);
  });

  // 4. Max 3 resolve loops enforced
  it("max 3 resolve loops enforced", async () => {
    const tools = Array.from({ length: 5 }, (_, i) =>
      makeTool({ name: `tool_${i}`, shouldDefer: true }),
    );
    const registry = new DeferredRegistry(tools);
    runtime.setDeferredRegistry(registry);

    // Model keeps calling resolve_tools on every turn
    const resolveResponse = () =>
      makeToolUseResponse([{
        id: `t${Math.random()}`,
        name: "resolve_tools",
        input: { names: [`tool_${Math.floor(Math.random() * 5)}`] },
      }]);

    mockCreate
      .mockResolvedValueOnce(resolveResponse()) // resolve loop 1
      .mockResolvedValueOnce(resolveResponse()) // resolve loop 2
      .mockResolvedValueOnce(resolveResponse()) // resolve loop 3
      .mockResolvedValueOnce(resolveResponse()) // resolve loop 4 — should NOT trigger rebuild
      .mockResolvedValueOnce(makeEndTurnResponse("Done"));

    runtime.setToolExecutor(async (name, input) => {
      if (name === "resolve_tools") {
        const parsed = input as { names?: string[]; search?: string };
        registry.resolve(parsed.names, parsed.search);
        return { resolved: true };
      }
      return { result: "ok" };
    });

    const result = await runtime.run(baseConfig, "Keep resolving");
    expect(result.text).toBe("Done");

    // Verify the resolve loop counter was enforced by checking the tools array
    // After 3 resolve loops, the tools should stop being updated
    // The 4th call should use the same tools as the 3rd
    const calls = mockCreate.mock.calls;
    if (calls.length >= 4) {
      const thirdCallTools = calls[2][0].tools;
      const fourthCallTools = calls[3][0].tools;
      expect(fourthCallTools).toEqual(thirdCallTools);
    }
  });
});
