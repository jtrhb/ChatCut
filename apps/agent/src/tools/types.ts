import { z } from "zod";

export type AgentType =
  | "master"
  | "editor"
  | "creator"
  | "audio"
  | "vision"
  | "asset";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  agentTypes: AgentType[]; // Which agents can use this tool
  accessMode: "read" | "write" | "read_write";
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
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
