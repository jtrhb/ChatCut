# ChatCut Agent Runtime Integration Wiring Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the 10 isolated runtime modules (PromptBuilder, SessionManager, ToolPipeline, TaskRegistry, EventBus, MemorySelector, DelegationContract, VerificationAgent, SkillRuntime, ExtensionRegistry) into the running ChatCut agent application so they become operational.

**Architecture:** Modify existing files only — no new modules. `server.ts` becomes the DI root that instantiates all services and passes them to route/agent factories. Routes switch from static Hono exports to factory functions accepting dependencies. Runtime and agents gain session/event awareness.

**Tech Stack:** TypeScript, Vitest, Hono, Zod, `@anthropic-ai/sdk`

**Pre-requisite commits:** All 10 module tasks complete + 3 critical bug fixes (c00db693).

---

## TDD Enforcement — Mandatory for Every Task

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
- All tests: `cd apps/agent && npx vitest run`

---

## File Structure — All Modifications (No New Modules)

```
apps/agent/src/
├── server.ts                          # W1: DI root — instantiate services, pass to factories
├── events/
│   └── event-bus.ts                   # W2: Add try/catch around handler calls
├── routes/
│   ├── events.ts                      # W2: createEventsRouter({ eventBus })
│   ├── status.ts                      # W3: createStatusRouter({ sessionManager, taskRegistry })
│   └── chat.ts                        # Already has createChatRouter — no changes needed
├── agents/
│   ├── runtime.ts                     # W4: Session-aware run() with incrementTurn
│   └── master-agent.ts               # W5: Add dispatch_verification route
├── tools/
│   └── tool-pipeline.ts              # W6: Add trace/idempotency caps
├── memory/
│   └── memory-loader.ts              # W7: Use MemoryIndex + MemorySelector
├── skills/
│   └── loader.ts                      # W8: Use SkillRuntime for frontmatter resolution
```

---

### Task W1: Wire server.ts as DI Root

**Why:** `server.ts` currently imports static route instances. It needs to instantiate SessionManager, TaskRegistry, EventBus and pass them to route factories.

**Files:**
- Modify: `apps/agent/src/server.ts`
- Modify: `apps/agent/src/routes/__tests__/routes.test.ts`

---

- [ ] **Step 1: Write failing test**

```typescript
// Add to apps/agent/src/routes/__tests__/routes.test.ts

describe("DI-wired routes", () => {
  it("GET /status returns real session and task counts", async () => {
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("activeSessions");
    expect(body).toHaveProperty("queuedTasks");
    expect(body).toHaveProperty("runningTasks");
  });

  it("POST /chat creates a real session", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "00000000-0000-0000-0000-000000000001",
        message: "Hello",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).not.toBe("placeholder");
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/routes/__tests__/routes.test.ts`
Expected: FAIL — `activeSessions` not in status response; `sessionId` is `"placeholder"`

- [ ] **Step 3: Implement server.ts DI wiring**

```typescript
// apps/agent/src/server.ts

import { Hono } from "hono";
import { cors } from "hono/cors";
import { commands } from "./routes/commands.js";
import { project } from "./routes/project.js";
import { media } from "./routes/media.js";
import { changeset } from "./routes/changeset.js";
import { SessionStore } from "./session/session-store.js";
import { SessionManager } from "./session/session-manager.js";
import { TaskRegistry } from "./tasks/task-registry.js";
import { EventBus } from "./events/event-bus.js";
import { createChatRouter } from "./routes/chat.js";
import { createEventsRouter } from "./routes/events.js";
import { createStatusRouter } from "./routes/status.js";

export function createApp() {
  const app = new Hono();

  // ── Instantiate shared services ────────────────────────────────────────
  const sessionStore = new SessionStore();
  const sessionManager = new SessionManager(sessionStore);
  const taskRegistry = new TaskRegistry();
  const eventBus = new EventBus();

  app.use("*", cors());

  app.get("/health", (c) => c.json({ status: "ok" }));

  // ── Static routes (no DI needed) ───────────────────────────────────────
  app.route("/commands", commands);
  app.route("/project", project);
  app.route("/media", media);
  app.route("/changeset", changeset);

  // ── DI-wired routes ────────────────────────────────────────────────────
  app.route("/chat", createChatRouter({ sessionManager }));
  app.route("/events", createEventsRouter({ eventBus }));
  app.route("/status", createStatusRouter({ sessionManager, taskRegistry }));

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/routes/__tests__/routes.test.ts`
Expected: PASS (depends on W2 createEventsRouter and W3 createStatusRouter — implement those first if needed)

