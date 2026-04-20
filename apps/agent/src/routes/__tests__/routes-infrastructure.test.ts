import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createCommandsRouter } from "../commands.js";
import { createProjectRouter } from "../project.js";
import { createMediaRouter } from "../media.js";
import type { ProjectContextManager } from "../../context/project-context.js";
import { ServerEditorCore } from "../../services/server-editor-core.js";
import { CoreRegistry } from "../../services/core-registry.js";
import type { MutationDB } from "../../services/commit-mutation.js";
import type { CommandFactory } from "../commands.js";

// Trivial factory: any (type, params) → a stub Command. Tests that want
// the commitMutation path to succeed pass this; tests for the
// "no-factory" guard omit it.
const stubCommandFactory: CommandFactory = (_type, _params) => ({
  execute: () => {},
  undo: () => {},
} as unknown as import("@opencut/core").Command);

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
// /commands with CoreRegistry + MutationDB — Phase 2C-2 commitMutation path
// ---------------------------------------------------------------------------
// Mirrors the existing makeMockServerEditorCore pattern (which mocks
// because the route's `{type, ...params}` shape is not a real Command —
// real EditorCore would throw at execute time). We need clone() and
// replaceRuntime() too because commitMutation calls them.
function makeMockCore(initialVersion: number): any {
  let version = initialVersion;
  const state = { project: null, scenes: [], activeSceneId: null };
  const self: any = {
    get snapshotVersion() { return version; },
    validateVersion(v: number) {
      if (version !== v) throw new Error(`Stale snapshot version: expected ${v}, got ${version}`);
    },
    executeHumanCommand() { version++; },
    executeAgentCommand() { version++; },
    clone() { return makeMockCore(version); },
    replaceRuntime(donor: any) { version = donor.snapshotVersion; },
    serialize() { return state; },
  };
  return self;
}

function makeRegistryAndDB(opts: {
  initialVersion?: number;
  insertedChangeId?: string;
  failOn?: "insert" | "update";
} = {}): {
  coreRegistry: CoreRegistry;
  mutationDB: MutationDB;
  liveCore: any;
  insertSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
} {
  const liveCore = makeMockCore(opts.initialVersion ?? 0);
  const coreRegistry = {
    get: async () => liveCore,
    has: () => true,
    invalidate: () => {},
    evictIdle: () => [],
  } as unknown as CoreRegistry;

  const insertSpy = vi.fn(async () => ({ id: opts.insertedChangeId ?? "ch-1" }));
  const updateSpy = vi.fn(async () => {});
  if (opts.failOn === "insert") insertSpy.mockRejectedValue(new Error("insert failed"));
  if (opts.failOn === "update") updateSpy.mockRejectedValue(new Error("update failed"));
  const mutationDB: MutationDB = {
    transaction: async (fn) =>
      fn({
        insertChangeLogEntry: insertSpy,
        updateProjectSnapshot: updateSpy,
      }),
  };
  return { coreRegistry, mutationDB, liveCore, insertSpy, updateSpy };
}

