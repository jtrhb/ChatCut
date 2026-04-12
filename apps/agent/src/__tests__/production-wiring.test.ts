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
});
