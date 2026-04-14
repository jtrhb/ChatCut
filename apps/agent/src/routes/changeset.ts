import { Hono } from "hono";
import { z } from "zod";
import type { ChangesetManager } from "../changeset/changeset-manager.js";

const changesetIdSchema = z.object({
  changesetId: z.string().min(1),
});

export function createChangesetRouter(deps: {
  changesetManager?: ChangesetManager;
}): Hono {
  const { changesetManager } = deps;
  const router = new Hono();

  router.post("/approve", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = changesetIdSchema.safeParse(body);
    if (!result.success) {
      return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
    }

    if (!changesetManager) {
      return c.json({ error: "ChangesetManager not configured" }, 503);
    }

    try {
      const changeset = await changesetManager.approve(result.data.changesetId);
      return c.json({ status: "approved", changesetId: result.data.changesetId, changeset });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  router.post("/reject", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = changesetIdSchema.safeParse(body);
    if (!result.success) {
      return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
    }

    if (!changesetManager) {
      return c.json({ error: "ChangesetManager not configured" }, 503);
    }

    try {
      const changeset = await changesetManager.reject(result.data.changesetId);
      return c.json({ status: "rejected", changesetId: result.data.changesetId, changeset });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");

    if (!changesetManager) {
      return c.json({ error: "ChangesetManager not configured" }, 503);
    }

    const changeset = await changesetManager.getChangeset(id);
    if (!changeset) {
      return c.json({ error: "Changeset not found" }, 404);
    }
    return c.json(changeset);
  });

  return router;
}

// Backward-compatible static export for tests that don't inject deps
export const changeset = createChangesetRouter({});
