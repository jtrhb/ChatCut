import { describe, it, expect, vi } from "vitest";
import { VisionToolExecutor } from "../vision-tool-executor.js";
import {
  SCHEMA_VERSION,
  type VideoAnalysis,
  type VisionClient,
} from "../../services/vision-client.js";
import type { VisionCache } from "../../services/vision-cache.js";
import type { ToolContext } from "../types.js";

const ANALYSIS: VideoAnalysis = {
  scenes: [
    { start: 0, end: 5, description: "beach", objects: ["sand"] },
    { start: 5, end: 10, description: "ocean waves", objects: ["water"] },
  ],
  characters: ["surfer"],
  mood: "calm",
  style: "documentary",
};

function fakeClient(opts?: {
  uploadResult?: { fileUri: string; mimeType: string; name: string };
  uploadThrows?: Error;
  analyzeResult?: VideoAnalysis;
  analyzeThrows?: Error;
}): {
  client: VisionClient;
  uploadSpy: ReturnType<typeof vi.fn>;
  analyzeSpy: ReturnType<typeof vi.fn>;
} {
  const uploadSpy = vi.fn(async () => {
    if (opts?.uploadThrows) throw opts.uploadThrows;
    return (
      opts?.uploadResult ?? {
        fileUri: "https://gemini.example/files/x",
        mimeType: "video/mp4",
        name: "files/x",
      }
    );
  });
  const analyzeSpy = vi.fn(async () => {
    if (opts?.analyzeThrows) throw opts.analyzeThrows;
    return opts?.analyzeResult ?? ANALYSIS;
  });
  const client = {
    uploadVideo: uploadSpy,
    analyzeVideo: analyzeSpy,
    locateScene: (q: string, a: VideoAnalysis) =>
      a.scenes
        .filter((s) => s.description.includes(q))
        .map(({ start, end, description }) => ({ start, end, description })),
  } as unknown as VisionClient;
  return { client, uploadSpy, analyzeSpy };
}

function fakeCache(initial?: VideoAnalysis): {
  cache: VisionCache;
  getSpy: ReturnType<typeof vi.fn>;
  setSpy: ReturnType<typeof vi.fn>;
} {
  let stored = initial ?? null;
  const getSpy = vi.fn(async () => stored);
  const setSpy = vi.fn(async (_h, _v, a, focus) => {
    if (!focus) stored = a;
  });
  const cache = {
    get: getSpy,
    set: setSpy,
    invalidate: vi.fn(),
  } as unknown as VisionCache;
  return { cache, getSpy, setSpy };
}

function fakeFetcher(bytes: Uint8Array, mimeType = "video/mp4") {
  return vi.fn(async (_url: string) => ({ bytes, mimeType }));
}

const CTX: ToolContext = { agentType: "vision", taskId: "t-1" };

