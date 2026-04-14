import { randomUUID } from "crypto";
import { eq, and, sql, type SQL } from "drizzle-orm";
import { skills } from "../db/schema.js";

export interface SkillPerformance {
  approveCount: number;
  rejectCount: number;
  sessionsSeen: number;
  consecutiveRejects: number;
  createdSessionId: string | null;
  lastSessionId: string | null;
}

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

    const conditions: SQL<unknown>[] = [];
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

  async findById(id: string): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.id, id));
    return rows[0] ?? null;
  }

  async updateStatus(
    id: string,
    status: "draft" | "validated" | "deprecated",
  ): Promise<void> {
    await this.db
      .update(skills)
      .set({ skillStatus: status, updatedAt: new Date() })
      .where(eq(skills.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(skills).where(eq(skills.id, id));
  }

  async recordOutcome(
    id: string,
    sessionId: string,
    approved: boolean,
  ): Promise<void> {
    if (approved) {
      await this.db
        .update(skills)
        .set({
          approveCount: sql`${skills.approveCount} + 1`,
          consecutiveRejects: 0,
          lastSessionId: sessionId,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, id));
    } else {
      await this.db
        .update(skills)
        .set({
          rejectCount: sql`${skills.rejectCount} + 1`,
          consecutiveRejects: sql`${skills.consecutiveRejects} + 1`,
          lastSessionId: sessionId,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, id));
    }
  }

  async getPerformance(id: string): Promise<SkillPerformance | null> {
    const rows = await this.db
      .select({
        approveCount: skills.approveCount,
        rejectCount: skills.rejectCount,
        sessionsSeen: skills.sessionsSeen,
        consecutiveRejects: skills.consecutiveRejects,
        createdSessionId: skills.createdSessionId,
        lastSessionId: skills.lastSessionId,
      })
      .from(skills)
      .where(eq(skills.id, id));
    return rows[0] ?? null;
  }
}
