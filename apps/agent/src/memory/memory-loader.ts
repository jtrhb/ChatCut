import type {
  ParsedMemory,
  TaskContext,
  MemoryContext,
  ConflictMarker,
} from "./types.js";
import type { MemoryStore } from "./memory-store.js";
import { MemorySelector } from "./memory-selector.js";
import { MemoryIndex } from "./memory-index.js";

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
    // Phase 5c: `_conflicts/*` no longer loaded via QUERY_TEMPLATES.
    // Conflict markers have their own shape (target/severity/conflicts_with)
    // that doesn't fit ParsedMemory cleanly, so they go through a dedicated
    // loadConflictMarkers() path instead. The MasterAgent prompt builder
    // surfaces them in a separate "Active conflicts" section so the LLM
    // doesn't weigh past rejections like positive guidance.
  ],
  "single-edit": (p) => [
    "global/aesthetic/*",
    "global/quality/approval-criteria.md",
    `brands/${p.brand}/identity/*`,
    ...(p.projectId ? [`projects/${p.projectId}/*`] : []),
  ],
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
  // Phase 5c: optional so test doubles that don't exercise conflicts can
  // omit them. loadConflictMarkers handles the unsupported case via the
  // wired-or-not check below.
  listConflictMarkers?(): Promise<string[]>;
  readConflictMarker?(path: string): Promise<ConflictMarker>;
}

export class MemoryLoader {
  private readonly store: MemoryStoreLike;
  private readonly selector: MemorySelector;
  private readonly index: MemoryIndex;

  constructor(store: MemoryStoreLike) {
    this.store = store;
    this.selector = new MemorySelector();
    this.index = new MemoryIndex();
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

    // Populate index
    for (const mem of candidates) {
      this.index.add(mem);
    }

    // Use MemorySelector for the filter/merge/truncate pipeline
    const selected = this.selector.selectRelevant(candidates, task);
    return this.serializeForPrompt(selected, (task.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN);
  }

  /**
   * Phase 5c: load all active conflict markers from `_conflicts/*`. Markers
   * stay until manually cleared (5c-Q4 — auto-aging is out of scope this
   * phase). Returns empty array when the store doesn't support markers
   * (older test doubles) or when listing fails — callers treat conflicts as
   * best-effort, never fail-the-turn.
   */
  async loadConflictMarkers(): Promise<ConflictMarker[]> {
    if (!this.store.listConflictMarkers || !this.store.readConflictMarker) {
      return [];
    }
    let filenames: string[];
    try {
      filenames = await this.store.listConflictMarkers();
    } catch {
      return [];
    }

    const markers: ConflictMarker[] = [];
    for (const filename of filenames) {
      try {
        const marker = await this.store.readConflictMarker(
          `_conflicts/${filename}`,
        );
        markers.push(marker);
      } catch {
        // Skip unparseable markers — file is still on disk for human review.
      }
    }
    // Newest-first so the prompt builder can take the top N if a budget cap
    // is ever added. Sort by last_seen_at (ISO strings sort correctly).
    markers.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
    return markers;
  }

  /**
   * Expose the populated MemoryIndex for downstream consumers.
   */
  getIndex(): MemoryIndex {
    return this.index;
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
