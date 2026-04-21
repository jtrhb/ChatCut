/**
 * Phase 5b: ghost preview state machine.
 *
 * The agent emits proposed timeline diffs ahead of human approval. The
 * web client renders each one as a "ghost" element so the user can see
 * the proposed change before committing. This module owns the pure-TS
 * state machine that ghosts move through; the React layer (apps/web)
 * holds the resulting Map and renders styling off `state` + `confidence`.
 *
 * State diagram:
 *
 *   proposed ──preview──▶ previewing ──approve──▶ accepted ──commit──▶ committed
 *      │                       │
 *      │                       │
 *      ├────reject────────┐    ├────reject──┐
 *      │                  │    │            │
 *      ▼                  ▼    ▼            ▼
 *   invalidated      invalidated         invalidated
 *
 * Off-path: any ghost may transition to `stale` when an upstream ghost
 * (one named in `dependsOn`) reaches `invalidated` or `stale`. Stale is
 * terminal; a stale ghost never moves back into the active path.
 *
 * Why a state machine and not a flag? Real edit sessions can have
 * dozens of in-flight ghosts, and human approval may interleave with
 * fresh agent proposals. Without explicit transition guards the React
 * layer would race-update ghost styling and produce jarring UI flicker
 * (a ghost briefly returning to `proposed` after acceptance, etc.).
 * Keeping the rules here, fully covered by unit tests, lets the React
 * layer stay a pure projection of state.
 */

export type GhostState =
	| "proposed"
	| "previewing"
	| "accepted"
	| "committed"
	| "invalidated"
	| "stale";

/**
 * One ghost in the live preview map. Mirrors the agent-emitted
 * `ProposedElement` shape (see `apps/agent/src/changeset/changeset-types.ts`)
 * with the addition of `state` (transition machine) and `confidence`
 * (LLM self-reported, drives border styling).
 *
 * `payload` is `unknown` so the consumer can plug in the actual
 * TimelineElement type at the use-site without forcing this shared
 * package to depend on the editor type tree.
 */
export interface GhostRecord {
	ghostId: string;
	state: GhostState;
	kind: "insert" | "update" | "delete";
	changesetId: string;
	/** Element this ghost mutates (absent for `insert`). */
	targetId?: string;
	trackId?: string;
	payload?: unknown;
	/** Other ghostIds that this ghost depends on for staleness propagation. */
	dependsOn: string[];
	/** LLM self-reported confidence ∈ [0, 1]. */
	confidence: number;
	/** Wall-clock when this ghost first entered `proposed`. */
	proposedAt: number;
}

/**
 * Allowed forward transitions. `proposed → invalidated` and `proposed →
 * stale` are reachable via the off-path branches; explicit allow-list
 * keeps the table easy to scan.
 */
const ALLOWED_TRANSITIONS: Record<GhostState, ReadonlySet<GhostState>> = {
	proposed: new Set<GhostState>(["previewing", "invalidated", "stale"]),
	previewing: new Set<GhostState>(["accepted", "invalidated", "stale"]),
	accepted: new Set<GhostState>(["committed", "stale"]),
	// Terminal states — no outgoing transitions. Listed explicitly so the
	// type system catches the day someone adds a new state and forgets to
	// declare its outgoing edges.
	committed: new Set<GhostState>(),
	invalidated: new Set<GhostState>(),
	stale: new Set<GhostState>(),
};

export type TransitionResult =
	| { ok: true; record: GhostRecord }
	| { ok: false; reason: string };

/**
 * Single-step state transition. Validates the move against the
 * transition table and returns a fresh record (immutability discipline:
 * never mutate the input — React relies on referential changes for
 * re-render). Returns `{ ok: false }` on illegal moves so callers can
 * surface a clear reason rather than throwing into render code.
 */
export function transition(
	record: GhostRecord,
	next: GhostState,
): TransitionResult {
	if (record.state === next) {
		// No-op transitions are explicitly OK so reducers can fold the
		// same SSE event twice without spurious errors. We still return a
		// fresh object so callers don't have to special-case identity.
		return { ok: true, record: { ...record } };
	}
	const allowed = ALLOWED_TRANSITIONS[record.state];
	if (!allowed.has(next)) {
		return {
			ok: false,
			reason: `Illegal transition: ${record.state} → ${next} (allowed: ${[...allowed].join(", ") || "<terminal>"})`,
		};
	}
	return { ok: true, record: { ...record, state: next } };
}

