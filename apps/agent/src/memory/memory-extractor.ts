import { nanoid } from "nanoid";
import type { ChangeLog, ChangeEntry, ChangesetDecisionEvent } from "@opencut/core";
import type { ParsedMemory } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal read-only interface for the memory store — MemoryExtractor needs
// to enumerate drafts/explicit directories and read existing memories to
// reinforce them, but NEVER writes directly. Writes are routed through a
// Master-owned callback so MasterAgent remains the sole writer (spec §9.4).
// ---------------------------------------------------------------------------

interface MemoryReader {
  listDir(path: string): Promise<string[]>;
  readParsed(path: string): Promise<ParsedMemory>;
  exists(path: string): Promise<boolean>;
}

/** Writer callback injected by MasterAgent. The callback internally uses the
 *  Master's writer token to reach the real MemoryStore. Extractor never sees
 *  the token or the store directly. */
type MemoryWriter = (path: string, memory: ParsedMemory) => Promise<void>;

/**
 * Phase 5c: writer callback for conflict markers, also injected by MasterAgent.
 * Optional — when omitted, the extractor still records draft memories on
 * rejection but skips marker writes (for tests / minimal boots that don't
 * exercise the conflict surface).
 */
type ConflictMarkerWriter = (params: {
  actionType: string;
  target?: string;
  severity: "high" | "medium" | "low";
  conflictsWith?: string[];
  reason: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SignalClassification {
  type: string;
  severity: "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------
// MemoryExtractor
// ---------------------------------------------------------------------------

export class MemoryExtractor {
  private readonly changeLog: ChangeLog;
  private readonly reader: MemoryReader;
  private readonly writeMemory: MemoryWriter;
  /** Phase 5c: optional — writes a `_conflicts/*` marker when 3+ consecutive
   *  rejections of the same signal type fire. Skipped silently when not wired. */
  private readonly writeConflictMarker?: ConflictMarkerWriter;
  private readonly sessionId: string;

  constructor(deps: {
    changeLog: ChangeLog;
    memoryReader: MemoryReader;
    writeMemory: MemoryWriter;
    writeConflictMarker?: ConflictMarkerWriter;
    sessionId?: string;
  }) {
    this.changeLog = deps.changeLog;
    this.reader = deps.memoryReader;
    this.writeMemory = deps.writeMemory;
    this.writeConflictMarker = deps.writeConflictMarker;
    this.sessionId = deps.sessionId ?? `session-${nanoid(6)}`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Subscribe to changeLog "decision" events. */
  start(): void {
    this.changeLog.on("decision", (event: ChangesetDecisionEvent) => {
      void this.onChangesetDecision(event);
    });
  }

  /** Route to the appropriate handler based on the decision event type. */
  async onChangesetDecision(event: ChangesetDecisionEvent): Promise<void> {
    if (event.type === "changeset_rejected") {
      await this.handleRejection(event.changesetId);
    } else if (event.type === "changeset_committed") {
      await this.handleApproval(event.changesetId);
    }
  }

  /**
   * Handle a rejected changeset:
   * 1. Get entries from changeLog
   * 2. Analyse what went wrong
   * 3. Create draft memory: source="implicit", status="draft", confidence="low"
   * 4. If 3+ consecutive rejections of same type → set activation_scope
   * 5. Write to memoryStore
   */
  async handleRejection(changesetId: string): Promise<ParsedMemory | null> {
    const entries = this.changeLog.getByChangeset(changesetId);
    if (entries.length === 0) return null;

    const signal = this.classifySignal(entries);
    const now = new Date().toISOString();
    const memoryId = `mem-${nanoid(8)}`;

    const memory: ParsedMemory = {
      memory_id: memoryId,
      type: "pattern",
      status: "draft",
      confidence: "low",
      source: "implicit",
      created: now,
      updated: now,
      reinforced_count: 0,
      last_reinforced_at: now,
      source_change_ids: entries.map((e) => e.id),
      used_in_changeset_ids: [changesetId],
      created_session_id: this.sessionId,
      last_reinforced_session_id: this.sessionId,
      scope: "global",
      scope_level: "global",
      semantic_key: `rejected-${signal.type}-pattern`,
      tags: [signal.type, "rejection", signal.severity],
      content: `User rejected a changeset containing ${signal.type} actions. Signal severity: ${signal.severity}.`,
    };

    // Check for 3+ consecutive rejections of the same signal type
    const consecutiveCount = this.countConsecutiveRejections(signal.type, changesetId);
    if (consecutiveCount >= 2) {
      // This is the 3rd (or more) consecutive rejection — set activation_scope
      memory.activation_scope = { session_id: changesetId };
    }

    const path = `drafts/${memory.memory_id}.md`;
    await this.writeMemory(path, memory);

    // Phase 5c: same 3+ consecutive trigger as activation_scope above. Writes
    // a `_conflicts/{ts}-{signalType}-{hash}.md` marker via the master-bound
    // callback so the next turn's prompt builder surfaces it as an active
    // conflict the agent must acknowledge before re-proposing the action.
    // Best-effort — marker-write failures must not break the rejection-handling
    // path that already persisted the draft memory above.
    if (consecutiveCount >= 2 && this.writeConflictMarker) {
      try {
        await this.writeConflictMarker({
          actionType: signal.type,
          severity: signal.severity,
          conflictsWith: [path],
          reason:
            `User rejected ${consecutiveCount + 1} consecutive changesets ` +
            `containing ${signal.type} actions. The agent should acknowledge ` +
            `this pattern and propose a different approach (or ask the user ` +
            `to clarify what they want instead) before re-proposing ${signal.type}.`,
        });
      } catch (err) {
        // Telemetry-only; the draft memory above already captured the signal.
        console.warn(
          `[MemoryExtractor] writeConflictMarker failed for ${signal.type}; draft memory at ${path} is still persisted.`,
          err instanceof Error ? (err.stack ?? err.message) : err,
        );
      }
    }

    return memory;
  }

  /**
   * Handle an approved changeset:
   * Reinforce related memories (increment reinforced_count, update last_reinforced_at).
   * Does NOT create new memories.
   */
  async handleApproval(changesetId: string): Promise<void> {
    const entries = this.changeLog.getByChangeset(changesetId);
    if (entries.length === 0) return;

    const signal = this.classifySignal(entries);

    // Look for related draft/active memories to reinforce
    const relatedMemories = await this.findRelatedMemories(signal.type);

    const now = new Date().toISOString();
    for (const { path, memory } of relatedMemories) {
      const updated: ParsedMemory = {
        ...memory,
        reinforced_count: memory.reinforced_count + 1,
        last_reinforced_at: now,
        last_reinforced_session_id: this.sessionId,
        updated: now,
        used_in_changeset_ids: [...memory.used_in_changeset_ids, changesetId],
      };
      await this.writeMemory(path, updated);
    }
  }

  /**
   * Handle explicit user input.
   * Direct write: source="explicit", status="active", confidence="high".
   * No draft phase needed.
   */
  async handleExplicitInput(input: {
    content: string;
    scope: string;
    tags: string[];
  }): Promise<ParsedMemory> {
    const now = new Date().toISOString();
    const memoryId = `mem-${nanoid(8)}`;

    const scopeLevel = this.deriveScopeLevel(input.scope);

    const memory: ParsedMemory = {
      memory_id: memoryId,
      type: "preference",
      status: "active",
      confidence: "high",
      source: "explicit",
      created: now,
      updated: now,
      reinforced_count: 0,
      last_reinforced_at: now,
      source_change_ids: [],
      used_in_changeset_ids: [],
      created_session_id: this.sessionId,
      last_reinforced_session_id: this.sessionId,
      scope: input.scope,
      scope_level: scopeLevel,
      semantic_key: `explicit-${nanoid(6)}`,
      tags: input.tags,
      content: input.content,
    };

    const path = `explicit/${memory.memory_id}.md`;
    await this.writeMemory(path, memory);

    return memory;
  }

  /**
   * Session Gate: a draft can only promote to active if it was reinforced in a
   * DIFFERENT session from the one it was created in.
   *
   * Returns true when:
   *   - last_reinforced_session_id is set
   *   - last_reinforced_session_id !== created_session_id
   *   - last_reinforced_session_id === currentSessionId (being reinforced now)
   */
  canPromoteDraft(memory: ParsedMemory, currentSessionId: string): boolean {
    if (!memory.last_reinforced_session_id) return false;
    if (memory.last_reinforced_session_id === memory.created_session_id) return false;
    return memory.last_reinforced_session_id === currentSessionId;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Classify the dominant action type and severity from a set of ChangeEntry objects.
   */
  private classifySignal(entries: ChangeEntry[]): SignalClassification {
    if (entries.length === 0) {
      return { type: "unknown", severity: "low" };
    }

    // Count action types
    const typeCounts = new Map<string, number>();
    for (const entry of entries) {
      const t = entry.action.type;
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }

    // Find the dominant type
    let dominantType = "unknown";
    let maxCount = 0;
    for (const [type, count] of typeCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominantType = type;
      }
    }

    // Severity: high for destructive ops, medium for structural, low otherwise
    const highSeverityTypes = new Set(["delete", "trim", "split"]);
    const mediumSeverityTypes = new Set(["move", "batch", "transition"]);

    let severity: "high" | "medium" | "low" = "low";
    if (highSeverityTypes.has(dominantType)) {
      severity = "high";
    } else if (mediumSeverityTypes.has(dominantType)) {
      severity = "medium";
    }

    return { type: dominantType, severity };
  }

  /**
   * Count how many prior decisions were rejections of the same signal type,
   * going backwards from (but not including) the current changesetId.
   */
  private countConsecutiveRejections(signalType: string, currentChangesetId: string): number {
    const decisions = this.changeLog.getDecisions();
    // Find index of current changeset decision (not yet recorded, so just look at all prior)
    let count = 0;

    // Walk decisions in reverse (most recent first), skipping the current one
    for (let i = decisions.length - 1; i >= 0; i--) {
      const decision = decisions[i];
      if (decision.changesetId === currentChangesetId) continue;

      if (decision.type !== "changeset_rejected") break;

      // Check if the entries for this prior rejected changeset have the same signal type
      const priorEntries = this.changeLog.getByChangeset(decision.changesetId);
      const priorSignal = this.classifySignal(priorEntries);
      if (priorSignal.type !== signalType) break;

      count++;
    }

    return count;
  }

  /**
   * Find memories related to a given signal type by scanning drafts directory.
   */
  private async findRelatedMemories(
    signalType: string
  ): Promise<Array<{ path: string; memory: ParsedMemory }>> {
    const results: Array<{ path: string; memory: ParsedMemory }> = [];

    const dirs = ["drafts/", "explicit/"];
    for (const dir of dirs) {
      let filenames: string[];
      try {
        filenames = await this.reader.listDir(dir);
      } catch {
        continue;
      }

      for (const filename of filenames) {
        const path = `${dir}${filename}`;
        try {
          const memory = await this.reader.readParsed(path);
          // A memory is "related" if it shares the signal type in its tags or semantic_key
          if (
            memory.tags.includes(signalType) ||
            memory.semantic_key.includes(signalType)
          ) {
            results.push({ path, memory });
          }
        } catch {
          // skip unparseable files
        }
      }
    }

    return results;
  }

  /** Derive scope_level from a scope string like "global", "brand:x", "project:y". */
  private deriveScopeLevel(scope: string): ParsedMemory["scope_level"] {
    if (scope === "global") return "global";
    const prefix = scope.split(":")[0];
    const validLevels: ParsedMemory["scope_level"][] = [
      "global",
      "brand",
      "platform",
      "series",
      "project",
    ];
    if (validLevels.includes(prefix as ParsedMemory["scope_level"])) {
      return prefix as ParsedMemory["scope_level"];
    }
    return "global";
  }
}
