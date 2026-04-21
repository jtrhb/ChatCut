import { eq, and } from "drizzle-orm";
import { visionCache } from "../db/schema.js";
import type { VideoAnalysis } from "./vision-client.js";

export class VisionCache {
  constructor(private readonly db: any) {}

  async get(mediaHash: string, schemaVersion: number): Promise<VideoAnalysis | null> {
    const rows = await this.db
      .select()
      .from(visionCache)
      .where(
        and(
          eq(visionCache.mediaHash, mediaHash),
          eq(visionCache.schemaVersion, schemaVersion)
        )
      )
      .limit(1);

    if (rows.length === 0) return null;
    return rows[0].analysis as VideoAnalysis;
  }

  async set(
    mediaHash: string,
    schemaVersion: number,
    analysis: VideoAnalysis,
    focus?: string
  ): Promise<void> {
    // Only cache canonical (no-focus) analyses
    if (focus) return;

    // Phase 5a MED-2 race fix: two concurrent agents analyzing the
    // same media will both miss the cache, both call Gemini, then race
    // on INSERT. Without onConflictDoNothing the second writer hits
    // a unique-constraint violation that surfaces as a tool error.
    // The constraint is on (media_hash, schema_version) via the index
    // declared in db/schema.ts:124. First-writer-wins is correct: the
    // analysis content for the same hash + same schema is identical,
    // so silently dropping the duplicate is safe and the user-visible
    // behavior is "both calls return the analysis", which is exactly
    // what we want.
    await this.db
      .insert(visionCache)
      .values({ mediaHash, schemaVersion, analysis })
      .onConflictDoNothing();
  }

  async invalidate(mediaHash: string): Promise<void> {
    await this.db
      .delete()
      .from(visionCache)
      .where(eq(visionCache.mediaHash, mediaHash));
  }
}
