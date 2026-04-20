-- Phase 2A migration (audit plan §2.1).
-- Adds projects.last_committed_change_id so commitMutation (Phase 2B)
-- can stamp the head changeId atomically alongside the snapshot update.
--
-- =============================================================================
-- DEPLOYMENT BOOTSTRAP — READ BEFORE APPLYING
-- =============================================================================
-- This file is a manual SQL diff. It assumes the base schema (`projects`,
-- `change_log`, etc.) is ALREADY present in the database. It does NOT
-- create the base tables.
--
-- Recommended bootstrap on a fresh DB:
--     bun run db:bootstrap        # runs db:push (creates base schema) then db:migrate (this file)
--
-- Or step-by-step:
--     bun run db:push             # drizzle-kit push — creates base schema from src/db/schema.ts
--     bun run db:migrate          # applies every migrations/*.sql in order
--
-- Why a hybrid push+migrate flow: the project never committed an initial
-- schema dump (predates Phase 2). Rather than synthesise one retroactively,
-- new structural changes that need transactional precision (FKs, unique
-- indexes, data backfills) live here as manual SQL; routine schema drift
-- continues to be applied via `db:push` from src/db/schema.ts.
--
-- All statements below are idempotent (IF NOT EXISTS / DO blocks) so
-- re-running this migration after a schema push is safe.
-- =============================================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_committed_change_id uuid NULL;

-- Phase 2 reviewer fix: enforce strictly-monotonic per-project sequence
-- in change_log. Without this, two concurrent commitMutation calls on the
-- same projectId can both SELECT max(sequence) → both INSERT the same
-- value → silent corruption of the audit trail. The unique constraint
-- raises a Postgres unique_violation that aborts the second tx; the
-- first tx's atomic swap still lands cleanly per commitMutation's design.
CREATE UNIQUE INDEX IF NOT EXISTS change_log_project_sequence_uniq
  ON change_log(project_id, sequence);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_last_committed_change_id_change_log_id_fk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_last_committed_change_id_change_log_id_fk
      FOREIGN KEY (last_committed_change_id) REFERENCES change_log(id)
      ON DELETE SET NULL;
  END IF;
END $$;
