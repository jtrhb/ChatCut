import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../prompt-builder.js";
import { identitySection, taskSection } from "../sections.js";
import { delegationContractSection } from "../delegation-contract.js";
import type { PromptContext, PromptSection } from "../types.js";
import type { ProjectContext } from "../../context/project-context.js";

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectContext: {
      timelineState: '{"tracks":[]}',
      snapshotVersion: 1,
      videoAnalysis: null,
      currentIntent: { raw: "", parsed: "", explorationMode: false },
      memoryContext: { promptText: "", injectedMemoryIds: [], injectedSkillIds: [] },
      artifacts: {},
      recentChanges: [],
    },
    agentIdentity: {
      role: "Test Agent",
      description: "A test agent for unit tests.",
      rules: ["Rule one.", "Rule two."],
    },
    ...overrides,
  };
}

describe("PromptBuilder", () => {
  describe("build()", () => {
    it("renders identity section at the top", () => {
      const builder = new PromptBuilder();
      const result = builder.build(makeContext());
      expect(result).toContain("# Test Agent");
      expect(result).toContain("A test agent for unit tests.");
      expect(result).toContain("- Rule one.");
    });

    it("includes timeline state section", () => {
      const ctx = makeContext();
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Current Timeline State");
      expect(result).toContain('{"tracks":[]}');
      expect(result).toContain("Snapshot version: 1");
    });

    it("omits memory section when promptText is empty", () => {
      const result = new PromptBuilder().build(makeContext());
      expect(result).not.toContain("## Memory Context");
    });

    it("includes memory section when promptText is present", () => {
      const ctx = makeContext({
        projectContext: {
          ...makeContext().projectContext,
          memoryContext: {
            promptText: "User prefers fast cuts.",
            injectedMemoryIds: ["mem-1"],
            injectedSkillIds: [],
          },
        } as ProjectContext,
      });
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Memory Context");
      expect(result).toContain("User prefers fast cuts.");
      expect(result).toContain("mem-1");
    });

    it("includes recent changes when present", () => {
      const ctx = makeContext({
        projectContext: {
          ...makeContext().projectContext,
          recentChanges: [
            { id: "c1", source: "human", summary: "Trimmed clip A", timestamp: 1000 },
          ],
        } as ProjectContext,
      });
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Recent Changes");
      expect(result).toContain("[human] Trimmed clip A");
    });

    it("includes task section when task is provided", () => {
      const ctx = makeContext({
        task: { task: "Trim the intro to 3 seconds", accessMode: "read_write" },
      });
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Task");
      expect(result).toContain("Trim the intro to 3 seconds");
    });

    it("allows registering custom sections", () => {
      const builder = new PromptBuilder();
      const custom: PromptSection = {
        key: "brand",
        render: () => "## Brand Guidelines\nUse red and white colors.",
        priority: 25,
      };
      builder.register(custom);
      const result = builder.build(makeContext());
      expect(result).toContain("## Brand Guidelines");
      expect(result).toContain("Use red and white colors.");
    });

    it("orders sections by priority", () => {
      const builder = new PromptBuilder();
      builder.register({ key: "late", render: () => "LATE_SECTION", priority: 90 });
      builder.register({ key: "early", render: () => "EARLY_SECTION", priority: 5 });
      const result = builder.build(makeContext());
      const earlyIndex = result.indexOf("EARLY_SECTION");
      const lateIndex = result.indexOf("LATE_SECTION");
      expect(earlyIndex).toBeLessThan(lateIndex);
    });

    it("skips sections that render to empty string", () => {
      const builder = new PromptBuilder();
      builder.register({ key: "empty", render: () => "", priority: 25 });
      const result = builder.build(makeContext());
      // Should not have excessive blank lines from empty section
      expect(result).not.toMatch(/\n{4,}/);
    });
  });

  describe("constructor options", () => {
    it("starts with no sections when builtins is false", () => {
      const builder = new PromptBuilder({ builtins: false });
      const result = builder.build(makeContext());
      // Only trailing newline from empty render
      expect(result.trim()).toBe("");
    });

    it("allows registering individual sections when builtins is false", () => {
      const builder = new PromptBuilder({ builtins: false });
      builder.register(identitySection);
      builder.register(taskSection);
      const ctx = makeContext({
        task: { task: "Do something", accessMode: "read" },
      });
      const result = builder.build(ctx);
      expect(result).toContain("# Test Agent");
      expect(result).toContain("## Task");
      expect(result).toContain("Do something");
      // Should NOT contain timeline or memory (not registered)
      expect(result).not.toContain("## Current Timeline State");
      expect(result).not.toContain("## Memory Context");
    });

    it("includes all built-in sections by default", () => {
      const builder = new PromptBuilder();
      const result = builder.build(makeContext());
      expect(result).toContain("# Test Agent");
      expect(result).toContain("## Current Timeline State");
    });
  });

  describe("delegationContractSection", () => {
    it("renders non-empty content", () => {
      const content = delegationContractSection.render(makeContext());
      expect(content.length).toBeGreaterThan(0);
    });

    it("renders the contract heading", () => {
      const content = delegationContractSection.render(makeContext());
      expect(content).toContain("## Sub-Agent Delegation Contract");
    });

    it("covers When to Dispatch", () => {
      const content = delegationContractSection.render(makeContext());
      expect(content).toContain("When to Dispatch");
    });

    it("covers Writing the Task Description", () => {
      const content = delegationContractSection.render(makeContext());
      expect(content).toContain("Writing the Task Description");
    });

    it("covers Dispatch Rules", () => {
      const content = delegationContractSection.render(makeContext());
      expect(content).toContain("Dispatch Rules");
    });

    it("covers Handling Sub-Agent Results", () => {
      const content = delegationContractSection.render(makeContext());
      expect(content).toContain("Handling Sub-Agent Results");
    });

    it("covers Destructive Operations", () => {
      const content = delegationContractSection.render(makeContext());
      expect(content).toContain("Destructive Operations");
    });

    it("has priority 15 and isStatic true", () => {
      expect(delegationContractSection.priority).toBe(15);
      expect(delegationContractSection.isStatic).toBe(true);
    });

    it("MasterAgent buildSystemPrompt includes delegation contract text", async () => {
      const { MasterAgent } = await import("../../agents/master-agent.js");
      // Minimal stubs
      const fakeRuntime = { setToolExecutor: () => {} } as any;
      const fakeCtx = makeContext().projectContext!;
      const fakeContextManager = { get: () => fakeCtx } as any;
      const fakeLock = { acquire: async () => {}, release: () => {} } as any;
      const agent = new MasterAgent({
        runtime: fakeRuntime,
        contextManager: fakeContextManager,
        writeLock: fakeLock,
        subAgentDispatchers: new Map(),
      });
      const prompt = agent.buildSystemPrompt(fakeCtx as any);
      expect(prompt).toContain("## Sub-Agent Delegation Contract");
      expect(prompt).toContain("When to Dispatch");
    });
  });
});
