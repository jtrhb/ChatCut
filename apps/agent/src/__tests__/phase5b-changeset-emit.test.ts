/**
 * Phase 5b Stage 1 — agent-side ghost emission contract.
 *
 * Locks down:
 *   1. ChangesetManager.propose stores proposedElements + confidence and
 *      emits `changeset.proposed` carrying both, scoped to the
 *      proposing-turn's sessionId so the per-session SSE filter
 *      (routes/events.ts) actually delivers the event.
 *   2. ChangesetManager.approve / reject emit `changeset.approved` /
 *      `.rejected` echoing the proposing-turn's sessionId.
 *   3. Backwards compatibility: a manager constructed without an
 *      EventBus (every existing test fixture) must not crash on
 *      propose/approve/reject. Tests that don't care about events
 *      shouldn't have to be updated en masse.
 *   4. Confidence is clamped to [0, 1] inside the manager (defense in
 *     depth — the route Zod gate is the primary check).
 *   5. event-protocol.serializeEvent now includes `type` in the JSON
 *      data so consumers reading via `EventSource.onmessage` can
 *      discriminate on `data.type` (the existing apps/web/src/hooks/use-chat.ts
 *      pattern). Without this, the `event:` SSE line routes the message
 *      ONLY to addEventListener and `onmessage` consumers see nothing.
 */

import { ChangeLog } from "@opencut/core";
import type { SerializedEditorState } from "@opencut/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ChangesetManager } from "../changeset/changeset-manager.js";
import { EventBus } from "../events/event-bus.js";
import { serializeEvent } from "../events/event-protocol.js";
import type { RuntimeEvent } from "../events/types.js";
import { ServerEditorCore } from "../services/server-editor-core.js";

const emptyState: SerializedEditorState = {
	project: null,
	scenes: [],
	activeSceneId: null,
};

function makeManager(opts?: { withEventBus?: boolean }) {
	const changeLog = new ChangeLog();
	const serverCore = ServerEditorCore.fromSnapshot(emptyState);
	const eventBus = opts?.withEventBus ? new EventBus() : undefined;
	const captured: RuntimeEvent[] = [];
	if (eventBus) {
		eventBus.onAll((e) => captured.push(e));
	}
	const manager = new ChangesetManager({ changeLog, serverCore, eventBus });
	return { manager, eventBus, captured, changeLog, serverCore };
}

