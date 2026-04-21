import { nanoid } from "nanoid";
import type { ChangeLog } from "@opencut/core";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { EventBus } from "../events/event-bus.js";
import type { PendingChangeset, ProposedElement } from "./changeset-types.js";

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
	/**
	 * Phase 5b: per-element ghost diff. The web client renders one ghost
	 * per entry, in `proposed` state. Optional for callers that pre-date
	 * Phase 5b (legacy approve/reject regression tests, sub-agent paths
	 * that don't yet stamp the field) — defaults to `[]`.
	 */
	proposedElements?: ProposedElement[];
	/**
	 * Phase 5b: LLM self-reported confidence ∈ [0, 1]. Optional with
	 * default 0.5 so the model omitting the field doesn't fail the
	 * propose schema mid-turn — the route layer's Zod gate enforces the
	 * bound when the field IS supplied.
	 */
	confidence?: number;
	/**
	 * Phase 5b: session that produced this changeset. Forwarded to the
	 * EventBus emit so SSE filtering at routes/events.ts can route the
	 * event back to the originating browser tab. Without it, the
	 * `changeset.proposed` event sets `sessionId === undefined` and the
	 * per-session SSE filter drops it (closing security C4 also closes
	 * us off from broadcast). Optional only because tests construct a
	 * standalone manager — production paths always pass it.
	 */
	sessionId?: string;
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
	/**
	 * Phase 5b: optional EventBus for publishing `changeset.proposed |
	 * .approved | .rejected` to SSE consumers (web ghost preview state
	 * machine). Optional so unit tests that don't care about events
	 * keep their lightweight construction; production wiring at
	 * server.ts always injects.
	 */
	private readonly eventBus?: EventBus;

	constructor(deps: {
		changeLog: ChangeLog;
		serverCore: ServerEditorCore;
		terminalRetentionMs?: number;
		eventBus?: EventBus;
	}) {
		this.changeLog = deps.changeLog;
		this.serverCore = deps.serverCore;
		this.terminalRetentionMs =
			deps.terminalRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
		this.eventBus = deps.eventBus;
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

		// Phase 5b: clamp confidence to [0, 1]. The route-layer Zod gate
		// REJECTS out-of-range values (z.number().min(0).max(1) is a
		// validator, not a clamper) — this re-clamp only fires for
		// in-process callers that bypass the route schema (sub-agent
		// dispatch, tests, future direct-API consumers).
		//
		// Reviewer Phase 5b LOW-2 fix: handle NaN explicitly. `z.number()`
		// at the route layer accepts NaN, and `Math.max(0, Math.min(1,
		// NaN))` returns NaN, which serializes as `null` over JSON and
		// poisons the UI threshold logic. Mirror createGhost's behavior
		// (substitute 0.5 default).
		const rawConfidence = params.confidence ?? 0.5;
		const confidence = Number.isNaN(rawConfidence)
			? 0.5
			: Math.max(0, Math.min(1, rawConfidence));

		const proposedElements = params.proposedElements ?? [];

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
			proposedElements,
			confidence,
			sessionId: params.sessionId,
			createdAt: Date.now(),
		};

		this.changesets.set(changeset.changesetId, changeset);
		this.currentPendingId = changeset.changesetId;

		// Phase 5b: publish for SSE so the web ghost state machine spawns
		// ghosts in `proposed` state. Best-effort — handler errors inside
		// EventBus.emit are already swallowed there so this can't break the
		// tool-runtime hot path.
		this.eventBus?.emit({
			type: "changeset.proposed",
			timestamp: Date.now(),
			sessionId: params.sessionId,
			data: {
				changesetId: changeset.changesetId,
				projectId: changeset.projectId,
				summary: changeset.summary,
				proposedElements,
				confidence,
				affectedElementIds: params.affectedElements,
			},
		});

		return changeset;
	}

	async approve(changesetId: string, actor?: ChangesetActor): Promise<void> {
		const changeset = this.requireDecidable(changesetId, "approve", actor);
		this.finalizeDecision(changeset, "changeset_committed", "approved");
		// Review design-flag fix: sweep on terminal transitions too, not only
		// on propose. A system that enters an approve/reject-only quiet phase
		// (no new proposals) would otherwise retain terminal changesets past
		// the retention window.
		this.sweepTerminal();
	}

	async reject(changesetId: string, actor?: ChangesetActor): Promise<void> {
		const changeset = this.requireDecidable(changesetId, "reject", actor);
		this.finalizeDecision(changeset, "changeset_rejected", "rejected");
		this.sweepTerminal();
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

		// Phase 5b: notify SSE so the web ghost state machine transitions
		// proposed/previewing ghosts to `committed` (approved) or
		// `invalidated` (rejected). Echo with the proposing-turn's
		// sessionId — without it, the per-session SSE filter at
		// routes/events.ts drops the event (its `event.sessionId`
		// strict-equality check against the subscriber's id is `false`
		// for `undefined`).
		//
		// Reviewer Phase 5b MED-2: known UX gap. Another browser tab
		// (same project, different chat session) will NOT see the
		// approve/reject SSE update because it filters on sessionId.
		// Its ghosts stay in `proposed` style after another tab commits.
		// Out of scope for v1 per Q5=a (undo + multi-tab deferred);
		// Stage 2 / Phase 6 candidates:
		//   - Add a `projectId:` filter fallback in routes/events.ts
		//     that matches when the subscriber has no sessionId set but
		//     owns the project, OR
		//   - Emit a second broadcast event on a project-scoped channel.
		// Documented here so the deferral is discoverable at the emit
		// site rather than only in the plan doc.
		this.eventBus?.emit({
			type:
				terminalStatus === "approved"
					? "changeset.approved"
					: "changeset.rejected",
			timestamp: Date.now(),
			sessionId: changeset.sessionId,
			data: {
				changesetId: changeset.changesetId,
				projectId: changeset.projectId,
			},
		});
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

		const snapshotDrift =
			currentSnapshotVersion !== changeset.baseSnapshotVersion;

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
