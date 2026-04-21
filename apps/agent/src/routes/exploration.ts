import { Hono } from "hono";
import type { ObjectStorage } from "../services/object-storage.js";
import type { ExplorationLookup } from "../services/exploration-lookup.js";

/**
 * Exploration routes (Phase 3 Stage E.3).
 *
 * GET /:explorationId/preview/:candidateId returns one of:
 *   200 { explorationId, candidateId, url }       — storage key found, signed URL minted
 *   422 { error, message, synthesized?, ts }      — render failure recorded
 *   404 { error: "not_ready"|"unknown_..."}        — still rendering / unknown ids
 *   503 { error, available: false }                — backend infra missing
 *
 * The fast path for live previews is the SSE `exploration.candidate_ready`
 * event, which carries a pre-signed URL minted in the worker (Stage E.5).
 * This route is the recovery path: page reload mid-render, late
 * subscriber, or any client that prefers polling.
 */

export interface ExplorationRouterDeps {
  objectStorage?: ObjectStorage;
  lookup?: ExplorationLookup;
  /** Signed URL TTL in seconds. Default 24h, matches R2 lifecycle. */
  signedUrlTtlSec?: number;
}

const DEFAULT_SIGNED_URL_TTL_SEC = 24 * 60 * 60;

export function createExplorationRouter(deps: ExplorationRouterDeps = {}): Hono {
  const { objectStorage, lookup } = deps;
  const ttl = deps.signedUrlTtlSec ?? DEFAULT_SIGNED_URL_TTL_SEC;
  const router = new Hono();

  router.get("/:explorationId/preview/:candidateId", async (c) => {
    if (!objectStorage) {
      return c.json(
        { error: "object_storage_unavailable", available: false },
        503,
      );
    }
    if (!lookup) {
      return c.json(
        { error: "exploration_lookup_unavailable", available: false },
        503,
      );
    }

    const explorationId = c.req.param("explorationId");
    const candidateId = c.req.param("candidateId");

    let state;
    try {
      state = await lookup.getPreviewState({ explorationId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: "lookup_failed", message: msg, available: false },
        503,
      );
    }

    if (!state) {
      return c.json(
        { error: "unknown_exploration", explorationId },
        404,
      );
    }

    // Failure beats success: if both maps somehow have an entry for the
    // same candidate (race between two retries), the failure wins so
    // the user sees the most recent diagnostic.
    const failure = state.previewRenderFailures?.[candidateId];
    if (failure) {
      return c.json(
        {
          error: "render_failed",
          message: failure.message,
          ts: failure.ts,
          ...(failure.synthesized ? { synthesized: true } : {}),
        },
        422,
      );
    }

    const storageKey = state.previewStorageKeys?.[candidateId];
    if (!storageKey) {
      return c.json(
        { error: "not_ready", explorationId, candidateId },
        404,
      );
    }

    try {
      const url = await objectStorage.getSignedUrl(storageKey, ttl);
      return c.json({ explorationId, candidateId, url, storageKey });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: "signing_failed", message: msg }, 503);
    }
  });

  return router;
}
