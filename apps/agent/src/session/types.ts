export type SessionStatus = "active" | "paused" | "completed" | "failed";

export interface AgentSession {
  sessionId: string;
  projectId: string;
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
  metadata?: Record<string, unknown>;
}
