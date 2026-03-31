import { describe, it, expect, beforeEach } from "vitest";
import { ChangeLog } from "@opencut/core";
import { ContextSynchronizer } from "../context-sync.js";

function makeEntry(source: "human" | "agent" | "system", agentId?: string) {
  return {
    source,
    agentId,
    action: {
      type: "insert" as const,
      targetType: "element" as const,
      targetId: "el-1",
      details: {},
    },
    summary: `${source} did something`,
  };
}

describe("ContextSynchronizer", () => {
  let log: ChangeLog;
  let sync: ContextSynchronizer;

  beforeEach(() => {
    log = new ChangeLog();
    sync = new ContextSynchronizer(log);
  });

  it("returns null when there are no changes since last sync", () => {
    // Empty log — nothing to report.
    expect(sync.buildContextUpdate("agent-A")).toBeNull();
  });

  it("returns null when there are no new changes after a previous sync", () => {
    log.record(makeEntry("human"));
    sync.buildContextUpdate("agent-A"); // consume the entry
    // No new entries — should return null.
    expect(sync.buildContextUpdate("agent-A")).toBeNull();
  });

  it("builds an update from human changes", () => {
    log.record({ ...makeEntry("human"), summary: "User trimmed a clip" });
    const update = sync.buildContextUpdate("agent-A");
    expect(update).not.toBeNull();
    expect(update).toContain("Human");
    expect(update).toContain("User trimmed a clip");
  });

  it("excludes the agent's own changes", () => {
    // agent-A records its own entry
    log.record(makeEntry("agent", "agent-A"));
    const update = sync.buildContextUpdate("agent-A");
    // All entries belong to agent-A, so nothing to report.
    expect(update).toBeNull();
  });

  it("includes changes from other agents but not from self", () => {
    log.record(makeEntry("agent", "agent-A")); // own — excluded
    log.record(makeEntry("agent", "agent-B")); // other — included
    const update = sync.buildContextUpdate("agent-A");
    expect(update).not.toBeNull();
    expect(update).toContain("agent-B");
    expect(update).not.toContain("agent-A");
  });

  it("advances the cursor so subsequent calls only return new entries", () => {
    log.record(makeEntry("human")); // entry 0
    sync.buildContextUpdate("agent-A"); // cursor → 0

    log.record(makeEntry("human")); // entry 1 — new
    const second = sync.buildContextUpdate("agent-A");
    expect(second).not.toBeNull();
    // Should mention exactly 1 change.
    expect(second).toContain("1 change");

    // No more new entries.
    expect(sync.buildContextUpdate("agent-A")).toBeNull();
  });

  it("tracks independent cursors for multiple agents", () => {
    log.record(makeEntry("human")); // entry 0

    // agent-A consumes entry 0.
    sync.buildContextUpdate("agent-A");

    // agent-B hasn't synced yet — should still see entry 0.
    const updateB = sync.buildContextUpdate("agent-B");
    expect(updateB).not.toBeNull();
    expect(updateB).toContain("Human");

    // agent-A already consumed — nothing new.
    expect(sync.buildContextUpdate("agent-A")).toBeNull();
  });
});
