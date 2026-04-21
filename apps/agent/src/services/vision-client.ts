/**
 * Gemini Vision client (Phase 5a).
 *
 * Two endpoints are wrapped:
 *   1. Files API multipart upload — uploads the actual video bytes so
 *      Gemini can analyze them (the pre-Phase-5a code put the URL in a
 *      text prompt, which Gemini reads as text and either refuses or
 *      hallucinates an analysis — a fundamental bug closed here).
 *   2. generateContent — analyzes the uploaded file via `file_data`
 *      reference, returns structured VideoAnalysis JSON.
 *
 * Auth: `x-goog-api-key` header (the pre-Phase-5a code put the key in
 * the URL query string, which leaks via referrer/logs/history — fixed
 * here). Timeouts: 180s upload, 120s analyze, both via AbortController.
 *
 * Schema versioning: bump `SCHEMA_VERSION` when the `VideoAnalysis`
 * shape changes (add/remove field). Prompt-text tweaks DO NOT bump —
 * those land via the next mediaHash mismatch (5a-Q2 confirmed).
 */

const API_BASE = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-2.5-pro";

const UPLOAD_TIMEOUT_MS = 180_000;
const ANALYZE_TIMEOUT_MS = 120_000;

/** Bump only on `VideoAnalysis` shape changes (5a-Q2). */
export const SCHEMA_VERSION = 1;

export interface VideoAnalysis {
  scenes: Array<{ start: number; end: number; description: string; objects: string[] }>;
  characters: string[];
  mood: string;
  style: string;
}

export interface UploadedFile {
  /** Files API URI passed back as `file_data.file_uri` in generateContent. */
  fileUri: string;
  /** MIME type Gemini stored the file as. */
  mimeType: string;
  /** Resource name like `files/abc123` — useful for explicit deletion. */
  name: string;
}

export type VisionProgressUpdate = { step: number; totalSteps?: number; text?: string };
export type VisionProgressCallback = (update: VisionProgressUpdate) => void;

function safeProgress(cb: VisionProgressCallback | undefined, u: VisionProgressUpdate): void {
  if (!cb) return;
  try {
    cb(u);
  } catch {
    /* best-effort */
  }
}

export class VisionClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Upload a video to Gemini's Files API via simple multipart upload.
   * Files auto-delete after 48h on Gemini's side; the caller's cache
   * (VisionCache) is the canonical record across that window.
   *
   * Returns a `fileUri` that `analyzeVideo` accepts as input.
   */
  async uploadVideo(
    bytes: Uint8Array | Buffer,
    mimeType: string,
    displayName?: string,
  ): Promise<UploadedFile> {
    const boundary = `chatcut_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({
      file: displayName ? { display_name: displayName } : {},
    });

    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([head, Buffer.from(bytes), tail]);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${API_BASE}/upload/v1beta/files?uploadType=multipart`,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "x-goog-api-key": this.apiKey,
          },
          body,
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Gemini Files upload failed (${response.status}): ${text.slice(0, 200)}`,
        );
      }
      const data = (await response.json()) as {
        file?: { uri?: string; mimeType?: string; name?: string };
      };
      const file = data.file;
      if (!file?.uri || !file.mimeType || !file.name) {
        throw new Error(
          "Gemini Files upload returned malformed response (missing uri/mimeType/name)",
        );
      }
      return { fileUri: file.uri, mimeType: file.mimeType, name: file.name };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Analyze a previously-uploaded video. Pass the `fileUri` returned
   * by `uploadVideo`. Returns structured `VideoAnalysis`.
   *
   * Progress emission (3 steps) flows to the tool-pipeline EventBus →
   * SSE → web. Errors thrown by the callback are swallowed so a faulty
   * sink can never abort an analysis that's already in flight.
   */
  async analyzeVideo(
    fileUri: string,
    mimeType: string,
    focus?: string,
    onProgress?: VisionProgressCallback,
  ): Promise<VideoAnalysis> {
    const focusLine = focus ? `\nFocus on: ${focus}` : "";
    const prompt = `Analyze the attached video and return a JSON object with this exact structure:
{
  "scenes": [{ "start": <number>, "end": <number>, "description": "<string>", "objects": ["<string>"] }],
  "characters": ["<string>"],
  "mood": "<string>",
  "style": "<string>"
}${focusLine}

Return only valid JSON, no markdown or extra text.`;

    safeProgress(onProgress, {
      step: 1,
      totalSteps: 3,
      text: "Sending analysis request to Gemini",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${API_BASE}/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { file_data: { file_uri: fileUri, mime_type: mimeType } },
                  { text: prompt },
                ],
              },
            ],
          }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Gemini API request failed with status ${response.status}: ${text.slice(0, 200) || response.statusText}`,
      );
    }

    safeProgress(onProgress, {
      step: 2,
      totalSteps: 3,
      text: "Parsing Gemini response",
    });
    const data = (await response.json()) as Record<string, unknown>;

    if (
      !data.candidates ||
      !Array.isArray(data.candidates) ||
      data.candidates.length === 0
    ) {
      throw new Error(
        "Gemini API returned no candidates. The response may have been safety-filtered.",
      );
    }

    const candidate = data.candidates[0] as Record<string, unknown>;
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<{ text?: string }> | undefined;

    if (!parts || parts.length === 0 || typeof parts[0].text !== "string") {
      throw new Error(
        "Gemini API candidate has no text content. The response may have been blocked or empty.",
      );
    }

    const text = parts[0].text;

    try {
      const result = JSON.parse(text) as VideoAnalysis;
      safeProgress(onProgress, {
        step: 3,
        totalSteps: 3,
        text: "Analysis complete",
      });
      return result;
    } catch {
      throw new Error(
        `Failed to parse Gemini response as JSON: ${text.slice(0, 200)}`,
      );
    }
  }

  /**
   * Pure filter over a previously-computed VideoAnalysis. No network call.
   * Used by the `locate_scene` tool when the caller has the analysis in
   * context (cached or re-passed).
   */
  locateScene(
    query: string,
    analysis: VideoAnalysis,
  ): Array<{ start: number; end: number; description: string }> {
    const lowerQuery = query.toLowerCase();
    return analysis.scenes
      .filter((scene) => scene.description.toLowerCase().includes(lowerQuery))
      .map(({ start, end, description }) => ({ start, end, description }));
  }
}
