import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillValidator } from "../skill-validator.js";

function createMockSkillStore() {
  return {
    findById: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    getPerformance: vi.fn(),
    incrementUsage: vi.fn(),
  };
}

function createMockMemoryStore() {
  return {
    readFile: vi.fn(),
    readParsed: vi.fn(),
    writeMemory: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn(),
    exists: vi.fn(),
  };
}

describe("SkillValidator", () => {
  let skillStore: ReturnType<typeof createMockSkillStore>;
  let memoryStore: ReturnType<typeof createMockMemoryStore>;
  let validator: SkillValidator;

  beforeEach(() => {
    skillStore = createMockSkillStore();
    memoryStore = createMockMemoryStore();
    validator = new SkillValidator(skillStore as any, memoryStore as any);
  });

  it("promotes after 3+ approvals across 2+ sessions", async () => {
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 4,
      rejectCount: 0,
      sessionsSeen: 3,
      consecutiveRejects: 0,
      createdSessionId: "s0",
      lastSessionId: "s3",
    });
    skillStore.findById.mockResolvedValue({
      id: "skill-1",
      skillStatus: "draft",
      frontmatter: { scope: "brand:acme" },
    });

    const result = await validator.evaluateAndApply("skill-1");

    expect(result).toBe("promoted");
    expect(skillStore.updateStatus).toHaveBeenCalledWith("skill-1", "validated");
  });

  it("deprecates after 3 consecutive rejects", async () => {
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 1,
      rejectCount: 4,
      sessionsSeen: 2,
      consecutiveRejects: 3,
      createdSessionId: "s0",
      lastSessionId: "s2",
    });
    skillStore.findById.mockResolvedValue({
      id: "skill-2",
      skillStatus: "draft",
      frontmatter: { scope: "brand:acme" },
    });

    const result = await validator.evaluateAndApply("skill-2");

    expect(result).toBe("deprecated");
    expect(skillStore.updateStatus).toHaveBeenCalledWith("skill-2", "deprecated");
  });

  it("refuses same-session promotion", async () => {
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 5,
      rejectCount: 0,
      sessionsSeen: 1,
      consecutiveRejects: 0,
      createdSessionId: "s1",
      lastSessionId: "s1",
    });
    skillStore.findById.mockResolvedValue({
      id: "skill-3",
      skillStatus: "draft",
      frontmatter: {},
    });

    const result = await validator.evaluateAndApply("skill-3");

    expect(result).toBe("unchanged");
    expect(skillStore.updateStatus).not.toHaveBeenCalled();
  });

  it("returns unchanged for already validated skills", async () => {
    skillStore.findById.mockResolvedValue({
      id: "skill-4",
      skillStatus: "validated",
      frontmatter: {},
    });
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 10,
      rejectCount: 0,
      sessionsSeen: 5,
      consecutiveRejects: 0,
      createdSessionId: "s0",
      lastSessionId: "s5",
    });

    const result = await validator.evaluateAndApply("skill-4");

    expect(result).toBe("unchanged");
  });

  it("recordOutcome delegates to skillStore", async () => {
    await validator.recordOutcome("skill-1", "session-abc", true);

    expect(skillStore.recordOutcome).toHaveBeenCalledWith("skill-1", "session-abc", true);
  });
});
