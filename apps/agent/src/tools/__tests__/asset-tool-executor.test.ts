import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssetToolExecutor } from "../asset-tool-executor.js";

function createMockDeps() {
  return {
    assetStore: {
      search: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateTags: vi.fn().mockResolvedValue(undefined),
      saveWithEmbedding: vi.fn().mockResolvedValue({ id: "new-asset-1" }),
      findSimilar: vi.fn().mockResolvedValue([]),
    },
    brandStore: {
      getWithAssets: vi.fn().mockResolvedValue({ brand: null, assets: [] }),
    },
    characterStore: {
      getById: vi.fn().mockResolvedValue(null),
      getWithAssets: vi.fn().mockResolvedValue({ character: null, assets: [] }),
    },
    objectStorage: {
      upload: vi.fn().mockResolvedValue("storage-key-123"),
      getSignedUrl: vi.fn().mockResolvedValue("https://r2.example.com/signed"),
    },
    embeddingClient: {
      embed: vi.fn().mockResolvedValue(Array.from({ length: 768 }, () => 0.1)),
    },
  };
}

describe("AssetToolExecutor", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let executor: AssetToolExecutor;

  beforeEach(() => {
    deps = createMockDeps();
    executor = new AssetToolExecutor(deps as any);
  });

  it("routes search_assets to AssetStore.search", async () => {
    const result = await executor.execute(
      "search_assets",
      { query: "sunset", type: "image" },
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(true);
    expect(deps.assetStore.search).toHaveBeenCalled();
  });

  it("threads ctx.userId into assetStore.search (B1 tenant isolation)", async () => {
    await executor.execute(
      "search_assets",
      { query: "sunset" },
      { agentType: "asset", taskId: "t1", userId: "user-alice" },
    );
    expect(deps.assetStore.search).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-alice", query: "sunset" }),
    );
  });

  it("falls back to 'unscoped' when ctx.userId is missing (dev/test)", async () => {
    await executor.execute(
      "search_assets",
      { query: "sunset" },
      { agentType: "asset", taskId: "t1" },
    );
    expect(deps.assetStore.search).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "unscoped" }),
    );
  });

  it("routes get_asset_info to AssetStore.findById + signed URL", async () => {
    deps.assetStore.findById.mockResolvedValue({
      id: "a1", name: "test", storageKey: "key-1",
    });
    const result = await executor.execute(
      "get_asset_info",
      { asset_id: "a1" },
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(true);
    expect(deps.objectStorage.getSignedUrl).toHaveBeenCalledWith("key-1");
  });

  it("routes save_asset — fetches URL, uploads, embeds, saves", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      headers: { get: () => "image/png" },
    }));

    const result = await executor.execute(
      "save_asset",
      { file_or_url: "https://example.com/img.png", metadata: { name: "test" }, tags: ["sunset"] },
      { agentType: "asset", taskId: "t1", userId: "user-bob" },
    );
    expect(result.success).toBe(true);
    expect(deps.objectStorage.upload).toHaveBeenCalled();
    expect(deps.embeddingClient.embed).toHaveBeenCalled();
    expect(deps.assetStore.saveWithEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-bob" }),
      expect.any(Array),
    );

    vi.unstubAllGlobals();
  });

  it("routes tag_asset to AssetStore.updateTags", async () => {
    const result = await executor.execute(
      "tag_asset",
      { asset_id: "a1", tags: ["red", "car"] },
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(true);
    expect(deps.assetStore.updateTags).toHaveBeenCalledWith("a1", ["red", "car"]);
  });

  it("routes find_similar — gets embedding then searches", async () => {
    const embedding = Array.from({ length: 768 }, () => 0.5);
    deps.assetStore.findById.mockResolvedValue({ id: "a1", embedding });
    deps.assetStore.findSimilar.mockResolvedValue([{ id: "a2", distance: 0.1 }]);

    const result = await executor.execute(
      "find_similar",
      { asset_id: "a1", limit: 5 },
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(true);
    expect(deps.assetStore.findSimilar).toHaveBeenCalledWith(embedding, 5);
  });

  it("find_similar returns error when asset has no embedding", async () => {
    deps.assetStore.findById.mockResolvedValue({ id: "a1", embedding: null });
    const result = await executor.execute(
      "find_similar",
      { asset_id: "a1", limit: 5 },
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("no embedding");
  });

  it("routes get_character to CharacterStore", async () => {
    deps.characterStore.getById.mockResolvedValue({ id: "c1", name: "Hero" });
    deps.characterStore.getWithAssets.mockResolvedValue({
      character: { id: "c1", name: "Hero" },
      assets: [{ id: "a1", storageKey: "k1", role: "reference" }],
    });

    const result = await executor.execute(
      "get_character",
      { character_id: "c1" },
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(true);
    expect(deps.characterStore.getWithAssets).toHaveBeenCalledWith("c1");
  });

  it("routes get_brand_assets to BrandStore", async () => {
    deps.brandStore.getWithAssets.mockResolvedValue({
      brand: { id: "b1", name: "Acme" },
      assets: [{ id: "a1", storageKey: "k1", role: "logo" }],
    });

    const result = await executor.execute(
      "get_brand_assets",
      { brand_id: "b1" },
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(true);
    expect(deps.brandStore.getWithAssets).toHaveBeenCalledWith("b1");
  });
});
