import { describe, it, expect } from "vitest";
import { ServerTracksSnapshotCommand } from "../server-tracks-snapshot";
import { EditorCore } from "../../../editor-core";
import type { TimelineTrack, TScene } from "../../../types/timeline";

function makeScene(tracks: TimelineTrack[]): TScene {
	return {
		id: "scene-1",
		name: "Scene 1",
		tracks,
		durationSec: 0,
	} as unknown as TScene;
}

describe("ServerTracksSnapshotCommand", () => {
	it("applies 'after' tracks on execute and reverts on undo", () => {
		const before: TimelineTrack[] = [
			{ id: "t1", type: "video", elements: [], name: "T1", muted: false, hidden: false } as unknown as TimelineTrack,
		];
		const after: TimelineTrack[] = [
			{ id: "t1", type: "video", elements: [], name: "T1", muted: false, hidden: false } as unknown as TimelineTrack,
			{ id: "t2", type: "audio", elements: [], name: "T2", muted: false, hidden: false } as unknown as TimelineTrack,
		];

		const core = EditorCore.deserialize({
			project: null,
			scenes: [makeScene(before)],
			activeSceneId: "scene-1",
		});

		const cmd = new ServerTracksSnapshotCommand(core, before, after);
		cmd.execute();

		expect(core.timeline.getTracks().map((t) => t.id)).toEqual(["t1", "t2"]);

		cmd.undo();

		expect(core.timeline.getTracks().map((t) => t.id)).toEqual(["t1"]);
	});

	it("does NOT read EditorCore.getInstance() — uses the injected core", () => {
		// Reset the singleton to ensure any accidental singleton read would blow up
		EditorCore.reset();

		const beforeA: TimelineTrack[] = [
			{ id: "a1", type: "video", elements: [], name: "A1", muted: false, hidden: false } as unknown as TimelineTrack,
		];
		const afterA: TimelineTrack[] = [
			{ id: "a1", type: "video", elements: [], name: "A1", muted: false, hidden: false } as unknown as TimelineTrack,
			{ id: "a2", type: "audio", elements: [], name: "A2", muted: false, hidden: false } as unknown as TimelineTrack,
		];

		const coreA = EditorCore.deserialize({
			project: null,
			scenes: [makeScene(beforeA)],
			activeSceneId: "scene-1",
		});

		// coreA is deliberately not the singleton — EditorCore.getInstance() would
		// lazily create a different instance. If the command uses the singleton,
		// coreA.timeline.getTracks() will not reflect the mutation.
		const cmd = new ServerTracksSnapshotCommand(coreA, beforeA, afterA);
		cmd.execute();

		expect(coreA.timeline.getTracks().map((t) => t.id)).toEqual(["a1", "a2"]);
	});

	it("is safe to undo even if 'after' and 'before' are the same reference", () => {
		const tracks: TimelineTrack[] = [
			{ id: "t1", type: "video", elements: [], name: "T1", muted: false, hidden: false } as unknown as TimelineTrack,
		];
		const core = EditorCore.deserialize({
			project: null,
			scenes: [makeScene(tracks)],
			activeSceneId: "scene-1",
		});

		const cmd = new ServerTracksSnapshotCommand(core, tracks, tracks);
		cmd.execute();
		cmd.undo();

		expect(core.timeline.getTracks()).toEqual(tracks);
	});
});
