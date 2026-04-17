import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  GetTimelineStateSchema,
  GetElementInfoSchema,
  PreviewFrameSchema,
  TrimElementSchema,
  SplitElementSchema,
  DeleteElementSchema,
  MoveElementSchema,
  AddElementSchema,
  SetSpeedSchema,
  SetVolumeSchema,
  AddTransitionSchema,
  AddEffectSchema,
  UpdateTextSchema,
  AddKeyframeSchema,
  ReorderElementsSchema,
  BatchEditSchema,
  EditorToolExecutor,
  EDITOR_TOOL_DEFINITIONS,
} from "../editor-tools.js";
import { ServerEditorCore } from "../../services/server-editor-core.js";
import { EditorCore } from "@opencut/core";
import type { SerializedEditorState } from "@opencut/core";
import type { TScene, VideoTrack, AudioTrack, TextTrack } from "@opencut/core";

// ── Test Helpers ─────────────────────────────────────────────────────────────

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
              id: "video-el-1",
              name: "Clip A",
              type: "video",
              mediaId: "media-1",
              startTime: 0,
              duration: 5,
              trimStart: 0,
              trimEnd: 0,
              transform: {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
              },
              opacity: 1,
            },
            {
              id: "video-el-2",
              name: "Clip B",
              type: "video",
              mediaId: "media-2",
              startTime: 5,
              duration: 5,
              trimStart: 0,
              trimEnd: 0,
              transform: {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
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
        {
          id: "text-track-1",
          name: "Text Track",
          type: "text",
          hidden: false,
          elements: [
            {
              id: "text-el-1",
              name: "Title",
              type: "text",
              content: "Hello World",
              fontSize: 48,
              fontFamily: "Inter",
              color: "#ffffff",
              background: { enabled: false, color: "#000000" },
              textAlign: "center" as const,
              fontWeight: "normal" as const,
              fontStyle: "normal" as const,
              textDecoration: "none" as const,
              startTime: 0,
              duration: 3,
              trimStart: 0,
              trimEnd: 0,
              transform: {
                x: 0,
                y: 0,
                width: 400,
                height: 100,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
              },
              opacity: 1,
            },
          ],
        } as unknown as TextTrack,
      ],
    },
  ];

  return {
    project: {
      metadata: {
        id: "project-1",
        name: "Test Project",
        duration: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      scenes,
      currentSceneId: "scene-1",
      settings: {
        fps: 30,
        canvasSize: { width: 1920, height: 1080 },
        background: { type: "color", color: "#000000" },
      },
      version: 1,
    },
    scenes,
    activeSceneId: "scene-1",
  };
}

function createTestExecutor(): {
  executor: EditorToolExecutor;
  serverCore: ServerEditorCore;
} {
  const state = buildTestProject();
  const serverCore = ServerEditorCore.fromSnapshot(state);
  const executor = new EditorToolExecutor(serverCore);
  return { executor, serverCore };
}

const editorCtx = { agentType: "editor" as const, taskId: "test-task" };
const masterCtx = { agentType: "master" as const, taskId: "test-task" };

// ── Schema Validation Tests ──────────────────────────────────────────────────

