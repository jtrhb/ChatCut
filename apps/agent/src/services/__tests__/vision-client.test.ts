import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global fetch before importing VisionClient
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { VisionClient } from "../vision-client.js";
import type { VideoAnalysis } from "../vision-client.js";

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

describe("VisionClient", () => {
  let client: VisionClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new VisionClient(API_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("analyzeVideo()", () => {
    it("returns structured VideoAnalysis from Gemini response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });

      const result = await client.analyzeVideo("https://example.com/video.mp4");

      expect(result).toEqual(MOCK_ANALYSIS);
    });

    it("calls the correct Gemini endpoint with the API key", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });

      await client.analyzeVideo("https://example.com/video.mp4");

      expect(mockFetch).toHaveBeenCalledWith(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${API_KEY}`,
        expect.any(Object)
      );
    });

    it("includes the video URL in the prompt", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });

      const videoUrl = "https://example.com/my-video.mp4";
      await client.analyzeVideo(videoUrl);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      const promptText = body.contents[0].parts[0].text as string;
      expect(promptText).toContain(videoUrl);
    });

    it("includes focus in the prompt when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });

      await client.analyzeVideo("https://example.com/video.mp4", "action sequences");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      const promptText = body.contents[0].parts[0].text as string;
      expect(promptText).toContain("action sequences");
    });

    it("does NOT include focus text in the prompt when focus is not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });

      await client.analyzeVideo("https://example.com/video.mp4");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      const promptText = body.contents[0].parts[0].text as string;
      // Should not have a "Focus on:" section when no focus provided
      expect(promptText).not.toContain("Focus on:");
    });

    // Audit Phase 4 / tool-evolution §6 acceptance test #3:
    // analyze_video must emit at least 2 tool.progress events per call.
    it("emits at least 2 progress events for one call (Phase 4 acceptance)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      const events: Array<{ step: number; totalSteps?: number; text?: string }> = [];

      await client.analyzeVideo("https://example.com/video.mp4", undefined, (e) => events.push(e));

      expect(events.length).toBeGreaterThanOrEqual(2);
      // Steps are monotonic
      for (let i = 1; i < events.length; i++) {
        expect(events[i].step).toBeGreaterThanOrEqual(events[i - 1].step);
      }
      // Text descriptions are non-empty
      for (const e of events) expect(e.text).toBeTruthy();
    });

    it("does not throw when no onProgress callback is provided (back-compat)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(MOCK_ANALYSIS),
      });
      // No third arg — must not throw, must still return analysis.
      const result = await client.analyzeVideo("https://example.com/video.mp4");
      expect(result).toEqual(MOCK_ANALYSIS);
    });

    it("parses the JSON from candidates[0].content.parts[0].text", async () => {
      const customAnalysis: VideoAnalysis = {
        scenes: [{ start: 1, end: 3, description: "forest path", objects: ["trees"] }],
        characters: ["hiker"],
        mood: "serene",
        style: "nature",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeGeminiResponse(customAnalysis),
      });

      const result = await client.analyzeVideo("https://example.com/forest.mp4");
      expect(result.scenes[0].description).toBe("forest path");
      expect(result.mood).toBe("serene");
    });
  });

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