describe("VisionToolExecutor", () => {
  // ── analyze_video ────────────────────────────────────────────────────

  describe("analyze_video", () => {
    it("happy path: fetch → upload → analyze → cache → return analysis", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const fetcher = fakeFetcher(bytes);
      const { client, uploadSpy, analyzeSpy } = fakeClient();
      const { cache, setSpy } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });

      const result = await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/clip.mp4" },
        CTX,
      );

      expect(result.success).toBe(true);
      expect(fetcher).toHaveBeenCalledWith("https://r2.example/clip.mp4");
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(analyzeSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledTimes(1);
      const data = result.data as { analysis: VideoAnalysis; cacheHit: boolean };
      expect(data.analysis).toEqual(ANALYSIS);
      expect(data.cacheHit).toBe(false);
    });

    it("cache hit: skip Gemini calls entirely", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const fetcher = fakeFetcher(bytes);
      const { client, uploadSpy, analyzeSpy } = fakeClient();
      const { cache, setSpy } = fakeCache(ANALYSIS);
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });

      const result = await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/clip.mp4" },
        CTX,
      );

      expect(result.success).toBe(true);
      const data = result.data as { analysis: VideoAnalysis; cacheHit: boolean };
      expect(data.cacheHit).toBe(true);
      expect(data.analysis).toEqual(ANALYSIS);
      // Critical: NO upload + NO analyze on cache hit.
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    });

    it("focus-narrowed request bypasses cache (read AND write)", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const fetcher = fakeFetcher(bytes);
      const { client, uploadSpy, analyzeSpy } = fakeClient();
      const { cache, getSpy, setSpy } = fakeCache(ANALYSIS);
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });

      await exec.execute(
        "analyze_video",
        {
          video_url: "https://r2.example/clip.mp4",
          focus: "action sequences",
        },
        CTX,
      );

      // Cache read SKIPPED for focus-narrowed (mirrors set-skips-focus
      // semantics — focus responses can't trust canonical cache).
      expect(getSpy).not.toHaveBeenCalled();
      // Real Gemini calls fire. Phase 5a HIGH-1: analyze receives a
      // 4th onProgress arg (undefined here — no pipeline-side
      // onProgress was supplied to the executor).
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(analyzeSpy).toHaveBeenCalledWith(
        expect.any(String),
        "video/mp4",
        "action sequences",
        undefined,
      );
      // VisionCache.set is called (focus arg passed) but the cache impl
      // itself no-ops on focus — that's vision-cache.ts's contract,
      // tested separately.
      expect(setSpy).toHaveBeenCalled();
    });

    it("uses SHA-256 of bytes for the cache key (URL-independent)", async () => {
      const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
      const fetcher = fakeFetcher(bytes);
      const { client } = fakeClient();
      const { cache, getSpy } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });

      await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/clip.mp4?sig=ROTATE-1" },
        CTX,
      );
      await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/clip.mp4?sig=ROTATE-2" },
        CTX,
      );

      // Same bytes, different URLs → same mediaHash → both call get
      // with the SAME hash.
      expect(getSpy).toHaveBeenCalledTimes(2);
      const hash1 = getSpy.mock.calls[0]![0];
      const hash2 = getSpy.mock.calls[1]![0];
      expect(hash1).toBe(hash2);
    });

    it("passes SCHEMA_VERSION to cache.get + cache.set", async () => {
      const bytes = new Uint8Array([1]);
      const { client } = fakeClient();
      const { cache, getSpy, setSpy } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(bytes),
      });
      await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/x.mp4" },
        CTX,
      );
      expect(getSpy).toHaveBeenCalledWith(expect.any(String), SCHEMA_VERSION);
      expect(setSpy).toHaveBeenCalledWith(
        expect.any(String),
        SCHEMA_VERSION,
        ANALYSIS,
        undefined,
      );
    });

    it("propagates upstream MIME type from media fetcher to upload", async () => {
      const bytes = new Uint8Array([1, 2]);
      const fetcher = fakeFetcher(bytes, "video/quicktime");
      const { client, uploadSpy } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });
      await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/clip.mov" },
        CTX,
      );
      expect(uploadSpy).toHaveBeenCalledWith(bytes, "video/quicktime");
    });

    it("returns success:false when fetch fails", async () => {
      const fetcher = vi.fn(async () => {
        throw new Error("404 not found");
      });
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });
      const result = await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/missing.mp4" },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("404 not found");
    });

    it("returns success:false when upload fails", async () => {
      const { client } = fakeClient({ uploadThrows: new Error("file too large") });
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/x.mp4" },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("file too large");
    });

    it("returns success:false when analyze fails", async () => {
      const { client } = fakeClient({ analyzeThrows: new Error("model overloaded") });
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/x.mp4" },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("model overloaded");
    });

    // Phase 5a HIGH-1: onProgress threading from pipeline → executor → client.
    it("threads onProgress through to VisionClient.analyzeVideo (HIGH-1 fix)", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const fetcher = fakeFetcher(bytes);
      const { client, analyzeSpy } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });

      const onProgress = vi.fn();
      await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/x.mp4" },
        CTX,
        onProgress,
      );

      // analyzeVideo received a 4th arg that is a function (the
      // VisionProgressUpdate adapter), not undefined.
      expect(analyzeSpy).toHaveBeenCalledTimes(1);
      const callArgs = analyzeSpy.mock.calls[0]!;
      expect(typeof callArgs[3]).toBe("function");
    });

    it("threaded progress adapter forwards to onProgress as ToolProgressEvent", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const fetcher = fakeFetcher(bytes);
      // Custom client whose analyzeVideo invokes its 4th-arg progress
      // callback so we can verify the adapter shape.
      const analyzeSpy = vi.fn(
        async (_uri, _mime, _focus, onProg) => {
          onProg?.({ step: 50, totalSteps: 100, text: "halfway" });
          return ANALYSIS;
        },
      );
      const client = {
        uploadVideo: vi.fn(async () => ({
          fileUri: "u",
          mimeType: "video/mp4",
          name: "files/x",
        })),
        analyzeVideo: analyzeSpy,
        locateScene: () => [],
      } as unknown as VisionClient;
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fetcher,
      });

      const events: any[] = [];
      const onProgress = vi.fn((e) => events.push(e));
      await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/x.mp4" },
        CTX,
        onProgress,
      );

      expect(events.length).toBe(1);
      // The adapter wraps the simple {step, totalSteps, text} shape into
      // a full ToolProgressEvent. toolName/toolCallId are placeholders
      // because the pipeline (tool-pipeline.ts:289-310) overrides them
      // from the surrounding ctx.
      expect(events[0]).toMatchObject({
        type: "tool.progress",
        step: 50,
        totalSteps: 100,
        text: "halfway",
      });
    });

    // Phase 5a MED-1: SSRF guard on the default media fetcher.
    it("default mediaFetcher rejects localhost URLs (SSRF guard)", async () => {
      // Construct an executor with the default fetcher (no override).
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        // NB: no mediaFetcher override — exercises defaultMediaFetcher.
      });
      const result = await exec.execute(
        "analyze_video",
        { video_url: "http://localhost:8080/internal" },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/blocked host|private network/);
    });

    it("default mediaFetcher rejects RFC1918 private IPs (SSRF guard)", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
      });
      const result = await exec.execute(
        "analyze_video",
        { video_url: "http://10.0.0.1/internal" },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private network/);
    });

    it("default mediaFetcher rejects non-http(s) protocols", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
      });
      const result = await exec.execute(
        "analyze_video",
        { video_url: "file:///etc/passwd" },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/protocol .* not allowed/);
    });

    // Phase 5a MED-4: runtime shape guard for context.analysis.
    it("rejects locate_scene when context.analysis has malformed scenes", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute(
        "locate_scene",
        {
          query: "beach",
          // Hallucinated shape — `description` is a number, not a string.
          context: { analysis: { scenes: [{ description: 42, start: 0, end: 1 }] } },
        },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("call analyze_video first");
    });

    it("rejects calls from non-vision agents (ToolExecutor permission check)", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute(
        "analyze_video",
        { video_url: "https://r2.example/x.mp4" },
        { agentType: "editor", taskId: "t-2" },
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not authorized/);
    });
  });

  // ── locate_scene ─────────────────────────────────────────────────────

  describe("locate_scene", () => {
    it("filters scenes from the analysis in context", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute(
        "locate_scene",
        { query: "beach", context: { analysis: ANALYSIS } },
        CTX,
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        matches: Array<{ start: number; end: number; description: string }>;
      };
      expect(data.matches).toHaveLength(1);
      expect(data.matches[0].description).toBe("beach");
    });

    it("returns clear actionable error when no analysis in context", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute(
        "locate_scene",
        { query: "beach" },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("call analyze_video first");
    });
  });

  // ── describe_frame (stubbed for 5a follow-up) ────────────────────────

  describe("describe_frame", () => {
    it("returns a clear LLM-actionable fallback error (NIT-2)", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute("describe_frame", { time: 5 }, CTX);
      expect(result.success).toBe(false);
      // Message tells the model exactly what to do instead of a vague
      // "not implemented" string.
      expect(result.error).toContain("describe_frame is unavailable");
      expect(result.error).toContain("Fall back to analyze_video");
    });
  });

  // ── tool registration ───────────────────────────────────────────────

  it("registers all three vision tools", () => {
    const { client } = fakeClient();
    const { cache } = fakeCache();
    const exec = new VisionToolExecutor({
      visionClient: client,
      visionCache: cache,
      mediaFetcher: fakeFetcher(new Uint8Array([1])),
    });
    expect(exec.hasToolName("analyze_video")).toBe(true);
    expect(exec.hasToolName("locate_scene")).toBe(true);
    expect(exec.hasToolName("describe_frame")).toBe(true);
    expect(exec.hasToolName("nonexistent")).toBe(false);
  });
});
