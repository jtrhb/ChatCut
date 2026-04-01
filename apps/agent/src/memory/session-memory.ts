export type SessionMemoryType =
  | "user_intent"
  | "agent_action"
  | "tool_result"
  | "decision"
  | "observation";

export interface SessionMemoryEntry {
  type: SessionMemoryType;
  content: string;
  timestamp: number;
}

const DEFAULT_MAX_ENTRIES = 50;

export class SessionMemory {
  private readonly maxEntries: number;
  private store: SessionMemoryEntry[] = [];

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  record(entry: { type: SessionMemoryType; content: string }): void {
    this.store.push({ ...entry, timestamp: Date.now() });
    if (this.store.length > this.maxEntries) {
      this.store.shift(); // evict oldest
    }
  }

  getEntries(): readonly SessionMemoryEntry[] {
    return this.store;
  }

  clear(): void {
    this.store = [];
  }

  summarize(): string {
    if (this.store.length === 0) return "";
    return this.store.map((e) => `- ${e.content}`).join("\n");
  }

  toPromptText(): string {
    if (this.store.length === 0) return "";
    return this.store.map((e) => `[${e.type}] ${e.content}`).join("\n");
  }
}
