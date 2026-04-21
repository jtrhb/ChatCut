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
      // Real Gemini calls fire.
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(analyzeSpy).toHaveBeenCalledWith(
        expect.any(String),
        "video/mp4",
        "action sequences",
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
    it("returns a clear 'not yet wired' error", async () => {
      const { client } = fakeClient();
      const { cache } = fakeCache();
      const exec = new VisionToolExecutor({
        visionClient: client,
        visionCache: cache,
        mediaFetcher: fakeFetcher(new Uint8Array([1])),
      });
      const result = await exec.execute("describe_frame", { time: 5 }, CTX);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not yet wired");
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
