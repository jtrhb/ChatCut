import { describe, it, expect } from "vitest";
import { skills } from "../schema.js";

describe("skills table schema", () => {
  it("has performance tracking columns", () => {
    const columns = Object.keys(skills);
    expect(columns).toContain("approveCount");
    expect(columns).toContain("rejectCount");
    expect(columns).toContain("sessionsSeen");
    expect(columns).toContain("consecutiveRejects");
    expect(columns).toContain("createdSessionId");
    expect(columns).toContain("lastSessionId");
  });
});
