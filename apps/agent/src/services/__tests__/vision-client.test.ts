import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  SCHEMA_VERSION,
  VisionClient,
  type VideoAnalysis,
} from "../vision-client.js";

const API_KEY = "test-gemini-api-key";

const MOCK_ANALYSIS: VideoAnalysis = {
  scenes: [
    { start: 0, end: 5, description: "A sunny beach with waves", objects: ["beach", "waves", "sky"] },
    { start: 5, end: 12, description: "Close-up of a red sunset", objects: ["sun", "clouds", "horizon"] },
  ],
  characters: ["surfer", "child"],
  mood: "peaceful",
  style: "documentary",
};

function makeGeminiResponse(analysis: VideoAnalysis) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(analysis) }],
        },
      },
    ],
  };
}

function makeFilesUploadResponse() {
  return {
    file: {
      uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123",
      mimeType: "video/mp4",
      name: "files/abc-123",
    },
  };
}

describe("VisionClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: VisionClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new VisionClient(API_KEY, mockFetch as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── SCHEMA_VERSION ────────────────────────────────────────────────────

  describe("SCHEMA_VERSION", () => {
    it("exports an integer that VisionCache can use as a key component", () => {
      expect(typeof SCHEMA_VERSION).toBe("number");
      expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    });
  });

  // ── uploadVideo (Files API multipart) ─────────────────────────────────

  describe("uploadVideo()", () => {
    it("POSTs multipart to the Files API endpoint with x-goog-api-key header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeFilesUploadResponse(),
      });
      const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const result = await client.uploadVideo(bytes, "video/mp4", "test.mp4");

      expect(result).toEqual({
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123",
        mimeType: "video/mp4",
        name: "files/abc-123",
      });
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toContain(
        "/upload/v1beta/files?uploadType=multipart",
      );
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe(API_KEY);
      expect(headers["Content-Type"]).toContain("multipart/related; boundary=");
    });

    it("encodes display name in the multipart metadata", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeFilesUploadResponse(),
      });
      await client.uploadVideo(Buffer.from([0]), "video/mp4", "my-clip.mp4");
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const bodyString = (init.body as Buffer).toString("utf8");
      expect(bodyString).toContain('"display_name":"my-clip.mp4"');
    });

    it("works without display name (omits the field)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeFilesUploadResponse(),
      });
      await client.uploadVideo(Buffer.from([0]), "video/mp4");
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const bodyString = (init.body as Buffer).toString("utf8");
      expect(bodyString).not.toContain("display_name");
    });

    it("throws on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 413,
        text: async () => "file too large",
      });
      await expect(
        client.uploadVideo(Buffer.from([0]), "video/mp4"),
      ).rejects.toThrow(/Gemini Files upload failed \(413\)/);
    });

    it("throws on malformed response (missing uri/mimeType/name)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ file: { uri: "x" } }),
      });
      await expect(
        client.uploadVideo(Buffer.from([0]), "video/mp4"),
      ).rejects.toThrow(/malformed response/);
    });

    it("passes an AbortSignal so timeouts are wired", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeFilesUploadResponse(),
      });
      await client.uploadVideo(Buffer.from([0]), "video/mp4");
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── analyzeVideo (uses file_data, not URL-in-prompt) ──────────────────

  describe("analyzeVideo()", () => {
    const FILE_URI = "https://generativelanguage.googleapis.com/v1beta/files/x";

    it("returns structured VideoAnalysis from Gemini response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      const result = await client.analyzeVideo(FILE_URI, "video/mp4");
      expect(result).toEqual(MOCK_ANALYSIS);
    });

    it("calls generateContent with x-goog-api-key header (NOT URL key)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      await client.analyzeVideo(FILE_URI, "video/mp4");
      const [url, init] = mockFetch.mock.calls[0]!;
      // URL must NOT carry ?key=...
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      );
      expect(url).not.toContain("?key=");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe(API_KEY);
    });

    it("sends file_data part referencing the uploaded fileUri", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      await client.analyzeVideo(FILE_URI, "video/mp4");
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      const parts = body.contents[0].parts;
      const fileDataPart = parts.find((p: any) => p.file_data);
      expect(fileDataPart).toBeDefined();
      expect(fileDataPart.file_data).toEqual({
        file_uri: FILE_URI,
        mime_type: "video/mp4",
      });
    });

    it("does NOT put the file URI inside the prompt text", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      await client.analyzeVideo(FILE_URI, "video/mp4");
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      const textParts = body.contents[0].parts.filter(
        (p: any) => typeof p.text === "string",
      );
      expect(textParts.length).toBeGreaterThan(0);
      // The prompt should reference "the attached video", not a URL
      for (const tp of textParts) {
        expect(tp.text).not.toContain(FILE_URI);
        expect(tp.text).not.toContain("https://");
      }
    });

    it("includes focus in the prompt text when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      await client.analyzeVideo(FILE_URI, "video/mp4", "action sequences");
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      const promptText = body.contents[0].parts.find(
        (p: any) => typeof p.text === "string",
      ).text;
      expect(promptText).toContain("action sequences");
    });

    it("emits at least 2 progress events for one call (Phase 4 acceptance)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      const events: Array<{ step: number; totalSteps?: number; text?: string }> = [];
      await client.analyzeVideo(FILE_URI, "video/mp4", undefined, (e) =>
        events.push(e),
      );
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].step).toBeGreaterThanOrEqual(events[i - 1].step);
      }
      for (const e of events) expect(e.text).toBeTruthy();
    });

    it("does not throw when no onProgress callback is provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      const result = await client.analyzeVideo(FILE_URI, "video/mp4");
      expect(result).toEqual(MOCK_ANALYSIS);
    });

    it("swallows onProgress errors (best-effort emission)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      const onProgress = vi.fn(() => {
        throw new Error("sse disconnected");
      });
      const result = await client.analyzeVideo(FILE_URI, "video/mp4", undefined, onProgress);
      expect(result).toEqual(MOCK_ANALYSIS);
      expect(onProgress).toHaveBeenCalled();
    });

    it("throws on non-OK Gemini response with body snippet", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "model overloaded",
      });
      await expect(
        client.analyzeVideo(FILE_URI, "video/mp4"),
      ).rejects.toThrow(/500.*model overloaded/);
    });

    it("throws when Gemini returns no candidates (safety filter)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [] }),
      });
      await expect(
        client.analyzeVideo(FILE_URI, "video/mp4"),
      ).rejects.toThrow(/no candidates/);
    });

    it("throws when candidate has no text content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [] } }],
        }),
      });
      await expect(
        client.analyzeVideo(FILE_URI, "video/mp4"),
      ).rejects.toThrow(/no text content/);
    });

    it("throws when response text is not valid JSON", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "not-json" }] } }],
        }),
      });
      await expect(
        client.analyzeVideo(FILE_URI, "video/mp4"),
      ).rejects.toThrow(/Failed to parse/);
    });

    it("passes an AbortSignal so timeouts are wired", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      await client.analyzeVideo(FILE_URI, "video/mp4");
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── locateScene (pure filter) ─────────────────────────────────────────

  describe("locateScene()", () => {
    it("filters scenes by query string (case-insensitive)", () => {
      const result = client.locateScene("beach", MOCK_ANALYSIS);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe("A sunny beach with waves");
    });

    it("is case-insensitive when matching query", () => {
      const result = client.locateScene("SUNSET", MOCK_ANALYSIS);
      expect(result).toHaveLength(1);
      expect(result[0].description).toContain("sunset");
    });

    it("returns multiple matching scenes when more than one matches", () => {
      const analysis: VideoAnalysis = {
        ...MOCK_ANALYSIS,
        scenes: [
          { start: 0, end: 3, description: "ocean waves crashing", objects: ["ocean"] },
          { start: 3, end: 6, description: "ocean at dawn", objects: ["ocean", "sky"] },
          { start: 6, end: 9, description: "mountain trail", objects: ["mountain"] },
        ],
      };
      const result = client.locateScene("ocean", analysis);
      expect(result).toHaveLength(2);
    });

    it("returns empty array when no scenes match the query", () => {
      const result = client.locateScene("spaceship", MOCK_ANALYSIS);
      expect(result).toHaveLength(0);
    });

    it("returns only start, end, description fields (not objects)", () => {
      const result = client.locateScene("beach", MOCK_ANALYSIS);
      expect(result[0]).toEqual({
        start: 0,
        end: 5,
        description: "A sunny beach with waves",
      });
      expect(result[0]).not.toHaveProperty("objects");
    });
  });
});
