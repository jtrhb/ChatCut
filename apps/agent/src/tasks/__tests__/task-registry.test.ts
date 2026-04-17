import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskRegistry } from "../task-registry.js";

describe("TaskRegistry", () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  // 1. createTask — returns task with queued status, progress 0
  it("createTask returns task with queued status and progress 0", () => {
    const task = registry.createTask({ type: "agent_dispatch", description: "dispatch agent" });

    expect(task.status).toBe("queued");
    expect(task.progress).toBe(0);
    expect(task.taskId).toBeTruthy();
    expect(typeof task.taskId).toBe("string");
    expect(task.type).toBe("agent_dispatch");
    expect(task.description).toBe("dispatch agent");
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBeGreaterThan(0);
    expect(task.completedAt).toBeUndefined();
  });

  // 2. createTask — links to session and changeset
  it("createTask links to session and changeset", () => {
    const task = registry.createTask({
      type: "exploration",
      description: "explore edits",
      sessionId: "sess-1",
      changesetId: "cs-42",
      parentTaskId: "parent-task-99",
    });

    expect(task.sessionId).toBe("sess-1");
    expect(task.changesetId).toBe("cs-42");
    expect(task.parentTaskId).toBe("parent-task-99");
  });

  // 3. getTask — returns undefined for unknown
  it("getTask returns undefined for unknown taskId", () => {
    expect(registry.getTask("nonexistent-id")).toBeUndefined();
  });

  // 4. getTask — returns task by ID
  it("getTask returns task by ID", () => {
    const created = registry.createTask({ type: "generation", description: "generate content" });
    const fetched = registry.getTask(created.taskId);

    expect(fetched).toBeDefined();
    expect(fetched!.taskId).toBe(created.taskId);
    expect(fetched!.description).toBe("generate content");
  });

  // 5. updateProgress — updates progress, sets status to running
  it("updateProgress updates progress and sets status to running", () => {
    const task = registry.createTask({ type: "render_preview", description: "render preview" });
    expect(task.status).toBe("queued");

    registry.updateProgress(task.taskId, 42);

    const updated = registry.getTask(task.taskId)!;
    expect(updated.progress).toBe(42);
    expect(updated.status).toBe("running");
  });

  // 6. completeTask — marks completed with result, progress 100, completedAt set
  it("completeTask marks task completed with result, progress 100, and completedAt", () => {
    const before = Date.now();
    const task = registry.createTask({ type: "export", description: "export video" });

    registry.completeTask(task.taskId, { url: "https://example.com/video.mp4" });

    const completed = registry.getTask(task.taskId)!;
    expect(completed.status).toBe("completed");
    expect(completed.progress).toBe(100);
    expect(completed.result).toEqual({ url: "https://example.com/video.mp4" });
    expect(completed.completedAt).toBeGreaterThanOrEqual(before);
  });

  // 7. failTask — marks failed with error
  it("failTask marks task as failed with error message", () => {
    const task = registry.createTask({ type: "verification", description: "verify output" });

    registry.failTask(task.taskId, "Verification failed: invalid output");

    const failed = registry.getTask(task.taskId)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Verification failed: invalid output");
  });

  // 8. cancelTask — marks queued task as cancelled
  it("cancelTask marks a queued task as cancelled", () => {
    const task = registry.createTask({ type: "agent_dispatch", description: "dispatch" });
    expect(task.status).toBe("queued");

    const result = registry.cancelTask(task.taskId);

    expect(result).toBe(true);
    const cancelled = registry.getTask(task.taskId)!;
    expect(cancelled.status).toBe("cancelled");
  });

  // 9. cancelTask — returns false for completed task
  it("cancelTask returns false for an already completed task", () => {
    const task = registry.createTask({ type: "export", description: "export" });
    registry.completeTask(task.taskId, null);

    const result = registry.cancelTask(task.taskId);

    expect(result).toBe(false);
    const stillCompleted = registry.getTask(task.taskId)!;
    expect(stillCompleted.status).toBe("completed");
  });

  // 10. listTasks — returns all tasks
  it("listTasks returns all tasks when no filter is provided", () => {
    registry.createTask({ type: "agent_dispatch", description: "task 1" });
    registry.createTask({ type: "exploration", description: "task 2" });
    registry.createTask({ type: "generation", description: "task 3" });

    const all = registry.listTasks();
    expect(all).toHaveLength(3);
  });

  // 11. listTasks — filters by status and session
  it("listTasks filters by status and sessionId", () => {
    const t1 = registry.createTask({ type: "agent_dispatch", description: "task 1", sessionId: "sess-A" });
    const t2 = registry.createTask({ type: "exploration", description: "task 2", sessionId: "sess-A" });
    registry.createTask({ type: "generation", description: "task 3", sessionId: "sess-B" });

    registry.updateProgress(t1.taskId, 50); // now running

    const runningSessA = registry.listTasks({ status: "running", sessionId: "sess-A" });
    expect(runningSessA).toHaveLength(1);
    expect(runningSessA[0].taskId).toBe(t1.taskId);

    const queuedSessA = registry.listTasks({ status: "queued", sessionId: "sess-A" });
    expect(queuedSessA).toHaveLength(1);
    expect(queuedSessA[0].taskId).toBe(t2.taskId);

    const allSessA = registry.listTasks({ sessionId: "sess-A" });
    expect(allSessA).toHaveLength(2);
  });

  // 12. getChildTasks — returns tasks with matching parentTaskId
  it("getChildTasks returns tasks with matching parentTaskId", () => {
    const parent = registry.createTask({ type: "agent_dispatch", description: "parent task" });
    const child1 = registry.createTask({
      type: "exploration",
      description: "child 1",
      parentTaskId: parent.taskId,
    });
    const child2 = registry.createTask({
      type: "generation",
      description: "child 2",
      parentTaskId: parent.taskId,
    });
    registry.createTask({ type: "export", description: "unrelated task" });

    const children = registry.getChildTasks(parent.taskId);
    expect(children).toHaveLength(2);
    const childIds = children.map((c) => c.taskId);
    expect(childIds).toContain(child1.taskId);
    expect(childIds).toContain(child2.taskId);
  });

  describe("B6: terminal-state retention", () => {
    it("evicts completed tasks past terminalRetentionMs on next createTask", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      try {
        const r = new TaskRegistry({ terminalRetentionMs: 10_000 });
        const t1 = r.createTask({ type: "export", description: "old" });
        r.completeTask(t1.taskId, "ok");

        vi.advanceTimersByTime(10_001);
        r.createTask({ type: "export", description: "fresh" });

        expect(r.getTask(t1.taskId)).toBeUndefined();
        expect(r.size()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps running/queued tasks regardless of age", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      try {
        const r = new TaskRegistry({ terminalRetentionMs: 10_000 });
        const running = r.createTask({ type: "export", description: "long-lived" });

        vi.advanceTimersByTime(60_000);
        r.createTask({ type: "export", description: "trigger sweep" });

        expect(r.getTask(running.taskId)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("evicts failed and cancelled tasks too", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      try {
        const r = new TaskRegistry({ terminalRetentionMs: 1_000 });
        const f = r.createTask({ type: "export", description: "fail" });
        const c = r.createTask({ type: "export", description: "cancel" });
        r.failTask(f.taskId, "boom");
        r.cancelTask(c.taskId);

        vi.advanceTimersByTime(2_000);
        r.createTask({ type: "export", description: "new" });

        expect(r.getTask(f.taskId)).toBeUndefined();
        expect(r.getTask(c.taskId)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
