import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { changeset, createChangesetRouter } from "../changeset.js";
import { ChangeLog } from "@opencut/core";
import { ServerEditorCore } from "../../services/server-editor-core.js";
import { ChangesetManager } from "../../changeset/changeset-manager.js";
import type { SerializedEditorState } from "@opencut/core";

const emptyState: SerializedEditorState = {
  project: null,
  scenes: [],
  activeSceneId: null,
};

function validBody(changesetId: string, projectId = "proj-1") {
  return JSON.stringify({ changesetId, projectId });
}

const OWNER = "alice";

describe("Changeset routes (no ChangesetManager)", () => {
  const app = new Hono();
  app.route("/changeset", changeset);

  describe("POST /changeset/approve", () => {
    it("returns 503 when ChangesetManager not configured", async () => {
      const res = await app.request("/changeset/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": OWNER },
        body: validBody("cs-abc123"),
      });
      expect(res.status).toBe(503);
      const body = await res.json() as any;
      expect(body.error).toContain("ChangesetManager not configured");
    });

    it("rejects missing changesetId with 400", async () => {
      const res = await app.request("/changeset/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing projectId with 400 (B5 owner check needs it)", async () => {
      const res = await app.request("/changeset/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ changesetId: "cs-1" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /changeset/reject", () => {
    it("returns 503 when ChangesetManager not configured", async () => {
      const res = await app.request("/changeset/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": OWNER },
        body: validBody("cs-xyz789"),
      });
      expect(res.status).toBe(503);
    });

    it("rejects missing changesetId with 400", async () => {
      const res = await app.request("/changeset/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": OWNER },
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

describe("B5: Changeset routes (wired ChangesetManager)", () => {
  let app: Hono;
  let manager: ChangesetManager;
  let serverCore: ServerEditorCore;
  let changeLog: ChangeLog;

  beforeEach(() => {
    changeLog = new ChangeLog();
    serverCore = ServerEditorCore.fromSnapshot(emptyState);
    manager = new ChangesetManager({ changeLog, serverCore });
    app = new Hono();
    app.route("/changeset", createChangesetRouter({ changesetManager: manager }));
  });

  it("requires x-user-id header (returns 401 when missing)", async () => {
    const cs = await manager.propose({
      summary: "s",
      affectedElements: [],
      userId: OWNER,
      projectId: "proj-1",
    });
    const res = await app.request("/changeset/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody(cs.changesetId),
    });
    expect(res.status).toBe(401);
  });

  it("review design-flag fix: 401 gates BEFORE body validation (don't leak schema to unauth callers)", async () => {
    // Missing header AND invalid body. Prior behavior: Zod-first → 400,
    // which leaked the body schema (via `issues`) to unauthenticated
    // callers. Fix: auth-first → 401, no schema hints.
    const res = await app.request("/changeset/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ /* no changesetId, no projectId */ }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string; issues?: unknown };
    expect(body.issues).toBeUndefined();
  });

  it("review design-flag fix: reject path also gates auth BEFORE body validation", async () => {
    const res = await app.request("/changeset/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("approves successfully when actor matches owner", async () => {
    const cs = await manager.propose({
      summary: "s",
      affectedElements: [],
      userId: OWNER,
      projectId: "proj-1",
    });
    const res = await app.request("/changeset/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": OWNER },
      body: validBody(cs.changesetId),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("approved");
    expect(manager.getChangeset(cs.changesetId)!.status).toBe("approved");
  });

  it("returns 403 when actor is not the owner (IDOR closure)", async () => {
    const cs = await manager.propose({
      summary: "s",
      affectedElements: [],
      userId: OWNER,
      projectId: "proj-1",
    });
    const res = await app.request("/changeset/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": "eve" },
      body: validBody(cs.changesetId),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.kind).toBe("owner-mismatch");
    // Must not mutate the changeset
    expect(manager.getChangeset(cs.changesetId)!.status).toBe("pending");
  });

  it("returns 409 when editor state is stale (StaleStateError)", async () => {
    const cs = await manager.propose({
      summary: "s",
      affectedElements: [],
      userId: OWNER,
      projectId: "proj-1",
    });
    // Simulate concurrent mutation bumping the version
    (serverCore as unknown as { _version: number })._version++;

    const res = await app.request("/changeset/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": OWNER },
      body: validBody(cs.changesetId),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.kind).toBe("stale-state");
    expect(body.details.changesetId).toBe(cs.changesetId);
  });

  it("returns 404 when changeset id doesn't exist", async () => {
    const res = await app.request("/changeset/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": OWNER },
      body: validBody("does-not-exist"),
    });
    expect(res.status).toBe(404);
  });

  it("reject path enforces owner + staleness the same way", async () => {
    const cs = await manager.propose({
      summary: "s",
      affectedElements: [],
      userId: OWNER,
      projectId: "proj-1",
    });

    // Wrong owner → 403
    const idor = await app.request("/changeset/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": "eve" },
      body: validBody(cs.changesetId),
    });
    expect(idor.status).toBe(403);

    // Correct owner → 200
    const ok = await app.request("/changeset/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": OWNER },
      body: validBody(cs.changesetId),
    });
    expect(ok.status).toBe(200);
  });
});
