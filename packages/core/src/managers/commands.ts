import type { Command } from "../commands/base-command";
import EventEmitter from "eventemitter3";

export interface ExecuteOptions {
	source: "human" | "agent" | "system";
	agentId?: string;
	changesetId?: string;
	taskId?: string;
}

interface HistoryEntry {
	command: Command;
	options?: ExecuteOptions;
}

export class CommandManager extends EventEmitter {
	private history: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];

	execute({ command, options }: { command: Command; options?: ExecuteOptions }): Command {
		command.execute();
		this.history.push({ command, options });
		this.redoStack = [];
		this.emit("command:executed", { command, options: options ?? { source: "system" } });
		return command;
	}

	push({ command, options }: { command: Command; options?: ExecuteOptions }): void {
		this.history.push({ command, options });
		this.redoStack = [];
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			this.redoStack.push(entry);
		}
		this.emit("command:undone", { command: entry?.command });
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		entry?.command.redo();
		if (entry) {
			this.history.push(entry);
		}
		this.emit("command:redone", { command: entry?.command });
	}

	/**
	 * Undo every history entry tagged with the given taskId, in reverse
	 * history order. Used for sub-agent dispatch rollback on error: the
	 * Master mints a taskId per dispatch, all commands issued by that
	 * dispatch are tagged with it, and on failure the Master asks to undo
	 * them as a unit. Entries are NOT pushed onto the redo stack — this
	 * is error recovery, not a user undo.
	 *
	 * Individual undo() failures are isolated: if one command's undo
	 * throws, the other matching commands are still undone, the failing
	 * entry is still removed from history (leaving it there would break
	 * future redos / rollbacks), and the error is emitted via
	 * `command:rollback-error` so observers can surface it. The return
	 * count reflects how many commands undone without throwing; the
	 * `rollback` event is still emitted whenever the sweep touched any
	 * matching entries, with the full attempted count.
	 */
	undoByTaskId(taskId: string): number {
		let undone = 0;
		let attempted = 0;
		const errors: unknown[] = [];
		for (let i = this.history.length - 1; i >= 0; i--) {
			const entry = this.history[i];
			if (entry.options?.taskId === taskId) {
				attempted++;
				try {
					entry.command.undo();
					undone++;
				} catch (err) {
					errors.push(err);
				}
				this.history.splice(i, 1);
			}
		}
		if (attempted > 0) {
			this.emit("command:rollback", { taskId, count: attempted, undone });
			if (errors.length > 0) {
				this.emit("command:rollback-error", { taskId, errors });
			}
		}
		return undone;
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
	}
}
