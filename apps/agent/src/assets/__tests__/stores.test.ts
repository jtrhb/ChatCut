import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillStore } from "../skill-store.js";
import { AssetStore } from "../asset-store.js";
import { BrandStore } from "../brand-store.js";

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

function makeMockDb() {
  return {
    insert: vi.fn(async () => {}),
    select: vi.fn(async () => []),
    update: vi.fn(async () => {}),
    findOne: vi.fn(async () => null),
  };
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

  // ── 1. save calls db.insert ───────────────────────────────────────────────
  it("save calls db.insert with correct fields", async () => {
    const result = await store.save({
      userId: "user-1",
      name: "Beat Sync",
      agentType: "editor",
      scopeLevel: "brand",
      content: "Cut on the beat.",
    });

    expect(db.insert).toHaveBeenCalledOnce();
    const [table, row] = db.insert.mock.calls[0];
    expect(table).toBe("skills");
    expect(row.user_id).toBe("user-1");
    expect(row.name).toBe("Beat Sync");
    expect(row.agent_type).toBe("editor");
    expect(row.scope_level).toBe("brand");
    expect(row.content).toBe("Cut on the beat.");
    expect(typeof row.id).toBe("string");
    expect(result.id).toBe(row.id);
  });

  // ── 2. search calls db.select with userId filter ──────────────────────────
  it("search calls db.select with userId filter", async () => {
    await store.search({ userId: "user-1" });

    expect(db.select).toHaveBeenCalledOnce();
    const [table, filters] = db.select.mock.calls[0];
    expect(table).toBe("skills");
    expect(filters.user_id).toBe("user-1");
  });

  // ── 3. search includes agentType filter when provided ────────────────────
  it("search includes agentType filter when provided", async () => {
    await store.search({ userId: "user-1", agentType: "editor" });

    const [, filters] = db.select.mock.calls[0];
    expect(filters.agent_type).toBe("editor");
  });

  // ── 4. search includes scopeLevel filter when provided ───────────────────
  it("search includes scopeLevel filter when provided", async () => {
    await store.search({ userId: "user-1", scopeLevel: "brand" });

    const [, filters] = db.select.mock.calls[0];
    expect(filters.scope_level).toBe("brand");
  });

  // ── 5. incrementUsage calls db.update ────────────────────────────────────
  it("incrementUsage calls db.update with skillId", async () => {
    await store.incrementUsage("skill-abc");

    expect(db.update).toHaveBeenCalledOnce();
    const [table, id] = db.update.mock.calls[0];
    expect(table).toBe("skills");
    expect(id).toBe("skill-abc");
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

  // ── 6. save stores asset with generation_context ──────────────────────────
  it("save stores asset with generation_context field", async () => {
    const result = await store.save({
      userId: "user-2",
      type: "image",
      name: "thumbnail-001",
      storageKey: "r2/thumbnails/001.jpg",
      metadata: { width: 1280, height: 720 },
      tags: ["youtube", "thumbnail"],
    });

    expect(db.insert).toHaveBeenCalledOnce();
    const [table, row] = db.insert.mock.calls[0];
    expect(table).toBe("assets");
    expect(row.user_id).toBe("user-2");
    expect(row.type).toBe("image");
    expect(row.name).toBe("thumbnail-001");
    expect(row.storage_key).toBe("r2/thumbnails/001.jpg");
    expect(row.metadata).toEqual({ width: 1280, height: 720 });
    expect(row.tags).toEqual(["youtube", "thumbnail"]);
    expect(row.generation_context).toBeDefined();
    expect(row.generation_context.source).toBe("agent");
    expect(typeof result.id).toBe("string");
  });

  // ── 7. save uses empty defaults for optional fields ───────────────────────
  it("save uses empty defaults when metadata and tags are omitted", async () => {
    await store.save({
      userId: "user-2",
      type: "video",
      name: "clip-001",
      storageKey: "r2/clips/001.mp4",
    });

    const [, row] = db.insert.mock.calls[0];
    expect(row.metadata).toEqual({});
    expect(row.tags).toEqual([]);
  });

  // ── 8. search filters by type ─────────────────────────────────────────────
  it("search calls db.select with type filter when provided", async () => {
    db.select.mockResolvedValue([]);
    await store.search({ userId: "user-2", type: "image" });

    const [table, filters] = db.select.mock.calls[0];
    expect(table).toBe("assets");
    expect(filters.type).toBe("image");
    expect(filters.user_id).toBe("user-2");
  });

  // ── 9. search applies text query filter on returned results ───────────────
  it("search filters returned rows by query string against name and tags", async () => {
    db.select.mockResolvedValue([
      { id: "a1", name: "viral-thumbnail", tags: ["youtube"], generation_context: {} },
      { id: "a2", name: "podcast-cover", tags: ["audio"], generation_context: {} },
    ]);

    const results = await store.search({ userId: "user-2", query: "viral" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a1");
  });

  // ── 10. search returns all when no query/type filter ─────────────────────
  it("search returns all results when no query or type is provided", async () => {
    db.select.mockResolvedValue([
      { id: "a1", name: "clip-1", tags: [] },
      { id: "a2", name: "clip-2", tags: [] },
    ]);

    const results = await store.search({ userId: "user-2" });
    expect(results).toHaveLength(2);
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

  // ── 11. create saves brand kit ────────────────────────────────────────────
  it("create calls db.insert with brand kit data", async () => {
    const result = await store.create({
      userId: "user-3",
      name: "Acme Brand",
      colors: ["#ff0000", "#000000"],
      fonts: ["Inter", "Roboto"],
    });

    expect(db.insert).toHaveBeenCalledOnce();
    const [table, row] = db.insert.mock.calls[0];
    expect(table).toBe("brand_kits");
    expect(row.user_id).toBe("user-3");
    expect(row.name).toBe("Acme Brand");
    expect(row.colors).toEqual(["#ff0000", "#000000"]);
    expect(row.fonts).toEqual(["Inter", "Roboto"]);
    expect(typeof row.id).toBe("string");
    expect(result.id).toBe(row.id);
  });

  // ── 12. create uses empty defaults for optional fields ───────────────────
  it("create uses empty arrays when colors and fonts are omitted", async () => {
    await store.create({ userId: "user-3", name: "Minimal Brand" });

    const [, row] = db.insert.mock.calls[0];
    expect(row.colors).toEqual([]);
    expect(row.fonts).toEqual([]);
  });

  // ── 13. get returns brand data via db.findOne ─────────────────────────────
  it("get calls db.findOne and returns the brand record", async () => {
    const brandRecord = {
      id: "brand-abc",
      user_id: "user-3",
      name: "Acme Brand",
      colors: ["#ff0000"],
      fonts: ["Inter"],
    };
    db.findOne.mockResolvedValue(brandRecord);

    const result = await store.get("brand-abc");

    expect(db.findOne).toHaveBeenCalledOnce();
    const [table, filters] = db.findOne.mock.calls[0];
    expect(table).toBe("brand_kits");
    expect(filters.id).toBe("brand-abc");
    expect(result).toEqual(brandRecord);
  });

  // ── 14. get returns null when brand does not exist ───────────────────────
  it("get returns null when db.findOne returns null", async () => {
    db.findOne.mockResolvedValue(null);

    const result = await store.get("nonexistent-brand");
    expect(result).toBeNull();
  });
});
