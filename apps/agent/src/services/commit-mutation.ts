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
 *
 * Status: the human-command path is wired through the /commands HTTP
 * route (commands.ts). The agent-command path (isAgent=true with
 * agentId/taskId) is implemented and unit-tested but no production call
 * site invokes it yet — MasterAgent tool dispatch will route through it
 * in a future phase. Reviewer MEDIUM #7.
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

/**
 * Per-project serialization. Two concurrent commitMutation calls on the
 * same projectId would otherwise interleave at every await boundary
 * (cloneA → cloneB → executeA → executeB → txA → txB → swapA → swapB),
 * leaving DB and live core desynced — both clones derive from the same
 * base version, both txs write the same snapshotVersion, and the row
 * the live core ends up at depends on swap timing rather than tx
 * ordering. The mutex chains all calls for a given projectId through a
 * single promise so each clone observes the previous swap's post-state.
 *
 * Spec §3.3.2: single Agent service instance — in-process locking is
 * sufficient. The (project_id, sequence) unique index in change_log is
 * the Postgres-level backstop for the future multi-instance case.
 *
 * The mutex is module-scoped because the live cores live in CoreRegistry
 * (also module-scoped per process) — no per-call dep injection is needed
 * and tests with isolated cores still serialize correctly because they
 * share this Map.
 */
const projectLocks = new Map<string, Promise<unknown>>();

export async function commitMutation(
  params: CommitMutationParams,
): Promise<CommitMutationResult> {
  const { projectId } = params;
  // Chain onto any in-flight commit for this project. Settled promises
  // are still chained from — the previous .then() on a settled promise
  // is microtask-immediate, so contention-free calls aren't penalised.
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  const next = previous.then(
    () => doCommit(params),
    () => doCommit(params), // previous failure must not block subsequent commits
  );
  projectLocks.set(projectId, next);

  // Cleanup: drop the entry when this is the last in the chain. We
  // detach via .finally with a no-op catch — the actual rejection is
  // delivered to the caller via the `next` promise we return.
  next
    .finally(() => {
      if (projectLocks.get(projectId) === next) {
        projectLocks.delete(projectId);
      }
    })
    .catch(() => {});

  return next;
}

async function doCommit(
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
