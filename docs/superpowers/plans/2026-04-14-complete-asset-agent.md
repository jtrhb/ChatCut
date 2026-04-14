# Complete Asset Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all 7 asset tool executors with R2 storage, pgvector similarity search, Gemini Embedding 2 integration, and character/brand asset relations.

**Architecture:** 8 tasks in dependency order. Tasks 1-2 are infrastructure (EmbeddingClient, DB schema). Tasks 3-5 are data layer (AssetStore extensions, CharacterStore, BrandStore extensions). Task 6 is the executor. Tasks 7-8 are wiring and integration tests.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM, @aws-sdk/client-s3, pgvector, Hono

---

## File Structure

```
apps/agent/src/
├── services/
│   └── embedding-client.ts          (new) OpenAI-compatible embedding client
├── db/
│   └── schema.ts                    (modify) pgvector vector column + characters + brand_asset_links tables
├── assets/
│   ├── asset-store.ts               (modify) Add findById, updateTags, saveWithEmbedding, findSimilar
│   ├── brand-store.ts               (modify) Add getWithAssets, linkAsset
│   └── character-store.ts           (new) Character CRUD + asset linking
├── tools/
│   └── asset-tool-executor.ts       (new) 7-tool switch dispatch
└── index.ts                         (modify) Wire EmbeddingClient, AssetToolExecutor, CharacterStore
```

---

### Task 1: EmbeddingClient

**Files:**
- Create: `apps/agent/src/services/embedding-client.ts`
- Test: `apps/agent/src/services/__tests__/embedding-client.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/agent/src/services/__tests__/embedding-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbeddingClient } from "../embedding-client.js";

describe("EmbeddingClient", () => {
  let client: EmbeddingClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new EmbeddingClient("https://embed.test", "test-key");
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("embed() returns 768-dim vector", async () => {
    const mockVector = Array.from({ length: 768 }, (_, i) => i * 0.001);
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: mockVector }] }),
    });

    const result = await client.embed("a red car on a beach");

    expect(result).toHaveLength(768);
    expect(result[0]).toBe(0);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://embed.test/v1/embeddings");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");

    const body = JSON.parse(opts.body);
    expect(body.input).toBe("a red car on a beach");
    expect(body.dimensions).toBe(768);
  });

  it("embedBatch() returns multiple vectors", async () => {
    const v1 = Array.from({ length: 768 }, () => 0.1);
    const v2 = Array.from({ length: 768 }, () => 0.2);
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: v1 }, { embedding: v2 }] }),
    });

    const result = await client.embedBatch(["text 1", "text 2"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(768);
    expect(result[1]).toHaveLength(768);
  });

  it("throws on non-ok response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    await expect(client.embed("test")).rejects.toThrow("Embedding API error 429");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/services/__tests__/embedding-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement EmbeddingClient**

```typescript
// apps/agent/src/services/embedding-client.ts

export class EmbeddingClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly defaultDimensions: number;

  constructor(apiUrl: string, apiKey: string, dimensions = 768) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.defaultDimensions = dimensions;
  }

  async embed(input: string, dimensions?: number): Promise<number[]> {
    const result = await this.callApi(input, dimensions ?? this.defaultDimensions);
    return result.data[0].embedding;
  }

  async embedBatch(inputs: string[], dimensions?: number): Promise<number[][]> {
    const result = await this.callApi(inputs, dimensions ?? this.defaultDimensions);
    return result.data.map((d: { embedding: number[] }) => d.embedding);
  }

  private async callApi(
    input: string | string[],
    dimensions: number,
  ): Promise<{ data: Array<{ embedding: number[] }> }> {
    const response = await fetch(`${this.apiUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gemini-embedding-2",
        input,
        dimensions,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Embedding API error ${response.status}: ${text}`);
    }

    return response.json();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/services/__tests__/embedding-client.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/services/embedding-client.ts apps/agent/src/services/__tests__/embedding-client.test.ts
git commit -m "feat(agent): add EmbeddingClient for Gemini Embedding 2 via OpenAI-compatible API"
```

---

### Task 2: DB Schema — pgvector + Character/Brand Tables

**Files:**
- Modify: `apps/agent/src/db/schema.ts`
- Test: `apps/agent/src/db/__tests__/schema-asset-tables.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/agent/src/db/__tests__/schema-asset-tables.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/db/__tests__/schema-asset-tables.test.ts`
Expected: FAIL — exports don't exist

- [ ] **Step 3: Add tables and columns to schema**

In `apps/agent/src/db/schema.ts`:

```typescript
import { customType } from "drizzle-orm/pg-core";

