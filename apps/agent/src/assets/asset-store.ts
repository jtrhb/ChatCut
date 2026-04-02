import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { assets } from "../db/schema.js";

export interface AssetSaveParams {
  userId: string;
  type: string;
  name: string;
  storageKey: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface AssetSearchParams {
  userId: string;
  query?: string;
  type?: string;
}

export class AssetStore {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  async save(params: AssetSaveParams): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(assets).values({
      id,
      name: params.name,
      type: params.type,
      storageKey: params.storageKey,
      tags: params.tags ?? [],
      generationContext: {
        created_at: new Date().toISOString(),
        source: "agent",
        metadata: params.metadata ?? {},
      },
      createdAt: new Date(),
    });
    return { id };
  }

  async search(params: AssetSearchParams): Promise<any[]> {
    let query = this.db.select().from(assets);

    const conditions = [];
    if (params.type !== undefined) {
      conditions.push(eq(assets.type, params.type));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const results: any[] = await query;

    if (params.query) {
      const q = params.query.toLowerCase();
      return results.filter(
        (a: any) =>
          (a.name as string).toLowerCase().includes(q) ||
          ((a.tags ?? []) as string[]).some((t: string) => t.toLowerCase().includes(q))
      );
    }

    return results;
  }
}
