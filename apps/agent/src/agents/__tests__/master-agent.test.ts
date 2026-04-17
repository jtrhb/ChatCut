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

function makeContextManager(overrides?: Record<string, unknown>) {
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
    ...(overrides ?? {}),
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

  // ── 9. propose_changes returns explicit error when ChangesetManager not configured ──
  it("propose_changes returns error when ChangesetManager not configured", async () => {
    const result = await runtime.callTool("propose_changes", {
      summary: "Remove intro clip",
      affectedElements: ["clip-1"],
    });

    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining("ChangesetManager not configured") })
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
      expect.objectContaining({ error: expect.stringContaining("ExplorationEngine not configured") })
    );
  });

  // ── 11. export_video returns error when TaskRegistry not configured ──────
  it("export_video returns error when TaskRegistry not configured", async () => {
    const result = (await runtime.callTool("export_video", {
      format: "mp4",
      quality: "standard",
    })) as { error: string };

    expect(result).toHaveProperty("error");
    expect(result.error).toContain("TaskRegistry not configured");
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
    expect(result.text).toBe("I trimmed the clip for you.");
    expect(result.tokensUsed).toEqual({ input: 200, output: 100 });

    // Verify config shape
    const config = runtime.run.mock.calls[0][0];
    expect(config.agentType).toBe("master");
    expect(config.model).toBe("claude-opus-4-6");
    expect(config.system).toContain('{"tracks":[]}'); // timeline state included
  });

  // ── 14. active skills in system prompt ───────────────────────────────────
  it("includes active skills in system prompt when skillContracts provided", () => {
    const agentWithSkills = new MasterAgent({
      runtime: runtime as any,
      contextManager,
      writeLock,
      subAgentDispatchers: dispatchers,
      skillContracts: [
        {
          skillId: "beat-sync",
          name: "beat-sync-skill",
          frontmatter: { effort: "medium" },
          content: "Cut on beat drops.",
          resolvedTools: ["trim_element", "split_element"],
          resolvedTokenBudget: { input: 30000, output: 4000 },
          resolvedModel: "claude-sonnet-4-6",
        },
      ],
    });

    const prompt = agentWithSkills.buildSystemPrompt(contextManager.get());
    expect(prompt).toContain("## Active Skills");
    expect(prompt).toContain("beat-sync-skill");
    expect(prompt).toContain("Cut on beat drops.");
    expect(prompt).toContain("trim_element");
  });

  it("does not include Active Skills section when no skillContracts provided", () => {
    const prompt = agent.buildSystemPrompt(contextManager.get());
    expect(prompt).not.toContain("## Active Skills");
  });

  // ── Pipeline integration ────────────────────────────────────────────────

  describe("ToolPipeline integration", () => {
    it("tool calls go through the pipeline and produce traces", async () => {
      const editorDispatcher = makeDispatcher("editor result");
      dispatchers.set("editor", editorDispatcher);

      await runtime.callTool("dispatch_editor", {
        task: "trim clip",
        accessMode: "read_write",
      });

      const traces = agent.getPipeline().getTraces();
      expect(traces.length).toBeGreaterThan(0);
      expect(traces[0].toolName).toBe("dispatch_editor");
      expect(traces[0].success).toBe(true);
    });

    it("pipeline hooks are invoked during real tool calls", async () => {
      const hookSpy = vi.fn(async () => ({}));

      // Create agent with a hook
      agent = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        hooks: [{ name: "spy-hook", pre: hookSpy }],
      });

      dispatchers.set("editor", makeDispatcher());

      await runtime.callTool("dispatch_editor", {
        task: "test hook",
        accessMode: "read",
      });

      expect(hookSpy).toHaveBeenCalled();
    });
  });

  describe("B3: per-dispatch taskId + rollback on throw", () => {
    it("mints a fresh taskId per dispatch and threads it into DispatchInput.identity", async () => {
      const editorDispatcher = makeDispatcher("ok");
      dispatchers.set("editor", editorDispatcher);

      await runtime.callTool("dispatch_editor", { task: "trim", accessMode: "write" });

      expect(editorDispatcher).toHaveBeenCalledOnce();
      const arg = editorDispatcher.mock.calls[0][0] as DispatchInput;
      expect(arg.identity?.taskId).toMatch(/^dispatch-[A-Za-z0-9_-]{10}$/);
    });

    it("mints a DIFFERENT taskId for each dispatch", async () => {
      const editorDispatcher = makeDispatcher("ok");
      dispatchers.set("editor", editorDispatcher);

      await runtime.callTool("dispatch_editor", { task: "first", accessMode: "write" });
      await runtime.callTool("dispatch_editor", { task: "second", accessMode: "write" });

      const id1 = (editorDispatcher.mock.calls[0][0] as DispatchInput).identity?.taskId;
      const id2 = (editorDispatcher.mock.calls[1][0] as DispatchInput).identity?.taskId;
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
    });

    it("calls serverCore.rollbackByTaskId when dispatcher throws", async () => {
      const rollbackSpy = vi.fn().mockReturnValue(2);
      const serverCoreMock = { rollbackByTaskId: rollbackSpy } as any;

      const throwingAgent = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        serverCore: serverCoreMock,
      });
      void throwingAgent; // registers tool executor on runtime

      const editorDispatcher = vi
        .fn<(input: DispatchInput) => Promise<DispatchOutput>>()
        .mockRejectedValue(new Error("sub-agent exploded"));
      dispatchers.set("editor", editorDispatcher);

      const result = (await runtime.callTool("dispatch_editor", {
        task: "break things",
        accessMode: "write",
      })) as { error?: string };

      expect(rollbackSpy).toHaveBeenCalledOnce();
      const rolledBackId = rollbackSpy.mock.calls[0][0];
      expect(rolledBackId).toMatch(/^dispatch-[A-Za-z0-9_-]{10}$/);
      expect(result.error).toContain("Sub-agent dispatch failed");
      expect(result.error).toContain("sub-agent exploded");
    });

    it("releases the write lock even when dispatcher throws (lock + rollback compose)", async () => {
      const rollbackSpy = vi.fn().mockReturnValue(0);
      const serverCoreMock = { rollbackByTaskId: rollbackSpy } as any;

      const throwingAgent = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        serverCore: serverCoreMock,
      });
      void throwingAgent;

      const editorDispatcher = vi
        .fn<(input: DispatchInput) => Promise<DispatchOutput>>()
        .mockRejectedValue(new Error("boom"));
      dispatchers.set("editor", editorDispatcher);

      const releaseSpy = vi.spyOn(writeLock, "release");

      await runtime.callTool("dispatch_editor", { task: "fail", accessMode: "write" });

      expect(releaseSpy).toHaveBeenCalledOnce();
      expect(rollbackSpy).toHaveBeenCalledOnce();
    });

    it("does NOT call rollback when dispatcher succeeds", async () => {
      const rollbackSpy = vi.fn();
      const serverCoreMock = { rollbackByTaskId: rollbackSpy } as any;

      const okAgent = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        serverCore: serverCoreMock,
      });
      void okAgent;

      const editorDispatcher = makeDispatcher("ok");
      dispatchers.set("editor", editorDispatcher);

      await runtime.callTool("dispatch_editor", { task: "ok", accessMode: "write" });

      expect(rollbackSpy).not.toHaveBeenCalled();
    });

    it("still surfaces the error if serverCore is not wired (rollback is best-effort)", async () => {
      const editorDispatcher = vi
        .fn<(input: DispatchInput) => Promise<DispatchOutput>>()
        .mockRejectedValue(new Error("no core wired"));
      dispatchers.set("editor", editorDispatcher);

      const result = (await runtime.callTool("dispatch_editor", {
        task: "t",
        accessMode: "write",
      })) as { error?: string };

      expect(result.error).toContain("no core wired");
    });

    it("swallows rollback errors so the original dispatch error remains the signal", async () => {
      const rollbackSpy = vi.fn(() => {
        throw new Error("rollback itself blew up");
      });
      const serverCoreMock = { rollbackByTaskId: rollbackSpy } as any;

      const agentWithBadRollback = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        serverCore: serverCoreMock,
      });
      void agentWithBadRollback;

      const editorDispatcher = vi
        .fn<(input: DispatchInput) => Promise<DispatchOutput>>()
        .mockRejectedValue(new Error("original error"));
      dispatchers.set("editor", editorDispatcher);

      const result = (await runtime.callTool("dispatch_editor", {
        task: "t",
        accessMode: "write",
      })) as { error?: string };

      expect(rollbackSpy).toHaveBeenCalledOnce();
      expect(result.error).toContain("original error");
      expect(result.error).not.toContain("rollback itself blew up");
    });
  });
});
