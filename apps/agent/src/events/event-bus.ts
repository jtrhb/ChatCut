import type { RuntimeEvent, RuntimeEventType } from "./types.js";

type EventHandler = (event: RuntimeEvent) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private history: RuntimeEvent[] = [];
  private historySize: number;

  constructor(opts?: { historySize?: number }) {
    this.historySize = opts?.historySize ?? 100;
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
    // Ring buffer: evict oldest when full
    if (this.history.length >= this.historySize) {
      this.history.shift();
    }
    this.history.push(event);

    // Deliver to type-specific handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        handler(event);
      }
    }

    // Deliver to wildcard handlers
    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(event);
      }
    }
  }

  getHistory(): readonly RuntimeEvent[] {
    return this.history;
  }
}
