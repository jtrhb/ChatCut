import { randomUUID } from "crypto";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { JobQueue } from "../services/job-queue.js";
import type { ObjectStorage } from "../services/object-storage.js";
import { explorationSessions } from "../db/schema.js";

export type ExplorationStatus =
  | "queued"
  | "running"
  | "partial"
  | "completed"
  | "user_selected"
  | "applied"
  | "cancelled"
  | "expired";

/**
 * Valid state transitions for the exploration state machine.
 * Each key maps to the set of states it can transition to.
 */
const VALID_TRANSITIONS: Record<ExplorationStatus, ExplorationStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["partial", "completed", "cancelled"],
  partial: ["completed", "cancelled"],
  completed: ["user_selected", "cancelled", "expired"],
  user_selected: ["applied", "cancelled"],
  applied: [],
  cancelled: [],
  expired: [],
};

export interface ExplorationCandidate {
  label: string;
  summary: string;
  candidateType: string;
  commands: unknown[];
  expectedMetrics: { durationChange: string; affectedElements: number };
}

export interface ExploreParams {
  intent: string;
  baseSnapshotVersion: number;
  timelineSnapshot: string;
  candidates: ExplorationCandidate[];
  /**
   * The project this exploration belongs to. Required so the persisted
   * exploration_sessions row carries the right tenant scope. Audit §A.7
   * fix: previously this was hardcoded to "default" with a TODO, which
   * meant every project's explorations collided on a single key in
   * multi-project deployments.
   */
  projectId: string;
}

export interface CandidateResult {
  candidateId: string;
  label: string;
  summary: string;
  expectedMetrics: { durationChange: string; affectedElements: number };
}

export interface ExploreResult {
  explorationId: string;
  status: ExplorationStatus;
  candidates: CandidateResult[];
}

export interface ExplorationSession {
  status: ExplorationStatus;
  candidates: CandidateResult[];
  selectedCandidateId: string | null;
  createdAt: number;
}

/** Minimal DB interface matching Drizzle's insert API for exploration_sessions. */
export interface ExplorationDB {
  insert(table: typeof explorationSessions): {
    values(data: Record<string, unknown>): Promise<unknown>;
  };
}

export interface ExplorationEngineDeps {
  serverCore: ServerEditorCore;
  jobQueue: JobQueue;
  objectStorage: ObjectStorage;
  db: ExplorationDB;
}

/**
 * ExplorationEngine — orchestrates fan-out candidate materialization
 * with a full state machine tracking each exploration session.
 *
 * State machine:
 *   queued -> running -> partial -> completed -> user_selected -> applied
 *                    \-> completed               \-> cancelled
 *                    \-> cancelled                \-> expired
 *
 * For each candidate skeleton it:
 *   1. Clones the serverCore to produce an isolated editor instance
 *   2. Applies commands on the clone to materialize the candidate
 *   3. Generates a unique candidateId
 *   4. Stores the result timeline snapshot
 *   5. Enqueues a pg-boss "preview-render" job (with commands in payload)
 */
export class ExplorationEngine {
  private readonly serverCore: ServerEditorCore;
  private readonly jobQueue: JobQueue;
  private readonly objectStorage: ObjectStorage;
  private readonly db: ExplorationDB;

  private readonly sessions = new Map<string, ExplorationSession>();

  constructor(deps: ExplorationEngineDeps) {
    this.serverCore = deps.serverCore;
    this.jobQueue = deps.jobQueue;
    this.objectStorage = deps.objectStorage;
    this.db = deps.db;
  }

