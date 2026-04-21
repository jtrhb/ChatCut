/**
 * Phase 5a end-to-end integration test.
 *
 * Acceptance from .omc/plans/phase-5.md §1:
 *   "Integration test: stub Gemini fetch (canned VideoAnalysis JSON)
 *    → exercise vision-agent.dispatch_vision → assert structured scenes
 *    returned + cached"
 *
 * Vertical slice under test:
 *
 *   ToolPipeline.execute("analyze_video", input, ctx)
 *      → VisionToolExecutor (registered via createAgentPipeline seam)
 *         → mediaFetcher (stub: returns bytes + mime)
 *         → SHA-256 hash of bytes → cache key
 *         → VisionCache.get(hash, SCHEMA_VERSION) [first call: miss]
 *         → VisionClient.uploadVideo (stub fetch: Files API multipart)
 *         → VisionClient.analyzeVideo (stub fetch: generateContent)
 *         → VisionCache.set(hash, SCHEMA_VERSION, analysis)
 *         → returns { analysis, cacheHit: false }
 *
 *   Second call with the SAME bytes:
 *      → mediaFetcher → same hash → VisionCache.get → HIT
 *      → returns { analysis, cacheHit: true } WITHOUT touching Gemini
 *
 * The VisionAgent class itself wraps this in its own runtime + pipeline,
 * but the runtime makes a real Anthropic call which we don't want in
 * this test. We exercise the pipeline directly with the agentType set
 * to "vision" so the same authorization path runs.
 */

import { describe, it, expect, vi } from "vitest";
import { createAgentPipeline } from "../agents/create-agent-pipeline.js";
import { VisionToolExecutor } from "../tools/vision-tool-executor.js";
import {
  VisionClient,
  SCHEMA_VERSION,
  type VideoAnalysis,
} from "../services/vision-client.js";
import type { VisionCache } from "../services/vision-cache.js";
import { visionToolDefinitions } from "../tools/vision-tools.js";

const ANALYSIS: VideoAnalysis = {
  scenes: [
    { start: 0, end: 4, description: "skateboarder grinds rail", objects: ["rail", "skateboard"] },
    { start: 4, end: 9, description: "crowd cheers", objects: ["crowd", "stadium"] },
  ],
  characters: ["athlete"],
  mood: "energetic",
  style: "action sports",
};

function makeStubFetch() {
  // Sequenced Gemini-side responses: upload → analyze.
  let call = 0;
  const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
    call++;
    if (call === 1) {
      // Files API upload response
      return {
        ok: true,
        json: async () => ({
          file: {
            uri: "https://gemini.example/v1beta/files/clip-1",
            mimeType: "video/mp4",
            name: "files/clip-1",
          },
        }),
      } as unknown as Response;
    }
    // generateContent response
    return {
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(ANALYSIS) }] } },
        ],
      }),
    } as unknown as Response;
  });
  return fetchSpy;
}

function makeInMemoryCache(): VisionCache {
  const store = new Map<string, VideoAnalysis>();
  const key = (h: string, v: number) => `${h}::${v}`;
  return {
    async get(h: string, v: number) {
      return store.get(key(h, v)) ?? null;
    },
    async set(h: string, v: number, a: VideoAnalysis, focus?: string) {
      if (focus) return;
      store.set(key(h, v), a);
    },
    async invalidate(h: string) {
      for (const k of [...store.keys()]) {
        if (k.startsWith(`${h}::`)) store.delete(k);
      }
    },
  } as unknown as VisionCache;
}

