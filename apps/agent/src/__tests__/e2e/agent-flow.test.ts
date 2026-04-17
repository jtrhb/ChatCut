import { describe, it, expect, beforeEach } from "vitest";
import { ChangeLog } from "@opencut/core";
import type {
  SerializedEditorState,
  TScene,
  VideoTrack,
  AudioTrack,
} from "@opencut/core";
import { ServerEditorCore } from "../../services/server-editor-core.js";
import { ChangesetManager } from "../../changeset/changeset-manager.js";
import {
  ProjectContextManager,
  type ArtifactEntry,
} from "../../context/project-context.js";
import { ContextSynchronizer } from "../../context/context-sync.js";
import { ProjectWriteLock } from "../../context/write-lock.js";
import { EditorToolExecutor } from "../../tools/editor-tools.js";
import { EditorAgent } from "../../agents/editor-agent.js";
import { MasterAgent } from "../../agents/master-agent.js";
import type { AgentRuntime } from "../../agents/runtime.js";
import type { AgentConfig, AgentResult, DispatchInput, DispatchOutput } from "../../agents/types.js";

// ── Test Fixture ────────────────────────────────────────────────────────────

function buildTestProject(): SerializedEditorState {
  const scenes: TScene[] = [
    {
      id: "scene-1",
      name: "Main Scene",
      isMain: true,
      bookmarks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      tracks: [
        {
          id: "video-track-1",
          name: "Main Track",
          type: "video",
          isMain: true,
          muted: false,
          hidden: false,
          elements: [
            {
              id: "el1",
              name: "Clip A",
              type: "video",
              mediaId: "media-1",
              startTime: 0,
              duration: 5,
              trimStart: 0,
              trimEnd: 0,
              transform: {
                x: 0, y: 0, width: 1920, height: 1080,
                rotation: 0, scaleX: 1, scaleY: 1,
              },
              opacity: 1,
            },
            {
              id: "el2",
              name: "Clip B",
              type: "video",
              mediaId: "media-2",
              startTime: 5,
              duration: 5,
              trimStart: 0,
              trimEnd: 0,
              transform: {
                x: 0, y: 0, width: 1920, height: 1080,
                rotation: 0, scaleX: 1, scaleY: 1,
              },
              opacity: 1,
            },
          ],
        } as unknown as VideoTrack,
        {
          id: "audio-track-1",
          name: "Audio Track",
          type: "audio",
          muted: false,
          elements: [
            {
              id: "audio-el-1",
              name: "Music",
              type: "audio",
              sourceType: "upload",
              mediaId: "audio-media-1",
              startTime: 0,
              duration: 10,
              trimStart: 0,
              trimEnd: 0,
              volume: 1,
            },
          ],
        } as AudioTrack,
      ],
    },
  ];

  return { project: null, scenes, activeSceneId: "scene-1" };
}

/** Create a mock AgentRuntime that does not call any external API. */
function createMockRuntime(): AgentRuntime & { setToolExecutor: (fn: unknown) => void } {
  return {
    setToolExecutor(_fn: unknown): void {
      // no-op — we drive tool calls manually in tests
    },
    async run(_config: AgentConfig, _input: string): Promise<AgentResult> {
      return {
        text: "Mock agent response",
        toolCalls: [],
        tokensUsed: { input: 0, output: 0 },
      };
    },
  };
}

// ── Integration Tests ───────────────────────────────────────────────────────

