/**
 * Exploration session preview lookup (Phase 3 Stage E.3).
 *
 * The /exploration/:explorationId/preview/:candidateId route reads
 * per-candidate state from `exploration_sessions` to decide whether to
 * serve a 200 (storage key present → mint signed URL), 422 (failure
 * recorded → return error message), or 404 (still rendering / never
 * heard of it).
 *
 * The interface is the seam for tests: the route file mocks it with
 * vi.fn() and asserts shape; production wires DrizzleExplorationLookup
 * in apps/agent/src/server.ts.
 */

import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { explorationSessions } from "../db/schema.js";

export interface PreviewFailureRecord {
  message: string;
  ts: string;
  synthesized?: boolean;
}

export interface ExplorationPreviewState {
  /** Map of candidateId → R2 storage key. null when row exists but no key yet. */
  previewStorageKeys: Record<string, string> | null;
  /** Map of candidateId → failure metadata. null when no failures recorded. */
  previewRenderFailures: Record<string, PreviewFailureRecord> | null;
}

export interface ExplorationLookup {
  /**
   * Fetch preview state for one exploration. Returns null when the
   * exploration row itself does not exist (route translates → 404).
   */
  getPreviewState(args: {
    explorationId: string;
  }): Promise<ExplorationPreviewState | null>;
}

// Reviewer Stage E NIT-2: see preview-writeback.ts — same alias shape,
// same rationale. Not narrowed to the project schema by design.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzlePg = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

export class DrizzleExplorationLookup implements ExplorationLookup {
  constructor(private readonly db: DrizzlePg) {}

  async getPreviewState({
    explorationId,
  }: {
    explorationId: string;
  }): Promise<ExplorationPreviewState | null> {
    const rows = await this.db
      .select({
        previewStorageKeys: explorationSessions.previewStorageKeys,
        previewRenderFailures: explorationSessions.previewRenderFailures,
      })
      .from(explorationSessions)
      .where(eq(explorationSessions.id, explorationId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      previewStorageKeys:
        (row.previewStorageKeys as Record<string, string> | null) ?? null,
      previewRenderFailures:
        (row.previewRenderFailures as Record<
          string,
          PreviewFailureRecord
        > | null) ?? null,
    };
  }
}
