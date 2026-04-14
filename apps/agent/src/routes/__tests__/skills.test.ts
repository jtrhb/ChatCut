import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createSkillsRouter } from "../skills.js";

function createMockDeps() {
  return {
    skillStore: {
      search: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getPerformance: vi.fn(),
    },
    memoryStore: {
      deleteFile: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("/skills API", () => {
  let app: Hono;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    app = new Hono();
    app.route("/skills", createSkillsRouter(deps as any));
  });

  it("GET /skills returns list", async () => {
    deps.skillStore.search.mockResolvedValue([
      { id: "s1", name: "Pacing", skillStatus: "draft" },
    ]);
    const res = await app.request("/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Pacing");
  });

  it("GET /skills/:id returns skill with performance", async () => {
    deps.skillStore.findById.mockResolvedValue({
      id: "s1", name: "Pacing", skillStatus: "draft",
      content: "# Pacing", frontmatter: {},
    });
    deps.skillStore.getPerformance.mockResolvedValue({
      approveCount: 3, rejectCount: 1, sessionsSeen: 2,
      consecutiveRejects: 0, createdSessionId: "x", lastSessionId: "y",
    });
    const res = await app.request("/skills/s1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.performance.approveCount).toBe(3);
  });

  it("GET /skills/:id returns 404 for missing", async () => {
    deps.skillStore.findById.mockResolvedValue(null);
    const res = await app.request("/skills/missing");
    expect(res.status).toBe(404);
  });

  it("POST /skills/:id/approve updates to validated", async () => {
    deps.skillStore.findById.mockResolvedValue({ id: "s1", skillStatus: "draft" });
    const res = await app.request("/skills/s1/approve", { method: "POST" });
    expect(res.status).toBe(200);
    expect(deps.skillStore.updateStatus).toHaveBeenCalledWith("s1", "validated");
  });

  it("POST /skills/:id/deprecate updates to deprecated", async () => {
    deps.skillStore.findById.mockResolvedValue({ id: "s1", skillStatus: "draft" });
    const res = await app.request("/skills/s1/deprecate", { method: "POST" });
    expect(res.status).toBe(200);
    expect(deps.skillStore.updateStatus).toHaveBeenCalledWith("s1", "deprecated");
  });

  it("DELETE /skills/:id removes from DB and R2", async () => {
    deps.skillStore.findById.mockResolvedValue({
      id: "s1", frontmatter: { scope: "brand:acme" },
    });
    const res = await app.request("/skills/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deps.skillStore.delete).toHaveBeenCalledWith("s1");
    expect(deps.memoryStore.deleteFile).toHaveBeenCalled();
  });
});