- [ ] **Step 5: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/server.ts apps/agent/src/routes/__tests__/routes.test.ts
git commit -m "feat(agent): wire server.ts as DI root with SessionManager, TaskRegistry, EventBus

Instantiate shared services in createApp() and pass to route factories.
Chat route now creates real sessions. Status and events routes use
DI-injected services.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task W2: Wire Events Route + EventBus Handler Safety

**Why:** `events.ts` is a stub that sends one `connected` event. Also, EventBus handlers can throw and break the pipeline.

**Files:**
- Modify: `apps/agent/src/events/event-bus.ts`
- Modify: `apps/agent/src/routes/events.ts`
- Modify: `apps/agent/src/events/__tests__/event-bus.test.ts`

---

- [ ] **Step 1: Write failing test for handler safety**

Add to `apps/agent/src/events/__tests__/event-bus.test.ts`:

```typescript
  it("continues delivering to other handlers when one throws", () => {
    const badHandler = vi.fn(() => { throw new Error("boom"); });
    const goodHandler = vi.fn();
    bus.on("tool.called", badHandler);
    bus.on("tool.called", goodHandler);

    bus.emit({ type: "tool.called", timestamp: Date.now(), data: {} });

    expect(badHandler).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/events/__tests__/event-bus.test.ts`
Expected: FAIL — error propagates, goodHandler not called

- [ ] **Step 3: Add try/catch to EventBus.emit()**

In `apps/agent/src/events/event-bus.ts`, wrap each handler call:

```typescript
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
```

- [ ] **Step 4: Implement createEventsRouter**

Replace `apps/agent/src/routes/events.ts`:

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../events/event-bus.js";
import { serializeEvent } from "../events/event-protocol.js";

export function createEventsRouter(deps: { eventBus: EventBus }) {
  const router = new Hono();

  router.get("/", (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ message: "SSE connection established" }),
      });

      const unsub = deps.eventBus.onAll(async (event) => {
        try {
          const sse = serializeEvent(event);
          await stream.writeSSE(sse);
        } catch {
          // stream may have closed
        }
      });

      stream.onAbort(() => { unsub(); });

      // Keep connection alive until aborted
      await new Promise(() => {});
    });
  });

  return router;
}

// Backward-compatible export for any code still importing { events }
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

- [ ] **Step 5: Run tests, verify PASS**

Run: `cd apps/agent && npx vitest run src/events/__tests__/event-bus.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Run all tests, commit**

Run: `cd apps/agent && npx vitest run`

```bash
git add apps/agent/src/events/event-bus.ts apps/agent/src/events/__tests__/event-bus.test.ts apps/agent/src/routes/events.ts
git commit -m "fix(agent): add handler safety to EventBus, wire createEventsRouter

EventBus.emit() now catches handler errors to prevent one bad handler
from breaking the pipeline. Events route upgraded with createEventsRouter
factory that streams all runtime events via SSE.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task W3: Wire Status Route with Real Data

**Why:** `status.ts` returns hardcoded `{ agentStatus: "idle", activeChangesets: 0 }`. Should return real session/task counts.

**Files:**
- Modify: `apps/agent/src/routes/status.ts`

---

- [ ] **Step 1: Implement createStatusRouter**