/**
 * A ghost is "active" when it can still affect the timeline (proposed,
 * previewing, accepted). Committed/invalidated/stale are terminal from
 * the user's perspective even though committed represents a successful
 * outcome (the change is now part of the timeline; the ghost overlay
 * disappears).
 */
export function isActive(record: GhostRecord): boolean {
	return (
		record.state === "proposed" ||
		record.state === "previewing" ||
		record.state === "accepted"
	);
}

/**
 * Terminal: no further transitions are possible.
 */
export function isTerminal(record: GhostRecord): boolean {
	return ALLOWED_TRANSITIONS[record.state].size === 0;
}

/**
 * Cascade staleness through a ghost map: when any ghost is invalidated
 * or stale, every direct AND transitive dependent that's still active
 * moves to `stale`. Returns a new map; original is untouched.
 *
 * Algorithm: repeated scan until a fixed point — small ghost counts
 * (the realistic v1 ceiling is ~50 in-flight ghosts) make this cheaper
 * than building an explicit reverse-dependency graph and far easier to
 * reason about. If we ever need to scale past hundreds of ghosts this
 * is the obvious place to swap in a memoized reverse-dep cache.
 */
export function propagateStale(
	ghosts: ReadonlyMap<string, GhostRecord>,
): Map<string, GhostRecord> {
	const next = new Map<string, GhostRecord>();
	for (const [id, g] of ghosts) next.set(id, { ...g });

	let changed = true;
	while (changed) {
		changed = false;
		for (const [id, g] of next) {
			if (!isActive(g)) continue;
			if (g.dependsOn.length === 0) continue;
			// Stale if ANY dependency is in a non-active terminal state
			// EXCEPT `committed` — a committed dependency is a successful
			// outcome, not a reason to invalidate downstream work.
			const hasDeadDep = g.dependsOn.some((depId) => {
				const dep = next.get(depId);
				if (!dep) return false; // unknown dep doesn't kill the ghost
				return dep.state === "invalidated" || dep.state === "stale";
			});
			if (hasDeadDep) {
				next.set(id, { ...g, state: "stale" });
				changed = true;
			}
		}
	}
	return next;
}

/**
 * Construct a fresh ghost in `proposed` state from an agent-emitted
 * proposal entry. Centralized so React-side reducers don't drift from
 * the canonical initial-state shape.
 */
export interface NewGhostInput {
	ghostId: string;
	changesetId: string;
	kind: "insert" | "update" | "delete";
	targetId?: string;
	trackId?: string;
	payload?: unknown;
	dependsOn?: string[];
	confidence: number;
	proposedAt?: number;
}

export function createGhost(input: NewGhostInput): GhostRecord {
	return {
		ghostId: input.ghostId,
		state: "proposed",
		changesetId: input.changesetId,
		kind: input.kind,
		targetId: input.targetId,
		trackId: input.trackId,
		payload: input.payload,
		dependsOn: input.dependsOn ?? [],
		confidence: clampConfidence(input.confidence),
		proposedAt: input.proposedAt ?? Date.now(),
	};
}

function clampConfidence(value: number): number {
	if (Number.isNaN(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

/**
 * Bulk transition for a changeset-level decision. When the user
 * approves/rejects an entire changeset, every ghost belonging to that
 * changeset moves in lockstep — `proposed/previewing → accepted` on
 * approve, then a separate `accepted → committed` after the timeline
 * actually persists; or `proposed/previewing → invalidated` on reject.
 *
 * Returns a new map; never mutates input. Skips ghosts already in
 * terminal states so a re-delivered SSE event doesn't error.
 */
export function applyChangesetDecision(
	ghosts: ReadonlyMap<string, GhostRecord>,
	changesetId: string,
	decision: "approve" | "commit" | "reject",
): Map<string, GhostRecord> {
	const next = new Map<string, GhostRecord>();
	for (const [id, g] of ghosts) {
		if (g.changesetId !== changesetId) {
			next.set(id, g);
			continue;
		}
		let target: GhostState;
		if (decision === "approve") target = "accepted";
		else if (decision === "commit") target = "committed";
		else target = "invalidated";

		const result = transition(g, target);
		if (result.ok) {
			next.set(id, result.record);
		} else {
			// Already-terminal ghosts can't transition further — preserve
			// them as-is rather than dropping (callers may want to render
			// historical ghosts faded).
			next.set(id, g);
		}
	}
	// Reject cascades stale propagation; approve / commit don't.
	return decision === "reject" ? propagateStale(next) : next;
}
