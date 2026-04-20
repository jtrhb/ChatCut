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

/**
 * Phase 1C: drives ContentEditor.replaceWithGenerated end-to-end —
 * generation request → completion poll → upload → return storageKey.
 * The model can chain a separate replace_segment call (with the
 * returned new_storage_key) when timeline placement is needed.
 *
 * Audit §B.ContentEditor: this is the first call site for the existing
 * extract→generate→upload pipeline.
 */
export const GenerateIntoSegmentSchema = z.object({
  element_id: z.string(),
  prompt: z.string(),
  time_range: z.object({ start: z.number(), end: z.number() }),
  provider: z.enum(["kling", "seedance", "veo"]).optional(),
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
  {
    name: "generate_into_segment",
    description:
      "Generate a new video clip from a prompt and upload it to storage in one call. Returns the new storage key, which can then be passed to replace_segment to swap the timeline element.",
    inputSchema: GenerateIntoSegmentSchema,
    agentTypes: ["creator"],
    accessMode: "write",
  },
];
