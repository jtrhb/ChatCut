import type { ParsedMemory } from "./types.js";

export class MemoryIndex {
  private entries = new Map<string, ParsedMemory>();

  add(memory: ParsedMemory): void {
    this.entries.set(memory.memory_id, memory);
  }

  remove(memoryId: string): void {
    this.entries.delete(memoryId);
  }

  getAll(): ParsedMemory[] {
    return [...this.entries.values()];
  }

  findByTags(tags: string[]): ParsedMemory[] {
    if (tags.length === 0) return [];
    return [...this.entries.values()].filter((m) =>
      m.tags.some((t) => tags.includes(t))
    );
  }

  findByScope(scopeLevel: ParsedMemory["scope_level"]): ParsedMemory[] {
    return [...this.entries.values()].filter((m) => m.scope_level === scopeLevel);
  }

  findBySemanticKey(key: string): ParsedMemory | undefined {
    for (const mem of this.entries.values()) {
      if (mem.semantic_key === key) return mem;
    }
    return undefined;
  }
}
