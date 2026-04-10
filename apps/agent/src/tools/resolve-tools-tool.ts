import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const ResolveToolsSchema = z.object({
  names: z.array(z.string()).optional(),
  search: z.string().optional(),
}).refine((d) => (d.names && d.names.length > 0) || !!d.search, {
  message: "At least one of 'names' or 'search' is required",
});

export function createResolveToolsTool(): ToolDefinition {
  return {
    name: "resolve_tools",
    description: "Load full schema for deferred tools by name or keyword search",
    inputSchema: ResolveToolsSchema,
    agentTypes: ["master"],
    accessMode: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    shouldDefer: false, // resolve_tools itself is never deferred
  };
}
