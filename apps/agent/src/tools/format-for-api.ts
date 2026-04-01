import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "./types.js";

/**
 * Format contract: Anthropic SDK expects tools as:
 * { name: string, description: string, input_schema: JSONSchema }
 *
 * Our ToolDefinition uses Zod schemas for runtime validation.
 * This utility converts Zod → JSON Schema for the API boundary.
 */

export interface ApiToolFormat {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Convert a single ToolDefinition to Anthropic API format. */
export function formatToolForApi(def: ToolDefinition): ApiToolFormat {
  const jsonSchema = zodToJsonSchema(def.inputSchema, {
    $refStrategy: "none",
    target: "openApi3",
  });

  // Remove $schema and top-level metadata that Anthropic doesn't need
  const { $schema, ...schema } = jsonSchema as Record<string, unknown>;

  return {
    name: def.name,
    description: def.description,
    input_schema: schema,
  };
}

/** Convert an array of ToolDefinitions to Anthropic API format. */
export function formatToolsForApi(defs: ToolDefinition[]): ApiToolFormat[] {
  return defs.map(formatToolForApi);
}