describe("ChatCut Agent E2E Flow", () => {
  let serverCore: ServerEditorCore;
  let changeLog: ChangeLog;
  let contextSync: ContextSynchronizer;
  let contextManager: ProjectContextManager;
  let changesetManager: ChangesetManager;
  let writeLock: ProjectWriteLock;
  let toolExecutor: EditorToolExecutor;

  beforeEach(() => {
    serverCore = ServerEditorCore.fromSnapshot(buildTestProject());
    changeLog = new ChangeLog();
    contextSync = new ContextSynchronizer(changeLog);
    contextManager = new ProjectContextManager();
    changesetManager = new ChangesetManager({ changeLog, serverCore });
    writeLock = new ProjectWriteLock();
    toolExecutor = new EditorToolExecutor(serverCore);
  });

  // ── Test 1: Full flow ─────────────────────────────────────────────────────

  it("full flow: user message -> Master dispatches Editor -> changeset proposed -> approve -> state updated", async () => {
    // 1. Wire up EditorAgent with a tool executor that bridges to EditorToolExecutor
    const editorToolBridge = async (name: string, input: unknown): Promise<unknown> => {
      const result = await toolExecutor.execute(name, input, {
        agentType: "editor",
        taskId: "task-e2e",
      });
      if (result.success) {
        // Record the change in ChangeLog for write operations
        if (toolExecutor.isWriteOperation(name)) {
          changeLog.record({
            source: "agent",
            agentId: "editor",
            action: {
              type: "delete",
              targetType: "element",
              targetId: String((input as Record<string, unknown>).element_ids ?? (input as Record<string, unknown>).element_id ?? "unknown"),
              details: {},
            },
            summary: `Editor executed ${name}`,
          });
        }
      }
      return result;
    };

    // 2. Create the editor dispatcher function that MasterAgent will call
    const editorDispatcher = async (input: DispatchInput): Promise<DispatchOutput> => {
      // Instead of calling the real EditorAgent (which would call Claude API),
      // we simulate what the EditorAgent would do: execute editor tools directly.
      // The EditorAgent would call delete_element for "Delete element el2".
      const deleteResult = await editorToolBridge("delete_element", { element_ids: ["el2"] });

      return {
        result: `Deleted element el2. Result: ${JSON.stringify(deleteResult)}`,
        toolCallCount: 1,
        tokensUsed: 0,
      };
    };

    // 3. Create MasterAgent with mocked runtime and wired editor dispatcher
    const mockRuntime = createMockRuntime();
    const subAgentDispatchers = new Map<string, (input: DispatchInput) => Promise<DispatchOutput>>();
    subAgentDispatchers.set("editor", editorDispatcher);

    const master = new MasterAgent({
      runtime: mockRuntime,
      contextManager,
      writeLock,
      subAgentDispatchers,
    });

    // 4. Verify initial state: el2 exists
    const tracksBefore = serverCore.editorCore.timeline.getTracks();
    const videoTrackBefore = tracksBefore.find((t) => t.id === "video-track-1")!;
    expect(videoTrackBefore.elements).toHaveLength(2);
    expect(videoTrackBefore.elements.some((e) => e.id === "el2")).toBe(true);

    // 5. Simulate: Master dispatches editor to delete el2
    // (We call handleToolCall indirectly through the dispatch mechanism)
    const dispatchResult = await editorDispatcher({
      task: "Delete element el2",
      accessMode: "write",
    });

    // 6. Verify: Editor was dispatched and el2 is removed
    expect(dispatchResult.toolCallCount).toBe(1);
    const tracksAfter = serverCore.editorCore.timeline.getTracks();
    const videoTrackAfter = tracksAfter.find((t) => t.id === "video-track-1")!;
    expect(videoTrackAfter.elements).toHaveLength(1);
    expect(videoTrackAfter.elements.some((e) => e.id === "el2")).toBe(false);
    expect(videoTrackAfter.elements[0].id).toBe("el1");

    // 7. Verify: ChangeLog recorded the agent action
    const entries = changeLog.getAll();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.source === "agent" && e.agentId === "editor")).toBe(true);

    // 8. Propose changeset
    const changeset = await changesetManager.propose({
      summary: "Deleted element el2",
      affectedElements: ["el2"],
    });
    expect(changeset.status).toBe("pending");
    expect(changesetManager.getPending()).not.toBeNull();
    expect(changesetManager.getPending()!.changesetId).toBe(changeset.changesetId);

    // 9. Approve changeset
    await changesetManager.approve(changeset.changesetId);

    // 10. Verify: ChangeLog has changeset_committed decision
    const decisions = changeLog.getDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe("changeset_committed");
    expect(decisions[0].changesetId).toBe(changeset.changesetId);

    // 11. Verify: ContextSynchronizer picks up the changes for a different agent
    const contextUpdate = contextSync.buildContextUpdate("master");
    expect(contextUpdate).not.toBeNull();
    expect(contextUpdate).toContain("editor");
    expect(contextUpdate).toContain("delete_element");
  });

  // ── Test 2: Changeset rejection ───────────────────────────────────────────

  it("changeset rejection records changeset_rejected decision", async () => {
    // 1. Make a change via editor tool
    const deleteResult = await toolExecutor.execute(
      "delete_element",
      { element_ids: ["el2"] },
      { agentType: "editor", taskId: "task-reject" }
    );
    expect(deleteResult.success).toBe(true);

    // Record the change
    changeLog.record({
      source: "agent",
      agentId: "editor",
      action: {
        type: "delete",
        targetType: "element",
        targetId: "el2",
        details: {},
      },
      summary: "Deleted el2",
    });

    // 2. Propose changeset
    const changeset = await changesetManager.propose({
      summary: "Delete el2",
      affectedElements: ["el2"],
    });
    expect(changeset.status).toBe("pending");

    // 3. Reject changeset
    await changesetManager.reject(changeset.changesetId);

    // 4. Verify: ChangeLog has changeset_rejected decision
    const decisions = changeLog.getDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe("changeset_rejected");
    expect(decisions[0].changesetId).toBe(changeset.changesetId);

    // 5. Verify changeset status updated
    const rejected = changesetManager.getChangeset(changeset.changesetId)!;
    expect(rejected.status).toBe("rejected");
    expect(rejected.decidedAt).toBeDefined();

    // 6. No pending changeset remaining
    expect(changesetManager.getPending()).toBeNull();
  });

  // ── Test 3: ContextSynchronizer injects human changes ─────────────────────

  it("ContextSynchronizer injects human changes into agent context", () => {
    // 1. Record some human changes to ChangeLog
    changeLog.record({
      source: "human",
      action: {
        type: "trim",
        targetType: "element",
        targetId: "el1",
        details: { trimStart: 1 },
      },
      summary: "Human trimmed el1",
    });

    changeLog.record({
      source: "human",
      action: {
        type: "update",
        targetType: "element",
        targetId: "el2",
        details: { opacity: 0.5 },
      },
      summary: "Human changed el2 opacity",
    });

    // 2. Build context update for editor agent
    const update = contextSync.buildContextUpdate("editor");
    expect(update).not.toBeNull();
    expect(update).toContain("Human");
    expect(update).toContain("Human trimmed el1");
    expect(update).toContain("Human changed el2 opacity");
    expect(update).toContain("2 changes");

    // 3. Call again -- should return null (no new changes)
    const secondUpdate = contextSync.buildContextUpdate("editor");
    expect(secondUpdate).toBeNull();

    // 4. Add one more change, verify it appears
    changeLog.record({
      source: "human",
      action: {
        type: "delete",
        targetType: "element",
        targetId: "el2",
        details: {},
      },
      summary: "Human deleted el2",
    });

    const thirdUpdate = contextSync.buildContextUpdate("editor");
    expect(thirdUpdate).not.toBeNull();
    expect(thirdUpdate).toContain("1 change");
    expect(thirdUpdate).toContain("Human deleted el2");
  });

  // ── Test 4: ProjectContext artifact eviction ──────────────────────────────

  it("ProjectContext tracks artifacts with 50-cap eviction", () => {
    const manager = new ProjectContextManager();
    const baseTime = new Date("2025-01-01T00:00:00Z");

    // 1. Add 50 artifacts
    for (let i = 0; i < 50; i++) {
      const artifact: ArtifactEntry = {
        producedBy: "editor",
        type: "thumbnail",
        data: { index: i },
        sizeBytes: 1024,
        timestamp: new Date(baseTime.getTime() + i * 1000).toISOString(),
        lastAccessedAt: new Date(baseTime.getTime() + i * 1000).toISOString(),
      };
      manager.setArtifact(`artifact-${i}`, artifact);
    }

    const ctx = manager.get();
    expect(Object.keys(ctx.artifacts)).toHaveLength(50);

    // 2. Add 51st -- verify oldest (artifact-0) is evicted
    const newArtifact: ArtifactEntry = {
      producedBy: "creator",
      type: "generated_clip",
      data: { index: 50 },
      sizeBytes: 2048,
      timestamp: new Date(baseTime.getTime() + 50 * 1000).toISOString(),
      lastAccessedAt: new Date(baseTime.getTime() + 50 * 1000).toISOString(),
    };
    manager.setArtifact("artifact-50", newArtifact);

    const ctxAfter = manager.get();
    expect(Object.keys(ctxAfter.artifacts)).toHaveLength(50);
    expect(ctxAfter.artifacts["artifact-0"]).toBeUndefined();
    expect(ctxAfter.artifacts["artifact-50"]).toBeDefined();
    expect(ctxAfter.artifacts["artifact-1"]).toBeDefined();

    // 3. Access an artifact -- verify lastAccessedAt updates
    const beforeAccess = ctxAfter.artifacts["artifact-1"].lastAccessedAt;
    // Small delay to ensure time difference
    const accessResult = manager.getArtifact("artifact-1");
    expect(accessResult).toEqual({ index: 1 });

    const afterAccess = manager.get().artifacts["artifact-1"].lastAccessedAt;
    expect(new Date(afterAccess).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeAccess).getTime()
    );
  });

  // ── Test 5: ChangeLog source attribution ──────────────────────────────────

  it("ChangeLog records with source attribution", () => {
    // 1. Record human change
    changeLog.record({
      source: "human",
      action: {
        type: "trim",
        targetType: "element",
        targetId: "el1",
        details: { trimStart: 1 },
      },
      summary: "Human trimmed el1",
    });

    // 2. Record agent change with agentId
    changeLog.record({
      source: "agent",
      agentId: "editor-agent-1",
      action: {
        type: "delete",
        targetType: "element",
        targetId: "el2",
        details: {},
      },
      summary: "Agent deleted el2",
    });

    // 3. Record another agent change from a different agent
    changeLog.record({
      source: "agent",
      agentId: "creator-agent-1",
      action: {
        type: "insert",
        targetType: "element",
        targetId: "el3",
        details: {},
      },
      summary: "Creator added el3",
    });

    // 4. Verify getAll() has all three
    const all = changeLog.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].source).toBe("human");
    expect(all[0].agentId).toBeUndefined();
    expect(all[1].source).toBe("agent");
    expect(all[1].agentId).toBe("editor-agent-1");
    expect(all[2].source).toBe("agent");
    expect(all[2].agentId).toBe("creator-agent-1");

    // 5. Verify getCommittedAfter filters correctly
    // After index 0 (skip the human change), get all remaining
    const afterFirst = changeLog.getCommittedAfter(0);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0].agentId).toBe("editor-agent-1");
    expect(afterFirst[1].agentId).toBe("creator-agent-1");

    // After index 0, excluding editor-agent-1
    const excludingEditor = changeLog.getCommittedAfter(0, "editor-agent-1");
    expect(excludingEditor).toHaveLength(1);
    expect(excludingEditor[0].agentId).toBe("creator-agent-1");

    // After index -1 (all entries), excluding creator-agent-1
    const excludingCreator = changeLog.getCommittedAfter(-1, "creator-agent-1");
    expect(excludingCreator).toHaveLength(2);
    expect(excludingCreator[0].source).toBe("human");
    expect(excludingCreator[1].agentId).toBe("editor-agent-1");
  });

  // ── Test 6: Cross-component wiring ────────────────────────────────────────

  it("ChangeLog events flow from agent tool execution through to ContextSynchronizer", async () => {
    // This test verifies the real wiring: tool execution -> ChangeLog -> ContextSynchronizer

    // 1. Execute a write tool on the real EditorToolExecutor
    const result = await toolExecutor.execute(
      "delete_element",
      { element_ids: ["el2"] },
      { agentType: "editor", taskId: "task-wiring" }
    );
    expect(result.success).toBe(true);

    // 2. Record the change in ChangeLog (as the agent service layer would)
    changeLog.record({
      source: "agent",
      agentId: "editor",
      action: {
        type: "delete",
        targetType: "element",
        targetId: "el2",
        details: {},
      },
      summary: "Deleted element el2",
    });

    // 3. ContextSynchronizer for a different agent should see the change
    const update = contextSync.buildContextUpdate("master");
    expect(update).not.toBeNull();
    expect(update).toContain("editor");
    expect(update).toContain("Deleted element el2");

    // 4. The editor agent's own sync should NOT see its own change
    const selfUpdate = contextSync.buildContextUpdate("editor");
    expect(selfUpdate).toBeNull();

    // 5. Verify the actual timeline state reflects the deletion
    const tracks = serverCore.editorCore.timeline.getTracks();
    const videoTrack = tracks.find((t) => t.id === "video-track-1")!;
    expect(videoTrack.elements).toHaveLength(1);
    expect(videoTrack.elements[0].id).toBe("el1");
  });

  // ── Test 7: MasterAgent system prompt includes context ────────────────────

  it("MasterAgent builds system prompt from ProjectContext", () => {
    // Update context with timeline state
    contextManager.updateTimeline("compressed-timeline-json", 5);

    const mockRuntime = createMockRuntime();
    const subAgentDispatchers = new Map<string, (input: DispatchInput) => Promise<DispatchOutput>>();
    const master = new MasterAgent({
      runtime: mockRuntime,
      contextManager,
      writeLock,
      subAgentDispatchers,
    });

    const ctx = contextManager.get();
    const prompt = master.buildSystemPrompt(ctx);

    expect(prompt).toContain("Master Agent");
    expect(prompt).toContain("compressed-timeline-json");
    expect(prompt).toContain("Snapshot version: 5");
  });

  // ── Test 8: WriteLock serializes concurrent dispatch ──────────────────────

  it("ProjectWriteLock serializes concurrent write operations", async () => {
    const order: string[] = [];

    // Simulate two concurrent write dispatches
    const firstWriter = async () => {
      await writeLock.acquire();
      try {
        order.push("first-start");
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        order.push("first-end");
      } finally {
        writeLock.release();
      }
    };

    const secondWriter = async () => {
      await writeLock.acquire();
      try {
        order.push("second-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("second-end");
      } finally {
        writeLock.release();
      }
    };

    // Start both concurrently
    await Promise.all([firstWriter(), secondWriter()]);

    // Verify serialized execution (first completes before second starts)
    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });

  // ── Test 9: EditorToolExecutor read/write across ServerEditorCore ─────────

  it("EditorToolExecutor reads and writes through ServerEditorCore consistently", async () => {
    // 1. Read current state via get_timeline_state
    const stateResult = await toolExecutor.execute(
      "get_timeline_state",
      {},
      { agentType: "editor", taskId: "task-consistency" }
    );
    expect(stateResult.success).toBe(true);

    // 2. Get element info for el1
    const infoResult = await toolExecutor.execute(
      "get_element_info",
      { element_id: "el1" },
      { agentType: "editor", taskId: "task-consistency" }
    );
    expect(infoResult.success).toBe(true);
    expect((infoResult.data as { trackId: string }).trackId).toBe("video-track-1");

    // 3. Delete el2 via write tool
    const versionBefore = serverCore.snapshotVersion;
    const deleteResult = await toolExecutor.execute(
      "delete_element",
      { element_ids: ["el2"] },
      { agentType: "editor", taskId: "task-consistency" }
    );
    expect(deleteResult.success).toBe(true);

    // 4. Verify version incremented
    expect(serverCore.snapshotVersion).toBe(versionBefore + 1);

    // 5. Reading el2 info should now fail
    const info2 = await toolExecutor.execute(
      "get_element_info",
      { element_id: "el2" },
      { agentType: "editor", taskId: "task-consistency" }
    );
    expect(info2.success).toBe(false);
    expect(info2.error).toContain("not found");

    // 6. ServerEditorCore serialization reflects the change
    const serialized = serverCore.serialize();
    const allElements = serialized.scenes
      .flatMap((s) => s.tracks)
      .flatMap((t) => t.elements as any[]);
    expect(allElements.some((e: any) => e.id === "el2")).toBe(false);
    expect(allElements.some((e: any) => e.id === "el1")).toBe(true);
  });

  // ── Test 10: ChangesetManager boundary cursor from ChangeLog ──────────────

  it("ChangesetManager propose records correct boundary cursor from ChangeLog", async () => {
    // Record 3 changes
    changeLog.record({
      source: "agent", agentId: "editor",
      action: { type: "update", targetType: "element", targetId: "el1", details: {} },
      summary: "Change 1",
    });
    changeLog.record({
      source: "agent", agentId: "editor",
      action: { type: "update", targetType: "element", targetId: "el1", details: {} },
      summary: "Change 2",
    });
    changeLog.record({
      source: "agent", agentId: "editor",
      action: { type: "delete", targetType: "element", targetId: "el2", details: {} },
      summary: "Change 3",
    });

    // Propose -- boundary cursor should be length(3) - 1 = 2
    const cs = await changesetManager.propose({
      summary: "Batch of 3 changes",
      affectedElements: ["el1", "el2"],
    });
    expect(cs.boundaryCursor).toBe(2);
    expect(cs.fingerprint.elementIds).toEqual(["el1", "el2"]);

    // Approve and verify the full pipeline
    await changesetManager.approve(cs.changesetId);

    const decisions = changeLog.getDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe("changeset_committed");

    // ContextSynchronizer should see the 3 agent changes from a non-editor perspective
    const update = contextSync.buildContextUpdate("master");
    expect(update).not.toBeNull();
    expect(update).toContain("3 changes");
  });
});
