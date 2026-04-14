import type { SkillStore, SkillPerformance } from "../assets/skill-store.js";
import type { MemoryStore } from "../memory/memory-store.js";

const PROMOTION_THRESHOLD = 3;       // approvals needed
const PROMOTION_MIN_SESSIONS = 2;    // distinct sessions needed
const DEPRECATION_CONSECUTIVE = 3;   // consecutive rejects to deprecate

export class SkillValidator {
  constructor(
    private skillStore: SkillStore,
    private memoryStore: MemoryStore,
  ) {}

  async recordOutcome(
    skillId: string,
    sessionId: string,
    approved: boolean,
  ): Promise<void> {
    await this.skillStore.recordOutcome(skillId, sessionId, approved);
  }

  async evaluateAndApply(
    skillId: string,
  ): Promise<"promoted" | "deprecated" | "unchanged"> {
    const skill = await this.skillStore.findById(skillId);
    if (!skill || skill.skillStatus !== "draft") {
      return "unchanged";
    }

    const perf = await this.skillStore.getPerformance(skillId);
    if (!perf) return "unchanged";

    // Deprecate: 3+ consecutive rejects
    if (perf.consecutiveRejects >= DEPRECATION_CONSECUTIVE) {
      await this.skillStore.updateStatus(skillId, "deprecated");
      return "deprecated";
    }

    // Session gate: must have reinforcements from different sessions
    if (perf.sessionsSeen < PROMOTION_MIN_SESSIONS) {
      return "unchanged";
    }

    // Same-session gate: lastSessionId must differ from createdSessionId
    if (perf.createdSessionId && perf.lastSessionId === perf.createdSessionId) {
      return "unchanged";
    }

    // Promote: 3+ approvals across 2+ sessions
    if (perf.approveCount >= PROMOTION_THRESHOLD) {
      await this.skillStore.updateStatus(skillId, "validated");
      return "promoted";
    }

    return "unchanged";
  }
}
