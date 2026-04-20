import { Hono } from "hono";
import { z } from "zod";
import type { Command } from "@opencut/core";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { CoreRegistry } from "../services/core-registry.js";
import type { MutationDB } from "../services/commit-mutation.js";
import { commitMutation } from "../services/commit-mutation.js";

/**
 * Resolves a (type, params) pair from the wire into a real Command
 * instance. Returns null when the type isn't recognised — the route
 * surfaces that as 400. No factory has been registered for production
 * yet (per-command-type dispatcher is the next phase); tests inject a
 * trivial factory to exercise the commitMutation path.
 */
export type CommandFactory = (type: string, params: Record<string, unknown>) => Command | null;

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
  /** Phase 2 reviewer HIGH #5: route must hand commitMutation a real
   *  Command (with execute/undo). JSON requests don't carry methods, so
   *  the route asks the factory to build one from (type, params). When
   *  no factory is registered, every request surfaces a 400 instead of
   *  a cryptic mid-tx "command.execute is not a function". */
  commandFactory?: CommandFactory;
}

function createCommandsRouter(deps: CommandsRouterDeps = {}): Hono {
  const { serverEditorCore, coreRegistry, mutationDB, commandFactory } = deps;
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

    // Persistent path: registry + mutationDB are wired. When wired we
    // REQUIRE projectId — silently falling back to the singleton would
    // mutate a process-global core regardless of the requested project,
    // which is exactly the §A.3 isolation bug Phase 2 was written to
    // close (reviewer HIGH #4).
    if (coreRegistry && mutationDB) {
      if (!result.data.projectId) {
        return c.json(
          { error: "projectId is required when persistent storage is configured" },
          400,
        );
      }

      // change_log.targetId is NOT NULL text — a placeholder like
      // "unknown" pollutes the audit trail (reviewer MEDIUM #6). Until
      // a per-command-type dispatcher exists, accept only requests that
      // carry an explicit `params.id`.
      const targetId = result.data.params.id;
      if (typeof targetId !== "string" || targetId.length === 0) {
        return c.json(
          { error: "params.id (string) is required for persistent commands" },
          400,
        );
      }

      // Build a real Command via the injected factory (reviewer HIGH #5).
      const synthesisedCommand = commandFactory
        ? commandFactory(result.data.type, result.data.params)
        : null;
      if (!synthesisedCommand || typeof synthesisedCommand.execute !== "function") {
        return c.json(
          {
            error: `Unknown command type "${result.data.type}" — no command-class dispatcher registered for HTTP /commands yet.`,
          },
          400,
        );
      }

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
          command: synthesisedCommand,
          isAgent: false,
          changeEntry: {
            projectId,
            source: "human",
            actionType: result.data.type,
            targetType: "command",
            targetId,
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
