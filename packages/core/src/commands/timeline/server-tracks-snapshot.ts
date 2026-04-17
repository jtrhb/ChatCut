import { Command } from "../base-command";
import type { TimelineTrack } from "../../types/timeline";
import type { EditorCore } from "../../editor-core";

/**
 * Server-safe counterpart to TracksSnapshotCommand.
 *
 * The existing TracksSnapshotCommand reads from EditorCore.getInstance(),
 * which is a process-wide singleton set up for the browser. The server-side
 * agent holds its own EditorCore instance per request via ServerEditorCore,
 * so we need a command that takes an explicit EditorCore reference rather
 * than reaching for the global.
 *
 * Enables agent tools to route mutations through CommandManager and
 * participate in taskId-scoped rollback.
 */
export class ServerTracksSnapshotCommand extends Command {
	constructor(
		private readonly core: EditorCore,
		private readonly before: TimelineTrack[],
		private readonly after: TimelineTrack[],
	) {
		super();
	}

	execute(): void {
		this.core.timeline.updateTracks(this.after);
	}

	undo(): void {
		this.core.timeline.updateTracks(this.before);
	}
}
