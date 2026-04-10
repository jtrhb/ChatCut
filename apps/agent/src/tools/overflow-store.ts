interface StoreEntry {
  data: string;
  accessedAt: number;
}

export interface OverflowReadResult {
  content: string;
  total_chars: number;
  offset: number;
  has_more: boolean;
}

export class OverflowStore {
  private entries = new Map<string, StoreEntry>();
  private totalBytes = 0;
  private lastToolCallAt = Date.now();
  private accessCounter = 0;
  private readonly maxBytes: number;
  private readonly idleTimeoutMs: number;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(opts?: { maxBytes?: number; idleTimeoutMs?: number }) {
    this.maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024; // 10MB
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 30 * 60 * 1000; // 30 min
    this.startIdleCheck();
  }

  /** Periodic check: clear the store if idle for too long. */
  private startIdleCheck(): void {
    // Check every 5 minutes
    this.idleTimer = setInterval(() => {
      if (this.isIdle() && this.entries.size > 0) {
        this.clear();
      }
    }, 5 * 60 * 1000);
    // Don't prevent process exit
    if (this.idleTimer && typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      this.idleTimer.unref();
    }
  }

  /** Stop the idle check timer. Call when the session ends. */
  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.clear();
  }

  /** Store data under a ref key. Returns false if a single entry exceeds maxBytes. */
  store(ref: string, data: string): boolean {
    const byteSize = Buffer.byteLength(data);

    // Single entry > maxBytes: reject entirely
    if (byteSize > this.maxBytes) {
      return false;
    }

    // Remove existing entry if overwriting
    if (this.entries.has(ref)) {
      const existing = this.entries.get(ref)!;
      this.totalBytes -= Buffer.byteLength(existing.data);
      this.entries.delete(ref);
    }

    // Evict LRU entries until there's room
    while (this.totalBytes + byteSize > this.maxBytes && this.entries.size > 0) {
      this.evictOldest();
    }

    this.entries.set(ref, { data, accessedAt: ++this.accessCounter });
    this.totalBytes += byteSize;
    return true;
  }

  /** Read stored data with optional pagination via offset/limit. */
  read(ref: string, offset?: number, limit?: number): OverflowReadResult | null {
    const entry = this.entries.get(ref);
    if (!entry) return null;

    // Update access counter for LRU
    entry.accessedAt = ++this.accessCounter;

    const effectiveOffset = offset ?? 0;
    const effectiveLimit = limit ?? entry.data.length;
    const content = entry.data.slice(effectiveOffset, effectiveOffset + effectiveLimit);
    const hasMore = effectiveOffset + effectiveLimit < entry.data.length;

    return {
      content,
      total_chars: entry.data.length,
      offset: effectiveOffset,
      has_more: hasMore,
    };
  }

  /** Update last tool call timestamp to prevent idle cleanup. */
  touch(): void {
    this.lastToolCallAt = Date.now();
  }

  /** Returns true if no touch() has occurred within idleTimeoutMs. */
  isIdle(): boolean {
    return Date.now() - this.lastToolCallAt >= this.idleTimeoutMs;
  }

  /** Clear all stored entries. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Total bytes currently stored. */
  get size(): number {
    return this.totalBytes;
  }

  /** Evict the least-recently-accessed entry. */
  private evictOldest(): void {
    let oldestRef: string | null = null;
    let oldestTime = Infinity;

    for (const [ref, entry] of this.entries) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt;
        oldestRef = ref;
      }
    }

    if (oldestRef) {
      const entry = this.entries.get(oldestRef)!;
      this.totalBytes -= Buffer.byteLength(entry.data);
      this.entries.delete(oldestRef);
    }
  }
}
