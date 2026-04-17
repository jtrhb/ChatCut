import { nanoid } from "nanoid";
import type { ChangeLog } from "@opencut/core";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { PendingChangeset } from "./changeset-types.js";

/**
 * Thrown when a human (or another process) mutated the editor state
 * between propose and decide. Routes should map this to HTTP 409.
 */
export class StaleStateError extends Error {
  readonly kind = "stale-state" as const;
  constructor(
    message: string,
    readonly details: {
      changesetId: string;
      baseSnapshotVersion: number;
      currentSnapshotVersion: number;
      interveningHumanEntries: number;
    },
  ) {
    super(message);
    this.name = "StaleStateError";
  }
}

/**
 * Thrown when the caller's identity doesn't match the changeset owner.
 * Routes should map this to HTTP 403. Closes security C3 IDOR (any user
 * could decide any changeset by id).
 */
export class ChangesetOwnerMismatchError extends Error {
  readonly kind = "owner-mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChangesetOwnerMismatchError";
  }
}

interface ProposeParams {
  summary: string;
  affectedElements: string[];
  projectId?: string;
  userId?: string;
  /**
   * Memory IDs loaded into the agent prompt during the turn that
   * produced this changeset. Stamped per spec §9.4 so approve /
   * reject can run reinforceRelatedMemories / analyze-bad-decisions
   * later. Optional — absent for legacy or unscoped callers.
   */
  injectedMemoryIds?: string[];
  /** Skill IDs injected during the same turn. Same rationale as above. */
  injectedSkillIds?: string[];
}

interface Modification {
  type: string;
  targetId: string;
  details: Record<string, unknown>;
}

/**
 * Identity of the caller invoking approve/reject. When provided, the
 * manager verifies it matches the changeset owner — this is the IDOR
 * closure per spec §5.5 / security C3. Optional so legacy callers (and
 * tests that don't test authorization) keep working, but routes MUST
 * pass actor in production.
 */
export interface ChangesetActor {
  userId: string;
  projectId: string;
}

export class ChangesetManager {
  private readonly changeLog: ChangeLog;
  private readonly serverCore: ServerEditorCore;
  private readonly changesets = new Map<string, PendingChangeset>();
  private currentPendingId: string | null = null;
  /**
   * How long to retain terminal (approved / rejected) changesets after
   * their decidedAt timestamp. Pending changesets are never evicted —
   * they require an explicit decide. Default 7 days.
   */
  private readonly terminalRetentionMs: number;