describe("Editor Tool Schemas", () => {
  describe("get_timeline_state", () => {
    it("accepts empty object", () => {
      expect(GetTimelineStateSchema.safeParse({}).success).toBe(true);
    });
    it("rejects non-object input", () => {
      expect(GetTimelineStateSchema.safeParse("bad").success).toBe(false);
    });
  });

  describe("get_element_info", () => {
    it("accepts valid element_id", () => {
      expect(
        GetElementInfoSchema.safeParse({ element_id: "el-1" }).success
      ).toBe(true);
    });
    it("rejects missing element_id", () => {
      expect(GetElementInfoSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("preview_frame", () => {
    it("accepts valid time", () => {
      expect(PreviewFrameSchema.safeParse({ time: 2.5 }).success).toBe(true);
    });
    it("rejects negative time", () => {
      expect(PreviewFrameSchema.safeParse({ time: -1 }).success).toBe(false);
    });
  });

  describe("trim_element", () => {
    it("accepts element_id with optional trims", () => {
      expect(
        TrimElementSchema.safeParse({
          element_id: "el-1",
          trim_start: 1,
        }).success
      ).toBe(true);
    });
    it("rejects missing element_id", () => {
      expect(
        TrimElementSchema.safeParse({ trim_start: 1 }).success
      ).toBe(false);
    });
  });

  describe("split_element", () => {
    it("accepts valid input", () => {
      expect(
        SplitElementSchema.safeParse({
          element_id: "el-1",
          split_time: 2.5,
        }).success
      ).toBe(true);
    });
    it("rejects missing split_time", () => {
      expect(
        SplitElementSchema.safeParse({ element_id: "el-1" }).success
      ).toBe(false);
    });
  });

  describe("delete_element", () => {
    it("accepts array of element_ids", () => {
      expect(
        DeleteElementSchema.safeParse({ element_ids: ["el-1", "el-2"] }).success
      ).toBe(true);
    });
    it("rejects non-array element_ids", () => {
      expect(
        DeleteElementSchema.safeParse({ element_ids: "el-1" }).success
      ).toBe(false);
    });
  });

  describe("move_element", () => {
    it("accepts element_id with optional fields", () => {
      expect(
        MoveElementSchema.safeParse({
          element_id: "el-1",
          new_start_time: 3,
        }).success
      ).toBe(true);
    });
    it("rejects missing element_id", () => {
      expect(
        MoveElementSchema.safeParse({ new_start_time: 3 }).success
      ).toBe(false);
    });
  });

  describe("add_element", () => {
    it("accepts valid input", () => {
      expect(
        AddElementSchema.safeParse({
          track_id: "t-1",
          type: "video",
          start_time: 0,
          duration: 5,
        }).success
      ).toBe(true);
    });
    it("rejects invalid type enum", () => {
      expect(
        AddElementSchema.safeParse({
          track_id: "t-1",
          type: "invalid_type",
          start_time: 0,
          duration: 5,
        }).success
      ).toBe(false);
    });
  });

  describe("set_speed", () => {
    it("accepts valid speed", () => {
      expect(
        SetSpeedSchema.safeParse({ element_id: "el-1", speed: 2 }).success
      ).toBe(true);
    });
    it("rejects speed below 0.1", () => {
      expect(
        SetSpeedSchema.safeParse({ element_id: "el-1", speed: 0.01 }).success
      ).toBe(false);
    });
    it("rejects speed above 10", () => {
      expect(
        SetSpeedSchema.safeParse({ element_id: "el-1", speed: 11 }).success
      ).toBe(false);
    });
  });

  describe("set_volume", () => {
    it("accepts valid volume", () => {
      expect(
        SetVolumeSchema.safeParse({ element_id: "el-1", volume: 0.5 }).success
      ).toBe(true);
    });
    it("rejects volume below 0", () => {
      expect(
        SetVolumeSchema.safeParse({ element_id: "el-1", volume: -1 }).success
      ).toBe(false);
    });
    it("rejects volume above 2", () => {
      expect(
        SetVolumeSchema.safeParse({ element_id: "el-1", volume: 3 }).success
      ).toBe(false);
    });
  });

  describe("add_transition", () => {
    it("accepts valid input with default duration", () => {
      const result = AddTransitionSchema.safeParse({
        element_id: "el-1",
        transition_type: "fade",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.duration).toBe(0.5);
      }
    });
    it("rejects missing transition_type", () => {
      expect(
        AddTransitionSchema.safeParse({ element_id: "el-1" }).success
      ).toBe(false);
    });
  });

  describe("add_effect", () => {
    it("accepts valid input", () => {
      expect(
        AddEffectSchema.safeParse({
          element_id: "el-1",
          effect_type: "blur",
        }).success
      ).toBe(true);
    });
    it("rejects missing effect_type", () => {
      expect(
        AddEffectSchema.safeParse({ element_id: "el-1" }).success
      ).toBe(false);
    });
  });

  describe("update_text", () => {
    it("accepts text and style", () => {
      expect(
        UpdateTextSchema.safeParse({
          element_id: "el-1",
          text: "New Title",
          style: { fontSize: 72 },
        }).success
      ).toBe(true);
    });
    it("rejects missing element_id", () => {
      expect(
        UpdateTextSchema.safeParse({ text: "Oops" }).success
      ).toBe(false);
    });
  });

  describe("add_keyframe", () => {
    it("accepts valid keyframe input", () => {
      expect(
        AddKeyframeSchema.safeParse({
          element_id: "el-1",
          property: "opacity",
          time: 1.0,
          value: 0.5,
        }).success
      ).toBe(true);
    });
    it("rejects missing property", () => {
      expect(
        AddKeyframeSchema.safeParse({
          element_id: "el-1",
          time: 1.0,
          value: 0.5,
        }).success
      ).toBe(false);
    });
  });

  describe("reorder_elements", () => {
    it("accepts valid input", () => {
      expect(
        ReorderElementsSchema.safeParse({
          track_id: "t-1",
          element_ids: ["el-2", "el-1"],
        }).success
      ).toBe(true);
    });
    it("rejects missing track_id", () => {
      expect(
        ReorderElementsSchema.safeParse({ element_ids: ["el-1"] }).success
      ).toBe(false);
    });
  });

  describe("batch_edit", () => {
    it("accepts array of operations", () => {
      expect(
        BatchEditSchema.safeParse({
          operations: [
            { tool: "set_volume", input: { element_id: "el-1", volume: 0.5 } },
          ],
        }).success
      ).toBe(true);
    });
    it("rejects non-array operations", () => {
      expect(
        BatchEditSchema.safeParse({ operations: "not-an-array" }).success
      ).toBe(false);
    });
  });
});

// ── Tool Definition Registration Tests ───────────────────────────────────────

describe("EDITOR_TOOL_DEFINITIONS", () => {
  it("contains exactly 16 tools", () => {
    expect(EDITOR_TOOL_DEFINITIONS).toHaveLength(16);
  });

  it("has unique names", () => {
    const names = EDITOR_TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ── Permission Tests ─────────────────────────────────────────────────────────

describe("EditorToolExecutor Permissions", () => {
  let executor: EditorToolExecutor;

  beforeEach(() => {
    ({ executor } = createTestExecutor());
  });

  afterEach(() => {
    EditorCore.reset();
  });

  it("editor agent can call all 16 tools", () => {
    const editorTools = executor.getToolDefinitions("editor");
    expect(editorTools).toHaveLength(16);
  });

  it("master agent can only call read tools", () => {
    const masterTools = executor.getToolDefinitions("master");
    const masterToolNames = masterTools.map((t) => t.name);
    expect(masterToolNames).toContain("get_timeline_state");
    expect(masterToolNames).toContain("get_element_info");
    expect(masterToolNames).toContain("preview_frame");
    expect(masterToolNames).toHaveLength(3);
  });

  it("master agent is denied write tools", async () => {
    const result = await executor.execute(
      "trim_element",
      { element_id: "video-el-1", trim_start: 1 },
      masterCtx
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });
});

// ── Executor Integration Tests ───────────────────────────────────────────────

describe("EditorToolExecutor", () => {
  let executor: EditorToolExecutor;
  let serverCore: ServerEditorCore;

  beforeEach(() => {
    ({ executor, serverCore } = createTestExecutor());
  });

  afterEach(() => {
    EditorCore.reset();
  });

  describe("get_timeline_state", () => {
    it("returns serialized timeline JSON", async () => {
      const result = await executor.execute(
        "get_timeline_state",
        {},
        editorCtx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.data as string);
      expect(parsed.scenes).toBeDefined();
      expect(parsed.scenes[0].tracks.length).toBeGreaterThan(0);
      expect(parsed.duration).toBeGreaterThan(0);
    });
  });

  describe("get_element_info", () => {
    it("returns element details", async () => {
      const result = await executor.execute(
        "get_element_info",
        { element_id: "video-el-1" },
        editorCtx
      );
      expect(result.success).toBe(true);
      const data = result.data as { element: { id: string }; trackId: string };
      expect(data.element.id).toBe("video-el-1");
      expect(data.trackId).toBe("video-track-1");
    });

    it("returns error for non-existent element", async () => {
      const result = await executor.execute(
        "get_element_info",
        { element_id: "non-existent" },
        editorCtx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("preview_frame", () => {
    it("returns elements at a given time", async () => {
      const result = await executor.execute(
        "preview_frame",
        { time: 2 },
        editorCtx
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        time: number;
        elements: Array<{ elementId: string }>;
      };
      expect(data.time).toBe(2);
      // video-el-1 (0-5), audio-el-1 (0-10), text-el-1 (0-3) are all active at t=2
      expect(data.elements.length).toBe(3);
    });
  });

  describe("trim_element", () => {
    it("modifies element trim values", async () => {
      const result = await executor.execute(
        "trim_element",
        { element_id: "video-el-1", trim_start: 1, trim_end: 0.5 },
        editorCtx
      );
      expect(result.success).toBe(true);

      // Verify state changed
      const tracks = serverCore.editorCore.timeline.getTracks();
      const el = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "video-el-1") as any;
      expect(el?.trimStart).toBe(1);
      expect(el?.trimEnd).toBe(0.5);
    });
  });

  describe("split_element", () => {
    it("creates two elements from one", async () => {
      const tracksBefore = serverCore.editorCore.timeline.getTracks();
      const videoTrack = tracksBefore.find((t) => t.id === "video-track-1")!;
      const countBefore = (videoTrack.elements as any[]).length;

      const result = await executor.execute(
        "split_element",
        { element_id: "video-el-1", split_time: 2.5 },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracksAfter = serverCore.editorCore.timeline.getTracks();
      const videoTrackAfter = tracksAfter.find(
        (t) => t.id === "video-track-1"
      )!;
      expect((videoTrackAfter.elements as any[]).length).toBe(countBefore + 1);

      const data = result.data as { created_element_ids: string[] };
      expect(data.created_element_ids.length).toBeGreaterThan(0);
    });
  });

  describe("delete_element", () => {
    it("removes elements from timeline", async () => {
      const result = await executor.execute(
        "delete_element",
        { element_ids: ["video-el-2"] },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracks = serverCore.editorCore.timeline.getTracks();
      const allIds = tracks.flatMap((t) => t.elements as any[]).map((e: any) => e.id);
      expect(allIds).not.toContain("video-el-2");
    });

    it("returns error for non-existent element", async () => {
      const result = await executor.execute(
        "delete_element",
        { element_ids: ["ghost-id"] },
        editorCtx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("move_element", () => {
    it("moves element to a new start time", async () => {
      const result = await executor.execute(
        "move_element",
        { element_id: "video-el-2", new_start_time: 8 },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracks = serverCore.editorCore.timeline.getTracks();
      const el = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "video-el-2") as any;
      expect(el?.startTime).toBe(8);
    });
  });

  describe("add_element", () => {
    it("adds a new element to an existing track", async () => {
      const result = await executor.execute(
        "add_element",
        {
          track_id: "video-track-1",
          type: "video",
          start_time: 10,
          duration: 3,
        },
        editorCtx
      );
      expect(result.success).toBe(true);

      const data = result.data as { element_id: string };
      expect(data.element_id).toBeDefined();

      const tracks = serverCore.editorCore.timeline.getTracks();
      const videoTrack = tracks.find((t) => t.id === "video-track-1")!;
      expect((videoTrack.elements as any[]).some((e: any) => e.id === data.element_id)).toBe(
        true
      );
    });
  });

  describe("set_speed", () => {
    it("updates element speed", async () => {
      const result = await executor.execute(
        "set_speed",
        { element_id: "video-el-1", speed: 2 },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracks = serverCore.editorCore.timeline.getTracks();
      const el = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "video-el-1") as Record<string, unknown>;
      expect(el?.speed).toBe(2);
    });
  });

  describe("set_volume", () => {
    it("updates element volume", async () => {
      const result = await executor.execute(
        "set_volume",
        { element_id: "audio-el-1", volume: 0.5 },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracks = serverCore.editorCore.timeline.getTracks();
      const el = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "audio-el-1") as Record<string, unknown>;
      expect(el?.volume).toBe(0.5);
    });
  });

  describe("add_transition", () => {
    it("adds a transition to an element", async () => {
      const result = await executor.execute(
        "add_transition",
        { element_id: "video-el-1", transition_type: "fade", duration: 0.3 },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracks = serverCore.editorCore.timeline.getTracks();
      const el = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "video-el-1") as Record<string, unknown>;
      expect((el?.transition as { type: string })?.type).toBe("fade");
    });
  });

  describe("update_text", () => {
    it("updates text content", async () => {
      const result = await executor.execute(
        "update_text",
        { element_id: "text-el-1", text: "Updated Title" },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracks = serverCore.editorCore.timeline.getTracks();
      const el = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "text-el-1") as Record<string, unknown>;
      expect(el?.content).toBe("Updated Title");
    });
  });

  describe("reorder_elements", () => {
    it("reorders elements in a track", async () => {
      const result = await executor.execute(
        "reorder_elements",
        {
          track_id: "video-track-1",
          element_ids: ["video-el-2", "video-el-1"],
        },
        editorCtx
      );
      expect(result.success).toBe(true);

      const tracks = serverCore.editorCore.timeline.getTracks();
      const videoTrack = tracks.find((t) => t.id === "video-track-1")!;
      expect((videoTrack.elements as any[])[0].id).toBe("video-el-2");
      expect((videoTrack.elements as any[])[1].id).toBe("video-el-1");
    });
  });

  describe("batch_edit", () => {
    it("executes multiple operations atomically", async () => {
      const result = await executor.execute(
        "batch_edit",
        {
          operations: [
            {
              tool: "set_volume",
              input: { element_id: "audio-el-1", volume: 0.3 },
            },
            {
              tool: "trim_element",
              input: { element_id: "video-el-1", trim_start: 0.5 },
            },
          ],
        },
        editorCtx
      );
      expect(result.success).toBe(true);

      // Verify both operations took effect
      const tracks = serverCore.editorCore.timeline.getTracks();
      const audioEl = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "audio-el-1") as Record<string, unknown>;
      const videoEl = tracks
        .flatMap((t) => t.elements as any[])
        .find((e: any) => e.id === "video-el-1") as any;

      expect(audioEl?.volume).toBe(0.3);
      expect(videoEl?.trimStart).toBe(0.5);
    });

    it("fails and reports error on unknown tool in batch", async () => {
      const result = await executor.execute(
        "batch_edit",
        {
          operations: [
            {
              tool: "nonexistent_tool",
              input: {},
            },
          ],
        },
        editorCtx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool in batch");
    });

    it("rejects nested batch_edit", async () => {
      const result = await executor.execute(
        "batch_edit",
        {
          operations: [
            {
              tool: "batch_edit",
              input: { operations: [] },
            },
          ],
        },
        editorCtx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Nested batch_edit");
    });
  });

  describe("version tracking", () => {
    it("increments snapshot version on write operations", async () => {
      const versionBefore = serverCore.snapshotVersion;

      await executor.execute(
        "trim_element",
        { element_id: "video-el-1", trim_start: 1 },
        editorCtx
      );

      expect(serverCore.snapshotVersion).toBe(versionBefore + 1);
    });

    it("does not increment version on read operations", async () => {
      const versionBefore = serverCore.snapshotVersion;

      await executor.execute("get_timeline_state", {}, editorCtx);

      expect(serverCore.snapshotVersion).toBe(versionBefore);
    });
  });
});