describe("Phase 5b — ChangesetManager EventBus emission", () => {
	describe("propose()", () => {
		let env: ReturnType<typeof makeManager>;

		beforeEach(() => {
			env = makeManager({ withEventBus: true });
		});

		it("emits `changeset.proposed` when EventBus is wired", async () => {
			await env.manager.propose({
				summary: "delete intro",
				affectedElements: ["el-1"],
				sessionId: "sess-1",
			});
			const proposed = env.captured.find(
				(e) => e.type === "changeset.proposed",
			);
			expect(proposed).toBeDefined();
		});

		it("payload carries proposedElements + confidence", async () => {
			const proposedElements = [
				{ ghostId: "g1", kind: "delete" as const, targetId: "el-1" },
				{ ghostId: "g2", kind: "insert" as const, trackId: "tr-1" },
			];
			await env.manager.propose({
				summary: "edit",
				affectedElements: ["el-1"],
				proposedElements,
				confidence: 0.83,
				sessionId: "sess-x",
			});
			const proposed = env.captured.find(
				(e) => e.type === "changeset.proposed",
			);
			expect(proposed?.data.proposedElements).toEqual(proposedElements);
			expect(proposed?.data.confidence).toBeCloseTo(0.83);
		});

		it("payload echoes the proposing-turn's sessionId", async () => {
			await env.manager.propose({
				summary: "x",
				affectedElements: [],
				sessionId: "sess-abc",
			});
			const proposed = env.captured.find(
				(e) => e.type === "changeset.proposed",
			);
			expect(proposed?.sessionId).toBe("sess-abc");
		});

		it("emits with sessionId=undefined when caller omits (legacy path)", async () => {
			await env.manager.propose({
				summary: "x",
				affectedElements: [],
			});
			const proposed = env.captured.find(
				(e) => e.type === "changeset.proposed",
			);
			expect(proposed?.sessionId).toBeUndefined();
		});

		it("clamps confidence above 1 to 1", async () => {
			await env.manager.propose({
				summary: "x",
				affectedElements: [],
				confidence: 5,
				sessionId: "s",
			});
			const proposed = env.captured.find(
				(e) => e.type === "changeset.proposed",
			);
			expect(proposed?.data.confidence).toBe(1);
		});

		it("clamps confidence below 0 to 0", async () => {
			await env.manager.propose({
				summary: "x",
				affectedElements: [],
				confidence: -3,
				sessionId: "s",
			});
			const proposed = env.captured.find(
				(e) => e.type === "changeset.proposed",
			);
			expect(proposed?.data.confidence).toBe(0);
		});

		it("defaults missing confidence to 0.5", async () => {
			await env.manager.propose({
				summary: "x",
				affectedElements: [],
				sessionId: "s",
			});
			const proposed = env.captured.find(
				(e) => e.type === "changeset.proposed",
			);
			expect(proposed?.data.confidence).toBe(0.5);
		});

		it("stores proposedElements + confidence on the returned changeset", async () => {
			const proposedElements = [
				{ ghostId: "g1", kind: "update" as const, targetId: "el-2" },
			];
			const cs = await env.manager.propose({
				summary: "x",
				affectedElements: ["el-2"],
				proposedElements,
				confidence: 0.42,
				sessionId: "s",
			});
			expect(cs.proposedElements).toEqual(proposedElements);
			expect(cs.confidence).toBe(0.42);
			expect(cs.sessionId).toBe("s");
		});
	});

	describe("approve() / reject()", () => {
		it("emits `changeset.approved` echoing proposing-turn sessionId", async () => {
			const env = makeManager({ withEventBus: true });
			const cs = await env.manager.propose({
				summary: "x",
				affectedElements: [],
				userId: "u",
				projectId: "p",
				sessionId: "sess-1",
			});
			env.captured.length = 0; // clear propose emission

			await env.manager.approve(cs.changesetId, {
				userId: "u",
				projectId: "p",
			});
			const approved = env.captured.find(
				(e) => e.type === "changeset.approved",
			);
			expect(approved).toBeDefined();
			expect(approved?.sessionId).toBe("sess-1");
			expect(approved?.data.changesetId).toBe(cs.changesetId);
		});

		it("emits `changeset.rejected` echoing proposing-turn sessionId", async () => {
			const env = makeManager({ withEventBus: true });
			const cs = await env.manager.propose({
				summary: "x",
				affectedElements: [],
				userId: "u",
				projectId: "p",
				sessionId: "sess-2",
			});
			env.captured.length = 0;

			await env.manager.reject(cs.changesetId, {
				userId: "u",
				projectId: "p",
			});
			const rejected = env.captured.find(
				(e) => e.type === "changeset.rejected",
			);
			expect(rejected).toBeDefined();
			expect(rejected?.sessionId).toBe("sess-2");
		});
	});

	describe("backwards compatibility (no EventBus)", () => {
		it("propose() works without EventBus", async () => {
			const env = makeManager({ withEventBus: false });
			await expect(
				env.manager.propose({
					summary: "x",
					affectedElements: [],
					proposedElements: [{ ghostId: "g", kind: "insert" }],
					confidence: 0.7,
				}),
			).resolves.toBeDefined();
		});

		it("approve() works without EventBus", async () => {
			const env = makeManager({ withEventBus: false });
			const cs = await env.manager.propose({
				summary: "x",
				affectedElements: [],
				userId: "u",
				projectId: "p",
			});
			await expect(
				env.manager.approve(cs.changesetId, { userId: "u", projectId: "p" }),
			).resolves.toBeUndefined();
		});

		it("reject() works without EventBus", async () => {
			const env = makeManager({ withEventBus: false });
			const cs = await env.manager.propose({
				summary: "x",
				affectedElements: [],
				userId: "u",
				projectId: "p",
			});
			await expect(
				env.manager.reject(cs.changesetId, { userId: "u", projectId: "p" }),
			).resolves.toBeUndefined();
		});
	});

	describe("serializeEvent — type field included in data payload", () => {
		it("includes type in JSON data so onmessage consumers can discriminate", () => {
			const event: RuntimeEvent = {
				type: "changeset.proposed",
				timestamp: 123,
				sessionId: "s",
				data: { changesetId: "cs", confidence: 0.7 },
			};
			const sse = serializeEvent(event);
			const parsed = JSON.parse(sse.data);
			expect(parsed.type).toBe("changeset.proposed");
			expect(parsed.changesetId).toBe("cs");
			expect(parsed.confidence).toBe(0.7);
		});

		it("preserves the existing event: SSE line for addEventListener consumers", () => {
			const event: RuntimeEvent = {
				type: "changeset.approved",
				timestamp: 1,
				sessionId: "s",
				data: { changesetId: "cs" },
			};
			const sse = serializeEvent(event);
			expect(sse.event).toBe("changeset.approved");
		});

		it("data field type does NOT shadow data sub-keys named `type`", () => {
			// Defensive: if a future emit ever included `type` inside the
			// data object, we want the top-level event type to win (it's
			// the canonical identifier; sub-keys are just payload). Verify
			// the spread order (`{ type, ...data, ...rest }`) preserves
			// the canonical type.
			const event: RuntimeEvent = {
				type: "tool.called",
				timestamp: 1,
				data: { toolName: "x" },
			};
			const sse = serializeEvent(event);
			const parsed = JSON.parse(sse.data);
			expect(parsed.type).toBe("tool.called");
		});
	});
});
