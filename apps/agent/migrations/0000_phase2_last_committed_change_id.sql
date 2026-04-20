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

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_committed_change_id uuid NULL;

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
