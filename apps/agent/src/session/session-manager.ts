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

  forkSession(parentSessionId: string): AgentSession {
    const parent = this.store.get(parentSessionId);
    if (!parent) {
      throw new Error(`Session not found: ${parentSessionId}`);
    }
    const now = Date.now();
    const forked: AgentSession = {
      sessionId: randomUUID(),
      projectId: parent.projectId,
      status: "active",
      messages: parent.messages.map((m) => ({ ...m })),
      totalTokens: { input: 0, output: 0 },
      turnCount: 0,
      metadata: { ...parent.metadata },
      createdAt: now,
      updatedAt: now,
      parentSessionId,
    };
    this.store.set(forked);
    return { ...forked, messages: [...forked.messages] };
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
