import { describe, it, expect } from "vitest";
import { z } from "zod";
import { DeferredRegistry } from "../deferred-registry.js";
import { ResolveToolsSchema } from "../resolve-tools-tool.js";
import type { ToolDefinition } from "../types.js";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeferredRegistry", () => {
  // 1. getDeferredListing returns formatted list for deferred tools
  it("getDeferredListing returns formatted list for deferred tools", () => {
    const tools = [
      makeTool({ name: "alpha", shouldDefer: true, searchHint: "Alpha hint" }),
      makeTool({ name: "beta", shouldDefer: true }),
      makeTool({ name: "gamma", shouldDefer: false }),
    ];

    const registry = new DeferredRegistry(tools);
    const listing = registry.getDeferredListing();

    expect(listing).toContain("Available on demand (call resolve_tools to use):");
    expect(listing).toContain("- alpha: Alpha hint");
    expect(listing).toContain("- beta: Description for beta");
    expect(listing).not.toContain("gamma");
  });

  // 2. resolve by name returns full schema and moves tool from deferred to resolved
  it("resolve by name returns full schema and moves tool from deferred to resolved", () => {
    const tools = [
      makeTool({ name: "alpha", shouldDefer: true }),
      makeTool({ name: "beta", shouldDefer: true }),
    ];

    const registry = new DeferredRegistry(tools);

    const resolved = registry.resolve(["alpha"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("alpha");

    // alpha is now resolved, not deferred
    const listing = registry.getDeferredListing();
    expect(listing).not.toContain("alpha");
    expect(listing).toContain("beta");

    // getResolvedTools includes alpha
    const allResolved = registry.getResolvedTools();
    expect(allResolved).toHaveLength(1);
    expect(allResolved[0].name).toBe("alpha");
  });

  // 3. resolve by search keyword matches name and searchHint
  it("resolve by search keyword matches name and searchHint", () => {
    const tools = [
      makeTool({ name: "file_search", shouldDefer: true, searchHint: "Search for files in project" }),
      makeTool({ name: "web_fetch", shouldDefer: true, searchHint: "Fetch web content" }),
      makeTool({ name: "code_lint", shouldDefer: true, searchHint: "Lint source code" }),
    ];

    const registry = new DeferredRegistry(tools);

    // Search by name substring
    const byName = registry.resolve(undefined, "web");
    expect(byName).toHaveLength(1);
    expect(byName[0].name).toBe("web_fetch");

    // Search by hint substring
    const byHint = registry.resolve(undefined, "lint");
    expect(byHint).toHaveLength(1);
    expect(byHint[0].name).toBe("code_lint");
  });

  // 4. resolve with empty {} is rejected by schema validation
  it("resolve with empty {} is rejected by schema validation", () => {
    const result = ResolveToolsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  // 5. isEnabled=false tools excluded from deferred listing
  it("isEnabled=false tools excluded from deferred listing", () => {
    const tools = [
      makeTool({
        name: "disabled_tool",
        shouldDefer: true,
        isEnabled: () => false,
      }),
      makeTool({
        name: "enabled_tool",
        shouldDefer: true,
        isEnabled: () => true,
      }),
      makeTool({
        name: "throws_tool",
        shouldDefer: true,
        isEnabled: () => { throw new Error("boom"); },
      }),
    ];

    const registry = new DeferredRegistry(tools, {});
    const listing = registry.getDeferredListing();

    expect(listing).not.toContain("disabled_tool");
    expect(listing).toContain("enabled_tool");
    // throws_tool is excluded (fail-closed)
    expect(listing).not.toContain("throws_tool");
  });

  // 6. getResolvedTools returns all previously resolved tools
  it("getResolvedTools returns all previously resolved tools", () => {
    const tools = [
      makeTool({ name: "alpha", shouldDefer: true }),
      makeTool({ name: "beta", shouldDefer: true }),
      makeTool({ name: "gamma", shouldDefer: true }),
    ];

    const registry = new DeferredRegistry(tools);

    registry.resolve(["alpha"]);
    registry.resolve(["beta"]);

    const allResolved = registry.getResolvedTools();
    expect(allResolved).toHaveLength(2);
    const names = allResolved.map((t) => t.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).not.toContain("gamma");
  });

  // Additional edge cases

  it("getDeferredListing returns empty string when no deferred tools", () => {
    const tools = [
      makeTool({ name: "normal", shouldDefer: false }),
    ];
    const registry = new DeferredRegistry(tools);
    expect(registry.getDeferredListing()).toBe("");
  });

  it("resolve with unknown name returns empty array", () => {
    const tools = [
      makeTool({ name: "alpha", shouldDefer: true }),
    ];
    const registry = new DeferredRegistry(tools);
    const result = registry.resolve(["nonexistent"]);
    expect(result).toHaveLength(0);
  });

  it("hasNewResolutions returns true after resolving", () => {
    const tools = [
      makeTool({ name: "alpha", shouldDefer: true }),
    ];
    const registry = new DeferredRegistry(tools);
    expect(registry.hasNewResolutions()).toBe(false);

    registry.resolve(["alpha"]);
    expect(registry.hasNewResolutions()).toBe(true);
  });

  it("non-deferred tools are ignored by the registry", () => {
    const tools = [
      makeTool({ name: "core_tool", shouldDefer: false }),
      makeTool({ name: "deferred_tool", shouldDefer: true }),
    ];
    const registry = new DeferredRegistry(tools);
    const listing = registry.getDeferredListing();
    expect(listing).not.toContain("core_tool");
    expect(listing).toContain("deferred_tool");
  });
});

describe("ResolveToolsSchema", () => {
  it("accepts names array", () => {
    const result = ResolveToolsSchema.safeParse({ names: ["alpha", "beta"] });
    expect(result.success).toBe(true);
  });

  it("accepts search string", () => {
    const result = ResolveToolsSchema.safeParse({ search: "file" });
    expect(result.success).toBe(true);
  });

  it("accepts both names and search", () => {
    const result = ResolveToolsSchema.safeParse({ names: ["alpha"], search: "file" });
    expect(result.success).toBe(true);
  });

  it("rejects empty object", () => {
    const result = ResolveToolsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty names array without search", () => {
    const result = ResolveToolsSchema.safeParse({ names: [] });
    expect(result.success).toBe(false);
  });
});
