import { randomUUID } from "crypto";
import type {
  AgentSession,
  CreateSessionParams,
  SessionMessage,
  SessionStatus,
} from "./types.js";
import { SessionStore } from "./session-store.js";

export class SessionManager {
  constructor(private store: SessionStore) {}

  createSession(params: CreateSessionParams): AgentSession {
    const now = Date.now();
    const session: AgentSession = {
      sessionId: randomUUID(),
      projectId: params.projectId,
      userId: params.userId,
      status: "active",
      messages: [],
      totalTokens: { input: 0, output: 0 },
      turnCount: 0,
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(session);
    return { ...session, messages: [...session.messages] };
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.store.get(sessionId);
  }

  appendMessage(sessionId: string, message: SessionMessage): void {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.messages.push(message);
    this.store.set(session);
  }

  updateStatus(sessionId: string, status: SessionStatus): void {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.status = status;
    this.store.set(session);
  }

  incrementTurn(
    sessionId: string,
    tokens: { input: number; output: number }
  ): void {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.turnCount += 1;
    session.totalTokens = {
      input: session.totalTokens.input + tokens.input,
      output: session.totalTokens.output + tokens.output,
    };
    this.store.set(session);
  }

  /**
   * Phase 5e: apply a compaction result. Persists the new summary, replaces
   * the message tail with the retained continuity buffer, and stamps
   * lastCompactedAt. Throws if the session no longer exists.
   *
   * Single combined method instead of separate setSummary / replaceMessages
   * so partial application is impossible — either both land or neither does.
   *
   * **Contract (Phase 5e MED-1):** `retainedTail` MUST be the COMPLETE
   * desired post-compaction message list — including any non-user/assistant
   * rows (e.g. `tool_result`) you want to keep. This method does an
   * unconditional `messages = retainedTail` write, so anything you omit is
   * destroyed. Today no caller persists `tool_result` to AgentSession.messages,
   * but if that changes the caller is responsible for re-stitching them in.
   */
  applyCompaction(
    sessionId: string,
    result: { summary: string; retainedTail: SessionMessage[] }
  ): void {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.summary = result.summary;
    session.messages = [...result.retainedTail];
    session.lastCompactedAt = Date.now();
    this.store.set(session);
  }

  forkSession(parentSessionId: string): AgentSession {
    const parent = this.store.get(parentSessionId);
    if (!parent) {
      throw new Error(`Session not found: ${parentSessionId}`);
    }
    const now = Date.now();
    const forked: AgentSession = {
      sessionId: randomUUID(),
      projectId: parent.projectId,
      userId: parent.userId,
      status: "active",
      messages: parent.messages.map((m) => ({ ...m })),
      totalTokens: { input: 0, output: 0 },
      turnCount: 0,
      metadata: { ...parent.metadata },
      createdAt: now,
      updatedAt: now,
      parentSessionId,
      // Phase 5e: forked sessions inherit the parent's compacted summary so
      // continuity isn't lost on the fork. lastCompactedAt is intentionally
      // NOT carried — the fork gets a fresh compaction clock.
      summary: parent.summary,
    };
    this.store.set(forked);
    return { ...forked, messages: [...forked.messages] };
  }

  countActiveSessions(): number {
    return this.store.countByStatus("active");
  }

  listSessions(projectId: string): AgentSession[] {
    return this.store.listByProject(projectId);
  }

  saveSession(sessionId: string): string {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return JSON.stringify(session);
  }

  restoreSession(serialized: string): AgentSession {
    const session = JSON.parse(serialized) as AgentSession;
    this.store.set(session);
    return this.store.get(session.sessionId)!;
  }
}
