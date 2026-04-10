import { describe, it, expect, beforeEach, vi } from "vitest";
import { OverflowStore } from "../overflow-store.js";

describe("OverflowStore", () => {
  let store: OverflowStore;

  beforeEach(() => {
    store = new OverflowStore();
  });

  // 1. store() and read() round-trip correctly
  it("store() and read() round-trip correctly", () => {
    const data = "hello world";
    const stored = store.store("ref-1", data);
    expect(stored).toBe(true);

    const result = store.read("ref-1");
    expect(result).not.toBeNull();
    expect(result!.content).toBe(data);
    expect(result!.total_chars).toBe(data.length);
    expect(result!.offset).toBe(0);
    expect(result!.has_more).toBe(false);
  });

  // 2. read() with offset/limit returns correct slice and has_more flag
  it("read() with offset/limit returns correct slice and has_more flag", () => {
    const data = "abcdefghij"; // 10 chars
    store.store("ref-2", data);

    // Read first 3 chars
    const r1 = store.read("ref-2", 0, 3);
    expect(r1).not.toBeNull();
    expect(r1!.content).toBe("abc");
    expect(r1!.offset).toBe(0);
    expect(r1!.has_more).toBe(true);
    expect(r1!.total_chars).toBe(10);

    // Read middle 4 chars
    const r2 = store.read("ref-2", 3, 4);
    expect(r2).not.toBeNull();
    expect(r2!.content).toBe("defg");
    expect(r2!.offset).toBe(3);
    expect(r2!.has_more).toBe(true);

    // Read to end
    const r3 = store.read("ref-2", 7, 100);
    expect(r3).not.toBeNull();
    expect(r3!.content).toBe("hij");
    expect(r3!.offset).toBe(7);
    expect(r3!.has_more).toBe(false);
  });

  // 3. store() returns false when single entry exceeds maxBytes
  it("store() returns false when single entry exceeds maxBytes", () => {
    const smallStore = new OverflowStore({ maxBytes: 100 });
    const bigData = "x".repeat(200);

    const stored = smallStore.store("big-ref", bigData);
    expect(stored).toBe(false);

    // Should not be readable
    const result = smallStore.read("big-ref");
    expect(result).toBeNull();
    expect(smallStore.size).toBe(0);
  });

  // 4. LRU eviction: storing beyond maxBytes evicts oldest entry
  it("LRU eviction: storing beyond maxBytes evicts oldest-accessed entry", () => {
    const smallStore = new OverflowStore({ maxBytes: 100 });

    // Store 3 entries totaling ~90 bytes
    smallStore.store("a", "x".repeat(30)); // 30 bytes
    smallStore.store("b", "y".repeat(30)); // 30 bytes
    smallStore.store("c", "z".repeat(30)); // 30 bytes

    // Access "a" to make it more recent than "b"
    smallStore.read("a");

    // Store a new entry that requires eviction (30 + 30 + 30 + 30 = 120 > 100)
    const stored = smallStore.store("d", "w".repeat(30));
    expect(stored).toBe(true);

    // "b" should be evicted (oldest accessed), "a" and "c" and "d" should remain
    // But maxBytes is 100, so we need to evict enough to fit 30 more bytes
    // Current: a(30) + c(30) + d(30) = 90, that's under 100
    expect(smallStore.read("b")).toBeNull(); // evicted
    expect(smallStore.read("a")).not.toBeNull(); // kept (recently accessed)
    expect(smallStore.read("d")).not.toBeNull(); // just added
  });

  // 5. clear() empties the store
  it("clear() empties the store", () => {
    store.store("ref-a", "data-a");
    store.store("ref-b", "data-b");
    expect(store.size).toBeGreaterThan(0);

    store.clear();

    expect(store.size).toBe(0);
    expect(store.read("ref-a")).toBeNull();
    expect(store.read("ref-b")).toBeNull();
  });

  // 6. isIdle() returns true after idleTimeoutMs with no touch()
  it("isIdle() returns true after idleTimeoutMs with no touch()", () => {
    const quickStore = new OverflowStore({ idleTimeoutMs: 100 });

    expect(quickStore.isIdle()).toBe(false);

    // Advance time past idle timeout
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);

    expect(quickStore.isIdle()).toBe(true);

    // touch() resets idle
    quickStore.touch();
    expect(quickStore.isIdle()).toBe(false);

    vi.useRealTimers();
  });

  // Additional: read() returns null for unknown ref
  it("read() returns null for unknown ref", () => {
    expect(store.read("nonexistent")).toBeNull();
  });

  // Additional: size reflects total bytes stored
  it("size reflects total bytes stored", () => {
    expect(store.size).toBe(0);
    store.store("r1", "abc"); // 3 bytes
    expect(store.size).toBe(3);
    store.store("r2", "defgh"); // 5 bytes
    expect(store.size).toBe(8);
  });

  // Additional: overwriting an existing ref updates the data and size
  it("overwriting an existing ref updates the data and adjusts size", () => {
    store.store("ref", "short");
    const sizeBefore = store.size;

    store.store("ref", "a much longer string");
    expect(store.read("ref")!.content).toBe("a much longer string");
    expect(store.size).not.toBe(sizeBefore);
  });
});
