import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { brandKits, brandAssetLinks, assets } from "../db/schema.js";

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

  async linkAsset(brandId: string, assetId: string, role: string): Promise<void> {
    await this.db.insert(brandAssetLinks).values({
      id: randomUUID(),
      brandId,
      assetId,
      assetRole: role,
    });
  }

  async getWithAssets(
    brandId: string,
  ): Promise<{ brand: any; assets: any[] }> {
    const brand = await this.get(brandId);
    if (!brand) return { brand: null, assets: [] };

    const linked = await this.db
      .select()
      .from(brandAssetLinks)
      .innerJoin(assets, eq(brandAssetLinks.assetId, assets.id))
      .where(eq(brandAssetLinks.brandId, brandId));

    return {
      brand,
      assets: linked.map((row: any) => ({
        ...row.assets,
        role: row.brand_asset_links.assetRole,
      })),
    };
  }
}
