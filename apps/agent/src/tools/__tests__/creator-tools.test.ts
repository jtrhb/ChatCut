import { describe, it, expect } from "vitest";
import {
  GenerateVideoSchema,
  GenerateImageSchema,
  CheckGenerationStatusSchema,
  ReplaceSegmentSchema,
  CompareBeforeAfterSchema,
  creatorToolDefinitions,
} from "../creator-tools.js";

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
  it("contains exactly 5 tools", () => {
    expect(creatorToolDefinitions).toHaveLength(5);
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
