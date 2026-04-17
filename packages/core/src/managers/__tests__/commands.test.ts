import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandManager } from "../commands";
import { Command } from "../../commands/base-command";

class RecordingCommand extends Command {
	public executed = 0;
	public undone = 0;
	constructor(public readonly label: string) {
		super();
	}
	execute(): void {
		this.executed++;
	}
	undo(): void {
		this.undone++;
	}
}

describe("CommandManager", () => {
	let mgr: CommandManager;

	beforeEach(() => {
		mgr = new CommandManager();
	});

	it("executes a command and stores options in history", () => {
		const cmd = new RecordingCommand("a");
		mgr.execute({ command: cmd, options: { source: "agent", agentId: "editor", taskId: "t1" } });

		expect(cmd.executed).toBe(1);
		expect(mgr.canUndo()).toBe(true);
	});

	it("emits command:executed with the original options", () => {
		const listener = vi.fn();
		mgr.on("command:executed", listener);

		const cmd = new RecordingCommand("a");
		const opts = { source: "agent" as const, agentId: "editor", taskId: "t1" };
		mgr.execute({ command: cmd, options: opts });

		expect(listener).toHaveBeenCalledWith({ command: cmd, options: opts });
	});

	describe("undoByTaskId (B3)", () => {
		it("undoes every command tagged with the taskId, in reverse order", () => {
			const c1 = new RecordingCommand("c1");
			const c2 = new RecordingCommand("c2");
			const c3 = new RecordingCommand("c3");

			mgr.execute({ command: c1, options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.execute({ command: c2, options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.execute({ command: c3, options: { source: "agent", agentId: "editor", taskId: "T" } });

			const undoOrder: string[] = [];
			for (const c of [c1, c2, c3]) {
				const originalUndo = c.undo.bind(c);
				c.undo = () => {
					undoOrder.push(c.label);
					originalUndo();
				};
			}

			const count = mgr.undoByTaskId("T");

			expect(count).toBe(3);
			expect(undoOrder).toEqual(["c3", "c2", "c1"]);
			expect(mgr.canUndo()).toBe(false);
		});

		it("leaves commands tagged with other taskIds in place", () => {
			const a = new RecordingCommand("a");
			const b = new RecordingCommand("b");
			const c = new RecordingCommand("c");

			mgr.execute({ command: a, options: { source: "agent", agentId: "editor", taskId: "TA" } });
			mgr.execute({ command: b, options: { source: "agent", agentId: "editor", taskId: "TB" } });
			mgr.execute({ command: c, options: { source: "agent", agentId: "editor", taskId: "TA" } });

			const count = mgr.undoByTaskId("TA");

			expect(count).toBe(2);
			expect(a.undone).toBe(1);
			expect(b.undone).toBe(0);
			expect(c.undone).toBe(1);
			expect(mgr.canUndo()).toBe(true);
		});

		it("ignores entries with no taskId (e.g. human commands)", () => {
			const agentCmd = new RecordingCommand("agent");
			const humanCmd = new RecordingCommand("human");

			mgr.execute({ command: agentCmd, options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.execute({ command: humanCmd, options: { source: "human" } });

			const count = mgr.undoByTaskId("T");

			expect(count).toBe(1);
			expect(agentCmd.undone).toBe(1);
			expect(humanCmd.undone).toBe(0);
		});

		it("returns 0 and is a no-op when no entries match", () => {
			mgr.execute({ command: new RecordingCommand("x"), options: { source: "agent", agentId: "editor", taskId: "OTHER" } });
			expect(mgr.undoByTaskId("MISSING")).toBe(0);
			expect(mgr.canUndo()).toBe(true);
		});

		it("does NOT push rolled-back commands onto the redo stack", () => {
			const cmd = new RecordingCommand("x");
			mgr.execute({ command: cmd, options: { source: "agent", agentId: "editor", taskId: "T" } });

			mgr.undoByTaskId("T");

			expect(mgr.canRedo()).toBe(false);
		});

		it("emits command:rollback with taskId, count (attempted) and undone (succeeded)", () => {
			const listener = vi.fn();
			mgr.on("command:rollback", listener);

			mgr.execute({ command: new RecordingCommand("a"), options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.execute({ command: new RecordingCommand("b"), options: { source: "agent", agentId: "editor", taskId: "T" } });

			mgr.undoByTaskId("T");

			expect(listener).toHaveBeenCalledWith({ taskId: "T", count: 2, undone: 2 });
		});

		it("isolates a failing undo(): other tagged commands still get undone", () => {
			const c1 = new RecordingCommand("c1");
			const bad = new RecordingCommand("bad");
			const c3 = new RecordingCommand("c3");
			vi.spyOn(bad, "undo").mockImplementation(() => {
				throw new Error("undo blew up");
			});

			mgr.execute({ command: c1, options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.execute({ command: bad, options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.execute({ command: c3, options: { source: "agent", agentId: "editor", taskId: "T" } });

			const undone = mgr.undoByTaskId("T");

			// 3 entries attempted, 2 actually undone (bad threw)
			expect(undone).toBe(2);
			expect(c1.undone).toBe(1);
			expect(c3.undone).toBe(1);
			// All three entries removed from history — leaving the failing one
			// would corrupt future rollback / redo semantics
			expect(mgr.canUndo()).toBe(false);
		});

		it("emits command:rollback-error with the caught errors when any undo() throws", () => {
			const rollbackListener = vi.fn();
			const errorListener = vi.fn();
			mgr.on("command:rollback", rollbackListener);
			mgr.on("command:rollback-error", errorListener);

			const bad = new RecordingCommand("bad");
			vi.spyOn(bad, "undo").mockImplementation(() => {
				throw new Error("kaboom");
			});
			mgr.execute({ command: bad, options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.execute({ command: new RecordingCommand("ok"), options: { source: "agent", agentId: "editor", taskId: "T" } });

			mgr.undoByTaskId("T");

			expect(rollbackListener).toHaveBeenCalledWith({ taskId: "T", count: 2, undone: 1 });
			expect(errorListener).toHaveBeenCalledOnce();
			const [errorPayload] = errorListener.mock.calls[0];
			expect(errorPayload.taskId).toBe("T");
			expect(errorPayload.errors).toHaveLength(1);
			expect((errorPayload.errors[0] as Error).message).toBe("kaboom");
		});

		it("does NOT emit command:rollback-error when every undo succeeds", () => {
			const errorListener = vi.fn();
			mgr.on("command:rollback-error", errorListener);

			mgr.execute({ command: new RecordingCommand("a"), options: { source: "agent", agentId: "editor", taskId: "T" } });
			mgr.undoByTaskId("T");

			expect(errorListener).not.toHaveBeenCalled();
		});

		it("does NOT emit command:rollback when count is 0", () => {
			const listener = vi.fn();
			mgr.on("command:rollback", listener);

			mgr.undoByTaskId("MISSING");

			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("undo/redo still work with tuple history", () => {
		it("undo pops last command and pushes to redo stack", () => {
			const cmd = new RecordingCommand("x");
			mgr.execute({ command: cmd, options: { source: "human" } });

			mgr.undo();

			expect(cmd.undone).toBe(1);
			expect(mgr.canUndo()).toBe(false);
			expect(mgr.canRedo()).toBe(true);
		});

		it("redo re-executes the popped command", () => {
			const cmd = new RecordingCommand("x");
			mgr.execute({ command: cmd, options: { source: "human" } });
			mgr.undo();

			mgr.redo();

			expect(cmd.executed).toBe(2);
			expect(mgr.canUndo()).toBe(true);
			expect(mgr.canRedo()).toBe(false);
		});
	});
});
