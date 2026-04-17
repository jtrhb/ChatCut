export type AgentType = "master" | "editor" | "creator" | "audio" | "vision" | "asset" | "verification";

export interface AgentConfig {
  agentType: AgentType;
  model: string;
  system: string;
  tools: unknown[];  // Claude API tool format
  tokenBudget?: { input: number; output: number };
  maxIterations?: number;
}

export interface AgentResult {
  text: string;
  toolCalls: Array<{ toolName: string; input: unknown; output: unknown }>;
  tokensUsed: { input: number; output: number };
  needsAssistance?: { agentType: string; task: string; context: unknown };
}

export interface DispatchInput {
  task: string;
  accessMode: "read" | "write" | "read_write";
  context?: Record<string, unknown>;
  constraints?: { maxIterations?: number; timeoutMs?: number };
  /** Identity propagated from the originating request (B1). Optional during migration. */
  identity?: {
    userId?: string;
    sessionId?: string;
    projectId?: string;
    taskId?: string;
  };
}

export interface DispatchOutput {
  result: string;
  artifacts?: Record<string, unknown>;
  needsAssistance?: { agentType: string; task: string; context: unknown };
  toolCallCount: number;
  tokensUsed: number;
}

export const TOKEN_BUDGETS = {
  master: { input: 100_000, output: 8_000 },
  editor: { input: 30_000, output: 4_000 },
  creator: { input: 30_000, output: 4_000 },
  audio: { input: 30_000, output: 4_000 },
  vision: { input: 50_000, output: 8_000 },
  asset: { input: 10_000, output: 2_000 },
  verification: { input: 10_000, output: 2_000 },
} as const;

export const MAX_ITERATIONS = {
  master: 30,
  editor: 20,
  creator: 10,
  audio: 15,
  vision: 5,
  asset: 10,
  verification: 1,
} as const;
