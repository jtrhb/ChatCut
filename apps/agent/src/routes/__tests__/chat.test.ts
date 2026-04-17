import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createChatRouter } from "../chat.js";
import { SessionStore } from "../../session/session-store.js";
import { SessionManager } from "../../session/session-manager.js";

const sessionManager = new SessionManager(new SessionStore());

const app = new Hono();
app.route("/chat", createChatRouter({ sessionManager }));

// DI-wired app for session tests (separate instance)
const diSessionManager = new SessionManager(new SessionStore());
const diApp = new Hono();
diApp.route("/chat", createChatRouter({ sessionManager: diSessionManager }));

describe("POST /chat", () => {
  it("rejects request with missing projectId (400)", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects request with non-UUID projectId (400)", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "not-a-uuid", message: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects request with empty message (400)", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        message: "",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects request with missing message (400)", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "550e8400-e29b-41d4-a716-446655440000" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid request and returns processing status (200)", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Cut the first clip at 5 seconds",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ status: "processing", sessionId: expect.any(String) });
  });
});

describe("POST /chat (DI-wired)", () => {
  it("rejects session belonging to a different project (403)", async () => {
    // Create session for project A
    const createRes = await diApp.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "00000000-0000-0000-0000-000000000001",
        message: "Hello from project A",
      }),
    });
    const { sessionId } = await createRes.json() as any;

    // Try to use that session with project B
    const crossRes = await diApp.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "00000000-0000-0000-0000-000000000002",
        message: "Hello from project B",
        sessionId,
      }),
    });
    expect(crossRes.status).toBe(403);
    const body = await crossRes.json() as any;
    expect(body.error).toContain("does not belong");
  });

  it("allows resuming session with the correct project (200)", async () => {
    const projectId = "00000000-0000-0000-0000-000000000003";
    const createRes = await diApp.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, message: "First message" }),
    });
    const { sessionId } = await createRes.json() as any;

    const resumeRes = await diApp.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, message: "Second message", sessionId }),
    });
    expect(resumeRes.status).toBe(200);
    const body = await resumeRes.json() as any;
    expect(body.sessionId).toBe(sessionId);
  });
});
