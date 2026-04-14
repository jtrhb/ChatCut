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

  /** Validate a resolved IP address against private/internal ranges. */
  private validateResolvedIp(ip: string): string | null {
    // IPv4 checks
    if (ip.startsWith("127.") || ip === "0.0.0.0") return "Loopback address";
    if (ip.startsWith("10.")) return "Private network (10.x)";
    if (ip.startsWith("192.168.")) return "Private network (192.168.x)";
    if (ip.startsWith("169.254.")) return "Link-local / cloud metadata";
    if (ip.startsWith("172.")) {
      const second = parseInt(ip.split(".")[1], 10);
      if (second >= 16 && second <= 31) return "Private network (172.16-31.x)";
    }
    // IPv6 checks
    const ipLower = ip.toLowerCase();
    if (ipLower === "::1" || ipLower === "::") return "Loopback address";
    if (ipLower.startsWith("fe80:")) return "Link-local IPv6";
    if (ipLower.startsWith("fc00:") || ipLower.startsWith("fd00:")) return "Unique-local IPv6";
    if (ipLower.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 — may be dotted (::ffff:10.0.0.1) or hex (::ffff:a00:1)
      const mapped = ipLower.slice(7);
      if (mapped.includes(".")) {
        return this.validateResolvedIp(mapped);
      }
      // Hex format: parse two 16-bit groups into IPv4 octets
      const hexParts = mapped.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return this.validateResolvedIp(ipv4);
      }
    }
    return null;
  }

  /** Validate URL to prevent SSRF — only allow https with public hosts. */
  private validateAssetUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return "Only HTTPS URLs are allowed";

      const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

      // Block loopback (127.x.x.x, ::1, IPv6-mapped loopback)
      if (host === "localhost" || host.startsWith("127.") || host === "0.0.0.0" ||
          host === "::1" || host === "0:0:0:0:0:0:0:1" ||
          host.startsWith("::ffff:127.") || host.startsWith("::ffff:7f")) {
        return "Loopback addresses are not allowed";
      }

      // Block private RFC-1918 ranges
      if (host.startsWith("10.") || host.startsWith("192.168.")) {
        return "Private network addresses are not allowed";
      }
      // 172.16.0.0 - 172.31.255.255
      if (host.startsWith("172.")) {
        const second = parseInt(host.split(".")[1], 10);
        if (second >= 16 && second <= 31) return "Private network addresses are not allowed";
      }

      // Block link-local (169.254.x.x — cloud metadata endpoint)
      if (host.startsWith("169.254.")) {
        return "Link-local addresses are not allowed (cloud metadata protection)";
      }

      // Block IPv6-mapped private addresses (dotted and hex formats)
      if (host.startsWith("::ffff:10.") || host.startsWith("::ffff:192.168.") ||
          host.startsWith("::ffff:169.254.")) {
        return "IPv6-mapped private addresses are not allowed";
      }
      // Node canonicalizes ::ffff:10.0.0.1 to ::ffff:a00:1 — check hex format too
      if (host.startsWith("::ffff:")) {
        const hexPart = host.slice(7);
        if (!hexPart.includes(".") && hexPart.includes(":")) {
          const parts = hexPart.split(":");
          if (parts.length === 2) {
            const hi = parseInt(parts[0], 16);
            const ipv4First = (hi >> 8) & 0xff;
            if (ipv4First === 10 || ipv4First === 127 || ipv4First === 169 || ipv4First === 192) {
              return "IPv6-mapped private addresses are not allowed (hex format)";
            }
          }
        }
      }

      // Block internal domains
      if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
        return "Internal domain names are not allowed";
      }

      // Block raw IPv6 private ranges (fe80::, fc00::, fd00::)
      const hostLower = host.toLowerCase();
      if (hostLower.startsWith("fe80:") || hostLower.startsWith("fc00:") ||
          hostLower.startsWith("fd00:")) {
        return "IPv6 private addresses are not allowed";
      }

      return null; // valid
    } catch {
      return "Invalid URL format";
    }
  }

  /**
   * Fetch a URL with full SSRF protection:
   * 1. Validate URL format + hostname string
   * 2. DNS resolve + validate resolved IP (prevents rebinding)
   * 3. Fetch with redirect:"manual" + 30s timeout
   * 4. If redirect, repeat steps 1-3 for the Location URL (max 1 hop)
   */
  private async safeFetch(url: string): Promise<{ response: Response } | { error: string }> {
    // Step 1: URL validation
    const urlError = this.validateAssetUrl(url);
    if (urlError) return { error: `URL rejected: ${urlError}` };

    // Step 2: DNS resolution + IP validation (prevents TOCTOU rebinding)
    try {
      const { hostname } = new URL(url);
      const dns = await import("dns/promises");
      const { address } = await dns.lookup(hostname);
      const ipError = this.validateResolvedIp(address);
      if (ipError) return { error: `DNS resolved to blocked IP: ${ipError}` };
    } catch {
      return { error: "DNS resolution failed for URL" };
    }

    // Step 3: Fetch with no auto-redirect
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    } catch (err) {
      clearTimeout(timeout);
      return { error: `Failed to fetch: ${err instanceof Error ? err.message : String(err)}` };
    }
    clearTimeout(timeout);

    // Step 4: Handle redirect — full re-validation of redirect target
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { error: "Redirect with no Location header" };

      // Recursion-safe: redirect target goes through the same validation but with redirect:"error"
      const redirectUrlError = this.validateAssetUrl(location);
      if (redirectUrlError) return { error: `Redirect blocked: ${redirectUrlError}` };

      try {
        const { hostname: rHost } = new URL(location);
        const dns = await import("dns/promises");
        const { address: rAddr } = await dns.lookup(rHost);
        const rIpError = this.validateResolvedIp(rAddr);
        if (rIpError) return { error: `Redirect DNS resolved to blocked IP: ${rIpError}` };
      } catch {
        return { error: "DNS resolution failed for redirect URL" };
      }

      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 30_000);
      try {
        response = await fetch(location, { signal: controller2.signal, redirect: "error" });
      } catch (err) {
        clearTimeout(timeout2);
        return { error: `Failed to fetch redirect: ${err instanceof Error ? err.message : String(err)}` };
      }
      clearTimeout(timeout2);
    }

    if (!response.ok) return { error: `Failed to fetch: ${url} (${response.status})` };
    return { response };
  }

  private async _saveAsset(input: {
    file_or_url: string;
    metadata: Record<string, unknown>;
    tags?: string[];
  }): Promise<ToolCallResult> {
    const MAX_ASSET_SIZE = 100 * 1024 * 1024; // 100MB

    // SSRF-safe fetch with DNS validation + redirect protection
    const fetchResult = await this.safeFetch(input.file_or_url);
    if ("error" in fetchResult) return { success: false, error: fetchResult.error };
    const response = fetchResult.response;

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

    let result: { id: string };
    if (embedding) {
      result = await this.assetStore.saveWithEmbedding(saveParams, embedding);
    } else if (this.assetStore.save) {
      result = await this.assetStore.save(saveParams);
    } else {
      return { success: false, error: "Cannot save asset: AssetStore.save is not available" };
    }

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
