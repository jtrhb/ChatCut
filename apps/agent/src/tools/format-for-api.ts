import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition, ToolFormatContext } from "./types.js";

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

/**
 * Convert an array of ToolDefinitions to Anthropic API format.
 *
 * When ctx is provided:
 *   - Tools with isEnabled are filtered (fail-closed on throw)
 *   - Tools with descriptionSuffix get the suffix appended
 * Output is always sorted by name for deterministic cache keys.
 */
export function formatToolsForApi(
  tools: ToolDefinition[],
  ctx?: ToolFormatContext,
): ApiToolFormat[] {
  let filtered = tools;
  if (ctx) {
    filtered = tools.filter((t) => {
      if (!t.isEnabled) return true;
      try {
        return t.isEnabled(ctx.filterContext);
      } catch {
        console.warn(`isEnabled threw for tool "${t.name}", disabling it (fail-closed)`);
        return false;
      }
    });
  }

  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));

  return sorted.map((t) => {
    let description = t.description;
    if (ctx && t.descriptionSuffix) {
      try {
        const suffix = t.descriptionSuffix(ctx.descriptionContext);
        if (suffix) description = `${description} ${suffix}`;
      } catch {
        console.warn(`descriptionSuffix threw for tool "${t.name}", skipping suffix`);
      }
    }
    return formatToolForApi({ ...t, description });
  });
}
