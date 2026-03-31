import { describe, it, expect } from "vitest";
import { ProjectWriteLock } from "../write-lock.js";

describe("ProjectWriteLock", () => {
  it("acquire() succeeds when unlocked", async () => {
    const lock = new ProjectWriteLock();
    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
  });

  it("isLocked is false initially", () => {
    const lock = new ProjectWriteLock();
    expect(lock.isLocked).toBe(false);
  });

  it("isLocked is true after acquire()", async () => {
    const lock = new ProjectWriteLock();
    await lock.acquire();
    expect(lock.isLocked).toBe(true);
    lock.release();
  });

  it("release() unlocks the lock", async () => {
    const lock = new ProjectWriteLock();
    await lock.acquire();
    lock.release();
    expect(lock.isLocked).toBe(false);
  });

  it("second acquire() blocks until first release()", async () => {
    const lock = new ProjectWriteLock();
    const order: number[] = [];

    await lock.acquire();
    order.push(1); // first acquire is immediate

    // Second acquire should wait
    const p2 = lock.acquire().then(() => {
      order.push(2);
      lock.release();
    });

    // Release the first hold — this should unblock p2
    lock.release();

    await p2;

    expect(order).toEqual([1, 2]);
  });

  it("multiple waiters dequeue in order (FIFO)", async () => {
    const lock = new ProjectWriteLock();
    const order: number[] = [];

    await lock.acquire();

    const p1 = lock.acquire().then(() => {
      order.push(1);
      lock.release();
    });
    const p2 = lock.acquire().then(() => {
      order.push(2);
      lock.release();
    });
    const p3 = lock.acquire().then(() => {
      order.push(3);
      lock.release();
    });

    // Release the initial hold to start the chain
    lock.release();

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("concurrent acquires serialize correctly", async () => {
    const lock = new ProjectWriteLock();
    const results: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async (id: string) => {
      await lock.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 1));
      results.push(id);
      concurrent--;
      lock.release();
    };

    await Promise.all([task("a"), task("b"), task("c"), task("d")]);

    // At no point should two tasks hold the lock simultaneously
    expect(maxConcurrent).toBe(1);
    // All tasks must have completed
    expect(results.length).toBe(4);
    expect(results.sort()).toEqual(["a", "b", "c", "d"]);
  });
});
