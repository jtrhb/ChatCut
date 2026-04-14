import { describe, it, expect } from "vitest";
import { assets, characters, characterAssets, brandAssetLinks } from "../schema.js";

describe("asset-related schema tables", () => {
  it("assets table has embedding column", () => {
    expect(Object.keys(assets)).toContain("embedding");
  });

  it("characters table exists with required columns", () => {
    const cols = Object.keys(characters);
    expect(cols).toContain("id");
    expect(cols).toContain("name");
    expect(cols).toContain("description");
    expect(cols).toContain("projectId");
    expect(cols).toContain("createdAt");
    expect(cols).toContain("updatedAt");
  });

  it("characterAssets join table exists", () => {
    const cols = Object.keys(characterAssets);
    expect(cols).toContain("characterId");
    expect(cols).toContain("assetId");
    expect(cols).toContain("role");
  });

  it("brandAssetLinks join table exists", () => {
    const cols = Object.keys(brandAssetLinks);
    expect(cols).toContain("brandId");
    expect(cols).toContain("assetId");
    expect(cols).toContain("assetRole");
  });
});