  async explore(params: ExploreParams): Promise<ExploreResult> {
    const explorationId = randomUUID();
    const candidateResults: CandidateResult[] = [];

    // Initialize session as queued
    this.sessions.set(explorationId, {
      status: "queued",
      candidates: [],
      selectedCandidateId: null,
      createdAt: Date.now(),
    });

    // Transition to running
    this.transition(explorationId, "running");

    for (let i = 0; i < params.candidates.length; i++) {
      const skeleton = params.candidates[i]!;

      // 1. Clone serverCore for isolation
      const clone = this.serverCore.clone();

      // 2. Apply commands on the clone to materialize the candidate
      for (const cmd of skeleton.commands) {
        clone.executeAgentCommand(cmd as any, "exploration-engine");
      }

      // 3. Generate candidateId
      const candidateId = randomUUID();

      // 4. Store result timeline snapshot (post-command application).
      // Capture the immutable storage key (Stage C.1, C-Q1) so the
      // preview-render job payload can carry just the key — the GPU
      // renderer fetches the snapshot from R2 instead of receiving a
      // multi-MB inline copy.
      const serialized = clone.serialize();
      const snapshotStorageKey = await this.objectStorage.upload(
        Buffer.from(JSON.stringify(serialized)),
        {
          contentType: "application/json",
          prefix: `explorations/${explorationId}`,
          extension: ".json",
        }
      );

      // 5. Enqueue preview-render job. snapshotStorageKey is the new
      // canonical reference; timelineSnapshot is kept for backwards-
      // compat with the legacy worker path until Stage C.5 rewires it.
      await this.jobQueue.enqueue("preview-render", {
        explorationId,
        candidateId,
        label: skeleton.label,
        commands: skeleton.commands,
        snapshotStorageKey,
        timelineSnapshot: params.timelineSnapshot,
      });

      const result: CandidateResult = {
        candidateId,
        label: skeleton.label,
        summary: skeleton.summary,
        expectedMetrics: skeleton.expectedMetrics,
      };

      candidateResults.push(result);

      // Transition to partial after first candidate completes
      if (i === 0 && params.candidates.length > 1) {
        this.transition(explorationId, "partial");
      }
    }

    // All candidates processed — transition to completed
    this.transition(explorationId, "completed");

    // Update session with final candidate list
    const session = this.sessions.get(explorationId)!;
    session.candidates = candidateResults;

    // 6. Persist exploration session in DB
    await this.db
      .insert(explorationSessions)
      .values({
        id: explorationId,
        projectId: params.projectId,
        baseSnapshotVersion: params.baseSnapshotVersion,
        userIntent: params.intent,
        candidates: candidateResults,
        status: session.status,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
      });

    return {
      explorationId,
      status: session.status,
      candidates: candidateResults,
    };
  }

  /** Get the current status of an exploration session. */
  getStatus(explorationId: string): ExplorationStatus | undefined {
    return this.sessions.get(explorationId)?.status;
  }

  /** Get the full session data for an exploration. */
  getSession(explorationId: string): ExplorationSession | undefined {
    const session = this.sessions.get(explorationId);
    if (!session) return undefined;
    return { ...session, candidates: [...session.candidates] };
  }

  /** Mark a candidate as selected by the user. Transitions to "user_selected". */
  selectCandidate(explorationId: string, candidateId: string): void {
    const session = this.sessions.get(explorationId);
    if (!session) {
      throw new Error(`Unknown exploration: ${explorationId}`);
    }

    const found = session.candidates.some((c) => c.candidateId === candidateId);
    if (!found) {
      throw new Error(
        `Unknown candidate ${candidateId} in exploration ${explorationId}`
      );
    }

    this.transition(explorationId, "user_selected");
    session.selectedCandidateId = candidateId;
  }

  /** Apply the selected candidate to the main editor. Transitions to "applied". */
  applySelection(explorationId: string): void {
    const session = this.sessions.get(explorationId);
    if (!session) {
      throw new Error(`Unknown exploration: ${explorationId}`);
    }
    if (!session.selectedCandidateId) {
      throw new Error(
        `No candidate selected in exploration ${explorationId}`
      );
    }

    this.transition(explorationId, "applied");
  }

  /** Cancel an exploration session. Transitions to "cancelled". */
  cancel(explorationId: string): void {
    const session = this.sessions.get(explorationId);
    if (!session) {
      throw new Error(`Unknown exploration: ${explorationId}`);
    }

    this.transition(explorationId, "cancelled");
  }

  /**
   * Transition the session to a new status, enforcing the state machine.
   * Throws if the transition is not allowed.
   */
  private transition(explorationId: string, to: ExplorationStatus): void {
    const session = this.sessions.get(explorationId);
    if (!session) {
      throw new Error(`Unknown exploration: ${explorationId}`);
    }

    const allowed = VALID_TRANSITIONS[session.status];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid transition: ${session.status} -> ${to} for exploration ${explorationId}`
      );
    }

    session.status = to;
  }
}
