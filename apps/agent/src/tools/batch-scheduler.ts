import type { ToolDefinition } from "./types.js";

interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

type Batch = ToolUseBlock[];

/**
 * Build order-preserving batches from tool_use blocks.
 * Consecutive concurrent-safe tools merge into parallel batches.
 * A non-concurrent-safe tool forms its own single-item batch (barrier).
 */
export function buildOrderPreservingBatches(
  blocks: ToolUseBlock[],
  registry: Map<string, ToolDefinition>,
): Batch[] {
  const batches: Batch[] = [];
  let currentBatch: Batch = [];
  let currentBatchIsConcurrent = true;

  for (const block of blocks) {
    const tool = registry.get(block.name);
    const isSafe = tool?.isConcurrencySafe ?? false; // fail-closed default

    if (isSafe && currentBatchIsConcurrent) {
      currentBatch.push(block);
    } else {
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [block];
      currentBatchIsConcurrent = isSafe;
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  return batches;
}
