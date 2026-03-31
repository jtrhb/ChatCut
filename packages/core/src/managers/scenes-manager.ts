import type { EditorCore } from "../editor-core";
import type { TimelineTrack, TScene } from "../types/timeline";
import {
	getMainScene,
	ensureMainScene,
	canDeleteScene,
	findCurrentScene,
} from "../utils/scenes";
import {
	getBookmarkAtTime,
	getFrameTime,
	isBookmarkAtTime,
} from "../utils/bookmarks";
import { ensureMainTrack } from "../utils/track-utils";
import {
	CreateSceneCommand,
	DeleteSceneCommand,
	MoveBookmarkCommand,
	RemoveBookmarkCommand,
	RenameSceneCommand,
	ToggleBookmarkCommand,
	UpdateBookmarkCommand,
} from "../commands/scene";

export class ScenesManager {
	private active: TScene | null = null;
	private list: TScene[] = [];
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	createScene({
		name,
		isMain = false,
	}: {
		name: string;
		isMain?: boolean;
	}): string {
		const command = new CreateSceneCommand(name, isMain);
		this.editor.command.execute({ command });
		return command.getSceneId();
	}

	deleteScene({ sceneId }: { sceneId: string }): void {
		const sceneToDelete = this.list.find((s) => s.id === sceneId);

		if (!sceneToDelete) {
			throw new Error("Scene not found");
		}

		const { canDelete, reason } = canDeleteScene({ scene: sceneToDelete });
		if (!canDelete) {
			throw new Error(reason);
		}

		const command = new DeleteSceneCommand(sceneId);
		this.editor.command.execute({ command });
	}

	renameScene({
		sceneId,
		name,
	}: {
		sceneId: string;
		name: string;
	}): void {
		const command = new RenameSceneCommand(sceneId, name);
		this.editor.command.execute({ command });
	}

	switchToScene({ sceneId }: { sceneId: string }): void {
		const targetScene = this.list.find((s) => s.id === sceneId);

		if (!targetScene) {
			throw new Error("Scene not found");
		}

		const activeProject = this.editor.project.getActive();

		if (activeProject) {
			const updatedProject = {
				...activeProject,
				currentSceneId: sceneId,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};

			this.editor.project.setActiveProject({ project: updatedProject });
		}

		this.active = targetScene;
		this.notify();
	}

	toggleBookmark({ time }: { time: number }): void {
		const command = new ToggleBookmarkCommand(time);
		this.editor.command.execute({ command });
	}

	isBookmarked({ time }: { time: number }): boolean {
		const activeScene = this.getActiveScene();
		const activeProject = this.editor.project.getActive();

		if (!activeScene || !this.active || !activeProject) return false;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return isBookmarkAtTime({ bookmarks: activeScene.bookmarks, frameTime });
	}

	removeBookmark({ time }: { time: number }): void {
		const command = new RemoveBookmarkCommand(time);
		this.editor.command.execute({ command });
	}

	updateBookmark({
		time,
		updates,
	}: {
		time: number;
		updates: Partial<{ note: string; color: string; duration: number }>;
	}): void {
		const command = new UpdateBookmarkCommand(time, updates);
		this.editor.command.execute({ command });
	}

	moveBookmark({
		fromTime,
		toTime,
	}: {
		fromTime: number;
		toTime: number;
	}): void {
		const command = new MoveBookmarkCommand(fromTime, toTime);
		this.editor.command.execute({ command });
	}

	getBookmarkAtTime({ time }: { time: number }) {
		const activeScene = this.active;
		const activeProject = this.editor.project.getActive();

		if (!activeScene || !activeProject) return null;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return getBookmarkAtTime({
			bookmarks: activeScene.bookmarks,
			frameTime,
		});
	}

	initializeScenes({
		scenes,
		currentSceneId,
	}: {
		scenes: TScene[];
		currentSceneId?: string;
	}): void {
		const ensuredScenes = ensureMainScene({ scenes });
		const { scenes: scenesWithMainTracks } =
			this.ensureScenesHaveMainTrack({ scenes: ensuredScenes });
		const currentScene = currentSceneId
			? scenesWithMainTracks.find((s) => s.id === currentSceneId)
			: null;

		const fallbackScene = getMainScene({ scenes: scenesWithMainTracks });

		this.list = scenesWithMainTracks;
		this.active = currentScene || fallbackScene;
		this.notify();
	}

	clearScenes(): void {
		this.list = [];
		this.active = null;
		this.notify();
	}

	getActiveScene(): TScene {
		if (!this.active) {
			throw new Error("No active scene.");
		}
		return this.active;
	}

	getScenes(): TScene[] {
		return this.list;
	}

	setScenes({
		scenes,
		activeSceneId,
	}: {
		scenes: TScene[];
		activeSceneId?: string;
	}): void {
		this.list = scenes;
		const nextActiveSceneId = activeSceneId ?? this.active?.id ?? null;
		this.active = nextActiveSceneId
			? (scenes.find((scene) => scene.id === nextActiveSceneId) ?? null)
			: null;
		this.notify();

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				scenes,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => fn());
	}

	updateSceneTracks({ tracks }: { tracks: TimelineTrack[] }): void {
		if (!this.active) return;

		const updatedScene: TScene = {
			...this.active,
			tracks,
			updatedAt: new Date(),
		};

		this.list = this.list.map((s) =>
			s.id === this.active?.id ? updatedScene : s,
		);
		this.active = updatedScene;
		this.notify();

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				scenes: this.list,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
	}

	private ensureScenesHaveMainTrack({ scenes }: { scenes: TScene[] }): {
		scenes: TScene[];
		hasAddedMainTrack: boolean;
	} {
		let hasAddedMainTrack = false;
		const ensuredScenes: TScene[] = [];

		for (const scene of scenes) {
			const existingTracks = scene.tracks ?? [];
			const updatedTracks = ensureMainTrack({ tracks: existingTracks });
			if (updatedTracks !== existingTracks) {
				hasAddedMainTrack = true;
				ensuredScenes.push({
					...scene,
					tracks: updatedTracks,
					updatedAt: new Date(),
				});
			} else {
				ensuredScenes.push(scene);
			}
		}

		return { scenes: ensuredScenes, hasAddedMainTrack };
	}
}
