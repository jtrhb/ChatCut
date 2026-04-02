/**
 * ProjectContext — shared state bag passed between agents in a dispatch run.
 */
export interface ArtifactEntry {
  producedBy: string;
  type: string;
  data: unknown;
  sizeBytes: number;
  timestamp: string;
  lastAccessedAt: string;
}

export interface ProjectContext {
  timelineState: string;
  snapshotVersion: number;
  videoAnalysis: {
    scenes: Array<{ start: number; end: number; description: string }>;
    characters: string[];
    mood: string;
    style: string;
    sourceStorageKey: string;
    analyzedAtSnapshotVersion: number;
    lastAnalyzedAt: string;
  } | null;
  currentIntent: {
    raw: string;
    parsed: string;
    explorationMode: boolean;
  };
  memoryContext: {
    promptText: string;
    injectedMemoryIds: string[];
    injectedSkillIds: string[];
  };
  artifacts: Record<string, ArtifactEntry>;
  recentChanges: Array<{
    id: string;
    source: string;
    summary: string;
    timestamp: number;
  }>;
}

const MAX_ARTIFACTS = 50;

function defaultContext(): ProjectContext {
  return {
    timelineState: "",
    snapshotVersion: 0,
    videoAnalysis: null,
    currentIntent: {
      raw: "",
      parsed: "",
      explorationMode: false,
    },
    memoryContext: {
      promptText: "",
      injectedMemoryIds: [],
      injectedSkillIds: [],
    },
    artifacts: {},
    recentChanges: [],
  };
}

export class ProjectContextManager {
  private _ctx: ProjectContext;

  constructor(initial?: Partial<ProjectContext>) {
    this._ctx = { ...defaultContext(), ...initial };
  }

  /** Return a readonly view of the current context. */
  get(): Readonly<ProjectContext> {
    return this._ctx;
  }

  /** Replace the video analysis data wholesale. */
  updateVideoAnalysis(analysis: NonNullable<ProjectContext["videoAnalysis"]>): void {
    this._ctx.videoAnalysis = analysis;
  }

  /** Update the serialized timeline state and snapshot version together. */
  updateTimeline(state: string, version: number): void {
    this._ctx.timelineState = state;
    this._ctx.snapshotVersion = version;
  }

  /**
   * Store an artifact. Evicts the entry with the oldest lastAccessedAt when
   * the 50-artifact cap is reached.
   */
  setArtifact(key: string, artifact: ArtifactEntry): void {
    const artifacts = this._ctx.artifacts;

    // If we're at the cap and this is a new key, evict the oldest.
    if (!(key in artifacts) && Object.keys(artifacts).length >= MAX_ARTIFACTS) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;

      for (const [k, v] of Object.entries(artifacts)) {
        const t = new Date(v.lastAccessedAt).getTime();
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }

      if (oldestKey !== undefined) {
        delete artifacts[oldestKey];
      }
    }

    artifacts[key] = artifact;
  }

  /**
   * Retrieve artifact data by key. Updates lastAccessedAt on hit.
   * Returns undefined for unknown keys.
   */
  getArtifact(key: string): unknown | undefined {
    const entry = this._ctx.artifacts[key];
    if (entry === undefined) {
      return undefined;
    }
    entry.lastAccessedAt = new Date().toISOString();
    return entry.data;
  }
}
