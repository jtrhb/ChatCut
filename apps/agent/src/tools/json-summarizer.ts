/**
 * Default JSON summarizer for tool results that exceed maxResultSizeChars.
 * Preserves top-level keys, truncates arrays to first 3 elements,
 * and truncates the final output to maxChars.
 */
export function summarizeJson(value: unknown, maxChars?: number): string {
  const summarized = summarizeValue(value, 0);
  const result = JSON.stringify(summarized, null, 2);

  if (maxChars && result.length > maxChars) {
    return result.slice(0, maxChars - 14) + "...(truncated)";
  }

  return result;
}

function summarizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return summarizeArray(value, depth);
  }

  if (typeof value === "object") {
    return summarizeObject(value as Record<string, unknown>, depth);
  }

  // Primitives pass through
  return value;
}

function summarizeArray(arr: unknown[], depth: number): unknown {
  if (arr.length === 0) return [];

  const kept = arr.slice(0, 3).map((item) => summarizeValue(item, depth + 1));

  if (arr.length > 3) {
    kept.push(`...and ${arr.length - 3} more`);
  }

  return kept;
}

function summarizeObject(
  obj: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    result[key] = summarizeValue(val, depth + 1);
  }

  return result;
}