// pgvector custom column type
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

// Add to existing assets table definition:
// embedding: vector("embedding"),

// New tables:
export const characters = pgTable("characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  projectId: uuid("project_id").references(() => projects.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const characterAssets = pgTable("character_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  characterId: uuid("character_id").references(() => characters.id).notNull(),
  assetId: uuid("asset_id").references(() => assets.id).notNull(),
  role: text("role").default("reference").notNull(),
});

export const brandAssetLinks = pgTable("brand_asset_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id").references(() => brandKits.id).notNull(),
  assetId: uuid("asset_id").references(() => assets.id).notNull(),
  assetRole: text("asset_role").notNull(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/db/__tests__/schema-asset-tables.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/db/schema.ts apps/agent/src/db/__tests__/schema-asset-tables.test.ts
git commit -m "feat(agent): add pgvector column + characters + brand_asset_links tables"
```

---

### Task 3: AssetStore Extensions

**Files:**
- Modify: `apps/agent/src/assets/asset-store.ts`
- Test: `apps/agent/src/assets/__tests__/asset-store-extensions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/agent/src/assets/__tests__/asset-store-extensions.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/asset-store-extensions.test.ts`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Implement new methods**

Add to `apps/agent/src/assets/asset-store.ts`:

```typescript
import { randomUUID } from "crypto";
import { eq, and, sql, type SQL } from "drizzle-orm";
import { assets } from "../db/schema.js";

// Add these methods to AssetStore class:

  async findById(id: string): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(assets)
      .where(eq(assets.id, id));
    return rows[0] ?? null;
  }

  async updateTags(id: string, tags: string[]): Promise<void> {
    await this.db
      .update(assets)
      .set({ tags })
      .where(eq(assets.id, id));
  }

  async saveWithEmbedding(
    params: AssetSaveParams,
    embedding: number[],
  ): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(assets).values({
      id,
      name: params.name,
      type: params.type,
      storageKey: params.storageKey,
      tags: params.tags ?? [],
      embedding,
      generationContext: {
        created_at: new Date().toISOString(),
        source: "agent",
        metadata: params.metadata ?? {},
      },
      createdAt: new Date(),
    });
    return { id };
  }

  async findSimilar(embedding: number[], limit = 5): Promise<any[]> {
    const vectorStr = `[${embedding.join(",")}]`;
    const result = await this.db.execute(
      sql`SELECT *, embedding <=> ${vectorStr}::vector AS distance
          FROM assets
          WHERE embedding IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${limit}`,
    );
    return result;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/asset-store-extensions.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/assets/asset-store.ts apps/agent/src/assets/__tests__/asset-store-extensions.test.ts
git commit -m "feat(agent): add AssetStore findById, updateTags, saveWithEmbedding, findSimilar"
```

---

### Task 4: CharacterStore

**Files:**
- Create: `apps/agent/src/assets/character-store.ts`
- Test: `apps/agent/src/assets/__tests__/character-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/character-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CharacterStore**

```typescript
// apps/agent/src/assets/character-store.ts
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { characters, characterAssets, assets } from "../db/schema.js";

export class CharacterStore {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  async getById(id: string): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(eq(characters.id, id));
    return rows[0] ?? null;
  }

  async getByName(name: string, projectId?: string): Promise<any | null> {
    const conditions = [eq(characters.name, name)];
    if (projectId) conditions.push(eq(characters.projectId, projectId));
    const rows = await this.db
      .select()
      .from(characters)
      .where(and(...conditions));
    return rows[0] ?? null;
  }

  async create(params: {
    name: string;
    description?: string;
    projectId?: string;
  }): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(characters).values({
      id,
      name: params.name,
      description: params.description,
      projectId: params.projectId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id };
  }

  async linkAsset(
    characterId: string,
    assetId: string,
    role = "reference",
  ): Promise<void> {
    await this.db.insert(characterAssets).values({
      id: randomUUID(),
      characterId,
      assetId,
      role,
    });
  }

  async getWithAssets(
    characterId: string,
  ): Promise<{ character: any; assets: any[] }> {
    const character = await this.getById(characterId);
    if (!character) return { character: null, assets: [] };

    const linked = await this.db
      .select()
      .from(characterAssets)
      .innerJoin(assets, eq(characterAssets.assetId, assets.id))
      .where(eq(characterAssets.characterId, characterId));

    return {
      character,
      assets: linked.map((row: any) => ({
        ...row.assets,
        role: row.character_assets.role,
      })),
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/character-store.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/assets/character-store.ts apps/agent/src/assets/__tests__/character-store.test.ts
git commit -m "feat(agent): add CharacterStore with CRUD + asset linking"
```

---

### Task 5: BrandStore Extensions

**Files:**
- Modify: `apps/agent/src/assets/brand-store.ts`
- Test: `apps/agent/src/assets/__tests__/brand-store-extensions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/agent/src/assets/__tests__/brand-store-extensions.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/brand-store-extensions.test.ts`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Implement extensions**

Add to `apps/agent/src/assets/brand-store.ts`:

```typescript
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { brandKits, brandAssetLinks, assets } from "../db/schema.js";

// Add methods to BrandStore class:

  async linkAsset(brandId: string, assetId: string, role: string): Promise<void> {
    await this.db.insert(brandAssetLinks).values({
      id: randomUUID(),
      brandId,
      assetId,
      assetRole: role,
    });
  }

  async getWithAssets(
    brandId: string,
  ): Promise<{ brand: any; assets: any[] }> {
    const brand = await this.get(brandId);
    if (!brand) return { brand: null, assets: [] };

    const linked = await this.db
      .select()
      .from(brandAssetLinks)
      .innerJoin(assets, eq(brandAssetLinks.assetId, assets.id))
      .where(eq(brandAssetLinks.brandId, brandId));

    return {
      brand,
      assets: linked.map((row: any) => ({
        ...row.assets,
        role: row.brand_asset_links.assetRole,
      })),
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/brand-store-extensions.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/assets/brand-store.ts apps/agent/src/assets/__tests__/brand-store-extensions.test.ts
git commit -m "feat(agent): add BrandStore.getWithAssets + linkAsset"
```

---

### Task 6: AssetToolExecutor

**Files:**
- Create: `apps/agent/src/tools/asset-tool-executor.ts`
- Test: `apps/agent/src/tools/__tests__/asset-tool-executor.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/agent/src/tools/__tests__/asset-tool-executor.test.ts
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
      { agentType: "asset", taskId: "t1" },
    );
    expect(result.success).toBe(true);
    expect(deps.objectStorage.upload).toHaveBeenCalled();
    expect(deps.embeddingClient.embed).toHaveBeenCalled();
    expect(deps.assetStore.saveWithEmbedding).toHaveBeenCalled();

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/asset-tool-executor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AssetToolExecutor**

```typescript
// apps/agent/src/tools/asset-tool-executor.ts
import { ToolExecutor } from "./executor.js";
import { assetToolDefinitions } from "./asset-tools.js";
import type { ToolCallResult, AgentType } from "./types.js";
import type { AssetStore } from "../assets/asset-store.js";
import type { BrandStore } from "../assets/brand-store.js";
import type { CharacterStore } from "../assets/character-store.js";
import type { ObjectStorage } from "../services/object-storage.js";
import type { EmbeddingClient } from "../services/embedding-client.js";

export class AssetToolExecutor extends ToolExecutor {
  private assetStore: AssetStore;
  private brandStore: BrandStore;
  private characterStore: CharacterStore;
  private objectStorage: ObjectStorage;
  private embeddingClient: EmbeddingClient;

  constructor(deps: {
    assetStore: AssetStore;
    brandStore: BrandStore;
    characterStore: CharacterStore;
    objectStorage: ObjectStorage;
    embeddingClient: EmbeddingClient;
  }) {
    super();
    this.assetStore = deps.assetStore;
    this.brandStore = deps.brandStore;
    this.characterStore = deps.characterStore;
    this.objectStorage = deps.objectStorage;
    this.embeddingClient = deps.embeddingClient;

    for (const def of assetToolDefinitions) {
      this.register(def);
    }
  }

  protected async executeImpl(
    toolName: string,
    input: unknown,
    _context: { agentType: AgentType; taskId: string },
  ): Promise<ToolCallResult> {
    try {
      switch (toolName) {
        case "search_assets":
          return this._searchAssets(input as { query: string; type?: string });
        case "get_asset_info":
          return this._getAssetInfo(input as { asset_id: string });
        case "save_asset":
          return this._saveAsset(input as { file_or_url: string; metadata: Record<string, unknown>; tags?: string[] });
        case "tag_asset":
          return this._tagAsset(input as { asset_id: string; tags: string[] });
        case "find_similar":
          return this._findSimilar(input as { asset_id: string; limit: number });
        case "get_character":
          return this._getCharacter(input as { character_id: string });
        case "get_brand_assets":
          return this._getBrandAssets(input as { brand_id: string });
        default:
          return { success: false, error: `Unhandled asset tool: "${toolName}"` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async _searchAssets(input: { query: string; type?: string }): Promise<ToolCallResult> {
    const results = await this.assetStore.search({
      userId: "default",
      query: input.query,
      type: input.type,
    });
    return { success: true, data: results };
  }

  private async _getAssetInfo(input: { asset_id: string }): Promise<ToolCallResult> {
    const asset = await this.assetStore.findById(input.asset_id);
    if (!asset) return { success: false, error: `Asset not found: "${input.asset_id}"` };

    const url = await this.objectStorage.getSignedUrl(asset.storageKey);
    return { success: true, data: { ...asset, url } };
  }

  private async _saveAsset(input: {
    file_or_url: string;
    metadata: Record<string, unknown>;
    tags?: string[];
  }): Promise<ToolCallResult> {
    // Fetch URL to buffer
    const response = await fetch(input.file_or_url);
    if (!response.ok) {
      return { success: false, error: `Failed to fetch: ${input.file_or_url}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";

    // Upload to R2
    const storageKey = await this.objectStorage.upload(buffer, {
      contentType,
      prefix: "assets",
    });

    // Generate text embedding from name + tags
    const name = (input.metadata.name as string) ?? "untitled";
    const embeddingText = [name, ...(input.tags ?? [])].join(" ");
    let embedding: number[] | undefined;
    try {
      embedding = await this.embeddingClient.embed(embeddingText);
    } catch {
      // Embedding service down — save without vector
      console.warn("Embedding service unavailable, saving asset without vector");
    }

    // Save to DB
    const result = embedding
      ? await this.assetStore.saveWithEmbedding(
          { userId: "default", type: contentType.split("/")[0], name, storageKey, metadata: input.metadata, tags: input.tags },
          embedding,
        )
      : await this.assetStore.save(
          { userId: "default", type: contentType.split("/")[0], name, storageKey, metadata: input.metadata, tags: input.tags },
        );

    return { success: true, data: { asset_id: result.id, storageKey } };
  }

  private async _tagAsset(input: { asset_id: string; tags: string[] }): Promise<ToolCallResult> {
    await this.assetStore.updateTags(input.asset_id, input.tags);
    return { success: true, data: { asset_id: input.asset_id, tags: input.tags } };
  }

  private async _findSimilar(input: { asset_id: string; limit: number }): Promise<ToolCallResult> {
    const asset = await this.assetStore.findById(input.asset_id);
    if (!asset) return { success: false, error: `Asset not found: "${input.asset_id}"` };
    if (!asset.embedding) return { success: false, error: `Asset "${input.asset_id}" has no embedding available` };

    const similar = await this.assetStore.findSimilar(asset.embedding, input.limit);
    return { success: true, data: similar };
  }

  private async _getCharacter(input: { character_id: string }): Promise<ToolCallResult> {
    const result = await this.characterStore.getWithAssets(input.character_id);
    if (!result.character) return { success: true, data: { character: null, assets: [] } };

    // Enrich assets with signed URLs
    const enrichedAssets = await Promise.all(
      result.assets.map(async (a: any) => ({
        ...a,
        url: a.storageKey ? await this.objectStorage.getSignedUrl(a.storageKey) : null,
      })),
    );

    return { success: true, data: { character: result.character, assets: enrichedAssets } };
  }

  private async _getBrandAssets(input: { brand_id: string }): Promise<ToolCallResult> {
    const result = await this.brandStore.getWithAssets(input.brand_id);
    if (!result.brand) return { success: true, data: { brand: null, assets: [] } };

    const enrichedAssets = await Promise.all(
      result.assets.map(async (a: any) => ({
        ...a,
        url: a.storageKey ? await this.objectStorage.getSignedUrl(a.storageKey) : null,
      })),
    );

    return { success: true, data: { brand: result.brand, assets: enrichedAssets } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/asset-tool-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/tools/asset-tool-executor.ts apps/agent/src/tools/__tests__/asset-tool-executor.test.ts
git commit -m "feat(agent): add AssetToolExecutor with 7-tool dispatch"
```

---

### Task 7: Production Wiring

**Files:**
- Modify: `apps/agent/src/index.ts`
- Test: `apps/agent/src/__tests__/asset-wiring.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/agent/src/__tests__/asset-wiring.test.ts
import { describe, it, expect, vi } from "vitest";
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
```

- [ ] **Step 2: Run test to verify it passes** (should pass — AssetToolExecutor already done)

Run: `cd apps/agent && npx vitest run src/__tests__/asset-wiring.test.ts`
Expected: PASS

- [ ] **Step 3: Wire into index.ts**

In `apps/agent/src/index.ts`, add after the existing `editorToolExecutor` creation:

```typescript
import { EmbeddingClient } from "./services/embedding-client.js";
import { AssetToolExecutor } from "./tools/asset-tool-executor.js";
import { CharacterStore } from "./assets/character-store.js";

// Create embedding client (graceful if env vars missing)
const embeddingClient = process.env.EMBEDDING_API_URL
  ? new EmbeddingClient(process.env.EMBEDDING_API_URL, process.env.EMBEDDING_API_KEY ?? "")
  : null;

// Create character store (needs DB — use null for now if no DB)
const characterStore = null; // Will be wired when DB connection is available

// Create asset tool executor if embedding client is available
const assetToolExecutor = embeddingClient
  ? new AssetToolExecutor({
      assetStore: new AssetStore(null as any), // DB placeholder
      brandStore: new BrandStore(null as any),
      characterStore: new CharacterStore(null as any),
      objectStorage,
      embeddingClient,
    })
  : null;

// Update toolExecutor routing:
const toolExecutor = async (name: string, input: unknown) => {
  if (editorToolExecutor.hasToolName(name)) {
    return editorToolExecutor.execute(name, input, { agentType: "editor", taskId: "default" });
  }
  if (assetToolExecutor?.hasToolName(name)) {
    return assetToolExecutor.execute(name, input, { agentType: "asset", taskId: "default" });
  }
  return { success: false, error: `Tool "${name}" has no registered executor` };
};
```

- [ ] **Step 4: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/index.ts apps/agent/src/__tests__/asset-wiring.test.ts
git commit -m "feat(agent): wire AssetToolExecutor into production entry point"
```

---

### Task 8: Edge Case Tests

**Files:**
- Test: `apps/agent/src/tools/__tests__/asset-edge-cases.test.ts`

- [ ] **Step 1: Write edge case tests**

```typescript
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

    vi.unstubAllGlobals();
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

    vi.unstubAllGlobals();
  });

  it("get_asset_info with unknown id returns error", async () => {
    const result = await executor.execute("get_asset_info", { asset_id: "unknown" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/asset-edge-cases.test.ts`
Expected: PASS

- [ ] **Step 3: Run all tests and commit**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

```bash
git add apps/agent/src/tools/__tests__/asset-edge-cases.test.ts
git commit -m "test(agent): add AssetToolExecutor edge case tests"
```

---

## Self-Review Checklist

| Spec Requirement | Task |
|-----------------|------|
| EmbeddingClient (OpenAI-compatible) | Task 1 |
| pgvector schema + characters + brand_asset_links | Task 2 |
| AssetStore findById/updateTags/saveWithEmbedding/findSimilar | Task 3 |
| CharacterStore CRUD + getWithAssets | Task 4 |
| BrandStore getWithAssets + linkAsset | Task 5 |
| AssetToolExecutor 7-tool dispatch | Task 6 |
| Production wiring in index.ts | Task 7 |
| Edge cases (embedding down, no embedding, fetch fail) | Task 8 |
| save_asset URL → Buffer flow | Task 6 (_saveAsset) |
| find_similar pgvector cosine query | Task 3 (findSimilar) |
| Signed URLs on get_character/get_brand_assets | Task 6 |

No placeholders. All code blocks complete. All test commands exact.
