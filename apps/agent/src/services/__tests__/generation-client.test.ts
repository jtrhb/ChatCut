import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global fetch before importing GenerationClient
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GenerationClient } from "../generation-client.js";

const BASE_URL = "https://creative-engine.example.com";
const API_KEY = "test-api-key-123";

const DEFAULT_CONFIG = { baseUrl: BASE_URL, apiKey: API_KEY };

describe("GenerationClient", () => {
  let client: GenerationClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GenerationClient(DEFAULT_CONFIG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("generateVideo()", () => {
    it("POSTs to correct URL and returns taskId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ taskId: "task-video-001" }),
      });

      const result = await client.generateVideo({
        prompt: "A sunset over the ocean",
        provider: "kling",
        duration: 5,
        idempotencyKey: "idem-001",
      });

      expect(result).toEqual({ taskId: "task-video-001" });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/generate/video`,
        expect.objectContaining({ method: "POST" })
      );
    });

    it("includes prompt, provider, duration, refImage and idempotencyKey in request body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ taskId: "task-video-002" }),
      });

      await client.generateVideo({
        prompt: "Dancing robots",
        provider: "seedance",
        duration: 10,
        refImage: "https://example.com/ref.jpg",
        idempotencyKey: "idem-002",
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.prompt).toBe("Dancing robots");
      expect(body.provider).toBe("seedance");
      expect(body.duration).toBe(10);
      expect(body.refImage).toBe("https://example.com/ref.jpg");
      expect(body.idempotencyKey).toBe("idem-002");
    });

    it("sends Authorization header with API key", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ taskId: "task-video-003" }),
      });

      await client.generateVideo({
        prompt: "Test prompt",
        idempotencyKey: "idem-003",
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${API_KEY}`
      );
    });

    it("throws when response is not ok", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      await expect(
        client.generateVideo({ prompt: "bad", idempotencyKey: "idem-err" })
      ).rejects.toThrow();
    });
  });

  describe("generateImage()", () => {
    it("POSTs to correct URL and returns taskId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ taskId: "task-img-001" }),
      });

      const result = await client.generateImage({
        prompt: "A red apple",
        provider: "dalle",
        dimensions: "1024x1024",
        idempotencyKey: "idem-img-001",
      });

      expect(result).toEqual({ taskId: "task-img-001" });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/generate/image`,
        expect.objectContaining({ method: "POST" })
      );
    });

    it("includes prompt, provider, dimensions and idempotencyKey in request body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ taskId: "task-img-002" }),
      });

      await client.generateImage({
        prompt: "Mountain landscape",
        provider: "stable-diffusion",
        dimensions: "512x512",
        idempotencyKey: "idem-img-002",
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.prompt).toBe("Mountain landscape");
      expect(body.provider).toBe("stable-diffusion");
      expect(body.dimensions).toBe("512x512");
      expect(body.idempotencyKey).toBe("idem-img-002");
    });
  });

  describe("checkStatus()", () => {
    it("GETs the correct URL and returns status object", async () => {
      const mockStatus = {
        status: "processing" as const,
        progress: 42,
        resultUrl: undefined,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockStatus,
      });

      const result = await client.checkStatus("task-abc-123");

      expect(result).toEqual(mockStatus);
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/status/task-abc-123`,
        expect.objectContaining({ method: "GET" })
      );
    });

    it("returns resultUrl when status is completed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "completed",
          progress: 100,
          resultUrl: "https://cdn.example.com/output.mp4",
        }),
      });

      const result = await client.checkStatus("task-done-456");

      expect(result.status).toBe("completed");
      expect(result.resultUrl).toBe("https://cdn.example.com/output.mp4");
    });

    it("includes Authorization header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending", progress: 0 }),
      });

      await client.checkStatus("task-xyz");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${API_KEY}`
      );
    });
  });

  describe("waitForCompletion()", () => {
    it("polls until completed and returns resultUrl", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: "pending", progress: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: "processing", progress: 50 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "completed",
            progress: 100,
            resultUrl: "https://cdn.example.com/result.mp4",
          }),
        });

      const resultUrl = await client.waitForCompletion(
        "task-poll-001",
        5000,
        10
      );

      expect(resultUrl).toBe("https://cdn.example.com/result.mp4");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("throws when status is failed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "failed", progress: 0 }),
      });

      await expect(
        client.waitForCompletion("task-fail-001", 5000, 10)
      ).rejects.toThrow(/failed/i);
    });

    it("throws on timeout when task never completes", async () => {
      // Always return "processing" so it never finishes
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "processing", progress: 10 }),
      });

      await expect(
        client.waitForCompletion("task-timeout-001", 100, 10)
      ).rejects.toThrow(/timeout/i);
    });
  });
});
