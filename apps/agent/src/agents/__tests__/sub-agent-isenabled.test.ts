import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mock NativeAPIRuntime before any agent imports so the agents never call
// the real Anthropic SDK.
// ---------------------------------------------------------------------------

vi.mock("../runtime.js", () => {
  const mockRun = vi.fn().mockResolvedValue({
    text: "mock response",
    toolCalls: [],
    tokensUsed: { input: 50, output: 30 },
    needsAssistance: false,
  });

  const NativeAPIRuntime = vi.fn().mockImplementation(() => ({
    run: mockRun,
    setToolExecutor: vi.fn(),
    setToolRegistry: vi.fn(),
  }));

  (NativeAPIRuntime as any).mockRun = mockRun;

  return { NativeAPIRuntime };
});

import { SubAgent, type SubAgentDeps, type SubAgentConfig } from "../sub-agent.js";
import { NativeAPIRuntime } from "../runtime.js";
import type { ToolDefinition } from "../../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRun = (NativeAPIRuntime as unknown as { mockRun: ReturnType<typeof vi.fn> }).mockRun;

function makeTool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: z.object({}),
    agentTypes: ["editor"],
    accessMode: "read",
    ...overrides,
  };
}

function makeSubAgent(
  tools: ToolDefinition[],
  projectContext?: Readonly<Record<string, unknown>>,
): SubAgent {
  const config: SubAgentConfig = {
    agentType: "editor",
    model: "claude-sonnet-4-6",
    tools,
    identity: { role: "Test", description: "Test agent", rules: [] },
  };
  const deps: SubAgentDeps = {
    toolExecutor: vi.fn().mockResolvedValue({ success: true }),
    apiKey: "test-key",
    projectContext,
  };
  return new SubAgent(config, deps);
}

const baseInput = { task: "test task", accessMode: "read" as const };

// ---------------------------------------------------------------------------
// P3 — SubAgent isEnabled filtering via ToolFormatContext
// ---------------------------------------------------------------------------

describe("SubAgent isEnabled filtering", () => {
  beforeEach(() => {
    mockRun.mockClear();
  });

  it("filters out tools where isEnabled returns false when projectContext is provided", async () => {
    const allowedTool = makeTool("allowed_tool");
    const blockedTool = makeTool("blocked_tool", {
      isEnabled: () => false,
    });
    const agent = makeSubAgent([allowedTool, blockedTool], { projectId: "proj-1" });

    await agent.dispatch(baseInput);

    const config = mockRun.mock.calls[0][0];
    const toolNames = config.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("allowed_tool");
    expect(toolNames).not.toContain("blocked_tool");
  });

  it("includes all tools when projectContext is not provided (no filtering)", async () => {
    const toolA = makeTool("tool_a");
    const toolB = makeTool("tool_b", {
      isEnabled: () => false,
    });
    // No projectContext — isEnabled should NOT be called
    const agent = makeSubAgent([toolA, toolB]);

    await agent.dispatch(baseInput);

    const config = mockRun.mock.calls[0][0];
    const toolNames = config.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("tool_a");
    expect(toolNames).toContain("tool_b");
  });

  it("disables a tool when isEnabled throws (fail-closed)", async () => {
    const safeTool = makeTool("safe_tool");
    const throwingTool = makeTool("throwing_tool", {
      isEnabled: () => {
        throw new Error("guard exploded");
      },
    });
    const agent = makeSubAgent([safeTool, throwingTool], { projectId: "proj-2" });

    await agent.dispatch(baseInput);

    const config = mockRun.mock.calls[0][0];
    const toolNames = config.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("safe_tool");
    expect(toolNames).not.toContain("throwing_tool");
  });

  it("appends descriptionSuffix to tool description when projectContext is present", async () => {
    const tool = makeTool("suffixed_tool", {
      descriptionSuffix: () => "[project mode]",
    });
    const agent = makeSubAgent([tool], { projectId: "proj-3" });

    await agent.dispatch(baseInput);

    const config = mockRun.mock.calls[0][0];
    const found = config.tools.find((t: { name: string }) => t.name === "suffixed_tool");
    expect(found).toBeDefined();
    expect(found.description).toContain("[project mode]");
  });
});
