import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../event-bus.js";
import { serializeEvent } from "../event-protocol.js";
import type { RuntimeEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    type: "task.created",
    timestamp: 1000,
    data: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EventBus tests
// ---------------------------------------------------------------------------

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // 1. emit delivers to matching type subscribers
  it("emit delivers event to matching type subscriber", () => {
    const handler = vi.fn();
    bus.on("task.created", handler);

    const event = makeEvent({ type: "task.created" });
    bus.emit(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(event);
  });

  // 2. emit does NOT deliver to non-matching subscribers
  it("emit does NOT deliver event to non-matching type subscriber", () => {
    const handler = vi.fn();
    bus.on("task.completed", handler);

    bus.emit(makeEvent({ type: "task.created" }));

    expect(handler).not.toHaveBeenCalled();
  });

  // 3. wildcard "*" subscription receives all events
  it('wildcard "*" subscription receives all emitted events', () => {
    const handler = vi.fn();
    bus.on("*", handler);

    bus.emit(makeEvent({ type: "task.created" }));
    bus.emit(makeEvent({ type: "session.created" }));
    bus.emit(makeEvent({ type: "tool.called" }));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  // 4. off() removes a specific handler
  it("off() removes a specific handler so it no longer receives events", () => {
    const handler = vi.fn();
    bus.on("task.created", handler);
    bus.emit(makeEvent({ type: "task.created" }));

    bus.off("task.created", handler);
    bus.emit(makeEvent({ type: "task.created" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // 5. onAll() subscribes to all and returns unsubscribe function
  it("onAll() subscribes to all events and unsubscribe function removes the handler", () => {
    const handler = vi.fn();
    const unsubscribe = bus.onAll(handler);

    bus.emit(makeEvent({ type: "task.created" }));
    bus.emit(makeEvent({ type: "session.completed" }));
    expect(handler).toHaveBeenCalledTimes(2);

    unsubscribe();
    bus.emit(makeEvent({ type: "tool.called" }));
    expect(handler).toHaveBeenCalledTimes(2); // no new calls after unsubscribe
  });

  // NEW: handler safety — one throwing handler must not block others
  it("continues delivering to other handlers when one throws", () => {
    const badHandler = vi.fn(() => { throw new Error("boom"); });
    const goodHandler = vi.fn();
    bus.on("tool.called", badHandler);
    bus.on("tool.called", goodHandler);

    bus.emit({ type: "tool.called", timestamp: Date.now(), data: {} });

    expect(badHandler).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalled();
  });

  // 6. history stores last N events (ring buffer, test with historySize: 3)
  it("history acts as a ring buffer respecting historySize", () => {
    const smallBus = new EventBus({ historySize: 3 });

    const e1 = makeEvent({ type: "task.created", timestamp: 1 });
    const e2 = makeEvent({ type: "task.progress", timestamp: 2 });
    const e3 = makeEvent({ type: "task.completed", timestamp: 3 });
    const e4 = makeEvent({ type: "task.failed", timestamp: 4 });

    smallBus.emit(e1);
    smallBus.emit(e2);
    smallBus.emit(e3);

    expect(smallBus.getHistory()).toHaveLength(3);
    expect(smallBus.getHistory()[0]).toBe(e1);

    // Emit a 4th event — oldest (e1) should be evicted
    smallBus.emit(e4);
    expect(smallBus.getHistory()).toHaveLength(3);
    expect(smallBus.getHistory()[0]).toBe(e2);
    expect(smallBus.getHistory()[2]).toBe(e4);
  });
});

// ---------------------------------------------------------------------------
// serializeEvent tests
// ---------------------------------------------------------------------------

describe("serializeEvent", () => {
  // 7. produces correct { event, data } pair
  it("produces correct { event, data } pair", () => {
    const event: RuntimeEvent = {
      type: "changeset.proposed",
      timestamp: 9999,
      sessionId: "sess-abc",
      taskId: "task-xyz",
      data: { changesetId: "cs-1", diff: "some diff" },
    };

    const result = serializeEvent(event);

    expect(result.event).toBe("changeset.proposed");

    const parsed = JSON.parse(result.data);
    expect(parsed.changesetId).toBe("cs-1");
    expect(parsed.diff).toBe("some diff");
    expect(parsed.timestamp).toBe(9999);
    expect(parsed.sessionId).toBe("sess-abc");
    expect(parsed.taskId).toBe("task-xyz");
    // type should NOT appear as a separate key in data (it's the event field)
    expect(parsed.type).toBeUndefined();
  });
});

describe("B6: EventBus ring-buffer history", () => {
  it("caps history at historySize without O(n) shift", () => {
    const bus = new EventBus({ historySize: 3 });
    bus.emit(makeEvent({ type: "task.created", timestamp: 1 }));
    bus.emit(makeEvent({ type: "task.created", timestamp: 2 }));
    bus.emit(makeEvent({ type: "task.created", timestamp: 3 }));
    bus.emit(makeEvent({ type: "task.created", timestamp: 4 }));
    bus.emit(makeEvent({ type: "task.created", timestamp: 5 }));

    const history = bus.getHistory();
    expect(history).toHaveLength(3);
    // Oldest kept is timestamp 3 (1 and 2 overwritten)
    expect(history.map((e) => e.timestamp)).toEqual([3, 4, 5]);
  });

  it("returns events in chronological order when underfilled", () => {
    const bus = new EventBus({ historySize: 10 });
    bus.emit(makeEvent({ type: "task.created", timestamp: 1 }));
    bus.emit(makeEvent({ type: "task.created", timestamp: 2 }));
    expect(bus.getHistory().map((e) => e.timestamp)).toEqual([1, 2]);
  });

  it("returns empty history when nothing emitted", () => {
    const bus = new EventBus({ historySize: 5 });
    expect(bus.getHistory()).toEqual([]);
  });

  it("does not block emit performance when full (many iterations)", () => {
    const bus = new EventBus({ historySize: 50 });
    // Would be O(n^2) under shift-based eviction; O(n) under ring buffer.
    // Not a perf assertion — just ensures we can emit 10k without choking.
    for (let i = 0; i < 10_000; i++) {
      bus.emit(makeEvent({ type: "task.created", timestamp: i }));
    }
    expect(bus.getHistory()).toHaveLength(50);
    expect(bus.getHistory().at(-1)!.timestamp).toBe(9999);
    expect(bus.getHistory().at(0)!.timestamp).toBe(9950);
  });
});
