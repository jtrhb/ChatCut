import type { AgentTask, CreateTaskParams, TaskStatus } from "./types.js";

export class TaskRegistry {
  private tasks = new Map<string, AgentTask>();

  createTask(params: CreateTaskParams): AgentTask {
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

  getTask(taskId: string): AgentTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
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
