import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createCommandsRouter } from "../commands.js";
import { createProjectRouter } from "../project.js";
import { createMediaRouter } from "../media.js";
import type { ProjectContextManager } from "../../context/project-context.js";

// ---------------------------------------------------------------------------
// Minimal mock for ServerEditorCore
// ---------------------------------------------------------------------------
function makeMockServerEditorCore(overrides?: {
  snapshotVersion?: number;
}) {
  let version = overrides?.snapshotVersion ?? 5;
  return {
    get snapshotVersion() { return version; },
    validateVersion(expected: number) {
      if (expected !== version) {
        throw new Error(`Stale snapshot version: expected ${expected}, got ${version}`);
      }
    },
    executeHumanCommand(_command: unknown) {
      version++;
    },
  } as unknown as import("../../services/server-editor-core.js").ServerEditorCore;
}

// ---------------------------------------------------------------------------
// Minimal mock for ProjectContextManager
// ---------------------------------------------------------------------------
function makeMockContextManager(overrides?: {
  timelineState?: string;
  snapshotVersion?: number;
}): ProjectContextManager {
  const ctx = {
    timelineState: overrides?.timelineState ?? '{"scenes":[]}',
    snapshotVersion: overrides?.snapshotVersion ?? 3,
    videoAnalysis: null,
    currentIntent: { raw: "", parsed: "", explorationMode: false },
    memoryContext: { promptText: "", injectedMemoryIds: [], injectedSkillIds: [] },
    artifacts: {},
    recentChanges: [],
  };
  return {
    get: () => ctx,
  } as unknown as ProjectContextManager;
}

// ---------------------------------------------------------------------------
// /commands without infrastructure — returns error
// ---------------------------------------------------------------------------
describe("/commands without infrastructure", () => {
  const app = new Hono();
  app.route("/commands", createCommandsRouter());

  it("returns 503 with error when serverEditorCore is not provided", async () => {
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { clipId: "abc-123" },
        baseSnapshotVersion: 0,
      }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      error: "ServerEditorCore not configured",
      available: false,
    });
  });
});

// ---------------------------------------------------------------------------
// /project without infrastructure — returns error
// ---------------------------------------------------------------------------
describe("/project without infrastructure", () => {
  const app = new Hono();
  app.route("/project", createProjectRouter());

  it("returns 503 with error when contextManager is not provided", async () => {
    const res = await app.request("/project/test-project-id");
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      error: "ProjectContext not configured",
      available: false,
    });
  });
});

// ---------------------------------------------------------------------------
// /media without infrastructure — returns error
// ---------------------------------------------------------------------------
describe("/media without infrastructure", () => {
  const app = new Hono();
  app.route("/media", createMediaRouter());

  it("POST /media/finalize returns 503 with error when objectStorage is not provided", async () => {
    const res = await app.request("/media/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storageKey: "media/test.mp4" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      error: "ObjectStorage not configured",
      available: false,
    });
  });

  it("GET /media/:id returns 503 with error when objectStorage is not provided", async () => {
    const res = await app.request("/media/some-media-id");
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      error: "ObjectStorage not configured",
      available: false,
    });
  });
});

// ---------------------------------------------------------------------------
// /commands with mock serverEditorCore — returns real data
// ---------------------------------------------------------------------------
describe("/commands with mock serverEditorCore", () => {
  const serverEditorCore = makeMockServerEditorCore({ snapshotVersion: 5 });
  const app = new Hono();
  app.route("/commands", createCommandsRouter({ serverEditorCore }));

  it("returns 200 with success and incremented snapshotVersion on valid command", async () => {
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { clipId: "abc-123" },
        baseSnapshotVersion: 5,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ success: true, snapshotVersion: expect.any(Number) });
    // Version should have incremented after executing the command
    expect(body.snapshotVersion).toBe(6);
  });

  it("returns 409 when baseSnapshotVersion is stale", async () => {
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { clipId: "abc-123" },
        baseSnapshotVersion: 0,
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// /project with mock contextManager — returns real data
// ---------------------------------------------------------------------------
describe("/project with mock contextManager", () => {
  const contextManager = makeMockContextManager({
    timelineState: '{"scenes":["scene-1"]}',
    snapshotVersion: 7,
  });
  const app = new Hono();
  app.route("/project", createProjectRouter({ contextManager }));

  it("returns 200 with real project context data", async () => {
    const res = await app.request("/project/my-project-id");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      projectId: "my-project-id",
      snapshotVersion: 7,
      timeline: '{"scenes":["scene-1"]}',
    });
  });
});
