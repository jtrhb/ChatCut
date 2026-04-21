/**
 * VisionToolExecutor (Phase 5a chunk 2).
 *
 * Wires the three vision tool definitions to real implementations:
 *   analyze_video  → fetch video → hash → cache check → Files API
 *                    upload → generateContent → cache set → return
 *   locate_scene   → pure filter over a previously-computed VideoAnalysis
 *                    passed in via `context`
 *   describe_frame → stub (returns a clear "not yet wired" error;
 *                    requires per-frame extraction infra that's a
 *                    Phase 5a follow-up — see TODO inline)
 *
 * Mirrors the AssetToolExecutor pattern (one class extending
 * `ToolExecutor`, deps in the constructor, `executeImpl` switch).
 *
 * Cache semantics: only canonical (no-focus) analyses are cached so
 * focus-narrowed responses don't poison the canonical entry.
 * `mediaHash` is the SHA-256 of the actual fetched bytes — robust
 * against URL changes (signed URLs, CDN paths) for the same content.
 */

import { ToolExecutor } from "./executor.js";
import { visionToolDefinitions } from "./vision-tools.js";
import type { ToolCallResult, ToolContext } from "./types.js";
import {
  SCHEMA_VERSION,
  type VideoAnalysis,
  type VisionClient,
  type VisionProgressCallback,
} from "../services/vision-client.js";
import type { VisionCache } from "../services/vision-cache.js";

export interface VisionToolDeps {
  visionClient: VisionClient;
  visionCache: VisionCache;
  /**
   * Injectable for tests; defaults to global fetch. Returns the raw
   * video bytes + the upstream Content-Type so the Files API upload
   * can declare the correct MIME.
   */
  mediaFetcher?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}

const DEFAULT_MIME = "video/mp4";

async function defaultMediaFetcher(
  url: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `media fetch failed (${response.status}): ${response.statusText}`,
    );
  }
  const buf = await response.arrayBuffer();
  const mimeType = response.headers.get("content-type") ?? DEFAULT_MIME;
  return { bytes: new Uint8Array(buf), mimeType };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class VisionToolExecutor extends ToolExecutor {
  private visionClient: VisionClient;
  private visionCache: VisionCache;
  private mediaFetcher: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; mimeType: string }>;

  constructor(deps: VisionToolDeps) {
    super();
    this.visionClient = deps.visionClient;
    this.visionCache = deps.visionCache;
    this.mediaFetcher = deps.mediaFetcher ?? defaultMediaFetcher;
    for (const def of visionToolDefinitions) {
      this.register(def);
    }
  }

  protected async executeImpl(
    toolName: string,
    input: unknown,
    _context: ToolContext,
  ): Promise<ToolCallResult> {
    try {
      switch (toolName) {
        case "analyze_video":
          return await this._analyzeVideo(
            input as { video_url: string; focus?: string },
          );
        case "locate_scene":
          return this._locateScene(
            input as { query: string; context?: Record<string, unknown> },
          );
        case "describe_frame":
          return this._describeFrame(input as { time: number });
        default:
          return { success: false, error: `Unhandled vision tool: "${toolName}"` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── analyze_video ────────────────────────────────────────────────────

  private async _analyzeVideo(input: {
    video_url: string;
    focus?: string;
    onProgress?: VisionProgressCallback;
  }): Promise<ToolCallResult> {
    const { video_url: videoUrl, focus } = input;

    // 1. Fetch + hash. Hashing the bytes (not the URL) makes the cache
    //    survive signed-URL rotation and CDN path changes for the same
    //    underlying content.
    const { bytes, mimeType } = await this.mediaFetcher(videoUrl);
    const mediaHash = await sha256Hex(bytes);

    // 2. Cache check (canonical / no-focus only — focus-narrowed
    //    responses bypass the cache to avoid poisoning the canonical
    //    entry, mirroring vision-cache.ts:set semantics).
    if (!focus) {
      const cached = await this.visionCache.get(mediaHash, SCHEMA_VERSION);
      if (cached) {
        return { success: true, data: { analysis: cached, cacheHit: true } };
      }
    }

    // 3. Upload to Gemini Files API (cache miss, or focus-narrowed
    //    request). Files auto-delete after 48h on Gemini's side; our
    //    cache is the durable record.
    const uploaded = await this.visionClient.uploadVideo(bytes, mimeType);

    // 4. Analyze.
    const analysis = await this.visionClient.analyzeVideo(
      uploaded.fileUri,
      uploaded.mimeType,
      focus,
    );

    // 5. Cache (no-op when focus is set, per vision-cache.ts).
    await this.visionCache.set(mediaHash, SCHEMA_VERSION, analysis, focus);

    return { success: true, data: { analysis, cacheHit: false } };
  }

  // ── locate_scene ─────────────────────────────────────────────────────

  private _locateScene(input: {
    query: string;
    context?: Record<string, unknown>;
  }): ToolCallResult {
    // Caller threads a previously-computed VideoAnalysis through the
    // `context` field. No Gemini call here — pure JS filter via the
    // client's locateScene helper. If no analysis is in context, return
    // a clear actionable error so the agent can call analyze_video
    // first instead of silently returning empty results.
    const analysis = input.context?.analysis as VideoAnalysis | undefined;
    if (!analysis || !Array.isArray(analysis.scenes)) {
      return {
        success: false,
        error:
          "locate_scene needs a previously-computed VideoAnalysis in context.analysis — call analyze_video first",
      };
    }
    const matches = this.visionClient.locateScene(input.query, analysis);
    return { success: true, data: { matches } };
  }

  // ── describe_frame ───────────────────────────────────────────────────

  private _describeFrame(_input: { time: number }): ToolCallResult {
    // Phase 5a follow-up: needs per-frame extraction infra (ffmpeg →
    // image bytes → Gemini inline_data) plus a way to know which
    // project media the timeline frame belongs to. Stubbed clearly so
    // the model gets actionable signal instead of silent mis-behaviour.
    return {
      success: false,
      error:
        "describe_frame is not yet wired (Phase 5a follow-up — needs frame extraction + project media lookup). Use analyze_video for whole-video understanding.",
    };
  }
}