  constructor(deps: {
    changeLog: ChangeLog;
    serverCore: ServerEditorCore;
    terminalRetentionMs?: number;
  }) {
    this.changeLog = deps.changeLog;
    this.serverCore = deps.serverCore;
    this.terminalRetentionMs = deps.terminalRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  /**
   * Opportunistic sweep: drop approved / rejected changesets whose
   * decidedAt is older than the retention window. Called from propose
   * so the map can't grow unbounded over the life of a long-running
   * agent process. Pending entries are always preserved.
   */
  private sweepTerminal(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, cs] of this.changesets) {
      if (
        (cs.status === "approved" || cs.status === "rejected") &&
        cs.decidedAt !== undefined &&
        now - cs.decidedAt > this.terminalRetentionMs
      ) {
        this.changesets.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Exposed for tests + health endpoints. */
  size(): number {
    return this.changesets.size;
  }

  async propose(params: ProposeParams): Promise<PendingChangeset> {
    // Opportunistic retention sweep — bounds the map without a timer.
    this.sweepTerminal();

    // Record boundary cursor (length - 1, or -1 if empty)
    const boundaryCursor = this.changeLog.length - 1;

    const changeset: PendingChangeset = {
      changesetId: nanoid(),
      projectId: params.projectId ?? "default",
      // "unscoped" fallback matches the B1 convention used in
      // asset-tool-executor for dev paths until auth middleware lands.
      userId: params.userId ?? "unscoped",
      boundaryCursor,
      baseSnapshotVersion: this.serverCore.snapshotVersion,
      reviewLock: true,
      status: "pending",
      summary: params.summary,
      fingerprint: {
        elementIds: params.affectedElements,
        trackIds: [],
        timeRanges: [],
      },
      injectedMemoryIds: params.injectedMemoryIds ?? [],
      injectedSkillIds: params.injectedSkillIds ?? [],
      createdAt: Date.now(),
    };

    this.changesets.set(changeset.changesetId, changeset);
    this.currentPendingId = changeset.changesetId;
    return changeset;
  }

  async approve(changesetId: string, actor?: ChangesetActor): Promise<void> {
    const changeset = this.requireDecidable(changesetId, "approve", actor);
    this.finalizeDecision(changeset, "changeset_committed", "approved");
  }

  async reject(changesetId: string, actor?: ChangesetActor): Promise<void> {
    const changeset = this.requireDecidable(changesetId, "reject", actor);
    this.finalizeDecision(changeset, "changeset_rejected", "rejected");
  }

  async approveWithMods(
    changesetId: string,
    modifications: Modification[],
    actor?: ChangesetActor,
  ): Promise<void> {
    // Owner + staleness check BEFORE recording human mods — otherwise a
    // failed approve would leave the mods in the ChangeLog with no
    // corresponding commit.
    const changeset = this.requireDecidable(changesetId, "approve", actor);

    // Record each human modification to the changeLog. These entries are
    // tagged with this changesetId so they're part of the commit, not
    // "intervening" human edits — which is why we don't re-run
    // requireDecidable after recording them (that second pass would see
    // these entries and spuriously flag the state as stale).
    for (const mod of modifications) {
      this.changeLog.record({
        source: "human",
        changesetId,
        action: {
          type: "update",
          targetType: "element",
          targetId: mod.targetId,
          details: { modificationType: mod.type, ...mod.details },
        },
        summary: `Human modification: ${mod.type} on ${mod.targetId}`,
      });
    }

    this.finalizeDecision(changeset, "changeset_committed", "approved");
  }

  getPending(): PendingChangeset | null {
    if (this.currentPendingId === null) return null;
    const cs = this.changesets.get(this.currentPendingId);
    return cs && cs.status === "pending" ? cs : null;
  }

  getChangeset(changesetId: string): PendingChangeset | undefined {
    return this.changesets.get(changesetId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Terminal state transition for a changeset that has already passed
   * requireDecidable. Emits the decision to the ChangeLog and stamps the
   * final fields on the changeset record.
   */
  private finalizeDecision(
    changeset: PendingChangeset,
    decision: "changeset_committed" | "changeset_rejected",
    terminalStatus: "approved" | "rejected",
  ): void {
    this.changeLog.emitDecision({
      type: decision,
      changesetId: changeset.changesetId,
      timestamp: Date.now(),
    });

    changeset.status = terminalStatus;
    changeset.reviewLock = false;
    changeset.decidedAt = Date.now();

    if (this.currentPendingId === changeset.changesetId) {
      this.currentPendingId = null;
    }
  }

  /**
   * Fetch the changeset and enforce the four gates for a decide-action:
   *   1. exists
   *   2. reviewLock (still open for review)
   *   3. status is still "pending"
   *   4. actor matches owner (when actor is provided)
   *   5. state is not stale (snapshotVersion + no human ChangeLog entries
   *      after the boundary cursor)
   * Returns the changeset so the caller can mutate its terminal fields.
   */
  private requireDecidable(
    changesetId: string,
    action: "approve" | "reject",
    actor?: ChangesetActor,
  ): PendingChangeset {
    const changeset = this.changesets.get(changesetId);
    if (!changeset) {
      throw new Error(`Changeset not found: ${changesetId}`);
    }
    if (!changeset.reviewLock || changeset.status !== "pending") {
      throw new Error(
        `Cannot ${action} changeset with status "${changeset.status}"`,
      );
    }

    // Owner check (IDOR closure). Only enforced when caller passes actor;
    // legacy callers that don't yet pass actor fall through for back-compat.
    if (actor) {
      if (
        actor.userId !== changeset.userId ||
        actor.projectId !== changeset.projectId
      ) {
        throw new ChangesetOwnerMismatchError(
          `Changeset ${changesetId} cannot be ${action}d by this actor: owner mismatch`,
        );
      }
    }

    // Staleness check. Two signals:
    //  a) snapshotVersion has advanced since propose (something mutated state)
    //  b) ChangeLog contains human entries after the boundary cursor
    const currentSnapshotVersion = this.serverCore.snapshotVersion;
    const interveningHumanEntries = this.changeLog
      .getCommittedAfter(changeset.boundaryCursor)
      .filter((e) => e.source === "human").length;

    const snapshotDrift = currentSnapshotVersion !== changeset.baseSnapshotVersion;

    if (snapshotDrift || interveningHumanEntries > 0) {
      throw new StaleStateError(
        `Cannot ${action} changeset ${changesetId}: editor state changed during review`,
        {
          changesetId,
          baseSnapshotVersion: changeset.baseSnapshotVersion,
          currentSnapshotVersion,
          interveningHumanEntries,
        },
      );
    }

    return changeset;
  }
}
