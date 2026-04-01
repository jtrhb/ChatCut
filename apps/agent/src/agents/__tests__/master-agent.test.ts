import { describe, it, expect, vi, beforeEach } from "vitest";
import { MasterAgent } from "../master-agent.js";
import type { DispatchInput, DispatchOutput } from "../types.js";
import { ProjectContextManager } from "../../context/project-context.js";
import { ProjectWriteLock } from "../../context/write-lock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRuntime() {
  const executorRef: { current: ((name: string, input: unknown) => Promise<unknown>) | null } = {
    current: null,
  };

  return {
    run: vi.fn().mockResolvedValue({
      text: "mock response",
      toolCalls: [],
      tokensUsed: { input: 100, output: 50 },
    }),
    setToolExecutor: vi.fn((fn: (name: string, input: unknown) => Promise<unknown>) => {
      executorRef.current = fn;
    }),
    /** Invoke the tool executor that was registered via setToolExecutor. */
    callTool: (name: string, input: unknown) => {
      if (!executorRef.current) throw new Error("No tool executor registered");
      return executorRef.current(name, input);
    },
  };
}

function makeDispatcher(result = "done"): ReturnType<typeof vi.fn> {
  return vi.fn<(input: DispatchInput) => Promise<DispatchOutput>>().mockResolvedValue({
    result,
    toolCallCount: 1,
    tokensUsed: 500,
  });
}

