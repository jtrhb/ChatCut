import { Hono } from "hono";
import { z } from "zod";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { CoreRegistry } from "../services/core-registry.js";
import type { MutationDB } from "../services/commit-mutation.js";
import { commitMutation } from "../services/commit-mutation.js";

const commandSchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.unknown()),
  baseSnapshotVersion: z.number(),
  // Phase 2C-2: when present (and registry+mutationDB are wired) the
  // request routes through commitMutation against the per-project core
  // and persists to DB. When absent, the legacy singleton path runs
  // (kept for the dev/test boot that has no DB).
  projectId: z.string().optional(),
});

interface CommandsRouterDeps {
  serverEditorCore?: ServerEditorCore;
  coreRegistry?: CoreRegistry;
  mutationDB?: MutationDB;
}

function createCommandsRouter(deps: CommandsRouterDeps = {}): Hono {
  const { serverEditorCore, coreRegistry, mutationDB } = deps;
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

    // Persistent path: registry + mutationDB present AND request names a
    // project. commitMutation handles version validation by executing on
    // a clone of the per-project live core (the clone's pre-execute
    // version IS the live core's current version), so the request's
    // baseSnapshotVersion is checked against it.
    if (coreRegistry && mutationDB && result.data.projectId) {
      const projectId = result.data.projectId;
      let liveCore: ServerEditorCore;
      try {
        liveCore = await coreRegistry.get(projectId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 404);
      }

      try {
        liveCore.validateVersion(result.data.baseSnapshotVersion);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 409);
      }

      try {
        const out = await commitMutation({
          liveCore,
          projectId,
          command: { type: result.data.type, ...result.data.params } as any,
          isAgent: false,
          changeEntry: {
            projectId,
            source: "human",
            actionType: result.data.type,
            // Generic targetType/Id pending command-specific routing in a
            // later phase. The change_log row still pins
            // (projectId, sequence, source, actionType) which is enough
            // for ordering + replay invariants.
            targetType: "command",
            targetId: (result.data.params.id as string) ?? "unknown",
            details: result.data.params,
          },
          db: mutationDB,
        });
        return c.json({
          success: true,
          snapshotVersion: out.snapshotVersion,
          changeId: out.changeId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg, persisted: false }, 500);
      }
    }

    // Legacy singleton path: kept for dev/test boots without DB.
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

    return c.json({ error: "ServerEditorCore not configured", available: false }, 503);
  });

  return router;
}

// Default no-deps instance for backward compatibility
const commands = createCommandsRouter();

export { commands, createCommandsRouter };
