import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMessageHandler } from "../server.js";
import { SessionStore } from "../session/session-store.js";
import { SessionManager } from "../session/session-manager.js";
import { EventBus } from "../events/event-bus.js";
import { SessionCompactor } from "../session/compactor.js";
import type { MasterAgent } from "../agents/master-agent.js";
import type { SessionMessage } from "../session/types.js";

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
