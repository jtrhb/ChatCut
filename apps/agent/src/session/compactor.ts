import Anthropic from "@anthropic-ai/sdk";
import type { SessionMessage } from "./types.js";

/**
 * Phase 5e — Session memory wiring.
 *
 * SessionCompactor decides when to roll a long conversation into a summary
 * and runs the LLM call that produces that summary. It is intentionally
 * SDK-agnostic: callers inject a `summarize` function so tests can mock the
 * LLM and production wires Anthropic Haiku via `createAnthropicSummarizer`.
 *
 * Decisions (see .omc/plans/phase-5.md §2):
 * - Q1a/Q1b: trigger when estimated input tokens (history + summary) > 150K
 *   of the 180K master input cap (~75%, leaves headroom for the next turn's
 *   tool calls + memory injection + Anthropic's input/output reservation).
 * - Q2:     summarizer is `claude-haiku-4-5` (cheap + fast + nuanced).
 * - Q3:     summary lives on `AgentSession.summary` (explicit field).
 * - Q4:     replacement, not layering — pre-summary messages are dropped
 *           except for a small continuity tail (last user + last assistant).
 */

/** ~4 chars per token is the common rule of thumb for English Anthropic models.
 *  We bias slightly conservative (3.6) so compaction fires a touch early —
 *  cheaper than overshooting the input cap. */
const CHARS_PER_TOKEN = 3.6;

const DEFAULT_THRESHOLD_TOKENS = 150_000;
/** Keep this many trailing messages verbatim so the model can see how the
 *  most recent exchange ended. Below 2 we'd lose the last user turn → assistant
 *  pairing; above ~4 we waste the savings compaction was supposed to buy. */
const DEFAULT_RETAIN_TAIL_COUNT = 2;
const DEFAULT_SUMMARY_MODEL = "claude-haiku-4-5";
const DEFAULT_SUMMARY_MAX_TOKENS = 1500;

export interface SummarizeInput {
  messages: SessionMessage[];
  priorSummary?: string;
}

/** Pluggable LLM summarizer. Callers (tests + prod) inject this. */
export type SummarizeFn = (input: SummarizeInput) => Promise<string>;

export interface CompactorDeps {
  summarize: SummarizeFn;
  thresholdTokens?: number;
  retainTailCount?: number;
}

export interface CompactionResult {
  /** New summary text to persist on AgentSession.summary. May incorporate priorSummary. */
  summary: string;
  /** Continuity tail to keep verbatim — these are the messages the next turn will still see. */
  retainedTail: SessionMessage[];
  /** How many messages were rolled into the summary (i.e. dropped from history). */
  droppedCount: number;
}

export class SessionCompactor {
  private readonly thresholdTokens: number;
  private readonly retainTailCount: number;

  constructor(private readonly deps: CompactorDeps) {
    this.thresholdTokens = deps.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
    this.retainTailCount = deps.retainTailCount ?? DEFAULT_RETAIN_TAIL_COUNT;
  }