describe("/commands with coreRegistry + mutationDB (Phase 2C-2)", () => {
  it("routes through commitMutation when projectId + factory are present; returns success + new version + changeId", async () => {
    const { coreRegistry, mutationDB, insertSpy, updateSpy } = makeRegistryAndDB({
      initialVersion: 4,
      insertedChangeId: "ch-42",
    });
    const app = new Hono();
    app.route("/commands", createCommandsRouter({ coreRegistry, mutationDB, commandFactory: stubCommandFactory }));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { id: "el-1", clipId: "abc-123" },
        baseSnapshotVersion: 4,
        projectId: "proj-A",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.snapshotVersion).toBe(5);
    expect(body.changeId).toBe("ch-42");
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 409 with stale-version error when baseSnapshotVersion doesn't match", async () => {
    const { coreRegistry, mutationDB, insertSpy } = makeRegistryAndDB({
      initialVersion: 7,
    });
    const app = new Hono();
    app.route("/commands", createCommandsRouter({ coreRegistry, mutationDB, commandFactory: stubCommandFactory }));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { id: "el-1", clipId: "abc-123" },
        baseSnapshotVersion: 4,
        projectId: "proj-A",
      }),
    });

    expect(res.status).toBe(409);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns 500 with persisted:false when DB tx update fails (live core unchanged)", async () => {
    const { coreRegistry, mutationDB, liveCore } = makeRegistryAndDB({
      initialVersion: 0,
      failOn: "update",
    });
    const app = new Hono();
    app.route("/commands", createCommandsRouter({ coreRegistry, mutationDB, commandFactory: stubCommandFactory }));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { id: "el-1", clipId: "abc-123" },
        baseSnapshotVersion: 0,
        projectId: "proj-A",
      }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.persisted).toBe(false);

    // Live core's version still 0 (live not touched on tx failure)
    expect(liveCore.snapshotVersion).toBe(0);
  });

  // Reviewer HIGH #4: when registry+DB are wired, missing projectId is
  // a 400 (not a silent singleton fallback). The pre-fix test that
  // exercised the silent fallback codified the §A.3 isolation bug as a
  // contract — flipping the assertion closes that contract.
  it("returns 400 when projectId is omitted but registry+DB are wired (no silent singleton fallback)", async () => {
    const { coreRegistry, mutationDB, insertSpy } = makeRegistryAndDB();
    const singleton = makeMockServerEditorCore({ snapshotVersion: 9 });
    const app = new Hono();
    app.route(
      "/commands",
      createCommandsRouter({
        serverEditorCore: singleton,
        coreRegistry,
        mutationDB,
        commandFactory: stubCommandFactory,
      }),
    );

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { id: "el-1", clipId: "abc-123" },
        baseSnapshotVersion: 9,
        // no projectId
      }),
    });

    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
    // Singleton untouched
    expect(singleton.snapshotVersion).toBe(9);
  });

  // Reviewer MEDIUM #6: missing params.id surfaces as 400, not as a
  // change_log row with targetId="unknown".
  it("returns 400 when params.id is missing (audit trail integrity)", async () => {
    const { coreRegistry, mutationDB, insertSpy } = makeRegistryAndDB();
    const app = new Hono();
    app.route("/commands", createCommandsRouter({ coreRegistry, mutationDB, commandFactory: stubCommandFactory }));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { clipId: "abc-123" }, // no `id`
        baseSnapshotVersion: 0,
        projectId: "proj-A",
      }),
    });

    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  // Reviewer HIGH #5: no commandFactory wired → 400 instead of letting a
  // synthesised `{type, ...params}` reach commitMutation and crash.
  it("returns 400 when no commandFactory is registered (HIGH #5 guard)", async () => {
    const { coreRegistry, mutationDB, insertSpy } = makeRegistryAndDB();
    const app = new Hono();
    app.route("/commands", createCommandsRouter({ coreRegistry, mutationDB }));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { id: "el-1", clipId: "abc-123" },
        baseSnapshotVersion: 0,
        projectId: "proj-A",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/dispatcher|factory|command type/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  // Singleton fallback still works when registry/DB are NOT wired (dev
  // boot path) — projectId is irrelevant in that mode.
  it("singleton path still works when registry+DB are absent (dev boot)", async () => {
    const singleton = makeMockServerEditorCore({ snapshotVersion: 9 });
    const app = new Hono();
    app.route("/commands", createCommandsRouter({ serverEditorCore: singleton }));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CUT_CLIP",
        params: { clipId: "abc-123" },
        baseSnapshotVersion: 9,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.snapshotVersion).toBe(10);
    expect(body.changeId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /project with mock contextManager — returns real data
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// /project with coreRegistry — Phase 2D registry-backed hydration
// ---------------------------------------------------------------------------
describe("/project with coreRegistry (Phase 2D)", () => {
  it("returns the per-project snapshot + version from the registry", async () => {
    const liveCore = makeMockCore(11);
    const coreRegistry = {
      get: async () => liveCore,
      has: () => true,
      invalidate: () => {},
      evictIdle: () => [],
    } as unknown as CoreRegistry;
    const app = new Hono();
    app.route("/project", createProjectRouter({ coreRegistry }));

    const res = await app.request("/project/proj-A");

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.projectId).toBe("proj-A");
    expect(body.snapshotVersion).toBe(11);
    expect(body.timeline).toBeDefined();
    expect(body._warning).toBeUndefined(); // legacy warn doesn't appear on the registry path
  });

  it("returns 404 when the registry rejects (project not found)", async () => {
    const coreRegistry = {
      get: async () => { throw new Error("Project not found: missing"); },
      has: () => false,
      invalidate: () => {},
      evictIdle: () => [],
    } as unknown as CoreRegistry;
    const app = new Hono();
    app.route("/project", createProjectRouter({ coreRegistry }));

    const res = await app.request("/project/missing");

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/missing/);
  });

  it("prefers the registry path over the legacy contextManager when both are wired", async () => {
    const liveCore = makeMockCore(2);
    const coreRegistry = {
      get: async () => liveCore,
      has: () => true,
      invalidate: () => {},
      evictIdle: () => [],
    } as unknown as CoreRegistry;
    const contextManager = makeMockContextManager({
      timelineState: '{"scenes":["legacy"]}',
      snapshotVersion: 99,
    });
    const app = new Hono();
    app.route("/project", createProjectRouter({ coreRegistry, contextManager }));

    const res = await app.request("/project/proj-A");

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Came from the mock core (version 2), NOT the contextManager (version 99)
    expect(body.snapshotVersion).toBe(2);
    expect(body._warning).toBeUndefined();
  });
});

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
