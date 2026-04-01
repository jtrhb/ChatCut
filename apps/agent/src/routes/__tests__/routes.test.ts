import { describe, it, expect } from "vitest";
import { createApp } from "../../server.js";

describe("HTTP Routes", () => {
  const app = createApp();

  // 1. GET /health
  describe("GET /health", () => {
    it("returns 200 with { status: 'ok' }", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok" });
    });
  });

  // 2. POST /commands — rejects empty body
  describe("POST /commands", () => {
    it("rejects empty body with 400", async () => {
      const res = await app.request("/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing params with 400", async () => {
      const res = await app.request("/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "CUT_CLIP" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-number baseSnapshotVersion with 400", async () => {
      const res = await app.request("/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "CUT_CLIP",
          params: { clipId: "abc" },
          baseSnapshotVersion: "not-a-number",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid command body with 200 and success shape", async () => {
      const res = await app.request("/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "CUT_CLIP",
          params: { clipId: "abc-123" },
          baseSnapshotVersion: 0,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, snapshotVersion: expect.any(Number) });
    });
  });

  // 3. GET /project/:id
  describe("GET /project/:id", () => {
    it("returns project shape with correct id", async () => {
      const res = await app.request("/project/proj-42");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        projectId: "proj-42",
        snapshotVersion: 0,
        timeline: null,
      });
    });

    it("returns different ids correctly", async () => {
      const res = await app.request("/project/my-project");
      const body = await res.json();
      expect(body.projectId).toBe("my-project");
    });
  });

  // 4. GET /status
  describe("GET /status", () => {
    it("returns agent status shape", async () => {
      const res = await app.request("/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        agentStatus: expect.any(String),
        activeSessions: expect.any(Number),
        queuedTasks: expect.any(Number),
        runningTasks: expect.any(Number),
      });
    });

    it("returns idle status by default", async () => {
      const res = await app.request("/status");
      const body = await res.json();
      expect(body.agentStatus).toBe("idle");
      expect(body.activeSessions).toBe(0);
      expect(body.queuedTasks).toBe(0);
      expect(body.runningTasks).toBe(0);
    });
  });

  // 5. POST /media/finalize
  describe("POST /media/finalize", () => {
    it("returns mediaId", async () => {
      const res = await app.request("/media/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("mediaId");
    });
  });

  // 6. GET /media/:id
  describe("GET /media/:id", () => {
    it("returns url for media id", async () => {
      const res = await app.request("/media/media-123");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("url");
    });
  });

  // 7. GET /events — SSE stub
  describe("GET /events", () => {
    it("responds with 200 and text/event-stream content type", async () => {
      const res = await app.request("/events");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });
  });
});

describe("DI-wired routes", () => {
  const app = createApp();

  it("GET /status returns real session and task counts", async () => {
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("activeSessions");
    expect(body).toHaveProperty("queuedTasks");
    expect(body).toHaveProperty("runningTasks");
  });

  it("POST /chat creates a real session", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "00000000-0000-0000-0000-000000000001",
        message: "Hello",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).not.toBe("placeholder");
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});
