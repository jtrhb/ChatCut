/**
 * Phase 5b Stage 1: ghost state machine unit tests.
 *
 * Why exhaustive: the React rendering layer is going to fold SSE events
 * through `transition` / `applyChangesetDecision` on every changeset
 * push. Any edge-case bug here flickers the timeline UI and ships
 * confusing "did the change apply or not?" UX. The cost of running
 * 30 fast pure-function tests is trivial; the cost of debugging a
 * client-only race condition in production is not.
 */

import { describe, expect, it } from "vitest";
import {
	applyChangesetDecision,
	createGhost,
	type GhostRecord,
	type GhostState,
	isActive,
	isTerminal,
	propagateStale,
	transition,
} from "../ghost/ghost-state";

function makeGhost(overrides: Partial<GhostRecord> = {}): GhostRecord {
	return {
		ghostId: "g-1",
		state: "proposed",
		kind: "insert",
		changesetId: "cs-1",
		dependsOn: [],
		confidence: 0.8,
		proposedAt: 1_000,
		...overrides,
	};
}

describe("Phase 5b — ghost state machine", () => {
	describe("createGhost()", () => {
		it("starts in `proposed` state", () => {
			const g = createGhost({
				ghostId: "g",
				changesetId: "cs",
				kind: "insert",
				confidence: 0.7,
			});
			expect(g.state).toBe("proposed");
			expect(g.dependsOn).toEqual([]);
		});

		it("clamps confidence below 0 to 0", () => {
			const g = createGhost({
				ghostId: "g",
				changesetId: "cs",
				kind: "insert",
				confidence: -0.5,
			});
			expect(g.confidence).toBe(0);
		});

		it("clamps confidence above 1 to 1", () => {
			const g = createGhost({
				ghostId: "g",
				changesetId: "cs",
				kind: "insert",
				confidence: 1.5,
			});
			expect(g.confidence).toBe(1);
		});

		it("substitutes 0.5 for NaN confidence", () => {
			const g = createGhost({
				ghostId: "g",
				changesetId: "cs",
				kind: "insert",
				confidence: Number.NaN,
			});
			expect(g.confidence).toBe(0.5);
		});

		it("uses provided proposedAt when set, otherwise Date.now()", () => {
			const g = createGhost({
				ghostId: "g",
				changesetId: "cs",
				kind: "insert",
				confidence: 0.5,
				proposedAt: 12345,
			});
			expect(g.proposedAt).toBe(12345);

			const before = Date.now();
			const g2 = createGhost({
				ghostId: "g",
				changesetId: "cs",
				kind: "insert",
				confidence: 0.5,
			});
			const after = Date.now();
			expect(g2.proposedAt).toBeGreaterThanOrEqual(before);
			expect(g2.proposedAt).toBeLessThanOrEqual(after);
		});
	});

	describe("transition() — happy path", () => {
		it("proposed → previewing", () => {
			const r = transition(makeGhost({ state: "proposed" }), "previewing");
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.record.state).toBe("previewing");
		});

		it("previewing → accepted", () => {
			const r = transition(makeGhost({ state: "previewing" }), "accepted");
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.record.state).toBe("accepted");
		});

		it("accepted → committed", () => {
			const r = transition(makeGhost({ state: "accepted" }), "committed");
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.record.state).toBe("committed");
		});

		it("returns a fresh object (does not mutate input)", () => {
			const before = makeGhost({ state: "proposed" });
			const r = transition(before, "previewing");
			expect(before.state).toBe("proposed");
			if (r.ok) expect(r.record).not.toBe(before);
		});

		it("self-transition is a no-op success", () => {
			const r = transition(makeGhost({ state: "proposed" }), "proposed");
			expect(r.ok).toBe(true);
		});
	});

	describe("transition() — illegal moves", () => {
		const cases: Array<[GhostState, GhostState]> = [
			["proposed", "accepted"],
			["proposed", "committed"],
			["previewing", "proposed"],
			["previewing", "committed"],
			["accepted", "proposed"],
			["accepted", "previewing"],
			["committed", "proposed"],
			["committed", "previewing"],
			["committed", "accepted"],
			["committed", "invalidated"],
			["invalidated", "proposed"],
			["invalidated", "previewing"],
			["invalidated", "accepted"],
			["invalidated", "committed"],
			["stale", "proposed"],
			["stale", "previewing"],
			["stale", "accepted"],
			["stale", "committed"],
		];
		for (const [from, to] of cases) {
			it(`rejects ${from} → ${to}`, () => {
				const r = transition(makeGhost({ state: from }), to);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.reason).toMatch(/Illegal transition/);
			});
		}
	});

	describe("transition() — off-path branches", () => {
		it("proposed → invalidated", () => {
			const r = transition(makeGhost({ state: "proposed" }), "invalidated");
			expect(r.ok).toBe(true);
		});

		it("previewing → invalidated", () => {
			const r = transition(makeGhost({ state: "previewing" }), "invalidated");
			expect(r.ok).toBe(true);
		});

		it("proposed → stale", () => {
			const r = transition(makeGhost({ state: "proposed" }), "stale");
			expect(r.ok).toBe(true);
		});

		it("accepted → stale (e.g. dependent's source got invalidated mid-flight)", () => {
			const r = transition(makeGhost({ state: "accepted" }), "stale");
			expect(r.ok).toBe(true);
		});
	});

	describe("isActive() / isTerminal()", () => {
		it("active = proposed | previewing | accepted", () => {
			expect(isActive(makeGhost({ state: "proposed" }))).toBe(true);
			expect(isActive(makeGhost({ state: "previewing" }))).toBe(true);
			expect(isActive(makeGhost({ state: "accepted" }))).toBe(true);
			expect(isActive(makeGhost({ state: "committed" }))).toBe(false);
			expect(isActive(makeGhost({ state: "invalidated" }))).toBe(false);
			expect(isActive(makeGhost({ state: "stale" }))).toBe(false);
		});

		it("terminal = committed | invalidated | stale", () => {
			expect(isTerminal(makeGhost({ state: "committed" }))).toBe(true);
			expect(isTerminal(makeGhost({ state: "invalidated" }))).toBe(true);
			expect(isTerminal(makeGhost({ state: "stale" }))).toBe(true);
			expect(isTerminal(makeGhost({ state: "proposed" }))).toBe(false);
			expect(isTerminal(makeGhost({ state: "previewing" }))).toBe(false);
			expect(isTerminal(makeGhost({ state: "accepted" }))).toBe(false);
		});
	});

	describe("propagateStale()", () => {
		it("turns dependents of an invalidated ghost into stale", () => {
			const ghosts = new Map<string, GhostRecord>([
				["A", makeGhost({ ghostId: "A", state: "invalidated" })],
				[
					"B",
					makeGhost({ ghostId: "B", state: "previewing", dependsOn: ["A"] }),
				],
			]);
			const next = propagateStale(ghosts);
			expect(next.get("B")?.state).toBe("stale");
		});

		it("propagates transitively (B depends on A; C depends on B)", () => {
			const ghosts = new Map<string, GhostRecord>([
				["A", makeGhost({ ghostId: "A", state: "invalidated" })],
				["B", makeGhost({ ghostId: "B", state: "proposed", dependsOn: ["A"] })],
				["C", makeGhost({ ghostId: "C", state: "proposed", dependsOn: ["B"] })],
			]);
			const next = propagateStale(ghosts);
			expect(next.get("B")?.state).toBe("stale");
			expect(next.get("C")?.state).toBe("stale");
		});

		it("does NOT mark dependents of a committed ghost as stale (success cascade is not death)", () => {
			const ghosts = new Map<string, GhostRecord>([
				["A", makeGhost({ ghostId: "A", state: "committed" })],
				["B", makeGhost({ ghostId: "B", state: "proposed", dependsOn: ["A"] })],
			]);
			const next = propagateStale(ghosts);
			expect(next.get("B")?.state).toBe("proposed");
		});

		it("ignores unknown dependencies (don't kill ghosts referencing IDs we never received)", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"B",
					makeGhost({
						ghostId: "B",
						state: "proposed",
						dependsOn: ["nonexistent"],
					}),
				],
			]);
			const next = propagateStale(ghosts);
			expect(next.get("B")?.state).toBe("proposed");
		});

		it("does not mutate the input map", () => {
			const ghosts = new Map<string, GhostRecord>([
				["A", makeGhost({ ghostId: "A", state: "invalidated" })],
				["B", makeGhost({ ghostId: "B", state: "proposed", dependsOn: ["A"] })],
			]);
			propagateStale(ghosts);
			expect(ghosts.get("B")?.state).toBe("proposed");
		});

		it("returns a fresh map even when nothing changes", () => {
			const ghosts = new Map<string, GhostRecord>([
				["A", makeGhost({ ghostId: "A", state: "proposed" })],
			]);
			const next = propagateStale(ghosts);
			expect(next).not.toBe(ghosts);
			expect(next.get("A")?.state).toBe("proposed");
		});

		it("skips terminal ghosts so re-running the pass is idempotent", () => {
			const ghosts = new Map<string, GhostRecord>([
				["A", makeGhost({ ghostId: "A", state: "invalidated" })],
				["B", makeGhost({ ghostId: "B", state: "stale", dependsOn: ["A"] })],
			]);
			const next1 = propagateStale(ghosts);
			const next2 = propagateStale(next1);
			expect(next2.get("B")?.state).toBe("stale");
		});
	});

	describe("applyChangesetDecision()", () => {
		it("approve transitions matching ghosts to accepted", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"A",
					makeGhost({
						ghostId: "A",
						state: "previewing",
						changesetId: "cs-1",
					}),
				],
				[
					"B",
					makeGhost({
						ghostId: "B",
						state: "proposed",
						changesetId: "cs-other",
					}),
				],
			]);
			const next = applyChangesetDecision(ghosts, "cs-1", "approve");
			// Note: proposed → accepted is illegal; only previewing → accepted is allowed.
			// "A" was previewing so it should accept; the other-changeset ghost is untouched.
			expect(next.get("A")?.state).toBe("accepted");
			expect(next.get("B")?.state).toBe("proposed");
		});

		it("approve preserves a ghost that's already accepted (re-delivery safe)", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"A",
					makeGhost({
						ghostId: "A",
						state: "accepted",
						changesetId: "cs-1",
					}),
				],
			]);
			const next = applyChangesetDecision(ghosts, "cs-1", "approve");
			expect(next.get("A")?.state).toBe("accepted");
		});

		it("commit moves accepted ghosts to committed", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"A",
					makeGhost({
						ghostId: "A",
						state: "accepted",
						changesetId: "cs-1",
					}),
				],
			]);
			const next = applyChangesetDecision(ghosts, "cs-1", "commit");
			expect(next.get("A")?.state).toBe("committed");
		});

		it("reject invalidates AND propagates stale to dependents", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"A",
					makeGhost({
						ghostId: "A",
						state: "previewing",
						changesetId: "cs-bad",
					}),
				],
				[
					"B",
					makeGhost({
						ghostId: "B",
						state: "proposed",
						changesetId: "cs-other",
						dependsOn: ["A"],
					}),
				],
			]);
			const next = applyChangesetDecision(ghosts, "cs-bad", "reject");
			expect(next.get("A")?.state).toBe("invalidated");
			expect(next.get("B")?.state).toBe("stale");
		});

		it("reject ALSO invalidates ghosts still in `proposed`", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"A",
					makeGhost({
						ghostId: "A",
						state: "proposed",
						changesetId: "cs-1",
					}),
				],
			]);
			const next = applyChangesetDecision(ghosts, "cs-1", "reject");
			expect(next.get("A")?.state).toBe("invalidated");
		});

		it("does not touch ghosts belonging to other changesets", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"A",
					makeGhost({
						ghostId: "A",
						state: "previewing",
						changesetId: "cs-1",
					}),
				],
				[
					"B",
					makeGhost({
						ghostId: "B",
						state: "previewing",
						changesetId: "cs-2",
					}),
				],
			]);
			const next = applyChangesetDecision(ghosts, "cs-1", "approve");
			expect(next.get("B")?.state).toBe("previewing");
		});

		it("returns a fresh map (immutability discipline)", () => {
			const ghosts = new Map<string, GhostRecord>([
				[
					"A",
					makeGhost({
						ghostId: "A",
						state: "proposed",
						changesetId: "cs-1",
					}),
				],
			]);
			const next = applyChangesetDecision(ghosts, "cs-1", "reject");
			expect(next).not.toBe(ghosts);
			expect(ghosts.get("A")?.state).toBe("proposed");
		});
	});
});