  /**
   * Char-based token estimate. Cheap, no tokenizer dep. Pessimistic by design.
   *
   * `extraText` (Phase 5e MED-2 fix) lets the caller include the current
   * turn's user message in the threshold check WITHOUT having it count as
   * something to summarize. The chat route appends the user message AFTER
   * messageHandler runs, so without this the threshold lags the real input
   * by one turn — eating the entire 30K headroom in a worst-case turn.
   */
  estimateTokens(
    messages: SessionMessage[],
    priorSummary?: string,
    extraText?: string,
  ): number {
    let chars = priorSummary ? priorSummary.length : 0;
    if (extraText) chars += extraText.length;
    for (const m of messages) {
      chars += stringifyContent(m.content).length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /** True when (history + summary + extraText) would push the next turn over budget. */
  shouldCompact(
    messages: SessionMessage[],
    priorSummary?: string,
    extraText?: string,
  ): boolean {
    if (messages.length <= this.retainTailCount) return false;
    return (
      this.estimateTokens(messages, priorSummary, extraText) > this.thresholdTokens
    );
  }

  /**
   * Run compaction. Splits messages into [pre-tail, tail], asks the
   * summarizer to fold the pre-tail (and any priorSummary) into a single
   * summary, returns the result. Caller persists via SessionManager.applyCompaction.
   *
   * Throws if the summarizer rejects — the caller MUST catch and treat as
   * "compaction skipped this turn" rather than failing the user's request.
   */
  async compact(
    messages: SessionMessage[],
    priorSummary?: string
  ): Promise<CompactionResult> {
    const tailStart = Math.max(0, messages.length - this.retainTailCount);
    const preTail = messages.slice(0, tailStart);
    const retainedTail = messages.slice(tailStart);

    const summary = await this.deps.summarize({
      messages: preTail,
      priorSummary,
    });

    return {
      summary: summary.trim(),
      retainedTail,
      droppedCount: preTail.length,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Production summarizer factory
// ────────────────────────────────────────────────────────────────────────────

const SUMMARIZER_SYSTEM = [
  "You compact a video-editing AI assistant's conversation into a tight summary",
  "so the assistant can keep going after older messages are dropped from context.",
  "",
  "Preserve, in priority order:",
  "1. User's stated goals and constraints (deadlines, style, target length, brand).",
  "2. Decisions made and tools used (so the assistant doesn't redo work).",
  "3. Outstanding TODOs or rejected approaches the user told you to avoid.",
  "4. Key entities: project name, clip names, timecodes/ranges already discussed",
  "   (e.g. \"in:out 00:01:23–00:02:10\" — the model will recompute or re-ask",
  "   if it forgets a range), timeline structure facts.",
  "",
  "Drop: chit-chat, greetings, retracted plans, verbose tool output already acted on.",
  "",
  "Output: bullet points only. No preamble, no closing remarks. Under 800 tokens.",
].join("\n");

/**
 * Build the Anthropic Haiku prompt for one compaction pass. If a priorSummary
 * exists, ask the model to merge it with the new pre-tail messages so the
 * summary stays coherent across multiple compactions.
 */
function buildSummarizerUserPrompt(input: SummarizeInput): string {
  const parts: string[] = [];
  if (input.priorSummary) {
    parts.push("## Existing summary (merge into the new one)\n");
    parts.push(input.priorSummary);
    parts.push("\n");
  }
  parts.push("## Conversation to compact\n");
  for (const m of input.messages) {
    parts.push(`### ${m.role}`);
    parts.push(stringifyContent(m.content));
    parts.push("");
  }
  parts.push("\n## Instruction\nReturn the merged summary as bullet points.");
  return parts.join("\n");
}

export interface AnthropicSummarizerOpts {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
}

/** Production wiring: a SummarizeFn backed by Anthropic Haiku. */
export function createAnthropicSummarizer(
  opts: AnthropicSummarizerOpts
): SummarizeFn {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? DEFAULT_SUMMARY_MODEL;
  const maxTokens = opts.maxOutputTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;

  return async (input) => {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: SUMMARIZER_SYSTEM,
      messages: [{ role: "user", content: buildSummarizerUserPrompt(input) }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text.trim()) {
      throw new Error("SessionCompactor: summarizer returned empty text");
    }
    return text;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers (exported so server.ts and any other history-flattening callsite
// can mirror this — Phase 5e LOW-1 fix avoids `String({...}) === "[object Object]"`).
// ────────────────────────────────────────────────────────────────────────────

const UNSERIALIZABLE_SENTINEL = "[unserializable content]";

/**
 * Serialize SessionMessage.content for token estimation, summarizer input,
 * and history flattening. Returns a string that's safe to feed to an LLM:
 * - strings pass through verbatim
 * - JSON-serializable objects → JSON.stringify
 * - circular refs / unserializable values → explicit sentinel (NIT-1).
 *   Returning `String(content) === "[object Object]"` would silently inject
 *   garbage into the summary; the sentinel makes the failure visible.
 */
export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return UNSERIALIZABLE_SENTINEL;
  }
}
