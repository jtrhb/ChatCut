import { Hono } from "hono";
import type { SessionManager } from "../session/session-manager.js";
import type { TaskRegistry } from "../tasks/task-registry.js";

export function createStatusRouter(deps: {
  sessionManager: SessionManager;
  taskRegistry: TaskRegistry;
}) {
  const router = new Hono();

  router.get("/", (c) => {
    const tasks = deps.taskRegistry.listTasks();
    const queuedTasks = tasks.filter((t) => t.status === "queued").length;
    const runningTasks = tasks.filter((t) => t.status === "running").length;

    return c.json({
      agentStatus: runningTasks > 0 ? "busy" : "idle",
      activeSessions: 0,
      queuedTasks,
      runningTasks,
      completedTasks: tasks.filter((t) => t.status === "completed").length,
      failedTasks: tasks.filter((t) => t.status === "failed").length,
    });
  });

  return router;
}

// Backward-compatible export
const status = new Hono();
status.get("/", (c) => {
  return c.json({ agentStatus: "idle", activeChangesets: 0 });
});
export { status };
