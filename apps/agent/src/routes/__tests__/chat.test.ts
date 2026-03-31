import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { chat } from "../chat.js";

const app = new Hono();
app.route("/chat", chat);

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
    const body = await res.json();
    expect(body).toMatchObject({ status: "processing", sessionId: expect.any(String) });
  });
});
