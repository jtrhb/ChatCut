import type { RuntimeEvent } from "./types.js";

/**
 * Serialize a RuntimeEvent into the SSE wire shape.
 *
 * Wire format (since pre-Phase-5b): `data` is FLATTENED onto the top
 * level of the JSON payload alongside the envelope fields (timestamp,
 * sessionId, taskId). Web consumers (`apps/web/src/hooks/use-chat.ts`)
 * read the data fields as top-level properties — `parsed.text` not
 * `parsed.data.text`.
 *
 * Phase 5b: also include `type` in the JSON payload so consumers reading
 * via `EventSource.onmessage` can discriminate on `parsed.type`. Without
 * this, browsers route named-event SSE messages ONLY to
 * `addEventListener(<type>, ...)` — `onmessage` would never fire, leaving
 * the existing web hook unable to see typed events at all.
 *
 * Reviewer Phase 5b HIGH-1 fix: spread order is `{ ...data, ...rest, type }`
 * so the canonical envelope `type` ALWAYS wins over a colliding key
 * inside `data`. A future emit that ships `data: { type: "subtype" }`
 * would otherwise silently overwrite the canonical event-type
 * discriminator and break SSE event routing on the web client. Same
 * principle applies to `timestamp`/`sessionId`/`taskId` — `rest` (the
 * envelope) wins over `data`.
 */
export function serializeEvent(event: RuntimeEvent): {
	event: string;
	data: string;
} {
	const { type, data, ...rest } = event;
	return { event: type, data: JSON.stringify({ ...data, ...rest, type }) };
}
