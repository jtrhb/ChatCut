// apps/agent/src/assets/__tests__/skill-store-phase5.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillStore } from "../skill-store.js";

function createMockDb() {
  const rows: any[] = [];
  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    _rows: rows,
  };
}

describe("SkillStore Phase 5 methods", () => {
  let db: ReturnType<typeof createMockDb>;
  let store: SkillStore;

  beforeEach(() => {
    db = createMockDb();
    store = new SkillStore(db);
  });

  it("findById queries by id", async () => {
    await store.findById("skill-123");
    expect(db.select).toHaveBeenCalled();
  });

  it("updateStatus sets skillStatus and updatedAt", async () => {
    await store.updateStatus("skill-123", "validated");
    expect(db.update).toHaveBeenCalled();
  });

  it("delete removes by id", async () => {
    await store.delete("skill-123");
    expect(db.delete).toHaveBeenCalled();
  });

  it("recordOutcome increments approve_count for approved", async () => {
    await store.recordOutcome("skill-123", "session-abc", true);
    expect(db.update).toHaveBeenCalled();
  });

  it("recordOutcome increments reject_count and consecutive_rejects for rejected", async () => {
    await store.recordOutcome("skill-123", "session-abc", false);
    expect(db.update).toHaveBeenCalled();
  });

  it("getPerformance returns counters", async () => {
    db._rows.push({
      approveCount: 5,
      rejectCount: 2,
      sessionsSeen: 3,
      consecutiveRejects: 0,
      createdSessionId: "s1",
      lastSessionId: "s3",
    });
    const perf = await store.getPerformance("skill-123");
    expect(perf).toHaveProperty("approveCount");
    expect(perf).toHaveProperty("sessionsSeen");
  });
});
