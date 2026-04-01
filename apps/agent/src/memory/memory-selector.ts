import type { ParsedMemory, TaskContext } from "./types.js";

const SCOPE_RANK: Record<ParsedMemory["scope_level"], number> = {
  global: 0,
  brand: 1,
  platform: 2,
  series: 3,
  project: 4,
};

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

export class MemorySelector {
  selectRelevant(memories: ParsedMemory[], task: TaskContext): ParsedMemory[] {
    // Step 1: Filter stale/deprecated
    const statusFiltered = memories.filter(
      (m) => m.status !== "stale" && m.status !== "deprecated"
    );

    // Step 2: Filter drafts by activation_scope — draft with session_id that
    // doesn't match current session is excluded
    const scopeFiltered = statusFiltered.filter((m) => {
      if (m.status !== "draft") return true;
      const scope = m.activation_scope;
      if (!scope) return true;
      if (scope.session_id !== undefined) {
        return scope.session_id === task.sessionId;
      }
      return true;
    });

    // Step 3: Merge by semantic_key — keep highest scope_level (SCOPE_RANK)
    const byKey = new Map<string, ParsedMemory>();
    for (const mem of scopeFiltered) {
      const existing = byKey.get(mem.semantic_key);
      if (!existing) {
        byKey.set(mem.semantic_key, mem);
      } else {
        const challengerRank = SCOPE_RANK[mem.scope_level];
        const incumbentRank = SCOPE_RANK[existing.scope_level];
        if (challengerRank > incumbentRank) {
          byKey.set(mem.semantic_key, mem);
        }
      }
    }

    const merged = [...byKey.values()];

    // Step 4: Token budget truncation (~4 chars/token)
    const budget = (task.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN;
    const result: ParsedMemory[] = [];
    let usedChars = 0;

    for (const mem of merged) {
      const len = mem.content.length + mem.semantic_key.length + 20;
      if (usedChars + len > budget) break;
      result.push(mem);
      usedChars += len;
    }

    return result;
  }
}
