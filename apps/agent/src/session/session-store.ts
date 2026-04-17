import type { AgentSession } from "./types.js";

/**
 * SessionStore with TTL eviction.
 *
 * Sessions are evicted once their `updatedAt` is older than maxIdleMs.
 * Eviction is lazy (on `get`) + opportunistic (on `set` — O(n) sweep
 * before insert). No background timer; the ambient process load does
 * the work as it touches the store.
 */
export class SessionStore {
  private sessions = new Map<string, AgentSession>();
  private readonly maxIdleMs: number;
  /** Max sessions in flight; when exceeded, oldest-idle are evicted first. */
  private readonly maxEntries: number;

  constructor(opts?: { maxIdleMs?: number; maxEntries?: number }) {
    // Default 30 minutes idle — matches OverflowStore convention.
    this.maxIdleMs = opts?.maxIdleMs ?? 30 * 60 * 1000;
    // Default 10k entries — generous ceiling; real concurrent-session
    // counts in tests sit in the single digits, but the bound prevents
    // pathological growth if a leak ever slips through.
    this.maxEntries = opts?.maxEntries ?? 10_000;
  }

  get(sessionId: string): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // Lazy expiration check: if the session has been idle beyond the TTL,
    // pretend it no longer exists and clean it up. A future `set` with the
    // same id would create a fresh record rather than "revive" the stale
    // one, which matches what the session manager expects.
    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    // Return shallow copy to prevent external mutation
    return { ...session, messages: [...session.messages] };
  }

  set(session: AgentSession): void {
    // Opportunistic sweep: as long as writes happen at least occasionally
    // (and they do — every agent turn writes), expired sessions get
    // garbage-collected without a background timer.
    this.sweepExpired();

    // Enforce a hard ceiling. In practice this rarely fires, but it keeps
    // the worst case bounded if a writer suddenly bursts.
    if (this.sessions.size >= this.maxEntries && !this.sessions.has(session.sessionId)) {
      this.evictOldest();
    }

    this.sessions.set(session.sessionId, {
      ...session,
      messages: [...session.messages],
      updatedAt: Date.now(),
    });
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  countByStatus(status: AgentSession["status"]): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (this.isExpired(session)) continue;
      if (session.status === status) count++;
    }
    return count;
  }

  listByProject(projectId: string): AgentSession[] {
    const result: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (this.isExpired(session)) continue;
      if (session.projectId === projectId) {
        result.push({ ...session, messages: [...session.messages] });
      }
    }
    return result;
  }

  /**
   * Remove every expired session. Exposed for tests + callers that want
   * to force a sweep (e.g. a health endpoint).
   */
  sweepExpired(): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Exposed for observability / tests. */
  size(): number {
    return this.sessions.size;
  }

  private isExpired(session: AgentSession): boolean {
    return Date.now() - session.updatedAt > this.maxIdleMs;
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < oldestAt) {
        oldestAt = session.updatedAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) {
      this.sessions.delete(oldestId);
    }
  }
}
