import { describe, it, expect, beforeEach } from "vitest";
import { ServerEditorCore } from "../services/server-editor-core.js";
import { EditorToolExecutor } from "../tools/editor-tools.js";
import { ChangesetManager } from "../changeset/changeset-manager.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import { ChangeLog } from "@opencut/core";
import type { SerializedEditorState, TScene } from "@opencut/core";

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildDefaultScene(): TScene {
  return {
    id: "default",
    name: "Scene 1",
    isMain: true,
    tracks: [],
    bookmarks: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildEmptyState(): SerializedEditorState {
  return {
    project: null,
    scenes: [buildDefaultScene()],
    activeSceneId: "default",
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Production wiring", () => {
  let serverEditorCore: ServerEditorCore;
  let editorToolExecutor: EditorToolExecutor;

  beforeEach(() => {
    serverEditorCore = ServerEditorCore.fromSnapshot(buildEmptyState());
    editorToolExecutor = new EditorToolExecutor(serverEditorCore);
  });

  describe("EditorToolExecutor", () => {
    it("executes get_timeline_state and returns actual state", async () => {
      const result = await editorToolExecutor.execute(
        "get_timeline_state",
        {},
        { agentType: "editor", taskId: "default" },
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it("reports hasToolName correctly for registered tools", () => {
      expect(editorToolExecutor.hasToolName("get_timeline_state")).toBe(true);
      expect(editorToolExecutor.hasToolName("trim_element")).toBe(true);
      expect(editorToolExecutor.hasToolName("nonexistent_tool")).toBe(false);
    });
  });

  describe("ChangesetManager", () => {
    it("creates real changesets via propose", async () => {
      const changeLog = new ChangeLog();
      const changesetManager = new ChangesetManager({
        changeLog,
        serverCore: serverEditorCore,
      });

      const changeset = await changesetManager.propose({
        summary: "Test changeset",
        affectedElements: ["el-1"],
      });

      expect(changeset.changesetId).toBeTruthy();
      expect(changeset.status).toBe("pending");
      expect(changeset.summary).toBe("Test changeset");

      // Verify it can be retrieved
      const pending = changesetManager.getPending();
      expect(pending).not.toBeNull();
      expect(pending!.changesetId).toBe(changeset.changesetId);
    });
  });

  describe("TaskRegistry", () => {
    it("creates real tasks", () => {
      const taskRegistry = new TaskRegistry();

      const task = taskRegistry.createTask({
        type: "export",
        description: "Export video",
        sessionId: "test-session",
      });

      expect(task.taskId).toBeTruthy();
      expect(task.status).toBe("queued");
      expect(task.type).toBe("export");

      // Verify it can be retrieved
      const retrieved = taskRegistry.getTask(task.taskId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.taskId).toBe(task.taskId);
    });
  });

  describe("toolExecutor routing", () => {
    it("routes editor tools to EditorToolExecutor", async () => {
      const toolExecutor = async (name: string, input: unknown) => {
        if (editorToolExecutor.hasToolName(name)) {
          return editorToolExecutor.execute(name, input, {
            agentType: "editor",
            taskId: "default",
          });
        }
        return { success: false, error: `Tool "${name}" has no registered executor` };
      };

      // Editor tool should route to EditorToolExecutor
      const result = await toolExecutor("get_timeline_state", {});
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it("returns explicit error for unregistered tools", async () => {
      const toolExecutor = async (name: string, input: unknown) => {
        if (editorToolExecutor.hasToolName(name)) {
          return editorToolExecutor.execute(name, input, {
            agentType: "editor",
            taskId: "default",
          });
        }
        return { success: false, error: `Tool "${name}" has no registered executor` };
      };

      const result = await toolExecutor("nonexistent_tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("no registered executor");
    });
  });

  describe("createWiredMasterAgent integration", () => {
    it("passes changesetManager and taskRegistry through", async () => {
      // This test verifies the wiring contract: createWiredMasterAgent
      // accepts and passes changesetManager/taskRegistry to MasterAgent.
      // We import the function directly rather than booting the full server.
      const { createWiredMasterAgent } = await import("../server.js");
      const { ProjectContextManager } = await import("../context/project-context.js");
      const { ProjectWriteLock } = await import("../context/write-lock.js");
      const { createEventBusHook } = await import("../tools/hooks.js");
      const { EventBus } = await import("../events/event-bus.js");

      const changeLog = new ChangeLog();
      const changesetManager = new ChangesetManager({
        changeLog,
        serverCore: serverEditorCore,
      });
      const taskRegistry = new TaskRegistry();
      const eventBus = new EventBus();

      // createWiredMasterAgent should accept these without error
      const masterAgent = createWiredMasterAgent({
        apiKey: "test-key",
        contextManager: new ProjectContextManager(),
        writeLock: new ProjectWriteLock(),
        eventBusHook: createEventBusHook(eventBus),
        skillContracts: [],
        subAgentDispatchers: new Map(),
        changesetManager,
        taskRegistry,
      });

      expect(masterAgent).toBeDefined();
    });
  });

  // ── Phase 1A smoke: memory + context-sync wiring ────────────────────────
  // The audit's largest dormant-module cluster (§B.MemoryStore et al.)
  // failed because nothing constructed the chain at boot. This test wires
  // the same chain index.ts now wires (memoryStore → MasterAgent →
  // writer-token callback → MemoryExtractor → ChangeLog subscription) and
  // proves a changeset_rejected event flows end-to-end into a memory
  // write. Without this wiring the rejection event had no listener, so
  // the regression target is "an emitted decision must reach the store."
  describe("Phase 1A: memory + context-sync wiring", () => {
    it("ChangeLog → MemoryExtractor write callback fires through MasterAgent's writer token", async () => {
      const { createWiredMasterAgent } = await import("../server.js");
      const { ProjectContextManager } = await import("../context/project-context.js");
      const { ProjectWriteLock } = await import("../context/write-lock.js");
      const { createEventBusHook } = await import("../tools/hooks.js");
      const { EventBus } = await import("../events/event-bus.js");
      const { MemoryExtractor } = await import("../memory/memory-extractor.js");
      const { ContextSynchronizer } = await import("../context/context-sync.js");

      // Fake store satisfies both the reader interface (used by the
      // extractor) and the token-gated writer interface (used by
      // MasterAgent.writeMemory under the hood). The token check passes
      // because MasterAgent claims the token via grantWriterToken on
      // construction and reuses it on writeMemory.
      const writtenToken: { current: symbol | null } = { current: null };
      const writes: Array<{ token: symbol; path: string; memory: any }> = [];
      const fakeStore: any = {
        listDir: async () => [],
        readParsed: async () => { throw new Error("not stored"); },
        exists: async () => false,
        grantWriterToken: () => {
          if (writtenToken.current) {
            throw new Error("token already granted");
          }
          writtenToken.current = Symbol("memory-writer");
          return writtenToken.current;
        },
        writeMemory: async (token: symbol, path: string, memory: any) => {
          writes.push({ token, path, memory });
        },
      };

      const changeLog = new ChangeLog();
      const contextSynchronizer = new ContextSynchronizer(changeLog);
      const eventBus = new EventBus();

      const masterAgent = createWiredMasterAgent({
        apiKey: "test-key",
        contextManager: new ProjectContextManager(),
        writeLock: new ProjectWriteLock(),
        eventBusHook: createEventBusHook(eventBus),
        skillContracts: [],
        subAgentDispatchers: new Map(),
        memoryStore: fakeStore,
        contextSynchronizer,
      });

      // Mirror index.ts: extractor uses the writer callback that's
      // bound to Master's claimed token.
      const writeMemory = masterAgent.getMemoryWriter();
      const extractor = new MemoryExtractor({
        changeLog,
        memoryReader: fakeStore,
        writeMemory,
      });
      extractor.start();

      // Trigger the chain: a recorded entry + a rejection decision.
      changeLog.record({
        source: "agent",
        changesetId: "cs-wire-smoke",
        action: { type: "delete", targetType: "element", targetId: "el-1", details: {} },
        summary: "Deleted clip",
      });
      changeLog.emitDecision({
        type: "changeset_rejected",
        changesetId: "cs-wire-smoke",
        timestamp: Date.now(),
      });

      // The extractor's listener is async; let microtasks settle.
      await new Promise((r) => setTimeout(r, 0));

      // Token must have been granted exactly once (Master claimed it).
      expect(writtenToken.current).not.toBeNull();
      // The decision event must have produced a draft-implicit memory.
      expect(writes.length).toBeGreaterThan(0);
      expect(writes[0].token).toBe(writtenToken.current);
      expect(writes[0].memory.source).toBe("implicit");
      expect(writes[0].memory.status).toBe("draft");
    });
  });
});
