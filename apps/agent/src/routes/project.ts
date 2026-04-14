import { Hono } from "hono";
import type { ProjectContextManager } from "../context/project-context.js";

function createProjectRouter(deps: { contextManager?: ProjectContextManager } = {}): Hono {
  const { contextManager } = deps;
  const router = new Hono();

  router.get("/:id", (c) => {
    const id = c.req.param("id");

    if (contextManager) {
      // WARNING: Currently returns global shared context regardless of project ID.
      // Multi-project isolation requires per-project ServerEditorCore + ProjectContext.
      // Until then, this is single-project only.
      const ctx = contextManager.get();
      return c.json({
        projectId: id,
        snapshotVersion: ctx.snapshotVersion,
        timeline: ctx.timelineState || null,
        _warning: "single-project mode — context is shared across all project IDs",
      });
    }

    return c.json({ error: "ProjectContext not configured", available: false }, 503);
  });

  return router;
}

// Default no-deps instance for backward compatibility
const project = createProjectRouter();

export { project, createProjectRouter };
