import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AnnotationsSchema,
  AnnotatedFrameSchema,
  type Annotations,
  type AnnotatedFrame,
} from "../routes/chat.js";
import { MasterAgent } from "../agents/master-agent.js";
import { ProjectContextManager } from "../context/project-context.js";
import { ProjectWriteLock } from "../context/write-lock.js";
import type { DispatchInput, DispatchOutput } from "../agents/types.js";
import { createMessageHandler } from "../server.js";
import { SessionStore } from "../session/session-store.js";
import { SessionManager } from "../session/session-manager.js";
import { EventBus } from "../events/event-bus.js";

/**
 * Phase 5d — Multimodal indication input.
 *
 * Verifies:
 *   1. Schema accepts/rejects the right shapes (5d.1)
 *   2. MasterAgent serializes annotations into a deterministic prompt
 *      prefix the model can parse exactly (5d.3 text path)
 *   3. When an annotated frame is attached, the runtime sees a multi-block
 *      content array (text + Anthropic vision block) — Q1=d (5d.3 image path)
 *   4. Un-annotated turns are bit-for-bit identical to pre-5d behavior
 *   5. createMessageHandler threads annotations + frame end-to-end (5d.5)
 */

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";

// ────────────────────────────────────────────────────────────────────────────
// 5d.1 — Schema validation
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5d.1 — chat schema", () => {
  describe("AnnotationsSchema", () => {
    it("accepts undefined (no annotations on this turn)", () => {
      expect(AnnotationsSchema.parse(undefined)).toBeUndefined();
    });

    it("accepts a single spatial annotation in 0..1 normalized coords", () => {
      const result = AnnotationsSchema.parse({
        spatial: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
      });
      expect(result?.spatial).toHaveLength(1);
      expect(result?.spatial?.[0].x).toBe(0.1);
    });

    it("accepts multiple spatial annotations (Q3: arrays in schema)", () => {
      const result = AnnotationsSchema.parse({
        spatial: [
          { x: 0, y: 0, w: 0.5, h: 0.5 },
          { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
        ],
      });
      expect(result?.spatial).toHaveLength(2);
    });

    it("rejects spatial coords outside [0,1]", () => {
      expect(() =>
        AnnotationsSchema.parse({ spatial: [{ x: 1.5, y: 0, w: 0.1, h: 0.1 }] }),
      ).toThrow();
      expect(() =>
        AnnotationsSchema.parse({ spatial: [{ x: -0.1, y: 0, w: 0.1, h: 0.1 }] }),
      ).toThrow();
    });

    it("accepts a temporal window with non-negative seconds", () => {
      const result = AnnotationsSchema.parse({
        temporal: { startSec: 1.5, endSec: 3.0 },
      });
      expect(result?.temporal?.startSec).toBe(1.5);
    });

    it("rejects negative temporal seconds", () => {
      expect(() =>
        AnnotationsSchema.parse({ temporal: { startSec: -1, endSec: 1 } }),
      ).toThrow();
    });

    it("accepts a ghostRef alongside spatial+temporal", () => {
      const result = AnnotationsSchema.parse({
        spatial: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
        temporal: { startSec: 0, endSec: 1 },
        ghostRef: { ghostId: "ghost-abc" },
      });
      expect(result?.ghostRef?.ghostId).toBe("ghost-abc");
    });

    it("accepts an optional label on a spatial annotation", () => {
      const result = AnnotationsSchema.parse({
        spatial: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "remove this" }],
      });
      expect(result?.spatial?.[0].label).toBe("remove this");
    });
  });

  describe("AnnotatedFrameSchema", () => {
    it("accepts a small base64 png", () => {
      const result = AnnotatedFrameSchema.parse({
        mediaType: "image/png",
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=",
      });
      expect(result?.mediaType).toBe("image/png");
    });

    it("rejects an unknown mediaType", () => {
      expect(() =>
        AnnotatedFrameSchema.parse({
          mediaType: "image/svg+xml",
          base64: "abc",
        }),
      ).toThrow();
    });

    it("rejects an empty base64", () => {
      expect(() =>
        AnnotatedFrameSchema.parse({ mediaType: "image/png", base64: "" }),
      ).toThrow();
    });

    it("rejects a base64 over the 12MB cap", () => {
      const oversized = "x".repeat(12_000_001);
      expect(() =>
        AnnotatedFrameSchema.parse({
          mediaType: "image/png",
          base64: oversized,
        }),
      ).toThrow();
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5d.3 — MasterAgent prompt threading + vision-block plumbing
// ────────────────────────────────────────────────────────────────────────────

function makeMockRuntime() {
  const captured: Array<{
    input: string;
    userContent?: unknown;
    history?: unknown;
  }> = [];
  return {
    captured,
    run: vi.fn(async (_config: unknown, input: string, history?: unknown, userContent?: unknown) => {
      captured.push({ input, userContent, history });
      return {
        text: "ok",
        toolCalls: [],
        tokensUsed: { input: 100, output: 50 },
      };
    }),
    setToolExecutor: vi.fn(),
  };
}

function makeMaster(runtime: ReturnType<typeof makeMockRuntime>): MasterAgent {
  return new MasterAgent({
    runtime: runtime as unknown as ConstructorParameters<typeof MasterAgent>[0]["runtime"],
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
}

describe("Phase 5d.3 — MasterAgent threads annotations into the model call", () => {
  let runtime: ReturnType<typeof makeMockRuntime>;
  let master: MasterAgent;

  beforeEach(() => {
    runtime = makeMockRuntime();
    master = makeMaster(runtime);
  });

  it("un-annotated turn: no prefix, no userContent override (back-compat)", async () => {
    await master.handleUserMessage("hello world");
    expect(runtime.captured).toHaveLength(1);
    expect(runtime.captured[0].input).toBe("hello world");
    // No vision block — userContent stays undefined, runtime uses string `input`
    expect(runtime.captured[0].userContent).toBeUndefined();
  });

  it("spatial annotation appears as a structured prefix in the model input text", async () => {
    const annotations: Annotations = {
      spatial: [{ x: 0.25, y: 0.5, w: 0.1, h: 0.1, label: "remove this" }],
    };
    await master.handleUserMessage(
      "remove the highlighted clip",
      undefined,
      undefined,
      undefined,
      annotations,
    );

    const inputText = runtime.captured[0].input;
    expect(inputText).toContain("## User indication");
    expect(inputText).toContain("Spatial");
    expect(inputText).toContain("0.250"); // x normalized
    expect(inputText).toContain("0.500"); // y normalized
    expect(inputText).toContain('"remove this"'); // label round-trips
    expect(inputText).toContain("remove the highlighted clip"); // original message preserved AFTER the prefix
    // Order: prefix, then user message
    const prefixIdx = inputText.indexOf("## User indication");
    const msgIdx = inputText.indexOf("remove the highlighted clip");
    expect(prefixIdx).toBeLessThan(msgIdx);
  });

  it("temporal annotation appears in the prefix with second-precision", async () => {
    const annotations: Annotations = {
      temporal: { startSec: 1.234, endSec: 4.567 },
    };
    await master.handleUserMessage(
      "trim this section",
      undefined,
      undefined,
      undefined,
      annotations,
    );
    const inputText = runtime.captured[0].input;
    expect(inputText).toContain("Temporal: 1.23s → 4.57s");
  });

  it("ghostRef appears in the prefix when provided", async () => {
    const annotations: Annotations = {
      ghostRef: { ghostId: "ghost-xyz" },
    };
    await master.handleUserMessage(
      "apply to the ghost",
      undefined,
      undefined,
      undefined,
      annotations,
    );
    expect(runtime.captured[0].input).toContain("Ghost reference: ghost-xyz");
  });

  it("multiple spatial annotations all appear in the prefix (Q3: 1..N supported)", async () => {
    const annotations: Annotations = {
      spatial: [
        { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      ],
    };
    await master.handleUserMessage(
      "remove these",
      undefined,
      undefined,
      undefined,
      annotations,
    );
    const inputText = runtime.captured[0].input;
    expect(inputText).toContain("0.100"); // first
    expect(inputText).toContain("0.500"); // second
  });

  it("annotations object with empty spatial+no temporal+no ghostRef → no prefix added", async () => {
    const annotations: Annotations = { spatial: [] };
    await master.handleUserMessage(
      "plain message",
      undefined,
      undefined,
      undefined,
      annotations,
    );
    expect(runtime.captured[0].input).toBe("plain message");
  });

  it("Q1=d: annotated frame attached as Anthropic vision block via userContent", async () => {
    const frame: AnnotatedFrame = {
      mediaType: "image/png",
      base64: "AAAA",
    };
    const annotations: Annotations = {
      spatial: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }],
    };
    await master.handleUserMessage(
      "this one",
      undefined,
      undefined,
      undefined,
      annotations,
      frame,
    );

    // userContent should be a 2-block array: text + image
    const userContent = runtime.captured[0].userContent as Array<{
      type: string;
      [k: string]: unknown;
    }>;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent).toHaveLength(2);
    expect(userContent[0].type).toBe("text");
    expect(userContent[1].type).toBe("image");
    const imageBlock = userContent[1] as {
      type: "image";
      source: { type: string; media_type: string; data: string };
    };
    expect(imageBlock.source.type).toBe("base64");
    expect(imageBlock.source.media_type).toBe("image/png");
    expect(imageBlock.source.data).toBe("AAAA");
  });

  it("annotated frame WITHOUT spatial annotations still rides as vision block (caller's choice)", async () => {
    const frame: AnnotatedFrame = { mediaType: "image/jpeg", base64: "BBBB" };
    await master.handleUserMessage(
      "describe this image",
      undefined,
      undefined,
      undefined,
      undefined, // no annotations
      frame,
    );
    const userContent = runtime.captured[0].userContent as unknown[];
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5d.5 — End-to-end through createMessageHandler
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 5d.5 — createMessageHandler threads annotations + frame to MasterAgent", () => {
  it("passes annotations (5th arg) and annotatedFrame (6th arg) to handleUserMessage", async () => {
    const handleSpy = vi
      .fn()
      .mockResolvedValue({ text: "ok", tokensUsed: { input: 0, output: 0 } });
    const masterAgent = { handleUserMessage: handleSpy } as unknown as MasterAgent;

    const sessionManager = new SessionManager(new SessionStore());
    const session = sessionManager.createSession({ projectId: PROJECT_ID });
    const handler = createMessageHandler({
      masterAgent,
      sessionManager,
      eventBus: new EventBus(),
    });

    const annotations: Annotations = {
      spatial: [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }],
    };
    const frame: AnnotatedFrame = {
      mediaType: "image/png",
      base64: "AAAA",
    };

    await handler(
      "hello",
      session.sessionId,
      { sessionId: session.sessionId, projectId: PROJECT_ID },
      annotations,
      frame,
    );

    expect(handleSpy).toHaveBeenCalledTimes(1);
    // Positional args: (message, history, identity, sessionSummary, annotations, frame)
    const callArgs = handleSpy.mock.calls[0];
    expect(callArgs[4]).toEqual(annotations);
    expect(callArgs[5]).toEqual(frame);
  });

  it("un-annotated call passes undefined for both 5th and 6th args (back-compat)", async () => {
    const handleSpy = vi
      .fn()
      .mockResolvedValue({ text: "ok", tokensUsed: { input: 0, output: 0 } });
    const masterAgent = { handleUserMessage: handleSpy } as unknown as MasterAgent;
    const sessionManager = new SessionManager(new SessionStore());
    const session = sessionManager.createSession({ projectId: PROJECT_ID });
    const handler = createMessageHandler({
      masterAgent,
      sessionManager,
      eventBus: new EventBus(),
    });

    await handler("hi", session.sessionId, {
      sessionId: session.sessionId,
      projectId: PROJECT_ID,
    });

    expect(handleSpy.mock.calls[0][4]).toBeUndefined();
    expect(handleSpy.mock.calls[0][5]).toBeUndefined();
  });
});
