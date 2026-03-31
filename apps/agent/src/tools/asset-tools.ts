import { z } from "zod";
import type { ToolDefinition } from "./types.js";

// ── Zod Schemas ──────────────────────────────────────────────────────────────

export const SearchAssetsSchema = z.object({
  query: z.string(),
  type: z.enum(["video", "image", "audio"]).optional(),
});

export const GetAssetInfoSchema = z.object({
  asset_id: z.string(),
});

export const SaveAssetSchema = z.object({
  file_or_url: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()).optional(),
});

export const TagAssetSchema = z.object({
  asset_id: z.string(),
  tags: z.array(z.string()),
});

export const FindSimilarSchema = z.object({
  asset_id: z.string(),
  limit: z.number().default(5),
});

export const GetCharacterSchema = z.object({
  character_id: z.string(),
});

export const GetBrandAssetsSchema = z.object({
  brand_id: z.string(),
});

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const assetToolDefinitions: ToolDefinition[] = [
  {
    name: "search_assets",
    description: "Search the asset library by query text and optional media type",
    inputSchema: SearchAssetsSchema,
    agentTypes: ["asset"],
    accessMode: "read",
  },
  {
    name: "get_asset_info",
    description: "Retrieve detailed metadata for a specific asset by ID",
    inputSchema: GetAssetInfoSchema,
    agentTypes: ["asset"],
    accessMode: "read",
  },
  {
    name: "save_asset",
    description: "Save a file or URL as a new asset with metadata and optional tags",
    inputSchema: SaveAssetSchema,
    agentTypes: ["asset"],
    accessMode: "write",
  },
  {
    name: "tag_asset",
    description: "Apply or replace tags on an existing asset",
    inputSchema: TagAssetSchema,
    agentTypes: ["asset"],
    accessMode: "write",
  },
  {
    name: "find_similar",
    description: "Find assets visually or semantically similar to a given asset",
    inputSchema: FindSimilarSchema,
    agentTypes: ["asset"],
    accessMode: "read",
  },
  {
    name: "get_character",
    description: "Retrieve character reference assets and metadata by character ID",
    inputSchema: GetCharacterSchema,
    agentTypes: ["asset"],
    accessMode: "read",
  },
  {
    name: "get_brand_assets",
    description: "Retrieve brand kit assets (logos, colors, fonts) by brand ID",
    inputSchema: GetBrandAssetsSchema,
    agentTypes: ["asset"],
    accessMode: "read",
  },
];
