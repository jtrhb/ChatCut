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

    const loadPromise = (async () => {
      const row = await this.source.loadSnapshot(projectId);
      if (!row) {
        throw new Error(`Project not found: ${projectId}`);
      }
      const core = ServerEditorCore.fromSnapshot(row.snapshot, row.snapshotVersion);
      this.cores.set(projectId, core);
      this.lastAccessed.set(projectId, Date.now());
      return core;
    })().finally(() => {
      this.inflight.delete(projectId);
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
