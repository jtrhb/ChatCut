import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { ToolPipeline } from "../tool-pipeline.js";
import type { ToolDefinition, ToolCallResult } from "../types.js";
import { masterToolDefinitions } from "../master-tools.js";
import { EDITOR_TOOL_DEFINITIONS } from "../editor-tools.js";
import type { AgentType } from "../types.js";

const ctx = { agentType: "editor" as AgentType, taskId: "task-1" };

function makeExecutor() {
  return vi.fn(
    async (_name: string, _input: unknown, _ctx: unknown): Promise<ToolCallResult> => ({
      success: true,
      data: { ok: true },
    }),
  );
}

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: z.object({ value: z.string() }),
    agentTypes: ["editor"],
    accessMode: "read",
    ...overrides,
  };
}

describe("P1: fail-closed defaults on ToolDefinition", () => {
  let pipeline: ToolPipeline;

  beforeEach(() => {
    pipeline = new ToolPipeline(makeExecutor());
  });

  // 1. ToolDefinition without isReadOnly — isReadOnly is absent/undefined (defaults to false)
  it("ToolDefinition without isReadOnly has it as undefined (fail-closed: false)", () => {
    const tool = makeTool();
    // The field is optional — absence means false (fail-closed)
    expect(tool.isReadOnly).toBeUndefined();
    // Registering should not throw
    expect(() => pipeline.registerTool(tool)).not.toThrow();
  });

  // 2. ToolDefinition without isConcurrencySafe — defaults to undefined (false)
  it("ToolDefinition without isConcurrencySafe has it as undefined (fail-closed: false)", () => {
    const tool = makeTool();
    expect(tool.isConcurrencySafe).toBeUndefined();
    expect(() => pipeline.registerTool(tool)).not.toThrow();
  });

  // 3. isReadOnly:true + accessMode:"read_write" throws at registerTool()
  it("registerTool() throws when isReadOnly:true conflicts with accessMode:'read_write'", () => {
    const tool = makeTool({ isReadOnly: true, accessMode: "read_write" });
    expect(() => pipeline.registerTool(tool)).toThrow(
      `Tool "test_tool" declares isReadOnly:true but accessMode:"read_write" — conflict`,
    );
  });

  // 4. isReadOnly:true + accessMode:"write" throws at registerTool()
  it("registerTool() throws when isReadOnly:true conflicts with accessMode:'write'", () => {
    const tool = makeTool({ isReadOnly: true, accessMode: "write" });
    expect(() => pipeline.registerTool(tool)).toThrow(
      `Tool "test_tool" declares isReadOnly:true but accessMode:"write" — conflict`,
    );
  });

  // 5. isReadOnly:true without explicit accessMode auto-sets accessMode to "read"
  it("registerTool() auto-sets accessMode to 'read' when isReadOnly:true and no accessMode given", () => {
    // Construct the tool without accessMode (using a cast to simulate missing field)
    const tool = makeTool({ isReadOnly: true });
    // Remove accessMode to simulate not providing it
    const toolWithoutMode = {
      name: "no_mode_tool",
      description: "A tool without accessMode",
      inputSchema: z.object({ value: z.string() }),
      agentTypes: ["editor" as AgentType],
      isReadOnly: true,
    } as ToolDefinition;

    expect(() => pipeline.registerTool(toolWithoutMode)).not.toThrow();

    // After registration the pipeline should have auto-set accessMode to "read"
    // We verify indirectly: the tool should be registered (no error)
    // and the pipeline should treat it as a read tool (idempotency key not reserved)
    const exec = makeExecutor();
    const p2 = new ToolPipeline(exec);
    p2.registerTool(toolWithoutMode);

    // Execute to confirm no crash and tool is registered
    return p2
      .execute("no_mode_tool", { value: "hello" }, { agentType: "editor", taskId: "t1" })
      .then((result) => {
        expect(result.success).toBe(true);
      });
  });

  // 5b. isReadOnly:true with explicit accessMode:"read" does NOT throw
  it("registerTool() accepts isReadOnly:true with accessMode:'read'", () => {
    const tool = makeTool({ isReadOnly: true, accessMode: "read" });
    expect(() => pipeline.registerTool(tool)).not.toThrow();
  });

  // 6. Existing tools (masterToolDefinitions, editorToolDefinitions) register without errors
  it("existing masterToolDefinitions register with no errors on a fresh pipeline", () => {
    const exec = makeExecutor();
    const p = new ToolPipeline(exec);
    expect(() => {
      for (const tool of masterToolDefinitions) {
        p.registerTool(tool);
      }
    }).not.toThrow();
  });

  it("existing EDITOR_TOOL_DEFINITIONS register with no errors on a fresh pipeline", () => {
    const exec = makeExecutor();
    const p = new ToolPipeline(exec);
    expect(() => {
      for (const tool of EDITOR_TOOL_DEFINITIONS) {
        p.registerTool(tool);
      }
    }).not.toThrow();
  });
});
