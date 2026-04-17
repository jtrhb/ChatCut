import type { AgentTask, CreateTaskParams, TaskStatus } from "./types.js";

export class TaskRegistry {
  private tasks = new Map<string, AgentTask>();
  /**
   * How long to retain terminal tasks (completed / failed / cancelled)
   * after their last updatedAt. Running/queued tasks are never evicted
   * — they require a terminal transition. Default 7 days, same as
   * ChangesetManager.
   */
  private readonly terminalRetentionMs: number;

  constructor(opts?: { terminalRetentionMs?: number }) {
    this.terminalRetentionMs = opts?.terminalRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  createTask(params: CreateTaskParams): AgentTask {
    // Opportunistic retention sweep — bounds the map without a background
    // timer. Running tasks are untouched; only terminal-state tasks past
    // the retention window get evicted.
    this.sweepTerminal();

    const now = Date.now();
    const task: AgentTask = {
      taskId: crypto.randomUUID(),
      type: params.type,
      status: "queued",
      description: params.description,
      sessionId: params.sessionId,
      changesetId: params.changesetId,
      parentTaskId: params.parentTaskId,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    return { ...task };
  }

  /** Drop terminal tasks whose updatedAt is older than the retention window. */
  private sweepTerminal(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, task] of this.tasks) {
      const terminal =
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled";
      if (terminal && now - task.updatedAt > this.terminalRetentionMs) {
        this.tasks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Exposed for tests + health endpoints. */
  size(): number {
    return this.tasks.size;
  }

  getTask(taskId: string): AgentTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    // Review design-flag fix: lazily evict expired terminal tasks on read
    // as well as write, so callers don't receive a task that's past the
    // retention window just because no new createTask has fired recently.
    // Mirrors SessionStore.get's lazy expiration pattern.
    const terminal =
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled";
    if (
      terminal &&
      Date.now() - task.updatedAt > this.terminalRetentionMs
    ) {
      this.tasks.delete(taskId);
      return undefined;
    }
    return { ...task };
  }

  updateProgress(taskId: string, progress: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const clamped = Math.max(0, Math.min(100, progress));
    task.progress = clamped;
    task.updatedAt = Date.now();
    if (task.status === "queued") {
      task.status = "running";
    }
  }

  completeTask(taskId: string, result: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const now = Date.now();
    task.status = "completed";
    task.progress = 100;
    task.result = result;
    task.completedAt = now;
    task.updatedAt = now;
  }

  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "failed";
    task.error = error;
    task.updatedAt = Date.now();
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "failed") {
      return false;
    }
    task.status = "cancelled";
    task.updatedAt = Date.now();
    return true;
  }

  listTasks(filter?: { status?: TaskStatus; sessionId?: string }): AgentTask[] {
    const all = Array.from(this.tasks.values());
    if (!filter) return all.map((t) => ({ ...t }));

    return all
      .filter((t) => {
        if (filter.status !== undefined && t.status !== filter.status) return false;
        if (filter.sessionId !== undefined && t.sessionId !== filter.sessionId) return false;
        return true;
      })
      .map((t) => ({ ...t }));
  }

  getChildTasks(parentTaskId: string): AgentTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.parentTaskId === parentTaskId)
      .map((t) => ({ ...t }));
  }
}
