import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock NativeAPIRuntime before any agent imports so the agents never call
// the real Anthropic SDK.
// ---------------------------------------------------------------------------

vi.mock("../runtime.js", () => {
  const mockRun = vi.fn().mockResolvedValue({
    text: "mock agent response",
    toolCalls: [
      { toolName: "some_tool", input: {}, output: {} },
      { toolName: "other_tool", input: {}, output: {} },
    ],
    tokensUsed: { input: 120, output: 80 },
  });

  const NativeAPIRuntime = vi.fn().mockImplementation(() => ({
    run: mockRun,
    setToolExecutor: vi.fn(),
    setToolRegistry: vi.fn(),
  }));

  // Expose mockRun on the constructor so tests can access it via
  // (NativeAPIRuntime as any).mockRun
  (NativeAPIRuntime as any).mockRun = mockRun;

  return { NativeAPIRuntime };
});

import { EditorAgent } from "../editor-agent.js";
import { CreatorAgent } from "../creator-agent.js";
import { AudioAgent } from "../audio-agent.js";
import { VisionAgent } from "../vision-agent.js";
import { AssetAgent } from "../asset-agent.js";
import { NativeAPIRuntime } from "../runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockToolExecutor() {
  return vi.fn().mockResolvedValue({ success: true });
}

function baseInput(task = "do the thing") {
  return { task, accessMode: "read_write" as const };
}

function inputWithContext(task = "do the thing") {
  return {
    task,
    accessMode: "read" as const,
    context: { projectId: "proj-1", snapshotVersion: 5 },
  };
}

// Retrieve the shared mockRun from the mocked module
const mockRun = (NativeAPIRuntime as unknown as { mockRun: ReturnType<typeof vi.fn> }).mockRun;

// ---------------------------------------------------------------------------
// EditorAgent — 5 tests
// ---------------------------------------------------------------------------

describe("EditorAgent", () => {
  let agent: EditorAgent;

  beforeEach(() => {
    mockRun.mockClear();
    agent = new EditorAgent({ toolExecutor: makeMockToolExecutor(), apiKey: "test-key" });
  });

  it("dispatch() returns a DispatchOutput with result, toolCallCount, tokensUsed", async () => {
    const output = await agent.dispatch(baseInput("trim clip"));
    expect(output.result).toBe("mock agent response");
    expect(output.toolCallCount).toBe(2);
    expect(output.tokensUsed).toBe(200); // 120 + 80
  });

  it("system prompt includes the task description", async () => {
    await agent.dispatch(baseInput("trim the intro"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("trim the intro");
  });

  it("system prompt includes context when provided", async () => {
    await agent.dispatch(inputWithContext("trim with context"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("proj-1");
  });

  it("uses claude-sonnet-4-6 model", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("has 16 tools configured", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.tools).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// CreatorAgent — 5 tests
// ---------------------------------------------------------------------------

describe("CreatorAgent", () => {
  let agent: CreatorAgent;

  beforeEach(() => {
    mockRun.mockClear();
    agent = new CreatorAgent({ toolExecutor: makeMockToolExecutor(), apiKey: "test-key" });
  });

  it("dispatch() returns a DispatchOutput with result, toolCallCount, tokensUsed", async () => {
    const output = await agent.dispatch(baseInput("generate a clip"));
    expect(output.result).toBe("mock agent response");
    expect(output.toolCallCount).toBe(2);
    expect(output.tokensUsed).toBe(200);
  });

  it("system prompt includes the task description", async () => {
    await agent.dispatch(baseInput("generate a sunset clip"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("generate a sunset clip");
  });

  it("system prompt includes context when provided", async () => {
    await agent.dispatch(inputWithContext("generate with context"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("proj-1");
  });

  it("uses claude-sonnet-4-6 model", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("has 5 tools configured", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.tools).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// AudioAgent — 5 tests
// ---------------------------------------------------------------------------

describe("AudioAgent", () => {
  let agent: AudioAgent;

  beforeEach(() => {
    mockRun.mockClear();
    agent = new AudioAgent({ toolExecutor: makeMockToolExecutor(), apiKey: "test-key" });
  });

  it("dispatch() returns a DispatchOutput with result, toolCallCount, tokensUsed", async () => {
    const output = await agent.dispatch(baseInput("add background music"));
    expect(output.result).toBe("mock agent response");
    expect(output.toolCallCount).toBe(2);
    expect(output.tokensUsed).toBe(200);
  });

  it("system prompt includes the task description", async () => {
    await agent.dispatch(baseInput("transcribe the dialogue"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("transcribe the dialogue");
  });

  it("system prompt includes context when provided", async () => {
    await agent.dispatch(inputWithContext("add bgm with context"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("proj-1");
  });

  it("uses claude-sonnet-4-6 model", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("has 6 tools configured", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.tools).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// VisionAgent — 5 tests
// ---------------------------------------------------------------------------

describe("VisionAgent", () => {
  let agent: VisionAgent;

  beforeEach(() => {
    mockRun.mockClear();
    agent = new VisionAgent({ toolExecutor: makeMockToolExecutor(), apiKey: "test-key" });
  });

  it("dispatch() returns a DispatchOutput with result, toolCallCount, tokensUsed", async () => {
    const output = await agent.dispatch(baseInput("analyze the video"));
    expect(output.result).toBe("mock agent response");
    expect(output.toolCallCount).toBe(2);
    expect(output.tokensUsed).toBe(200);
  });

  it("system prompt includes the task description", async () => {
    await agent.dispatch(baseInput("locate the opening scene"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("locate the opening scene");
  });

  it("system prompt includes context when provided", async () => {
    await agent.dispatch(inputWithContext("describe frame with context"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("proj-1");
  });

  it("uses claude-sonnet-4-6 model", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("has 3 tools configured", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.tools).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// AssetAgent — 5 tests
// ---------------------------------------------------------------------------

describe("AssetAgent", () => {
  let agent: AssetAgent;

  beforeEach(() => {
    mockRun.mockClear();
    agent = new AssetAgent({ toolExecutor: makeMockToolExecutor(), apiKey: "test-key" });
  });

  it("dispatch() returns a DispatchOutput with result, toolCallCount, tokensUsed", async () => {
    const output = await agent.dispatch(baseInput("search for logo assets"));
    expect(output.result).toBe("mock agent response");
    expect(output.toolCallCount).toBe(2);
    expect(output.tokensUsed).toBe(200);
  });

  it("system prompt includes the task description", async () => {
    await agent.dispatch(baseInput("find similar assets"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("find similar assets");
  });

  it("system prompt includes context when provided", async () => {
    await agent.dispatch(inputWithContext("save asset with context"));
    const config = mockRun.mock.calls[0][0];
    expect(config.system).toContain("proj-1");
  });

  it("uses claude-haiku-4-5 model", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.model).toBe("claude-haiku-4-5");
  });

  it("has 7 tools configured", async () => {
    await agent.dispatch(baseInput());
    const config = mockRun.mock.calls[0][0];
    expect(config.tools).toHaveLength(7);
  });
});
