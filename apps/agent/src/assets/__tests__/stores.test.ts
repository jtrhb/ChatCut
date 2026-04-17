import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillStore } from "../skill-store.js";
import { AssetStore } from "../asset-store.js";
import { BrandStore } from "../brand-store.js";

// ---------------------------------------------------------------------------
// Mock DB factory — Drizzle-style chainable API
//
// Stores use: db.insert(table).values({...})
//             db.select().from(table).where(...)
//             db.update(table).set({...}).where(...)
// ---------------------------------------------------------------------------

function makeMockDb() {
  const db = {
    insert: vi.fn((_table: any) => ({
      values: vi.fn(async (_data: any) => {}),
    })),
    select: vi.fn(() => ({
      from: vi.fn((_table: any) => ({
        where: vi.fn(async () => []),
        // Make the from() result thenable for queries without .where()
        then: (resolve: any) => resolve([]),
      })),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {}),
      })),
    })),
  };

  return db;
}

type MockDb = ReturnType<typeof makeMockDb>;

// ---------------------------------------------------------------------------
// SkillStore
// ---------------------------------------------------------------------------

describe("SkillStore", () => {
  let db: MockDb;
  let store: SkillStore;

  beforeEach(() => {
    db = makeMockDb();
    store = new SkillStore(db);
  });

  // ── 1. save calls db.insert with Drizzle table reference ─────────────────
  it("save calls db.insert and returns an id", async () => {
    const result = await store.save({
      userId: "user-1",
      name: "Beat Sync",
      agentType: "editor",
      scopeLevel: "brand",
      content: "Cut on the beat.",
    });

    expect(db.insert).toHaveBeenCalled();
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
  });

  // ── 2. save passes table reference (not string) to db.insert ─────────────
  it("save passes a Drizzle table reference to db.insert", async () => {
    await store.save({
      userId: "user-1",
      name: "Beat Sync",
      agentType: "editor",
      scopeLevel: "brand",
      content: "Cut on the beat.",
    });

    const insertArg = db.insert.mock.calls[0][0];
    // Drizzle table refs are objects, not strings
    expect(typeof insertArg).toBe("object");
  });

  // ── 3. search calls db.select ────────────────────────────────────────────
  it("search calls db.select", async () => {
    await store.search({ userId: "user-1" });
    expect(db.select).toHaveBeenCalled();
  });

  // ── 4. search with agentType filter ──────────────────────────────────────
  it("search calls db.select when agentType is provided", async () => {
    await store.search({ userId: "user-1", agentType: "editor" });
    expect(db.select).toHaveBeenCalled();
  });

  // ── 5. incrementUsage calls db.update ────────────────────────────────────
  it("incrementUsage calls db.update", async () => {
    await store.incrementUsage("skill-abc");
    expect(db.update).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AssetStore
// ---------------------------------------------------------------------------

describe("AssetStore", () => {
  let db: MockDb;
  let store: AssetStore;

  beforeEach(() => {
    db = makeMockDb();
    store = new AssetStore(db);
  });

  // ── 6. save stores asset ─────────────────────────────────────────────────
  it("save calls db.insert and returns an id", async () => {
    const result = await store.save({
      userId: "user-2",
      type: "image",
      name: "thumbnail-001",
      storageKey: "r2/thumbnails/001.jpg",
      metadata: { width: 1280, height: 720 },
      tags: ["youtube", "thumbnail"],
    });

    expect(db.insert).toHaveBeenCalled();
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
  });

  // ── 7. save passes Drizzle table ref ─────────────────────────────────────
  it("save passes a Drizzle table reference to db.insert", async () => {
    await store.save({
      userId: "user-2",
      type: "video",
      name: "clip-001",
      storageKey: "r2/clips/001.mp4",
    });

    const insertArg = db.insert.mock.calls[0][0];
    expect(typeof insertArg).toBe("object");
  });

  // ── 8. search calls db.select ────────────────────────────────────────────
  it("search calls db.select", async () => {
    await store.search({ userId: "user-2", type: "image" });
    expect(db.select).toHaveBeenCalled();
  });

  // ── 9. search applies text query filter on returned results ──────────────
  it("search filters returned rows by query string against name and tags", async () => {
    const mockRows = [
      { id: "a1", name: "viral-thumbnail", tags: ["youtube"] },
      { id: "a2", name: "podcast-cover", tags: ["audio"] },
    ];
    db.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(async () => mockRows),
      })),
    } as any);

    const results = await store.search({ userId: "user-2", type: "image", query: "viral" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a1");
  });
});

// ---------------------------------------------------------------------------
// BrandStore
// ---------------------------------------------------------------------------

describe("BrandStore", () => {
  let db: MockDb;
  let store: BrandStore;

  beforeEach(() => {
    db = makeMockDb();
    store = new BrandStore(db);
  });

  // ── 10. create saves brand kit ───────────────────────────────────────────
  it("create calls db.insert and returns an id", async () => {
    const result = await store.create({
      userId: "user-3",
      name: "Acme Brand",
      colors: ["#ff0000", "#000000"],
      fonts: ["Inter", "Roboto"],
    });

    expect(db.insert).toHaveBeenCalled();
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
  });

  // ── 11. create passes Drizzle table ref ──────────────────────────────────
  it("create passes a Drizzle table reference to db.insert", async () => {
    await store.create({ userId: "user-3", name: "Minimal Brand" });

    const insertArg = db.insert.mock.calls[0][0];
    expect(typeof insertArg).toBe("object");
  });

  // ── 12. get calls db.select with where clause ───────────────────────────
  it("get calls db.select and returns the brand record", async () => {
    const brandRecord = {
      id: "brand-abc",
      name: "Acme Brand",
      brandSlug: "acme-brand",
      visualConfig: { colors: ["#ff0000"], fonts: ["Inter"] },
    };
    db.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(async () => [brandRecord]),
      })),
    } as any);

    const result = await store.get("brand-abc");

    expect(db.select).toHaveBeenCalled();
    expect(result).toEqual(brandRecord);
  });

  // ── 13. get returns null when brand does not exist ───────────────────────
  it("get returns null when no rows are returned", async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    } as any);

    const result = await store.get("nonexistent-brand");
    expect(result).toBeNull();
  });
});
