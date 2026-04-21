import { describe, it, expect, vi } from "vitest";
import { SessionCompactor, type SummarizeFn } from "../compactor.js";
import type { SessionMessage } from "../types.js";

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

function makeMsg(role: "user" | "assistant", content: string): SessionMessage {
  return { role, content, timestamp: Date.now() };
}

/** Build N messages whose total char count crosses `targetChars`. */
function bulkMessages(targetChars: number): SessionMessage[] {
  const each = "x".repeat(500);
  const count = Math.ceil(targetChars / each.length);
  const out: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(makeMsg(i % 2 === 0 ? "user" : "assistant", each));
  }
  return out;
}

const STUB_SUMMARY = "- user wants to edit a video\n- agent agreed to remove silences";

/** Returns a vi.fn typed as SummarizeFn. Caller can read .mock.calls directly. */
function makeStubSummarize(): SummarizeFn {
  return vi.fn().mockResolvedValue(STUB_SUMMARY) as unknown as SummarizeFn;
}

// ────────────────────────────────────────────────────────────────────────────
// estimateTokens
// ────────────────────────────────────────────────────────────────────────────

describe("SessionCompactor.estimateTokens", () => {
  it("returns 0 for empty messages with no priorSummary", () => {
    const compactor = new SessionCompactor({ summarize: makeStubSummarize() });
    expect(compactor.estimateTokens([])).toBe(0);
  });

  it("counts message content chars / 3.6", () => {
    const compactor = new SessionCompactor({ summarize: makeStubSummarize() });
    // 360 chars total → 100 tokens at 3.6 chars/tok
    const msgs = [makeMsg("user", "x".repeat(360))];
    expect(compactor.estimateTokens(msgs)).toBe(100);
  });

  it("includes priorSummary chars in the estimate", () => {
    const compactor = new SessionCompactor({ summarize: makeStubSummarize() });
    const msgs = [makeMsg("user", "abc")]; // 3 chars
    const prior = "x".repeat(720); // 720 / 3.6 = 200 tokens
    // 723 / 3.6 = ceil(200.83) = 201
    expect(compactor.estimateTokens(msgs, prior)).toBe(201);
  });

  it("handles non-string content via JSON.stringify", () => {
    const compactor = new SessionCompactor({ summarize: makeStubSummarize() });
    const msgs: SessionMessage[] = [
      { role: "user", content: { foo: "bar" }, timestamp: 0 },
    ];
    // JSON.stringify({foo:"bar"}) = '{"foo":"bar"}' = 13 chars → ceil(13/3.6) = 4
    expect(compactor.estimateTokens(msgs)).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// shouldCompact
// ────────────────────────────────────────────────────────────────────────────

describe("SessionCompactor.shouldCompact", () => {
  it("returns false when message count is at or below retainTailCount", () => {
    const compactor = new SessionCompactor({
      summarize: makeStubSummarize(),
      thresholdTokens: 10, // very low so token check would otherwise pass
      retainTailCount: 2,
    });
    const heavy = makeMsg("user", "x".repeat(10_000));
    // 2 messages = retainTailCount → no compaction (nothing to drop)
    expect(compactor.shouldCompact([heavy, heavy])).toBe(false);
  });

  it("returns false when token estimate is at or below threshold", () => {
    const compactor = new SessionCompactor({
      summarize: makeStubSummarize(),
      thresholdTokens: 1000,
      retainTailCount: 2,
    });
    // 5 messages, light content → well under 1000 tokens
    const msgs = Array.from({ length: 5 }, () => makeMsg("user", "hello"));
    expect(compactor.shouldCompact(msgs)).toBe(false);
  });

  it("returns true when token estimate exceeds threshold AND there is a pre-tail", () => {
    const compactor = new SessionCompactor({
      summarize: makeStubSummarize(),
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    const msgs = bulkMessages(2000); // 4 msgs × 500 chars = ~556 tokens > 100 threshold
    expect(msgs.length).toBeGreaterThan(2);
    expect(compactor.shouldCompact(msgs)).toBe(true);
  });

  it("counts priorSummary toward the threshold", () => {
    const compactor = new SessionCompactor({
      summarize: makeStubSummarize(),
      thresholdTokens: 100,
      retainTailCount: 2,
    });
    // Messages alone are tiny but priorSummary pushes us over
    const msgs = [
      makeMsg("user", "hi"),
      makeMsg("assistant", "hi back"),
      makeMsg("user", "ok"),
    ];
    const heavyPrior = "x".repeat(500); // ~140 tokens
    expect(compactor.shouldCompact(msgs, heavyPrior)).toBe(true);
    expect(compactor.shouldCompact(msgs)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// compact
// ────────────────────────────────────────────────────────────────────────────

describe("SessionCompactor.compact", () => {
  it("splits messages into pre-tail (summarized) and retainedTail (verbatim)", async () => {
    const summarize = makeStubSummarize();
    const compactor = new SessionCompactor({
      summarize,
      retainTailCount: 2,
    });
    const msgs: SessionMessage[] = [
      makeMsg("user", "first"),
      makeMsg("assistant", "second"),
      makeMsg("user", "third"),
      makeMsg("assistant", "fourth"),
      makeMsg("user", "fifth"),
    ];
    const result = await compactor.compact(msgs);

    // First 3 go to summarizer, last 2 are kept verbatim
    expect(result.droppedCount).toBe(3);
    expect(result.retainedTail).toEqual([msgs[3], msgs[4]]);

    expect(summarize).toHaveBeenCalledTimes(1);
    const passedArg = (summarize as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      messages: SessionMessage[];
    };
    expect(passedArg.messages).toEqual([msgs[0], msgs[1], msgs[2]]);
  });

  it("forwards priorSummary so the summarizer can merge it", async () => {
    const summarize = makeStubSummarize();
    const compactor = new SessionCompactor({ summarize, retainTailCount: 1 });
    const msgs = [makeMsg("user", "a"), makeMsg("assistant", "b")];
    await compactor.compact(msgs, "prior bullets here");

    const arg = (summarize as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      priorSummary?: string;
    };
    expect(arg.priorSummary).toBe("prior bullets here");
  });

  it("returns trimmed summary text from the summarizer", async () => {
    const summarize: SummarizeFn = vi
      .fn()
      .mockResolvedValue("  - bullet one\n- bullet two  \n");
    const compactor = new SessionCompactor({ summarize, retainTailCount: 1 });
    const result = await compactor.compact([
      makeMsg("user", "x"),
      makeMsg("assistant", "y"),
    ]);
    expect(result.summary).toBe("- bullet one\n- bullet two");
  });

  it("propagates summarizer errors so the caller can fall back", async () => {
    const summarize: SummarizeFn = vi
      .fn()
      .mockRejectedValue(new Error("rate limited"));
    const compactor = new SessionCompactor({ summarize, retainTailCount: 1 });
    await expect(
      compactor.compact([makeMsg("user", "x"), makeMsg("assistant", "y")])
    ).rejects.toThrow("rate limited");
  });

  it("retainedTail = entire message list when count <= retainTailCount", async () => {
    // shouldCompact would return false in this case; compact() itself doesn't
    // gate on threshold — it's a pure transform. Still: the math should hold.
    const summarize = makeStubSummarize();
    const compactor = new SessionCompactor({ summarize, retainTailCount: 5 });
    const msgs = [makeMsg("user", "only")];
    const result = await compactor.compact(msgs);
    expect(result.droppedCount).toBe(0);
    expect(result.retainedTail).toEqual(msgs);
  });
});
