import { Hono } from "hono";
import { z } from "zod";
import type { ChangesetManager } from "../changeset/changeset-manager.js";
import {
  StaleStateError,
  ChangesetOwnerMismatchError,
} from "../changeset/changeset-manager.js";

/**
 * B5 request shape. projectId is required because the owner check
 * compares (userId, projectId). userId comes from the x-user-id header
 * (B1 auth middleware stub). If either is missing, we can't run the
 * owner check, so we reject with 400 rather than silently skipping.
 */
const decideSchema = z.object({
  changesetId: z.string().min(1),
  projectId: z.string().min(1),
});

export function createChangesetRouter(deps: {
  changesetManager?: ChangesetManager;
}): Hono {
  const { changesetManager } = deps;
  const router = new Hono();

  /**
   * Map changeset-domain errors to HTTP status codes.
   * - StaleStateError → 409 Conflict (editor state changed during review)
   * - ChangesetOwnerMismatchError → 403 Forbidden (IDOR closure)
   * - "not found"-style messages → 404
   * - everything else → 400
   */
  const mapErrorToStatus = (err: unknown): { status: 400 | 403 | 404 | 409; body: Record<string, unknown> } => {
    if (err instanceof StaleStateError) {
      return {
        status: 409,
        body: { error: err.message, kind: "stale-state", details: err.details },
      };
    }
    if (err instanceof ChangesetOwnerMismatchError) {
      return { status: 403, body: { error: err.message, kind: "owner-mismatch" } };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) {
      return { status: 404, body: { error: message } };
    }
    return { status: 400, body: { error: message } };
  };

  router.post("/approve", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = decideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
    }

    if (!changesetManager) {
      return c.json({ error: "ChangesetManager not configured" }, 503);
    }

    const userId = c.req.header("x-user-id");
    if (!userId) {
      return c.json({ error: "Missing x-user-id header" }, 401);
    }

    try {
      await changesetManager.approve(parsed.data.changesetId, {
        userId,
        projectId: parsed.data.projectId,
      });
      const changeset = changesetManager.getChangeset(parsed.data.changesetId);
      return c.json({ status: "approved", changesetId: parsed.data.changesetId, changeset });
    } catch (err) {
      const { status, body: errBody } = mapErrorToStatus(err);
      return c.json(errBody, status);
    }
  });

  router.post("/reject", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = decideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
    }

    if (!changesetManager) {
      return c.json({ error: "ChangesetManager not configured" }, 503);
    }

    const userId = c.req.header("x-user-id");
    if (!userId) {
      return c.json({ error: "Missing x-user-id header" }, 401);
    }

    try {
      await changesetManager.reject(parsed.data.changesetId, {
        userId,
        projectId: parsed.data.projectId,
      });
      const changeset = changesetManager.getChangeset(parsed.data.changesetId);
      return c.json({ status: "rejected", changesetId: parsed.data.changesetId, changeset });
    } catch (err) {
      const { status, body: errBody } = mapErrorToStatus(err);
      return c.json(errBody, status);
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
