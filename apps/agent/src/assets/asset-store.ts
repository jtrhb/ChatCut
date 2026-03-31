import { randomUUID } from "crypto";

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
    await this.db.insert("assets", {
      id,
      user_id: params.userId,
      type: params.type,
      name: params.name,
      storage_key: params.storageKey,
      metadata: params.metadata ?? {},
      tags: params.tags ?? [],
      generation_context: {
        created_at: new Date().toISOString(),
        source: "agent",
      },
      created_at: new Date().toISOString(),
    });
    return { id };
  }

  async search(params: AssetSearchParams): Promise<any[]> {
    const filters: Record<string, unknown> = { user_id: params.userId };
    if (params.type !== undefined) filters.type = params.type;

    const results: any[] = await this.db.select("assets", filters);

    if (params.query) {
      const q = params.query.toLowerCase();
      return results.filter(
        (a: any) =>
          (a.name as string).toLowerCase().includes(q) ||
          (a.tags as string[]).some((t: string) => t.toLowerCase().includes(q))
      );
    }

    return results;
  }
}
