import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const events = new Hono();

events.get("/", (c) => {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ message: "SSE connection established" }),
    });
  });
});

export { events };
