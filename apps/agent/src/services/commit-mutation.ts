import type { Command, SerializedEditorState } from "@opencut/core";
import type { ServerEditorCore } from "./server-editor-core.js";

/**
 * Atomic mutation primitive (audit Phase 2.4 / spec §A.1-A.3).
 *
 * Pattern: clone → execute on clone → DB transaction (insert change_log +
 * update projects snapshot) → atomic replaceRuntime swap on success.
 * On any failure (command throw, tx failure, insert failure) the live
 * core is **not touched** and the clone is dropped for GC.
 *
 * The DB layer is abstracted behind MutationDB so the primitive is
 * testable without a real Postgres connection. Phase 2C wires this to
 * the real drizzle handle by adapting the schema's `changeLog` and
 * `projects` tables onto the MutationTx interface.
 */

export type ChangeSource = "human" | "agent" | "system";

export interface NewChangeLogEntry {
  projectId: string;
  source: ChangeSource;
  agentId?: string;
  changesetId?: string;
  actionType: string;
  targetType: string;
  targetId: string;
  details?: unknown;
  summary?: string;
}

export interface UpdateProjectSnapshotOpts {
  snapshot: SerializedEditorState;
  snapshotVersion: number;
  lastCommittedChangeId: string;
}

export interface MutationTx {
  insertChangeLogEntry(entry: NewChangeLogEntry): Promise<{ id: string }>;
  updateProjectSnapshot(projectId: string, opts: UpdateProjectSnapshotOpts): Promise<void>;
}

export interface MutationDB {
  transaction<T>(fn: (tx: MutationTx) => Promise<T>): Promise<T>;
}

export interface CommitMutationParams {
  liveCore: ServerEditorCore;
  projectId: string;
  command: Command;
  changeEntry: NewChangeLogEntry;
  db: MutationDB;
  /** Defaults to true (agent command path). Pass false for human commands. */
  isAgent?: boolean;
  /** Required when isAgent is true (default). */
  agentId?: string;
  /** Optional rollback group tag (only meaningful for agent commands). */
  taskId?: string;
}

export interface CommitMutationResult {
  snapshotVersion: number;
  changeId: string;
}

export async function commitMutation(
  params: CommitMutationParams,
): Promise<CommitMutationResult> {
  const { liveCore, projectId, command, changeEntry, db } = params;
  const isAgent = params.isAgent !== false;

  // Step 1: clone the live runtime. Independent EditorCore + history.
  const clone = liveCore.clone();

  // Step 2: execute the command on the clone. If this throws, the live
  // core is still untouched and we never reach the DB.
  if (isAgent) {
    if (!params.agentId) {
      throw new Error("commitMutation: agentId is required for agent commands");
    }
    clone.executeAgentCommand(command, params.agentId, params.taskId);
  } else {
    clone.executeHumanCommand(command);
  }

  // Step 3: DB transaction. Insert change_log row, then update the
  // projects snapshot to the post-execute state. If either step throws,
  // the tx aborts and we propagate — the live core is still untouched.
  const { changeId } = await db.transaction(async (tx) => {
    const inserted = await tx.insertChangeLogEntry(changeEntry);
    await tx.updateProjectSnapshot(projectId, {
      snapshot: clone.serialize(),
      snapshotVersion: clone.snapshotVersion,
      lastCommittedChangeId: inserted.id,
    });
    return { changeId: inserted.id };
  });

  // Step 4: tx committed. Synchronously swap the clone onto the live
  // core. No await between the version-bump (already done by the clone's
  // execute call) and the swap.
  liveCore.replaceRuntime(clone);

  return {
    snapshotVersion: liveCore.snapshotVersion,
    changeId,
  };
}
