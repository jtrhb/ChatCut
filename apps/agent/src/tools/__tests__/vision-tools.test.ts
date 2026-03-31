import { describe, it, expect } from "vitest";
import {
  AnalyzeVideoSchema,
  LocateSceneSchema,
  DescribeFrameSchema,
  visionToolDefinitions,
} from "../vision-tools.js";

// ── Schema Validation Tests ──────────────────────────────────────────────────

describe("Vision Tool Schemas", () => {
  describe("analyze_video", () => {
    it("accepts video_url only", () => {
      expect(
        AnalyzeVideoSchema.safeParse({
          video_url: "https://example.com/video.mp4",
        }).success
      ).toBe(true);
    });

    it("accepts optional focus field", () => {
      expect(
        AnalyzeVideoSchema.safeParse({
          video_url: "https://example.com/video.mp4",
          focus: "faces and emotions",
        }).success
      ).toBe(true);
    });

    it("rejects missing video_url", () => {
      expect(AnalyzeVideoSchema.safeParse({ focus: "faces" }).success).toBe(false);
    });

    it("rejects non-string video_url", () => {
      expect(AnalyzeVideoSchema.safeParse({ video_url: 42 }).success).toBe(false);
    });
  });

  describe("locate_scene", () => {
    it("accepts query only", () => {
      expect(
        LocateSceneSchema.safeParse({ query: "person walking" }).success
      ).toBe(true);
    });

    it("accepts optional context", () => {
      expect(
        LocateSceneSchema.safeParse({
          query: "person walking",
          context: { timeRange: { start: 0, end: 30 } },
        }).success
      ).toBe(true);
    });

    it("rejects missing query", () => {
      expect(LocateSceneSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-string query", () => {
      expect(LocateSceneSchema.safeParse({ query: 123 }).success).toBe(false);
    });
  });

  describe("describe_frame", () => {
    it("accepts valid time", () => {
      expect(DescribeFrameSchema.safeParse({ time: 5.5 }).success).toBe(true);
    });

    it("accepts time at min boundary (0)", () => {
      expect(DescribeFrameSchema.safeParse({ time: 0 }).success).toBe(true);
    });

    it("rejects negative time", () => {
      expect(DescribeFrameSchema.safeParse({ time: -1 }).success).toBe(false);
    });

    it("rejects missing time", () => {
      expect(DescribeFrameSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-number time", () => {
      expect(DescribeFrameSchema.safeParse({ time: "now" }).success).toBe(false);
    });
  });
});

// ── Tool Definition Tests ────────────────────────────────────────────────────

describe("visionToolDefinitions", () => {
  it("contains exactly 3 tools", () => {
    expect(visionToolDefinitions).toHaveLength(3);
  });

  it("all tools have agentType 'vision'", () => {
    for (const tool of visionToolDefinitions) {
      expect(tool.agentTypes).toContain("vision");
    }
  });

  it("has unique tool names", () => {
    const names = visionToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("analyze_video is a read tool", () => {
    const tool = visionToolDefinitions.find((t) => t.name === "analyze_video");
    expect(tool?.accessMode).toBe("read");
  });

  it("locate_scene is a read tool", () => {
    const tool = visionToolDefinitions.find((t) => t.name === "locate_scene");
    expect(tool?.accessMode).toBe("read");
  });

  it("describe_frame is a read tool", () => {
    const tool = visionToolDefinitions.find((t) => t.name === "describe_frame");
    expect(tool?.accessMode).toBe("read");
  });
});
