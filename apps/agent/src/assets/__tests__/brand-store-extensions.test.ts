import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrandStore } from "../brand-store.js";

function createMockDb() {
  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };
}

describe("BrandStore extensions", () => {
  let db: ReturnType<typeof createMockDb>;
  let store: BrandStore;

  beforeEach(() => {
    db = createMockDb();
    store = new BrandStore(db);
  });

  it("linkAsset inserts brand-asset link", async () => {
    await store.linkAsset("brand-1", "asset-1", "logo");
    expect(db.insert).toHaveBeenCalled();
  });

  it("getWithAssets returns brand and linked assets with roles", async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "brand-1", name: "Acme" }]),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { brand_asset_links: { assetRole: "logo" }, assets: { id: "a1", name: "logo.png" } },
          ]),
        }),
      }),
    });

    const result = await store.getWithAssets("brand-1");
    expect(result.brand).toHaveProperty("name", "Acme");
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].role).toBe("logo");
  });
});
