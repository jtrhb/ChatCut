import EventEmitter from "eventemitter3";
import { CommandManager, type ExecuteOptions } from "./managers/commands";
import { TimelineManager } from "./managers/timeline-manager";
import { ScenesManager } from "./managers/scenes-manager";
import { SelectionManager } from "./managers/selection-manager";
import { ProjectManager } from "./managers/project-manager";
import { ChangeLog } from "./change-log";
import type { Command } from "./commands/base-command";
import type { TProject } from "./types/project";

/**
 * Server-compatible EditorCore — shared between apps/web and apps/agent.
 *
 * Contains only managers that have no browser dependencies:
 * - CommandManager (undo/redo history with source tracking)
 * - TimelineManager (track/element operations)
 * - ScenesManager (scene CRUD, bookmarks)
 * - SelectionManager (element/keyframe selection state)
 * - ProjectManager (project state, settings)
 *
 * Browser-specific managers (Playback, Renderer, Audio, Media, Save)
 * are added by the apps/web EditorCore which wraps this core.
 */
export class EditorCore extends EventEmitter {
	private static instance: EditorCore | null = null;

	public readonly command: CommandManager;
	public readonly timeline: TimelineManager;
	public readonly scenes: ScenesManager;
	public readonly selection: SelectionManager;
	public readonly project: ProjectManager;
	public readonly changeLog: ChangeLog;

	constructor() {
		super();
		this.command = new CommandManager();
		this.timeline = new TimelineManager(this);
		this.scenes = new ScenesManager(this);
		this.selection = new SelectionManager(this);
		this.project = new ProjectManager(this);
		this.changeLog = new ChangeLog();
	}

	static getInstance(): EditorCore {
		if (!EditorCore.instance) {
			EditorCore.instance = new EditorCore();
		}
		return EditorCore.instance;
	}

	static reset(): void {
		EditorCore.instance = null;
	}

	/**
	 * Execute a command with source tracking metadata.
	 */
	executeCommand(command: Command, options?: ExecuteOptions): Command {
		return this.command.execute({ command, options });
	}

	/**
	 * Convenience method for agent-originated commands.
	 */
	executeAgentCommand(command: Command, agentId: string): Command {
		return this.command.execute({
			command,
			options: { source: "agent", agentId },
		});
	}

	/**
	 * Serialize the current editor state for persistence.
	 */
	serialize(): SerializedEditorState {
		return {
			project: this.project.getActive(),
			scenes: this.scenes.getScenes(),
			activeSceneId: (() => {
				try {
					return this.scenes.getActiveScene()?.id ?? null;
				} catch {
					return null;
				}
			})(),
		};
	}

	/**
	 * Restore editor state from a serialized snapshot.
	 */
	static deserialize(state: SerializedEditorState): EditorCore {
		const editor = new EditorCore();

		if (state.project) {
			editor.project.setActiveProject({ project: state.project });
		}

		if (state.scenes && state.scenes.length > 0) {
			editor.scenes.initializeScenes({
				scenes: state.scenes,
				currentSceneId: state.activeSceneId ?? undefined,
			});
		}

		return editor;
	}
}

export interface SerializedEditorState {
	project: TProject | null;
	scenes: import("./types/timeline").TScene[];
	activeSceneId: string | null;
}
