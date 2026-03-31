import { z } from "zod";
import type { ToolDefinition } from "./types.js";

// ── Zod Schemas ──────────────────────────────────────────────────────────────

export const GenerateVideoSchema = z.object({
  prompt: z.string(),
  provider: z.enum(["kling", "seedance", "veo"]).optional(),
  duration: z.number().optional(),
  ref_image: z.string().optional(),
  idempotencyKey: z.string(),
});

export const GenerateImageSchema = z.object({
  prompt: z.string(),
  provider: z.string().optional(),
  dimensions: z.string().optional(),
  idempotencyKey: z.string(),
});

export const CheckGenerationStatusSchema = z.object({
  task_id: z.string(),
});

export const ReplaceSegmentSchema = z.object({
  element_id: z.string(),
  new_storage_key: z.string(),
  time_range: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
});

export const CompareBeforeAfterSchema = z.object({
  element_id: z.string(),
  time: z.number(),
});

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const creatorToolDefinitions: ToolDefinition[] = [
  {
    name: "generate_video",
    description: "Generate a video clip from a text prompt using an AI provider",
    inputSchema: GenerateVideoSchema,
    agentTypes: ["creator"],
    accessMode: "write",
  },
  {
    name: "generate_image",
    description: "Generate an image from a text prompt using an AI provider",
    inputSchema: GenerateImageSchema,
    agentTypes: ["creator"],
    accessMode: "write",
  },
  {
    name: "check_generation_status",
    description: "Poll the status of an in-progress AI generation task",
    inputSchema: CheckGenerationStatusSchema,
    agentTypes: ["creator"],
    accessMode: "read",
  },
  {
    name: "replace_segment",
    description: "Replace a timeline segment with a new media asset from storage",
    inputSchema: ReplaceSegmentSchema,
    agentTypes: ["creator"],
    accessMode: "write",
  },
  {
    name: "compare_before_after",
    description: "Compare the original and replacement frames for a given element at a given time",
    inputSchema: CompareBeforeAfterSchema,
    agentTypes: ["creator"],
    accessMode: "read",
  },
];
