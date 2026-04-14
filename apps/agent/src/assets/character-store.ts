import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { characters, characterAssets, assets } from "../db/schema.js";

export class CharacterStore {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  async getById(id: string): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(eq(characters.id, id));
    return rows[0] ?? null;
  }

  async getByName(name: string, projectId?: string): Promise<any | null> {
    const conditions = [eq(characters.name, name)];
    if (projectId) conditions.push(eq(characters.projectId, projectId));
    const rows = await this.db
      .select()
      .from(characters)
      .where(and(...conditions));
    return rows[0] ?? null;
  }

  async create(params: {
    name: string;
    description?: string;
    projectId?: string;
  }): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(characters).values({
      id,
      name: params.name,
      description: params.description,
      projectId: params.projectId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id };
  }

  async linkAsset(
    characterId: string,
    assetId: string,
    role = "reference",
  ): Promise<void> {
    await this.db.insert(characterAssets).values({
      id: randomUUID(),
      characterId,
      assetId,
      role,
    });
  }

  async getWithAssets(
    characterId: string,
  ): Promise<{ character: any; assets: any[] }> {
    const character = await this.getById(characterId);
    if (!character) return { character: null, assets: [] };

    const linked = await this.db
      .select()
      .from(characterAssets)
      .innerJoin(assets, eq(characterAssets.assetId, assets.id))
      .where(eq(characterAssets.characterId, characterId));

    return {
      character,
      assets: linked.map((row: any) => ({
        ...row.assets,
        role: row.character_assets.role,
      })),
    };
  }
}
