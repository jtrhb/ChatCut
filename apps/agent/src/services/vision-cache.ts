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

    await this.db.insert(visionCache).values({
      mediaHash,
      schemaVersion,
      analysis,
    });
  }

  async invalidate(mediaHash: string): Promise<void> {
    await this.db
      .delete()
      .from(visionCache)
      .where(eq(visionCache.mediaHash, mediaHash));
  }
}
