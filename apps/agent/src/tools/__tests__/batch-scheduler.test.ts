import { describe, it, expect } from "vitest";
import { buildOrderPreservingBatches } from "../batch-scheduler.js";
import type { ToolDefinition } from "../types.js";
import { z } from "zod";

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

function makeBlock(id: string, name: string) {
  return { id, name, input: {} };
}

function makeRegistry(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]));
}

describe("buildOrderPreservingBatches", () => {
  it("groups all isConcurrencySafe:true tools into a single parallel batch", () => {
    const tools = [makeTool("read_a", true), makeTool("read_b", true), makeTool("read_c", true)];
    const registry = makeRegistry(tools);
    const blocks = [makeBlock("1", "read_a"), makeBlock("2", "read_b"), makeBlock("3", "read_c")];

    const batches = buildOrderPreservingBatches(blocks, registry);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it("puts each isConcurrencySafe:false tool in its own batch", () => {
    const tools = [makeTool("write_a", false), makeTool("write_b", false), makeTool("write_c", false)];
    const registry = makeRegistry(tools);
    const blocks = [makeBlock("1", "write_a"), makeBlock("2", "write_b"), makeBlock("3", "write_c")];

    const batches = buildOrderPreservingBatches(blocks, registry);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    expect(batches[2]).toHaveLength(1);
  });

  it("handles mixed [safe, safe, unsafe, safe] → [[safe, safe], [unsafe], [safe]]", () => {
    const tools = [
      makeTool("read_a", true),
      makeTool("read_b", true),
      makeTool("write_c", false),
      makeTool("read_d", true),
    ];
    const registry = makeRegistry(tools);
    const blocks = [
      makeBlock("1", "read_a"),
      makeBlock("2", "read_b"),
      makeBlock("3", "write_c"),
      makeBlock("4", "read_d"),
    ];

    const batches = buildOrderPreservingBatches(blocks, registry);

    expect(batches).toHaveLength(3);
    expect(batches[0].map((b) => b.name)).toEqual(["read_a", "read_b"]);
    expect(batches[1].map((b) => b.name)).toEqual(["write_c"]);
    expect(batches[2].map((b) => b.name)).toEqual(["read_d"]);
  });

  it("treats unknown tools (not in registry) as unsafe — fail-closed", () => {
    const tools = [makeTool("read_a", true)];
    const registry = makeRegistry(tools);
    const blocks = [
      makeBlock("1", "read_a"),
      makeBlock("2", "unknown_tool"),
      makeBlock("3", "read_a"),
    ];

    const batches = buildOrderPreservingBatches(blocks, registry);

    expect(batches).toHaveLength(3);
    expect(batches[0].map((b) => b.name)).toEqual(["read_a"]);
    expect(batches[1].map((b) => b.name)).toEqual(["unknown_tool"]);
    expect(batches[2].map((b) => b.name)).toEqual(["read_a"]);
  });

  it("returns empty array for empty input", () => {
    const registry = new Map<string, ToolDefinition>();
    const batches = buildOrderPreservingBatches([], registry);
    expect(batches).toEqual([]);
  });

  it("returns single batch for a single tool", () => {
    const tools = [makeTool("read_a", true)];
    const registry = makeRegistry(tools);
    const blocks = [makeBlock("1", "read_a")];

    const batches = buildOrderPreservingBatches(blocks, registry);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });
});
