export type SessionStatus = "active" | "paused" | "completed" | "failed";

export interface AgentSession {
  sessionId: string;
  projectId: string;
  /** Owning user. Optional during B1 incremental migration; required once auth middleware lands. */
  userId?: string;
  status: SessionStatus;
  messages: SessionMessage[];
  totalTokens: { input: number; output: number };
  turnCount: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  parentSessionId?: string;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool_result";
  content: unknown;
  timestamp: number;
}

export interface CreateSessionParams {
  projectId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}
