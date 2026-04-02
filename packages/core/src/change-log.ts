import EventEmitter from "eventemitter3";
import { generateUUID } from "./utils/id";
import type { ChangeEntry, ChangesetDecisionEvent } from "./types/change-log";

export class ChangeLog extends EventEmitter {
  private readonly entries: ChangeEntry[] = [];
  private readonly decisions: ChangesetDecisionEvent[] = [];

  /**
   * Record a new change entry. Auto-generates id and timestamp.
   * Emits "entry" with the created ChangeEntry.
   */
  record(input: Omit<ChangeEntry, "id" | "timestamp">): ChangeEntry {
    const entry: ChangeEntry = {
      ...input,
      id: generateUUID(),
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.emit("entry", entry);
    return entry;
  }

  /**
   * Record a changeset decision and emit "decision".
   */
  emitDecision(event: ChangesetDecisionEvent): void {
    this.decisions.push(event);
    this.emit("decision", event);
  }

  /** Return all recorded entries as a readonly array. */
  getAll(): readonly ChangeEntry[] {
    return this.entries;
  }

  /** Return all recorded changeset decisions as a readonly array. */
  getDecisions(): readonly ChangesetDecisionEvent[] {
    return this.decisions;
  }

  /**
   * Return entries after the given index (exclusive), optionally excluding
   * entries attributed to a specific agentId.
   */
  getCommittedAfter(afterIndex: number, excludeAgentId?: string): ChangeEntry[] {
    const slice = this.entries.slice(afterIndex + 1);
    if (excludeAgentId === undefined) {
      return slice;
    }
    return slice.filter((e) => e.agentId !== excludeAgentId);
  }

  /** Return all entries associated with a given changesetId. */
  getByChangeset(changesetId: string): ChangeEntry[] {
    return this.entries.filter((e) => e.changesetId === changesetId);
  }

  /** Total number of recorded entries. */
  get length(): number {
    return this.entries.length;
  }
}
