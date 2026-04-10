import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import type { OverflowStore } from "./overflow-store.js";

export const ReadOverflowSchema = z.object({
  ref: z.string(),
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).default(30000),
});

export function createReadOverflowTool(): ToolDefinition {
  return {
    name: "read_overflow",
    description:
      "Read full or paginated content from an overflow reference. Use when a tool result returns { preview, ref, size_bytes } to access the complete data.",
    inputSchema: ReadOverflowSchema,
    agentTypes: ["master", "editor", "vision", "creator", "audio", "asset"],
    accessMode: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    shouldDefer: false,
  };
}

export function executeReadOverflow(
  input: z.infer<typeof ReadOverflowSchema>,
  overflowStore: OverflowStore,
): { success: boolean; data?: unknown; error?: string } {
  const result = overflowStore.read(input.ref, input.offset, input.limit);

  if (!result) {
    return {
      success: false,
      error: `Overflow ref not found: "${input.ref}". It may have been evicted or the session may have expired.`,
    };
  }

  return {
    success: true,
    data: {
      content: result.content,
      total_chars: result.total_chars,
      offset: result.offset,
      has_more: result.has_more,
    },
  };
}
