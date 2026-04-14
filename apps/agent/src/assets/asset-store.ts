import { randomUUID } from "crypto";
import { eq, and, sql, type SQL } from "drizzle-orm";
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

    const conditions: SQL<unknown>[] = [];
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

  async findById(id: string): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(assets)
      .where(eq(assets.id, id));
    return rows[0] ?? null;
  }

  async updateTags(id: string, tags: string[]): Promise<void> {
    await this.db
      .update(assets)
      .set({ tags })
      .where(eq(assets.id, id));
  }

  async saveWithEmbedding(
    params: AssetSaveParams,
    embedding: number[],
  ): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(assets).values({
      id,
      name: params.name,
      type: params.type,
      storageKey: params.storageKey,
      tags: params.tags ?? [],
      embedding,
      generationContext: {
        created_at: new Date().toISOString(),
        source: "agent",
        metadata: params.metadata ?? {},
      },
      createdAt: new Date(),
    });
    return { id };
  }

  async findSimilar(embedding: number[], limit = 5): Promise<any[]> {
    const vectorStr = `[${embedding.join(",")}]`;
    const result = await this.db.execute(
      sql`SELECT *, embedding <=> ${vectorStr}::vector AS distance
          FROM assets
          WHERE embedding IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${limit}`,
    );
    return result;
  }
}
