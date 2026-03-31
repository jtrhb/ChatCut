import type { Command } from "../commands/base-command";
import EventEmitter from "eventemitter3";

export interface ExecuteOptions {
	source: "human" | "agent" | "system";
	agentId?: string;
	changesetId?: string;
}

export class CommandManager extends EventEmitter {
	private history: Command[] = [];
	private redoStack: Command[] = [];

	execute({ command, options }: { command: Command; options?: ExecuteOptions }): Command {
		command.execute();
		this.history.push(command);
		this.redoStack = [];
		this.emit("command:executed", { command, options: options ?? { source: "system" } });
		return command;
	}

	push({ command }: { command: Command }): void {
		this.history.push(command);
		this.redoStack = [];
	}

	undo(): void {
		if (this.history.length === 0) return;
		const command = this.history.pop();
		command?.undo();
		if (command) {
			this.redoStack.push(command);
		}
		this.emit("command:undone", { command });
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const command = this.redoStack.pop();
		command?.redo();
		if (command) {
			this.history.push(command);
		}
		this.emit("command:redone", { command });
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
