import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbeddingClient } from "../embedding-client.js";

describe("EmbeddingClient", () => {
  let client: EmbeddingClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new EmbeddingClient("https://embed.test", "test-key");
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("embed() returns 768-dim vector", async () => {
    const mockVector = Array.from({ length: 768 }, (_, i) => i * 0.001);
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: mockVector }] }),
    });

    const result = await client.embed("a red car on a beach");

    expect(result).toHaveLength(768);
    expect(result[0]).toBe(0);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://embed.test/v1/embeddings");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");

    const body = JSON.parse(opts.body);
    expect(body.input).toBe("a red car on a beach");
    expect(body.dimensions).toBe(768);
  });

  it("embedBatch() returns multiple vectors", async () => {
    const v1 = Array.from({ length: 768 }, () => 0.1);
    const v2 = Array.from({ length: 768 }, () => 0.2);
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: v1 }, { embedding: v2 }] }),
    });

    const result = await client.embedBatch(["text 1", "text 2"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(768);
    expect(result[1]).toHaveLength(768);
  });

  it("throws on non-ok response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    await expect(client.embed("test")).rejects.toThrow("Embedding API error 429");
  });
});
