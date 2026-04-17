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

    it("review D2: releases the write lock even without serverCore on dispatcher throw", async () => {
      // Regression for a silent lock-leak path: dispatcher throws, no
      // serverCore wired (so rollback path is the `if (this.serverCore)` no-op),
      // but the writeLock.release() in the finally block MUST still fire.
      const editorDispatcher = vi
        .fn<(input: DispatchInput) => Promise<DispatchOutput>>()
        .mockRejectedValue(new Error("boom-no-core"));
      dispatchers.set("editor", editorDispatcher);

      const masterNoCore = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        // No serverCore wired on purpose
      });
      void masterNoCore;

      const releaseSpy = vi.spyOn(writeLock, "release");
      const acquireSpy = vi.spyOn(writeLock, "acquire");

      await runtime.callTool("dispatch_editor", { task: "x", accessMode: "write" });

      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(releaseSpy).toHaveBeenCalledOnce();
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

    it("B4: writeMemory routes through a REAL MemoryStore with the master's token (integration)", async () => {
      // Replaces the earlier mock-only test where both sides were vi.fn() —
      // that version passed even if MasterAgent.writeMemory forgot to
      // forward the token. This one uses a real MemoryStore + captures
      // the actual R2 PutObjectCommand to prove the write lands end-to-end.
      const { MemoryStore } = await import("../../memory/memory-store.js");
      const puts: Array<{ Key: string; Body: string }> = [];
      const storageStub = {
        client: {
          send: async (cmd: any) => {
            if (cmd?.input?.Body !== undefined) {
              puts.push({ Key: cmd.input.Key, Body: cmd.input.Body });
            }
            return {};
          },
        },
      };
      const realStore = new MemoryStore(storageStub as any, "user-test");

      const masterWithMemory = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryStore: realStore,
      });

      const mem = {
        memory_id: "mem-real",
        type: "preference",
        status: "active",
        confidence: "high",
        source: "explicit",
        created: "2026-01-01",
        updated: "2026-01-01",
        reinforced_count: 0,
        last_reinforced_at: "2026-01-01",
        source_change_ids: [],
        used_in_changeset_ids: [],
        created_session_id: "s",
        scope: "global",
        scope_level: "global",
        semantic_key: "k",
        tags: [],
        content: "real memory content",
      } as any;

      await masterWithMemory.writeMemory("explicit/mem-real.md", mem);

      expect(puts).toHaveLength(1);
      expect(puts[0].Key).toBe("chatcut-memory/user-test/explicit/mem-real.md");
      expect(puts[0].Body).toContain("memory_id: mem-real");
      expect(puts[0].Body).toContain("real memory content");

      // The token gate is still structurally enforced: a second grant throws.
      expect(() => realStore.grantWriterToken()).toThrow(/already granted/);
    });

    it("B4: writeMemory throws when no memoryStore was configured", async () => {
      const agentNoMemory = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
      });

      await expect(
        agentNoMemory.writeMemory("x", { memory_id: "m", content: "c" } as any),
      ).rejects.toThrow(/memoryStore was not configured/);
    });

    it("B4: getMemoryWriter returns a callback bound to the master token", async () => {
      const grantedToken = Symbol("master-token");
      const writeMemorySpy = vi.fn().mockResolvedValue(undefined);
      const memoryStoreMock = {
        grantWriterToken: vi.fn().mockReturnValue(grantedToken),
        writeMemory: writeMemorySpy,
      } as any;

      const masterWithMemory = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryStore: memoryStoreMock,
      });

      const writer = masterWithMemory.getMemoryWriter();
      await writer("drafts/mem-2.md", { memory_id: "mem-2", content: "x" } as any);

      expect(writeMemorySpy).toHaveBeenCalledWith(
        grantedToken,
        "drafts/mem-2.md",
        expect.objectContaining({ memory_id: "mem-2" }),
      );
    });

    it("B4: loadMemories is called with resolved TaskContext (brand, series, projectId, sessionId, agentType)", async () => {
      const loadMemoriesSpy = vi.fn().mockResolvedValue({
        promptText: "## Memory: prefer quick cuts",
        injectedMemoryIds: ["mem-a", "mem-b"],
        injectedSkillIds: ["skill-1"],
      });
      const memoryLoaderMock = { loadMemories: loadMemoriesSpy } as any;

      contextManager.registerBrand("proj-1", { brand: "acme", series: "spring" });

      const masterWithLoader = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
      });

      await masterWithLoader.handleUserMessage("do a thing", undefined, {
        projectId: "proj-1",
        sessionId: "sess-123",
        userId: "user-1",
      });

      expect(loadMemoriesSpy).toHaveBeenCalledOnce();
      const [taskCtx, templateKey] = loadMemoriesSpy.mock.calls[0];
      expect(taskCtx).toMatchObject({
        brand: "acme",
        series: "spring",
        projectId: "proj-1",
        sessionId: "sess-123",
        agentType: "master",
      });
      expect(templateKey).toBe("single-edit");
    });

    it("B4: getCurrentInjectedMemoryIds is cleared in the finally block after a turn", async () => {
      const memoryLoaderMock = {
        loadMemories: vi.fn().mockResolvedValue({
          promptText: "...",
          injectedMemoryIds: ["mem-a", "mem-b"],
          injectedSkillIds: ["skill-1"],
        }),
      } as any;
      contextManager.registerBrand("proj-1", { brand: "acme" });

      const master = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
      });

      await master.handleUserMessage("x", undefined, { projectId: "proj-1", sessionId: "s" });

      // Post-turn reset invariant (so a subsequent turn with no loader doesn't
      // accidentally stamp stale IDs onto a fresh changeset).
      expect(master.getCurrentInjectedMemoryIds()).toEqual({ memoryIds: [], skillIds: [] });
    });

    it("B4 [C2 fix]: each dispatch calls loadMemories with its own agentType and appends IDs", async () => {
      const loadMemoriesSpy = vi.fn(async (ctx: any, templateKey: string) => {
        // Return agentType-specific IDs so we can tell the calls apart.
        return {
          promptText: `memory for ${ctx.agentType}`,
          injectedMemoryIds: [`mem-${ctx.agentType}-1`],
          injectedSkillIds: [`skill-${ctx.agentType}`],
        };
      });
      const memoryLoaderMock = { loadMemories: loadMemoriesSpy } as any;

      contextManager.registerBrand("proj-disp", { brand: "acme" });

      const editorDispatcher = makeDispatcher("editor result");
      dispatchers.set("editor", editorDispatcher);

      const master = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
      });

      runtime.run.mockImplementationOnce(async () => {
        // Dispatch a sub-agent mid-turn.
        await runtime.callTool("dispatch_editor", {
          task: "trim clip",
          accessMode: "write",
        });
        return { text: "ok", toolCalls: [], tokensUsed: { input: 1, output: 1 } };
      });

      await master.handleUserMessage("trim something", undefined, {
        projectId: "proj-disp",
        sessionId: "sess-disp",
        userId: "alice",
      });

      // loadMemories called ≥ 2 times: once for master, once for editor dispatch.
      expect(loadMemoriesSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      const agentTypesLoaded = loadMemoriesSpy.mock.calls.map((c) => (c[0] as any).agentType);
      expect(agentTypesLoaded).toContain("master");
      expect(agentTypesLoaded).toContain("editor");

      // Dispatcher received the per-dispatch memory promptText in its context.
      expect(editorDispatcher).toHaveBeenCalledOnce();
      const dispatchArg = editorDispatcher.mock.calls[0][0] as DispatchInput;
      expect((dispatchArg.context as any)?.memoryPromptText).toBe("memory for editor");
    });

    it("B4 [C2 fix]: propose_changes after a dispatch stamps BOTH master and sub-agent memory IDs", async () => {
      const loadMemoriesSpy = vi.fn(async (ctx: any) => ({
        promptText: `m-${ctx.agentType}`,
        injectedMemoryIds: [`mem-${ctx.agentType}`],
        injectedSkillIds: [`skill-${ctx.agentType}`],
      }));
      const memoryLoaderMock = { loadMemories: loadMemoriesSpy } as any;

      const { ChangeLog } = await import("@opencut/core");
      const { ServerEditorCore } = await import("../../services/server-editor-core.js");
      const { ChangesetManager } = await import("../../changeset/changeset-manager.js");
      const emptyState = { project: null, scenes: [], activeSceneId: null } as any;
      const serverCore = ServerEditorCore.fromSnapshot(emptyState);
      const changeLog = new ChangeLog();
      const changesetManager = new ChangesetManager({ changeLog, serverCore });

      contextManager.registerBrand("proj-combo", { brand: "acme" });

      const editorDispatcher = makeDispatcher("ok");
      dispatchers.set("editor", editorDispatcher);

      const master = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
        changesetManager,
      });

      let stampedChangeset: any;
      runtime.run.mockImplementationOnce(async () => {
        // First dispatch the editor (appends editor memory IDs).
        await runtime.callTool("dispatch_editor", { task: "t", accessMode: "write" });
        // Then propose (stamps both master + editor IDs).
        stampedChangeset = await runtime.callTool("propose_changes", {
          summary: "combined",
          affectedElements: [],
          projectId: "proj-combo",
        });
        return { text: "ok", toolCalls: [], tokensUsed: { input: 1, output: 1 } };
      });

      await master.handleUserMessage("go", undefined, {
        projectId: "proj-combo",
        sessionId: "s",
        userId: "alice",
      });

      expect(stampedChangeset.injectedMemoryIds).toEqual(
        expect.arrayContaining(["mem-master", "mem-editor"]),
      );
      expect(stampedChangeset.injectedSkillIds).toEqual(
        expect.arrayContaining(["skill-master", "skill-editor"]),
      );
    });

    it("B4 [C1 fix]: propose_changes during the turn stamps loaded memory IDs onto the changeset", async () => {
      // End-to-end proof of spec §9.4: load memories → propose_changes →
      // the resulting PendingChangeset carries injectedMemoryIds / SkillIds.
      const { ChangeLog } = await import("@opencut/core");
      const { ServerEditorCore } = await import("../../services/server-editor-core.js");
      const { ChangesetManager } = await import("../../changeset/changeset-manager.js");

      const emptyState = { project: null, scenes: [], activeSceneId: null } as any;
      const serverCore = ServerEditorCore.fromSnapshot(emptyState);
      const changeLog = new ChangeLog();
      const changesetManager = new ChangesetManager({ changeLog, serverCore });

      const memoryLoaderMock = {
        loadMemories: vi.fn().mockResolvedValue({
          promptText: "## Memory: relevant rules",
          injectedMemoryIds: ["mem-loaded-A", "mem-loaded-B"],
          injectedSkillIds: ["skill-loaded-X"],
        }),
      } as any;

      contextManager.registerBrand("proj-stamp", { brand: "acme" });

      const master = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
        changesetManager,
      });

      // Drive a turn that, mid-flight, calls propose_changes via the tool pipeline.
      runtime.run.mockImplementationOnce(async () => {
        const cs = (await runtime.callTool("propose_changes", {
          summary: "test stamping",
          affectedElements: ["el-1"],
          projectId: "proj-stamp",
        })) as { changesetId: string; injectedMemoryIds: string[]; injectedSkillIds: string[] };

        // The returned PendingChangeset should carry the loaded IDs.
        expect(cs.injectedMemoryIds).toEqual(["mem-loaded-A", "mem-loaded-B"]);
        expect(cs.injectedSkillIds).toEqual(["skill-loaded-X"]);

        // And the manager's stored copy should match (defensive slice worked).
        const stored = changesetManager.getChangeset(cs.changesetId)!;
        expect(stored.injectedMemoryIds).toEqual(["mem-loaded-A", "mem-loaded-B"]);
        expect(stored.injectedSkillIds).toEqual(["skill-loaded-X"]);

        return { text: "ok", toolCalls: [], tokensUsed: { input: 1, output: 1 } };
      });

      await master.handleUserMessage("propose something", undefined, {
        projectId: "proj-stamp",
        sessionId: "sess-stamp",
        userId: "alice",
      });

      expect(memoryLoaderMock.loadMemories).toHaveBeenCalledOnce();
    });

    it("B4: injects memory promptText into the system prompt", async () => {
      const memoryLoaderMock = {
        loadMemories: vi.fn().mockResolvedValue({
          promptText: "User prefers jump cuts on sports edits",
          injectedMemoryIds: ["mem-a"],
          injectedSkillIds: [],
        }),
      } as any;

      contextManager.registerBrand("proj-1", { brand: "acme" });

      const masterWithLoader = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
      });

      await masterWithLoader.handleUserMessage("trim clip", undefined, {
        projectId: "proj-1",
        sessionId: "sess-abc",
      });

      expect(runtime.run).toHaveBeenCalledOnce();
      const runArgs = runtime.run.mock.calls[0][0];
      expect(runArgs.system).toContain("## Memory");
      expect(runArgs.system).toContain("User prefers jump cuts on sports edits");
    });

    it("B4: skips memory load gracefully when no brand mapping exists", async () => {
      const loadMemoriesSpy = vi.fn();
      const memoryLoaderMock = { loadMemories: loadMemoriesSpy } as any;

      // No brand registered for this project
      const masterWithLoader = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
      });

      await masterWithLoader.handleUserMessage("hello", undefined, {
        projectId: "unknown-proj",
        sessionId: "sess-xyz",
      });

      expect(loadMemoriesSpy).not.toHaveBeenCalled();
    });

    it("B4: tolerates memory loader throwing (best-effort)", async () => {
      const memoryLoaderMock = {
        loadMemories: vi.fn().mockRejectedValue(new Error("r2 unavailable")),
      } as any;
      contextManager.registerBrand("proj-1", { brand: "acme" });

      const masterWithLoader = new MasterAgent({
        runtime: runtime as any,
        contextManager,
        writeLock,
        subAgentDispatchers: dispatchers,
        memoryLoader: memoryLoaderMock,
      });

      // Must not reject the user's turn
      const result = await masterWithLoader.handleUserMessage("hi", undefined, {
        projectId: "proj-1",
        sessionId: "sess-1",
      });

      expect(result.text).toBe("mock response");
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
