import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMessageHandler } from "../server.js";
import { SessionStore } from "../session/session-store.js";
import { SessionManager } from "../session/session-manager.js";
import { EventBus } from "../events/event-bus.js";
import { SessionCompactor } from "../session/compactor.js";
import { MasterAgent } from "../agents/master-agent.js";
import type { SessionMessage } from "../session/types.js";
import type { DispatchInput, DispatchOutput } from "../agents/types.js";
import { ProjectContextManager } from "../context/project-context.js";
import { ProjectWriteLock } from "../context/write-lock.js";

/**
 * Phase 5e end-to-end: prove that createMessageHandler triggers compaction
 * when the session crosses the token threshold, persists the resulting
 * summary, and threads it into the next masterAgent.handleUserMessage call.
 */

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeMasterStub(): {
  agent: MasterAgent;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi
    .fn()
    .mockResolvedValue({ text: "ok", tokensUsed: { input: 100, output: 50 } });
  return {
    agent: { handleUserMessage: spy } as unknown as MasterAgent,
    spy,
  };
}

function seedHeavyHistory(
  manager: SessionManager,
  sessionId: string,
  count: number,
  charsPerMsg: number
): void {
  for (let i = 0; i < count; i++) {
    const msg: SessionMessage = {
      role: i % 2 === 0 ? "user" : "assistant",
      content: "z".repeat(charsPerMsg),
      timestamp: Date.now(),
    };
    manager.appendMessage(sessionId, msg);
  }
}

