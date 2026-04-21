import type { RuntimeEvent } from "./types.js";

/**
 * Serialize a RuntimeEvent into the SSE wire shape.
 *
 * The returned `event` field is consumed by `hono/streaming.writeSSE` and
 * becomes the SSE `event:` line — browsers route those events to
 * `EventSource.addEventListener(<type>, ...)`. They do NOT fire on
 * `EventSource.onmessage`, which only delivers messages with an empty
 * (default) event name.
 *
 * Phase 5b: include `type` in the JSON payload so consumers reading via
 * `onmessage` (the existing `apps/web/src/hooks/use-chat.ts` pattern,
 * which discriminates on `data.type`) can still discriminate even if the
 * SSE pipe is later restructured to use the default channel — and so
 * downstream consumers logging the parsed payload have the type onhand
 * without re-correlating to the SSE event name. Keeps both delivery
 * idioms working off one serializer.
 */
export function serializeEvent(event: RuntimeEvent): {
	event: string;
	data: string;
} {
	const { type, data, ...rest } = event;
	return { event: type, data: JSON.stringify({ type, ...data, ...rest }) };
}
