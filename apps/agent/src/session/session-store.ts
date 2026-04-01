import type { AgentSession } from "./types.js";

export class SessionStore {
  private sessions = new Map<string, AgentSession>();

  get(sessionId: string): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // Return shallow copy to prevent external mutation
    return { ...session, messages: [...session.messages] };
  }

  set(session: AgentSession): void {
    this.sessions.set(session.sessionId, {
      ...session,
      messages: [...session.messages],
      updatedAt: Date.now(),
    });
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  listByProject(projectId: string): AgentSession[] {
    const result: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) {
        result.push({ ...session, messages: [...session.messages] });
      }
    }
    return result;
  }
}
