import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillLoader } from "../loader.js";
import type { ParsedMemory } from "../../memory/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<ParsedMemory> = {}): ParsedMemory {
  return {
    memory_id: "skill-001",
    type: "knowledge",
    status: "active",
    confidence: "high",
    source: "explicit",
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
    content: "Skill content here.",
    skill_id: "skill_001",
    skill_status: "validated",
    agent_type: "editor",
    applies_to: ["pacing"],
    ...overrides,
  };
}

function makeMockStore(skills: ParsedMemory[] = []) {
  return {
    listDir: vi.fn<[string], Promise<string[]>>(async () =>
      skills.map((s) => `${s.skill_id}.md`)
    ),
    readParsed: vi.fn<[string], Promise<ParsedMemory>>(async () => skills[0]),
  };
}

// ---------------------------------------------------------------------------
// A testable subclass that injects preset files without hitting disk
// ---------------------------------------------------------------------------

class TestableSkillLoader extends SkillLoader {
  private readonly presetRaw: Array<{ file: string; content: string }>;

  constructor(
    store: any,
    presets: Array<{ file: string; content: string }> = []
  ) {
    super(store);
    this.presetRaw = presets;
  }

  protected override listPresetFiles(): string[] {
    return this.presetRaw.map((p) => p.file);
  }

  // Override loadSystemPresets to use injected raw strings instead of disk
  override async loadSystemPresets(agentType: string): Promise<ParsedMemory[]> {
    const results: ParsedMemory[] = [];
    for (const { content } of this.presetRaw) {
      try {
        // Access the private parser via a cast trick
        const mem = (this as any).parseFrontmatter(content);
        if (mem.agent_type === agentType) {
          results.push(mem);
        }
      } catch {
        // skip
      }
    }
    return results;
  }
}

const EDITOR_PRESET_RAW = `---
skill_id: skill_preset_beat_sync
skill_status: validated
agent_type: editor
applies_to: ["pacing","rhythm"]
---

# Beat-Sync Editing

Cut on the beat.`;

const AUDIO_PRESET_RAW = `---
skill_id: skill_preset_audio_ducking
skill_status: validated
agent_type: audio
applies_to: ["mixing","ducking"]
---

# Audio Ducking

Duck music under voice.`;

// ---------------------------------------------------------------------------
// Tests: loadSkills
// ---------------------------------------------------------------------------

describe("SkillLoader.loadSkills", () => {
  // ── 1. filters by agentType ───────────────────────────────────────────────
  it("returns only skills matching agentType", async () => {
    const editorSkill = makeSkill({ skill_id: "s1", agent_type: "editor" });
    const creatorSkill = makeSkill({
      skill_id: "s2",
      agent_type: "creator",
      semantic_key: "creator-skill",
    });

    const store = {
      listDir: vi.fn(async () => ["s1.md", "s2.md"]),
      readParsed: vi.fn()
        .mockResolvedValueOnce(editorSkill)
        .mockResolvedValueOnce(creatorSkill),
    };

    const loader = new SkillLoader(store as any);
    const result = await loader.loadSkills("editor", { brand: "acme" });

    expect(result).toHaveLength(1);
    expect(result[0].agent_type).toBe("editor");
  });

  // ── 2. excludes deprecated skills ────────────────────────────────────────
  it("excludes skills with skill_status === deprecated", async () => {
    const validSkill = makeSkill({
      skill_id: "s-valid",
      skill_status: "validated",
      agent_type: "editor",
    });
    const deprecatedSkill = makeSkill({
      skill_id: "s-dep",
      skill_status: "deprecated",
      agent_type: "editor",
      semantic_key: "deprecated-skill",
    });

    const store = {
      listDir: vi.fn(async () => ["s-valid.md", "s-dep.md"]),
      readParsed: vi.fn()
        .mockResolvedValueOnce(validSkill)
        .mockResolvedValueOnce(deprecatedSkill),
    };

    const loader = new SkillLoader(store as any);
    const result = await loader.loadSkills("editor", { brand: "acme" });

    expect(result).toHaveLength(1);
    expect(result[0].skill_id).toBe("s-valid");
  });

  // ── 3. returns empty when store is null (preset-only mode) ────────────────
  it("returns empty array when store is null", async () => {
    const loader = new SkillLoader(null);
    const result = await loader.loadSkills("editor", { brand: "acme" });
    expect(result).toEqual([]);
  });

  // ── 4. queries brand _skills/ path ───────────────────────────────────────
  it("queries brands/<brand>/_skills/ path", async () => {
    const store = {
      listDir: vi.fn(async () => []),
      readParsed: vi.fn(),
    };

    const loader = new SkillLoader(store as any);
    await loader.loadSkills("editor", { brand: "acme" });

    const dirs = store.listDir.mock.calls.map((c) => c[0]);
    expect(dirs).toContain("brands/acme/_skills/");
  });

  // ── 5. queries series _skills/ path when provided ─────────────────────────
  it("also queries series/_skills/ path when series is provided", async () => {
    const store = {
      listDir: vi.fn(async () => []),
      readParsed: vi.fn(),
    };

    const loader = new SkillLoader(store as any);
    await loader.loadSkills("editor", { brand: "acme", series: "summer" });

    const dirs = store.listDir.mock.calls.map((c) => c[0]);
    expect(dirs).toContain("brands/acme/series/summer/_skills/");
  });
});

