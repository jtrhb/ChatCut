import type { EditorCore } from "../editor-core";
import type { TProject, TProjectSettings } from "../types/project";
import { UpdateProjectSettingsCommand } from "../commands/project";

/**
 * Server-safe ProjectManager — minimal subset for core.
 * The full ProjectManager in apps/web adds browser-specific features
 * (canvas thumbnails, toast notifications, storage service, migrations).
 */
export class ProjectManager {
	private activeProject: TProject | null = null;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	getActive(): TProject | null {
		return this.activeProject;
	}

	setActiveProject({ project }: { project: TProject }): void {
		this.activeProject = project;
		this.notify();
	}

	updateSettings({
		settings,
		pushHistory = true,
	}: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
	}): void {
		if (pushHistory) {
			const command = new UpdateProjectSettingsCommand(settings);
			this.editor.command.execute({ command });
		} else {
			if (!this.activeProject) return;
			this.activeProject = {
				...this.activeProject,
				settings: { ...this.activeProject.settings, ...settings },
				metadata: { ...this.activeProject.metadata, updatedAt: new Date() },
			};
			this.notify();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => fn());
	}
}
