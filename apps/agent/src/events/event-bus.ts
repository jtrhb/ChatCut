import type { RuntimeEvent, RuntimeEventType } from "./types.js";

type EventHandler = (event: RuntimeEvent) => void;

/**
 * Bounded event bus with a ring-buffer history.
 *
 * Replaces the old `history.shift()` path which was O(n) on every emit
 * once the buffer filled — a hot path during agent dispatch. The ring
 * buffer keeps O(1) enqueue regardless of history size.
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  /**
   * Fixed-capacity ring. `nextIndex` is where the next event will land;
   * `count` tracks how many slots are filled (capped at buffer.length).
   * Once full, new events overwrite the oldest slot with no shift().
   */
  private buffer: Array<RuntimeEvent | undefined>;
  private nextIndex = 0;
  private count = 0;

  constructor(opts?: { historySize?: number }) {
    const historySize = opts?.historySize ?? 100;
    this.buffer = new Array(historySize);
  }

  on(type: RuntimeEventType | "*", handler: EventHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  off(type: RuntimeEventType | "*", handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  onAll(handler: EventHandler): () => void {
    this.on("*", handler);
    return () => this.off("*", handler);
  }

  emit(event: RuntimeEvent): void {
    // O(1) ring-buffer insert. Overwrites the oldest slot once full.
    this.buffer[this.nextIndex] = event;
    this.nextIndex = (this.nextIndex + 1) % this.buffer.length;
    if (this.count < this.buffer.length) {
      this.count++;
    }

    // Deliver to type-specific handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try { handler(event); } catch { /* handler error must not break pipeline */ }
      }
    }

    // Deliver to wildcard handlers
    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try { handler(event); } catch { /* handler error must not break pipeline */ }
      }
    }
  }

  /**
   * Return events in chronological order (oldest → newest). Allocates a
   * fresh array so callers can freely mutate; the ring buffer itself is
   * not exposed.
   */
  getHistory(): readonly RuntimeEvent[] {
    if (this.count === 0) return [];
    const result: RuntimeEvent[] = [];
    // When count < length, oldest is at index 0. When full, oldest is at
    // nextIndex (the slot about to be overwritten).
    const start = this.count < this.buffer.length ? 0 : this.nextIndex;
    for (let i = 0; i < this.count; i++) {
      const slot = this.buffer[(start + i) % this.buffer.length];
      if (slot !== undefined) {
        result.push(slot);
      }
    }
    return result;
  }
}
