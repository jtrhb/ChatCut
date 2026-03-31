import { describe, it, expect, vi } from "vitest";
import { ChangeLog } from "../change-log";
import type { ChangeEntry, ChangesetDecisionEvent } from "../types/change-log";

const makeInput = (overrides: Partial<Omit<ChangeEntry, "id" | "timestamp">> = {}): Omit<ChangeEntry, "id" | "timestamp"> => ({
  source: "human",
  action: {
    type: "insert",
    targetType: "element",
    targetId: "el-1",
    details: { trackId: "track-1" },
  },
  summary: "Inserted element el-1",
  ...overrides,
});

describe("ChangeLog", () => {
  it("record creates entry with auto-generated id and timestamp", () => {
    const log = new ChangeLog();
    const before = Date.now();
    const entry = log.record(makeInput());
    const after = Date.now();

    expect(entry.id).toBeTruthy();
    expect(typeof entry.id).toBe("string");
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
    expect(entry.source).toBe("human");
    expect(entry.summary).toBe("Inserted element el-1");
  });

  it("getAll returns all recorded entries", () => {
    const log = new ChangeLog();
    expect(log.getAll()).toHaveLength(0);

    log.record(makeInput({ summary: "first" }));
    log.record(makeInput({ summary: "second" }));

    const all = log.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].summary).toBe("first");
    expect(all[1].summary).toBe("second");
  });

  it("getCommittedAfter filters by index", () => {
    const log = new ChangeLog();
    log.record(makeInput({ summary: "entry-0" }));
    log.record(makeInput({ summary: "entry-1" }));
    log.record(makeInput({ summary: "entry-2" }));

    const result = log.getCommittedAfter(1);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe("entry-2");
  });

  it("getCommittedAfter excludes specified agentId", () => {
    const log = new ChangeLog();
    log.record(makeInput({ source: "agent", agentId: "agent-a", summary: "by-agent-a" }));
    log.record(makeInput({ source: "agent", agentId: "agent-b", summary: "by-agent-b" }));
    log.record(makeInput({ source: "human", summary: "by-human" }));

    const result = log.getCommittedAfter(0, "agent-a");
    expect(result.map((e) => e.summary)).toEqual(["by-agent-b", "by-human"]);
  });

  it("emitDecision records changeset decisions", () => {
    const log = new ChangeLog();
    const decision: ChangesetDecisionEvent = {
      type: "changeset_committed",
      changesetId: "cs-1",
      timestamp: Date.now(),
    };

    log.emitDecision(decision);

    const decisions = log.getDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual(decision);
  });

  it("getByChangeset filters by changesetId", () => {
    const log = new ChangeLog();
    log.record(makeInput({ changesetId: "cs-1", summary: "in-cs-1" }));
    log.record(makeInput({ changesetId: "cs-2", summary: "in-cs-2" }));
    log.record(makeInput({ changesetId: "cs-1", summary: "also-in-cs-1" }));

    const result = log.getByChangeset("cs-1");
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.summary)).toEqual(["in-cs-1", "also-in-cs-1"]);
  });

  it("emits 'entry' event on record", () => {
    const log = new ChangeLog();
    const listener = vi.fn();
    log.on("entry", listener);

    const entry = log.record(makeInput());

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(entry);
  });

  it("emits 'decision' event on emitDecision", () => {
    const log = new ChangeLog();
    const listener = vi.fn();
    log.on("decision", listener);

    const decision: ChangesetDecisionEvent = {
      type: "changeset_rejected",
      changesetId: "cs-99",
      timestamp: Date.now(),
    };
    log.emitDecision(decision);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(decision);
  });

  it("length property returns number of recorded entries", () => {
    const log = new ChangeLog();
    expect(log.length).toBe(0);

    log.record(makeInput());
    expect(log.length).toBe(1);

    log.record(makeInput());
    expect(log.length).toBe(2);
  });
});
