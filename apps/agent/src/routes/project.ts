import { Hono } from "hono";
import type { ProjectContextManager } from "../context/project-context.js";
import type { CoreRegistry } from "../services/core-registry.js";

interface ProjectRouterDeps {
  contextManager?: ProjectContextManager;
  /** Phase 2D: when wired, hydration returns the per-project snapshot
   *  via the registry instead of the legacy shared-context payload. */
  coreRegistry?: CoreRegistry;
}

function createProjectRouter(deps: ProjectRouterDeps = {}): Hono {
  const { contextManager, coreRegistry } = deps;
  const router = new Hono();

  router.get("/:id", async (c) => {
    const id = c.req.param("id");

    // Phase 2D persistent path: registry-backed per-project hydration.
    if (coreRegistry) {
      try {
        const core = await coreRegistry.get(id);
        return c.json({
          projectId: id,
          snapshotVersion: core.snapshotVersion,
          timeline: core.serialize(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 404);
      }
    }

    // Legacy: shared-context fallback for the dev boot without DB.
    if (contextManager) {
      // WARNING: Returns global shared context regardless of project ID.
      // Wire coreRegistry to get true per-project isolation.
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
