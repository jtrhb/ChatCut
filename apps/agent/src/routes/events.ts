import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../events/event-bus.js";
import { serializeEvent } from "../events/event-protocol.js";

/**
 * B7: Per-session SSE filter. Previously this route piped every event
 * on the bus to every connected client, which let User A see User B's
 * tool calls, token usage, changeset activity, etc. (security C4).
 *
 * Now the route requires a `sessionId` — via query param or
 * `x-session-id` header — and delivers only events whose top-level
 * `sessionId` matches. Events without a sessionId (system-wide
 * announcements) are intentionally NOT leaked to session subscribers.
 */
export function createEventsRouter(deps: { eventBus: EventBus }) {
  const router = new Hono();

  router.get("/", (c) => {
    const sessionId =
      c.req.query("sessionId") ?? c.req.header("x-session-id") ?? "";

    if (!sessionId) {
      return c.json(
        { error: "Missing sessionId (pass as ?sessionId= or x-session-id header)" },
        400,
      );
    }

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ message: "SSE connection established", sessionId }),
      });

      const unsub = deps.eventBus.onAll(async (event) => {
        if (event.sessionId !== sessionId) return;
        try {
          const sse = serializeEvent(event);
          await stream.writeSSE(sse);
        } catch {
          // stream may have closed
        }
      });

      stream.onAbort(() => { unsub(); });
      await new Promise(() => {});
    });
  });

  return router;
}
