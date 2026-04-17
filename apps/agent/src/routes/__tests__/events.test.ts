import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createEventsRouter } from "../events.js";
import { EventBus } from "../../events/event-bus.js";
import type { RuntimeEvent } from "../../events/types.js";

/**
 * Read from an SSE ReadableStream until `predicate(accumulated)` returns
 * true, or timeoutMs elapses. Returns the concatenated text. Used to drain
 * SSE responses deterministically in tests — the route's handler blocks
 * on `await new Promise(() => {})` so the stream never closes on its own.
 */
async function consumeUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (acc: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read().then((r) => ({ kind: "chunk" as const, ...r })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), remaining),
      ),
    ]);
    if (result.kind === "timeout") break;
    if (result.done) break;
    acc += decoder.decode(result.value, { stream: true });
    if (predicate(acc)) break;
  }
  return acc;
}

function makeEvent(over: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    type: "tool.called",
    timestamp: Date.now(),
    data: {},
    ...over,
  };
}

describe("B7 [C3 fix]: /events behavioral filter", () => {
  let bus: EventBus;
  let app: Hono;

  beforeEach(() => {
    bus = new EventBus({ historySize: 100 });
    app = new Hono();
    app.route("/events", createEventsRouter({ eventBus: bus }));
  });

  it("delivers events whose sessionId matches the subscriber", async () => {
    const res = await app.request("/events?sessionId=sess-A");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    // Give the handler a tick to register its onAll subscriber.
    await new Promise((r) => setTimeout(r, 10));

    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-A", data: { marker: "A1" } }));
    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-A", data: { marker: "A2" } }));

    const received = await consumeUntil(reader, (acc) => acc.includes("A2"), 500);
    await reader.cancel();

    expect(received).toContain("A1");
    expect(received).toContain("A2");
  });

  it("drops events whose sessionId does NOT match the subscriber (C4 closure)", async () => {
    const res = await app.request("/events?sessionId=sess-A");
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 10));

    // Two B-events before an A-event; the A event is our sentinel for when
    // to stop reading. The B-events must not appear in between.
    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-B", data: { marker: "B-leak-1" } }));
    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-B", data: { marker: "B-leak-2" } }));
    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-A", data: { marker: "A-ok" } }));

    const received = await consumeUntil(reader, (acc) => acc.includes("A-ok"), 500);
    await reader.cancel();

    expect(received).toContain("A-ok");
    expect(received).not.toContain("B-leak-1");
    expect(received).not.toContain("B-leak-2");
  });

  it("drops events with NO sessionId (system-wide events don't leak)", async () => {
    const res = await app.request("/events?sessionId=sess-A");
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 10));

    bus.emit(makeEvent({ type: "tool.called", data: { marker: "no-sid-leak" } })); // no sessionId
    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-A", data: { marker: "sentinel" } }));

    const received = await consumeUntil(reader, (acc) => acc.includes("sentinel"), 500);
    await reader.cancel();

    expect(received).toContain("sentinel");
    expect(received).not.toContain("no-sid-leak");
  });

  it("multi-tenant: two subscribers with different sessionIds stay isolated", async () => {
    const resA = await app.request("/events?sessionId=sess-A");
    const resB = await app.request("/events?sessionId=sess-B");
    const readerA = resA.body!.getReader();
    const readerB = resB.body!.getReader();

    await new Promise((r) => setTimeout(r, 10));

    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-A", data: { marker: "ONLY-A" } }));
    bus.emit(makeEvent({ type: "tool.called", sessionId: "sess-B", data: { marker: "ONLY-B" } }));

    const [textA, textB] = await Promise.all([
      consumeUntil(readerA, (acc) => acc.includes("ONLY-A"), 500),
      consumeUntil(readerB, (acc) => acc.includes("ONLY-B"), 500),
    ]);
    await Promise.all([readerA.cancel(), readerB.cancel()]);

    expect(textA).toContain("ONLY-A");
    expect(textA).not.toContain("ONLY-B");
    expect(textB).toContain("ONLY-B");
    expect(textB).not.toContain("ONLY-A");
  });

  it("emits the initial 'connected' frame with the requested sessionId", async () => {
    const res = await app.request("/events?sessionId=sess-X");
    const reader = res.body!.getReader();

    const received = await consumeUntil(reader, (acc) => acc.includes("connected"), 500);
    await reader.cancel();

    expect(received).toContain("connected");
    expect(received).toContain("sess-X");
  });
});
