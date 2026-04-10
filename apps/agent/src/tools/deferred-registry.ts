import type { ToolDefinition, ToolFilterContext } from "./types.js";

export class DeferredRegistry {
  private deferred = new Map<string, ToolDefinition>();
  private resolved = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[], filterCtx?: ToolFilterContext) {
    for (const tool of tools) {
      if (!tool.shouldDefer) continue;
      // Respect isEnabled — fail-closed on throw
      if (tool.isEnabled && filterCtx) {
        try {
          if (!tool.isEnabled(filterCtx)) continue;
        } catch {
          continue;
        }
      }
      this.deferred.set(tool.name, tool);
    }
  }

  /** Get system prompt listing for deferred tools. */
  getDeferredListing(): string {
    if (this.deferred.size === 0) return "";
    const lines = ["Available on demand (call resolve_tools to use):"];
    for (const [name, tool] of this.deferred) {
      lines.push(`- ${name}: ${tool.searchHint ?? tool.description}`);
    }
    return lines.join("\n");
  }

  /** Resolve tools by name or keyword search. Returns full schemas. */
  resolve(names?: string[], search?: string): ToolDefinition[] {
    const results: ToolDefinition[] = [];

    if (names) {
      for (const name of names) {
        const tool = this.deferred.get(name);
        if (tool) {
          results.push(tool);
          this.resolved.set(name, tool);
          this.deferred.delete(name);
        }
      }
    }

    if (search) {
      const lower = search.toLowerCase();
      // Snapshot keys to avoid mutation during iteration
      const entries = [...this.deferred.entries()];
      for (const [name, tool] of entries) {
        const haystack = `${name} ${tool.searchHint ?? tool.description}`.toLowerCase();
        if (haystack.includes(lower)) {
          results.push(tool);
          this.resolved.set(name, tool);
          this.deferred.delete(name);
        }
      }
    }

    return results;
  }

  /** Get all resolved tool definitions (to add to next API request). */
  getResolvedTools(): ToolDefinition[] {
    return [...this.resolved.values()];
  }

  /** Check if any tools have been resolved. */
  hasNewResolutions(): boolean {
    return this.resolved.size > 0;
  }
}
