// apps/agent/src/assets/__tests__/character-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CharacterStore } from "../character-store.js";

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

describe("CharacterStore", () => {
  let db: ReturnType<typeof createMockDb>;
  let store: CharacterStore;

  beforeEach(() => {
    db = createMockDb();
    store = new CharacterStore(db);
  });

  it("getById queries by id", async () => {
    await store.getById("char-1");
    expect(db.select).toHaveBeenCalled();
  });

  it("getByName queries by name", async () => {
    await store.getByName("Hero");
    expect(db.select).toHaveBeenCalled();
  });

  it("create inserts new character", async () => {
    const result = await store.create({ name: "Hero", description: "Main character" });
    expect(result).toHaveProperty("id");
    expect(db.insert).toHaveBeenCalled();
  });

  it("linkAsset inserts join record", async () => {
    await store.linkAsset("char-1", "asset-1", "reference");
    expect(db.insert).toHaveBeenCalled();
  });

  it("getWithAssets returns character and linked assets", async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "char-1", name: "Hero" }]),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { character_assets: { role: "reference" }, assets: { id: "a1", name: "ref.png" } },
          ]),
        }),
      }),
    });

    const result = await store.getWithAssets("char-1");
    expect(result.character).toHaveProperty("name", "Hero");
    expect(result.assets).toHaveLength(1);
  });
});
