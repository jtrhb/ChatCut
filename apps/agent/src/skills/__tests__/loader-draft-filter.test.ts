import { describe, it, expect, vi } from "vitest";
import { SkillLoader } from "../loader.js";
import type { ParsedMemory } from "../../memory/types.js";

function makeSkillMemory(overrides: Partial<ParsedMemory>): ParsedMemory {
  return {
    memory_id: "m-1",
    type: "pattern",
    status: "active",
    confidence: "high",
    source: "observed",
    created: "2025-01-01T00:00:00.000Z",
    updated: "2025-01-01T00:00:00.000Z",
    reinforced_count: 0,
    last_reinforced_at: "2025-01-01T00:00:00.000Z",
    source_change_ids: [],
    used_in_changeset_ids: [],
    created_session_id: "sess-1",
    scope: "global",
    scope_level: "global",
    semantic_key: "test-skill",
    tags: [],
    content: "test skill content",
    skill_id: "skill-1",
    skill_status: "draft",
    agent_type: "master",
    ...overrides,
  } as ParsedMemory;
}

describe("SkillLoader draft scope filtering", () => {
  it("includes draft skill matching current brand", async () => {
    const memoryStore = {
      listDir: vi.fn().mockResolvedValue([]),
      readParsed: vi.fn(),
    };

    const loader = new SkillLoader(memoryStore as any);

    // Test the filterDraftsByScope logic directly
    const drafts = [
      makeSkillMemory({ scope: "brand:acme", skill_status: "draft" }),
      makeSkillMemory({ scope: "brand:other", skill_status: "draft", skill_id: "skill-2" }),
    ];

    const filtered = loader.filterDraftsByScope(drafts, "acme");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].skill_id).toBe("skill-1");
  });

  it("includes draft skill with no scope (global)", async () => {
    const loader = new SkillLoader(null as any);
    const drafts = [
      makeSkillMemory({ scope: "global", skill_status: "draft" }),
    ];

    const filtered = loader.filterDraftsByScope(drafts);
    expect(filtered).toHaveLength(1);
  });

  it("excludes draft skill with non-matching series", async () => {
    const loader = new SkillLoader(null as any);
    const drafts = [
      makeSkillMemory({
        scope: "brand:acme/series:daily",
        skill_status: "draft",
      }),
    ];

    const filtered = loader.filterDraftsByScope(drafts, "acme", "weekly");
    expect(filtered).toHaveLength(0);
  });
});
