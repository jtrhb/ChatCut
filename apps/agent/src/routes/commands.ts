import { Hono } from "hono";
import { z } from "zod";
import type { ServerEditorCore } from "../services/server-editor-core.js";

const commandSchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.unknown()),
  baseSnapshotVersion: z.number(),
});

function createCommandsRouter(deps: { serverEditorCore?: ServerEditorCore } = {}): Hono {
  const { serverEditorCore } = deps;
  const router = new Hono();

  router.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = commandSchema.safeParse(body);
    if (!result.success) {
      return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
    }

    if (serverEditorCore) {
      try {
        serverEditorCore.validateVersion(result.data.baseSnapshotVersion);
        serverEditorCore.executeHumanCommand({
          type: result.data.type,
          ...result.data.params,
        } as any);
        return c.json({ success: true, snapshotVersion: serverEditorCore.snapshotVersion });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 409);
      }
    }

    return c.json({ success: true, snapshotVersion: 1 });
  });

  return router;
}

// Default no-deps instance for backward compatibility
const commands = createCommandsRouter();

export { commands, createCommandsRouter };
