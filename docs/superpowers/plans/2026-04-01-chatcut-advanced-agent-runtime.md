# ChatCut Advanced Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade ChatCut's agent system from a minimal tool-use loop into a production-grade agent runtime with session lifecycle, tool pipeline, unified task model, real event streaming, memory selection, delegation protocol, verification, skill contracts, and extension registry — borrowing proven patterns from advanced agent architectures.

**Architecture:** Three phases of incremental infrastructure upgrades to `apps/agent/src/`. Phase A builds the runtime foundation (PromptBuilder, SessionManager, ToolPipeline). Phase B adds cognition and collaboration (TaskRegistry, EventProtocol, MemorySelector, DelegationContract). Phase C adds advanced capabilities (VerificationAgent, SkillRuntime, ExtensionRegistry). Each task produces independently testable, working code.

**Tech Stack:** TypeScript, Vitest, Hono, Zod, `@anthropic-ai/sdk`, pg-boss, Cloudflare R2 (S3-compatible)

**Spec Sources:** `docs/chatcut-agent-advanced-agent-borrowing.md`, `docs/chatcut-agent-advanced-agent-borrowings.md`, `docs/chatcut-agent-system.md`, `docs/chatcut-architecture.md`

---

## TDD Enforcement — Mandatory for Every Task

**Every task MUST follow this cycle. No exceptions.**

```
1. Write failing test          → commit test file
2. Run test → verify FAIL      → paste output showing failure
3. Write minimal implementation
4. Run test → verify PASS      → paste output showing green
5. Run ALL tests for package   → verify no regressions
6. Commit implementation
```

**Test commands:**
- Single test: `cd apps/agent && npx vitest run src/<path>/__tests__/<file>.test.ts`
- All tests: `cd apps/agent && npm test`

**Test patterns (match existing codebase):**
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
// Mocks declared before imports using vi.hoisted() or vi.mock()
// Nested describe() blocks for logical grouping
// vi.fn() for mock functions, .mockResolvedValueOnce() for async
```

---

## File Structure Overview

### New Files (Phase A — Runtime Foundation)

```
apps/agent/src/
├── prompt/
│   ├── prompt-builder.ts              # Section-based system prompt assembler
│   ├── sections.ts                    # Individual prompt section renderers
│   ├── types.ts                       # PromptSection, PromptConfig types
│   └── __tests__/
│       └── prompt-builder.test.ts
├── session/
│   ├── session-manager.ts             # Session lifecycle: create/resume/save/fork/list
│   ├── session-store.ts               # Session persistence (in-memory + serializable)
│   ├── types.ts                       # AgentSession, SessionState types
│   └── __tests__/
│       └── session-manager.test.ts
├── tools/
│   ├── tool-pipeline.ts               # Staged execution: preflight→pre-hook→exec→post-hook→trace
│   ├── hooks.ts                       # ToolHook interface + built-in hooks
│   ├── failure-classifier.ts          # Classify tool failures by type
│   └── __tests__/
│       ├── tool-pipeline.test.ts
│       └── failure-classifier.test.ts
```

### New Files (Phase B — Cognition & Collaboration)

```
apps/agent/src/
├── tasks/
│   ├── task-registry.ts               # Unified async task model
│   ├── types.ts                       # AgentTask, TaskStatus types
│   └── __tests__/
│       └── task-registry.test.ts
├── events/
│   ├── event-bus.ts                   # Typed event emitter for runtime events
│   ├── event-protocol.ts             # SSE serializer for all event types
│   ├── types.ts                       # RuntimeEvent union type
│   └── __tests__/
│       └── event-bus.test.ts
├── memory/
│   ├── memory-index.ts                # Memory manifest/index layer
│   ├── memory-selector.ts             # Relevance-based memory selection
│   ├── session-memory.ts              # Short-term session continuity memory
│   └── __tests__/
│       ├── memory-index.test.ts
│       ├── memory-selector.test.ts
│       └── session-memory.test.ts
├── prompt/
│   └── delegation-contract.ts         # Master delegation protocol prompt section
```

### New Files (Phase C — Advanced Capabilities)

```
apps/agent/src/
├── agents/
│   ├── verification-agent.ts          # Adversarial result validator
│   └── __tests__/
│       └── verification-agent.test.ts
├── skills/
│   ├── skill-runtime.ts               # Skill frontmatter → runtime constraint resolver
│   ├── types.ts                       # SkillContract, SkillFrontmatter types
│   └── __tests__/
│       └── skill-runtime.test.ts
├── extensions/
│   ├── extension-registry.ts          # Unified provider/tool/brand registration
│   ├── types.ts                       # Extension, ExtensionManifest types
│   └── __tests__/
│       └── extension-registry.test.ts
```

### Modified Files

```
apps/agent/src/
├── agents/master-agent.ts             # Use PromptBuilder, SessionManager, DelegationContract
├── agents/editor-agent.ts             # Use PromptBuilder
├── agents/creator-agent.ts            # Use PromptBuilder
├── agents/audio-agent.ts              # Use PromptBuilder
├── agents/vision-agent.ts             # Use PromptBuilder
├── agents/asset-agent.ts              # Use PromptBuilder
├── agents/runtime.ts                  # Add session awareness
├── agents/types.ts                    # Add session-related types
├── tools/executor.ts                  # Delegate to ToolPipeline
├── routes/chat.ts                     # Use SessionManager + TaskRegistry
├── routes/events.ts                   # Use EventProtocol
├── routes/status.ts                   # Use TaskRegistry + SessionManager
├── memory/memory-loader.ts            # Use MemorySelector + MemoryIndex
├── skills/loader.ts                   # Use SkillRuntime for frontmatter resolution
├── server.ts                          # Wire EventBus, TaskRegistry, SessionManager
```

---

## Phase A — Runtime Foundation

---

### Task 1: PromptBuilder — Section-Based System Prompt Assembly

**Why:** All 6 agents currently hand-write `buildSystemPrompt()` with duplicated logic for timeline, memory, recent changes injection. A unified section-based builder eliminates this duplication and enables future prompt caching.

**Files:**
- Create: `apps/agent/src/prompt/types.ts`
- Create: `apps/agent/src/prompt/sections.ts`
- Create: `apps/agent/src/prompt/prompt-builder.ts`
- Create: `apps/agent/src/prompt/__tests__/prompt-builder.test.ts`
- Modify: `apps/agent/src/agents/master-agent.ts`
- Modify: `apps/agent/src/agents/editor-agent.ts`

---

- [ ] **Step 1: Create prompt types**

```typescript
// apps/agent/src/prompt/types.ts

import type { ProjectContext } from "../context/project-context.js";
import type { DispatchInput } from "../agents/types.js";

/** A single prompt section with a stable key for ordering and caching. */
export interface PromptSection {
  /** Unique key for dedup and ordering. */
  key: string;
  /** Rendered markdown content. Empty string = section omitted. */
  render: (ctx: PromptContext) => string;
  /** Lower = earlier in prompt. Default: 50. */
  priority?: number;
  /** If true, content is stable across turns (cache-friendly). */
  isStatic?: boolean;
}

/** Everything a prompt section might need to render. */
export interface PromptContext {
  projectContext: Readonly<ProjectContext>;
  agentIdentity: AgentIdentity;
  task?: DispatchInput;
  extras?: Record<string, unknown>;
}

export interface AgentIdentity {
  role: string;
  description: string;
  rules: string[];
}
```

- [ ] **Step 2: Write failing test for PromptBuilder**

```typescript
// apps/agent/src/prompt/__tests__/prompt-builder.test.ts

import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../prompt-builder.js";
import type { PromptContext, PromptSection } from "../types.js";

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectContext: {
      timelineState: '{"tracks":[]}',
      snapshotVersion: 1,
      videoAnalysis: null,
      currentIntent: { raw: "", parsed: "", explorationMode: false },
      memoryContext: { promptText: "", injectedMemoryIds: [], injectedSkillIds: [] },
      artifacts: {},
      recentChanges: [],
    },
    agentIdentity: {
      role: "Test Agent",
      description: "A test agent for unit tests.",
      rules: ["Rule one.", "Rule two."],
    },
    ...overrides,
  };
}

