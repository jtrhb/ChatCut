import { z } from "zod";
import type { AgentType } from "../agents/types.js";

export type { AgentType } from "../agents/types.js";

export interface ToolFilterContext {
  projectContext?: Readonly<Record<string, unknown>>;
  session?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export interface ToolDescriptionContext {
  projectContext?: Readonly<Record<string, unknown>>;
  activeSkills: Array<{ name: string }>;
  agentType: string;
}

export interface ToolFormatContext {
  filterContext: ToolFilterContext;
  descriptionContext: ToolDescriptionContext;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  agentTypes: AgentType[]; // Which agents can use this tool
  accessMode: "read" | "write" | "read_write";

  // P1: Fail-closed defaults
  isReadOnly?: boolean; // default false
  isConcurrencySafe?: boolean; // default false, true = can run parallel with other concurrent-safe tools

  // P2 (placeholder, logic not implemented):
  maxResultSizeChars?: number;
  summarize?: (result: unknown) => string;

  // P3: Optional guard — called with filter context when ctx is provided. Fail-closed on throw.
  isEnabled?: (ctx: ToolFilterContext) => boolean;

  // P4 (placeholder):
  shouldDefer?: boolean;
  searchHint?: string;

  // P5: Optional suffix generator — appended to description when ctx is provided.
  descriptionSuffix?: (ctx: ToolDescriptionContext) => string | undefined;
}

export interface ToolProgressEvent {
  type: "tool.progress";
  toolName: string;
  toolCallId: string;
  step: number;
  totalSteps?: number;
  text?: string;
  estimatedRemainingMs?: number;
}

export interface ToolVisualHint {
  affectedElements?: string[];
  operationType?: "trim" | "split" | "delete" | "move" | "add" | "effect" | "audio" | "generate";
  previewAvailable?: boolean;
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  visualHints?: ToolVisualHint;
}

/**
 * Execution context threaded through ToolPipeline → Executor → Tool impl.
 * `sessionId` + `userId` enable tenant isolation, per-session overflow store,
 * and per-dispatch taskId correlation. Added optional for incremental migration.
 */
export interface ToolContext {
  agentType: AgentType;
  taskId: string;
  toolCallId?: string;
  sessionId?: string;
  userId?: string;
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output: ToolCallResult;
  agentType: AgentType;
  taskId: string;
  timestamp: number;
  isWriteOp: boolean;
}
