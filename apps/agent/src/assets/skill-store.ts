import { randomUUID } from "crypto";
import { eq, and, sql } from "drizzle-orm";
import { skills } from "../db/schema.js";

export interface SkillSaveParams {
  userId: string;
  name: string;
  agentType: string;
  scopeLevel: string;
  content: string;
}

export interface SkillSearchParams {
  userId: string;
  agentType?: string;
  scopeLevel?: string;
}

export class SkillStore {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  async save(params: SkillSaveParams): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(skills).values({
      id,
      name: params.name,
      agentType: params.agentType,
      content: params.content,
      frontmatter: { scopeLevel: params.scopeLevel, userId: params.userId },
      skillStatus: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id };
  }

  async search(params: SkillSearchParams): Promise<any[]> {
    let query = this.db.select().from(skills);

    const conditions = [];
    if (params.agentType !== undefined) {
      conditions.push(eq(skills.agentType, params.agentType));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    return query;
  }

  async incrementUsage(skillId: string): Promise<void> {
    await this.db
      .update(skills)
      .set({ updatedAt: new Date() })
      .where(eq(skills.id, skillId));
  }
}
