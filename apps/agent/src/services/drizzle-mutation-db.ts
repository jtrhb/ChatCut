import { eq, max } from "drizzle-orm";
import { changeLog, projects } from "../db/schema.js";
import type {
  MutationDB,
  MutationTx,
  NewChangeLogEntry,
  UpdateProjectSnapshotOpts,
} from "./commit-mutation.js";

/**
 * Drizzle-backed MutationDB. Wraps `db.transaction(...)` and adapts the
 * tx callback's drizzle handle onto the MutationTx interface that
 * commitMutation calls.
 *
 * The change_log.sequence column is required and must be strictly
 * monotonic per project. We compute it inside the tx via
 * `SELECT max(sequence) FROM change_log WHERE project_id=$1` plus 1.
 * That SELECT shares the tx isolation level — under SERIALIZABLE this
 * is race-free; under READ COMMITTED two parallel commits could pick
 * the same sequence and the unique-index (added by Phase 2C-2) catches
 * the dup at INSERT time. Pre-MVP we run single-instance per spec
 * §3.3.2, so the contention case is theoretical.
 */
export class DrizzleMutationDB implements MutationDB {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  async transaction<T>(fn: (tx: MutationTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (drizzleTx: any) => {
      const tx: MutationTx = {
        insertChangeLogEntry: (entry) => insertChangeLogEntry(drizzleTx, entry),
        updateProjectSnapshot: (projectId, opts) =>
          updateProjectSnapshot(drizzleTx, projectId, opts),
      };
      return fn(tx);
    });
  }
}

async function insertChangeLogEntry(
  tx: any,
  entry: NewChangeLogEntry,
): Promise<{ id: string }> {
  const seqRows = await tx
    .select({ max: max(changeLog.sequence) })
    .from(changeLog)
    .where(eq(changeLog.projectId, entry.projectId));
  const nextSequence = (seqRows[0]?.max ?? 0) + 1;

  const inserted = await tx
    .insert(changeLog)
    .values({
      projectId: entry.projectId,
      sequence: nextSequence,
      source: entry.source,
      agentId: entry.agentId,
      changesetId: entry.changesetId,
      actionType: entry.actionType,
      targetType: entry.targetType,
      targetId: entry.targetId,
      details: entry.details ?? null,
      summary: entry.summary,
    })
    .returning({ id: changeLog.id });

  return { id: inserted[0].id };
}

async function updateProjectSnapshot(
  tx: any,
  projectId: string,
  opts: UpdateProjectSnapshotOpts,
): Promise<void> {
  await tx
    .update(projects)
    .set({
      timelineSnapshot: opts.snapshot,
      snapshotVersion: opts.snapshotVersion,
      lastCommittedChangeId: opts.lastCommittedChangeId,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
}
