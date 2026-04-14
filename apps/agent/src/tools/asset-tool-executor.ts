import { ToolExecutor } from "./executor.js";
import { assetToolDefinitions } from "./asset-tools.js";
import type { ToolCallResult, AgentType } from "./types.js";

export interface AssetToolDeps {
  assetStore: {
    search(params: { userId: string; query: string; type?: string }): Promise<unknown[]>;
    findById(id: string): Promise<any | null>;
    updateTags(id: string, tags: string[]): Promise<void>;
    saveWithEmbedding(
      params: { userId: string; type: string; name: string; storageKey: string; metadata?: Record<string, unknown>; tags?: string[] },
      embedding: number[],
    ): Promise<{ id: string }>;
    save?(
      params: { userId: string; type: string; name: string; storageKey: string; metadata?: Record<string, unknown>; tags?: string[] },
    ): Promise<{ id: string }>;
    findSimilar(embedding: number[], limit: number): Promise<unknown[]>;
  };
  brandStore: {
    getWithAssets(brandId: string): Promise<{ brand: any; assets: any[] }>;
  };
  characterStore: {
    getById(id: string): Promise<any | null>;
    getWithAssets(characterId: string): Promise<{ character: any; assets: any[] }>;
  };
  objectStorage: {
    upload(buffer: Buffer, opts: { contentType: string; prefix: string }): Promise<string>;
    getSignedUrl(key: string): Promise<string>;
  };
  embeddingClient: {
    embed(text: string): Promise<number[]>;
  };
}

export class AssetToolExecutor extends ToolExecutor {
  private assetStore: AssetToolDeps["assetStore"];
  private brandStore: AssetToolDeps["brandStore"];
  private characterStore: AssetToolDeps["characterStore"];
  private objectStorage: AssetToolDeps["objectStorage"];
  private embeddingClient: AssetToolDeps["embeddingClient"];

  constructor(deps: AssetToolDeps) {
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
      userId: "unscoped", // TODO: Thread userId from session context for tenant isolation
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

  /** Validate URL to prevent SSRF — only allow https with public hosts. */
  private validateAssetUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return "Only HTTPS URLs are allowed";
      // Block internal/private IPs
      const host = parsed.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
          host.startsWith("10.") || host.startsWith("192.168.") ||
          host.startsWith("172.") || host.endsWith(".internal") ||
          host.endsWith(".local") || host === "[::1]") {
        return "Internal/private URLs are not allowed";
      }
      return null; // valid
    } catch {
      return "Invalid URL format";
    }
  }

  private async _saveAsset(input: {
    file_or_url: string;
    metadata: Record<string, unknown>;
    tags?: string[];
  }): Promise<ToolCallResult> {
    // SSRF protection
    const urlError = this.validateAssetUrl(input.file_or_url);
    if (urlError) return { success: false, error: `URL rejected: ${urlError}` };

    const MAX_ASSET_SIZE = 100 * 1024 * 1024; // 100MB
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    let response: Response;
    try {
      response = await fetch(input.file_or_url, { signal: controller.signal });
    } catch (err) {
      clearTimeout(timeout);
      return { success: false, error: `Failed to fetch: ${err instanceof Error ? err.message : String(err)}` };
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `Failed to fetch: ${input.file_or_url} (${response.status})` };
    }

    // Check content-length before downloading
    const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_ASSET_SIZE) {
      return { success: false, error: `Asset too large: ${contentLength} bytes (max ${MAX_ASSET_SIZE})` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ASSET_SIZE) {
      return { success: false, error: `Asset too large: ${buffer.length} bytes (max ${MAX_ASSET_SIZE})` };
    }
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";

    const storageKey = await this.objectStorage.upload(buffer, {
      contentType,
      prefix: "assets",
    });

    const name = (input.metadata.name as string) ?? "untitled";
    const embeddingText = [name, ...(input.tags ?? [])].join(" ");
    let embedding: number[] | undefined;
    try {
      embedding = await this.embeddingClient.embed(embeddingText);
    } catch {
      // Embedding service down -- save without vector
    }

    const saveParams = {
      userId: "unscoped", // TODO: Thread userId from session context for tenant isolation
      type: contentType.split("/")[0],
      name,
      storageKey,
      metadata: input.metadata,
      tags: input.tags,
    };

    const result = embedding
      ? await this.assetStore.saveWithEmbedding(saveParams, embedding)
      : await this.assetStore.save!(saveParams);

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
