import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GpuServiceClient,
  GpuServiceError,
} from "../gpu-service-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GpuServiceClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: GpuServiceClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new GpuServiceClient({
      baseUrl: "https://gpu.example.com/",
      apiKey: "secret",
      fetch: fetchMock as any,
    });
  });

  // --- baseUrl normalization ---

  it("trims trailing slashes from baseUrl", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { jobId: "j1" }));
    await client.enqueueRender({
      explorationId: "e",
      candidateId: "c",
      snapshotStorageKey: "explorations/e/snap.json",
    });
    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe("https://gpu.example.com/render_preview");
    expect(url).not.toContain("//render_preview");
  });

  // --- enqueueRender ---

  describe("enqueueRender", () => {
    it("POSTs to /render_preview with snapshot key + auth header", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { jobId: "j-123" }));
      const result = await client.enqueueRender({
        explorationId: "exp1",
        candidateId: "cand1",
        snapshotStorageKey: "explorations/exp1/abc.json",
      });
      expect(result).toEqual({ jobId: "j-123" });
      const [url, opts] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://gpu.example.com/render_preview");
      expect(opts.method).toBe("POST");
      expect(opts.headers["X-API-Key"]).toBe("secret");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        explorationId: "exp1",
        candidateId: "cand1",
        snapshotStorageKey: "explorations/exp1/abc.json",
      });
    });

    it("throws GpuServiceError(401) when auth fails", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { detail: "invalid X-API-Key" }),
      );
      await expect(
        client.enqueueRender({
          explorationId: "e",
          candidateId: "c",
          snapshotStorageKey: "explorations/e/abc.json",
        }),
      ).rejects.toMatchObject({
        status: 401,
        message: "invalid X-API-Key",
      });
    });

    it("throws GpuServiceError(400) on validation failure with string detail", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { detail: "missing required field: snapshotStorageKey" }),
      );
      await expect(
        client.enqueueRender({
          explorationId: "e",
          candidateId: "c",
          snapshotStorageKey: "",
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: "missing required field: snapshotStorageKey",
      });
    });
  });

  // --- getJobStatus ---

  describe("getJobStatus", () => {
    it("GETs /status?job_id with url-encoded jobId + auth header", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          job_id: "j 1",
          state: "running",
          progress: 50,
        }),
      );
      const result = await client.getJobStatus("j 1");
      expect(result.state).toBe("running");
      expect(result.progress).toBe(50);
      const [url, opts] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://gpu.example.com/status?job_id=j%201");
      expect(opts.method).toBe("GET");
      expect(opts.headers["X-API-Key"]).toBe("secret");
    });

    it("returns done state with storage_key on completion", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          job_id: "j1",
          state: "done",
          progress: 100,
          result: { storage_key: "previews/exp/cand.mp4" },
        }),
      );
      const result = await client.getJobStatus("j1");
      expect(result.state).toBe("done");
      expect(result.result?.storage_key).toBe("previews/exp/cand.mp4");
    });

    it("returns failed state with error message", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          job_id: "j1",
          state: "failed",
          progress: 30,
          error: "melt subprocess crashed",
        }),
      );
      const result = await client.getJobStatus("j1");
      expect(result.state).toBe("failed");
      expect(result.error).toBe("melt subprocess crashed");
    });

    it("throws GpuServiceError(404) when jobId unknown", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(404, { detail: "unknown job_id: nope" }),
      );
      await expect(client.getJobStatus("nope")).rejects.toMatchObject({
        status: 404,
        message: "unknown job_id: nope",
      });
    });
  });

  // --- FastAPI detail unwrap (Stage A reviewer LOW carryover; resolved here) ---

  describe("FastAPI detail unwrap (C-Q2)", () => {
    it("unwraps 501 stub body's detail.error and detail.phase", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(501, {
          detail: { error: "not implemented", phase: "5" },
        }),
      );
      try {
        await client.enqueueRender({
          explorationId: "e",
          candidateId: "c",
          snapshotStorageKey: "explorations/e/abc.json",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GpuServiceError);
        const gpuErr = err as GpuServiceError;
        expect(gpuErr.status).toBe(501);
        expect(gpuErr.message).toBe("not implemented");
        expect(gpuErr.phase).toBe("5");
        expect(gpuErr.detail).toEqual({ error: "not implemented", phase: "5" });
      }
    });

    it("falls back to generic message when 5xx body is non-JSON", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("Internal Server Error (gateway)", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
      );
      try {
        await client.getJobStatus("j1");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GpuServiceError);
        expect((err as GpuServiceError).status).toBe(500);
        // Plain-text body becomes the message via the text() fallback path
        expect((err as GpuServiceError).message).toContain("gateway");
      }
    });

    it("falls back to generic message when JSON has no detail field", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(502, { something: "else" }));
      await expect(client.getJobStatus("j1")).rejects.toMatchObject({
        status: 502,
        message: "status failed (HTTP 502)",
      });
    });

    it("preserves detail object on the error for inspection", async () => {
      const detail = { error: "boom", phase: "5", extra: { trace: "abc" } };
      fetchMock.mockResolvedValueOnce(jsonResponse(503, { detail }));
      try {
        await client.getJobStatus("j1");
        expect.unreachable();
      } catch (err) {
        expect((err as GpuServiceError).detail).toEqual(detail);
      }
    });
  });

  // --- network errors propagate untouched ---

  it("propagates network errors from fetch", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.getJobStatus("j1")).rejects.toThrow("fetch failed");
  });
});