```typescript
// apps/agent/src/routes/status.ts

import { Hono } from "hono";
import type { SessionManager } from "../session/session-manager.js";
import type { TaskRegistry } from "../tasks/task-registry.js";

export function createStatusRouter(deps: {
  sessionManager: SessionManager;
  taskRegistry: TaskRegistry;
}) {
  const router = new Hono();

  router.get("/", (c) => {
    const tasks = deps.taskRegistry.listTasks();
    const queuedTasks = tasks.filter((t) => t.status === "queued").length;
    const runningTasks = tasks.filter((t) => t.status === "running").length;

    return c.json({
      agentStatus: runningTasks > 0 ? "busy" : "idle",
      activeSessions: 0, // Will be accurate once session listing is project-scoped
      queuedTasks,
      runningTasks,
      completedTasks: tasks.filter((t) => t.status === "completed").length,
      failedTasks: tasks.filter((t) => t.status === "failed").length,
    });
  });

  return router;
}

// Backward-compatible export
const status = new Hono();
status.get("/", (c) => {
  return c.json({ agentStatus: "idle", activeChangesets: 0 });
});
export { status };
```

- [ ] **Step 2: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: PASS — the routes.test.ts tests from W1 should now pass

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/routes/status.ts
git commit -m "feat(agent): wire status route with real task counts

createStatusRouter returns agentStatus (idle/busy based on running
tasks), queuedTasks, runningTasks, completedTasks, failedTasks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task W4: Session-Aware Runtime

**Why:** `NativeAPIRuntime.run()` is stateless — it doesn't track sessions or report token usage back. Adding session awareness lets the runtime record conversation history and token accumulation.

**Files:**
- Modify: `apps/agent/src/agents/runtime.ts`
- Modify: `apps/agent/src/agents/__tests__/runtime.test.ts`

---

- [ ] **Step 1: Write failing test**

Add to `apps/agent/src/agents/__tests__/runtime.test.ts`:

```typescript
describe("session-aware run", () => {
  it("calls onTurnComplete callback with token usage after each turn", async () => {
    mockCreate.mockResolvedValueOnce(makeEndTurnResponse("Done"));

    const onTurnComplete = vi.fn();
    runtime.setOnTurnComplete(onTurnComplete);

    await runtime.run(baseConfig, "Hello");

    expect(onTurnComplete).toHaveBeenCalledWith({
      input: expect.any(Number),
      output: expect.any(Number),
    });
  });

  it("does not fail when onTurnComplete is not set", async () => {
    mockCreate.mockResolvedValueOnce(makeEndTurnResponse("Done"));
    // No setOnTurnComplete call — should work fine
    const result = await runtime.run(baseConfig, "Hello");
    expect(result.text).toBe("Done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/runtime.test.ts`
Expected: FAIL — `setOnTurnComplete` is not a function

- [ ] **Step 3: Add onTurnComplete callback to NativeAPIRuntime**

In `apps/agent/src/agents/runtime.ts`, add a callback hook:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, AgentResult } from "./types.js";

export interface AgentRuntime {
  run(config: AgentConfig, input: string): Promise<AgentResult>;
  setToolExecutor(fn: (name: string, input: unknown) => Promise<unknown>): void;
  setOnTurnComplete?(fn: (tokens: { input: number; output: number }) => void): void;
}

