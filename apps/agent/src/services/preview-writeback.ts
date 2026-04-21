/**
 * Per-candidate preview-render writeback (Phase 3 Stage E.1/E.2).
 *
 * The preview-render pg-boss worker calls into this on terminal `done`
 * (record storage key) or terminal `failed` (record error message).
 * The implementation merges into existing jsonb maps via Postgres
 * `jsonb_set` so concurrent candidate writes for the same exploration
 * row don't clobber each other.
 *
 * The interface is the seam for tests: the worker test file mocks it
 * with vi.fn() and asserts shape; production wires DrizzlePreviewWriteback
 * in apps/agent/src/index.ts.
 *
 * IDs are validated against the same `safeForLog` regex used in the
 * worker — Stage C MED #9 defense-in-depth — so a future code path
 * that lets users supply candidateIds can't inject SQL via the jsonb
 * path argument. Today's IDs are server-generated UUIDs that always
 * pass.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export interface PreviewWriteback {
  /** Record a successful render; merges into preview_storage_keys jsonb. */
  recordSuccess(args: {
    explorationId: string;
    candidateId: string;
    storageKey: string;
  }): Promise<void>;
  /** Record a render failure; merges into preview_render_failures jsonb. */
  recordFailure(args: {
    explorationId: string;
    candidateId: string;
    message: string;
    synthesized?: boolean;
  }): Promise<void>;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(`${field} contains unsafe character: ${JSON.stringify(value)}`);
  }
}

type DrizzlePg = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

export class DrizzlePreviewWriteback implements PreviewWriteback {
  constructor(private readonly db: DrizzlePg) {}

  async recordSuccess({
    explorationId,
    candidateId,
    storageKey,
  }: {
    explorationId: string;
    candidateId: string;
    storageKey: string;
  }): Promise<void> {
    assertSafeId(explorationId, "explorationId");
    assertSafeId(candidateId, "candidateId");
    // jsonb_set(coalesce(...,'{}'), ARRAY[$candidateId], $value::jsonb, true)
    // — the path is parameterized as text[], so no SQL injection vector.
    await this.db.execute(sql`
      UPDATE exploration_sessions
      SET preview_storage_keys = jsonb_set(
        coalesce(preview_storage_keys, '{}'::jsonb),
        ARRAY[${candidateId}]::text[],
        ${JSON.stringify(storageKey)}::jsonb,
        true
      )
      WHERE id = ${explorationId}::uuid
    `);
  }

  async recordFailure({
    explorationId,
    candidateId,
    message,
    synthesized,
  }: {
    explorationId: string;
    candidateId: string;
    message: string;
    synthesized?: boolean;
  }): Promise<void> {
    assertSafeId(explorationId, "explorationId");
    assertSafeId(candidateId, "candidateId");
    const payload = {
      message,
      ts: new Date().toISOString(),
      ...(synthesized ? { synthesized: true } : {}),
    };
    await this.db.execute(sql`
      UPDATE exploration_sessions
      SET preview_render_failures = jsonb_set(
        coalesce(preview_render_failures, '{}'::jsonb),
        ARRAY[${candidateId}]::text[],
        ${JSON.stringify(payload)}::jsonb,
        true
      )
      WHERE id = ${explorationId}::uuid
    `);
  }
}
