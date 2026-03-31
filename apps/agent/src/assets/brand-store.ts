import { randomUUID } from "crypto";

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
    await this.db.insert("brand_kits", {
      id,
      user_id: params.userId,
      name: params.name,
      colors: params.colors ?? [],
      fonts: params.fonts ?? [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { id };
  }

  async get(brandId: string): Promise<any | null> {
    return this.db.findOne("brand_kits", { id: brandId });
  }
}
