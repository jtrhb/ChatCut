# Complete Asset Agent Design Spec

## Overview

Implement all 7 asset tool executors with real backends: R2 file storage, PostgreSQL + pgvector for metadata and similarity search, Gemini Embedding 2 (via fly.io OpenAI-compatible endpoint) for multimodal embeddings, and character/brand asset relations.

## Technical Stack

| Component | Choice |
|-----------|--------|
| Embedding | Gemini Embedding 2 via fly.io (OpenAI-compatible `/v1/embeddings`) |
| Vector storage | pgvector extension on existing PostgreSQL |
| File storage | Cloudflare R2 via existing `ObjectStorage` |
| Vector dimensions | 768 (Gemini Embedding 2 default) |
| Scope | All 7 tools fully operational |

## Architecture

```
AssetAgent.dispatch(task)
  ↓
AssetToolExecutor.executeImpl(toolName, input)
  ├── search_assets  → AssetStore.search(query, type)
  ├── get_asset_info → AssetStore.findById(id) + ObjectStorage.getSignedUrl(key)
  ├── save_asset     → ObjectStorage.upload(file) + EmbeddingClient.embed(file) + AssetStore.saveWithEmbedding(meta, vector)
  ├── tag_asset      → AssetStore.updateTags(id, tags)
  ├── find_similar   → AssetStore.findSimilar(embedding, limit) via pgvector <=> operator
  ├── get_character  → CharacterStore.getWithAssets(name) + ObjectStorage.getSignedUrl per ref
  └── get_brand_assets → BrandStore.getWithAssets(brandId) + ObjectStorage.getSignedUrl per asset
```

## Components

### 1. EmbeddingClient

**Location**: `apps/agent/src/services/embedding-client.ts` (new)

Calls the fly.io-deployed Gemini Embedding 2 service via OpenAI-compatible interface.

```ts
export class EmbeddingClient {
  constructor(private apiUrl: string, private apiKey: string) {}

  async embed(input: string, dimensions?: number): Promise<number[]>;
  async embedBatch(inputs: string[], dimensions?: number): Promise<number[][]>;
}
```

**Request format** (OpenAI-compatible):
```json
POST {apiUrl}/v1/embeddings
{
  "model": "gemini-embedding-2",
  "input": "description of the asset",
  "dimensions": 768
}
```

**Response**: `{ data: [{ embedding: number[] }] }`

**For images/video**: Pass base64-encoded content or URL as input. The fly.io service handles multimodal routing internally.

**Environment variables**:
```
EMBEDDING_API_URL=https://gemini-embed.fly.dev
EMBEDDING_API_KEY=<api key>
```

### 2. pgvector Schema Migration

**Location**: `apps/agent/src/db/schema.ts`

Add pgvector extension and embedding column to assets table:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE assets ADD COLUMN embedding vector(768);
CREATE INDEX assets_embedding_idx ON assets USING hnsw (embedding vector_cosine_ops);
```

In Drizzle ORM, add a custom column type for vector(768). Use raw SQL for the HNSW index since Drizzle doesn't natively support pgvector index types.

### 3. AssetStore Extensions

**Location**: `apps/agent/src/assets/asset-store.ts` (modify)

Existing: `save()`, `search()`. Add:

```ts
async findById(id: string): Promise<Asset | null>;
async updateTags(id: string, tags: string[]): Promise<void>;
async saveWithEmbedding(params: AssetSaveParams, embedding: number[]): Promise<{ id: string }>;
async findSimilar(embedding: number[], limit?: number): Promise<Asset[]>;
```

`findSimilar` uses pgvector's `<=>` cosine distance operator:
```sql
SELECT *, embedding <=> $1::vector AS distance
FROM assets
WHERE embedding IS NOT NULL
ORDER BY distance ASC
LIMIT $2
```

### 4. Character/Brand Relations

**Location**: `apps/agent/src/db/schema.ts` (modify), new store files

**New tables**:

```ts
// characters table
export const characters = pgTable("characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  projectId: uuid("project_id").references(() => projects.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// character_assets join table
export const characterAssets = pgTable("character_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  characterId: uuid("character_id").references(() => characters.id).notNull(),
  assetId: uuid("asset_id").references(() => assets.id).notNull(),
  role: text("role").default("reference").notNull(), // "reference", "thumbnail", "full_body"
});

// brand_asset_links join table
export const brandAssetLinks = pgTable("brand_asset_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id").references(() => brandKits.id).notNull(),
  assetId: uuid("asset_id").references(() => assets.id).notNull(),
  assetRole: text("asset_role").notNull(), // "logo", "font", "color_palette", "template"
});
```

**CharacterStore** — `apps/agent/src/assets/character-store.ts` (new):
```ts
export class CharacterStore {
  constructor(private db: any) {}
  async getByName(name: string, projectId?: string): Promise<Character | null>;
  async getWithAssets(characterId: string): Promise<{ character: Character; assets: Asset[] }>;
  async create(params: { name: string; description?: string; projectId?: string }): Promise<{ id: string }>;
  async linkAsset(characterId: string, assetId: string, role?: string): Promise<void>;
}
```

**BrandStore extensions** — `apps/agent/src/assets/brand-store.ts` (modify):
```ts
// Add to existing BrandStore:
async getWithAssets(brandId: string): Promise<{ brand: BrandKit; assets: Array<Asset & { role: string }> }>;
async linkAsset(brandId: string, assetId: string, role: string): Promise<void>;
```

### 5. AssetToolExecutor

**Location**: `apps/agent/src/tools/asset-tool-executor.ts` (new)

Follows the EditorToolExecutor pattern — extends `ToolExecutor`, implements `executeImpl()` with switch dispatch.

```ts
export class AssetToolExecutor extends ToolExecutor {
  constructor(deps: {
    assetStore: AssetStore;
    brandStore: BrandStore;
    characterStore: CharacterStore;
    objectStorage: ObjectStorage;
    embeddingClient: EmbeddingClient;
  }) {
    super();
    // register all ASSET_TOOL_DEFINITIONS
  }

