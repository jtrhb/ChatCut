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
  /**
   * Phase 5e: rolling summary of pre-compaction conversation. When present, the
   * MasterAgent system prompt carries this so the model has continuity even
   * after the actual messages were dropped to free context window. SessionCompactor
   * writes this; SessionManager.applyCompaction is the sanctioned mutation path.
   */
  summary?: string;
  /** Phase 5e: timestamp of the most recent compaction. null/undefined if never compacted. */
  lastCompactedAt?: number;
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