describe("PromptBuilder", () => {
  describe("build()", () => {
    it("renders identity section at the top", () => {
      const builder = new PromptBuilder();
      const result = builder.build(makeContext());
      expect(result).toContain("# Test Agent");
      expect(result).toContain("A test agent for unit tests.");
      expect(result).toContain("- Rule one.");
    });

    it("includes timeline state section", () => {
      const ctx = makeContext();
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Current Timeline State");
      expect(result).toContain('{"tracks":[]}');
      expect(result).toContain("Snapshot version: 1");
    });

    it("omits memory section when promptText is empty", () => {
      const result = new PromptBuilder().build(makeContext());
      expect(result).not.toContain("## Memory Context");
    });

    it("includes memory section when promptText is present", () => {
      const ctx = makeContext({
        projectContext: {
          ...makeContext().projectContext,
          memoryContext: {
            promptText: "User prefers fast cuts.",
            injectedMemoryIds: ["mem-1"],
            injectedSkillIds: [],
          },
        },
      });
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Memory Context");
      expect(result).toContain("User prefers fast cuts.");
      expect(result).toContain("mem-1");
    });

    it("includes recent changes when present", () => {
      const ctx = makeContext({
        projectContext: {
          ...makeContext().projectContext,
          recentChanges: [
            { id: "c1", source: "human", summary: "Trimmed clip A", timestamp: 1000 },
          ],
        },
      });
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Recent Changes");
      expect(result).toContain("[human] Trimmed clip A");
    });

    it("includes task section when task is provided", () => {
      const ctx = makeContext({
        task: { task: "Trim the intro to 3 seconds", accessMode: "read_write" },
      });
      const result = new PromptBuilder().build(ctx);
      expect(result).toContain("## Task");
      expect(result).toContain("Trim the intro to 3 seconds");
    });

    it("allows registering custom sections", () => {
      const builder = new PromptBuilder();
      const custom: PromptSection = {
        key: "brand",
        render: () => "## Brand Guidelines\nUse red and white colors.",
        priority: 25,
      };
      builder.register(custom);
      const result = builder.build(makeContext());
      expect(result).toContain("## Brand Guidelines");
      expect(result).toContain("Use red and white colors.");
    });

    it("orders sections by priority", () => {
      const builder = new PromptBuilder();
      builder.register({ key: "late", render: () => "LATE_SECTION", priority: 90 });
      builder.register({ key: "early", render: () => "EARLY_SECTION", priority: 5 });
      const result = builder.build(makeContext());
      const earlyIndex = result.indexOf("EARLY_SECTION");
      const lateIndex = result.indexOf("LATE_SECTION");
      expect(earlyIndex).toBeLessThan(lateIndex);
    });

    it("skips sections that render to empty string", () => {
      const builder = new PromptBuilder();
      builder.register({ key: "empty", render: () => "", priority: 25 });
      const result = builder.build(makeContext());
      // Should not have double newlines from empty section
      expect(result).not.toMatch(/\n{4,}/);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/prompt/__tests__/prompt-builder.test.ts`
Expected: FAIL — `Cannot find module '../prompt-builder.js'`

- [ ] **Step 4: Implement built-in sections**

```typescript
// apps/agent/src/prompt/sections.ts

import type { PromptSection, PromptContext } from "./types.js";

export const identitySection: PromptSection = {
  key: "identity",
  priority: 0,
  isStatic: true,
  render: (ctx: PromptContext): string => {
    const { role, description, rules } = ctx.agentIdentity;
    const lines = [`# ${role}`, "", description, ""];
    if (rules.length > 0) {
      lines.push("## Rules", ...rules.map((r) => `- ${r}`), "");
    }
    return lines.join("\n");
  },
};

export const timelineSection: PromptSection = {
  key: "timeline",
  priority: 10,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    const { timelineState, snapshotVersion } = ctx.projectContext;
    const lines = [
      "## Current Timeline State",
      timelineState || "(empty timeline)",
      `Snapshot version: ${snapshotVersion}`,
      "",
    ];
    return lines.join("\n");
  },
};

export const memorySection: PromptSection = {
  key: "memory",
  priority: 20,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    const { promptText, injectedMemoryIds } = ctx.projectContext.memoryContext;
    if (!promptText) return "";
    const lines = ["## Memory Context", promptText];
    if (injectedMemoryIds.length > 0) {
      lines.push(`Active memory IDs: ${injectedMemoryIds.join(", ")}`);
    }
    lines.push("");
    return lines.join("\n");
  },
};

export const recentChangesSection: PromptSection = {
  key: "recentChanges",
  priority: 30,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    const { recentChanges } = ctx.projectContext;
    if (recentChanges.length === 0) return "";
    const lines = ["## Recent Changes"];
    for (const change of recentChanges) {
      lines.push(`- [${change.source}] ${change.summary}`);
    }
    lines.push("");
    return lines.join("\n");
  },
};

export const taskSection: PromptSection = {
  key: "task",
  priority: 80,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    if (!ctx.task) return "";
    const lines = ["## Task", ctx.task.task];
    if (ctx.task.context && Object.keys(ctx.task.context).length > 0) {
      lines.push("", "## Context", JSON.stringify(ctx.task.context, null, 2));
    }
    lines.push("");
    return lines.join("\n");
  },
};

/** All built-in sections in registration order. */
export const BUILTIN_SECTIONS: PromptSection[] = [
  identitySection,
  timelineSection,
  memorySection,
  recentChangesSection,
  taskSection,
];
```

- [ ] **Step 5: Implement PromptBuilder**

```typescript
// apps/agent/src/prompt/prompt-builder.ts

import type { PromptSection, PromptContext } from "./types.js";
import { BUILTIN_SECTIONS } from "./sections.js";

export class PromptBuilder {
  private sections: PromptSection[] = [];

  constructor() {
    // Register built-in sections
    for (const section of BUILTIN_SECTIONS) {
      this.sections.push(section);
    }
  }

  /** Register a custom section. Replaces any existing section with the same key. */
  register(section: PromptSection): void {
    this.sections = this.sections.filter((s) => s.key !== section.key);
    this.sections.push(section);
  }

  /** Build the full system prompt from all registered sections. */
  build(ctx: PromptContext): string {
    const sorted = [...this.sections].sort(
      (a, b) => (a.priority ?? 50) - (b.priority ?? 50),
    );

    const rendered: string[] = [];
    for (const section of sorted) {
      const content = section.render(ctx);
      if (content) {
        rendered.push(content);
      }
    }

    return rendered.join("\n").trimEnd() + "\n";
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/prompt/__tests__/prompt-builder.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 7: Migrate MasterAgent to use PromptBuilder**

Replace `buildSystemPrompt()` in `apps/agent/src/agents/master-agent.ts`:

```typescript
// Add imports at the top of master-agent.ts
import { PromptBuilder } from "../prompt/prompt-builder.js";
import type { PromptContext } from "../prompt/types.js";

// Replace the buildSystemPrompt method (lines 74-109) with:
  buildSystemPrompt(ctx: Readonly<ProjectContext>): string {
    const builder = new PromptBuilder();
    const promptCtx: PromptContext = {
      projectContext: ctx,
      agentIdentity: {
        role: "Master Agent",
        description:
          "You are the Master Agent for OpenCut, an AI-powered video editor. " +
          "You coordinate sub-agents (editor, vision, creator, audio, asset) to fulfill user requests.",
        rules: [
          "Analyze the user's intent before dispatching to sub-agents.",
          "Use dispatch tools to delegate tasks to specialist agents.",
          "Never guess sub-agent results — wait for their response.",
          "For destructive edits, use propose_changes to get user approval first.",
        ],
      },
    };
    return builder.build(promptCtx);
  }
```

- [ ] **Step 8: Migrate EditorAgent to use PromptBuilder**

Replace `buildSystemPrompt()` in `apps/agent/src/agents/editor-agent.ts`:

```typescript
// Add imports at the top of editor-agent.ts
import { PromptBuilder } from "../prompt/prompt-builder.js";
import type { PromptContext } from "../prompt/types.js";

// Replace the buildSystemPrompt method (lines 38-56) with:
  buildSystemPrompt(input: DispatchInput): string {
    const builder = new PromptBuilder();
    const promptCtx: PromptContext = {
      projectContext: {
        timelineState: "",
        snapshotVersion: 0,
        videoAnalysis: null,
        currentIntent: { raw: "", parsed: "", explorationMode: false },
        memoryContext: { promptText: "", injectedMemoryIds: [], injectedSkillIds: [] },
        artifacts: {},
        recentChanges: [],
      },
      agentIdentity: {
        role: "Editor Agent",
        description: "You modify the video timeline using editing tools.",
        rules: [
          "Use read tools to inspect the timeline before making changes.",
          "Use write tools to apply mutations; prefer atomic batch operations when possible.",
          "Never exceed the token budget; be concise in tool calls.",
        ],
      },
      task: input,
    };
    return builder.build(promptCtx);
  }
```

- [ ] **Step 9: Run all tests to verify no regressions**

Run: `cd apps/agent && npm test`
Expected: All existing tests PASS + new prompt-builder tests PASS

- [ ] **Step 10: Commit**

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/prompt/
git add apps/agent/src/agents/master-agent.ts
git add apps/agent/src/agents/editor-agent.ts
git commit -m "feat(agent): add PromptBuilder with section-based prompt assembly

Replace hand-written buildSystemPrompt() in MasterAgent and EditorAgent
with unified PromptBuilder. Built-in sections: identity, timeline,
memory, recentChanges, task. Custom sections supported via register().

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SessionManager — Session Lifecycle

**Why:** `runtime.ts` is a stateless one-shot loop. `chat.ts` returns `sessionId: "placeholder"`. Without session lifecycle, there's no conversation continuity, no resume, no fork.

**Files:**
- Create: `apps/agent/src/session/types.ts`
- Create: `apps/agent/src/session/session-store.ts`
- Create: `apps/agent/src/session/session-manager.ts`
- Create: `apps/agent/src/session/__tests__/session-manager.test.ts`
- Modify: `apps/agent/src/agents/runtime.ts`
- Modify: `apps/agent/src/agents/types.ts`
- Modify: `apps/agent/src/routes/chat.ts`

---

- [ ] **Step 1: Create session types**

```typescript
// apps/agent/src/session/types.ts

export type SessionStatus = "active" | "paused" | "completed" | "failed";

export interface AgentSession {
  sessionId: string;
  projectId: string;
  status: SessionStatus;
  /** Conversation messages for resume. */
  messages: SessionMessage[];
  /** Token usage across all turns in this session. */
  totalTokens: { input: number; output: number };
  /** Number of agent turns completed. */
  turnCount: number;
  /** Session-level metadata. */
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** If this session was forked, the parent session ID. */
  parentSessionId?: string;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool_result";
  content: unknown;
  timestamp: number;
}

export interface CreateSessionParams {
  projectId: string;
  metadata?: Record<string, unknown>;
}

export interface ResumeSessionParams {
  sessionId: string;
  /** New user message to append when resuming. */
  message?: string;
}
```

- [ ] **Step 2: Write failing test for SessionManager**

```typescript
// apps/agent/src/session/__tests__/session-manager.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../session-manager.js";
import { SessionStore } from "../session-store.js";
import type { AgentSession } from "../types.js";

describe("SessionManager", () => {
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    store = new SessionStore();
    manager = new SessionManager(store);
  });

  describe("createSession()", () => {
    it("returns a new session with unique ID", () => {
      const session = manager.createSession({ projectId: "proj-1" });
      expect(session.sessionId).toBeTruthy();
      expect(session.projectId).toBe("proj-1");
      expect(session.status).toBe("active");
      expect(session.messages).toEqual([]);
      expect(session.turnCount).toBe(0);
    });

    it("stores the session in the store", () => {
      const session = manager.createSession({ projectId: "proj-1" });
      const retrieved = manager.getSession(session.sessionId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe(session.sessionId);
    });
  });

  describe("getSession()", () => {
    it("returns undefined for unknown session", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });
  });

  describe("appendMessage()", () => {
    it("adds a message to the session", () => {
      const session = manager.createSession({ projectId: "proj-1" });
      manager.appendMessage(session.sessionId, {
        role: "user",
        content: "Trim the intro",
        timestamp: Date.now(),
      });
      const updated = manager.getSession(session.sessionId)!;
      expect(updated.messages).toHaveLength(1);
      expect(updated.messages[0].role).toBe("user");
    });

    it("throws for unknown session", () => {
      expect(() =>
        manager.appendMessage("bad-id", { role: "user", content: "hi", timestamp: 0 }),
      ).toThrow(/not found/i);
    });
  });

  describe("updateStatus()", () => {
    it("updates session status", () => {
      const session = manager.createSession({ projectId: "proj-1" });
      manager.updateStatus(session.sessionId, "completed");
      expect(manager.getSession(session.sessionId)!.status).toBe("completed");
    });
  });

  describe("incrementTurn()", () => {
    it("increments turn count and updates tokens", () => {
      const session = manager.createSession({ projectId: "proj-1" });
      manager.incrementTurn(session.sessionId, { input: 1000, output: 200 });
      const updated = manager.getSession(session.sessionId)!;
      expect(updated.turnCount).toBe(1);
      expect(updated.totalTokens.input).toBe(1000);
      expect(updated.totalTokens.output).toBe(200);
    });

    it("accumulates tokens across multiple turns", () => {
      const session = manager.createSession({ projectId: "proj-1" });
      manager.incrementTurn(session.sessionId, { input: 500, output: 100 });
      manager.incrementTurn(session.sessionId, { input: 300, output: 50 });
      const updated = manager.getSession(session.sessionId)!;
      expect(updated.turnCount).toBe(2);
      expect(updated.totalTokens.input).toBe(800);
      expect(updated.totalTokens.output).toBe(150);
    });
  });

  describe("forkSession()", () => {
    it("creates a new session with parent reference", () => {
      const parent = manager.createSession({ projectId: "proj-1" });
      manager.appendMessage(parent.sessionId, {
        role: "user",
        content: "Original message",
        timestamp: Date.now(),
      });
      const fork = manager.forkSession(parent.sessionId);
      expect(fork.sessionId).not.toBe(parent.sessionId);
      expect(fork.parentSessionId).toBe(parent.sessionId);
      expect(fork.projectId).toBe(parent.projectId);
      expect(fork.messages).toHaveLength(1);
      expect(fork.messages[0].content).toBe("Original message");
    });
  });

  describe("listSessions()", () => {
    it("returns all sessions for a project", () => {
      manager.createSession({ projectId: "proj-1" });
      manager.createSession({ projectId: "proj-1" });
      manager.createSession({ projectId: "proj-2" });
      expect(manager.listSessions("proj-1")).toHaveLength(2);
      expect(manager.listSessions("proj-2")).toHaveLength(1);
    });
  });

  describe("saveSession() / restoreSession()", () => {
    it("serializes and restores a session", () => {
      const session = manager.createSession({ projectId: "proj-1" });
      manager.appendMessage(session.sessionId, {
        role: "user",
        content: "Hello",
        timestamp: 12345,
      });
      const serialized = manager.saveSession(session.sessionId);
      expect(typeof serialized).toBe("string");

      // Create a new store + manager to simulate restart
      const newStore = new SessionStore();
      const newManager = new SessionManager(newStore);
      const restored = newManager.restoreSession(serialized);
      expect(restored.sessionId).toBe(session.sessionId);
      expect(restored.messages).toHaveLength(1);
      expect(restored.messages[0].content).toBe("Hello");
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/session/__tests__/session-manager.test.ts`
Expected: FAIL — `Cannot find module '../session-manager.js'`

- [ ] **Step 4: Implement SessionStore**

```typescript
// apps/agent/src/session/session-store.ts

import type { AgentSession } from "./types.js";

/**
 * In-memory session store. Future: back with PostgreSQL.
 * All mutations go through this store so persistence is swappable.
 */
export class SessionStore {
  private sessions = new Map<string, AgentSession>();

  get(sessionId: string): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // Return a shallow copy to prevent external mutation
    return { ...session, messages: [...session.messages] };
  }

  set(session: AgentSession): void {
    this.sessions.set(session.sessionId, {
      ...session,
      messages: [...session.messages],
      updatedAt: Date.now(),
    });
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  listByProject(projectId: string): AgentSession[] {
    const result: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) {
        result.push({ ...session, messages: [...session.messages] });
      }
    }
    return result;
  }
}
```

- [ ] **Step 5: Implement SessionManager**

```typescript
// apps/agent/src/session/session-manager.ts

import type {
  AgentSession,
  SessionMessage,
  SessionStatus,
  CreateSessionParams,
} from "./types.js";
import type { SessionStore } from "./session-store.js";

export class SessionManager {
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  createSession(params: CreateSessionParams): AgentSession {
    const now = Date.now();
    const session: AgentSession = {
      sessionId: crypto.randomUUID(),
      projectId: params.projectId,
      status: "active",
      messages: [],
      totalTokens: { input: 0, output: 0 },
      turnCount: 0,
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(session);
    return { ...session, messages: [] };
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.store.get(sessionId);
  }

  appendMessage(sessionId: string, message: SessionMessage): void {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(message);
    this.store.set(session);
  }

  updateStatus(sessionId: string, status: SessionStatus): void {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.status = status;
    this.store.set(session);
  }

  incrementTurn(
    sessionId: string,
    tokens: { input: number; output: number },
  ): void {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.turnCount += 1;
    session.totalTokens.input += tokens.input;
    session.totalTokens.output += tokens.output;
    this.store.set(session);
  }

  forkSession(parentSessionId: string): AgentSession {
    const parent = this.store.get(parentSessionId);
    if (!parent) throw new Error(`Session not found: ${parentSessionId}`);
    const now = Date.now();
    const fork: AgentSession = {
      sessionId: crypto.randomUUID(),
      projectId: parent.projectId,
      status: "active",
      messages: [...parent.messages],
      totalTokens: { input: 0, output: 0 },
      turnCount: 0,
      metadata: { ...parent.metadata },
      createdAt: now,
      updatedAt: now,
      parentSessionId,
    };
    this.store.set(fork);
    return { ...fork, messages: [...fork.messages] };
  }

  listSessions(projectId: string): AgentSession[] {
    return this.store.listByProject(projectId);
  }

  saveSession(sessionId: string): string {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return JSON.stringify(session);
  }

  restoreSession(serialized: string): AgentSession {
    const session: AgentSession = JSON.parse(serialized);
    this.store.set(session);
    return { ...session, messages: [...session.messages] };
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/session/__tests__/session-manager.test.ts`
Expected: PASS (all 11 tests)

- [ ] **Step 7: Wire SessionManager into chat route**

Replace `apps/agent/src/routes/chat.ts`:

```typescript
// apps/agent/src/routes/chat.ts

import { Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "../session/session-manager.js";

const chatSchema = z.object({
  projectId: z.string().uuid(),
  message: z.string().min(1),
  sessionId: z.string().uuid().optional(),
});

export function createChatRouter(deps: { sessionManager: SessionManager }) {
  const chat = new Hono();

  chat.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = chatSchema.safeParse(body);
    if (!result.success) {
      return c.json(
        { error: "Invalid request body", issues: result.error.issues },
        400,
      );
    }

    const { projectId, message, sessionId: existingSessionId } = result.data;

    // Resume existing session or create new one
    let session;
    if (existingSessionId) {
      session = deps.sessionManager.getSession(existingSessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
    } else {
      session = deps.sessionManager.createSession({ projectId });
    }

    // Record the user message
    deps.sessionManager.appendMessage(session.sessionId, {
      role: "user",
      content: message,
      timestamp: Date.now(),
    });

    return c.json({ status: "processing", sessionId: session.sessionId });
  });

  return chat;
}

// Backward-compatible default export for existing tests
const chat = new Hono();
chat.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const chatSchemaLegacy = z.object({
    projectId: z.string().uuid(),
    message: z.string().min(1),
  });
  const result = chatSchemaLegacy.safeParse(body);
  if (!result.success) {
    return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
  }
  return c.json({ status: "processing", sessionId: "placeholder" });
});
export { chat };
```

- [ ] **Step 8: Run all tests to verify no regressions**

Run: `cd apps/agent && npm test`
Expected: All existing tests PASS + new session tests PASS

- [ ] **Step 9: Commit**

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/session/
git add apps/agent/src/routes/chat.ts
git commit -m "feat(agent): add SessionManager with create/resume/fork/save lifecycle

In-memory SessionStore backing SessionManager. Sessions track messages,
token usage, turn count, and parent references for forks. Chat route
upgraded with createChatRouter() factory that accepts SessionManager.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: ToolPipeline — Staged Tool Execution with Hooks

**Why:** `ToolExecutor.execute()` is a flat sequence (permission → validate → execute → log). Needs pre/post hooks, idempotency guard, failure classification, and tracing to support changeset interception, memory extraction, and safe retry.

**Files:**
- Create: `apps/agent/src/tools/hooks.ts`
- Create: `apps/agent/src/tools/failure-classifier.ts`
- Create: `apps/agent/src/tools/tool-pipeline.ts`
- Create: `apps/agent/src/tools/__tests__/tool-pipeline.test.ts`
- Create: `apps/agent/src/tools/__tests__/failure-classifier.test.ts`

---

- [ ] **Step 1: Create hook types and failure classifier**

```typescript
// apps/agent/src/tools/hooks.ts

import type { AgentType, ToolCallResult } from "./types.js";

export interface ToolHookContext {
  toolName: string;
  input: unknown;
  agentType: AgentType;
  taskId: string;
  idempotencyKey?: string;
}

/** Return `{ block: true, reason }` to prevent execution. */
export interface PreToolHookResult {
  block?: boolean;
  reason?: string;
  /** Optionally rewrite input before execution. */
  rewrittenInput?: unknown;
}

export interface PostToolHookResult {
  /** Optionally transform the result. */
  transformedResult?: ToolCallResult;
}

export interface ToolHook {
  name: string;
  /** Called before tool execution. Can block or rewrite input. */
  pre?: (ctx: ToolHookContext) => Promise<PreToolHookResult> | PreToolHookResult;
  /** Called after successful tool execution. */
  post?: (
    ctx: ToolHookContext,
    result: ToolCallResult,
  ) => Promise<PostToolHookResult> | PostToolHookResult;
  /** Called when tool execution fails. */
  onFailure?: (
    ctx: ToolHookContext,
    error: ToolCallResult,
  ) => Promise<void> | void;
}
```

```typescript
// apps/agent/src/tools/failure-classifier.ts

export type FailureType =
  | "permission_denied"
  | "validation_error"
  | "hook_blocked"
  | "execution_error"
  | "timeout"
  | "idempotency_conflict"
  | "unknown";

export interface ClassifiedFailure {
  type: FailureType;
  retryable: boolean;
  message: string;
}

export function classifyFailure(error: string): ClassifiedFailure {
  if (error.includes("not authorized")) {
    return { type: "permission_denied", retryable: false, message: error };
  }
  if (error.includes("Validation") || error.includes("Required") || error.includes("Expected")) {
    return { type: "validation_error", retryable: false, message: error };
  }
  if (error.includes("blocked by hook")) {
    return { type: "hook_blocked", retryable: false, message: error };
  }
  if (error.includes("idempotency")) {
    return { type: "idempotency_conflict", retryable: false, message: error };
  }
  if (error.includes("timeout") || error.includes("TIMEOUT")) {
    return { type: "timeout", retryable: true, message: error };
  }
  return { type: "execution_error", retryable: true, message: error };
}
```

- [ ] **Step 2: Write failing tests for ToolPipeline and FailureClassifier**

```typescript
// apps/agent/src/tools/__tests__/failure-classifier.test.ts

import { describe, it, expect } from "vitest";
import { classifyFailure } from "../failure-classifier.js";

describe("classifyFailure()", () => {
  it("classifies permission errors as non-retryable", () => {
    const result = classifyFailure('Agent type "asset" is not authorized to use tool "trim_element"');
    expect(result.type).toBe("permission_denied");
    expect(result.retryable).toBe(false);
  });

  it("classifies validation errors as non-retryable", () => {
    const result = classifyFailure("Validation error: Required field missing");
    expect(result.type).toBe("validation_error");
    expect(result.retryable).toBe(false);
  });

  it("classifies hook blocks as non-retryable", () => {
    const result = classifyFailure("Execution blocked by hook: changeset-guard");
    expect(result.type).toBe("hook_blocked");
    expect(result.retryable).toBe(false);
  });

  it("classifies timeouts as retryable", () => {
    const result = classifyFailure("Operation timeout after 30000ms");
    expect(result.type).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  it("classifies idempotency conflicts as non-retryable", () => {
    const result = classifyFailure("Duplicate idempotency key detected");
    expect(result.type).toBe("idempotency_conflict");
    expect(result.retryable).toBe(false);
  });

  it("defaults to retryable execution_error", () => {
    const result = classifyFailure("Something unexpected happened");
    expect(result.type).toBe("execution_error");
    expect(result.retryable).toBe(true);
  });
});
```

```typescript
// apps/agent/src/tools/__tests__/tool-pipeline.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolPipeline } from "../tool-pipeline.js";
import type { ToolHook, ToolHookContext } from "../hooks.js";
import type { ToolCallResult, ToolDefinition, AgentType } from "../types.js";
import { z } from "zod";

// Helper: create a minimal tool definition
function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: z.object({ value: z.string() }),
    agentTypes: ["editor" as AgentType],
    accessMode: "read",
    ...overrides,
  };
}

// Helper: create a mock executor that always succeeds
function makeExecutor(): (name: string, input: unknown, ctx: { agentType: AgentType; taskId: string }) => Promise<ToolCallResult> {
  return vi.fn(async () => ({ success: true, data: "executed" }));
}

describe("ToolPipeline", () => {
  let pipeline: ToolPipeline;
  let executor: ReturnType<typeof makeExecutor>;

  beforeEach(() => {
    executor = makeExecutor();
    pipeline = new ToolPipeline(executor);
  });

  describe("execute()", () => {
    it("runs the executor and returns result", async () => {
      pipeline.registerTool(makeTool());
      const result = await pipeline.execute("test_tool", { value: "hello" }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(result.success).toBe(true);
      expect(result.data).toBe("executed");
      expect(executor).toHaveBeenCalled();
    });

    it("rejects unknown tools", async () => {
      const result = await pipeline.execute("unknown", {}, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });

    it("rejects unauthorized agent types", async () => {
      pipeline.registerTool(makeTool({ agentTypes: ["master"] }));
      const result = await pipeline.execute("test_tool", { value: "x" }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not authorized");
    });

    it("rejects invalid input via Zod", async () => {
      pipeline.registerTool(makeTool());
      const result = await pipeline.execute("test_tool", { value: 123 }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(result.success).toBe(false);
      expect(result.classified?.type).toBe("validation_error");
    });
  });

  describe("hooks", () => {
    it("calls pre-hook before execution", async () => {
      const preHook = vi.fn(async () => ({}));
      const hook: ToolHook = { name: "test-hook", pre: preHook };
      pipeline.registerTool(makeTool());
      pipeline.registerHook(hook);

      await pipeline.execute("test_tool", { value: "x" }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(preHook).toHaveBeenCalledBefore(executor as any);
    });

    it("blocks execution when pre-hook returns block:true", async () => {
      const hook: ToolHook = {
        name: "blocker",
        pre: async () => ({ block: true, reason: "Blocked for safety" }),
      };
      pipeline.registerTool(makeTool());
      pipeline.registerHook(hook);

      const result = await pipeline.execute("test_tool", { value: "x" }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("blocked by hook");
      expect(executor).not.toHaveBeenCalled();
    });

    it("allows pre-hook to rewrite input", async () => {
      const hook: ToolHook = {
        name: "rewriter",
        pre: async () => ({ rewrittenInput: { value: "rewritten" } }),
      };
      pipeline.registerTool(makeTool());
      pipeline.registerHook(hook);

      await pipeline.execute("test_tool", { value: "original" }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(executor).toHaveBeenCalledWith(
        "test_tool",
        { value: "rewritten" },
        expect.any(Object),
      );
    });

    it("calls post-hook after successful execution", async () => {
      const postHook = vi.fn(async () => ({}));
      const hook: ToolHook = { name: "post-test", post: postHook };
      pipeline.registerTool(makeTool());
      pipeline.registerHook(hook);

      await pipeline.execute("test_tool", { value: "x" }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(postHook).toHaveBeenCalled();
    });

    it("calls onFailure hook when execution fails", async () => {
      const failHook = vi.fn(async () => {});
      const hook: ToolHook = { name: "fail-hook", onFailure: failHook };
      const failingExecutor = vi.fn(async () => ({
        success: false,
        error: "Something broke",
      }));
      pipeline = new ToolPipeline(failingExecutor);
      pipeline.registerTool(makeTool());
      pipeline.registerHook(hook);

      await pipeline.execute("test_tool", { value: "x" }, {
        agentType: "editor",
        taskId: "t1",
      });
      expect(failHook).toHaveBeenCalled();
    });
  });

  describe("idempotency", () => {
    it("rejects duplicate idempotency keys", async () => {
      pipeline.registerTool(makeTool({ accessMode: "write" }));
      const ctx = { agentType: "editor" as AgentType, taskId: "t1" };

      await pipeline.execute("test_tool", { value: "x" }, ctx, "idem-key-1");
      const result = await pipeline.execute("test_tool", { value: "x" }, ctx, "idem-key-1");
      expect(result.success).toBe(false);
      expect(result.classified?.type).toBe("idempotency_conflict");
    });

    it("allows different idempotency keys", async () => {
      pipeline.registerTool(makeTool({ accessMode: "write" }));
      const ctx = { agentType: "editor" as AgentType, taskId: "t1" };

      const r1 = await pipeline.execute("test_tool", { value: "x" }, ctx, "key-a");
      const r2 = await pipeline.execute("test_tool", { value: "x" }, ctx, "key-b");
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });
  });

  describe("tracing", () => {
    it("records trace entries for all executions", async () => {
      pipeline.registerTool(makeTool());
      await pipeline.execute("test_tool", { value: "x" }, {
        agentType: "editor",
        taskId: "t1",
      });
      const traces = pipeline.getTraces();
      expect(traces).toHaveLength(1);
      expect(traces[0].toolName).toBe("test_tool");
      expect(traces[0].success).toBe(true);
      expect(traces[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/tool-pipeline.test.ts src/tools/__tests__/failure-classifier.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement ToolPipeline**

```typescript
// apps/agent/src/tools/tool-pipeline.ts

import type { AgentType, ToolCallResult, ToolDefinition } from "./types.js";
import type { ToolHook, ToolHookContext } from "./hooks.js";
import { classifyFailure, type ClassifiedFailure } from "./failure-classifier.js";

export interface PipelineResult extends ToolCallResult {
  classified?: ClassifiedFailure;
}

export interface TraceEntry {
  toolName: string;
  agentType: AgentType;
  taskId: string;
  success: boolean;
  durationMs: number;
  classified?: ClassifiedFailure;
  timestamp: number;
}

type ExecutorFn = (
  name: string,
  input: unknown,
  ctx: { agentType: AgentType; taskId: string },
) => Promise<ToolCallResult>;

export class ToolPipeline {
  private tools = new Map<string, ToolDefinition>();
  private hooks: ToolHook[] = [];
  private seenIdempotencyKeys = new Set<string>();
  private traces: TraceEntry[] = [];
  private executor: ExecutorFn;

  constructor(executor: ExecutorFn) {
    this.executor = executor;
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerHook(hook: ToolHook): void {
    this.hooks.push(hook);
  }

  getTraces(): readonly TraceEntry[] {
    return this.traces;
  }

  async execute(
    toolName: string,
    input: unknown,
    ctx: { agentType: AgentType; taskId: string },
    idempotencyKey?: string,
  ): Promise<PipelineResult> {
    const start = performance.now();

    // ── Stage 1: Preflight ──────────────────────────────────────────────
    const tool = this.tools.get(toolName);
    if (!tool) {
      return this.fail(toolName, ctx, start, `Unknown tool: "${toolName}"`);
    }

    if (!tool.agentTypes.includes(ctx.agentType)) {
      return this.fail(
        toolName,
        ctx,
        start,
        `Agent type "${ctx.agentType}" is not authorized to use tool "${toolName}"`,
      );
    }

    // Zod validation
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return this.fail(toolName, ctx, start, parsed.error.message);
    }

    // Idempotency check (only for write operations with a key)
    if (idempotencyKey && (tool.accessMode === "write" || tool.accessMode === "read_write")) {
      if (this.seenIdempotencyKeys.has(idempotencyKey)) {
        return this.fail(
          toolName,
          ctx,
          start,
          `Duplicate idempotency key: ${idempotencyKey}`,
        );
      }
      this.seenIdempotencyKeys.add(idempotencyKey);
    }

    // ── Stage 2: Pre-hooks ──────────────────────────────────────────────
    const hookCtx: ToolHookContext = {
      toolName,
      input: parsed.data,
      agentType: ctx.agentType,
      taskId: ctx.taskId,
      idempotencyKey,
    };

    let finalInput = parsed.data;
    for (const hook of this.hooks) {
      if (hook.pre) {
        const preResult = await hook.pre(hookCtx);
        if (preResult.block) {
          return this.fail(
            toolName,
            ctx,
            start,
            `Execution blocked by hook: ${hook.name} — ${preResult.reason ?? "no reason"}`,
          );
        }
        if (preResult.rewrittenInput !== undefined) {
          finalInput = preResult.rewrittenInput;
        }
      }
    }

    // ── Stage 3: Execute ────────────────────────────────────────────────
    const result = await this.executor(toolName, finalInput, ctx);

    // ── Stage 4: Post-hooks / Failure-hooks ─────────────────────────────
    if (result.success) {
      let finalResult = result;
      for (const hook of this.hooks) {
        if (hook.post) {
          const postResult = await hook.post(hookCtx, finalResult);
          if (postResult.transformedResult) {
            finalResult = postResult.transformedResult;
          }
        }
      }
      this.trace(toolName, ctx, start, true);
      return finalResult;
    }

    // Failure path
    for (const hook of this.hooks) {
      if (hook.onFailure) {
        await hook.onFailure(hookCtx, result);
      }
    }

    const classified = classifyFailure(result.error ?? "unknown error");
    this.trace(toolName, ctx, start, false, classified);
    return { ...result, classified };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private fail(
    toolName: string,
    ctx: { agentType: AgentType; taskId: string },
    start: number,
    error: string,
  ): PipelineResult {
    const classified = classifyFailure(error);
    this.trace(toolName, ctx, start, false, classified);
    return { success: false, error, classified };
  }

  private trace(
    toolName: string,
    ctx: { agentType: AgentType; taskId: string },
    start: number,
    success: boolean,
    classified?: ClassifiedFailure,
  ): void {
    this.traces.push({
      toolName,
      agentType: ctx.agentType,
      taskId: ctx.taskId,
      success,
      durationMs: performance.now() - start,
      classified,
      timestamp: Date.now(),
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/tool-pipeline.test.ts src/tools/__tests__/failure-classifier.test.ts`
Expected: PASS (all 13 pipeline tests + 6 classifier tests)

- [ ] **Step 6: Run all tests to verify no regressions**

Run: `cd apps/agent && npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/tools/hooks.ts
git add apps/agent/src/tools/failure-classifier.ts
git add apps/agent/src/tools/tool-pipeline.ts
git add apps/agent/src/tools/__tests__/tool-pipeline.test.ts
git add apps/agent/src/tools/__tests__/failure-classifier.test.ts
git commit -m "feat(agent): add ToolPipeline with hooks, idempotency, failure classification

Staged pipeline: preflight (permission + validation + idempotency) →
pre-hooks (block / rewrite) → execute → post-hooks / failure-hooks →
trace. FailureClassifier categorizes errors into 6 types with
retryable flag.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — Cognition & Collaboration

---

### Task 4: TaskRegistry — Unified Async Task Model

**Why:** Exploration, generation, export, and agent dispatch all create async work but have no unified model. `status.ts` returns hardcoded `idle`. The UI has no way to track, cancel, or subscribe to task progress.

**Files:**
- Create: `apps/agent/src/tasks/types.ts`
- Create: `apps/agent/src/tasks/task-registry.ts`
- Create: `apps/agent/src/tasks/__tests__/task-registry.test.ts`

---

- [ ] **Step 1: Create task types**

```typescript
// apps/agent/src/tasks/types.ts

export type TaskType =
  | "agent_dispatch"
  | "exploration"
  | "generation"
  | "render_preview"
  | "export"
  | "verification";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTask {
  taskId: string;
  type: TaskType;
  status: TaskStatus;
  /** Human-readable description. */
  description: string;
  /** Which session created this task. */
  sessionId?: string;
  /** Which changeset this task belongs to. */
  changesetId?: string;
  /** Parent task ID for hierarchical tasks (e.g., exploration → preview renders). */
  parentTaskId?: string;
  /** Progress percentage (0-100). */
  progress: number;
  /** Task result (set on completion). */
  result?: unknown;
  /** Error message (set on failure). */
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CreateTaskParams {
  type: TaskType;
  description: string;
  sessionId?: string;
  changesetId?: string;
  parentTaskId?: string;
}
```

- [ ] **Step 2: Write failing test**

```typescript
// apps/agent/src/tasks/__tests__/task-registry.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskRegistry } from "../task-registry.js";

describe("TaskRegistry", () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  describe("createTask()", () => {
    it("creates a task with queued status", () => {
      const task = registry.createTask({
        type: "generation",
        description: "Generate video clip",
      });
      expect(task.taskId).toBeTruthy();
      expect(task.status).toBe("queued");
      expect(task.progress).toBe(0);
    });

    it("links task to session and changeset", () => {
      const task = registry.createTask({
        type: "agent_dispatch",
        description: "Dispatch editor",
        sessionId: "sess-1",
        changesetId: "cs-1",
      });
      expect(task.sessionId).toBe("sess-1");
      expect(task.changesetId).toBe("cs-1");
    });
  });

  describe("getTask()", () => {
    it("returns undefined for unknown task", () => {
      expect(registry.getTask("nonexistent")).toBeUndefined();
    });

    it("returns the task by ID", () => {
      const created = registry.createTask({ type: "export", description: "Export MP4" });
      expect(registry.getTask(created.taskId)?.description).toBe("Export MP4");
    });
  });

  describe("updateProgress()", () => {
    it("updates progress and sets status to running", () => {
      const task = registry.createTask({ type: "generation", description: "Gen" });
      registry.updateProgress(task.taskId, 50);
      const updated = registry.getTask(task.taskId)!;
      expect(updated.progress).toBe(50);
      expect(updated.status).toBe("running");
    });
  });

  describe("completeTask()", () => {
    it("marks task as completed with result", () => {
      const task = registry.createTask({ type: "generation", description: "Gen" });
      registry.completeTask(task.taskId, { url: "https://example.com/video.mp4" });
      const updated = registry.getTask(task.taskId)!;
      expect(updated.status).toBe("completed");
      expect(updated.progress).toBe(100);
      expect(updated.result).toEqual({ url: "https://example.com/video.mp4" });
      expect(updated.completedAt).toBeGreaterThan(0);
    });
  });

  describe("failTask()", () => {
    it("marks task as failed with error", () => {
      const task = registry.createTask({ type: "generation", description: "Gen" });
      registry.failTask(task.taskId, "Provider timeout");
      const updated = registry.getTask(task.taskId)!;
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("Provider timeout");
    });
  });

  describe("cancelTask()", () => {
    it("marks queued task as cancelled", () => {
      const task = registry.createTask({ type: "generation", description: "Gen" });
      registry.cancelTask(task.taskId);
      expect(registry.getTask(task.taskId)!.status).toBe("cancelled");
    });

    it("returns false for already completed task", () => {
      const task = registry.createTask({ type: "generation", description: "Gen" });
      registry.completeTask(task.taskId, {});
      const cancelled = registry.cancelTask(task.taskId);
      expect(cancelled).toBe(false);
    });
  });

  describe("listTasks()", () => {
    it("returns all tasks", () => {
      registry.createTask({ type: "generation", description: "A" });
      registry.createTask({ type: "export", description: "B" });
      expect(registry.listTasks()).toHaveLength(2);
    });

    it("filters by status", () => {
      const t1 = registry.createTask({ type: "generation", description: "A" });
      registry.createTask({ type: "export", description: "B" });
      registry.completeTask(t1.taskId, {});
      expect(registry.listTasks({ status: "completed" })).toHaveLength(1);
      expect(registry.listTasks({ status: "queued" })).toHaveLength(1);
    });

    it("filters by session", () => {
      registry.createTask({ type: "generation", description: "A", sessionId: "s1" });
      registry.createTask({ type: "export", description: "B", sessionId: "s2" });
      expect(registry.listTasks({ sessionId: "s1" })).toHaveLength(1);
    });
  });

  describe("getChildTasks()", () => {
    it("returns tasks with matching parentTaskId", () => {
      const parent = registry.createTask({ type: "exploration", description: "Explore" });
      registry.createTask({
        type: "render_preview",
        description: "Render candidate 1",
        parentTaskId: parent.taskId,
      });
      registry.createTask({
        type: "render_preview",
        description: "Render candidate 2",
        parentTaskId: parent.taskId,
      });
      expect(registry.getChildTasks(parent.taskId)).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/tasks/__tests__/task-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement TaskRegistry**

```typescript
// apps/agent/src/tasks/task-registry.ts

import type { AgentTask, CreateTaskParams, TaskStatus } from "./types.js";

export class TaskRegistry {
  private tasks = new Map<string, AgentTask>();

  createTask(params: CreateTaskParams): AgentTask {
    const now = Date.now();
    const task: AgentTask = {
      taskId: crypto.randomUUID(),
      type: params.type,
      status: "queued",
      description: params.description,
      sessionId: params.sessionId,
      changesetId: params.changesetId,
      parentTaskId: params.parentTaskId,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    return { ...task };
  }

  getTask(taskId: string): AgentTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  updateProgress(taskId: string, progress: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.progress = Math.min(100, Math.max(0, progress));
    if (task.status === "queued") task.status = "running";
    task.updatedAt = Date.now();
  }

  completeTask(taskId: string, result: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "completed";
    task.progress = 100;
    task.result = result;
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
  }

  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "failed";
    task.error = error;
    task.updatedAt = Date.now();
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "failed") return false;
    task.status = "cancelled";
    task.updatedAt = Date.now();
    return true;
  }

  listTasks(filter?: { status?: TaskStatus; sessionId?: string }): AgentTask[] {
    let result = Array.from(this.tasks.values());
    if (filter?.status) {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter?.sessionId) {
      result = result.filter((t) => t.sessionId === filter.sessionId);
    }
    return result.map((t) => ({ ...t }));
  }

  getChildTasks(parentTaskId: string): AgentTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.parentTaskId === parentTaskId)
      .map((t) => ({ ...t }));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/tasks/__tests__/task-registry.test.ts`
Expected: PASS (all 12 tests)

- [ ] **Step 6: Run all tests, commit**

Run: `cd apps/agent && npm test`

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/tasks/
git commit -m "feat(agent): add TaskRegistry for unified async task model

Supports create, progress update, complete, fail, cancel. Tasks linked
to sessions and changesets. Hierarchical parent→child relationships for
exploration→preview renders. Filter by status and session.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: EventBus + EventProtocol — Real SSE Event Stream

**Why:** `events.ts` only sends a `connected` event. The UI needs to subscribe to tool calls, changeset proposals, task progress, memory updates, and session state changes.

**Files:**
- Create: `apps/agent/src/events/types.ts`
- Create: `apps/agent/src/events/event-bus.ts`
- Create: `apps/agent/src/events/event-protocol.ts`
- Create: `apps/agent/src/events/__tests__/event-bus.test.ts`
- Modify: `apps/agent/src/routes/events.ts`

---

- [ ] **Step 1: Create event types**

```typescript
// apps/agent/src/events/types.ts

export type RuntimeEventType =
  | "session.created"
  | "session.resumed"
  | "session.completed"
  | "agent.turn_start"
  | "agent.turn_end"
  | "tool.called"
  | "tool.result"
  | "task.created"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "changeset.proposed"
  | "changeset.approved"
  | "changeset.rejected"
  | "memory.injected"
  | "exploration.started"
  | "exploration.candidate_ready";

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: number;
  sessionId?: string;
  taskId?: string;
  data: Record<string, unknown>;
}
```

- [ ] **Step 2: Write failing test**

```typescript
// apps/agent/src/events/__tests__/event-bus.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../event-bus.js";
import type { RuntimeEvent, RuntimeEventType } from "../types.js";
import { serializeEvent } from "../event-protocol.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe("emit() and on()", () => {
    it("delivers events to matching subscribers", () => {
      const handler = vi.fn();
      bus.on("tool.called", handler);

      const event: RuntimeEvent = {
        type: "tool.called",
        timestamp: Date.now(),
        data: { toolName: "trim_element" },
      };
      bus.emit(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("does not deliver events to non-matching subscribers", () => {
      const handler = vi.fn();
      bus.on("session.created", handler);

      bus.emit({
        type: "tool.called",
        timestamp: Date.now(),
        data: { toolName: "trim_element" },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("supports wildcard * subscription", () => {
      const handler = vi.fn();
      bus.on("*", handler);

      bus.emit({ type: "tool.called", timestamp: Date.now(), data: {} });
      bus.emit({ type: "session.created", timestamp: Date.now(), data: {} });

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("off()", () => {
    it("removes a specific handler", () => {
      const handler = vi.fn();
      bus.on("tool.called", handler);
      bus.off("tool.called", handler);

      bus.emit({ type: "tool.called", timestamp: Date.now(), data: {} });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("onAll()", () => {
    it("subscribes to all events and returns unsubscribe function", () => {
      const handler = vi.fn();
      const unsub = bus.onAll(handler);

      bus.emit({ type: "tool.called", timestamp: Date.now(), data: {} });
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      bus.emit({ type: "tool.called", timestamp: Date.now(), data: {} });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("history", () => {
    it("stores last N events", () => {
      bus = new EventBus({ historySize: 3 });

      bus.emit({ type: "tool.called", timestamp: 1, data: { n: 1 } });
      bus.emit({ type: "tool.called", timestamp: 2, data: { n: 2 } });
      bus.emit({ type: "tool.called", timestamp: 3, data: { n: 3 } });
      bus.emit({ type: "tool.called", timestamp: 4, data: { n: 4 } });

      const history = bus.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].data.n).toBe(2);
      expect(history[2].data.n).toBe(4);
    });
  });
});

describe("serializeEvent()", () => {
  it("serializes an event to SSE format", () => {
    const event: RuntimeEvent = {
      type: "tool.called",
      timestamp: 1000,
      sessionId: "s1",
      data: { toolName: "trim_element" },
    };
    const sse = serializeEvent(event);
    expect(sse.event).toBe("tool.called");
    expect(typeof sse.data).toBe("string");
    const parsed = JSON.parse(sse.data);
    expect(parsed.toolName).toBe("trim_element");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.timestamp).toBe(1000);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/events/__tests__/event-bus.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement EventBus and EventProtocol**

```typescript
// apps/agent/src/events/event-bus.ts

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
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  off(type: RuntimeEventType | "*", handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  onAll(handler: EventHandler): () => void {
    this.on("*", handler);
    return () => this.off("*", handler);
  }

  emit(event: RuntimeEvent): void {
    // Store in history
    this.history.push(event);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }

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
    return [...this.history];
  }
}
```

```typescript
// apps/agent/src/events/event-protocol.ts

import type { RuntimeEvent } from "./types.js";

/** Serialize a RuntimeEvent into SSE-compatible { event, data } pair. */
export function serializeEvent(event: RuntimeEvent): { event: string; data: string } {
  const { type, data, ...rest } = event;
  return {
    event: type,
    data: JSON.stringify({ ...data, ...rest }),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/events/__tests__/event-bus.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 6: Upgrade events route to use EventBus**

```typescript
// apps/agent/src/routes/events.ts

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../events/event-bus.js";
import { serializeEvent } from "../events/event-protocol.js";

export function createEventsRouter(deps: { eventBus: EventBus }) {
  const eventsRouter = new Hono();

  eventsRouter.get("/", (c) => {
    return streamSSE(c, async (stream) => {
      // Send initial connection event
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ message: "SSE connection established" }),
      });

      // Subscribe to all runtime events
      const unsub = deps.eventBus.onAll(async (event) => {
        const sse = serializeEvent(event);
        await stream.writeSSE(sse);
      });

      // Keep connection alive; clean up on close
      stream.onAbort(() => {
        unsub();
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  return eventsRouter;
}

// Backward-compatible export
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
```

- [ ] **Step 7: Run all tests, commit**

Run: `cd apps/agent && npm test`

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/events/
git add apps/agent/src/routes/events.ts
git commit -m "feat(agent): add EventBus and EventProtocol for typed runtime events

17 event types covering sessions, tools, tasks, changesets, memory,
and exploration. EventBus supports type-specific and wildcard
subscriptions with ring-buffer history. Events route upgraded to
stream all runtime events via SSE.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: MemoryIndex + MemorySelector + SessionMemory

**Why:** Current MemoryLoader reads all matching files and truncates by token budget. It lacks: (1) a lightweight index to avoid loading every file, (2) relevance scoring to pick the right memories for this specific query, (3) session memory for short-term continuity.

**Files:**
- Create: `apps/agent/src/memory/memory-index.ts`
- Create: `apps/agent/src/memory/memory-selector.ts`
- Create: `apps/agent/src/memory/session-memory.ts`
- Create: `apps/agent/src/memory/__tests__/memory-index.test.ts`
- Create: `apps/agent/src/memory/__tests__/memory-selector.test.ts`
- Create: `apps/agent/src/memory/__tests__/session-memory.test.ts`

---

- [ ] **Step 1: Write failing tests for MemoryIndex**

```typescript
// apps/agent/src/memory/__tests__/memory-index.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryIndex } from "../memory-index.js";
import type { ParsedMemory } from "../types.js";

function makeMemory(overrides: Partial<ParsedMemory> = {}): ParsedMemory {
  return {
    memory_id: "mem-1",
    type: "preference",
    status: "active",
    confidence: "high",
    source: "explicit",
    created: "2026-01-01",
    updated: "2026-03-01",
    reinforced_count: 3,
    last_reinforced_at: "2026-03-01",
    source_change_ids: [],
    used_in_changeset_ids: [],
    created_session_id: "s1",
    scope: "global",
    scope_level: "global",
    semantic_key: "default-transition-style",
    tags: ["transition", "style"],
    content: "User prefers cross-dissolve transitions.",
    ...overrides,
  };
}

describe("MemoryIndex", () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex();
  });

  describe("add() and getAll()", () => {
    it("stores memory entries", () => {
      index.add(makeMemory());
      expect(index.getAll()).toHaveLength(1);
    });

    it("deduplicates by memory_id", () => {
      index.add(makeMemory({ memory_id: "m1" }));
      index.add(makeMemory({ memory_id: "m1" }));
      expect(index.getAll()).toHaveLength(1);
    });
  });

  describe("findByTags()", () => {
    it("returns memories matching any of the given tags", () => {
      index.add(makeMemory({ memory_id: "m1", tags: ["transition", "style"] }));
      index.add(makeMemory({ memory_id: "m2", tags: ["audio", "volume"] }));
      expect(index.findByTags(["transition"])).toHaveLength(1);
      expect(index.findByTags(["transition"]).map((m) => m.memory_id)).toEqual(["m1"]);
    });
  });

  describe("findByScope()", () => {
    it("returns memories matching the scope level", () => {
      index.add(makeMemory({ memory_id: "m1", scope_level: "global" }));
      index.add(makeMemory({ memory_id: "m2", scope_level: "brand" }));
      expect(index.findByScope("brand")).toHaveLength(1);
    });
  });

  describe("findBySemanticKey()", () => {
    it("returns memory by semantic key", () => {
      index.add(makeMemory({ semantic_key: "cut-style" }));
      expect(index.findBySemanticKey("cut-style")).toBeDefined();
      expect(index.findBySemanticKey("nonexistent")).toBeUndefined();
    });
  });

  describe("remove()", () => {
    it("removes memory by ID", () => {
      index.add(makeMemory({ memory_id: "m1" }));
      index.remove("m1");
      expect(index.getAll()).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Write failing tests for MemorySelector**

```typescript
// apps/agent/src/memory/__tests__/memory-selector.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { MemorySelector } from "../memory-selector.js";
import type { ParsedMemory, TaskContext } from "../types.js";

function makeMemory(overrides: Partial<ParsedMemory> = {}): ParsedMemory {
  return {
    memory_id: "mem-1", type: "preference", status: "active",
    confidence: "high", source: "explicit",
    created: "2026-01-01", updated: "2026-03-01",
    reinforced_count: 3, last_reinforced_at: "2026-03-01",
    source_change_ids: [], used_in_changeset_ids: [],
    created_session_id: "s1", scope: "global", scope_level: "global",
    semantic_key: "key-1", tags: ["style"], content: "Content",
    ...overrides,
  };
}

function makeTaskContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    brand: "test-brand",
    sessionId: "sess-1",
    agentType: "editor",
    ...overrides,
  };
}

describe("MemorySelector", () => {
  let selector: MemorySelector;

  beforeEach(() => {
    selector = new MemorySelector();
  });

  describe("selectRelevant()", () => {
    it("excludes stale and deprecated memories", () => {
      const memories = [
        makeMemory({ memory_id: "m1", status: "active" }),
        makeMemory({ memory_id: "m2", status: "stale" }),
        makeMemory({ memory_id: "m3", status: "deprecated" }),
      ];
      const result = selector.selectRelevant(memories, makeTaskContext());
      expect(result.map((m) => m.memory_id)).toEqual(["m1"]);
    });

    it("prefers higher scope_level when semantic_key conflicts", () => {
      const memories = [
        makeMemory({ memory_id: "m1", scope_level: "global", semantic_key: "cut-style" }),
        makeMemory({ memory_id: "m2", scope_level: "brand", semantic_key: "cut-style" }),
      ];
      const result = selector.selectRelevant(memories, makeTaskContext());
      expect(result).toHaveLength(1);
      expect(result[0].memory_id).toBe("m2");
    });

    it("filters draft memories that are not in the current session activation scope", () => {
      const memories = [
        makeMemory({
          memory_id: "m1",
          status: "draft",
          activation_scope: { session_id: "other-session" },
        }),
        makeMemory({
          memory_id: "m2",
          status: "draft",
          activation_scope: { session_id: "sess-1" },
        }),
      ];
      const result = selector.selectRelevant(memories, makeTaskContext({ sessionId: "sess-1" }));
      expect(result.map((m) => m.memory_id)).toEqual(["m2"]);
    });

    it("respects token budget", () => {
      const memories = Array.from({ length: 20 }, (_, i) =>
        makeMemory({
          memory_id: `m${i}`,
          semantic_key: `key-${i}`,
          content: "A".repeat(500),
        }),
      );
      const result = selector.selectRelevant(memories, makeTaskContext({ tokenBudget: 2000 }));
      // Each memory ~500 chars ≈ 125 tokens. Budget 2000 tokens → ~16 memories max.
      expect(result.length).toBeLessThan(20);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 3: Write failing tests for SessionMemory**

```typescript
// apps/agent/src/memory/__tests__/session-memory.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { SessionMemory } from "../session-memory.js";

describe("SessionMemory", () => {
  let mem: SessionMemory;

  beforeEach(() => {
    mem = new SessionMemory({ maxEntries: 5 });
  });

  describe("record()", () => {
    it("stores a session memory entry", () => {
      mem.record({ type: "user_intent", content: "Trim the intro to 3s" });
      expect(mem.getEntries()).toHaveLength(1);
      expect(mem.getEntries()[0].content).toBe("Trim the intro to 3s");
    });

    it("evicts oldest entry when maxEntries exceeded", () => {
      for (let i = 0; i < 6; i++) {
        mem.record({ type: "user_intent", content: `entry-${i}` });
      }
      expect(mem.getEntries()).toHaveLength(5);
      expect(mem.getEntries()[0].content).toBe("entry-1");
    });
  });

  describe("summarize()", () => {
    it("produces a text summary of all entries", () => {
      mem.record({ type: "user_intent", content: "Trim intro" });
      mem.record({ type: "tool_result", content: "Trimmed to 3s" });
      const summary = mem.summarize();
      expect(summary).toContain("Trim intro");
      expect(summary).toContain("Trimmed to 3s");
    });

    it("returns empty string when no entries", () => {
      expect(mem.summarize()).toBe("");
    });
  });

  describe("clear()", () => {
    it("removes all entries", () => {
      mem.record({ type: "user_intent", content: "Hello" });
      mem.clear();
      expect(mem.getEntries()).toHaveLength(0);
    });
  });

  describe("toPromptText()", () => {
    it("formats entries with type labels for injection", () => {
      mem.record({ type: "user_intent", content: "Make it shorter" });
      mem.record({ type: "agent_action", content: "Trimmed clip A by 2s" });
      const text = mem.toPromptText();
      expect(text).toContain("[user_intent]");
      expect(text).toContain("[agent_action]");
    });
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd apps/agent && npx vitest run src/memory/__tests__/memory-index.test.ts src/memory/__tests__/memory-selector.test.ts src/memory/__tests__/session-memory.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 5: Implement MemoryIndex**

```typescript
// apps/agent/src/memory/memory-index.ts

import type { ParsedMemory } from "./types.js";

export class MemoryIndex {
  private entries = new Map<string, ParsedMemory>();

  add(memory: ParsedMemory): void {
    this.entries.set(memory.memory_id, memory);
  }

  remove(memoryId: string): void {
    this.entries.delete(memoryId);
  }

  getAll(): ParsedMemory[] {
    return Array.from(this.entries.values());
  }

  findByTags(tags: string[]): ParsedMemory[] {
    const tagSet = new Set(tags);
    return this.getAll().filter((m) =>
      m.tags.some((t) => tagSet.has(t)),
    );
  }

  findByScope(scopeLevel: ParsedMemory["scope_level"]): ParsedMemory[] {
    return this.getAll().filter((m) => m.scope_level === scopeLevel);
  }

  findBySemanticKey(key: string): ParsedMemory | undefined {
    return this.getAll().find((m) => m.semantic_key === key);
  }
}
```

- [ ] **Step 6: Implement MemorySelector**

```typescript
// apps/agent/src/memory/memory-selector.ts

import type { ParsedMemory, TaskContext } from "./types.js";

const SCOPE_RANK: Record<ParsedMemory["scope_level"], number> = {
  global: 0,
  brand: 1,
  platform: 2,
  series: 3,
  project: 4,
};

export class MemorySelector {
  selectRelevant(
    memories: ParsedMemory[],
    task: TaskContext,
  ): ParsedMemory[] {
    // Step 1: Filter stale/deprecated
    let candidates = memories.filter(
      (m) => m.status !== "stale" && m.status !== "deprecated",
    );

    // Step 2: Filter drafts by activation scope
    candidates = candidates.filter((m) => {
      if (m.status !== "draft") return true;
      if (!m.activation_scope) return true;
      return m.activation_scope.session_id === task.sessionId;
    });

    // Step 3: Merge by semantic_key — keep highest scope
    const byKey = new Map<string, ParsedMemory>();
    for (const mem of candidates) {
      const existing = byKey.get(mem.semantic_key);
      if (!existing || SCOPE_RANK[mem.scope_level] > SCOPE_RANK[existing.scope_level]) {
        byKey.set(mem.semantic_key, mem);
      }
    }
    candidates = Array.from(byKey.values());

    // Step 4: Token budget truncation
    const budget = task.tokenBudget ?? 4000;
    const charBudget = budget * 4; // ~4 chars per token
    let totalChars = 0;
    const selected: ParsedMemory[] = [];
    for (const mem of candidates) {
      const charCount = mem.content.length + mem.semantic_key.length + 20;
      if (totalChars + charCount > charBudget) break;
      totalChars += charCount;
      selected.push(mem);
    }

    return selected;
  }
}
```

- [ ] **Step 7: Implement SessionMemory**

```typescript
// apps/agent/src/memory/session-memory.ts

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

export class SessionMemory {
  private entries: SessionMemoryEntry[] = [];
  private maxEntries: number;

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? 50;
  }

  record(entry: { type: SessionMemoryType; content: string }): void {
    this.entries.push({ ...entry, timestamp: Date.now() });
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  getEntries(): readonly SessionMemoryEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  summarize(): string {
    if (this.entries.length === 0) return "";
    return this.entries.map((e) => `- ${e.content}`).join("\n");
  }

  toPromptText(): string {
    if (this.entries.length === 0) return "";
    return this.entries
      .map((e) => `[${e.type}] ${e.content}`)
      .join("\n");
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/agent && npx vitest run src/memory/__tests__/memory-index.test.ts src/memory/__tests__/memory-selector.test.ts src/memory/__tests__/session-memory.test.ts`
Expected: PASS (all tests)

- [ ] **Step 9: Run all tests, commit**

Run: `cd apps/agent && npm test`

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/memory/memory-index.ts
git add apps/agent/src/memory/memory-selector.ts
git add apps/agent/src/memory/session-memory.ts
git add apps/agent/src/memory/__tests__/memory-index.test.ts
git add apps/agent/src/memory/__tests__/memory-selector.test.ts
git add apps/agent/src/memory/__tests__/session-memory.test.ts
git commit -m "feat(agent): add MemoryIndex, MemorySelector, and SessionMemory

MemoryIndex provides tag/scope/semantic-key lookups without loading all
files. MemorySelector filters stale/deprecated, merges by scope
precedence, and enforces token budgets. SessionMemory tracks short-term
conversation continuity with ring buffer and prompt injection.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Master Delegation Contract

**Why:** Master only tells the model "you coordinate sub-agents" but doesn't teach it HOW — when to dispatch vs handle directly, what context to include, how to handle failures. This prompt-level protocol is the highest-leverage stability improvement.

**Files:**
- Create: `apps/agent/src/prompt/delegation-contract.ts`
- Modify: `apps/agent/src/agents/master-agent.ts`

---

- [ ] **Step 1: Create the delegation contract prompt section**

```typescript
// apps/agent/src/prompt/delegation-contract.ts

import type { PromptSection } from "./types.js";

/**
 * Prompt section that teaches the Master Agent how to correctly delegate
 * tasks to sub-agents. Based on advanced agent delegation protocol patterns.
 */
export const delegationContractSection: PromptSection = {
  key: "delegationContract",
  priority: 15,
  isStatic: true,
  render: () => `## Sub-Agent Delegation Contract

### When to Dispatch vs Handle Directly
- **Dispatch** when the task requires specialist tools you don't have (editing, generation, audio, vision, asset lookup).
- **Handle directly** when you can answer from the project context, memory, or conversation history alone.
- **Never dispatch just to "check" something** — use your own context awareness first.

### Writing the Task Description
Every dispatch MUST include:
1. **What** — a clear, specific instruction (not "look at the video" but "find the scene where the main character enters the cafe, between 0:00-0:30").
2. **Why** — the user's intent so the sub-agent can make judgment calls.
3. **Constraints** — any limits on scope, elements, or time ranges.
4. **Context** — pass relevant analysis results, previous sub-agent findings, or user corrections.

### Dispatch Rules
- **One task per dispatch.** Don't ask an agent to do two unrelated things.
- **Never guess sub-agent results.** Wait for the response before continuing.
- **For parallel-safe tasks** (e.g., vision analysis + asset search), dispatch them together.
- **For sequential tasks** (e.g., analyze → then edit), wait for step 1 before dispatching step 2.

### Handling Sub-Agent Results
- If the sub-agent returns **needsAssistance**, read the context carefully. It may need a different specialist, more information, or user clarification.
- If a sub-agent **fails or times out**, do not retry the exact same dispatch. Diagnose what went wrong and adjust the task description.
- If the result **partially satisfies** the user's intent, dispatch a follow-up with specific corrections rather than re-doing the entire task.

### Destructive Operations
- For any operation that deletes, replaces, or significantly restructures content, use **propose_changes** first.
- Never allow a sub-agent to make irreversible changes without a changeset.
- For exploration (fan-out), use **explore_options** to generate alternatives before committing.
`,
};
```

- [ ] **Step 2: Register the delegation contract in MasterAgent**

In `apps/agent/src/agents/master-agent.ts`, modify `buildSystemPrompt()`:

```typescript
// Add import at top
import { delegationContractSection } from "../prompt/delegation-contract.js";

// In buildSystemPrompt(), after creating the builder, register the contract:
  buildSystemPrompt(ctx: Readonly<ProjectContext>): string {
    const builder = new PromptBuilder();
    builder.register(delegationContractSection);
    const promptCtx: PromptContext = {
      projectContext: ctx,
      agentIdentity: {
        role: "Master Agent",
        description:
          "You are the Master Agent for OpenCut, an AI-powered video editor. " +
          "You coordinate sub-agents (editor, vision, creator, audio, asset) to fulfill user requests.",
        rules: [
          "Analyze the user's intent before dispatching to sub-agents.",
          "Follow the Sub-Agent Delegation Contract exactly.",
          "For destructive edits, use propose_changes to get user approval first.",
        ],
      },
    };
    return builder.build(promptCtx);
  }
```

- [ ] **Step 3: Run all tests to verify no regressions**

Run: `cd apps/agent && npm test`
Expected: All tests PASS (delegation contract is prompt content, tested indirectly through MasterAgent tests)

- [ ] **Step 4: Commit**

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/prompt/delegation-contract.ts
git add apps/agent/src/agents/master-agent.ts
git commit -m "feat(agent): add delegation contract prompt section for Master Agent

Teaches the model when to dispatch vs handle directly, how to write
task descriptions, parallel vs sequential dispatch rules, result
handling, and destructive operation safeguards. Registered as static
prompt section at priority 15.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Advanced Capabilities

---

### Task 8: VerificationAgent — Adversarial Result Validation

**Why:** No agent currently validates whether an edit or generation result actually matches the user's intent. For high-cost generation, a dedicated verifier that compares before/after catches errors before they get committed.

**Files:**
- Create: `apps/agent/src/agents/verification-agent.ts`
- Create: `apps/agent/src/agents/__tests__/verification-agent.test.ts`
- Modify: `apps/agent/src/tools/master-tools.ts` (add `dispatch_verification` tool)

---

- [ ] **Step 1: Write failing test**

```typescript
// apps/agent/src/agents/__tests__/verification-agent.test.ts

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts: unknown) {}
    },
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VerificationAgent } from "../verification-agent.js";
import type { DispatchInput, DispatchOutput } from "../types.js";

function makeEndTurnResponse(text: string) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe("VerificationAgent", () => {
  let agent: VerificationAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    const toolExecutor = vi.fn(async () => "ok");
    agent = new VerificationAgent({ toolExecutor });
  });

  it("returns a DispatchOutput with PASS/FAIL/PARTIAL verdict", async () => {
    mockCreate.mockResolvedValueOnce(
      makeEndTurnResponse(JSON.stringify({
        verdict: "PASS",
        confidence: "high",
        issues: [],
        summary: "Edit matches user intent. Intro trimmed to 3 seconds.",
      })),
    );

    const input: DispatchInput = {
      task: "Verify: user asked to trim intro to 3s. Editor reports trimmed element-1 from 5s to 3s.",
      accessMode: "read",
      context: {
        userIntent: "Trim the intro to 3 seconds",
        agentResult: "Trimmed element-1 start to 3.0s",
        affectedElements: ["element-1"],
      },
    };

    const result = await agent.dispatch(input);
    expect(result.result).toContain("PASS");
    expect(result.toolCallCount).toBe(0);
  });

  it("includes needsAssistance when verdict is FAIL", async () => {
    mockCreate.mockResolvedValueOnce(
      makeEndTurnResponse(JSON.stringify({
        verdict: "FAIL",
        confidence: "high",
        issues: ["Duration is 4s, not 3s as requested"],
        summary: "Edit does not match user intent.",
      })),
    );

    const input: DispatchInput = {
      task: "Verify: user asked to trim intro to 3s.",
      accessMode: "read",
      context: { userIntent: "Trim the intro to 3 seconds" },
    };

    const result = await agent.dispatch(input);
    expect(result.result).toContain("FAIL");
    expect(result.needsAssistance).toBeDefined();
    expect(result.needsAssistance?.task).toContain("Duration is 4s");
  });

  it("uses claude-haiku for cost efficiency", async () => {
    mockCreate.mockResolvedValueOnce(
      makeEndTurnResponse('{"verdict":"PASS","confidence":"high","issues":[],"summary":"OK"}'),
    );

    await agent.dispatch({
      task: "Verify something",
      accessMode: "read",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/verification-agent.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement VerificationAgent**

```typescript
// apps/agent/src/agents/verification-agent.ts

import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";

interface VerificationResult {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  confidence: "high" | "medium" | "low";
  issues: string[];
  summary: string;
}

export class VerificationAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    runtime.setToolExecutor(this.toolExecutor);

    const config: AgentConfig = {
      agentType: "master", // uses master for permission scope; verification is read-only
      model: "claude-haiku-4-5",
      system: this.buildSystemPrompt(input),
      tools: [],
      tokenBudget: { input: 10_000, output: 2_000 },
      maxIterations: 1,
    };

    const result = await runtime.run(config, input.task);

    // Parse structured verdict
    let verification: VerificationResult;
    try {
      verification = JSON.parse(result.text);
    } catch {
      verification = {
        verdict: "PARTIAL",
        confidence: "low",
        issues: ["Could not parse verification result"],
        summary: result.text,
      };
    }

    const output: DispatchOutput = {
      result: `[${verification.verdict}] ${verification.summary}`,
      toolCallCount: result.toolCalls.length,
      tokensUsed: result.tokensUsed.input + result.tokensUsed.output,
    };

    if (verification.verdict === "FAIL") {
      output.needsAssistance = {
        agentType: "master",
        task: verification.issues.join("; "),
        context: verification,
      };
    }

    return output;
  }

  private buildSystemPrompt(input: DispatchInput): string {
    return [
      "# Verification Agent",
      "",
      "You are an adversarial verifier. Your job is to check whether an edit or generation result matches the user's original intent.",
      "",
      "## Rules",
      "- Compare the reported result against the user's intent.",
      "- Check for: wrong elements affected, incorrect values, missing changes, unintended side effects.",
      "- Be skeptical — assume the edit might be wrong until proven correct.",
      "- Output ONLY a JSON object with this schema:",
      '  { "verdict": "PASS" | "FAIL" | "PARTIAL", "confidence": "high" | "medium" | "low", "issues": string[], "summary": string }',
      "",
      input.context ? `## Context\n${JSON.stringify(input.context, null, 2)}` : "",
    ].join("\n");
  }
}
```

- [ ] **Step 4: Add dispatch_verification to master tools**

In `apps/agent/src/tools/master-tools.ts`, add after the existing tools:

```typescript
// Add to the tool definitions array:
const DispatchVerificationSchema = z.object({
  task: z.string().describe("What to verify — include user intent, agent result, and affected elements"),
  context: z.record(z.unknown()).optional().describe("Verification context: userIntent, agentResult, affectedElements"),
});

// Add to masterToolDefinitions array:
{
  name: "dispatch_verification",
  description: "Dispatch the Verification Agent to check if an edit/generation result matches the user's intent. Use after high-cost operations (generation, replace, batch edit) before committing.",
  inputSchema: DispatchVerificationSchema,
  agentTypes: ["master"],
  accessMode: "read" as const,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/verification-agent.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 6: Run all tests, commit**

Run: `cd apps/agent && npm test`

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/agents/verification-agent.ts
git add apps/agent/src/agents/__tests__/verification-agent.test.ts
git add apps/agent/src/tools/master-tools.ts
git commit -m "feat(agent): add VerificationAgent for adversarial result validation

Lightweight claude-haiku verifier that checks edit/generation results
against user intent. Returns PASS/FAIL/PARTIAL verdict with issues.
FAIL triggers needsAssistance escalation. dispatch_verification added
to master tools.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: SkillRuntime — Frontmatter Affects Runtime Behavior

**Why:** Skills are currently "markdown text injected into prompt". For skills to be real capabilities, their frontmatter must constrain what tools an agent can use, what model to prefer, and when the skill should activate.

**Files:**
- Create: `apps/agent/src/skills/types.ts`
- Create: `apps/agent/src/skills/skill-runtime.ts`
- Create: `apps/agent/src/skills/__tests__/skill-runtime.test.ts`

---

- [ ] **Step 1: Create skill types**

```typescript
// apps/agent/src/skills/types.ts

import type { AgentType } from "../tools/types.js";

export interface SkillFrontmatter {
  /** Which agent types can use this skill. */
  agent_type?: AgentType | AgentType[];
  /** Tool allowlist — if set, only these tools are available during skill execution. */
  allowed_tools?: string[];
  /** Tool denylist — these tools are blocked during skill execution. */
  denied_tools?: string[];
  /** Preferred model override. */
  model?: string;
  /** Effort level hint (controls max iterations / token budget). */
  effort?: "low" | "medium" | "high";
  /** Auto-trigger patterns — skill activates when user intent matches. */
  when_to_use?: string[];
  /** Execution context: inline (in current agent) or forked (separate agent). */
  execution_context?: "inline" | "forked";
  /** Hooks to run during skill execution. */
  hooks?: string[];
}

export interface SkillContract {
  skillId: string;
  name: string;
  frontmatter: SkillFrontmatter;
  content: string;
  /** Resolved tool set based on frontmatter constraints. */
  resolvedTools: string[];
  /** Resolved token budget based on effort level. */
  resolvedTokenBudget: { input: number; output: number };
  /** Resolved model. */
  resolvedModel: string;
}
```

- [ ] **Step 2: Write failing test**

```typescript
// apps/agent/src/skills/__tests__/skill-runtime.test.ts

import { describe, it, expect } from "vitest";
import { SkillRuntime } from "../skill-runtime.js";
import type { SkillFrontmatter } from "../types.js";
import type { ParsedMemory } from "../../memory/types.js";

function makeSkillMemory(overrides: Partial<ParsedMemory & { frontmatter?: SkillFrontmatter }> = {}): ParsedMemory {
  return {
    memory_id: "skill-1",
    type: "pattern",
    status: "active",
    confidence: "high",
    source: "observed",
    created: "2026-01-01",
    updated: "2026-03-01",
    reinforced_count: 5,
    last_reinforced_at: "2026-03-01",
    source_change_ids: [],
    used_in_changeset_ids: [],
    created_session_id: "s1",
    scope: "global",
    scope_level: "global",
    semantic_key: "beat-sync-skill",
    tags: ["skill", "audio", "sync"],
    skill_id: "beat-sync",
    skill_status: "validated",
    agent_type: "editor",
    content: "Cut on beat drops for music videos.",
    ...overrides,
  };
}

describe("SkillRuntime", () => {
  let runtime: SkillRuntime;

  beforeEach(() => {
    runtime = new SkillRuntime({
      availableTools: ["trim_element", "split_element", "add_transition", "generate_video", "search_bgm"],
      defaultModel: "claude-sonnet-4-6",
    });
  });

  describe("resolve()", () => {
    it("creates a SkillContract from a ParsedMemory skill", () => {
      const skill = makeSkillMemory();
      const contract = runtime.resolve(skill);
      expect(contract.skillId).toBe("beat-sync");
      expect(contract.content).toBe("Cut on beat drops for music videos.");
    });

    it("filters tools by allowed_tools frontmatter", () => {
      const skill = makeSkillMemory();
      const contract = runtime.resolve(skill, {
        allowed_tools: ["trim_element", "split_element"],
      });
      expect(contract.resolvedTools).toEqual(["trim_element", "split_element"]);
    });

    it("removes tools listed in denied_tools", () => {
      const skill = makeSkillMemory();
      const contract = runtime.resolve(skill, {
        denied_tools: ["generate_video"],
      });
      expect(contract.resolvedTools).not.toContain("generate_video");
      expect(contract.resolvedTools).toContain("trim_element");
    });

    it("resolves token budget from effort level", () => {
      const lowEffort = runtime.resolve(makeSkillMemory(), { effort: "low" });
      const highEffort = runtime.resolve(makeSkillMemory(), { effort: "high" });
      expect(lowEffort.resolvedTokenBudget.output).toBeLessThan(highEffort.resolvedTokenBudget.output);
    });

    it("overrides model when frontmatter specifies one", () => {
      const contract = runtime.resolve(makeSkillMemory(), { model: "claude-haiku-4-5" });
      expect(contract.resolvedModel).toBe("claude-haiku-4-5");
    });

    it("uses default model when frontmatter omits model", () => {
      const contract = runtime.resolve(makeSkillMemory());
      expect(contract.resolvedModel).toBe("claude-sonnet-4-6");
    });
  });

  describe("matchesIntent()", () => {
    it("returns true when intent matches when_to_use patterns", () => {
      const result = runtime.matchesIntent("sync cuts to the beat", {
        when_to_use: ["beat sync", "cut on beat", "music video editing"],
      });
      expect(result).toBe(true);
    });

    it("returns false when no pattern matches", () => {
      const result = runtime.matchesIntent("add a title card", {
        when_to_use: ["beat sync", "cut on beat"],
      });
      expect(result).toBe(false);
    });

    it("returns false when when_to_use is empty", () => {
      const result = runtime.matchesIntent("anything", {});
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/skill-runtime.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement SkillRuntime**

```typescript
// apps/agent/src/skills/skill-runtime.ts

import type { ParsedMemory } from "../memory/types.js";
import type { SkillFrontmatter, SkillContract } from "./types.js";

const EFFORT_BUDGETS: Record<string, { input: number; output: number }> = {
  low: { input: 10_000, output: 2_000 },
  medium: { input: 30_000, output: 4_000 },
  high: { input: 50_000, output: 8_000 },
};

export class SkillRuntime {
  private availableTools: string[];
  private defaultModel: string;

  constructor(opts: { availableTools: string[]; defaultModel: string }) {
    this.availableTools = opts.availableTools;
    this.defaultModel = opts.defaultModel;
  }

  /** Resolve a ParsedMemory skill into a runtime-ready SkillContract. */
  resolve(
    skill: ParsedMemory,
    frontmatter?: SkillFrontmatter,
  ): SkillContract {
    const fm = frontmatter ?? {};

    // Resolve tools
    let tools = [...this.availableTools];
    if (fm.allowed_tools && fm.allowed_tools.length > 0) {
      const allowSet = new Set(fm.allowed_tools);
      tools = tools.filter((t) => allowSet.has(t));
    }
    if (fm.denied_tools && fm.denied_tools.length > 0) {
      const denySet = new Set(fm.denied_tools);
      tools = tools.filter((t) => !denySet.has(t));
    }

    // Resolve budget
    const effort = fm.effort ?? "medium";
    const budget = EFFORT_BUDGETS[effort] ?? EFFORT_BUDGETS.medium;

    // Resolve model
    const model = fm.model ?? this.defaultModel;

    return {
      skillId: skill.skill_id ?? skill.memory_id,
      name: skill.semantic_key,
      frontmatter: fm,
      content: skill.content,
      resolvedTools: tools,
      resolvedTokenBudget: budget,
      resolvedModel: model,
    };
  }

  /** Check if a user intent matches a skill's when_to_use patterns. */
  matchesIntent(intent: string, frontmatter: SkillFrontmatter): boolean {
    if (!frontmatter.when_to_use || frontmatter.when_to_use.length === 0) {
      return false;
    }
    const lower = intent.toLowerCase();
    return frontmatter.when_to_use.some((pattern) =>
      lower.includes(pattern.toLowerCase()),
    );
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/skill-runtime.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 6: Run all tests, commit**

Run: `cd apps/agent && npm test`

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/skills/types.ts
git add apps/agent/src/skills/skill-runtime.ts
git add apps/agent/src/skills/__tests__/skill-runtime.test.ts
git commit -m "feat(agent): add SkillRuntime for frontmatter-driven skill contracts

Skills resolve to SkillContract with tool allowlists/denylists, effort-
based token budgets, model overrides, and intent matching. Transforms
skills from passive prompt text into runtime-constrained capability
packages.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: ExtensionRegistry — Unified Provider/Tool/Brand Registration

**Why:** Provider routing, tool definitions, brand integrations, and skill registration are all separate mechanisms. A unified extension registry provides a single place to discover, register, and manage all extensible capabilities — the foundation for a future plugin system.

**Files:**
- Create: `apps/agent/src/extensions/types.ts`
- Create: `apps/agent/src/extensions/extension-registry.ts`
- Create: `apps/agent/src/extensions/__tests__/extension-registry.test.ts`

---

- [ ] **Step 1: Create extension types**

```typescript
// apps/agent/src/extensions/types.ts

export type ExtensionType =
  | "tool"
  | "provider"
  | "brand"
  | "skill"
  | "hook";

export interface ExtensionManifest {
  /** Unique identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Extension type. */
  type: ExtensionType;
  /** Version string (semver). */
  version: string;
  /** Short description. */
  description: string;
  /** Whether the extension is currently enabled. */
  enabled: boolean;
  /** Configuration specific to this extension type. */
  config?: Record<string, unknown>;
}
```

- [ ] **Step 2: Write failing test**

```typescript
// apps/agent/src/extensions/__tests__/extension-registry.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { ExtensionRegistry } from "../extension-registry.js";
import type { ExtensionManifest } from "../types.js";

function makeExtension(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: "ext-1",
    name: "Test Extension",
    type: "tool",
    version: "1.0.0",
    description: "A test extension",
    enabled: true,
    ...overrides,
  };
}

describe("ExtensionRegistry", () => {
  let registry: ExtensionRegistry;

  beforeEach(() => {
    registry = new ExtensionRegistry();
  });

  describe("register()", () => {
    it("adds an extension to the registry", () => {
      registry.register(makeExtension({ id: "ext-1" }));
      expect(registry.get("ext-1")).toBeDefined();
    });

    it("throws on duplicate ID", () => {
      registry.register(makeExtension({ id: "ext-1" }));
      expect(() => registry.register(makeExtension({ id: "ext-1" }))).toThrow(
        /already registered/i,
      );
    });
  });

  describe("get()", () => {
    it("returns undefined for unknown ID", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("unregister()", () => {
    it("removes an extension", () => {
      registry.register(makeExtension({ id: "ext-1" }));
      registry.unregister("ext-1");
      expect(registry.get("ext-1")).toBeUndefined();
    });
  });

  describe("listByType()", () => {
    it("returns extensions filtered by type", () => {
      registry.register(makeExtension({ id: "e1", type: "tool" }));
      registry.register(makeExtension({ id: "e2", type: "provider" }));
      registry.register(makeExtension({ id: "e3", type: "tool" }));
      expect(registry.listByType("tool")).toHaveLength(2);
      expect(registry.listByType("provider")).toHaveLength(1);
    });

    it("only returns enabled extensions by default", () => {
      registry.register(makeExtension({ id: "e1", type: "tool", enabled: true }));
      registry.register(makeExtension({ id: "e2", type: "tool", enabled: false }));
      expect(registry.listByType("tool")).toHaveLength(1);
    });

    it("returns all extensions when includeDisabled is true", () => {
      registry.register(makeExtension({ id: "e1", type: "tool", enabled: true }));
      registry.register(makeExtension({ id: "e2", type: "tool", enabled: false }));
      expect(registry.listByType("tool", { includeDisabled: true })).toHaveLength(2);
    });
  });

  describe("enable() / disable()", () => {
    it("toggles extension enabled state", () => {
      registry.register(makeExtension({ id: "e1", enabled: true }));
      registry.disable("e1");
      expect(registry.get("e1")!.enabled).toBe(false);
      registry.enable("e1");
      expect(registry.get("e1")!.enabled).toBe(true);
    });
  });

  describe("listAll()", () => {
    it("returns all registered extensions", () => {
      registry.register(makeExtension({ id: "e1" }));
      registry.register(makeExtension({ id: "e2" }));
      expect(registry.listAll()).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/extensions/__tests__/extension-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement ExtensionRegistry**

```typescript
// apps/agent/src/extensions/extension-registry.ts

import type { ExtensionManifest, ExtensionType } from "./types.js";

export class ExtensionRegistry {
  private extensions = new Map<string, ExtensionManifest>();

  register(manifest: ExtensionManifest): void {
    if (this.extensions.has(manifest.id)) {
      throw new Error(`Extension already registered: ${manifest.id}`);
    }
    this.extensions.set(manifest.id, { ...manifest });
  }

  unregister(id: string): void {
    this.extensions.delete(id);
  }

  get(id: string): ExtensionManifest | undefined {
    const ext = this.extensions.get(id);
    return ext ? { ...ext } : undefined;
  }

  enable(id: string): void {
    const ext = this.extensions.get(id);
    if (ext) ext.enabled = true;
  }

  disable(id: string): void {
    const ext = this.extensions.get(id);
    if (ext) ext.enabled = false;
  }

  listByType(
    type: ExtensionType,
    opts?: { includeDisabled?: boolean },
  ): ExtensionManifest[] {
    return Array.from(this.extensions.values())
      .filter((e) => e.type === type)
      .filter((e) => opts?.includeDisabled || e.enabled)
      .map((e) => ({ ...e }));
  }

  listAll(): ExtensionManifest[] {
    return Array.from(this.extensions.values()).map((e) => ({ ...e }));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/extensions/__tests__/extension-registry.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 6: Run all tests, commit**

Run: `cd apps/agent && npm test`

```bash
cd /Users/bitpravda/Documents/OpenCut
git add apps/agent/src/extensions/
git commit -m "feat(agent): add ExtensionRegistry for unified capability registration

Supports tool, provider, brand, skill, and hook extension types.
Enable/disable toggle, type-filtered listing, duplicate prevention.
Foundation for future plugin system and in-process MCP integration.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

### Spec Coverage

| Borrowing Point | Task | Status |
|---|---|---|
| 1. Session runtime (create/resume/fork/save) | Task 2 | Covered |
| 2. Tool pipeline (hooks, idempotency, failure classification, tracing) | Task 3 | Covered |
| 3. Prompt section-based builder | Task 1 | Covered |
| 4. Sub-agent fork/fresh/resume semantics | Task 7 (delegation contract) | Covered at prompt level; runtime dispatch modes deferred to integration |
| 5. Unified task control plane | Task 4 | Covered |
| 6. Memory index + selector + session memory | Task 6 | Covered |
| 7. Skill execution contracts | Task 9 | Covered |
| 8. Event stream as first-class protocol | Task 5 | Covered |
| 9. Extension contract / registry | Task 10 | Covered |
| 10. Unified control plane (status/changeset/session/memory/task) | Tasks 2+4+5 combine | Status route needs wiring (integration step after all tasks) |

### Placeholder Scan

No instances of "TBD", "TODO", "implement later", or "similar to Task N" found.

### Type Consistency

- `PromptContext`, `PromptSection`, `AgentIdentity` — consistent across Task 1 and Task 7
- `AgentSession`, `SessionMessage`, `SessionStatus` — consistent across Task 2
- `ToolHook`, `ToolHookContext`, `PipelineResult` — consistent across Task 3
- `AgentTask`, `TaskStatus`, `TaskType` — consistent across Task 4
- `RuntimeEvent`, `RuntimeEventType` — consistent across Task 5
- `ParsedMemory` references — all import from existing `memory/types.ts`
- `DispatchInput`, `DispatchOutput` — consistent with existing `agents/types.ts`
- `ToolDefinition`, `AgentType` — consistent with existing `tools/types.ts`
- `SkillFrontmatter`, `SkillContract` — consistent across Task 9
- `ExtensionManifest`, `ExtensionType` — consistent across Task 10

All names match between definition and usage sites.
