import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { changeset, createChangesetRouter } from "../changeset.js";

describe("Changeset routes (no ChangesetManager)", () => {
  const app = new Hono();
  app.route("/changeset", changeset);

  describe("POST /changeset/approve", () => {
    it("returns 503 when ChangesetManager not configured", async () => {
      const res = await app.request("/changeset/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changesetId: "cs-abc123" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json() as any;
      expect(body.error).toContain("ChangesetManager not configured");
    });

    it("rejects missing changesetId with 400", async () => {
      const res = await app.request("/changeset/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /changeset/reject", () => {
    it("returns 503 when ChangesetManager not configured", async () => {
      const res = await app.request("/changeset/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changesetId: "cs-xyz789" }),
      });
      expect(res.status).toBe(503);
    });

    it("rejects missing changesetId with 400", async () => {
      const res = await app.request("/changeset/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /changeset/:id", () => {
    it("returns 503 when ChangesetManager not configured", async () => {
      const res = await app.request("/changeset/cs-001");
      expect(res.status).toBe(503);
    });
  });
});
