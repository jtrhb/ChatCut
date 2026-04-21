/**
 * Shared preview-render configuration (Phase 3 Stage E reviewer LOW-1).
 *
 * The signed-URL TTL has to match the R2 lifecycle policy on the
 * `previews/` prefix (24h). Two callers mint URLs:
 *   - preview-render-worker.ts (fast path on terminal `done`)
 *   - routes/exploration.ts    (recovery path after page reload)
 * Pre-Stage-E both held private 24h constants; a future TTL bump would
 * silently drift one path. Living in one module makes the dependency
 * grep-able.
 */

export const PREVIEW_SIGNED_URL_TTL_SEC = 24 * 60 * 60;
