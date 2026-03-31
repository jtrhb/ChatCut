import { randomUUID } from "crypto";

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
    await this.db.insert("skills", {
      id,
      user_id: params.userId,
      name: params.name,
      agent_type: params.agentType,
      scope_level: params.scopeLevel,
      content: params.content,
      usage_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { id };
  }

  async search(params: SkillSearchParams): Promise<any[]> {
    const filters: Record<string, unknown> = { user_id: params.userId };
    if (params.agentType !== undefined) filters.agent_type = params.agentType;
    if (params.scopeLevel !== undefined) filters.scope_level = params.scopeLevel;

    return this.db.select("skills", filters);
  }

  async incrementUsage(skillId: string): Promise<void> {
    await this.db.update("skills", skillId, { usage_count: { $increment: 1 } });
  }
}
