import type { RuntimeEvent } from "./types.js";

export function serializeEvent(event: RuntimeEvent): { event: string; data: string } {
  const { type, data, ...rest } = event;
  return { event: type, data: JSON.stringify({ ...data, ...rest }) };
}