describe("Phase 5e — createMessageHandler compaction wiring", () => {
  let store: SessionStore;
  let manager: SessionManager;
  let eventBus: EventBus;

  beforeEach(() => {
    store = new SessionStore();
    manager = new SessionManager(store);
    eventBus = new EventBus();
  });

  it("does NOT call the compactor when no compactor is wired (legacy path)", async () => {
    const { agent, spy } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    seedHeavyHistory(manager, session.sessionId, 10, 1000);

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      // sessionCompactor intentionally omitted
    });
    await handler("hi", session.sessionId, { sessionId: session.sessionId, projectId: PROJECT_ID });

    // Master got called with no sessionSummary (4th arg)
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][3]).toBeUndefined();
    // Session.summary still empty
    expect(manager.getSession(session.sessionId)!.summary).toBeUndefined();
  });

  it("does NOT compact when shouldCompact returns false (history below threshold)", async () => {
    const summarize = vi.fn().mockResolvedValue("- bullet");
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 10_000_000, // absurdly high
      retainTailCount: 2,
    });
    const { agent, spy } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    seedHeavyHistory(manager, session.sessionId, 5, 100);

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("hi", session.sessionId, { sessionId: session.sessionId, projectId: PROJECT_ID });

    expect(summarize).not.toHaveBeenCalled();
    expect(spy.mock.calls[0][3]).toBeUndefined();
    expect(manager.getSession(session.sessionId)!.summary).toBeUndefined();
  });

  it("compacts when threshold is crossed, persists summary, threads it into the next agent call", async () => {
    const summarize = vi
      .fn()
      .mockResolvedValue("- user goal: trim silences\n- agent committed to lossless edit");
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 100, // tiny so it fires on any non-trivial history
      retainTailCount: 2,
    });
    const { agent, spy } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    seedHeavyHistory(manager, session.sessionId, 6, 300);

    const events: { type: string; data: Record<string, unknown> }[] = [];
    eventBus.onAll((e) => events.push({ type: e.type, data: e.data }));

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("now what?", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    // Compaction fired exactly once
    expect(summarize).toHaveBeenCalledTimes(1);

    // Session.summary persisted
    const updated = manager.getSession(session.sessionId)!;
    expect(updated.summary).toBe(
      "- user goal: trim silences\n- agent committed to lossless edit"
    );
    expect(updated.lastCompactedAt).toBeTypeOf("number");
    // 6 messages → drop 4, retain 2 (per retainTailCount)
    expect(updated.messages).toHaveLength(2);

    // Master saw the summary as the 4th arg
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][3]).toBe(
      "- user goal: trim silences\n- agent committed to lossless edit"
    );

    // Telemetry event emitted
    const compactedEvent = events.find((e) => e.type === "agent.session_compacted");
    expect(compactedEvent).toBeDefined();
    expect(compactedEvent!.data.droppedCount).toBe(4);
    expect(compactedEvent!.data.retainedCount).toBe(2);
  });

  it("does NOT fail the user's turn when the summarizer rejects (best-effort)", async () => {
    const summarize = vi
      .fn()
      .mockRejectedValue(new Error("rate limited"));
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    const { agent, spy } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    seedHeavyHistory(manager, session.sessionId, 6, 300);

    // Silence the warn so the test output is clean
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    const response = await handler("hi", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    expect(response).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    // No summary persisted; falls back to legacy slice
    expect(manager.getSession(session.sessionId)!.summary).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("MED-1: preserves interleaved tool_result rows across compaction (does not destroy them)", async () => {
    const summarize = vi.fn().mockResolvedValue("- summary bullet");
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    const { agent, spy } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });

    // Seed: user, assistant, tool_result (interleaved), user, assistant, user
    // The compactor sees only user+assistant (4 of them), retainedTail=2 so it
    // keeps the last user+assistant. The tool_result row sits between user[1]
    // and assistant[1] in the unfiltered messages — it must NOT be lost.
    manager.appendMessage(session.sessionId, {
      role: "user",
      content: "z".repeat(300),
      timestamp: 1,
    });
    manager.appendMessage(session.sessionId, {
      role: "assistant",
      content: "z".repeat(300),
      timestamp: 2,
    });
    manager.appendMessage(session.sessionId, {
      role: "user",
      content: "z".repeat(300),
      timestamp: 3,
    });
    // tool_result interleaved BEFORE the next assistant — server.ts must keep it
    manager.appendMessage(session.sessionId, {
      role: "tool_result",
      content: { tool: "x", output: "important state" },
      timestamp: 4,
    });
    manager.appendMessage(session.sessionId, {
      role: "assistant",
      content: "z".repeat(300),
      timestamp: 5,
    });
    manager.appendMessage(session.sessionId, {
      role: "user",
      content: "z".repeat(300),
      timestamp: 6,
    });
    manager.appendMessage(session.sessionId, {
      role: "assistant",
      content: "z".repeat(300),
      timestamp: 7,
    });

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("now what?", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    const updated = manager.getSession(session.sessionId)!;
    // The retainedTail (last 2 user/assistant) starts at the user@timestamp:6
    // — so everything from that index onwards must be in updated.messages,
    // including the assistant@timestamp:7 that follows.
    expect(updated.messages.map((m) => m.timestamp)).toEqual([6, 7]);
    // The tool_result was BEFORE the retained range, so it gets summarized
    // (acceptable — it's pre-tail). The point of MED-1 is that it doesn't
    // get DROPPED while sitting in the retained range, which would happen
    // if applyCompaction received the filtered tail.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("MED-2: counts the current user message in the threshold check", async () => {
    const summarize = vi.fn().mockResolvedValue("- bullet");
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 200, // ~720 chars at 3.6 chars/tok
      retainTailCount: 2,
    });
    const { agent } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    // Seed history just below threshold: 3 messages × 200 chars = 600 chars (~167 tokens)
    for (let i = 0; i < 3; i++) {
      manager.appendMessage(session.sessionId, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: "z".repeat(200),
        timestamp: i,
      });
    }
    // Without MED-2 the handler reads only existing messages (~167 tokens) and
    // skips compaction. With MED-2, the current 200-char message pushes us
    // over (167 + ~56 = ~223 > 200), so compaction fires.
    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("z".repeat(200), session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("MED-3: concurrent turns on the same session do NOT both trigger compaction", async () => {
    let summarizeCalls = 0;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((r) => {
      firstStarted = r;
    });
    let releaseFirst!: () => void;
    const releaseFirstPromise = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const summarize = vi.fn().mockImplementation(async () => {
      summarizeCalls++;
      if (summarizeCalls === 1) {
        firstStarted();
        await releaseFirstPromise;
      }
      return "- summary";
    });
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    const { agent } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    seedHeavyHistory(manager, session.sessionId, 6, 300);

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });

    // Fire two turns concurrently on the same sessionId.
    const p1 = handler("hi 1", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });
    const p2 = handler("hi 2", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    // Wait until first summarize is in flight, then release it.
    await firstStartedPromise;
    releaseFirst();
    await Promise.all([p1, p2]);

    // Without the mutex this would be 2 (both turns saw the same heavy state
    // and both called Haiku). With the mutex it must be 1.
    expect(summarizeCalls).toBe(1);
  });

  it("LOW-2: agent.session_compacted event carries previousCompactionAt", async () => {
    const summarize = vi.fn().mockResolvedValue("- second-round bullet");
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    const { agent } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });

    // Pre-stamp a compaction so previousCompactionAt is non-null on the next one
    manager.applyCompaction(session.sessionId, {
      summary: "earlier summary",
      retainedTail: [{ role: "user", content: "kept", timestamp: 0 }],
    });
    const firstCompactionAt = manager.getSession(session.sessionId)!.lastCompactedAt!;

    // Seed enough history to trigger compaction again
    seedHeavyHistory(manager, session.sessionId, 5, 300);

    const events: { type: string; data: Record<string, unknown> }[] = [];
    eventBus.onAll((e) => events.push({ type: e.type, data: e.data }));

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("hi", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    const compactedEvent = events.find((e) => e.type === "agent.session_compacted");
    expect(compactedEvent).toBeDefined();
    expect(compactedEvent!.data.previousCompactionAt).toBe(firstCompactionAt);
  });

  it("LOW-2: agent.session_compacted previousCompactionAt is null on first-ever compaction", async () => {
    const summarize = vi.fn().mockResolvedValue("- bullet");
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    const { agent } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    seedHeavyHistory(manager, session.sessionId, 6, 300);

    const events: { type: string; data: Record<string, unknown> }[] = [];
    eventBus.onAll((e) => events.push({ type: e.type, data: e.data }));

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("hi", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    const compactedEvent = events.find((e) => e.type === "agent.session_compacted");
    expect(compactedEvent!.data.previousCompactionAt).toBeNull();
  });

  it("NIT-3: real MasterAgent receives the summary in config.system (not just stub-arg-position)", async () => {
    // Mock the runtime so we can capture the AgentConfig the master built.
    const capturedConfigs: Array<{ system: string }> = [];
    const runtime = {
      run: vi
        .fn()
        .mockImplementation(async (config: { system: string }) => {
          capturedConfigs.push({ system: config.system });
          return {
            text: "ok",
            toolCalls: [],
            tokensUsed: { input: 100, output: 50 },
          };
        }),
      setToolExecutor: vi.fn(),
    };

    const realMaster = new MasterAgent({
      runtime: runtime as unknown as ConstructorParameters<
        typeof MasterAgent
      >[0]["runtime"],
      contextManager: new ProjectContextManager({
        timelineState: '{"tracks":[]}',
        snapshotVersion: 1,
        memoryContext: {
          promptText: "",
          injectedMemoryIds: [],
          injectedSkillIds: [],
        },
        recentChanges: [],
      }),
      writeLock: new ProjectWriteLock(),
      subAgentDispatchers: new Map<
        string,
        (input: DispatchInput) => Promise<DispatchOutput>
      >(),
    });

    const summarize = vi
      .fn()
      .mockResolvedValue("- user wants tight cuts\n- avoid jump cuts");
    const compactor = new SessionCompactor({
      summarize,
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    const session = manager.createSession({ projectId: PROJECT_ID });
    seedHeavyHistory(manager, session.sessionId, 6, 300);

    const handler = createMessageHandler({
      masterAgent: realMaster,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("trim this scene", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    // The system prompt the runtime received MUST contain the summary text
    // and the "compacted earlier turns" header from master-agent.ts.
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0].system).toContain(
      "Conversation summary (compacted earlier turns)",
    );
    expect(capturedConfigs[0].system).toContain("- user wants tight cuts");
    expect(capturedConfigs[0].system).toContain("- avoid jump cuts");
  });

  it("threads existing session.summary into agent call even when compaction does not fire this turn", async () => {
    const compactor = new SessionCompactor({
      summarize: vi.fn(),
      thresholdTokens: 10_000_000, // never fires
      retainTailCount: 2,
    });
    const { agent, spy } = makeMasterStub();
    const session = manager.createSession({ projectId: PROJECT_ID });
    // Pre-stamp a summary as if a prior turn compacted
    manager.applyCompaction(session.sessionId, {
      summary: "prior summary from earlier turn",
      retainedTail: [{ role: "user", content: "kept", timestamp: 0 }],
    });

    const handler = createMessageHandler({
      masterAgent: agent,
      sessionManager: manager,
      eventBus,
      sessionCompactor: compactor,
    });
    await handler("hi", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    expect(spy.mock.calls[0][3]).toBe("prior summary from earlier turn");
  });
});
