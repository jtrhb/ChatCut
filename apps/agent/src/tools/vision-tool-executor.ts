/**
 * VisionToolExecutor (Phase 5a chunk 2 + reviewer fixes).
 *
 * Wires the three vision tool definitions to real implementations:
 *   analyze_video  → fetch video → hash → cache check → Files API
 *                    upload → generateContent → cache set → return
 *   locate_scene   → pure filter over a previously-computed VideoAnalysis
 *                    passed in via `context`
 *   describe_frame → stub (returns a clear, LLM-actionable fallback
 *                    instruction; requires per-frame extraction infra
 *                    that's a Phase 5a follow-up)
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
import type { ToolCallResult, ToolContext, ToolProgressEvent } from "./types.js";
import {
  SCHEMA_VERSION,
  type VideoAnalysis,
  type VisionClient,
  type VisionProgressUpdate,
} from "../services/vision-client.js";
import type { VisionCache } from "../services/vision-cache.js";

export interface VisionToolDeps {
  visionClient: VisionClient;
  visionCache: VisionCache;
  /**
   * Injectable for tests; defaults to a built-in fetcher that enforces
   * a 60s timeout (Phase 5a MED-1) and rejects internal/private targets
   * (SSRF guard). Returns the raw video bytes + the upstream
   * Content-Type so the Files API upload can declare the correct MIME.
   */
  mediaFetcher?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}

const DEFAULT_MIME = "video/mp4";

/** R2-side fetch budget. Mirrors chunk 1's Gemini-side timeouts so a
 *  hung CDN can't pin the worker forever (Phase 5a MED-1). */
const MEDIA_FETCH_TIMEOUT_MS = 60_000;

// Phase 5a MED-1 (SSRF guard): the `video_url` parameter accepts an
// arbitrary string from the model. Reject hostnames + IPs that would
// pivot a tool call into the agent's internal network. Mirrors the
// AssetToolExecutor.validateAssetUrl precedent.
const SSRF_BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::",
  "::1",
]);

function assertSafeMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`media url is not a valid URL: ${url.slice(0, 100)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `media url protocol "${parsed.protocol}" not allowed (expected http/https)`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (SSRF_BLOCKED_HOSTNAMES.has(host)) {
    throw new Error(`media url targets a blocked host: ${host}`);
  }
  // RFC1918 + link-local IPv4 ranges + IPv6 unique-local
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80")
  ) {
    throw new Error(`media url targets a private network address: ${host}`);
  }
}

async function defaultMediaFetcher(
  url: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  assertSafeMediaUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `media fetch failed (${response.status}): ${response.statusText}`,
      );
    }
    const buf = await response.arrayBuffer();
    const mimeType = response.headers.get("content-type") ?? DEFAULT_MIME;
    return { bytes: new Uint8Array(buf), mimeType };
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Phase 5a MED-4: Zod's `context: z.record(z.string(), z.unknown())`
 * doesn't narrow shape; a hallucinated `{scenes: [{description: 5}]}`
 * would slip through and crash inside `.toLowerCase()`. This guard
 * verifies the shape `locateScene` actually depends on.
 */
function isVideoAnalysis(value: unknown): value is VideoAnalysis {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.scenes)) return false;
  for (const s of v.scenes) {
    if (!s || typeof s !== "object") return false;
    const scene = s as Record<string, unknown>;
    if (typeof scene.description !== "string") return false;
    if (typeof scene.start !== "number" || typeof scene.end !== "number") {
      return false;
    }
  }
  return true;
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

  // Phase 5a MED-3 (load-bearing try/catch): the parent
  // `ToolExecutor.execute` calls this method but does NOT wrap it in
  // try/catch — see executor.ts:91. Without the inner try/catch, a
  // VisionClient/Files-API rejection would propagate up as an unhandled
  // rejection through the pipeline. Keep this guard.
  protected async executeImpl(
    toolName: string,
    input: unknown,
    _context: ToolContext,
    onProgress?: (event: ToolProgressEvent) => void,
  ): Promise<ToolCallResult> {
    try {
      switch (toolName) {
        case "analyze_video":
          return await this._analyzeVideo(
            input as { video_url: string; focus?: string },
            onProgress,
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

  private async _analyzeVideo(
    input: { video_url: string; focus?: string },
    onProgress?: (event: ToolProgressEvent) => void,
  ): Promise<ToolCallResult> {
    const { video_url: videoUrl, focus } = input;

    // Phase 5a HIGH-1 fix: bridge the pipeline's ToolProgressEvent shape
    // to VisionClient's simpler {step, totalSteps?, text?} shape. The
    // pipeline auto-injects toolName + toolCallId from ctx (see
    // tool-pipeline.ts:289-310), so we leave them as placeholders.
    const visionProgress: ((u: VisionProgressUpdate) => void) | undefined =
      onProgress
        ? (u) =>
            onProgress({
              type: "tool.progress",
              toolName: "analyze_video",
              toolCallId: "",
              step: u.step,
              totalSteps: u.totalSteps,
              text: u.text,
            })
        : undefined;

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

    // 4. Analyze. Threading visionProgress here is the load-bearing
    //    HIGH-1 fix — without it, Phase 4's "≥2 tool.progress per call"
    //    acceptance was passing only at the unit-test level and silent
    //    in production.
    const analysis = await this.visionClient.analyzeVideo(
      uploaded.fileUri,
      uploaded.mimeType,
      focus,
      visionProgress,
    );

    // 5. Cache (no-op when focus is set, per vision-cache.ts).
    //    Phase 5a MED-2 race fix lives in vision-cache.ts via
    //    onConflictDoNothing — concurrent writers don't crash here.
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
    // client's locateScene helper. Phase 5a MED-4: validate the shape
    // at runtime since Zod accepts `z.record(z.unknown())` and a
    // hallucinated payload would crash inside `.toLowerCase()`.
    const candidate = input.context?.analysis;
    if (!isVideoAnalysis(candidate)) {
      return {
        success: false,
        error:
          "locate_scene needs a previously-computed VideoAnalysis in context.analysis (with scenes: Array<{start: number, end: number, description: string, ...}>) — call analyze_video first",
      };
    }
    const matches = this.visionClient.locateScene(input.query, candidate);
    return { success: true, data: { matches } };
  }

  // ── describe_frame ───────────────────────────────────────────────────

  private _describeFrame(_input: { time: number }): ToolCallResult {
    // Phase 5a follow-up: needs per-frame extraction infra (ffmpeg →
    // image bytes → Gemini inline_data) plus a way to know which
    // project media the timeline frame belongs to. Stubbed clearly so
    // the model gets actionable LLM-level instruction, not a generic
    // "not implemented" string (Phase 5a NIT-2).
    return {
      success: false,
      error:
        "describe_frame is unavailable in this build. Fall back to analyze_video for the same media and reference timestamps from the returned scenes array.",
    };
  }
}
