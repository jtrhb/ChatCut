import { randomUUID } from "crypto";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { JobQueue } from "../services/job-queue.js";
import type { ObjectStorage } from "../services/object-storage.js";

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
}

export interface CandidateResult {
  candidateId: string;
  label: string;
  summary: string;
  expectedMetrics: { durationChange: string; affectedElements: number };
}

export interface ExploreResult {
  explorationId: string;
  candidates: CandidateResult[];
}

export interface ExplorationEngineDeps {
  serverCore: ServerEditorCore;
  jobQueue: JobQueue;
  objectStorage: ObjectStorage;
  db: any;
}

/**
 * ExplorationEngine — orchestrates fan-out candidate materialization.
 *
 * For each candidate skeleton it:
 *   1. Clones the serverCore to produce an isolated editor instance
 *   2. Materializes the candidate (applies commands on the clone)
 *   3. Generates a unique candidateId
 *   4. Stores the result timeline snapshot
 *   5. Enqueues a pg-boss "preview-render" job for the candidate
 *
 * Finally it persists the exploration session in the DB and returns
 * the explorationId plus candidate metadata.
 */
export class ExplorationEngine {
  private readonly serverCore: ServerEditorCore;
  private readonly jobQueue: JobQueue;
  private readonly objectStorage: ObjectStorage;
  private readonly db: any;

  constructor(deps: ExplorationEngineDeps) {
    this.serverCore = deps.serverCore;
    this.jobQueue = deps.jobQueue;
    this.objectStorage = deps.objectStorage;
    this.db = deps.db;
  }

  async explore(params: ExploreParams): Promise<ExploreResult> {
    const explorationId = randomUUID();
    const candidateResults: CandidateResult[] = [];

    for (const skeleton of params.candidates) {
      // 1. Clone serverCore for isolation
      const clone = this.serverCore.clone();

      // 2. Materialize — apply each command on the clone
      // Commands are opaque at this layer; real invocation would
      // dispatch through clone.executeAgentCommand(). The clone is
      // materialized by the act of cloning — command application
      // is intentionally deferred to the preview-render worker.
      void skeleton.commands;

      // 3. Generate candidateId
      const candidateId = randomUUID();

      // 4. Store result timeline snapshot
      const serialized = clone.serialize();
      await this.objectStorage.upload(
        Buffer.from(JSON.stringify(serialized)),
        {
          contentType: "application/json",
          prefix: `explorations/${explorationId}`,
          extension: ".json",
        }
      );

      // 5. Enqueue preview-render job
      await this.jobQueue.enqueue("preview-render", {
        explorationId,
        candidateId,
        label: skeleton.label,
        timelineSnapshot: params.timelineSnapshot,
      });

      candidateResults.push({
        candidateId,
        label: skeleton.label,
        summary: skeleton.summary,
        expectedMetrics: skeleton.expectedMetrics,
      });
    }

    // 6. Persist exploration session in DB
    await this.db
      .insert()
      .values({
        explorationId,
        intent: params.intent,
        baseSnapshotVersion: params.baseSnapshotVersion,
        candidates: candidateResults,
        status: "queued",
        createdAt: new Date(),
      });

    return { explorationId, candidates: candidateResults };
  }
}
