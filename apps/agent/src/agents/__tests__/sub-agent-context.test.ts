import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock NativeAPIRuntime before any agent imports so the agents never call
// the real Anthropic SDK.
// ---------------------------------------------------------------------------

vi.mock("../runtime.js", () => {
  const mockRun = vi.fn().mockResolvedValue({
    text: "mock agent response",
    toolCalls: [],
    tokensUsed: { input: 100, output: 50 },
  });

  const NativeAPIRuntime = vi.fn().mockImplementation(() => ({
    run: mockRun,
    setToolExecutor: vi.fn(),
    setToolRegistry: vi.fn(),
  }));

  return { NativeAPIRuntime };
});

import { SubAgent, type SubAgentDeps } from "../sub-agent.js";
import { EditorAgent } from "../editor-agent.js";
import { VisionAgent } from "../vision-agent.js";
import { CreatorAgent } from "../creator-agent.js";
import { AudioAgent } from "../audio-agent.js";
import { AssetAgent } from "../asset-agent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockToolExecutor() {
  return vi.fn().mockResolvedValue({ success: true });
}

function baseDeps(): SubAgentDeps {
  return { toolExecutor: makeMockToolExecutor(), apiKey: "test-key" };
}

function depsWithContext(
  ctx: Readonly<Record<string, unknown>>,
): SubAgentDeps {
  return { ...baseDeps(), projectContext: ctx };
}

// Minimal concrete SubAgent for unit-testing the base class directly.
class TestSubAgent extends SubAgent {
  constructor(deps: SubAgentDeps) {
    super(
      {
        agentType: "editor",
        model: "claude-sonnet-4-6",
        tools: [],
        identity: {
          role: "Test",
          description: "Test agent",
          rules: [],
        },
      },
      deps,
    );
  }

  // Expose the protected field for assertion.
  getProjectContext() {
    return this.projectContext;
  }
}

// ---------------------------------------------------------------------------
// P1.3 — SubAgentDeps.projectContext
// ---------------------------------------------------------------------------

describe("SubAgent projectContext", () => {
  // 1. SubAgent receives projectContext via deps when provided
  it("stores projectContext when provided via deps", () => {
    const ctx = { projectId: "proj-42", fps: 30 } as const;
    const agent = new TestSubAgent(depsWithContext(ctx));
    expect(agent.getProjectContext()).toEqual(ctx);
  });

  // 2. SubAgent without projectContext continues to work (backward compatible)
  it("projectContext is undefined when not provided (backward compatible)", () => {
    const agent = new TestSubAgent(baseDeps());
    expect(agent.getProjectContext()).toBeUndefined();
  });

  // 3. projectContext is stored as Readonly — TypeScript enforces this at
  //    compile time; at runtime we verify the stored reference is the same
  //    object (not a copy) and that the field type is assignable to
  //    Readonly<Record<string, unknown>>.
  it("projectContext reference is stored as-is (Readonly semantics preserved)", () => {
    const ctx: Readonly<Record<string, unknown>> = Object.freeze({ key: "value" });
    const agent = new TestSubAgent(depsWithContext(ctx));
    // Same reference — no defensive copy, Readonly is a compile-time contract.
    expect(agent.getProjectContext()).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// All 5 concrete sub-agents — constructed WITH projectContext
// ---------------------------------------------------------------------------

describe("Concrete sub-agents accept projectContext", () => {
  const ctx: Readonly<Record<string, unknown>> = { env: "test", version: 2 };

  it("EditorAgent can be constructed with projectContext", () => {
    expect(
      () => new EditorAgent(depsWithContext(ctx)),
    ).not.toThrow();
  });

  it("VisionAgent can be constructed with projectContext", () => {
    expect(
      () => new VisionAgent(depsWithContext(ctx)),
    ).not.toThrow();
  });

  it("CreatorAgent can be constructed with projectContext", () => {
    expect(
      () => new CreatorAgent(depsWithContext(ctx)),
    ).not.toThrow();
  });

  it("AudioAgent can be constructed with projectContext", () => {
    expect(
      () => new AudioAgent(depsWithContext(ctx)),
    ).not.toThrow();
  });

  it("AssetAgent can be constructed with projectContext", () => {
    expect(
      () => new AssetAgent(depsWithContext(ctx)),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// All 5 concrete sub-agents — constructed WITHOUT projectContext (no regression)
// ---------------------------------------------------------------------------

describe("Concrete sub-agents work without projectContext (regression)", () => {
  it("EditorAgent can be constructed without projectContext", () => {
    expect(() => new EditorAgent(baseDeps())).not.toThrow();
  });

  it("VisionAgent can be constructed without projectContext", () => {
    expect(() => new VisionAgent(baseDeps())).not.toThrow();
  });

  it("CreatorAgent can be constructed without projectContext", () => {
    expect(() => new CreatorAgent(baseDeps())).not.toThrow();
  });

  it("AudioAgent can be constructed without projectContext", () => {
    expect(() => new AudioAgent(baseDeps())).not.toThrow();
  });

  it("AssetAgent can be constructed without projectContext", () => {
    expect(() => new AssetAgent(baseDeps())).not.toThrow();
  });
});
