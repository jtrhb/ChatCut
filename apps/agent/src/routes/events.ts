import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../events/event-bus.js";
import { serializeEvent } from "../events/event-protocol.js";

export function createEventsRouter(deps: { eventBus: EventBus }) {
  const router = new Hono();

  router.get("/", (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ message: "SSE connection established" }),
      });

      const unsub = deps.eventBus.onAll(async (event) => {
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

