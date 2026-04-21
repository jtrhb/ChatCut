import { z } from "zod";
import type { ToolDefinition, ToolDescriptionContext } from "./types.js";

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const ConstraintsSchema = z.object({
  maxIterations: z.number().optional(),
  timeoutMs: z.number().optional(),
});

const ContextSchema = z.record(z.string(), z.unknown());

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const AccessModeSchema = z.enum(["read", "write", "read_write"]);

export const DispatchVisionSchema = z.object({
  task: z.string(),
  accessMode: AccessModeSchema.default("read"),
  context: ContextSchema.optional(),
  constraints: ConstraintsSchema.optional(),
});

export const DispatchEditorSchema = z.object({
  task: z.string(),
  accessMode: AccessModeSchema.default("read_write"),
  context: ContextSchema.optional(),
  constraints: ConstraintsSchema.optional(),
});

export const DispatchCreatorSchema = z.object({
  task: z.string(),
  accessMode: AccessModeSchema.default("read_write"),
  context: ContextSchema.optional(),
  constraints: ConstraintsSchema.optional(),
});

export const DispatchAudioSchema = z.object({
  task: z.string(),
  accessMode: AccessModeSchema.default("read_write"),
  context: ContextSchema.optional(),
});

export const DispatchAssetSchema = z.object({
  task: z.string(),
  accessMode: AccessModeSchema.default("read"),
  context: ContextSchema.optional(),
});

const CandidateSchema = z.object({
  label: z.string(),
  summary: z.string(),
  candidateType: z.string(),
  commands: z.array(z.unknown()),
  expectedMetrics: z.object({
    durationChange: z.string(),
    affectedElements: z.number(),
  }),
});

export const ExploreOptionsSchema = z.object({
  intent: z.string(),
  baseSnapshotVersion: z.number(),
  timelineSnapshot: z.string(),
  candidates: z.array(CandidateSchema).min(3).max(4),
});

/**
 * Phase 5b: per-element ghost diff carried on a propose call. Mirrors
 * the `ProposedElement` runtime type in changeset/changeset-types.ts.
 * `payload` is `unknown` at the agent layer — the web client owns the
 * TimelineElement schema. Keeping this loose lets the agent forward
 * arbitrary shapes (insert vs. update vs. delete carry very different
 * payloads) without dragging the editor type system into the tool
 * schema and re-encoding it for every element variant.
 */
export const ProposedElementSchema = z.object({
  ghostId: z.string().min(1),
  kind: z.enum(["insert", "update", "delete"]),
  trackId: z.string().optional(),
  targetId: z.string().optional(),
  payload: z.unknown().optional(),
  dependsOn: z.array(z.string()).optional(),
});

export const ProposeChangesSchema = z.object({
  summary: z.string(),
  affectedElements: z.array(z.string()),
  /**
   * Phase 5b: prospective timeline diff. Optional with `[]` default so
   * a model trained before this field landed doesn't trip the schema
   * mid-turn — but the prompt-side delegation contract should ask the
   * model to populate it whenever it's destructive enough to require
   * propose_changes. Propose without elements is a smoke signal that
   * the model is hand-waving the spec.
   */
  proposedElements: z.array(ProposedElementSchema).optional().default([]),
  /**
   * Phase 5b (Q4=a): LLM self-reported confidence ∈ [0, 1]. The web
   * client maps this to ghost border styling. Optional with default
   * 0.5 so model omissions don't hard-fail propose; the manager re-
   * clamps defensively in case the model emits a value just outside
   * the bound.
   */
  confidence: z.number().min(0).max(1).optional().default(0.5),
});

export const ExportVideoSchema = z.object({
  format: z.string().default("mp4"),
  quality: z.enum(["preview", "standard", "high"]).default("standard"),
});

const DispatchVerificationSchema = z.object({
  task: z.string().describe("What to verify — include user intent, agent result, and affected elements"),
  context: ContextSchema.optional().describe("Verification context"),
});

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const masterToolDefinitions: ToolDefinition[] = [
  {
    name: "dispatch_vision",
    description:
      "Dispatch a task to the Vision sub-agent for visual analysis of the timeline or frames",
    inputSchema: DispatchVisionSchema,
    agentTypes: ["master"],
    accessMode: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
  },
  {
    name: "dispatch_editor",
    description:
      "Dispatch a task to the Editor sub-agent to read or mutate the timeline",
    inputSchema: DispatchEditorSchema,
    agentTypes: ["master"],
    accessMode: "read_write",
    isConcurrencySafe: false,
    descriptionSuffix: (ctx: ToolDescriptionContext) => {
      if (ctx.projectContext && ctx.projectContext["activeExplorationId"]) {
        return "(Note: edits will be queued during exploration)";
      }
      return undefined;
    },
  },
  {
    name: "dispatch_creator",
    description:
      "Dispatch a task to the Creator sub-agent to generate AI video or image assets",
    inputSchema: DispatchCreatorSchema,
    agentTypes: ["master"],
    accessMode: "read_write",
    isConcurrencySafe: false,
  },
  {
    name: "dispatch_audio",
    description:
      "Dispatch a task to the Audio sub-agent to mix, analyse, or generate audio",
    inputSchema: DispatchAudioSchema,
    agentTypes: ["master"],
    accessMode: "read_write",
    isConcurrencySafe: false,
  },
  {
    name: "dispatch_asset",
    description:
      "Dispatch a task to the Asset sub-agent to search or retrieve media assets",
    inputSchema: DispatchAssetSchema,
    agentTypes: ["master"],
    accessMode: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
  },
  {
    name: "explore_options",
    description:
      "Present 3–4 candidate edit strategies to the user and capture their intent for a fan-out exploration",
    inputSchema: ExploreOptionsSchema,
    agentTypes: ["master"],
    accessMode: "read",
    isReadOnly: true,
    isConcurrencySafe: false,
    descriptionSuffix: (ctx: ToolDescriptionContext) => {
      if (ctx.projectContext && ctx.projectContext["activeExplorationId"]) {
        return "(Note: per-project limit: 1 concurrent exploration)";
      }
      return undefined;
    },
  },
  {
    name: "propose_changes",
    description:
      "Propose a set of timeline changes to the user for approval before they are applied",
    inputSchema: ProposeChangesSchema,
    agentTypes: ["master"],
    accessMode: "write",
    isConcurrencySafe: false,
    descriptionSuffix: (ctx: ToolDescriptionContext) => {
      if (ctx.projectContext && ctx.projectContext["pendingChangesetId"]) {
        return "(Note: another changeset awaiting review)";
      }
      return undefined;
    },
  },
  {
    name: "export_video",
    description:
      "Trigger a video export job with the specified format and quality settings",
    inputSchema: ExportVideoSchema,
    agentTypes: ["master"],
    accessMode: "read",
    isReadOnly: true,
    isConcurrencySafe: false,
  },
  {
    name: "dispatch_verification",
    description:
      "Dispatch the Verification Agent to check if an edit/generation result matches the user's intent. Use after high-cost operations before committing.",
    inputSchema: DispatchVerificationSchema,
    agentTypes: ["master"],
    accessMode: "read" as const,
    isReadOnly: true,
    isConcurrencySafe: true,
  },
];
