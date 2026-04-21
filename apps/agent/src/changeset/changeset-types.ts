/**
 * Phase 5b: per-element ghost diff carried on a proposed changeset.
 * Each entry corresponds to ONE prospective timeline mutation that the
 * web client should render as a ghost preview. `ghostId` is the stable
 * client-side handle (matches `dependsOn` arrays for stale propagation).
 *
 * `kind` mirrors the ChangeLog action types: `insert` (new clip),
 * `update` (mutate existing element's bounds/properties), `delete`.
 *
 * `targetId` references an existing element/track for `update`/`delete`;
 * absent for `insert` (the ghost is the placeholder until acceptance).
 *
 * `payload` is intentionally `unknown` at the agent layer — the web
 * client owns the TimelineElement schema. Keeping it loose here lets the
 * agent forward whatever the LLM proposed without dragging the editor
 * type system into the agent process.
 */
export interface ProposedElement {
	ghostId: string;
	kind: "insert" | "update" | "delete";
	trackId?: string;
	targetId?: string;
	payload?: unknown;
	/**
	 * Optional: ghosts this one supersedes. When the upstream ghost moves
	 * to `invalidated` or `stale`, dependents propagate to `stale` per the
	 * Phase 5b state machine. Empty / absent means independent.
	 */
	dependsOn?: string[];
}

export interface PendingChangeset {
	changesetId: string;
	projectId: string;
	/**
	 * Owner of the changeset. Stored at propose time so approve/reject can
	 * enforce that the caller matches before acting — closes security C3
	 * (changeset IDOR: any user could decide any changeset by id).
	 */
	userId: string;
	boundaryCursor: number; // ChangeLog index at changeset start
	/**
	 * ServerEditorCore.snapshotVersion at propose time. Approve/reject
	 * compare this against current snapshotVersion to detect that a human
	 * (or another process) mutated the editor state during the review
	 * window — if so, the decision is rejected with StaleStateError.
	 */
	baseSnapshotVersion: number;
	/**
	 * True while the changeset is open for user review. Set false when
	 * approve/reject completes. Doubles as "is this still actionable" —
	 * the manager refuses decisions on a !reviewLock record.
	 */
	reviewLock: boolean;
	status: "pending" | "approved" | "rejected";
	summary: string;
	fingerprint: {
		elementIds: string[];
		trackIds: string[];
		timeRanges: Array<{ start: number; end: number }>;
	};
	injectedMemoryIds: string[];
	injectedSkillIds: string[];
	/**
	 * Phase 5b: per-element ghost diff. Always an array (possibly empty
	 * for changesets that the LLM produced before this field landed, or
	 * for non-element changesets). The web client maps each entry to a
	 * ghost in `proposed` state on receipt.
	 */
	proposedElements: ProposedElement[];
	/**
	 * Phase 5b (Q4=a): LLM self-reported confidence in the proposal,
	 * normalized to [0, 1]. Drives the UI border styling
	 * (low → dashed yellow, mid → solid blue, high → solid green) and
	 * gives operators a single number to threshold on for batch UX
	 * decisions. Defaults to 0.5 if the model omits it.
	 */
	confidence: number;
	/**
	 * Phase 5b: session that produced this changeset, persisted at
	 * propose time so approve/reject can re-emit `changeset.approved /
	 * .rejected` with the correct sessionId. Without this, the per-
	 * session SSE filter (routes/events.ts) drops the decision events
	 * because their sessionId would be `undefined` while the subscriber
	 * is filtering for a concrete session. Optional only because legacy
	 * propose paths / tests don't always carry session context.
	 */
	sessionId?: string;
	createdAt: number;
	decidedAt?: number;
}
