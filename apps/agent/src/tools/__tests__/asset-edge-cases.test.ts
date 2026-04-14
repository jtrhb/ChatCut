// apps/agent/src/tools/__tests__/asset-edge-cases.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AssetToolExecutor } from "../asset-tool-executor.js";

function createMockDeps() {
  return {
    assetStore: {
      search: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateTags: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue({ id: "a1" }),
      saveWithEmbedding: vi.fn().mockResolvedValue({ id: "a1" }),
      findSimilar: vi.fn().mockResolvedValue([]),
    },
    brandStore: { getWithAssets: vi.fn().mockResolvedValue({ brand: null, assets: [] }) },
    characterStore: {
      getById: vi.fn().mockResolvedValue(null),
      getWithAssets: vi.fn().mockResolvedValue({ character: null, assets: [] }),
    },
    objectStorage: {
      upload: vi.fn().mockResolvedValue("key-1"),
      getSignedUrl: vi.fn().mockResolvedValue("https://signed.url"),
    },
    embeddingClient: {
      embed: vi.fn().mockResolvedValue(Array.from({ length: 768 }, () => 0.1)),
    },
  };
}

describe("AssetToolExecutor edge cases", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let executor: AssetToolExecutor;
  const ctx = { agentType: "asset" as const, taskId: "t1" };

  beforeEach(() => {
    deps = createMockDeps();
    executor = new AssetToolExecutor(deps as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("save_asset with embedding service down saves without vector", async () => {
    deps.embeddingClient.embed.mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      headers: { get: () => "image/png" },
    }));

    const result = await executor.execute(
      "save_asset",
      { file_or_url: "https://example.com/img.png", metadata: { name: "test" } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(deps.assetStore.save).toHaveBeenCalled(); // fallback to save without embedding
    expect(deps.assetStore.saveWithEmbedding).not.toHaveBeenCalled();
  });

  it("find_similar on asset without embedding returns error", async () => {
    deps.assetStore.findById.mockResolvedValue({ id: "a1", embedding: null });
    const result = await executor.execute("find_similar", { asset_id: "a1", limit: 5 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("no embedding");
  });

  it("get_character with unknown id returns empty", async () => {
    const result = await executor.execute("get_character", { character_id: "unknown" }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as any).character).toBeNull();
  });

  it("search_assets with no matches returns empty array", async () => {
    const result = await executor.execute("search_assets", { query: "nonexistent" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("save_asset with fetch failure returns error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await executor.execute(
      "save_asset",
      { file_or_url: "https://example.com/missing.png", metadata: {} },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to fetch");
    expect(deps.assetStore.save).not.toHaveBeenCalled();
  });

  it("get_asset_info with unknown id returns error", async () => {
    const result = await executor.execute("get_asset_info", { asset_id: "unknown" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
