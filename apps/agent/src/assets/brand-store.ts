import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { brandKits } from "../db/schema.js";

export interface BrandCreateParams {
  userId: string;
  name: string;
  colors?: string[];
  fonts?: string[];
}

export class BrandStore {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  async create(params: BrandCreateParams): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(brandKits).values({
      id,
      name: params.name,
      brandSlug: params.name.toLowerCase().replace(/\s+/g, "-"),
      visualConfig: {
        colors: params.colors ?? [],
        fonts: params.fonts ?? [],
      },
      createdAt: new Date(),
    });
    return { id };
  }

  async get(brandId: string): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(brandKits)
      .where(eq(brandKits.id, brandId));
    return rows[0] ?? null;
  }
}