  protected async executeImpl(toolName: string, input: unknown, context): Promise<ToolCallResult> {
    switch (toolName) {
      case "search_assets": return this._searchAssets(input);
      case "get_asset_info": return this._getAssetInfo(input);
      case "save_asset": return this._saveAsset(input);
      case "tag_asset": return this._tagAsset(input);
      case "find_similar": return this._findSimilar(input);
      case "get_character": return this._getCharacter(input);
      case "get_brand_assets": return this._getBrandAssets(input);
    }
  }
}
```

**Tool implementations**:

| Tool | Logic |
|------|-------|
| search_assets | `AssetStore.search(query, type)` → return matches with signed URLs |
| get_asset_info | `AssetStore.findById(id)` → enrich with `ObjectStorage.getSignedUrl(storageKey)` |
| save_asset | Upload to R2 → generate embedding via EmbeddingClient → save to DB with vector |
| tag_asset | `AssetStore.updateTags(id, tags)` |
| find_similar | `AssetStore.findById(id)` → get embedding → `AssetStore.findSimilar(embedding, limit)` |
| get_character | `CharacterStore.getByName(name)` → `getWithAssets()` → signed URLs for each ref |
| get_brand_assets | `BrandStore.getWithAssets(brandId)` → signed URLs for each asset |

### 6. Production Wiring

**Location**: `apps/agent/src/index.ts` (modify)

```ts
import { EmbeddingClient } from "./services/embedding-client.js";
import { AssetToolExecutor } from "./tools/asset-tool-executor.js";
import { CharacterStore } from "./assets/character-store.js";

const embeddingClient = new EmbeddingClient(
  process.env.EMBEDDING_API_URL!,
  process.env.EMBEDDING_API_KEY!,
);

const characterStore = new CharacterStore(db);
const assetToolExecutor = new AssetToolExecutor({
  assetStore, brandStore, characterStore, objectStorage, embeddingClient,
});

// Extend toolExecutor routing:
const toolExecutor = async (name: string, input: unknown) => {
  if (editorToolExecutor.hasToolName(name)) {
    return editorToolExecutor.execute(name, input, { agentType: "editor", taskId: "default" });
  }
  if (assetToolExecutor.hasToolName(name)) {
    return assetToolExecutor.execute(name, input, { agentType: "asset", taskId: "default" });
  }
  return { success: false, error: `Tool "${name}" has no registered executor` };
};
```

## Dependencies

| Dependency | Status | Action |
|-----------|--------|--------|
| ObjectStorage (R2) | Implemented | No changes |
| AssetStore (DB) | Implemented (save/search) | Add findById, updateTags, saveWithEmbedding, findSimilar |
| BrandStore (DB) | Implemented (create/get) | Add getWithAssets, linkAsset |
| ToolExecutor base class | Implemented | No changes |
| pgvector extension | Not installed | `CREATE EXTENSION vector` on PostgreSQL |
| Gemini Embedding fly.io | Deployed | Wire EmbeddingClient with env vars |

## Environment Variables

```
EMBEDDING_API_URL=https://gemini-embed.fly.dev
EMBEDDING_API_KEY=<api key>
```

(R2 env vars already configured from Phase 5 Skill Crystallization)

## Acceptance Tests

### Unit Tests
1. EmbeddingClient.embed() returns 768-dim vector from mock API
2. EmbeddingClient.embedBatch() handles multiple inputs
3. AssetStore.findById returns asset with all fields
4. AssetStore.updateTags replaces tags array
5. AssetStore.saveWithEmbedding stores vector alongside metadata
6. AssetStore.findSimilar returns ordered by cosine distance
7. CharacterStore.getByName finds by name + optional projectId
8. CharacterStore.getWithAssets returns character + linked assets
9. BrandStore.getWithAssets returns brand + linked assets with roles
10. AssetToolExecutor routes all 7 tools correctly

### Integration Tests
11. save_asset: upload file → embed → store → verify in DB with vector
12. find_similar: save 3 assets with embeddings → query → returns ordered by similarity
13. get_character: create character + link assets → query → returns with signed URLs
14. get_brand_assets: create brand + link assets → query → returns with roles
15. Full dispatch: AssetAgent.dispatch({ task: "find similar to asset X" }) → real result

### Edge Cases
16. save_asset with embedding service down → saves without vector, logs warning
17. find_similar on asset without embedding → returns error "no embedding available"
18. get_character with unknown name → returns empty result, not error
19. search_assets with no matches → returns empty array

## Non-Goals

- No real-time embedding index rebuilding (batch re-embed later if needed)
- No asset deduplication (same file uploaded twice = two assets)
- No asset versioning (overwrite-only)
- No video/audio embedding (text description embedding only for v1, multimodal later)

## File Structure

```
apps/agent/src/
├── services/
│   └── embedding-client.ts        (new) Gemini Embedding 2 client
├── db/
│   └── schema.ts                  (modify) pgvector column + characters + brand_asset_links tables
├── assets/
│   ├── asset-store.ts             (modify) Add findById, updateTags, saveWithEmbedding, findSimilar
│   ├── brand-store.ts             (modify) Add getWithAssets, linkAsset
│   └── character-store.ts         (new) Character CRUD + asset linking
├── tools/
│   └── asset-tool-executor.ts     (new) 7-tool switch dispatch
└── index.ts                       (modify) Wire EmbeddingClient, AssetToolExecutor, CharacterStore
```