// ---------------------------------------------------------------------------
// Tests: loadSkillsGrouped
// ---------------------------------------------------------------------------

describe("SkillLoader.loadSkillsGrouped", () => {
  // ── 6. separates validated from draft ────────────────────────────────────
  it("separates validated skills into mainSkills and draft into trialSkills", async () => {
    const validSkill = makeSkill({
      skill_id: "s-main",
      skill_status: "validated",
      agent_type: "editor",
    });
    const draftSkill = makeSkill({
      skill_id: "s-trial",
      skill_status: "draft",
      agent_type: "editor",
      semantic_key: "trial-skill",
    });

    const store = {
      listDir: vi.fn(async () => ["s-main.md", "s-trial.md"]),
      readParsed: vi.fn()
        .mockResolvedValueOnce(validSkill)
        .mockResolvedValueOnce(draftSkill),
    };

    const loader = new SkillLoader(store as any);
    const { mainSkills, trialSkills } = await loader.loadSkillsGrouped("editor", { brand: "acme" });

    expect(mainSkills).toHaveLength(1);
    expect(mainSkills[0].skill_id).toBe("s-main");

    expect(trialSkills).toHaveLength(1);
    expect(trialSkills[0].skill_id).toBe("s-trial");
  });

  // ── 7. both arrays empty when no skills match ─────────────────────────────
  it("returns empty mainSkills and trialSkills when no skills match agentType", async () => {
    const store = {
      listDir: vi.fn(async () => []),
      readParsed: vi.fn(),
    };

    const loader = new SkillLoader(store as any);
    const { mainSkills, trialSkills } = await loader.loadSkillsGrouped("audio", { brand: "acme" });

    expect(mainSkills).toEqual([]);
    expect(trialSkills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadSystemPresets
// ---------------------------------------------------------------------------

describe("SkillLoader.loadSystemPresets", () => {
  // ── 8. reads preset files and filters by agentType ───────────────────────
  it("returns only presets matching the requested agentType", async () => {
    const loader = new TestableSkillLoader(null, [
      { file: "editor-beat-sync.md", content: EDITOR_PRESET_RAW },
      { file: "audio-ducking.md", content: AUDIO_PRESET_RAW },
    ]);

    const editorPresets = await loader.loadSystemPresets("editor");

    expect(editorPresets).toHaveLength(1);
    expect(editorPresets[0].skill_id).toBe("skill_preset_beat_sync");
    expect(editorPresets[0].agent_type).toBe("editor");
  });

  // ── 9. returns empty when no presets match agentType ─────────────────────
  it("returns empty array when no preset matches agentType", async () => {
    const loader = new TestableSkillLoader(null, [
      { file: "editor-beat-sync.md", content: EDITOR_PRESET_RAW },
    ]);

    const result = await loader.loadSystemPresets("creator");
    expect(result).toEqual([]);
  });

  // ── 10. parses skill_id and applies_to from frontmatter ──────────────────
  it("correctly parses skill_id and applies_to from preset frontmatter", async () => {
    const loader = new TestableSkillLoader(null, [
      { file: "audio-ducking.md", content: AUDIO_PRESET_RAW },
    ]);

    const presets = await loader.loadSystemPresets("audio");

    expect(presets).toHaveLength(1);
    expect(presets[0].skill_id).toBe("skill_preset_audio_ducking");
    expect(presets[0].applies_to).toEqual(["mixing", "ducking"]);
  });

  // ── 11. returns empty when store is null (preset-only mode works fine) ────
  it("works in preset-only mode (store=null) for system presets", async () => {
    const loader = new TestableSkillLoader(null, [
      { file: "editor-beat-sync.md", content: EDITOR_PRESET_RAW },
    ]);

    // Should not throw even with null store
    const result = await loader.loadSystemPresets("editor");
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadSkillsWithContracts
// ---------------------------------------------------------------------------

describe("loadSkillsWithContracts()", () => {
  it("returns SkillContracts with resolved tools and model", async () => {
    const editorSkill = makeSkill({ skill_id: "s1", agent_type: "editor" });

    const store = makeMockStore([editorSkill]);

    const loader = new SkillLoader(store as any);
    const contracts = await loader.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      {
        availableTools: ["trim_element", "split_element"],
        defaultModel: "claude-sonnet-4-6",
      }
    );

    // If there are skills matching "editor", they should be SkillContracts
    for (const contract of contracts) {
      expect(contract).toHaveProperty("resolvedTools");
      expect(contract).toHaveProperty("resolvedModel");
      expect(contract).toHaveProperty("skillId");
      expect(contract).toHaveProperty("content");
    }
  });

  it("returns empty array when store is null (no store skills to resolve)", async () => {
    const loader = new SkillLoader(null);
    const contracts = await loader.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      {
        availableTools: ["trim_element"],
        defaultModel: "claude-sonnet-4-6",
      }
    );
    expect(contracts).toEqual([]);
  });

  it("resolvedModel defaults to the provided defaultModel when skill has no model override", async () => {
    const editorSkill = makeSkill({ skill_id: "s-model", agent_type: "editor" });
    const store = makeMockStore([editorSkill]);

    const loader = new SkillLoader(store as any);
    const contracts = await loader.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      {
        availableTools: ["trim_element"],
        defaultModel: "claude-sonnet-4-6",
      }
    );

    expect(contracts).toHaveLength(1);
    expect(contracts[0].resolvedModel).toBe("claude-sonnet-4-6");
  });

  it("resolvedTools is filtered to availableTools list", async () => {
    const editorSkill = makeSkill({ skill_id: "s-tools", agent_type: "editor" });
    const store = makeMockStore([editorSkill]);

    const loader = new SkillLoader(store as any);
    const contracts = await loader.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      {
        availableTools: ["trim_element", "split_element"],
        defaultModel: "claude-sonnet-4-6",
      }
    );

    expect(contracts).toHaveLength(1);
    // No allowed_tools in frontmatter → gets all available tools
    expect(contracts[0].resolvedTools).toEqual(["trim_element", "split_element"]);
  });

  it("allowed_tools frontmatter restricts resolvedTools", async () => {
    const skill = makeSkill({
      skill_id: "s-restricted",
      agent_type: "editor",
      allowed_tools: ["trim_element"],
    });
    const store = makeMockStore([skill]);

    const loader = new SkillLoader(store as any);
    const contracts = await loader.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      {
        availableTools: ["trim_element", "split_element", "delete_element"],
        defaultModel: "claude-sonnet-4-6",
      }
    );

    expect(contracts).toHaveLength(1);
    expect(contracts[0].resolvedTools).toEqual(["trim_element"]);
  });

  it("denied_tools frontmatter removes tools from resolvedTools", async () => {
    const skill = makeSkill({
      skill_id: "s-denied",
      agent_type: "editor",
      denied_tools: ["delete_element"],
    });
    const store = makeMockStore([skill]);

    const loader = new SkillLoader(store as any);
    const contracts = await loader.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      {
        availableTools: ["trim_element", "split_element", "delete_element"],
        defaultModel: "claude-sonnet-4-6",
      }
    );

    expect(contracts).toHaveLength(1);
    expect(contracts[0].resolvedTools).not.toContain("delete_element");
    expect(contracts[0].resolvedTools).toContain("trim_element");
  });

  it("skill_model frontmatter overrides resolvedModel", async () => {
    const skill = makeSkill({
      skill_id: "s-model-override",
      agent_type: "editor",
      skill_model: "claude-haiku-4-5",
    });
    const store = makeMockStore([skill]);

    const loader = new SkillLoader(store as any);
    const contracts = await loader.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      {
        availableTools: ["trim_element"],
        defaultModel: "claude-sonnet-4-6",
      }
    );

    expect(contracts).toHaveLength(1);
    expect(contracts[0].resolvedModel).toBe("claude-haiku-4-5");
  });

  it("effort frontmatter affects resolvedTokenBudget", async () => {
    const lowSkill = makeSkill({
      skill_id: "s-low",
      agent_type: "editor",
      effort: "low",
    });
    const highSkill = makeSkill({
      skill_id: "s-high",
      agent_type: "editor",
      effort: "high",
      semantic_key: "high-skill",
    });

    // Test low effort
    const storeLow = makeMockStore([lowSkill]);
    const loaderLow = new SkillLoader(storeLow as any);
    const contractsLow = await loaderLow.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      { availableTools: [], defaultModel: "claude-sonnet-4-6" }
    );

    // Test high effort
    const storeHigh = makeMockStore([highSkill]);
    const loaderHigh = new SkillLoader(storeHigh as any);
    const contractsHigh = await loaderHigh.loadSkillsWithContracts(
      "editor",
      { brand: "testbrand" },
      { availableTools: [], defaultModel: "claude-sonnet-4-6" }
    );

    expect(contractsLow[0].resolvedTokenBudget.output).toBeLessThan(
      contractsHigh[0].resolvedTokenBudget.output
    );
  });
});
