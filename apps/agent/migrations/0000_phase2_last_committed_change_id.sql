-- Phase 2A migration (audit plan §2.1).
-- Adds projects.last_committed_change_id so commitMutation (Phase 2B)
-- can stamp the head changeId atomically alongside the snapshot update.
--
-- This file is the manual SQL diff. The project has not previously kept
-- generated drizzle-kit manifests; future migrations should either land
-- as additional manual files here, or the team can run `drizzle-kit
-- generate` once to bring the manifest format up to date.
--
-- Apply with: psql "$DATABASE_URL" -f migrations/0000_phase2_last_committed_change_id.sql
-- Idempotent (uses IF NOT EXISTS / DO blocks) so re-running is safe.
--
-- PREREQUISITE: the base schema (`projects`, `change_log`, etc.) must
-- already be present in the DB. The project bootstraps tables via
-- `bun run db:push` (drizzle-kit push) on first deploy — see
-- `apps/agent/package.json`. Only run this migration AFTER that initial
-- push. Future schema changes either land here as additional manual SQL
-- files OR get picked up by another `db:push` for dev workflows.

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
