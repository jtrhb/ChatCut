import { describe, it, expect } from "vitest";
import { AssetToolExecutor } from "../tools/asset-tool-executor.js";

describe("Asset tool executor routing", () => {
  it("AssetToolExecutor has all 7 asset tool names", () => {
    const mockDeps = {
      assetStore: {},
      brandStore: {},
      characterStore: {},
      objectStorage: {},
      embeddingClient: {},
    };
    const executor = new AssetToolExecutor(mockDeps as any);

    expect(executor.hasToolName("search_assets")).toBe(true);
    expect(executor.hasToolName("get_asset_info")).toBe(true);
    expect(executor.hasToolName("save_asset")).toBe(true);
    expect(executor.hasToolName("tag_asset")).toBe(true);
    expect(executor.hasToolName("find_similar")).toBe(true);
    expect(executor.hasToolName("get_character")).toBe(true);
    expect(executor.hasToolName("get_brand_assets")).toBe(true);
    expect(executor.hasToolName("unknown_tool")).toBe(false);
  });
});
