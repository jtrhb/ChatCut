/**
 * ProjectWriteLock — a simple async mutual-exclusion lock for dispatch-scoped
 * writes to shared agent state.
 *
 * Usage:
 *   await lock.acquire();
 *   try { ... } finally { lock.release(); }
 */
export class ProjectWriteLock {
  private _locked = false;
  private _queue: Array<() => void> = [];

  /**
   * Acquire the lock. Resolves immediately when unlocked; otherwise queues
   * and resolves once the lock is released to this waiter.
   */
  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  /**
   * Release the lock. If there are waiters, the next one is dequeued and
   * granted the lock immediately (FIFO order).
   */
  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      // Lock stays "locked" — we're handing it directly to the next waiter.
      next();
    } else {
      this._locked = false;
    }
  }

  /** True while the lock is held by any caller. */
  get isLocked(): boolean {
    return this._locked;
  }
}
