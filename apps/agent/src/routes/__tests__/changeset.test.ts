import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { changeset } from "../changeset.js";

const app = new Hono();
app.route("/changeset", changeset);

describe("Changeset routes", () => {
  describe("POST /changeset/approve", () => {
    it("returns approved status with changesetId", async () => {
      const res = await app.request("/changeset/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changesetId: "cs-abc123" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "approved", changesetId: "cs-abc123" });
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
    it("returns rejected status with changesetId", async () => {
      const res = await app.request("/changeset/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changesetId: "cs-xyz789" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "rejected", changesetId: "cs-xyz789" });
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
    it("returns changeset shape with the given id and pending status", async () => {
      const res = await app.request("/changeset/cs-001");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ changesetId: "cs-001", status: "pending" });
    });

    it("returns different ids correctly", async () => {
      const res = await app.request("/changeset/my-changeset-99");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.changesetId).toBe("my-changeset-99");
      expect(body.status).toBe("pending");
    });
  });
});
