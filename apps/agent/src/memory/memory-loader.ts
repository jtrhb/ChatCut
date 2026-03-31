import type { ParsedMemory, TaskContext, MemoryContext } from "./types.js";
import type { MemoryStore } from "./memory-store.js";

// ---------------------------------------------------------------------------
// Query Templates
// ---------------------------------------------------------------------------

const QUERY_TEMPLATES: Record<string, (params: TaskContext) => string[]> = {
  "batch-production": (p) => [
    "global/aesthetic/*",
    "global/quality/approval-criteria.md",
    `brands/${p.brand}/identity/*`,
    `brands/${p.brand}/platforms/*`,
    `brands/${p.brand}/_skills/*`,
    ...(p.series
      ? [
          `brands/${p.brand}/series/${p.series}/*`,
          `brands/${p.brand}/series/${p.series}/_skills/*`,
        ]
      : []),
    ...(p.projectId ? [`projects/${p.projectId}/*`] : []),
    "_conflicts/*",
  ],
  "single-edit": (p) => [
    "global/aesthetic/*",
    "global/quality/approval-criteria.md",
    `brands/${p.brand}/identity/*`,
    ...(p.projectId ? [`projects/${p.projectId}/*`] : []),
  ],
};

// ---------------------------------------------------------------------------
// Scope precedence map (higher number = higher precedence)
// ---------------------------------------------------------------------------

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

// Default token budget (tokens × ~4 chars/token)
const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// MemoryLoader
// ---------------------------------------------------------------------------

/**
 * Minimal interface so we can accept both the real MemoryStore and test doubles
 * without creating a circular import through the concrete class.
 */
interface MemoryStoreLike {
  readParsed(path: string): Promise<ParsedMemory>;
  listDir(path: string): Promise<string[]>;
}

export class MemoryLoader {
  private readonly store: MemoryStoreLike;

  constructor(store: MemoryStoreLike) {
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Load, filter, merge, and serialize memories for the given task context.
   *
   * @param task        - Describes the current agent task (brand, series, etc.)
   * @param templateKey - Which query template to use (default: "single-edit")
   */
  async loadMemories(task: TaskContext, templateKey = "single-edit"): Promise<MemoryContext> {
    const templateFn = QUERY_TEMPLATES[templateKey] ?? QUERY_TEMPLATES["single-edit"];
    const patterns = templateFn(task);

    // Expand all patterns to concrete file paths
    const paths: string[] = [];
    for (const pattern of patterns) {
      const expanded = await this.expandPattern(pattern);
      paths.push(...expanded);
    }

    // Deduplicate paths
    const uniquePaths = [...new Set(paths)];

    // Load each file
    const candidates: ParsedMemory[] = [];
    for (const path of uniquePaths) {
      try {
        const mem = await this.store.readParsed(path);
        candidates.push(mem);
      } catch {
        // Skip files that fail to parse (missing, malformed, etc.)
      }
    }

    return this.postLoadPipeline(candidates, task);
  }

  // -------------------------------------------------------------------------
  // Private pipeline
  // -------------------------------------------------------------------------

  private postLoadPipeline(candidates: ParsedMemory[], task: TaskContext): MemoryContext {
    // Step 1: Filter out stale and deprecated memories
    const statusFiltered = candidates.filter(
      (m) => m.status !== "stale" && m.status !== "deprecated"
    );

    // Step 2: Filter drafts by activation_scope
    const scopeFiltered = statusFiltered.filter((m) => {
      if (m.status !== "draft") return true;
      return this.matchesActivationScope(m, task);
    });

    // Step 3: Merge by scope precedence (dedup same semantic_key)
    const merged = this.mergeByScope(scopeFiltered);

    // Step 4 & 5: Token budget truncation + serialization
    const budget = (task.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN;
    return this.serializeForPrompt(merged, budget);
  }

  /**
   * Returns true if a draft memory's activation_scope matches the current task.
   * At least one defined scope field must match; all defined fields must match.
   */
  private matchesActivationScope(memory: ParsedMemory, task: TaskContext): boolean {
    const scope = memory.activation_scope;
    if (!scope) return false;

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
   * Deduplicate memories by semantic_key, keeping the one with the highest
   * scope precedence. Ties broken by: confidence → source → recency (updated).
   */
  mergeByScope(memories: ParsedMemory[]): ParsedMemory[] {
    const byKey = new Map<string, ParsedMemory>();

    for (const mem of memories) {
      const existing = byKey.get(mem.semantic_key);

      if (!existing) {
        byKey.set(mem.semantic_key, mem);
        continue;
      }

      if (this.beats(mem, existing)) {
        byKey.set(mem.semantic_key, mem);
      }
    }

    return [...byKey.values()];
  }

  /**
   * Returns true if `challenger` should replace `incumbent`.
   * Precedence: scope_level > confidence > source > updated (newer)
   */
  private beats(challenger: ParsedMemory, incumbent: ParsedMemory): boolean {
    const scopeDiff = SCOPE_RANK[challenger.scope_level] - SCOPE_RANK[incumbent.scope_level];
    if (scopeDiff !== 0) return scopeDiff > 0;

    const confDiff = CONFIDENCE_RANK[challenger.confidence] - CONFIDENCE_RANK[incumbent.confidence];
    if (confDiff !== 0) return confDiff > 0;

    const srcDiff = SOURCE_RANK[challenger.source] - SOURCE_RANK[incumbent.source];
    if (srcDiff !== 0) return srcDiff > 0;

    // Newer updated timestamp wins
    return challenger.updated > incumbent.updated;
  }

  /**
   * Serialize memories into a prompt text string, respecting the char budget.
   * Memories are appended in order until the budget is exhausted.
   */
  serializeForPrompt(
    memories: ParsedMemory[],
    budget: number
  ): MemoryContext {
    const injectedMemoryIds: string[] = [];
    const injectedSkillIds: string[] = [];
    const sections: string[] = [];
    let usedChars = 0;

    for (const mem of memories) {
      const section = this.formatMemorySection(mem);
      if (usedChars + section.length > budget) break;

      sections.push(section);
      usedChars += section.length;

      if (mem.skill_id) {
        injectedSkillIds.push(mem.skill_id);
      } else {
        injectedMemoryIds.push(mem.memory_id);
      }
    }

    return {
      promptText: sections.join("\n\n"),
      injectedMemoryIds,
      injectedSkillIds,
    };
  }

  /**
   * Format a single memory as a prompt section.
   */
  private formatMemorySection(mem: ParsedMemory): string {
    const header = `[${mem.scope_level.toUpperCase()}] ${mem.semantic_key} (${mem.type}, confidence=${mem.confidence})`;
    return `${header}\n${mem.content}`;
  }

  /**
   * Expand a glob pattern into concrete file paths.
   * Patterns ending in `/*` or `/*.*` trigger a listDir call.
   * All other patterns are treated as direct file references.
   */
  async expandPattern(pattern: string): Promise<string[]> {
    // Detect wildcard: ends with /* or contains a bare * segment
    if (!pattern.includes("*")) {
      // Concrete path — return as-is
      return [pattern];
    }

    // Glob: strip the wildcard suffix to get the directory prefix
    const slashStar = pattern.lastIndexOf("/*");
    const dirPath = slashStar !== -1 ? pattern.slice(0, slashStar + 1) : pattern;

    const filenames = await this.store.listDir(dirPath);

    return filenames.map((filename) => `${dirPath}${filename}`);
  }
}
