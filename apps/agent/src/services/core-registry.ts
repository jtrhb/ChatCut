import type { SerializedEditorState } from "@opencut/core";
import { ServerEditorCore } from "./server-editor-core.js";

export interface ProjectSnapshotRow {
  snapshot: SerializedEditorState;
  snapshotVersion: number;
  lastCommittedChangeId: string | null;
}

export interface ProjectSnapshotSource {
  loadSnapshot(projectId: string): Promise<ProjectSnapshotRow | null>;
}

export interface CoreRegistryDeps {
  source: ProjectSnapshotSource;
}

/**
 * Per-project ServerEditorCore registry with lazy loading and idle eviction.
 *
 * Plan §2.6: replaces the singleton boot core. Each call to get(projectId)
 * either returns the cached instance or hydrates one from the snapshot
 * source (typically the projects table). Concurrent first-load callers
 * for the same projectId share a single inflight promise so we don't
 * deserialize the same snapshot twice.
 *
 * Eviction is exposed as evictIdle() rather than scheduled internally — the
 * boot wiring decides whether to run a periodic cleanup. Mirrors the
 * SessionStore lifecycle (spec §3.3.2: per-project cores are session-scoped
 * to a single Agent service instance).
 */
export class CoreRegistry {
  private readonly source: ProjectSnapshotSource;
  private readonly cores = new Map<string, ServerEditorCore>();
  private readonly lastAccessed = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<ServerEditorCore>>();

  constructor(deps: CoreRegistryDeps) {
    this.source = deps.source;
  }

  async get(projectId: string): Promise<ServerEditorCore> {
    const cached = this.cores.get(projectId);
    if (cached) {
      this.lastAccessed.set(projectId, Date.now());
      return cached;
    }

    const inflight = this.inflight.get(projectId);
    if (inflight) return inflight;

    // Build the load promise via .then chaining so callers receive the
    // unwrapped result-or-rejection. The cleanup is a separate promise
    // chain whose rejection branch is explicitly silenced — the actual
    // failure is delivered to callers via the loadPromise we hand back;
    // letting the detached cleanup chain reject would trip Node's
    // unhandledRejection.
    const loadPromise = this.source.loadSnapshot(projectId).then((row) => {
      if (!row) {
        throw new Error(`Project not found: ${projectId}`);
      }
      const core = ServerEditorCore.fromSnapshot(row.snapshot, row.snapshotVersion);
      this.cores.set(projectId, core);
      this.lastAccessed.set(projectId, Date.now());
      return core;
    });
    loadPromise
      .finally(() => {
        this.inflight.delete(projectId);
      })
      .catch(() => {
        // Cleanup-branch rejection is intentionally swallowed — see comment above.
      });

    this.inflight.set(projectId, loadPromise);
    return loadPromise;
  }

  has(projectId: string): boolean {
    return this.cores.has(projectId);
  }

  invalidate(projectId: string): void {
    this.cores.delete(projectId);
    this.lastAccessed.delete(projectId);
  }

  // TODO(Phase 2C): plan §2.6 calls for "LRU with 30-min idle (mirrors
  // SessionStore)". Phase 2A ships TTL-only with no scheduled invocation
  // and no max-entries cap — callers run evictIdle() cooperatively. Add
  // maxEntries + LRU eviction on cache-set, plus a setInterval kick-off
  // from index.ts, when the registry has its first real callers.
  evictIdle(thresholdMs: number, now: number = Date.now()): string[] {
    const evicted: string[] = [];
    for (const [id, ts] of this.lastAccessed.entries()) {
      if (now - ts > thresholdMs) {
        this.cores.delete(id);
        this.lastAccessed.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }
}
