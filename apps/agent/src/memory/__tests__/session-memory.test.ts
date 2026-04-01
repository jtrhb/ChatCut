import { describe, it, expect } from "vitest";
import { SessionMemory } from "../session-memory.js";

describe("SessionMemory", () => {
  // 1. record() stores entry
  it("record() stores an entry with timestamp", () => {
    const sm = new SessionMemory();
    sm.record({ type: "user_intent", content: "User wants a cut." });
    const entries = sm.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user_intent");
    expect(entries[0].content).toBe("User wants a cut.");
    expect(typeof entries[0].timestamp).toBe("number");
  });

  // 2. record() evicts oldest when maxEntries exceeded
  it("record() evicts the oldest entry when maxEntries is exceeded", () => {
    const sm = new SessionMemory({ maxEntries: 5 });
    for (let i = 1; i <= 5; i++) {
      sm.record({ type: "observation", content: `entry-${i}` });
    }
    expect(sm.getEntries()).toHaveLength(5);
    // Adding a 6th should evict entry-1
    sm.record({ type: "observation", content: "entry-6" });
    const entries = sm.getEntries();
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.content)).not.toContain("entry-1");
    expect(entries.map((e) => e.content)).toContain("entry-6");
  });

  // 3. summarize() produces text summary, empty string when no entries
  it("summarize() returns bullet list of contents, or empty string when empty", () => {
    const sm = new SessionMemory();
    expect(sm.summarize()).toBe("");

    sm.record({ type: "decision", content: "Use jump cut." });
    sm.record({ type: "agent_action", content: "Applied transition." });
    const summary = sm.summarize();
    expect(summary).toContain("- Use jump cut.");
    expect(summary).toContain("- Applied transition.");
  });

  // 4. clear() removes all
  it("clear() removes all stored entries", () => {
    const sm = new SessionMemory();
    sm.record({ type: "tool_result", content: "Tool returned X." });
    sm.record({ type: "observation", content: "Observed Y." });
    expect(sm.getEntries()).toHaveLength(2);
    sm.clear();
    expect(sm.getEntries()).toHaveLength(0);
  });

  // 5. toPromptText() formats with type labels
  it("toPromptText() formats entries with [type] prefix, or empty string when empty", () => {
    const sm = new SessionMemory();
    expect(sm.toPromptText()).toBe("");

    sm.record({ type: "user_intent", content: "Make it snappy." });
    sm.record({ type: "tool_result", content: "Cut applied at 00:05." });
    const text = sm.toPromptText();
    expect(text).toContain("[user_intent] Make it snappy.");
    expect(text).toContain("[tool_result] Cut applied at 00:05.");
  });
});
