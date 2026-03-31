import { describe, it, expect } from "vitest";
import {
  SearchAssetsSchema,
  GetAssetInfoSchema,
  SaveAssetSchema,
  TagAssetSchema,
  FindSimilarSchema,
  GetCharacterSchema,
  GetBrandAssetsSchema,
  assetToolDefinitions,
} from "../asset-tools.js";

// ── Schema Validation Tests ──────────────────────────────────────────────────

describe("Asset Tool Schemas", () => {
  describe("search_assets", () => {
    it("accepts query only", () => {
      expect(SearchAssetsSchema.safeParse({ query: "sunset" }).success).toBe(true);
    });

    it("accepts valid type enum values", () => {
      for (const type of ["video", "image", "audio"] as const) {
        expect(
          SearchAssetsSchema.safeParse({ query: "test", type }).success
        ).toBe(true);
      }
    });

    it("rejects missing query", () => {
      expect(SearchAssetsSchema.safeParse({ type: "video" }).success).toBe(false);
    });

    it("rejects invalid type enum", () => {
      expect(
        SearchAssetsSchema.safeParse({ query: "test", type: "text" }).success
      ).toBe(false);
    });
  });

  describe("get_asset_info", () => {
    it("accepts valid asset_id", () => {
      expect(GetAssetInfoSchema.safeParse({ asset_id: "asset-1" }).success).toBe(
        true
      );
    });

    it("rejects missing asset_id", () => {
      expect(GetAssetInfoSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-string asset_id", () => {
      expect(GetAssetInfoSchema.safeParse({ asset_id: 42 }).success).toBe(false);
    });
  });

  describe("save_asset", () => {
    it("accepts required fields", () => {
      expect(
        SaveAssetSchema.safeParse({
          file_or_url: "https://example.com/file.mp4",
          metadata: { title: "My Asset" },
        }).success
      ).toBe(true);
    });

    it("accepts optional tags", () => {
      expect(
        SaveAssetSchema.safeParse({
          file_or_url: "https://example.com/file.mp4",
          metadata: { title: "My Asset" },
          tags: ["nature", "outdoor"],
        }).success
      ).toBe(true);
    });

    it("rejects missing file_or_url", () => {
      expect(
        SaveAssetSchema.safeParse({ metadata: { title: "My Asset" } }).success
      ).toBe(false);
    });

    it("rejects missing metadata", () => {
      expect(
        SaveAssetSchema.safeParse({
          file_or_url: "https://example.com/file.mp4",
        }).success
      ).toBe(false);
    });

    it("rejects non-array tags", () => {
      expect(
        SaveAssetSchema.safeParse({
          file_or_url: "https://example.com/file.mp4",
          metadata: {},
          tags: "nature",
        }).success
      ).toBe(false);
    });
  });

  describe("tag_asset", () => {
    it("accepts asset_id and tags array", () => {
      expect(
        TagAssetSchema.safeParse({
          asset_id: "asset-1",
          tags: ["nature", "outdoor"],
        }).success
      ).toBe(true);
    });

    it("rejects missing asset_id", () => {
      expect(TagAssetSchema.safeParse({ tags: ["nature"] }).success).toBe(false);
    });

    it("rejects non-array tags", () => {
      expect(
        TagAssetSchema.safeParse({ asset_id: "asset-1", tags: "nature" }).success
      ).toBe(false);
    });
  });

  describe("find_similar", () => {
    it("accepts asset_id only (limit defaults to 5)", () => {
      const result = FindSimilarSchema.safeParse({ asset_id: "asset-1" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(5);
      }
    });

    it("accepts optional limit override", () => {
      expect(
        FindSimilarSchema.safeParse({ asset_id: "asset-1", limit: 10 }).success
      ).toBe(true);
    });

    it("rejects missing asset_id", () => {
      expect(FindSimilarSchema.safeParse({ limit: 5 }).success).toBe(false);
    });

    it("rejects non-number limit", () => {
      expect(
        FindSimilarSchema.safeParse({ asset_id: "asset-1", limit: "ten" }).success
      ).toBe(false);
    });
  });

  describe("get_character", () => {
    it("accepts valid character_id", () => {
      expect(
        GetCharacterSchema.safeParse({ character_id: "char-1" }).success
      ).toBe(true);
    });

    it("rejects missing character_id", () => {
      expect(GetCharacterSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-string character_id", () => {
      expect(GetCharacterSchema.safeParse({ character_id: 99 }).success).toBe(
        false
      );
    });
  });

  describe("get_brand_assets", () => {
    it("accepts valid brand_id", () => {
      expect(
        GetBrandAssetsSchema.safeParse({ brand_id: "brand-1" }).success
      ).toBe(true);
    });

    it("rejects missing brand_id", () => {
      expect(GetBrandAssetsSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-string brand_id", () => {
      expect(GetBrandAssetsSchema.safeParse({ brand_id: 0 }).success).toBe(false);
    });
  });
});

// ── Tool Definition Tests ────────────────────────────────────────────────────

describe("assetToolDefinitions", () => {
  it("contains exactly 7 tools", () => {
    expect(assetToolDefinitions).toHaveLength(7);
  });

  it("all tools have agentType 'asset'", () => {
    for (const tool of assetToolDefinitions) {
      expect(tool.agentTypes).toContain("asset");
    }
  });

  it("has unique tool names", () => {
    const names = assetToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("search_assets is a read tool", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "search_assets");
    expect(tool?.accessMode).toBe("read");
  });

  it("get_asset_info is a read tool", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "get_asset_info");
    expect(tool?.accessMode).toBe("read");
  });

  it("save_asset is a write tool", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "save_asset");
    expect(tool?.accessMode).toBe("write");
  });

  it("tag_asset is a write tool", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "tag_asset");
    expect(tool?.accessMode).toBe("write");
  });

  it("find_similar is a read tool", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "find_similar");
    expect(tool?.accessMode).toBe("read");
  });

  it("get_character is a read tool", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "get_character");
    expect(tool?.accessMode).toBe("read");
  });

  it("get_brand_assets is a read tool", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "get_brand_assets");
    expect(tool?.accessMode).toBe("read");
  });
});
