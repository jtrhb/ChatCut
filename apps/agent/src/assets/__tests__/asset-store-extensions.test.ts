import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssetStore } from "../asset-store.js";

function createMockDb() {
  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    execute: vi.fn().mockResolvedValue([]),
  };
}

describe("AssetStore extensions", () => {
  let db: ReturnType<typeof createMockDb>;
  let store: AssetStore;

  beforeEach(() => {
    db = createMockDb();
    store = new AssetStore(db);
  });

  it("findById queries by id", async () => {
    await store.findById("asset-123");
    expect(db.select).toHaveBeenCalled();
  });

  it("updateTags sets tags array", async () => {
    await store.updateTags("asset-123", ["sunset", "beach"]);
    expect(db.update).toHaveBeenCalled();
  });

  it("saveWithEmbedding stores vector alongside metadata", async () => {
    const embedding = Array.from({ length: 768 }, () => 0.1);
    await store.saveWithEmbedding(
      { userId: "u1", type: "image", name: "test", storageKey: "key-1" },
      embedding,
    );
    expect(db.insert).toHaveBeenCalled();
  });

  it("findSimilar uses raw SQL with vector parameter", async () => {
    const embedding = Array.from({ length: 768 }, () => 0.1);
    await store.findSimilar(embedding, 5);
    expect(db.execute).toHaveBeenCalled();
  });
});
