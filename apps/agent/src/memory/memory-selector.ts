import type { ParsedMemory, TaskContext } from "./types.js";

const SCOPE_RANK: Record<ParsedMemory["scope_level"], number> = {
  global: 0,
  brand: 1,
  platform: 2,
  series: 3,
  project: 4,
};

const CONFIDENCE_RANK: Record<ParsedMemory["confidence"], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const SOURCE_RANK: Record<ParsedMemory["source"], number> = {
  implicit: 0,
  observed: 1,
  explicit: 2,
};

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

export class MemorySelector {
  selectRelevant(memories: ParsedMemory[], task: TaskContext): ParsedMemory[] {
    // Step 1: Filter stale/deprecated
    const statusFiltered = memories.filter(
      (m) => m.status !== "stale" && m.status !== "deprecated",
    );

    // Step 2: Filter drafts by activation_scope
    // All defined scope fields must match; at least one must be defined
    const scopeFiltered = statusFiltered.filter((m) => {
      if (m.status !== "draft") return true;
      return this.matchesActivationScope(m, task);
    });

    // Step 3: Merge by semantic_key — full tiebreaker chain
    const byKey = new Map<string, ParsedMemory>();
    for (const mem of scopeFiltered) {
      const existing = byKey.get(mem.semantic_key);
      if (!existing) {
        byKey.set(mem.semantic_key, mem);
      } else if (this.beats(mem, existing)) {
        byKey.set(mem.semantic_key, mem);
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

  /**
   * Returns true if a draft memory's activation_scope matches the current task.
   * All defined scope fields must match; at least one must be defined.
   * If no activation_scope, draft passes through (globally valid).
   */
  private matchesActivationScope(memory: ParsedMemory, task: TaskContext): boolean {
    const scope = memory.activation_scope;
    if (!scope) return true;

    const checks: boolean[] = [];

    if (scope.project_id !== undefined) {
      checks.push(scope.project_id === task.projectId);
    }
    if (scope.batch_id !== undefined) {
      checks.push(scope.batch_id === task.batchId);
    }
    if (scope.session_id !== undefined) {
      checks.push(scope.session_id === task.sessionId);
    }

    // Must have at least one check and all must pass
    return checks.length > 0 && checks.every(Boolean);
  }

  /**
   * Returns true if challenger should replace incumbent.
   * Precedence: scope_level > confidence > source > updated (newer)
   */
  private beats(challenger: ParsedMemory, incumbent: ParsedMemory): boolean {
    const scopeDiff = SCOPE_RANK[challenger.scope_level] - SCOPE_RANK[incumbent.scope_level];
    if (scopeDiff !== 0) return scopeDiff > 0;

    const confDiff = CONFIDENCE_RANK[challenger.confidence] - CONFIDENCE_RANK[incumbent.confidence];
    if (confDiff !== 0) return confDiff > 0;

    const srcDiff = SOURCE_RANK[challenger.source] - SOURCE_RANK[incumbent.source];
    if (srcDiff !== 0) return srcDiff > 0;

    return challenger.updated > incumbent.updated;
  }
}
