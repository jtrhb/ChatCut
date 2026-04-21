-- Phase 5a Stage MED-2 race fix.
-- Promotes vision_cache_media_hash_schema_idx (non-unique) to a unique
-- index so the executor's onConflictDoNothing INSERT actually fires
-- under concurrent fan-out. Without this, two agents analyzing the
-- same media at the same time would both miss the cache, both call
-- Gemini (2x cost), and both INSERT — silently creating duplicate
-- rows that all read back identically (same analysis for same hash +
-- schema is deterministic) but waste storage.
--
-- Idempotent. The DROP step is conditional so re-runs on a fresh DB
-- (where db:push from src/db/schema.ts already created the unique
-- index) are no-ops.

DO $$
BEGIN
  -- Drop the old non-unique index if present (legacy of pre-Phase-5a schema).
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'vision_cache_media_hash_schema_idx'
  ) THEN
    DROP INDEX vision_cache_media_hash_schema_idx;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS vision_cache_media_hash_schema_uniq
  ON vision_cache (media_hash, schema_version);
