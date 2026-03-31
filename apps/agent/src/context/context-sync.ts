import type { ChangeLog } from "@opencut/core";
import type { ChangeEntry } from "@opencut/core";

export class ContextSynchronizer {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly changeLog: ChangeLog) {}

  /**
   * Build a human-readable context update for the given agent.
   * Returns null when there are no new entries since the last sync.
   * Advances the agent's cursor on every non-null return.
   */
  buildContextUpdate(agentId: string): string | null {
    const lastCursor = this.cursors.get(agentId) ?? -1;
    const entries = this.changeLog.getCommittedAfter(lastCursor, agentId);

    if (entries.length === 0) {
      return null;
    }

    // Advance cursor to point at the last entry currently in the log.
    this.cursors.set(agentId, this.changeLog.length - 1);

    return this.summarise(entries);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private summarise(entries: ChangeEntry[]): string {
    const lines = entries.map((e) => {
      const who = e.source === "human" ? "Human" : e.agentId ?? "System";
      return `- [${who}] ${e.summary} (${e.action.type} on ${e.action.targetType} ${e.action.targetId})`;
    });
    return `Context update (${entries.length} change${entries.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
  }
}