describe("Phase 5a — Vision Agent end-to-end", () => {
  it("first call: miss → upload + analyze + cache + return structured scenes", async () => {
    const fetchSpy = makeStubFetch();
    const visionClient = new VisionClient(
      "test-key",
      fetchSpy as unknown as typeof fetch,
    );
    const visionCache = makeInMemoryCache();
    const cacheGetSpy = vi.spyOn(visionCache, "get");
    const cacheSetSpy = vi.spyOn(visionCache, "set");

    const mediaFetcher = vi.fn(async (_url: string) => ({
      bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      mimeType: "video/mp4",
    }));

    const visionExecutor = new VisionToolExecutor({
      visionClient,
      visionCache,
      mediaFetcher,
    });

    // Build the same pipeline a sub-agent would use, with a raw
    // executor that routes to VisionToolExecutor.
    const { executor } = createAgentPipeline(
      async (name, input, ctx) =>
        visionExecutor.execute(name, input, ctx ?? { agentType: "vision", taskId: "t" }),
      visionToolDefinitions,
      "vision",
    );

    const wrapped = (await executor("analyze_video", {
      video_url: "https://r2.example/clip-1.mp4",
    })) as { success: boolean; data?: { analysis: VideoAnalysis; cacheHit: boolean }; error?: string };
    expect(wrapped.success).toBe(true);
    const result = wrapped.data!;

    // Structured scenes returned (acceptance criterion #1)
    expect(result.analysis).toEqual(ANALYSIS);
    expect(result.cacheHit).toBe(false);

    // Gemini was hit exactly twice (upload + analyze)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [uploadUrl] = fetchSpy.mock.calls[0]!;
    const [analyzeUrl] = fetchSpy.mock.calls[1]!;
    expect(uploadUrl).toContain("/upload/v1beta/files");
    expect(analyzeUrl).toContain(":generateContent");

    // Cache write fired with SCHEMA_VERSION
    expect(cacheGetSpy).toHaveBeenCalledTimes(1);
    expect(cacheGetSpy).toHaveBeenCalledWith(expect.any(String), SCHEMA_VERSION);
    expect(cacheSetSpy).toHaveBeenCalledTimes(1);
    expect(cacheSetSpy).toHaveBeenCalledWith(
      expect.any(String),
      SCHEMA_VERSION,
      ANALYSIS,
      undefined,
    );

    // Media fetcher was hit once
    expect(mediaFetcher).toHaveBeenCalledTimes(1);
  });

  it("second call same content: cache hit → NO Gemini round-trip", async () => {
    const fetchSpy = makeStubFetch();
    const visionClient = new VisionClient(
      "test-key",
      fetchSpy as unknown as typeof fetch,
    );
    const visionCache = makeInMemoryCache();
    const mediaFetcher = vi.fn(async (_url: string) => ({
      bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      mimeType: "video/mp4",
    }));

    const visionExecutor = new VisionToolExecutor({
      visionClient,
      visionCache,
      mediaFetcher,
    });
    const { executor } = createAgentPipeline(
      async (name, input, ctx) =>
        visionExecutor.execute(name, input, ctx ?? { agentType: "vision", taskId: "t" }),
      visionToolDefinitions,
      "vision",
    );

    // First call: warms the cache (2 fetches: upload + analyze)
    await executor("analyze_video", { video_url: "https://r2.example/clip.mp4" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Second call: same bytes → cache hit. mediaFetcher fires (we still
    // have to fetch + hash to know whether it's a hit), but Gemini
    // does NOT.
    const wrapped = (await executor("analyze_video", {
      video_url: "https://r2.example/clip.mp4?sig=DIFFERENT",
    })) as { success: boolean; data?: { analysis: VideoAnalysis; cacheHit: boolean } };
    expect(wrapped.success).toBe(true);
    const result = wrapped.data!;

    expect(result.cacheHit).toBe(true);
    expect(result.analysis).toEqual(ANALYSIS);
    // Critical: still 2 — no new Gemini fetches.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(mediaFetcher).toHaveBeenCalledTimes(2);
  });

  it("URL rotation does not invalidate cache (hash is over bytes, not URL)", async () => {
    const fetchSpy = makeStubFetch();
    const visionClient = new VisionClient(
      "test-key",
      fetchSpy as unknown as typeof fetch,
    );
    const visionCache = makeInMemoryCache();
    // Same bytes via two different URLs
    const bytes = new Uint8Array([0x01, 0x02, 0x03]);
    const mediaFetcher = vi.fn(async (_url: string) => ({
      bytes,
      mimeType: "video/mp4",
    }));

    const visionExecutor = new VisionToolExecutor({
      visionClient,
      visionCache,
      mediaFetcher,
    });
    const { executor } = createAgentPipeline(
      async (name, input, ctx) =>
        visionExecutor.execute(name, input, ctx ?? { agentType: "vision", taskId: "t" }),
      visionToolDefinitions,
      "vision",
    );

    await executor("analyze_video", { video_url: "https://r2.example/x?sig=A" });
    const secondWrapped = (await executor("analyze_video", {
      video_url: "https://r2.example/x?sig=B-rotated",
    })) as { success: boolean; data?: { cacheHit: boolean } };
    expect(secondWrapped.success).toBe(true);
    const second = secondWrapped.data!;

    expect(second.cacheHit).toBe(true);
    // Gemini hit only once across both calls.
    expect(fetchSpy).toHaveBeenCalledTimes(2); // upload + analyze (first call only)
  });

  it("ToolPipeline rejects analyze_video from a non-vision agent", async () => {
    const fetchSpy = makeStubFetch();
    const visionClient = new VisionClient(
      "test-key",
      fetchSpy as unknown as typeof fetch,
    );
    const visionCache = makeInMemoryCache();
    const mediaFetcher = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      mimeType: "video/mp4",
    }));

    const visionExecutor = new VisionToolExecutor({
      visionClient,
      visionCache,
      mediaFetcher,
    });
    // Build the pipeline with agentType: "editor" — the tool definitions
    // restrict to "vision" so the pipeline must refuse.
    const { executor } = createAgentPipeline(
      async (name, input, ctx) =>
        visionExecutor.execute(name, input, ctx ?? { agentType: "editor", taskId: "t" }),
      visionToolDefinitions,
      "editor",
    );

    const result = await executor("analyze_video", {
      video_url: "https://r2.example/x.mp4",
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/not authorized/) });
    // Gemini never touched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mediaFetcher).not.toHaveBeenCalled();
  });
});
