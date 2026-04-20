import { describe, it, expect, vi } from "vitest";
import {
  GenerateVideoSchema,
  GenerateImageSchema,
  CheckGenerationStatusSchema,
  ReplaceSegmentSchema,
  CompareBeforeAfterSchema,
  GenerateIntoSegmentSchema,
  creatorToolDefinitions,
} from "../creator-tools.js";
import { CreatorToolExecutor } from "../creator-tool-executor.js";
import type { ContentEditor } from "../../services/content-editor.js";

// ── Schema Validation Tests ──────────────────────────────────────────────────

describe("Creator Tool Schemas", () => {
  describe("generate_video", () => {
    it("accepts prompt and idempotencyKey only", () => {
      expect(
        GenerateVideoSchema.safeParse({
          prompt: "A sunset over mountains",
          idempotencyKey: "idem-1",
        }).success
      ).toBe(true);
    });

    it("accepts all optional fields", () => {
      expect(
        GenerateVideoSchema.safeParse({
          prompt: "A sunset over mountains",
          provider: "kling",
          duration: 5,
          ref_image: "https://example.com/ref.jpg",
          idempotencyKey: "idem-2",
        }).success
      ).toBe(true);
    });

    it("accepts valid provider values", () => {
      for (const provider of ["kling", "seedance", "veo"] as const) {
        expect(
          GenerateVideoSchema.safeParse({
            prompt: "test",
            provider,
            idempotencyKey: "idem-3",
          }).success
        ).toBe(true);
      }
    });

    it("rejects missing idempotencyKey", () => {
      expect(
        GenerateVideoSchema.safeParse({
          prompt: "A sunset over mountains",
        }).success
      ).toBe(false);
    });

    it("rejects invalid provider", () => {
      expect(
        GenerateVideoSchema.safeParse({
          prompt: "test",
          provider: "openai",
          idempotencyKey: "idem-4",
        }).success
      ).toBe(false);
    });

    it("rejects missing prompt", () => {
      expect(
        GenerateVideoSchema.safeParse({
          idempotencyKey: "idem-5",
        }).success
      ).toBe(false);
    });
  });

  describe("generate_image", () => {
    it("accepts prompt and idempotencyKey", () => {
      expect(
        GenerateImageSchema.safeParse({
          prompt: "A cat on a rooftop",
          idempotencyKey: "idem-10",
        }).success
      ).toBe(true);
    });

    it("accepts optional provider and dimensions", () => {
      expect(
        GenerateImageSchema.safeParse({
          prompt: "A cat on a rooftop",
          provider: "dall-e-3",
          dimensions: "1024x1024",
          idempotencyKey: "idem-11",
        }).success
      ).toBe(true);
    });

    it("rejects missing idempotencyKey", () => {
      expect(
        GenerateImageSchema.safeParse({
          prompt: "A cat on a rooftop",
        }).success
      ).toBe(false);
    });

    it("rejects missing prompt", () => {
      expect(
        GenerateImageSchema.safeParse({
          idempotencyKey: "idem-12",
        }).success
      ).toBe(false);
    });
  });

  describe("check_generation_status", () => {
    it("accepts valid task_id", () => {
      expect(
        CheckGenerationStatusSchema.safeParse({ task_id: "task-abc" }).success
      ).toBe(true);
    });

    it("rejects missing task_id", () => {
      expect(CheckGenerationStatusSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-string task_id", () => {
      expect(
        CheckGenerationStatusSchema.safeParse({ task_id: 123 }).success
      ).toBe(false);
    });
  });

  describe("replace_segment", () => {
    it("accepts required fields", () => {
      expect(
        ReplaceSegmentSchema.safeParse({
          element_id: "el-1",
          new_storage_key: "s3://bucket/file.mp4",
        }).success
      ).toBe(true);
    });

    it("accepts optional time_range", () => {
      expect(
        ReplaceSegmentSchema.safeParse({
          element_id: "el-1",
          new_storage_key: "s3://bucket/file.mp4",
          time_range: { start: 0, end: 5 },
        }).success
      ).toBe(true);
    });

    it("rejects missing element_id", () => {
      expect(
        ReplaceSegmentSchema.safeParse({
          new_storage_key: "s3://bucket/file.mp4",
        }).success
      ).toBe(false);
    });

    it("rejects missing new_storage_key", () => {
      expect(
        ReplaceSegmentSchema.safeParse({
          element_id: "el-1",
        }).success
      ).toBe(false);
    });
  });

  describe("compare_before_after", () => {
    it("accepts valid input", () => {
      expect(
        CompareBeforeAfterSchema.safeParse({
          element_id: "el-1",
          time: 2.5,
        }).success
      ).toBe(true);
    });

    it("rejects missing element_id", () => {
      expect(
        CompareBeforeAfterSchema.safeParse({ time: 2.5 }).success
      ).toBe(false);
    });

    it("rejects missing time", () => {
      expect(
        CompareBeforeAfterSchema.safeParse({ element_id: "el-1" }).success
      ).toBe(false);
    });
  });
});

// ── Tool Definition Tests ────────────────────────────────────────────────────

describe("creatorToolDefinitions", () => {
  it("contains exactly 6 tools (5 originals + Phase 1C generate_into_segment)", () => {
    expect(creatorToolDefinitions).toHaveLength(6);
  });

  it("all tools have agentType 'creator'", () => {
    for (const tool of creatorToolDefinitions) {
      expect(tool.agentTypes).toContain("creator");
    }
  });

  it("has unique tool names", () => {
    const names = creatorToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("generate_video is a write tool", () => {
    const tool = creatorToolDefinitions.find((t) => t.name === "generate_video");
    expect(tool?.accessMode).toBe("write");
  });

  it("check_generation_status is a read tool", () => {
    const tool = creatorToolDefinitions.find(
      (t) => t.name === "check_generation_status"
    );
    expect(tool?.accessMode).toBe("read");
  });

  it("compare_before_after is a read tool", () => {
    const tool = creatorToolDefinitions.find(
      (t) => t.name === "compare_before_after"
    );
    expect(tool?.accessMode).toBe("read");
  });

  it("generate_image is a write tool", () => {
    const tool = creatorToolDefinitions.find((t) => t.name === "generate_image");
    expect(tool?.accessMode).toBe("write");
  });

  it("replace_segment is a write tool", () => {
    const tool = creatorToolDefinitions.find((t) => t.name === "replace_segment");
    expect(tool?.accessMode).toBe("write");
  });
});

// ── Phase 1C: generate_into_segment + CreatorToolExecutor ────────────────────
// Audit §B.ContentEditor was the last dormant module: a full
// generate→download→upload pipeline existed but no tool ever called it.
// This phase wires it via a new generate_into_segment tool exposed by a
// minimal CreatorToolExecutor (mirrors the AssetToolExecutor shape).

describe("GenerateIntoSegmentSchema", () => {
  it("accepts the minimum required input", () => {
    expect(
      GenerateIntoSegmentSchema.safeParse({
        element_id: "el-1",
        prompt: "snowy mountains",
        time_range: { start: 0, end: 5 },
      }).success,
    ).toBe(true);
  });

  it("accepts optional provider", () => {
    expect(
      GenerateIntoSegmentSchema.safeParse({
        element_id: "el-1",
        prompt: "snowy mountains",
        time_range: { start: 0, end: 5 },
        provider: "kling",
      }).success,
    ).toBe(true);
  });

  it("rejects missing prompt", () => {
    expect(
      GenerateIntoSegmentSchema.safeParse({
        element_id: "el-1",
        time_range: { start: 0, end: 5 },
      }).success,
    ).toBe(false);
  });

  it("rejects missing time_range", () => {
    expect(
      GenerateIntoSegmentSchema.safeParse({
        element_id: "el-1",
        prompt: "snowy mountains",
      }).success,
    ).toBe(false);
  });
});

describe("CreatorToolExecutor", () => {
  function makeExecutor(contentEditorOverrides: Partial<ContentEditor> = {}) {
    const replaceWithGenerated = vi.fn().mockResolvedValue({
      newStorageKey: "generated/abc.mp4",
    });
    const contentEditor = {
      replaceWithGenerated,
      ...contentEditorOverrides,
    } as unknown as ContentEditor;
    const executor = new CreatorToolExecutor({ contentEditor });
    return { executor, replaceWithGenerated };
  }

  it("hasToolName recognises generate_into_segment", () => {
    const { executor } = makeExecutor();
    expect(executor.hasToolName("generate_into_segment")).toBe(true);
    expect(executor.hasToolName("nonexistent_tool")).toBe(false);
  });

  it("generate_into_segment forwards mapped params to ContentEditor and returns the storageKey (2nd arg undefined when no callback)", async () => {
    const { executor, replaceWithGenerated } = makeExecutor();
    const result = await executor.execute(
      "generate_into_segment",
      {
        element_id: "el-1",
        prompt: "snowy mountains",
        time_range: { start: 1.5, end: 6 },
        provider: "kling",
      },
      { agentType: "creator", taskId: "task-001" },
    );

    expect(replaceWithGenerated).toHaveBeenCalledTimes(1);
    const callArgs = replaceWithGenerated.mock.calls[0];
    expect(callArgs[0]).toEqual({
      elementId: "el-1",
      prompt: "snowy mountains",
      timeRange: { start: 1.5, end: 6 },
      provider: "kling",
      agentId: "task-001",
    });
    // No onProgress passed → no adapter built → 2nd arg must be undefined.
    // A future refactor that always builds an adapter even when the
    // pipeline didn't pass onProgress would fail this — the goal is
    // zero overhead in the no-progress case.
    expect(callArgs[1]).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ newStorageKey: "generated/abc.mp4" });
  });

  // Phase 4 wire-through coverage (reviewer HIGH #8): the executor must
  // build a GenerationProgressCallback adapter that, when invoked with a
  // GenerationProgressUpdate, calls the pipeline's ToolProgressEvent
  // callback with the SAME numeric/text payload (toolName="generate_into_segment",
  // toolCallId injected later by wrappedProgress). Pass A's "loosen the
  // assertion" hid this — the legacy test only asserted the params arg.
  it("threads pipeline onProgress through ContentEditor as a properly-shaped adapter", async () => {
    const { executor, replaceWithGenerated } = makeExecutor();
    const pipelineOnProgress = vi.fn();

    await executor.execute(
      "generate_into_segment",
      {
        element_id: "el-1",
        prompt: "snowy mountains",
        time_range: { start: 1.5, end: 6 },
      },
      { agentType: "creator", taskId: "task-001" },
      pipelineOnProgress,
    );

    const adapter = replaceWithGenerated.mock.calls[0][1] as
      | ((u: { step: number; totalSteps?: number; text?: string; estimatedRemainingMs?: number }) => void)
      | undefined;
    expect(typeof adapter).toBe("function");

    // Simulate the generation client emitting a per-poll update — the
    // pipeline-side callback should receive a ToolProgressEvent whose
    // step/totalSteps/text/eta are mapped 1:1 from the update, with
    // toolName tagged "generate_into_segment".
    adapter!({ step: 60, totalSteps: 100, text: "Generation processing (60%)", estimatedRemainingMs: 7500 });

    expect(pipelineOnProgress).toHaveBeenCalledTimes(1);
    const event = pipelineOnProgress.mock.calls[0][0];
    expect(event.type).toBe("tool.progress");
    expect(event.toolName).toBe("generate_into_segment");
    expect(event.step).toBe(60);
    expect(event.totalSteps).toBe(100);
    expect(event.text).toBe("Generation processing (60%)");
    expect(event.estimatedRemainingMs).toBe(7500);
  });

  it("returns success:false on schema validation failure (does not call ContentEditor)", async () => {
    const { executor, replaceWithGenerated } = makeExecutor();
    const result = await executor.execute(
      "generate_into_segment",
      { element_id: "el-1" }, // missing prompt + time_range
      { agentType: "creator", taskId: "task-002" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/schema|required|invalid/i);
    expect(replaceWithGenerated).not.toHaveBeenCalled();
  });

  it("returns success:false when ContentEditor throws", async () => {
    const { executor } = makeExecutor({
      replaceWithGenerated: vi.fn().mockRejectedValue(new Error("provider 503")),
    } as Partial<ContentEditor>);
    const result = await executor.execute(
      "generate_into_segment",
      {
        element_id: "el-1",
        prompt: "snowy",
        time_range: { start: 0, end: 5 },
      },
      { agentType: "creator", taskId: "task-003" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("provider 503");
  });

  it("returns success:false for unregistered tool names", async () => {
    const { executor } = makeExecutor();
    const result = await executor.execute(
      "nonexistent_tool",
      {},
      { agentType: "creator", taskId: "task-004" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown|registered|nonexistent_tool/i);
  });
});