function makeContextManager(overrides?: Partial<Parameters<typeof ProjectContextManager["prototype"]["get"]>[0] extends never ? ReturnType<typeof ProjectContextManager["prototype"]["get"]> : never>) {
  return new ProjectContextManager({
    timelineState: '{"tracks":[]}',
    snapshotVersion: 1,
    memoryContext: {
      promptText: "User prefers quick cuts",
      injectedMemoryIds: ["mem-1"],
      injectedSkillIds: [],
    },
    recentChanges: [
      {
        id: "ch-1",
        source: "editor",
        summary: "Added clip to track 0",
        timestamp: Date.now(),
      },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MasterAgent", () => {
  let runtime: ReturnType<typeof makeMockRuntime>;
  let contextManager: ProjectContextManager;
  let writeLock: ProjectWriteLock;
  let dispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;
  let agent: MasterAgent;

  beforeEach(() => {
    runtime = makeMockRuntime();
    contextManager = makeContextManager();
    writeLock = new ProjectWriteLock();
    dispatchers = new Map();
    agent = new MasterAgent({
      runtime: runtime as any,
      contextManager,
      writeLock,
      subAgentDispatchers: dispatchers,
    });
  });

  // ── 1. dispatch_editor routes to correct sub-agent ────────────────────────
  it("handleToolCall routes dispatch_editor to the editor dispatcher", async () => {
    const editorDispatcher = makeDispatcher("editor result");
    dispatchers.set("editor", editorDispatcher);

    const result = await runtime.callTool("dispatch_editor", {
      task: "trim clip",
      accessMode: "write",
    });

    expect(editorDispatcher).toHaveBeenCalledOnce();
    expect(editorDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ task: "trim clip", accessMode: "write" })
    );
    expect(result).toEqual(expect.objectContaining({ result: "editor result" }));
  });

  // ── 2. dispatch_vision routes to vision dispatcher ────────────────────────
  it("handleToolCall routes dispatch_vision to the vision dispatcher", async () => {
    const visionDispatcher = makeDispatcher("vision result");
    dispatchers.set("vision", visionDispatcher);

    const result = await runtime.callTool("dispatch_vision", {
      task: "analyse scene",
    });

    expect(visionDispatcher).toHaveBeenCalledOnce();
    expect(visionDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ task: "analyse scene", accessMode: "read" })
    );
    expect(result).toEqual(expect.objectContaining({ result: "vision result" }));
  });

  // ── 3. acquires write lock for write-mode dispatches ──────────────────────
  it("handleToolCall acquires write lock for write-mode dispatches", async () => {
    const editorDispatcher = makeDispatcher("write done");
    dispatchers.set("editor", editorDispatcher);

    const acquireSpy = vi.spyOn(writeLock, "acquire");
    const releaseSpy = vi.spyOn(writeLock, "release");

    await runtime.callTool("dispatch_editor", {
      task: "delete clip",
      accessMode: "write",
    });

    expect(acquireSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledOnce();
  });

  // ── 4. does NOT acquire write lock for read-only dispatches ───────────────
  it("handleToolCall does NOT acquire write lock for read-only dispatches", async () => {
    const visionDispatcher = makeDispatcher("read result");
    dispatchers.set("vision", visionDispatcher);

    const acquireSpy = vi.spyOn(writeLock, "acquire");

    await runtime.callTool("dispatch_vision", {
      task: "inspect frame",
    });

    expect(acquireSpy).not.toHaveBeenCalled();
  });

  // ── 5. buildSystemPrompt includes timeline state ──────────────────────────
  it("buildSystemPrompt includes timeline state from context", () => {
    const prompt = agent.buildSystemPrompt(contextManager.get());

    expect(prompt).toContain('{"tracks":[]}');
  });

  // ── 6. buildSystemPrompt includes memory context ──────────────────────────
  it("buildSystemPrompt includes memory context when present", () => {
    const prompt = agent.buildSystemPrompt(contextManager.get());

    expect(prompt).toContain("User prefers quick cuts");
  });

  // ── 7. buildSystemPrompt includes recent changes ──────────────────────────
  it("buildSystemPrompt includes recent changes", () => {
    const prompt = agent.buildSystemPrompt(contextManager.get());

    expect(prompt).toContain("Added clip to track 0");
  });

  // ── 8. returns error for unknown dispatch target ──────────────────────────
  it("handleToolCall returns error for unknown dispatch target", async () => {
    const result = await runtime.callTool("dispatch_editor", {
      task: "do something",
      accessMode: "read",
    });

    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining("editor") })
    );
  });

  // ── 9. propose_changes returns pending status ─────────────────────────────
  it("propose_changes returns pending status", async () => {
    const result = await runtime.callTool("propose_changes", {
      summary: "Remove intro clip",
      affectedElements: ["clip-1"],
    });

    expect(result).toEqual(
      expect.objectContaining({ status: "pending" })
    );
  });

  // ── 10. explore_options returns queued status ─────────────────────────────
  it("explore_options returns queued status", async () => {
    const result = await runtime.callTool("explore_options", {
      intent: "make it dramatic",
      baseSnapshotVersion: 1,
      timelineSnapshot: "{}",
      candidates: [
        {
          label: "A",
          summary: "Fast cuts",
          candidateType: "edit",
          commands: [],
          expectedMetrics: { durationChange: "+0s", affectedElements: 3 },
        },
        {
          label: "B",
          summary: "Slow fades",
          candidateType: "edit",
          commands: [],
          expectedMetrics: { durationChange: "+2s", affectedElements: 2 },
        },
        {
          label: "C",
          summary: "Color grade",
          candidateType: "effect",
          commands: [],
          expectedMetrics: { durationChange: "+0s", affectedElements: 5 },
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({ status: "queued" })
    );
  });

  // ── 11. export_video returns task_id ──────────────────────────────────────
  it("export_video returns a task_id", async () => {
    const result = (await runtime.callTool("export_video", {
      format: "mp4",
      quality: "standard",
    })) as { task_id: string };

    expect(result).toHaveProperty("task_id");
    expect(typeof result.task_id).toBe("string");
    expect(result.task_id.length).toBeGreaterThan(0);
  });

  // ── 12. routes dispatch_verification through DISPATCH_ROUTES ─────────────
  it("routes dispatch_verification through DISPATCH_ROUTES", async () => {
    const verifyDispatcher = vi.fn(async () => ({
      result: "[PASS] Looks good",
      toolCallCount: 0,
      tokensUsed: 150,
    }));
    dispatchers.set("verification", verifyDispatcher);

    // Simulate the model calling dispatch_verification
    const result = await (agent as any).handleToolCall("dispatch_verification", {
      task: "Verify the trim",
      context: { userIntent: "Trim to 3s" },
    });

    expect(verifyDispatcher).toHaveBeenCalled();
    expect(result).toHaveProperty("result");
  });

  // ── 13. handleUserMessage calls runtime.run ───────────────────────────────
  it("handleUserMessage calls runtime.run and returns result text", async () => {
    runtime.run.mockResolvedValueOnce({
      text: "I trimmed the clip for you.",
      toolCalls: [],
      tokensUsed: { input: 200, output: 100 },
    });

    const result = await agent.handleUserMessage("Trim the first clip");

    expect(runtime.run).toHaveBeenCalledOnce();
    expect(result).toBe("I trimmed the clip for you.");

    // Verify config shape
    const config = runtime.run.mock.calls[0][0];
    expect(config.agentType).toBe("master");
    expect(config.model).toBe("claude-opus-4-6");
    expect(config.system).toContain('{"tracks":[]}'); // timeline state included
  });
});