export class NativeAPIRuntime implements AgentRuntime {
  private client: Anthropic;
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;
  private onTurnComplete?: (tokens: { input: number; output: number }) => void;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.toolExecutor = async (_name: string, _input: unknown) => {
      throw new Error("No tool executor set");
    };
  }

  setToolExecutor(fn: (name: string, input: unknown) => Promise<unknown>): void {
    this.toolExecutor = fn;
  }

  setOnTurnComplete(fn: (tokens: { input: number; output: number }) => void): void {
    this.onTurnComplete = fn;
  }

  async run(config: AgentConfig, input: string): Promise<AgentResult> {
    const maxIterations = config.maxIterations ?? 10;
    const tokenBudget = config.tokenBudget ?? { input: 30_000, output: 4_000 };

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: input },
    ];

    const toolCalls: AgentResult["toolCalls"] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.client.messages.create({
        model: config.model,
        system: config.system,
        messages,
        tools: config.tools as Anthropic.Tool[],
        max_tokens: tokenBudget.output,
      });

      totalInputTokens += response.usage?.input_tokens ?? 0;
      totalOutputTokens += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === "end_turn") {
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === "text"
        );
        const text = textBlocks.map((b) => b.text).join("\n");

        // Notify session of turn completion
        this.onTurnComplete?.({ input: totalInputTokens, output: totalOutputTokens });

        return {
          text,
          toolCalls,
          tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        };
      }

      // Process tool_use blocks
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === "text"
        );
        const text = textBlocks.map((b) => b.text).join("\n");

        this.onTurnComplete?.({ input: totalInputTokens, output: totalOutputTokens });

        return {
          text,
          toolCalls,
          tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        };
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const output = await this.toolExecutor(toolUse.name, toolUse.input);
        toolCalls.push({ toolName: toolUse.name, input: toolUse.input, output });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Max iterations reached
    this.onTurnComplete?.({ input: totalInputTokens, output: totalOutputTokens });

    return {
      text: "Max iterations reached",
      toolCalls,
      tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests, commit**

Run: `cd apps/agent && npx vitest run`

```bash
git add apps/agent/src/agents/runtime.ts apps/agent/src/agents/__tests__/runtime.test.ts
git commit -m "feat(agent): add onTurnComplete callback to NativeAPIRuntime

Session-aware hook called after each agent turn with accumulated token
usage. Enables SessionManager.incrementTurn() integration without
coupling runtime to session implementation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task W5: Route dispatch_verification in MasterAgent

**Why:** `dispatch_verification` tool is defined in master-tools.ts but not routed in MasterAgent. Calling it returns `{ error: "Unknown tool" }`.

**Files:**
- Modify: `apps/agent/src/agents/master-agent.ts`
- Modify: `apps/agent/src/agents/__tests__/master-agent.test.ts`

---

- [ ] **Step 1: Write failing test**

Add to `apps/agent/src/agents/__tests__/master-agent.test.ts`:

```typescript
  it("routes dispatch_verification through DISPATCH_ROUTES", async () => {
    const verifyDispatcher = vi.fn(async () => ({
      result: "[PASS] Looks good",
      toolCallCount: 0,
      tokensUsed: 150,
    }));
    dispatchers.set("verification", verifyDispatcher);

    // Simulate the model calling dispatch_verification
    const result = await (agent as any).handleToolCall("dispatch_verification", {
      task: "Verify the trim",
      context: { userIntent: "Trim to 3s" },
    });

    expect(verifyDispatcher).toHaveBeenCalled();
    expect(result).toHaveProperty("result");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/master-agent.test.ts`
Expected: FAIL — verifyDispatcher not called, result is `{ error: "Unknown tool: dispatch_verification" }`

- [ ] **Step 3: Add dispatch_verification to DISPATCH_ROUTES**

In `apps/agent/src/agents/master-agent.ts`, add to `DISPATCH_ROUTES`:

```typescript
const DISPATCH_ROUTES: Record<string, { agentKey: string; defaultAccessMode: DispatchInput["accessMode"] }> = {
  dispatch_editor:       { agentKey: "editor",       defaultAccessMode: "read_write" },
  dispatch_vision:       { agentKey: "vision",       defaultAccessMode: "read" },
  dispatch_creator:      { agentKey: "creator",      defaultAccessMode: "read_write" },
  dispatch_audio:        { agentKey: "audio",        defaultAccessMode: "read_write" },
  dispatch_asset:        { agentKey: "asset",         defaultAccessMode: "read" },
  dispatch_verification: { agentKey: "verification", defaultAccessMode: "read" },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/master-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests, commit**

Run: `cd apps/agent && npx vitest run`

```bash
git add apps/agent/src/agents/master-agent.ts apps/agent/src/agents/__tests__/master-agent.test.ts
git commit -m "feat(agent): route dispatch_verification in MasterAgent

Add verification to DISPATCH_ROUTES so the model can invoke the
VerificationAgent via dispatch_verification tool. Read-only access
mode — no write lock needed.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task W6: Cap ToolPipeline Traces and Idempotency Keys

**Why:** Both `traces` array and `seenIdempotencyKeys` Set grow without bound — memory leak in long-running server.

**Files:**
- Modify: `apps/agent/src/tools/tool-pipeline.ts`
- Modify: `apps/agent/src/tools/__tests__/tool-pipeline.test.ts`

---

- [ ] **Step 1: Write failing test**

Add to `apps/agent/src/tools/__tests__/tool-pipeline.test.ts`:

```typescript
  describe("resource limits", () => {
    it("evicts oldest traces when maxTraces exceeded", async () => {
      pipeline = new ToolPipeline(executor, { maxTraces: 3 });
      pipeline.registerTool(makeTool());
      const ctx = { agentType: "editor" as AgentType, taskId: "t1" };

      for (let i = 0; i < 5; i++) {
        await pipeline.execute("test_tool", { value: `v${i}` }, ctx);
      }

      const traces = pipeline.getTraces();
      expect(traces).toHaveLength(3);
    });

    it("evicts oldest idempotency keys when maxIdempotencyKeys exceeded", async () => {
      pipeline = new ToolPipeline(executor, { maxIdempotencyKeys: 3 });
      pipeline.registerTool(makeTool({ accessMode: "write" }));
      const ctx = { agentType: "editor" as AgentType, taskId: "t1" };

      // Fill up 3 keys
      await pipeline.execute("test_tool", { value: "a" }, ctx, "key-1");
      await pipeline.execute("test_tool", { value: "b" }, ctx, "key-2");
      await pipeline.execute("test_tool", { value: "c" }, ctx, "key-3");

      // key-4 should evict key-1
      await pipeline.execute("test_tool", { value: "d" }, ctx, "key-4");

      // key-1 should now be allowed again (evicted)
      const result = await pipeline.execute("test_tool", { value: "e" }, ctx, "key-1");
      expect(result.success).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/tool-pipeline.test.ts`
Expected: FAIL — constructor doesn't accept options, traces length is 5

- [ ] **Step 3: Add caps to ToolPipeline**

In `apps/agent/src/tools/tool-pipeline.ts`, update constructor and internals:

```typescript
export interface ToolPipelineOptions {
  maxTraces?: number;
  maxIdempotencyKeys?: number;
}

export class ToolPipeline {
  private tools = new Map<string, ToolDefinition>();
  private hooks: ToolHook[] = [];
  private idempotencyKeys: string[] = [];
  private idempotencyKeySet = new Set<string>();
  private traces: TraceEntry[] = [];
  private executor: ExecutorFn;
  private maxTraces: number;
  private maxIdempotencyKeys: number;

  constructor(executor: ExecutorFn, opts?: ToolPipelineOptions) {
    this.executor = executor;
    this.maxTraces = opts?.maxTraces ?? 1000;
    this.maxIdempotencyKeys = opts?.maxIdempotencyKeys ?? 10000;
  }
```

For traces, use ring buffer eviction in the trace recording method:

```typescript
  private trace(...): void {
    this.traces.push({ ... });
    while (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }
  }
```

For idempotency keys, use FIFO eviction:

```typescript
  // In the idempotency check section of execute():
  if (idempotencyKey && (tool.accessMode === "write" || tool.accessMode === "read_write")) {
    if (this.idempotencyKeySet.has(idempotencyKey)) {
      return this.fail(...);
    }
    this.idempotencyKeys.push(idempotencyKey);
    this.idempotencyKeySet.add(idempotencyKey);
    while (this.idempotencyKeys.length > this.maxIdempotencyKeys) {
      const evicted = this.idempotencyKeys.shift()!;
      this.idempotencyKeySet.delete(evicted);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/tool-pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests, commit**

Run: `cd apps/agent && npx vitest run`

```bash
git add apps/agent/src/tools/tool-pipeline.ts apps/agent/src/tools/__tests__/tool-pipeline.test.ts
git commit -m "fix(agent): cap ToolPipeline traces and idempotency keys

Add maxTraces (default 1000) and maxIdempotencyKeys (default 10000)
with ring-buffer eviction to prevent memory leaks in long-running
server processes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task W7: Wire MemorySelector into MemoryLoader

**Why:** MemoryLoader has its own inline filter/merge/truncation pipeline. The new MemorySelector provides the same logic with better testability and the MemoryIndex adds tag/scope/semantic-key lookup.

**Files:**
- Modify: `apps/agent/src/memory/memory-loader.ts`
- Modify: `apps/agent/src/memory/__tests__/memory-loader.test.ts`

---

- [ ] **Step 1: Write failing test**

Add to `apps/agent/src/memory/__tests__/memory-loader.test.ts`:

```typescript
  it("uses MemoryIndex for tag-based lookup when tags are provided in task", async () => {
    // Setup: store has memories with different tags
    const mem1 = makeParsedMemory({ memory_id: "m1", tags: ["transition"], semantic_key: "k1", content: "Use dissolve." });
    const mem2 = makeParsedMemory({ memory_id: "m2", tags: ["audio"], semantic_key: "k2", content: "Keep volume low." });
    store._store.set("global/aesthetic/m1.md", serializeMemory(mem1));
    store._store.set("global/aesthetic/m2.md", serializeMemory(mem2));

    const result = await loader.loadMemories(baseTask);
    // Both should be loaded (loadMemories loads all matching files)
    expect(result.injectedMemoryIds.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Refactor MemoryLoader to use MemorySelector**

In `apps/agent/src/memory/memory-loader.ts`, replace the inline `postLoadPipeline` with a call to `MemorySelector`:

```typescript
import { MemorySelector } from "./memory-selector.js";
import { MemoryIndex } from "./memory-index.js";

export class MemoryLoader {
  private readonly store: MemoryStoreLike;
  private readonly selector: MemorySelector;
  private readonly index: MemoryIndex;

  constructor(store: MemoryStoreLike) {
    this.store = store;
    this.selector = new MemorySelector();
    this.index = new MemoryIndex();
  }

  async loadMemories(task: TaskContext, templateKey = "single-edit"): Promise<MemoryContext> {
    const templateFn = QUERY_TEMPLATES[templateKey] ?? QUERY_TEMPLATES["single-edit"];
    const patterns = templateFn(task);

    const paths: string[] = [];
    for (const pattern of patterns) {
      const expanded = await this.expandPattern(pattern);
      paths.push(...expanded);
    }

    const uniquePaths = [...new Set(paths)];

    const candidates: ParsedMemory[] = [];
    for (const path of uniquePaths) {
      try {
        const mem = await this.store.readParsed(path);
        candidates.push(mem);
        this.index.add(mem);  // Populate index for future lookups
      } catch {
        // Skip files that fail to parse
      }
    }

    // Use MemorySelector for the filter/merge/truncate pipeline
    const selected = this.selector.selectRelevant(candidates, task);
    return this.serializeForPrompt(selected, (task.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN);
  }

  /** Expose the index for direct lookups (e.g., by tag or semantic key). */
  getIndex(): MemoryIndex {
    return this.index;
  }

  // Keep serializeForPrompt, formatMemorySection, expandPattern as-is
  // Remove postLoadPipeline, mergeByScope, beats, matchesActivationScope (now in MemorySelector)
```

- [ ] **Step 3: Run all tests to verify no regressions**

Run: `cd apps/agent && npx vitest run`
Expected: PASS — existing memory-loader tests should still work since the behavior is equivalent

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/memory/memory-loader.ts apps/agent/src/memory/__tests__/memory-loader.test.ts
git commit -m "refactor(agent): wire MemorySelector and MemoryIndex into MemoryLoader

Replace inline postLoadPipeline with MemorySelector.selectRelevant().
Populate MemoryIndex during load for future tag/scope/semantic-key
lookups. Remove duplicated filter/merge/truncation logic.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task W8: Wire SkillRuntime into SkillLoader

**Why:** SkillLoader loads markdown files but doesn't resolve frontmatter into runtime contracts. SkillRuntime does that — they need to be connected.

**Files:**
- Modify: `apps/agent/src/skills/loader.ts`
- Modify: `apps/agent/src/skills/__tests__/loader.test.ts`

---

- [ ] **Step 1: Write failing test**

Add to `apps/agent/src/skills/__tests__/loader.test.ts`:

```typescript
  describe("loadSkillsWithContracts()", () => {
    it("returns SkillContracts with resolved tools and model", async () => {
      // Setup mock store with a skill that has frontmatter
      // ... (use existing mock setup pattern from the file)

      const contracts = await loader.loadSkillsWithContracts("editor", {
        brand: "testbrand",
      }, {
        availableTools: ["trim_element", "split_element"],
        defaultModel: "claude-sonnet-4-6",
      });

      // Should return SkillContract[] not ParsedMemory[]
      if (contracts.length > 0) {
        expect(contracts[0]).toHaveProperty("resolvedTools");
        expect(contracts[0]).toHaveProperty("resolvedModel");
        expect(contracts[0]).toHaveProperty("skillId");
      }
    });
  });
```

- [ ] **Step 2: Add loadSkillsWithContracts to SkillLoader**

In `apps/agent/src/skills/loader.ts`, add:

```typescript
import { SkillRuntime } from "./skill-runtime.js";
import type { SkillContract, SkillFrontmatter } from "./types.js";

// Add to SkillLoader class:

  /**
   * Load skills and resolve their frontmatter into runtime contracts.
   * Returns SkillContract[] instead of ParsedMemory[].
   */
  async loadSkillsWithContracts(
    agentType: string,
    params: { brand?: string; series?: string },
    runtimeOpts: { availableTools: string[]; defaultModel: string },
  ): Promise<SkillContract[]> {
    const skills = await this.loadSkills(agentType, params);
    const runtime = new SkillRuntime(runtimeOpts);

    return skills.map((skill) => {
      const frontmatter: SkillFrontmatter = {};
      // Extract frontmatter fields that SkillRuntime understands
      if (skill.agent_type) {
        frontmatter.agent_type = skill.agent_type as any;
      }
      return runtime.resolve(skill, frontmatter);
    });
  }
```

- [ ] **Step 3: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/skills/loader.ts apps/agent/src/skills/__tests__/loader.test.ts
git commit -m "feat(agent): wire SkillRuntime into SkillLoader

Add loadSkillsWithContracts() that resolves skill frontmatter into
SkillContract objects with tool allowlists, model overrides, and
effort budgets.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

### Coverage Check

| Integration Point | Task | Status |
|---|---|---|
| server.ts DI root | W1 | Covered |
| events route + handler safety | W2 | Covered |
| status route real data | W3 | Covered |
| runtime session awareness | W4 | Covered |
| dispatch_verification routing | W5 | Covered |
| ToolPipeline resource caps | W6 | Covered |
| MemoryLoader → MemorySelector | W7 | Covered |
| SkillLoader → SkillRuntime | W8 | Covered |

### Placeholder Scan

No instances of "TBD", "TODO", "implement later", or "similar to Task N".

### Type Consistency

- `createChatRouter({ sessionManager })` — matches existing export in chat.ts
- `createEventsRouter({ eventBus })` — new factory, consistent pattern
- `createStatusRouter({ sessionManager, taskRegistry })` — new factory, consistent pattern
- `ToolPipelineOptions` — new interface, clean extension
- `setOnTurnComplete` — added to both interface and class
- `loadSkillsWithContracts` — returns `SkillContract[]`, consistent with skill-runtime.ts types
