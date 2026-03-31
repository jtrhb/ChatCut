import { Command } from "../base-command";
import type { TimelineTrack } from "../../types/timeline";
import { EditorCore } from "../../editor-core";

export class TracksSnapshotCommand extends Command {
	constructor(
		private before: TimelineTrack[],
		private after: TimelineTrack[],
	) {
		super();
	}

	execute(): void {
		EditorCore.getInstance().timeline.updateTracks(this.after);
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}
