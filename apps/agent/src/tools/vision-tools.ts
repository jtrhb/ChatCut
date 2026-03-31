import { z } from "zod";
import type { ToolDefinition } from "./types.js";

// ── Zod Schemas ──────────────────────────────────────────────────────────────

export const AnalyzeVideoSchema = z.object({
  video_url: z.string(),
  focus: z.string().optional(),
});

export const LocateSceneSchema = z.object({
  query: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const DescribeFrameSchema = z.object({
  time: z.number().min(0),
});

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const visionToolDefinitions: ToolDefinition[] = [
  {
    name: "analyze_video",
    description: "Analyze a video URL and return a structured description of its content",
    inputSchema: AnalyzeVideoSchema,
    agentTypes: ["vision"],
    accessMode: "read",
  },
  {
    name: "locate_scene",
    description: "Locate a scene or moment in the active project matching a natural-language query",
    inputSchema: LocateSceneSchema,
    agentTypes: ["vision"],
    accessMode: "read",
  },
  {
    name: "describe_frame",
    description: "Describe the visual content of the timeline frame at a given time",
    inputSchema: DescribeFrameSchema,
    agentTypes: ["vision"],
    accessMode: "read",
  },
];
