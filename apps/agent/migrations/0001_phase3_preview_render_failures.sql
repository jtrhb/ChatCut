-- Phase 3 Stage E migration (plan §E.2).
-- Adds exploration_sessions.preview_render_failures so the preview-render
-- worker can record per-candidate failure metadata distinct from the
-- success-side preview_storage_keys map. The route layer uses presence
-- in this column to serve 422 ("render failed, here's why") instead of
-- 404 ("never heard of this candidate / still rendering").
--
-- Idempotent — safe to re-run after a `bun run db:push` from the
-- schema definition.

ALTER TABLE exploration_sessions
  ADD COLUMN IF NOT EXISTS preview_render_failures jsonb NULL;
