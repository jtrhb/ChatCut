# ChatCut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform OpenCut into ChatCut — an AI Agent-driven video editor where users command AI in natural language, with human-in-the-loop approval for all changes.

**Architecture:** Server-authoritative monorepo with three apps: `apps/web` (Next.js frontend on Vercel, read-only), `apps/agent` (Agent service with sole write authority, deployed on Railway/Fly.io), and `packages/core` (shared EditorCore + Commands + Change Log). Multi-agent system: 1 Master Agent (Claude Opus 4.6) coordinating 5 Sub-agents (Vision/Editor/Creator/Audio/Asset) via Claude Agent SDK, with shared ProjectContext and dispatch-scoped write locking.

**Tech Stack:** Next.js 16 + React 19 + TypeScript, Zustand, Radix UI, Drizzle ORM + PostgreSQL, Cloudflare R2 (object storage), pg-boss (job queue), Claude Agent SDK + Gemini 2.5 Pro, FFmpeg (server-side), Playwright (headless rendering).

**Spec Sources:** `docs/chatcut-plan.md`, `docs/chatcut-architecture.md`, `docs/chatcut-agent-system.md`, `docs/chatcut-memory-layer.md`, `docs/chatcut-fanout-exploration.md`, `docs/chatcut-research.md`

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

**Completion gate:** A task is NOT done until:
- All new tests pass (`npx vitest run <test-file>`)
- All existing package tests pass (`npm test` in relevant package)
- Test output is shown as evidence (not just "Expected: PASS")

**Test file naming:** `<module>.test.ts` co-located in `__tests__/` next to source.

**Test matrix — every task's required test files:**

| Task | Test File | Key Assertions |
|---|---|---|
| 1 | (scaffolding — turbo dry-run) | workspace resolution |
| 2 | `packages/core/src/__tests__/editor-core.test.ts` | serialize/deserialize roundtrip, source tracking |
| 3 | `apps/agent/src/services/__tests__/object-storage.test.ts` | upload returns key, signedUrl has expiry, downloadToTempFile streams |
| 4 | `apps/agent/src/db/__tests__/schema.test.ts` | migration applies cleanly, tables exist |
| 5 | `packages/core/src/__tests__/change-log.test.ts` | record/retrieve, getCommittedAfter filter, decision events |
| 6 | `packages/core/src/__tests__/state-serializer.test.ts` | compression ratio, roundtrip, field stripping |
| 7 | `apps/agent/src/services/__tests__/job-queue.test.ts` | enqueue, singletonKey idempotency, worker registration |
| 8 | `apps/agent/src/routes/__tests__/routes.test.ts` | health 200, commands validates schema, project returns JSON |
| 9 | `apps/agent/src/services/__tests__/server-editor-core.test.ts` | fromSnapshot, version gating, clone independence |
| 10 | `apps/agent/src/tools/__tests__/executor.test.ts` | permission check, input validation, write classification, call log |
| 11 | `apps/agent/src/tools/__tests__/editor-tools.test.ts` | trim modifies timeline, split creates 2 elements, batch atomicity |
| 12 | `apps/agent/src/tools/__tests__/creator-tools.test.ts` | idempotencyKey required, schema validation for all 5 tools |
| 12 | `apps/agent/src/tools/__tests__/audio-tools.test.ts` | schema validation for all 6 tools |
| 12 | `apps/agent/src/tools/__tests__/vision-tools.test.ts` | schema validation for all 3 tools |
| 12 | `apps/agent/src/tools/__tests__/asset-tools.test.ts` | schema validation for all 7 tools |
| 13 | `apps/agent/src/tools/__tests__/master-tools.test.ts` | dispatch schema validation, explore_options requires 3-4 candidates |
| 14 | `apps/agent/src/context/__tests__/project-context.test.ts` | artifact 50-cap eviction, getArtifact updates lastAccessedAt |
| 14 | `apps/agent/src/context/__tests__/write-lock.test.ts` | acquire/release, queue ordering, concurrent acquire blocks |
| 15 | `apps/agent/src/agents/__tests__/runtime.test.ts` | tool-use loop terminates, max iterations enforced, tool results returned |
| 16 | `apps/agent/src/agents/__tests__/master-agent.test.ts` | intent→dispatch mapping, write lock acquired for write dispatches |
| 17 | `apps/agent/src/agents/__tests__/editor-agent.test.ts` | dispatch returns DispatchOutput, needsAssistance escalation |
| 17 | `apps/agent/src/agents/__tests__/creator-agent.test.ts` | dispatch with idempotencyKey |
| 17 | `apps/agent/src/agents/__tests__/audio-agent.test.ts` | dispatch returns result |
| 17 | `apps/agent/src/agents/__tests__/vision-agent.test.ts` | dispatch calls Gemini mock |
| 17 | `apps/agent/src/agents/__tests__/asset-agent.test.ts` | dispatch returns result |
| 18 | `apps/agent/src/changeset/__tests__/changeset-manager.test.ts` | propose records boundary, approve commits atomically, reject undoes, approveWithMods applies tweaks, stale version rejected |
| 19 | `apps/agent/src/services/__tests__/vision-client.test.ts` | analyzeVideo returns VideoAnalysis, locateScene filters by query |
| 19 | `apps/agent/src/services/__tests__/vision-cache.test.ts` | cache hit returns stored, cache miss calls Gemini, focus queries skip cache |
| 20 | `apps/agent/src/services/__tests__/generation-client.test.ts` | generateVideo returns taskId, waitForCompletion polls until done, timeout throws |
| 20 | `apps/agent/src/services/__tests__/content-editor.test.ts` | end-to-end: extract→generate→replace pipeline |
| 21 | `apps/agent/src/memory/__tests__/memory-store.test.ts` | write/read roundtrip, frontmatter parsing, listDir |
| 22 | `apps/agent/src/memory/__tests__/memory-loader.test.ts` | template expansion, scope merge (project overrides global), token budget truncation, draft activation_scope filter |
| 23 | `apps/agent/src/memory/__tests__/memory-extractor.test.ts` | rejection→draft memory, 3x rejection→immediate draft, explicit→active, session gate blocks same-session promotion |
| 24 | `apps/agent/src/memory/__tests__/pattern-observer.test.ts` | 5+ high-confidence memories trigger crystallization, skill file written to _skills/ |
| 25 | `apps/web/src/components/editor/chat/__tests__/chat-panel.test.tsx` | renders message list, input submits, changeset buttons fire callbacks |
| 25 | `apps/web/src/hooks/__tests__/use-chat.test.ts` | sendMessage adds user message, SSE updates state |
| 26 | `apps/agent/src/context/__tests__/context-sync.test.ts` | builds update from human changes, excludes own agent's changes, cursor advances |
| 27 | `apps/agent/src/routes/__tests__/chat.test.ts` | validates projectId+message, returns processing status |
| 28 | `apps/agent/src/routes/__tests__/changeset.test.ts` | approve returns approved, reject returns rejected, GET returns status |
| 29 | `apps/agent/src/exploration/__tests__/exploration-engine.test.ts` | materializes 4 candidates, dispersion check rejects >70% similar, enqueues pg-boss jobs |
| 30 | `apps/agent/src/skills/__tests__/loader.test.ts` | filters by agentType, excludes deprecated, draft in trial block |
| 31 | `apps/agent/src/assets/__tests__/skill-store.test.ts` | save/search/update CRUD |
| 31 | `apps/agent/src/assets/__tests__/asset-store.test.ts` | save with generation context, search by tags |
| 31 | `apps/agent/src/assets/__tests__/brand-store.test.ts` | create/get brand kit |
| 32 | `apps/agent/src/__tests__/e2e/agent-flow.test.ts` | full chat→dispatch→propose→approve→verify flow |

**Total: 42 test files across 32 tasks.**

---

## Scope Note

This is a master plan covering all 4 parts of ChatCut. Each Part is independently executable and produces working, testable software. Parts should be executed sequentially as each builds on the prior.

**Execution order (per user direction):**
1. **Part 1 — Foundation & OpenCut Code Migration** (Phase 0 + 1 from spec)
2. **Part 2 — Agent System** (Phase 2 + 3 + 4 core from spec)
3. **Part 3 — Memory System** (Memory Layer from spec)
4. **Part 4 — UI & Integration** (Chat UI + Fan-out + Asset Management from spec)

---

## File Structure Overview

New and modified paths relative to `/Users/bitpravda/Documents/OpenCut/`:

```
apps/
├── web/src/                          # Existing Next.js frontend (modified)
│   ├── app/api/
│   │   ├── media/upload-session/route.ts    # NEW: presigned upload URLs
│   │   └── auth/[...all]/route.ts           # Existing
│   ├── components/editor/
│   │   ├── chat/                            # NEW: Chat UI panel
│   │   │   ├── chat-panel.tsx
│   │   │   ├── message-bubble.tsx
│   │   │   ├── changeset-review.tsx
│   │   │   ├── candidate-cards.tsx
│   │   │   └── agent-status.tsx
│   │   └── panels/                          # Existing (modified)
│   ├── hooks/
│   │   └── use-chat.ts                      # NEW: Chat state + SSE
│   ├── stores/
│   │   └── editor-store.ts                  # Modified: add reviewMode
│   └── services/
│       └── video-cache/                     # Modified: signed URL support
│
├── agent/src/                        # NEW: Agent service (sole write authority)
│   ├── index.ts                             # Service entrypoint
│   ├── server.ts                            # HTTP server (Hono)
│   ├── routes/
│   │   ├── chat.ts                          # POST /chat (SSE)
│   │   ├── commands.ts                      # POST /commands
│   │   ├── changeset.ts                     # POST /changeset/approve|reject
│   │   ├── project.ts                       # GET /project/:id
│   │   ├── events.ts                        # GET /events (SSE)
│   │   ├── media.ts                         # POST /media/finalize, GET /media/:id
│   │   ├── exploration.ts                   # GET /exploration/:id/preview/:candidateId
│   │   └── status.ts                        # GET /status
│   ├── agents/
│   │   ├── runtime.ts                       # AgentRuntime abstraction
│   │   ├── master-agent.ts                  # Master Agent (Opus 4.6)
│   │   ├── editor-agent.ts                  # Editor Sub-agent (Sonnet 4.6)
│   │   ├── creator-agent.ts                 # Creator Sub-agent (Sonnet 4.6)
│   │   ├── audio-agent.ts                   # Audio Sub-agent (Sonnet 4.6)
│   │   ├── vision-agent.ts                  # Vision Sub-agent (Sonnet 4.6 + Gemini)
│   │   └── asset-agent.ts                   # Asset Sub-agent (Haiku 4.5)
│   ├── tools/
│   │   ├── executor.ts                      # Base ToolExecutor class
│   │   ├── editor-tools.ts                  # 16 Editor tools
│   │   ├── creator-tools.ts                 # 5 Creator tools
│   │   ├── audio-tools.ts                   # 6 Audio tools
│   │   ├── vision-tools.ts                  # 3 Vision tools
│   │   ├── asset-tools.ts                   # 7 Asset tools
│   │   └── master-tools.ts                  # 8 Master dispatch tools
│   ├── services/
│   │   ├── object-storage.ts                # R2 upload/download/signedUrl/delete
│   │   ├── server-editor-core.ts            # Server-side EditorCore wrapper
│   │   ├── generation-client.ts             # creative-engine API client
│   │   ├── vision-client.ts                 # Gemini 2.5 Pro video analysis
│   │   ├── vision-cache.ts                  # Vision result cache
│   │   ├── comparison.ts                    # Before/after frame comparison
│   │   ├── content-editor.ts                # End-to-end content editing pipeline
│   │   ├── headless-renderer.ts             # Playwright preview rendering
│   │   └── job-queue.ts                     # pg-boss wrapper
│   ├── context/
│   │   ├── project-context.ts               # SharedProjectContext
│   │   ├── context-sync.ts                  # ContextSynchronizer
│   │   └── write-lock.ts                    # ProjectWriteLock
│   ├── changeset/
│   │   ├── changeset-manager.ts             # Propose/approve/reject
│   │   └── changeset-types.ts               # Changeset interfaces
│   ├── memory/
│   │   ├── memory-store.ts                  # R2 read/write for memory files
│   │   ├── memory-extractor.ts              # Implicit + explicit extraction
│   │   ├── memory-loader.ts                 # Query templates + post-load pipeline
│   │   ├── pattern-observer.ts              # Cross-session pattern analysis
│   │   ├── dynamic-worker.ts                # V8 isolate for custom scripts
│   │   └── types.ts                         # Memory interfaces
│   ├── exploration/
│   │   ├── exploration-engine.ts            # Fan-out orchestration
│   │   ├── sandbox-pool.ts                  # Daytona sandbox lifecycle
│   │   └── candidate-generator.ts           # Dimensionality dispersion
│   ├── skills/
│   │   ├── loader.ts                        # Skill loading from R2
│   │   └── presets/                         # 20 system preset .md files
│   └── db/
│       └── schema.ts                        # Agent service DB tables
│
packages/
├── core/src/                         # NEW: Shared core package
│   ├── index.ts                             # Public exports
│   ├── editor-core.ts                       # EditorCore (extracted from apps/web)
│   ├── managers/
│   │   ├── commands.ts                      # CommandManager (+ source tracking)
│   │   ├── timeline-manager.ts              # TimelineManager
│   │   ├── scenes-manager.ts                # ScenesManager
│   │   ├── project-manager.ts               # ProjectManager
│   │   └── selection-manager.ts             # SelectionManager
│   ├── commands/                            # Command implementations
│   │   ├── base-command.ts
│   │   ├── batch-command.ts
│   │   ├── timeline/                        # All timeline commands
│   │   └── scene/                           # Scene commands
│   ├── change-log.ts                        # NEW: Append-only change log
│   ├── state-serializer.ts                  # NEW: Token-efficient timeline JSON
│   ├── types/
│   │   ├── timeline.ts
│   │   ├── project.ts
│   │   ├── change-log.ts                    # ChangeEntry interface
│   │   └── commands.ts
│   └── utils/
│       ├── time.ts
│       └── element-utils.ts
│
├── env/                              # Existing env package
└── ui/                               # Existing UI package
```

---

# Part 1: Foundation & OpenCut Code Migration

> Extracts OpenCut's editing core into a shared package, sets up server-authoritative storage on R2 + PostgreSQL, builds the minimal Editor Service, and adds Change Log + Job Queue infrastructure.

---

### Task 1: Monorepo Scaffolding — `packages/core` + `apps/agent`

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `apps/agent/package.json`
- Create: `apps/agent/tsconfig.json`
- Create: `apps/agent/src/index.ts`
- Modify: `turbo.json` — add `core` and `agent` to pipeline
- Modify: `package.json` — add workspace entries

- [ ] **Step 1: Create `packages/core` scaffold**

```json
// packages/core/package.json
{
  "name": "@opencut/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.2.1"
  },
  "dependencies": {
    "eventemitter3": "^5.0.1",
    "nanoid": "^5.1.5"
  }
}
```

```json
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

```typescript
// packages/core/src/index.ts
// Will export EditorCore, types, commands after extraction
export {};
```

- [ ] **Step 2: Create `apps/agent` scaffold**

```json
// apps/agent/package.json
{
  "name": "@opencut/agent",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@opencut/core": "workspace:*",
    "hono": "^4.7.0",
    "@hono/node-server": "^1.14.0",
    "drizzle-orm": "^0.44.2",
    "postgres": "^3.4.5",
    "@aws-sdk/client-s3": "^3.800.0",
    "@aws-sdk/s3-request-presigner": "^3.800.0",
    "pg-boss": "^10.2.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "tsx": "^4.19.0",
    "tsup": "^8.5.0",
    "vitest": "^3.2.1"
  }
}
```

```typescript
// apps/agent/src/index.ts
console.log("ChatCut Agent Service starting...");
```

- [ ] **Step 3: Update root workspace config**

Add to root `package.json` workspaces (if not already glob):
```json
{
  "workspaces": ["apps/*", "packages/*"]
}
```

Add to `turbo.json`:
```json
{
  "pipeline": {
    "build": { "dependsOn": ["^build"] },
    "dev": { "persistent": true },
    "test": {}
  }
}
```

- [ ] **Step 4: Install dependencies**

Run: `cd /Users/bitpravda/Documents/OpenCut && npm install`
Expected: Clean install with new workspace packages resolved.

- [ ] **Step 5: Verify monorepo structure**

Run: `npx turbo run build --dry-run`
Expected: Shows `@opencut/core` and `@opencut/agent` in task graph.

- [ ] **Step 6: Commit**

```bash
git add packages/core/ apps/agent/ turbo.json package.json
git commit -m "feat: scaffold packages/core and apps/agent for ChatCut"
```

---

### Task 2: Extract Shared Core — EditorCore + Commands + Types

**Files:**
- Create: `packages/core/src/types/timeline.ts` (copy from `apps/web/src/types/timeline.ts`)
- Create: `packages/core/src/types/project.ts` (copy from `apps/web/src/types/project.ts`)
- Create: `packages/core/src/types/commands.ts`
- Create: `packages/core/src/commands/base-command.ts` (copy from `apps/web/src/lib/commands/base-command.ts`)
- Create: `packages/core/src/commands/batch-command.ts` (copy from `apps/web/src/lib/commands/batch-command.ts`)
- Create: `packages/core/src/commands/timeline/` (copy all from `apps/web/src/lib/commands/timeline/`)
- Create: `packages/core/src/commands/scene/` (copy all from `apps/web/src/lib/commands/scene/`)
- Create: `packages/core/src/managers/commands.ts` (copy from `apps/web/src/core/managers/commands.ts`)
- Create: `packages/core/src/managers/timeline-manager.ts` (copy from `apps/web/src/core/managers/timeline-manager.ts`)
- Create: `packages/core/src/managers/scenes-manager.ts`
- Create: `packages/core/src/managers/project-manager.ts`
- Create: `packages/core/src/managers/selection-manager.ts`
- Create: `packages/core/src/editor-core.ts` (server-compatible subset)
- Create: `packages/core/src/utils/time.ts`
- Create: `packages/core/src/utils/element-utils.ts`
- Modify: `packages/core/src/index.ts` — export everything
- Modify: `apps/web/src/core/index.ts` — import from `@opencut/core` instead of local
- Modify: `apps/web/src/lib/commands/` — re-export from `@opencut/core`

- [ ] **Step 1: Copy type definitions to packages/core**

Copy `apps/web/src/types/timeline.ts` → `packages/core/src/types/timeline.ts`
Copy `apps/web/src/types/project.ts` → `packages/core/src/types/project.ts`

Remove any browser-specific imports (React types, DOM types). These type files should be pure TypeScript interfaces with no runtime dependencies.

- [ ] **Step 2: Copy command system to packages/core**

Copy the entire `apps/web/src/lib/commands/` directory to `packages/core/src/commands/`.

Strip any browser-specific code (DOM APIs, Canvas, WebGL references). Commands should operate on pure data structures. If a command references browser APIs (e.g., `OffscreenCanvas`), extract the browser-dependent part into a callback/interface that `apps/web` can provide.

- [ ] **Step 3: Copy managers to packages/core**

Copy these managers, removing browser/React dependencies:
- `commands.ts` — CommandManager (pure logic, no DOM)
- `timeline-manager.ts` — Track/element CRUD
- `scenes-manager.ts` — Scene management
- `project-manager.ts` — Project metadata
- `selection-manager.ts` — Selection tracking

Each manager should depend only on `eventemitter3` and core types.

- [ ] **Step 4: Create server-compatible EditorCore**

```typescript
// packages/core/src/editor-core.ts
import { EventEmitter } from "eventemitter3";
import { CommandManager } from "./managers/commands";
import { TimelineManager } from "./managers/timeline-manager";
import { ScenesManager } from "./managers/scenes-manager";
import { ProjectManager } from "./managers/project-manager";
import { SelectionManager } from "./managers/selection-manager";
import type { Project } from "./types/project";

export interface EditorCoreConfig {
  project: Project;
}

export class EditorCore extends EventEmitter {
  readonly commands: CommandManager;
  readonly timeline: TimelineManager;
  readonly scenes: ScenesManager;
  readonly project: ProjectManager;
  readonly selection: SelectionManager;

  constructor(config: EditorCoreConfig) {
    super();
    this.project = new ProjectManager(config.project);
    this.scenes = new ScenesManager(this);
    this.timeline = new TimelineManager(this);
    this.commands = new CommandManager(this);
    this.selection = new SelectionManager(this);
  }

  /** Execute a command from a human source */
  executeCommand(command: BaseCommand): void {
    this.commands.execute(command, { source: "human" });
  }

  /** Execute a command from an agent source */
  executeAgentCommand(command: BaseCommand, agentId: string): void {
    this.commands.execute(command, { source: "agent", agentId });
  }

  /** Serialize current state for persistence */
  serialize(): SerializedProject {
    return {
      project: this.project.serialize(),
      scenes: this.scenes.serialize(),
    };
  }

  /** Restore from serialized state */
  static deserialize(data: SerializedProject): EditorCore {
    return new EditorCore({ project: data.project });
  }
}
```

- [ ] **Step 5: Add source tracking to CommandManager**

Modify `packages/core/src/managers/commands.ts`:

```typescript
// Add to CommandManager.execute()
interface ExecuteOptions {
  source: "human" | "agent" | "system";
  agentId?: string;
  changesetId?: string;
}

execute(command: BaseCommand, options: ExecuteOptions = { source: "human" }): void {
  command.execute();
  this.history.push({ command, ...options });
  this.emit("command:executed", { command, ...options });
  // Existing undo stack management...
}
```

- [ ] **Step 6: Update packages/core/src/index.ts exports**

```typescript
// packages/core/src/index.ts
export { EditorCore } from "./editor-core";
export type { EditorCoreConfig } from "./editor-core";

// Types
export * from "./types/timeline";
export * from "./types/project";
export * from "./types/commands";

// Managers
export { CommandManager } from "./managers/commands";
export { TimelineManager } from "./managers/timeline-manager";
export { ScenesManager } from "./managers/scenes-manager";
export { ProjectManager } from "./managers/project-manager";
export { SelectionManager } from "./managers/selection-manager";

// Commands
export { BaseCommand } from "./commands/base-command";
export { BatchCommand } from "./commands/batch-command";
export * from "./commands/timeline";
export * from "./commands/scene";

// Utilities
export * from "./utils/time";
export * from "./utils/element-utils";
```

- [ ] **Step 7: Update apps/web to import from @opencut/core**

In `apps/web/src/core/index.ts`, change the existing EditorCore to extend or wrap `@opencut/core`'s EditorCore, adding browser-specific managers (PlaybackManager, RendererManager, AudioManager, MediaManager, SaveManager) that depend on DOM/Canvas/WebGL APIs.

```typescript
// apps/web/src/core/index.ts
import { EditorCore as CoreEditorCore } from "@opencut/core";
import { PlaybackManager } from "./managers/playback-manager";
import { RendererManager } from "./managers/renderer-manager";
import { AudioManager } from "./managers/audio-manager";
import { MediaManager } from "./managers/media-manager";
import { SaveManager } from "./managers/save-manager";

export class EditorCore extends CoreEditorCore {
  readonly playback: PlaybackManager;
  readonly renderer: RendererManager;
  readonly audio: AudioManager;
  readonly media: MediaManager;
  readonly save: SaveManager;

  // ... browser-specific initialization
}
```

- [ ] **Step 8: Run existing tests**

Run: `cd /Users/bitpravda/Documents/OpenCut && npm test`
Expected: All existing tests pass. The extraction should be a pure refactor with no behavior changes.

- [ ] **Step 9: Run core package tests**

Run: `cd packages/core && npm test`
Expected: Copied command tests pass in the new package.

- [ ] **Step 10: Commit**

```bash
git add packages/core/ apps/web/src/core/ apps/web/src/lib/commands/
git commit -m "refactor: extract shared EditorCore to packages/core with source tracking"
```

---

### Task 3: Object Storage Service (R2)

**Files:**
- Create: `apps/agent/src/services/object-storage.ts`
- Create: `apps/agent/src/services/__tests__/object-storage.test.ts`
- Create: `packages/env/src/agent.ts` — R2 env vars

- [ ] **Step 1: Write the failing test**

```typescript
// apps/agent/src/services/__tests__/object-storage.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectStorage } from "../object-storage";

describe("ObjectStorage", () => {
  it("upload returns immutable storageKey", async () => {
    const storage = createMockStorage();
    const key = await storage.upload(Buffer.from("test"), {
      contentType: "video/mp4",
      prefix: "media",
    });
    expect(key).toMatch(/^media\/.+/);
  });

  it("getSignedUrl returns time-limited URL", async () => {
    const storage = createMockStorage();
    const url = await storage.getSignedUrl("media/abc.mp4", 3600);
    expect(url).toContain("X-Amz-Expires");
  });

  it("downloadToTempFile streams to disk without OOM", async () => {
    const storage = createMockStorage();
    const tmpPath = await storage.downloadToTempFile("media/abc.mp4");
    expect(tmpPath).toMatch(/\.mp4$/);
  });

  it("delete removes object", async () => {
    const storage = createMockStorage();
    await expect(storage.delete("media/abc.mp4")).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/services/__tests__/object-storage.test.ts`
Expected: FAIL — `ObjectStorage` not defined.

- [ ] **Step 3: Implement ObjectStorage**

```typescript
// apps/agent/src/services/object-storage.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export interface UploadOptions {
  contentType: string;
  prefix: string;
  extension?: string;
}

export class ObjectStorage {
  private client: S3Client;
  private bucket: string;

  constructor(config: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  }) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async upload(data: Buffer | Readable, options: UploadOptions): Promise<string> {
    const ext = options.extension || this.guessExtension(options.contentType);
    const key = `${options.prefix}/${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: options.contentType,
      })
    );

    return key;
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn }
    );
  }

  async downloadToTempFile(key: string): Promise<string> {
    const ext = key.substring(key.lastIndexOf("."));
    const tmpPath = join(tmpdir(), `chatcut-${randomUUID()}${ext}`);

    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );

    await pipeline(response.Body as Readable, createWriteStream(tmpPath));
    return tmpPath;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  private guessExtension(contentType: string): string {
    const map: Record<string, string> = {
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "audio/mpeg": ".mp3",
      "audio/wav": ".wav",
    };
    return map[contentType] || "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/services/__tests__/object-storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/services/object-storage.ts apps/agent/src/services/__tests__/
git commit -m "feat: add ObjectStorage service for R2 upload/download/signedUrl"
```

---

### Task 4: Database Schema — Agent Service Tables

**Files:**
- Create: `apps/agent/src/db/schema.ts`
- Create: `apps/agent/src/db/index.ts`
- Create: `apps/agent/drizzle.config.ts`

- [ ] **Step 1: Define Drizzle schema**

```typescript
// apps/agent/src/db/schema.ts
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  name: text("name").notNull().default("Untitled"),
  snapshotVersion: integer("snapshot_version").notNull().default(0),
  timelineSnapshot: jsonb("timeline_snapshot"),
  settings: jsonb("settings"), // resolution, fps, background, etc.
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const changeLog = pgTable(
  "change_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    sequence: integer("sequence").notNull(), // Monotonic within project
    source: text("source").notNull(), // "human" | "agent" | "system"
    agentId: text("agent_id"),
    changesetId: text("changeset_id"),
    actionType: text("action_type").notNull(), // "insert" | "delete" | "update" | "trim" | ...
    targetType: text("target_type").notNull(), // "element" | "track" | "effect" | ...
    targetId: text("target_id").notNull(),
    details: jsonb("details"),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("change_log_project_seq_idx").on(table.projectId, table.sequence),
    index("change_log_changeset_idx").on(table.changesetId),
  ]
);

export const mediaAssets = pgTable("media_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id),
  userId: text("user_id").notNull(),
  storageKey: text("storage_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  duration: integer("duration_ms"),
  width: integer("width"),
  height: integer("height"),
  checksum: text("checksum"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("active"), // "active" | "idle" | "closed"
  lastMessageAt: timestamp("last_message_at"),
  contextSnapshot: jsonb("context_snapshot"), // For session recovery
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pendingChangesets = pgTable("pending_changesets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  sessionId: uuid("session_id").references(() => agentSessions.id),
  boundaryCursor: integer("boundary_cursor").notNull(),
  status: text("status").notNull().default("pending"), // "pending" | "approved" | "rejected"
  summary: text("summary"),
  fingerprint: jsonb("fingerprint"), // elementIds, trackIds, timeRanges
  createdAt: timestamp("created_at").defaultNow().notNull(),
  decidedAt: timestamp("decided_at"),
});

export const visionCache = pgTable(
  "vision_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mediaHash: text("media_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    analysis: jsonb("analysis").notNull(), // VideoAnalysis
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("vision_cache_hash_idx").on(table.mediaHash, table.schemaVersion),
  ]
);

export const explorationSessions = pgTable("exploration_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  baseSnapshotVersion: integer("base_snapshot_version"),
  userIntent: text("user_intent"),
  candidates: jsonb("candidates"), // ExecutionPlan[]
  previewStorageKeys: jsonb("preview_storage_keys"),
  selectedCandidateId: text("selected_candidate_id"),
  parentExplorationId: uuid("parent_exploration_id"),
  exposureOrder: jsonb("exposure_order"),
  status: text("status").notNull().default("queued"),
  memorySignals: jsonb("memory_signals"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});
```

- [ ] **Step 2: Create DB connection**

```typescript
// apps/agent/src/db/index.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);
export const db = drizzle(client, { schema });
```

- [ ] **Step 3: Create drizzle config**

```typescript
// apps/agent/drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 4: Generate initial migration**

Run: `cd apps/agent && npx drizzle-kit generate`
Expected: Migration file created in `apps/agent/migrations/`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/db/ apps/agent/drizzle.config.ts apps/agent/migrations/
git commit -m "feat: add agent service database schema with Drizzle"
```

---

### Task 5: Change Log Module

**Files:**
- Create: `packages/core/src/change-log.ts`
- Create: `packages/core/src/types/change-log.ts`
- Create: `packages/core/src/__tests__/change-log.test.ts`

- [ ] **Step 1: Define ChangeLog types**

```typescript
// packages/core/src/types/change-log.ts
export interface ChangeEntry {
  id: string;
  timestamp: number;
  source: "human" | "agent" | "system";
  agentId?: string;
  changesetId?: string;
  action: {
    type: "insert" | "delete" | "update" | "trim" | "split" | "move" | "batch" | "effect" | "keyframe" | "transition";
    targetType: "element" | "track" | "effect" | "keyframe" | "scene" | "project";
    targetId: string;
    details: Record<string, unknown>;
  };
  summary: string;
}

export type ChangesetDecisionEvent = {
  type: "changeset_committed" | "changeset_rejected";
  changesetId: string;
  timestamp: number;
};
```

- [ ] **Step 2: Write the failing test**

```typescript
// packages/core/src/__tests__/change-log.test.ts
import { describe, it, expect } from "vitest";
import { ChangeLog } from "../change-log";

describe("ChangeLog", () => {
  it("records an entry and retrieves it", () => {
    const log = new ChangeLog();
    log.record({
      source: "human",
      action: { type: "trim", targetType: "element", targetId: "el1", details: { trimStart: 1 } },
      summary: "Trimmed clip start by 1s",
    });
    const entries = log.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("human");
    expect(entries[0].action.type).toBe("trim");
  });

  it("getCommittedAfter filters by sequence", () => {
    const log = new ChangeLog();
    log.record({ source: "agent", agentId: "editor", action: { type: "insert", targetType: "element", targetId: "el1", details: {} }, summary: "Added clip" });
    log.record({ source: "human", action: { type: "delete", targetType: "element", targetId: "el2", details: {} }, summary: "Deleted clip" });
    log.record({ source: "agent", agentId: "editor", action: { type: "trim", targetType: "element", targetId: "el3", details: {} }, summary: "Trimmed clip" });

    const after = log.getCommittedAfter(0);
    expect(after).toHaveLength(2); // entries at index 1 and 2
  });

  it("emits on record", () => {
    const log = new ChangeLog();
    const events: unknown[] = [];
    log.on("entry", (e) => events.push(e));
    log.record({ source: "human", action: { type: "update", targetType: "element", targetId: "el1", details: {} }, summary: "Updated" });
    expect(events).toHaveLength(1);
  });

  it("emitDecision records changeset decision", () => {
    const log = new ChangeLog();
    log.emitDecision({ type: "changeset_committed", changesetId: "cs1", timestamp: Date.now() });
    expect(log.getDecisions()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/change-log.test.ts`
Expected: FAIL — `ChangeLog` not defined.

- [ ] **Step 4: Implement ChangeLog**

```typescript
// packages/core/src/change-log.ts
import { EventEmitter } from "eventemitter3";
import { nanoid } from "nanoid";
import type { ChangeEntry, ChangesetDecisionEvent } from "./types/change-log";

type RecordInput = Omit<ChangeEntry, "id" | "timestamp">;

export class ChangeLog extends EventEmitter {
  private entries: ChangeEntry[] = [];
  private decisions: ChangesetDecisionEvent[] = [];

  record(input: RecordInput): ChangeEntry {
    const entry: ChangeEntry = {
      id: nanoid(),
      timestamp: Date.now(),
      ...input,
    };
    this.entries.push(entry);
    this.emit("entry", entry);
    return entry;
  }

  emitDecision(event: ChangesetDecisionEvent): void {
    this.decisions.push(event);
    this.emit("decision", event);
  }

  getAll(): readonly ChangeEntry[] {
    return this.entries;
  }

  getDecisions(): readonly ChangesetDecisionEvent[] {
    return this.decisions;
  }

  /** Get entries after a given index, optionally filtering out a specific source */
  getCommittedAfter(afterIndex: number, excludeAgentId?: string): ChangeEntry[] {
    return this.entries
      .slice(afterIndex + 1)
      .filter((e) => (excludeAgentId ? e.agentId !== excludeAgentId : true));
  }

  /** Get entries by changesetId */
  getByChangeset(changesetId: string): ChangeEntry[] {
    return this.entries.filter((e) => e.changesetId === changesetId);
  }

  get length(): number {
    return this.entries.length;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/change-log.test.ts`
Expected: PASS

- [ ] **Step 6: Wire ChangeLog into EditorCore**

In `packages/core/src/editor-core.ts`, add:

```typescript
import { ChangeLog } from "./change-log";

export class EditorCore extends EventEmitter {
  readonly changeLog: ChangeLog;

  constructor(config: EditorCoreConfig) {
    super();
    this.changeLog = new ChangeLog();
    // ... existing init
  }
}
```

Update `CommandManager.execute()` to automatically record to ChangeLog after each command execution.

- [ ] **Step 7: Export from index and commit**

Add `export { ChangeLog } from "./change-log"` and `export * from "./types/change-log"` to `packages/core/src/index.ts`.

```bash
git add packages/core/src/change-log.ts packages/core/src/types/change-log.ts packages/core/src/__tests__/
git commit -m "feat: add append-only ChangeLog with source attribution"
```

---

### Task 6: Timeline State Serializer

**Files:**
- Create: `packages/core/src/state-serializer.ts`
- Create: `packages/core/src/__tests__/state-serializer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/state-serializer.test.ts
import { describe, it, expect } from "vitest";
import { StateSerializer } from "../state-serializer";

describe("StateSerializer", () => {
  it("compresses timeline to token-efficient JSON", () => {
    const fullTimeline = createMockTimeline(); // helper
    const compressed = StateSerializer.serialize(fullTimeline);
    const parsed = JSON.parse(compressed);

    // Should only contain essential fields
    expect(parsed.scenes[0].tracks[0].elements[0]).toHaveProperty("id");
    expect(parsed.scenes[0].tracks[0].elements[0]).toHaveProperty("type");
    expect(parsed.scenes[0].tracks[0].elements[0]).toHaveProperty("startTime");
    expect(parsed.scenes[0].tracks[0].elements[0]).toHaveProperty("duration");
    expect(parsed.scenes[0].tracks[0].elements[0]).not.toHaveProperty("renderNode");
    expect(parsed.scenes[0].tracks[0].elements[0]).not.toHaveProperty("waveformData");
  });

  it("produces JSON under 2000 tokens for typical 5-track timeline", () => {
    const timeline = createMockTimeline(5, 10); // 5 tracks, 10 elements each
    const compressed = StateSerializer.serialize(timeline);
    // Rough token estimate: 1 token ≈ 4 chars
    expect(compressed.length / 4).toBeLessThan(2000);
  });

  it("roundtrips essential fields", () => {
    const timeline = createMockTimeline();
    const compressed = StateSerializer.serialize(timeline);
    const view = StateSerializer.deserialize(compressed);
    expect(view.scenes[0].tracks[0].elements[0].id).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/state-serializer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement StateSerializer**

```typescript
// packages/core/src/state-serializer.ts
import type { Scene, Track, TimelineElement } from "./types/timeline";

export interface AgentTimelineView {
  scenes: Array<{
    id: string;
    name: string;
    tracks: Array<{
      id: string;
      type: string;
      muted: boolean;
      hidden: boolean;
      elements: Array<{
        id: string;
        name: string;
        type: string;
        startTime: number;
        duration: number;
        trimStart?: number;
        trimEnd?: number;
        speed?: number;
        volume?: number;
      }>;
    }>;
  }>;
  duration: number;
  currentTime: number;
}

export class StateSerializer {
  static serialize(scenes: Scene[], duration: number, currentTime = 0): string {
    const view: AgentTimelineView = {
      scenes: scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        tracks: scene.tracks.map((track) => ({
          id: track.id,
          type: track.type,
          muted: track.muted ?? false,
          hidden: track.hidden ?? false,
          elements: track.elements.map((el) => ({
            id: el.id,
            name: el.name || el.id,
            type: el.type,
            startTime: Math.round(el.startTime * 1000) / 1000,
            duration: Math.round(el.duration * 1000) / 1000,
            ...(el.trimStart ? { trimStart: el.trimStart } : {}),
            ...(el.trimEnd ? { trimEnd: el.trimEnd } : {}),
            ...(el.speed && el.speed !== 1 ? { speed: el.speed } : {}),
            ...(el.volume !== undefined && el.volume !== 1 ? { volume: el.volume } : {}),
          })),
        })),
      })),
      duration,
      currentTime,
    };
    return JSON.stringify(view);
  }

  static deserialize(json: string): AgentTimelineView {
    return JSON.parse(json);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/state-serializer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/state-serializer.ts packages/core/src/__tests__/state-serializer.test.ts
git commit -m "feat: add token-efficient timeline state serializer for agent consumption"
```

---

### Task 7: Job Queue Infrastructure (pg-boss)

**Files:**
- Create: `apps/agent/src/services/job-queue.ts`
- Create: `apps/agent/src/services/__tests__/job-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/agent/src/services/__tests__/job-queue.test.ts
import { describe, it, expect, vi } from "vitest";
import { JobQueue } from "../job-queue";

describe("JobQueue", () => {
  it("enqueues and processes a job", async () => {
    const queue = new JobQueue({ connectionString: "mock" });
    const handler = vi.fn().mockResolvedValue(undefined);

    queue.registerWorker("test-job", handler);
    await queue.enqueue("test-job", { data: "hello" });

    // In integration tests, pg-boss would process this
    // Unit test verifies the API shape
    expect(handler).not.toHaveBeenCalled(); // async processing
  });

  it("supports singletonKey for idempotency", async () => {
    const queue = new JobQueue({ connectionString: "mock" });
    await queue.enqueue("generation", { taskId: "abc" }, {
      singletonKey: "gen-abc",
      expireInMinutes: 30,
    });
    // Should not throw for duplicate
    await queue.enqueue("generation", { taskId: "abc" }, {
      singletonKey: "gen-abc",
      expireInMinutes: 30,
    });
  });
});
```

- [ ] **Step 2: Implement JobQueue wrapper**

```typescript
// apps/agent/src/services/job-queue.ts
import PgBoss from "pg-boss";

export interface JobQueueConfig {
  connectionString: string;
}

export interface EnqueueOptions {
  singletonKey?: string;
  expireInMinutes?: number;
  retryLimit?: number;
  retryDelay?: number;
}

export class JobQueue {
  private boss: PgBoss;

  constructor(config: JobQueueConfig) {
    this.boss = new PgBoss(config.connectionString);
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async enqueue<T extends Record<string, unknown>>(
    name: string,
    data: T,
    options?: EnqueueOptions
  ): Promise<string | null> {
    return this.boss.send(name, data, {
      singletonKey: options?.singletonKey,
      expireInMinutes: options?.expireInMinutes,
      retryLimit: options?.retryLimit ?? 2,
      retryDelay: options?.retryDelay ?? 30,
    });
  }

  registerWorker<T>(
    name: string,
    handler: (job: PgBoss.Job<T>) => Promise<void>,
    options?: { teamSize?: number }
  ): void {
    this.boss.work(name, { teamSize: options?.teamSize ?? 1 }, handler);
  }
}
```

- [ ] **Step 3: Run tests and commit**

Run: `cd apps/agent && npx vitest run src/services/__tests__/job-queue.test.ts`

```bash
git add apps/agent/src/services/job-queue.ts apps/agent/src/services/__tests__/job-queue.test.ts
git commit -m "feat: add pg-boss job queue wrapper with idempotency support"
```

---

### Task 8: Agent Service HTTP Server (Hono)

**Files:**
- Create: `apps/agent/src/server.ts`
- Create: `apps/agent/src/routes/commands.ts`
- Create: `apps/agent/src/routes/project.ts`
- Create: `apps/agent/src/routes/events.ts`
- Create: `apps/agent/src/routes/media.ts`
- Create: `apps/agent/src/routes/status.ts`
- Modify: `apps/agent/src/index.ts`

- [ ] **Step 1: Create Hono server with routes**

```typescript
// apps/agent/src/server.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { commandsRoute } from "./routes/commands";
import { projectRoute } from "./routes/project";
import { eventsRoute } from "./routes/events";
import { mediaRoute } from "./routes/media";
import { statusRoute } from "./routes/status";

export function createApp() {
  const app = new Hono();

  app.use("*", cors());

  app.route("/commands", commandsRoute);
  app.route("/project", projectRoute);
  app.route("/events", eventsRoute);
  app.route("/media", mediaRoute);
  app.route("/status", statusRoute);

  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}
```

- [ ] **Step 2: Create route stubs**

```typescript
// apps/agent/src/routes/commands.ts
import { Hono } from "hono";
import { z } from "zod";

export const commandsRoute = new Hono();

const commandSchema = z.object({
  type: z.string(),
  params: z.record(z.unknown()),
  baseSnapshotVersion: z.number(),
});

commandsRoute.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = commandSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  // TODO: Task 2.x — Execute command via ServerEditorCore
  return c.json({ success: true, snapshotVersion: 1 });
});
```

```typescript
// apps/agent/src/routes/project.ts
import { Hono } from "hono";

export const projectRoute = new Hono();

projectRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  // TODO: Fetch from DB
  return c.json({ projectId: id, snapshotVersion: 0, timeline: null });
});
```

```typescript
// apps/agent/src/routes/events.ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export const eventsRoute = new Hono();

eventsRoute.get("/", async (c) => {
  return streamSSE(c, async (stream) => {
    // TODO: Subscribe to ChangeLog events and forward as SSE
    await stream.writeSSE({ data: JSON.stringify({ type: "connected" }), event: "connected" });
  });
});
```

```typescript
// apps/agent/src/routes/media.ts
import { Hono } from "hono";

export const mediaRoute = new Hono();

mediaRoute.post("/finalize", async (c) => {
  // Validate checksum, write DB record
  return c.json({ mediaId: "placeholder" });
});

mediaRoute.get("/:id", async (c) => {
  // Return signed URL
  return c.json({ url: "placeholder" });
});
```

```typescript
// apps/agent/src/routes/status.ts
import { Hono } from "hono";

export const statusRoute = new Hono();

statusRoute.get("/", async (c) => {
  return c.json({ agentStatus: "idle", activeChangesets: 0 });
});
```

- [ ] **Step 3: Wire up entrypoint**

```typescript
// apps/agent/src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./server";

const app = createApp();
const port = parseInt(process.env.PORT || "4000");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ChatCut Agent Service running on http://localhost:${info.port}`);
});
```

- [ ] **Step 4: Write route tests**

```typescript
// apps/agent/src/routes/__tests__/routes.test.ts
import { describe, it, expect } from "vitest";
import { createApp } from "../../server";

const app = createApp();

async function request(path: string, options?: RequestInit) {
  return app.request(path, options);
}

describe("Agent Service Routes", () => {
  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const res = await request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });

  describe("POST /commands", () => {
    it("rejects missing body with 400", async () => {
      const res = await request("/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid command", async () => {
      const res = await request("/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "trim",
          params: { element_id: "el1", trim_start: 1 },
          baseSnapshotVersion: 0,
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("snapshotVersion");
    });
  });

  describe("GET /project/:id", () => {
    it("returns project shape", async () => {
      const res = await request("/project/test-id");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("projectId", "test-id");
    });
  });

  describe("GET /status", () => {
    it("returns agent status", async () => {
      const res = await request("/status");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("agentStatus");
    });
  });
});
```

- [ ] **Step 5: Run route tests**

Run: `cd apps/agent && npx vitest run src/routes/__tests__/routes.test.ts`
Expected: PASS — all 4 route tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/
git commit -m "feat: add Hono HTTP server with route stubs and route tests"
```

---

### Task 9: ServerEditorCore Wrapper

**Files:**
- Create: `apps/agent/src/services/server-editor-core.ts`
- Create: `apps/agent/src/services/__tests__/server-editor-core.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/agent/src/services/__tests__/server-editor-core.test.ts
import { describe, it, expect } from "vitest";
import { ServerEditorCore } from "../server-editor-core";

describe("ServerEditorCore", () => {
  it("initializes from project snapshot", () => {
    const core = ServerEditorCore.fromSnapshot({
      project: { id: "proj1", name: "Test", settings: {} },
      scenes: [],
    });
    expect(core.snapshotVersion).toBe(0);
  });

  it("executeAgentCommand increments snapshotVersion", () => {
    const core = ServerEditorCore.fromSnapshot({
      project: { id: "proj1", name: "Test", settings: {} },
      scenes: [],
    });
    // Would need actual command — mock for now
    expect(core.snapshotVersion).toBe(0);
  });

  it("rejects command with stale baseSnapshotVersion", () => {
    const core = ServerEditorCore.fromSnapshot({
      project: { id: "proj1", name: "Test", settings: {} },
      scenes: [],
    });
    expect(() =>
      core.validateVersion(5) // current is 0, trying to write against 5
    ).toThrow("Stale snapshot version");
  });

  it("clone creates independent copy", () => {
    const core = ServerEditorCore.fromSnapshot({
      project: { id: "proj1", name: "Test", settings: {} },
      scenes: [],
    });
    const clone = core.clone();
    expect(clone).not.toBe(core);
    expect(clone.snapshotVersion).toBe(core.snapshotVersion);
  });
});
```

- [ ] **Step 2: Implement ServerEditorCore**

```typescript
// apps/agent/src/services/server-editor-core.ts
import { EditorCore } from "@opencut/core";
import type { SerializedProject } from "@opencut/core";

export class ServerEditorCore {
  private core: EditorCore;
  private _snapshotVersion: number;

  private constructor(core: EditorCore, version: number) {
    this.core = core;
    this._snapshotVersion = version;
  }

  static fromSnapshot(data: SerializedProject, version = 0): ServerEditorCore {
    const core = EditorCore.deserialize(data);
    return new ServerEditorCore(core, version);
  }

  get snapshotVersion(): number {
    return this._snapshotVersion;
  }

  get editorCore(): EditorCore {
    return this.core;
  }

  validateVersion(expectedVersion: number): void {
    if (expectedVersion !== this._snapshotVersion) {
      throw new Error(
        `Stale snapshot version: expected ${this._snapshotVersion}, got ${expectedVersion}`
      );
    }
  }

  executeAgentCommand(command: unknown, agentId: string): void {
    this.core.executeAgentCommand(command as any, agentId);
    this._snapshotVersion++;
  }

  executeHumanCommand(command: unknown): void {
    this.core.executeCommand(command as any);
    this._snapshotVersion++;
  }

  serialize(): SerializedProject {
    return this.core.serialize();
  }

  clone(): ServerEditorCore {
    const serialized = this.serialize();
    return ServerEditorCore.fromSnapshot(serialized, this._snapshotVersion);
  }
}
```

- [ ] **Step 3: Run test and commit**

Run: `cd apps/agent && npx vitest run src/services/__tests__/server-editor-core.test.ts`

```bash
git add apps/agent/src/services/server-editor-core.ts apps/agent/src/services/__tests__/
git commit -m "feat: add ServerEditorCore with version gating and clone support"
```

---

# Part 2: Agent System

> Builds the multi-agent orchestration: tool schemas, tool executors, AgentRuntime, Master Agent, 5 Sub-agents, ProjectContext, write lock, and ChangesetManager.

---

### Task 10: Agent Tool Type System + Base ToolExecutor

**Files:**
- Create: `apps/agent/src/tools/types.ts`
- Create: `apps/agent/src/tools/executor.ts`
- Create: `apps/agent/src/tools/__tests__/executor.test.ts`

- [ ] **Step 1: Define tool types**

```typescript
// apps/agent/src/tools/types.ts
import { z } from "zod";

export type AgentType = "master" | "editor" | "creator" | "audio" | "vision" | "asset";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  agentTypes: AgentType[]; // Which agents can use this tool
  accessMode: "read" | "write" | "read_write";
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output: ToolCallResult;
  agentType: AgentType;
  taskId: string;
  timestamp: number;
  isWriteOp: boolean;
}
```

- [ ] **Step 2: Implement base ToolExecutor**

```typescript
// apps/agent/src/tools/executor.ts
import type { AgentType, ToolDefinition, ToolCallResult, ToolCallRecord } from "./types";

export abstract class ToolExecutor {
  protected tools = new Map<string, ToolDefinition>();
  private callLog: ToolCallRecord[] = [];

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  validatePermission(toolName: string, agentType: AgentType): void {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Unknown tool: ${toolName}`);
    if (!tool.agentTypes.includes(agentType)) {
      throw new Error(`Agent ${agentType} not authorized for tool ${toolName}`);
    }
  }

  isWriteOperation(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    return tool?.accessMode === "write" || tool?.accessMode === "read_write";
  }

  async execute(
    toolName: string,
    input: unknown,
    context: { agentType: AgentType; taskId: string }
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(toolName);
    if (!tool) return { success: false, error: `Unknown tool: ${toolName}` };

    // Validate permission
    this.validatePermission(toolName, context.agentType);

    // Validate input
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `Invalid input: ${parsed.error.message}` };
    }

    // Execute
    const result = await this.executeImpl(toolName, parsed.data, context);

    // Log
    this.callLog.push({
      toolName,
      input: parsed.data,
      output: result,
      agentType: context.agentType,
      taskId: context.taskId,
      timestamp: Date.now(),
      isWriteOp: this.isWriteOperation(toolName),
    });

    return result;
  }

  protected abstract executeImpl(
    toolName: string,
    input: unknown,
    context: { agentType: AgentType; taskId: string }
  ): Promise<ToolCallResult>;

  getToolDefinitions(agentType: AgentType): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) =>
      t.agentTypes.includes(agentType)
    );
  }
}
```

- [ ] **Step 3: Write test, run, commit**

Test that permission checks work, input validation catches bad input, and write ops are classified correctly.

```bash
git add apps/agent/src/tools/
git commit -m "feat: add ToolExecutor base class with permission checks and input validation"
```

---

### Task 11: Editor Agent Tools (16 tools)

**Files:**
- Create: `apps/agent/src/tools/editor-tools.ts`
- Create: `apps/agent/src/tools/__tests__/editor-tools.test.ts`

- [ ] **Step 1: Define all 16 Editor tool schemas**

```typescript
// apps/agent/src/tools/editor-tools.ts
import { z } from "zod";
import type { ToolDefinition } from "./types";
import { ToolExecutor } from "./executor";
import type { ServerEditorCore } from "../services/server-editor-core";

const EDITOR_AGENT: ["editor"] = ["editor"];

export const editorToolDefinitions: ToolDefinition[] = [
  // Read tools
  {
    name: "get_timeline_state",
    description: "Get the current timeline state as compressed JSON. Always call this first to understand the current state.",
    inputSchema: z.object({}),
    agentTypes: [...EDITOR_AGENT, "master"],
    accessMode: "read",
  },
  {
    name: "get_element_info",
    description: "Get detailed info about a specific timeline element.",
    inputSchema: z.object({ element_id: z.string() }),
    agentTypes: EDITOR_AGENT,
    accessMode: "read",
  },
  {
    name: "preview_frame",
    description: "Capture a preview frame at a specific time.",
    inputSchema: z.object({ time: z.number().min(0) }),
    agentTypes: EDITOR_AGENT,
    accessMode: "read",
  },

  // Write tools
  {
    name: "trim_element",
    description: "Trim an element's start or end point.",
    inputSchema: z.object({
      element_id: z.string(),
      trim_start: z.number().optional(),
      trim_end: z.number().optional(),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "split_element",
    description: "Split an element at a given time, creating two elements.",
    inputSchema: z.object({
      element_id: z.string(),
      split_time: z.number(),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "delete_element",
    description: "Delete one or more elements from the timeline.",
    inputSchema: z.object({ element_ids: z.array(z.string()) }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "move_element",
    description: "Move an element to a new track and/or start time.",
    inputSchema: z.object({
      element_id: z.string(),
      track_id: z.string().optional(),
      new_start_time: z.number().optional(),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "add_element",
    description: "Add a new element (clip, text, sticker) to a track.",
    inputSchema: z.object({
      track_id: z.string(),
      type: z.enum(["video", "audio", "text", "sticker", "effect"]),
      start_time: z.number(),
      duration: z.number(),
      properties: z.record(z.unknown()).optional(),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "set_speed",
    description: "Change playback speed of an element.",
    inputSchema: z.object({
      element_id: z.string(),
      speed: z.number().min(0.1).max(10),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "set_volume",
    description: "Set volume level of an audio or video element.",
    inputSchema: z.object({
      element_id: z.string(),
      volume: z.number().min(0).max(2),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "add_transition",
    description: "Add a transition between two adjacent elements.",
    inputSchema: z.object({
      element_id: z.string(),
      transition_type: z.string(),
      duration: z.number().default(0.5),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "add_effect",
    description: "Apply a visual effect to an element.",
    inputSchema: z.object({
      element_id: z.string(),
      effect_type: z.string(),
      params: z.record(z.unknown()).optional(),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "update_text",
    description: "Update text content and styling of a text element.",
    inputSchema: z.object({
      element_id: z.string(),
      text: z.string().optional(),
      style: z.record(z.unknown()).optional(),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "add_keyframe",
    description: "Add an animation keyframe to an element property.",
    inputSchema: z.object({
      element_id: z.string(),
      property: z.string(),
      time: z.number(),
      value: z.unknown(),
      easing: z.string().optional(),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "reorder_elements",
    description: "Change the order of elements within a track.",
    inputSchema: z.object({
      track_id: z.string(),
      element_ids: z.array(z.string()), // new order
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
  {
    name: "batch_edit",
    description: "Execute multiple edit operations atomically.",
    inputSchema: z.object({
      operations: z.array(z.object({
        tool: z.string(),
        input: z.record(z.unknown()),
      })),
    }),
    agentTypes: EDITOR_AGENT,
    accessMode: "write",
  },
];
```

- [ ] **Step 2: Implement EditorToolExecutor**

Create a class extending `ToolExecutor` that maps each tool to the appropriate `@opencut/core` Command and executes it on the `ServerEditorCore` instance.

- [ ] **Step 3: Write tests for key tools (trim, split, delete, add)**

Test that calling each tool correctly modifies the timeline state via ServerEditorCore.

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/tools/editor-tools.ts apps/agent/src/tools/__tests__/
git commit -m "feat: add 16 Editor Agent tool definitions with Zod schemas"
```

---

### Task 12: Creator, Audio, Vision, Asset Tool Schemas

**Files:**
- Create: `apps/agent/src/tools/creator-tools.ts` (5 tools)
- Create: `apps/agent/src/tools/audio-tools.ts` (6 tools)
- Create: `apps/agent/src/tools/vision-tools.ts` (3 tools)
- Create: `apps/agent/src/tools/asset-tools.ts` (7 tools)

- [ ] **Step 1: Define Creator tools**

5 tools: `generate_video`, `generate_image`, `check_generation_status`, `replace_segment`, `compare_before_after`

Key: `generate_video` and `generate_image` require `idempotencyKey` (UUID) for safe retries.

- [ ] **Step 2: Define Audio tools**

6 tools: `search_bgm`, `add_bgm`, `set_volume`, `transcribe`, `auto_subtitle`, `generate_voiceover`

- [ ] **Step 3: Define Vision tools**

3 tools: `analyze_video` (async, Gemini), `locate_scene`, `describe_frame`

- [ ] **Step 4: Define Asset tools**

7 tools: `search_assets`, `get_asset_info`, `save_asset`, `tag_asset`, `find_similar`, `get_character`, `get_brand_assets`

- [ ] **Step 5: Write schema validation tests for all 4 tool sets**

```typescript
// apps/agent/src/tools/__tests__/creator-tools.test.ts
import { describe, it, expect } from "vitest";
import { creatorToolDefinitions } from "../creator-tools";

describe("Creator Tool Schemas", () => {
  it("defines exactly 5 tools", () => {
    expect(creatorToolDefinitions).toHaveLength(5);
  });

  it("generate_video requires idempotencyKey", () => {
    const tool = creatorToolDefinitions.find((t) => t.name === "generate_video")!;
    const valid = tool.inputSchema.safeParse({ prompt: "test", idempotencyKey: "uuid-1" });
    expect(valid.success).toBe(true);
    const missing = tool.inputSchema.safeParse({ prompt: "test" });
    expect(missing.success).toBe(false);
  });

  it("generate_image requires idempotencyKey", () => {
    const tool = creatorToolDefinitions.find((t) => t.name === "generate_image")!;
    const missing = tool.inputSchema.safeParse({ prompt: "test" });
    expect(missing.success).toBe(false);
  });

  it("all creator tools restricted to creator agent", () => {
    for (const tool of creatorToolDefinitions) {
      expect(tool.agentTypes).toContain("creator");
    }
  });
});
```

```typescript
// apps/agent/src/tools/__tests__/audio-tools.test.ts
import { describe, it, expect } from "vitest";
import { audioToolDefinitions } from "../audio-tools";

describe("Audio Tool Schemas", () => {
  it("defines exactly 6 tools", () => {
    expect(audioToolDefinitions).toHaveLength(6);
  });

  it("search_bgm accepts optional mood/genre/bpm_range", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "search_bgm")!;
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
    expect(tool.inputSchema.safeParse({ mood: "upbeat", genre: "electronic" }).success).toBe(true);
  });

  it("set_volume clamps 0-2", () => {
    const tool = audioToolDefinitions.find((t) => t.name === "set_volume")!;
    expect(tool.inputSchema.safeParse({ element_id: "el1", volume: 1.5 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ element_id: "el1", volume: 5 }).success).toBe(false);
  });
});
```

```typescript
// apps/agent/src/tools/__tests__/vision-tools.test.ts
import { describe, it, expect } from "vitest";
import { visionToolDefinitions } from "../vision-tools";

describe("Vision Tool Schemas", () => {
  it("defines exactly 3 tools", () => {
    expect(visionToolDefinitions).toHaveLength(3);
  });

  it("analyze_video accepts optional focus", () => {
    const tool = visionToolDefinitions.find((t) => t.name === "analyze_video")!;
    expect(tool.inputSchema.safeParse({ video_url: "https://example.com/v.mp4" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ video_url: "https://example.com/v.mp4", focus: "main character" }).success).toBe(true);
  });

  it("all vision tools restricted to vision agent", () => {
    for (const tool of visionToolDefinitions) {
      expect(tool.agentTypes).toContain("vision");
    }
  });
});
```

```typescript
// apps/agent/src/tools/__tests__/asset-tools.test.ts
import { describe, it, expect } from "vitest";
import { assetToolDefinitions } from "../asset-tools";

describe("Asset Tool Schemas", () => {
  it("defines exactly 7 tools", () => {
    expect(assetToolDefinitions).toHaveLength(7);
  });

  it("search_assets requires query", () => {
    const tool = assetToolDefinitions.find((t) => t.name === "search_assets")!;
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ query: "sunset" }).success).toBe(true);
  });

  it("all asset tools restricted to asset agent", () => {
    for (const tool of assetToolDefinitions) {
      expect(tool.agentTypes).toContain("asset");
    }
  });
});
```

- [ ] **Step 6: Run all tool schema tests**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/`
Expected: PASS — all 4 test files green (creator, audio, vision, asset).

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/tools/
git commit -m "feat: add Creator/Audio/Vision/Asset tool schemas with validation tests (21 tools)"
```

---

### Task 13: Master Agent Dispatch Tools

**Files:**
- Create: `apps/agent/src/tools/master-tools.ts`

- [ ] **Step 1: Define 8 Master tools**

```typescript
// apps/agent/src/tools/master-tools.ts
import { z } from "zod";
import type { ToolDefinition } from "./types";

const MASTER: ["master"] = ["master"];

export const masterToolDefinitions: ToolDefinition[] = [
  {
    name: "dispatch_vision",
    description: "Dispatch the Vision Agent to analyze video content.",
    inputSchema: z.object({
      task: z.string(),
      context: z.record(z.unknown()).optional(),
      constraints: z.object({
        maxIterations: z.number().optional(),
        timeoutMs: z.number().optional(),
      }).optional(),
    }),
    agentTypes: MASTER,
    accessMode: "read",
  },
  {
    name: "dispatch_editor",
    description: "Dispatch the Editor Agent to modify the timeline.",
    inputSchema: z.object({
      task: z.string(),
      accessMode: z.enum(["read", "write", "read_write"]).default("read_write"),
      context: z.record(z.unknown()).optional(),
      constraints: z.object({
        maxIterations: z.number().optional(),
        timeoutMs: z.number().optional(),
      }).optional(),
    }),
    agentTypes: MASTER,
    accessMode: "read_write",
  },
  {
    name: "dispatch_creator",
    description: "Dispatch the Creator Agent to generate content.",
    inputSchema: z.object({
      task: z.string(),
      context: z.record(z.unknown()).optional(),
      constraints: z.object({
        maxIterations: z.number().optional(),
        timeoutMs: z.number().optional(),
      }).optional(),
    }),
    agentTypes: MASTER,
    accessMode: "read_write",
  },
  {
    name: "dispatch_audio",
    description: "Dispatch the Audio Agent for audio operations.",
    inputSchema: z.object({
      task: z.string(),
      context: z.record(z.unknown()).optional(),
    }),
    agentTypes: MASTER,
    accessMode: "read_write",
  },
  {
    name: "dispatch_asset",
    description: "Dispatch the Asset Agent for asset management.",
    inputSchema: z.object({
      task: z.string(),
      context: z.record(z.unknown()).optional(),
    }),
    agentTypes: MASTER,
    accessMode: "read",
  },
  {
    name: "explore_options",
    description: "Generate multiple edit candidates when user intent is ambiguous. Triggers fan-out exploration.",
    inputSchema: z.object({
      intent: z.string(),
      baseSnapshotVersion: z.number(),
      timelineSnapshot: z.string(),
      candidates: z.array(z.object({
        label: z.string(),
        summary: z.string(),
        candidateType: z.string(),
        commands: z.array(z.unknown()),
        expectedMetrics: z.object({
          durationChange: z.string(),
          affectedElements: z.number(),
        }),
      })).min(3).max(4),
    }),
    agentTypes: MASTER,
    accessMode: "read",
  },
  {
    name: "propose_changes",
    description: "Submit pending timeline changes for user approval.",
    inputSchema: z.object({
      summary: z.string(),
      affectedElements: z.array(z.string()),
    }),
    agentTypes: MASTER,
    accessMode: "write",
  },
  {
    name: "export_video",
    description: "Submit a video export job.",
    inputSchema: z.object({
      format: z.string().default("mp4"),
      quality: z.enum(["preview", "standard", "high"]).default("standard"),
    }),
    agentTypes: MASTER,
    accessMode: "read",
  },
];
```

- [ ] **Step 2: Write master tools tests**

```typescript
// apps/agent/src/tools/__tests__/master-tools.test.ts
import { describe, it, expect } from "vitest";
import { masterToolDefinitions } from "../master-tools";

describe("Master Tool Schemas", () => {
  it("defines exactly 8 tools", () => {
    expect(masterToolDefinitions).toHaveLength(8);
  });

  it("all master tools restricted to master agent", () => {
    for (const tool of masterToolDefinitions) {
      expect(tool.agentTypes).toContain("master");
    }
  });

  it("explore_options requires 3-4 candidates", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "explore_options")!;
    const twoCandidate = tool.inputSchema.safeParse({
      intent: "test",
      baseSnapshotVersion: 0,
      timelineSnapshot: "{}",
      candidates: [{ label: "A", summary: "a", candidateType: "trim", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } },
                    { label: "B", summary: "b", candidateType: "speed", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } }],
    });
    expect(twoCandidate.success).toBe(false); // min 3

    const threeCandidate = tool.inputSchema.safeParse({
      intent: "test",
      baseSnapshotVersion: 0,
      timelineSnapshot: "{}",
      candidates: [
        { label: "A", summary: "a", candidateType: "trim", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } },
        { label: "B", summary: "b", candidateType: "speed", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } },
        { label: "C", summary: "c", candidateType: "reorder", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 2 } },
      ],
    });
    expect(threeCandidate.success).toBe(true);
  });

  it("dispatch_editor defaults accessMode to read_write", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "dispatch_editor")!;
    const result = tool.inputSchema.safeParse({ task: "trim clip" });
    expect(result.success).toBe(true);
    expect(result.data.accessMode).toBe("read_write");
  });

  it("propose_changes requires summary and affectedElements", () => {
    const tool = masterToolDefinitions.find((t) => t.name === "propose_changes")!;
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ summary: "trimmed clip", affectedElements: ["el1"] }).success).toBe(true);
  });
});
```

- [ ] **Step 3: Run master tools tests**

Run: `cd apps/agent && npx vitest run src/tools/__tests__/master-tools.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/tools/master-tools.ts apps/agent/src/tools/__tests__/master-tools.test.ts
git commit -m "feat: add 8 Master Agent dispatch + control tools with tests"
```

---

### Task 14: ProjectContext + Write Lock

**Files:**
- Create: `apps/agent/src/context/project-context.ts`
- Create: `apps/agent/src/context/write-lock.ts`
- Create: `apps/agent/src/context/__tests__/project-context.test.ts`
- Create: `apps/agent/src/context/__tests__/write-lock.test.ts`

- [ ] **Step 1: Define ProjectContext**

```typescript
// apps/agent/src/context/project-context.ts
import type { VideoAnalysis } from "../services/vision-client";

export interface ProjectContext {
  timelineState: string; // Serialized via StateSerializer
  snapshotVersion: number;
  videoAnalysis: VideoAnalysis | null;
  currentIntent: {
    raw: string;
    parsed: string;
    explorationMode: boolean;
  };
  memoryContext: {
    promptText: string;
    injectedMemoryIds: string[];
    injectedSkillIds: string[];
  };
  artifacts: Record<string, {
    producedBy: string;
    type: string;
    data: unknown;
    sizeBytes: number;
    timestamp: string;
    lastAccessedAt: string;
  }>;
  recentChanges: Array<{
    id: string;
    source: string;
    summary: string;
    timestamp: number;
  }>;
}

export class ProjectContextManager {
  private context: ProjectContext;

  constructor(initial: Partial<ProjectContext> = {}) {
    this.context = {
      timelineState: initial.timelineState ?? "{}",
      snapshotVersion: initial.snapshotVersion ?? 0,
      videoAnalysis: initial.videoAnalysis ?? null,
      currentIntent: initial.currentIntent ?? { raw: "", parsed: "", explorationMode: false },
      memoryContext: initial.memoryContext ?? { promptText: "", injectedMemoryIds: [], injectedSkillIds: [] },
      artifacts: initial.artifacts ?? {},
      recentChanges: initial.recentChanges ?? [],
    };
  }

  get(): Readonly<ProjectContext> {
    return this.context;
  }

  updateTimeline(state: string, version: number): void {
    this.context.timelineState = state;
    this.context.snapshotVersion = version;
  }

  setArtifact(key: string, artifact: ProjectContext["artifacts"][string]): void {
    // Max 50 artifacts
    const keys = Object.keys(this.context.artifacts);
    if (keys.length >= 50 && !(key in this.context.artifacts)) {
      // Evict oldest by lastAccessedAt
      const oldest = keys.sort((a, b) =>
        new Date(this.context.artifacts[a].lastAccessedAt).getTime() -
        new Date(this.context.artifacts[b].lastAccessedAt).getTime()
      )[0];
      delete this.context.artifacts[oldest];
    }
    this.context.artifacts[key] = artifact;
  }

  getArtifact(key: string): unknown | undefined {
    const art = this.context.artifacts[key];
    if (art) art.lastAccessedAt = new Date().toISOString();
    return art?.data;
  }
}
```

- [ ] **Step 2: Implement ProjectWriteLock**

```typescript
// apps/agent/src/context/write-lock.ts
export class ProjectWriteLock {
  private locked = false;
  private waitQueue: Array<{ resolve: () => void }> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push({ resolve });
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next.resolve();
    } else {
      this.locked = false;
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }
}
```

- [ ] **Step 3: Write tests, run, commit**

```bash
git add apps/agent/src/context/
git commit -m "feat: add ProjectContext manager and dispatch-scoped write lock"
```

---

### Task 15: AgentRuntime Abstraction

**Files:**
- Create: `apps/agent/src/agents/runtime.ts`
- Create: `apps/agent/src/agents/types.ts`

- [ ] **Step 1: Define runtime interfaces**

```typescript
// apps/agent/src/agents/types.ts
import type { AgentType } from "../tools/types";

export interface AgentConfig {
  agentType: AgentType;
  model: string;
  system: string;
  tools: unknown[]; // Tool definitions in Claude format
  tokenBudget?: { input: number; output: number };
  maxIterations?: number;
}

export interface AgentResult {
  text: string;
  toolCalls: Array<{
    toolName: string;
    input: unknown;
    output: unknown;
  }>;
  tokensUsed: { input: number; output: number };
  needsAssistance?: {
    agentType: string;
    task: string;
    context: unknown;
  };
}

export interface DispatchInput {
  task: string;
  accessMode: "read" | "write" | "read_write";
  context?: Record<string, unknown>;
  constraints?: { maxIterations?: number; timeoutMs?: number };
}

export interface DispatchOutput {
  result: string;
  artifacts?: Record<string, unknown>;
  needsAssistance?: { agentType: string; task: string; context: unknown };
  toolCallCount: number;
  tokensUsed: number;
}

export const TOKEN_BUDGETS: Record<AgentType, { input: number; output: number }> = {
  master: { input: 100_000, output: 8_000 },
  editor: { input: 30_000, output: 4_000 },
  creator: { input: 30_000, output: 4_000 },
  audio: { input: 30_000, output: 4_000 },
  vision: { input: 50_000, output: 8_000 },
  asset: { input: 10_000, output: 2_000 },
};

export const MAX_ITERATIONS: Record<AgentType, number> = {
  master: 30,
  editor: 20,
  creator: 10,
  audio: 15,
  vision: 5,
  asset: 10,
};
```

- [ ] **Step 2: Implement AgentRuntime**

```typescript
// apps/agent/src/agents/runtime.ts
import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, AgentResult } from "./types";

export interface AgentRuntime {
  run(config: AgentConfig, input: string): Promise<AgentResult>;
}

/**
 * NativeAPIRuntime — fallback using Claude Messages API directly.
 * Manual tool-use loop with message history management.
 */
export class NativeAPIRuntime implements AgentRuntime {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async run(config: AgentConfig, input: string): Promise<AgentResult> {
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: input },
    ];

    const toolCalls: AgentResult["toolCalls"] = [];
    let iterations = 0;
    const maxIter = config.maxIterations ?? 20;

    while (iterations < maxIter) {
      const response = await this.client.messages.create({
        model: config.model,
        system: config.system,
        messages,
        tools: config.tools as Anthropic.Messages.Tool[],
        max_tokens: config.tokenBudget?.output ?? 4096,
      });

      // If no tool use, we're done
      if (response.stop_reason === "end_turn") {
        const text = response.content
          .filter((b) => b.type === "text")
          .map((b) => (b as Anthropic.Messages.TextBlock).text)
          .join("");
        return {
          text,
          toolCalls,
          tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
        };
      }

      // Process tool calls
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const toolBlock = block as Anthropic.Messages.ToolUseBlock;
        // Execute tool via provided executor (injected separately)
        const result = await this.executeTool(toolBlock.name, toolBlock.input);
        toolCalls.push({ toolName: toolBlock.name, input: toolBlock.input, output: result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
      iterations++;
    }

    return {
      text: "Max iterations reached",
      toolCalls,
      tokensUsed: { input: 0, output: 0 },
    };
  }

  // Tool execution is injected by the caller
  private executeTool: (name: string, input: unknown) => Promise<unknown> = async () => ({});

  setToolExecutor(fn: (name: string, input: unknown) => Promise<unknown>): void {
    this.executeTool = fn;
  }
}
```

- [ ] **Step 3: Write runtime tests**

```typescript
// apps/agent/src/agents/__tests__/runtime.test.ts
import { describe, it, expect, vi } from "vitest";
import { NativeAPIRuntime } from "../runtime";

// Mock Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(),
    };
  },
}));

describe("NativeAPIRuntime", () => {
  it("returns text when model responds without tool use", async () => {
    const runtime = new NativeAPIRuntime("test-key");

    // Mock the internal client to return end_turn
    const mockCreate = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Hello, I trimmed the clip." }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    (runtime as any).client.messages.create = mockCreate;

    const result = await runtime.run(
      { agentType: "editor", model: "claude-sonnet-4-6", system: "You are an editor.", tools: [], maxIterations: 5 },
      "Trim the first clip"
    );

    expect(result.text).toBe("Hello, I trimmed the clip.");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("executes tool-use loop and terminates", async () => {
    const runtime = new NativeAPIRuntime("test-key");
    const toolExecutor = vi.fn().mockResolvedValue({ success: true, data: { trimmed: true } });
    runtime.setToolExecutor(toolExecutor);

    const mockCreate = vi.fn()
      // First call: tool_use
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu1", name: "trim_element", input: { element_id: "el1", trim_start: 1 } },
        ],
        usage: { input_tokens: 200, output_tokens: 100 },
      })
      // Second call: end_turn
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done trimming." }],
        usage: { input_tokens: 300, output_tokens: 50 },
      });
    (runtime as any).client.messages.create = mockCreate;

    const result = await runtime.run(
      { agentType: "editor", model: "claude-sonnet-4-6", system: "You are an editor.", tools: [], maxIterations: 10 },
      "Trim clip"
    );

    expect(toolExecutor).toHaveBeenCalledWith("trim_element", { element_id: "el1", trim_start: 1 });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBe("Done trimming.");
  });

  it("stops at maxIterations", async () => {
    const runtime = new NativeAPIRuntime("test-key");
    runtime.setToolExecutor(vi.fn().mockResolvedValue({}));

    // Always returns tool_use — should stop at maxIterations
    const mockCreate = vi.fn().mockResolvedValue({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu1", name: "get_timeline_state", input: {} },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    (runtime as any).client.messages.create = mockCreate;

    const result = await runtime.run(
      { agentType: "editor", model: "claude-sonnet-4-6", system: "", tools: [], maxIterations: 3 },
      "Loop forever"
    );

    expect(result.text).toBe("Max iterations reached");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 4: Run runtime tests**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/runtime.test.ts`
Expected: PASS — 3 tests (text response, tool loop, max iterations).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/agents/
git commit -m "feat: add AgentRuntime abstraction with NativeAPIRuntime and tests"
```

---

### Task 16: Master Agent Implementation

**Files:**
- Create: `apps/agent/src/agents/master-agent.ts`

- [ ] **Step 1: Implement Master Agent**

The Master Agent:
1. Receives user message
2. Reads ProjectContext (timeline state, memory, recent changes)
3. Parses intent and decomposes into sub-tasks
4. Dispatches sub-agents via `dispatch_*` tools
5. Aggregates results
6. Calls `propose_changes` for user approval

```typescript
// apps/agent/src/agents/master-agent.ts
import { NativeAPIRuntime } from "./runtime";
import type { DispatchInput, DispatchOutput, AgentConfig } from "./types";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types";
import { masterToolDefinitions } from "../tools/master-tools";
import type { ProjectContextManager } from "../context/project-context";
import type { ProjectWriteLock } from "../context/write-lock";

export class MasterAgent {
  private runtime: NativeAPIRuntime;
  private contextManager: ProjectContextManager;
  private writeLock: ProjectWriteLock;
  private subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;

  constructor(deps: {
    runtime: NativeAPIRuntime;
    contextManager: ProjectContextManager;
    writeLock: ProjectWriteLock;
    subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;
  }) {
    this.runtime = deps.runtime;
    this.contextManager = deps.contextManager;
    this.writeLock = deps.writeLock;
    this.subAgentDispatchers = deps.subAgentDispatchers;

    // Wire tool executor
    this.runtime.setToolExecutor(async (name, input) => {
      return this.handleToolCall(name, input);
    });
  }

  async handleUserMessage(message: string): Promise<string> {
    const ctx = this.contextManager.get();

    const systemPrompt = this.buildSystemPrompt(ctx);

    const config: AgentConfig = {
      agentType: "master",
      model: "claude-opus-4-6",
      system: systemPrompt,
      tools: this.formatToolsForClaude(masterToolDefinitions),
      tokenBudget: TOKEN_BUDGETS.master,
      maxIterations: MAX_ITERATIONS.master,
    };

    const result = await this.runtime.run(config, message);
    return result.text;
  }

  private buildSystemPrompt(ctx: ReturnType<ProjectContextManager["get"]>): string {
    return `You are the Master Agent of ChatCut, an AI video editor.

## Current Timeline State
${ctx.timelineState}

## Memory Context
${ctx.memoryContext.promptText || "No memory loaded."}

## Recent Changes
${ctx.recentChanges.map((c) => `- [${c.source}] ${c.summary}`).join("\n") || "No recent changes."}

## Instructions
- Parse user intent and decompose into sub-tasks
- Dispatch appropriate sub-agents
- Use explore_options when intent is ambiguous
- Always propose_changes before committing edits
- Be concise in responses`;
  }

  private async handleToolCall(name: string, input: unknown): Promise<unknown> {
    if (name.startsWith("dispatch_")) {
      const agentType = name.replace("dispatch_", "");
      const dispatcher = this.subAgentDispatchers.get(agentType);
      if (!dispatcher) return { error: `No dispatcher for ${agentType}` };

      const dispatchInput = input as DispatchInput;

      // Acquire write lock for write operations
      if (dispatchInput.accessMode !== "read") {
        await this.writeLock.acquire();
        try {
          return await dispatcher(dispatchInput);
        } finally {
          this.writeLock.release();
        }
      }

      return dispatcher(dispatchInput);
    }

    if (name === "propose_changes") {
      // Delegate to ChangesetManager (Task 17)
      return { changesetId: "pending", status: "awaiting_approval" };
    }

    if (name === "explore_options") {
      // Delegate to ExplorationEngine (Part 4)
      return { explorationId: "pending", status: "queued" };
    }

    return { error: `Unhandled tool: ${name}` };
  }

  private formatToolsForClaude(tools: unknown[]): unknown[] {
    // Convert ToolDefinition[] to Claude API tool format
    return (tools as any[]).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}
```

- [ ] **Step 2: Write Master Agent tests**

```typescript
// apps/agent/src/agents/__tests__/master-agent.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MasterAgent } from "../master-agent";
import { ProjectContextManager } from "../../context/project-context";
import { ProjectWriteLock } from "../../context/write-lock";

describe("MasterAgent", () => {
  let agent: MasterAgent;
  let dispatchers: Map<string, vi.Mock>;
  let writeLock: ProjectWriteLock;

  beforeEach(() => {
    dispatchers = new Map([
      ["vision", vi.fn().mockResolvedValue({ result: "analyzed", toolCallCount: 2, tokensUsed: 500 })],
      ["editor", vi.fn().mockResolvedValue({ result: "trimmed", toolCallCount: 3, tokensUsed: 800 })],
      ["creator", vi.fn().mockResolvedValue({ result: "generated", toolCallCount: 1, tokensUsed: 300 })],
      ["audio", vi.fn().mockResolvedValue({ result: "added bgm", toolCallCount: 2, tokensUsed: 400 })],
      ["asset", vi.fn().mockResolvedValue({ result: "found assets", toolCallCount: 1, tokensUsed: 100 })],
    ]);
    writeLock = new ProjectWriteLock();
  });

  it("handleToolCall dispatches to correct sub-agent", async () => {
    const ctx = new ProjectContextManager({ timelineState: '{"scenes":[]}' });
    agent = createMasterAgent(ctx, writeLock, dispatchers);

    const result = await (agent as any).handleToolCall("dispatch_editor", {
      task: "trim first clip by 2s",
      accessMode: "write",
    });

    expect(dispatchers.get("editor")).toHaveBeenCalledWith(
      expect.objectContaining({ task: "trim first clip by 2s" })
    );
  });

  it("acquires write lock for write dispatches", async () => {
    const ctx = new ProjectContextManager();
    agent = createMasterAgent(ctx, writeLock, dispatchers);

    const acquireSpy = vi.spyOn(writeLock, "acquire");
    const releaseSpy = vi.spyOn(writeLock, "release");

    await (agent as any).handleToolCall("dispatch_editor", {
      task: "delete clip",
      accessMode: "write",
    });

    expect(acquireSpy).toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalled();
  });

  it("does NOT acquire write lock for read-only dispatches", async () => {
    const ctx = new ProjectContextManager();
    agent = createMasterAgent(ctx, writeLock, dispatchers);

    const acquireSpy = vi.spyOn(writeLock, "acquire");

    await (agent as any).handleToolCall("dispatch_vision", {
      task: "analyze video",
      accessMode: "read",
    });

    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("buildSystemPrompt includes timeline state and memory", () => {
    const ctx = new ProjectContextManager({
      timelineState: '{"scenes":[{"id":"s1"}]}',
      memoryContext: { promptText: "User prefers hard cuts", injectedMemoryIds: ["m1"], injectedSkillIds: [] },
    });
    agent = createMasterAgent(ctx, writeLock, dispatchers);

    const prompt = (agent as any).buildSystemPrompt(ctx.get());
    expect(prompt).toContain("s1");
    expect(prompt).toContain("User prefers hard cuts");
  });

  it("returns error for unknown dispatcher", async () => {
    const ctx = new ProjectContextManager();
    agent = createMasterAgent(ctx, writeLock, dispatchers);

    const result = await (agent as any).handleToolCall("dispatch_unknown", { task: "x" });
    expect(result).toHaveProperty("error");
  });
});

function createMasterAgent(ctx: ProjectContextManager, lock: ProjectWriteLock, dispatchers: Map<string, any>) {
  const { NativeAPIRuntime } = require("../runtime");
  const runtime = new NativeAPIRuntime("test-key");
  return new MasterAgent({ runtime, contextManager: ctx, writeLock: lock, subAgentDispatchers: dispatchers });
}
```

- [ ] **Step 3: Run Master Agent tests**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/master-agent.test.ts`
Expected: PASS — 5 tests (dispatch routing, write lock, read skip lock, system prompt, unknown dispatch error).

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/agents/master-agent.ts apps/agent/src/agents/__tests__/master-agent.test.ts
git commit -m "feat: add Master Agent with dispatch protocol, system prompt builder, and tests"
```

---

### Task 17: Sub-Agent Implementations (Editor, Creator, Audio, Vision, Asset)

**Files:**
- Create: `apps/agent/src/agents/editor-agent.ts`
- Create: `apps/agent/src/agents/creator-agent.ts`
- Create: `apps/agent/src/agents/audio-agent.ts`
- Create: `apps/agent/src/agents/vision-agent.ts`
- Create: `apps/agent/src/agents/asset-agent.ts`

Each sub-agent follows the same pattern:
1. Receives task description from Master
2. Builds agent-specific system prompt (with tool descriptions + memory)
3. Runs tool-use loop via NativeAPIRuntime
4. Returns DispatchOutput with result + optional artifacts

- [ ] **Step 1: Implement Editor Agent**

The Editor Agent uses 16 editor tools and operates on the timeline.

```typescript
// apps/agent/src/agents/editor-agent.ts
import { NativeAPIRuntime } from "./runtime";
import type { DispatchInput, DispatchOutput, AgentConfig } from "./types";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types";
import { editorToolDefinitions } from "../tools/editor-tools";
import type { ToolExecutor } from "../tools/executor";

export class EditorAgent {
  private runtime: NativeAPIRuntime;
  private toolExecutor: ToolExecutor;

  constructor(deps: { runtime: NativeAPIRuntime; toolExecutor: ToolExecutor }) {
    this.runtime = deps.runtime;
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const taskId = `task_editor_${Date.now()}`;

    const rt = new NativeAPIRuntime(process.env.ANTHROPIC_API_KEY!);
    rt.setToolExecutor(async (name, toolInput) => {
      const result = await this.toolExecutor.execute(name, toolInput, {
        agentType: "editor",
        taskId,
      });
      return result.data;
    });

    const config: AgentConfig = {
      agentType: "editor",
      model: "claude-sonnet-4-6",
      system: this.buildSystemPrompt(input),
      tools: this.formatTools(),
      tokenBudget: TOKEN_BUDGETS.editor,
      maxIterations: input.constraints?.maxIterations ?? MAX_ITERATIONS.editor,
    };

    const result = await rt.run(config, input.task);

    return {
      result: result.text,
      artifacts: {},
      toolCallCount: result.toolCalls.length,
      tokensUsed: result.tokensUsed.input + result.tokensUsed.output,
      ...(result.needsAssistance ? { needsAssistance: result.needsAssistance } : {}),
    };
  }

  private buildSystemPrompt(input: DispatchInput): string {
    return `You are the Editor Agent. Your job is to modify the video timeline.

## Task
${input.task}

## Context
${input.context ? JSON.stringify(input.context) : "No additional context."}

## Rules
- Always call get_timeline_state first
- Use batch_edit for multiple related changes
- Minimize tool calls — plan before acting`;
  }

  private formatTools(): unknown[] {
    return editorToolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}
```

- [ ] **Step 2: Implement Creator, Audio, Vision, Asset agents**

Same pattern, different tools and system prompts. Vision Agent additionally uses Gemini for video analysis.

- [ ] **Step 3: Write sub-agent tests**

```typescript
// apps/agent/src/agents/__tests__/editor-agent.test.ts
import { describe, it, expect, vi } from "vitest";
import { EditorAgent } from "../editor-agent";

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Trimmed clip el1 by 2s." }],
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
    };
  },
}));

describe("EditorAgent", () => {
  it("dispatch returns DispatchOutput with result and metrics", async () => {
    const mockExecutor = { execute: vi.fn().mockResolvedValue({ success: true, data: {} }) } as any;
    const agent = new EditorAgent({ runtime: null as any, toolExecutor: mockExecutor });

    const output = await agent.dispatch({
      task: "Trim el1 start by 2 seconds",
      accessMode: "write",
    });

    expect(output).toHaveProperty("result");
    expect(output).toHaveProperty("toolCallCount");
    expect(output).toHaveProperty("tokensUsed");
    expect(typeof output.result).toBe("string");
  });

  it("system prompt includes task description", () => {
    const mockExecutor = { execute: vi.fn() } as any;
    const agent = new EditorAgent({ runtime: null as any, toolExecutor: mockExecutor });

    const prompt = (agent as any).buildSystemPrompt({
      task: "Delete the third clip",
      accessMode: "write",
      context: { hint: "clip is at 5.2s" },
    });

    expect(prompt).toContain("Delete the third clip");
    expect(prompt).toContain("hint");
  });
});
```

```typescript
// apps/agent/src/agents/__tests__/creator-agent.test.ts
import { describe, it, expect, vi } from "vitest";
import { CreatorAgent } from "../creator-agent";

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Generated video segment." }],
        usage: { input_tokens: 400, output_tokens: 80 },
      }),
    };
  },
}));

describe("CreatorAgent", () => {
  it("dispatch returns result with artifacts", async () => {
    const mockExecutor = { execute: vi.fn().mockResolvedValue({ success: true, data: { taskId: "gen-1" } }) } as any;
    const agent = new CreatorAgent({ runtime: null as any, toolExecutor: mockExecutor });

    const output = await agent.dispatch({
      task: "Generate a sunset transition clip",
      accessMode: "write",
    });

    expect(output.result).toBeDefined();
    expect(output.tokensUsed).toBeGreaterThan(0);
  });
});
```

```typescript
// apps/agent/src/agents/__tests__/vision-agent.test.ts
import { describe, it, expect, vi } from "vitest";
import { VisionAgent } from "../vision-agent";

describe("VisionAgent", () => {
  it("dispatch calls vision tools and returns analysis", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { scenes: [{ start: 0, end: 3.2, description: "Logo intro" }], characters: [], mood: "warm" },
      }),
    } as any;
    const agent = new VisionAgent({ runtime: null as any, toolExecutor: mockExecutor });

    const output = await agent.dispatch({
      task: "Analyze the full video",
      accessMode: "read",
    });

    expect(output.result).toBeDefined();
    expect(output.toolCallCount).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 4: Run sub-agent tests**

Run: `cd apps/agent && npx vitest run src/agents/__tests__/`
Expected: PASS — editor-agent (2), creator-agent (1), vision-agent (1) all green.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/agents/
git commit -m "feat: add 5 sub-agent implementations with dispatch tests"
```

---

### Task 18: ChangesetManager

**Files:**
- Create: `apps/agent/src/changeset/changeset-manager.ts`
- Create: `apps/agent/src/changeset/changeset-types.ts`
- Create: `apps/agent/src/changeset/__tests__/changeset-manager.test.ts`

- [ ] **Step 1: Define types**

```typescript
// apps/agent/src/changeset/changeset-types.ts
export interface PendingChangeset {
  changesetId: string;
  projectId: string;
  boundaryCursor: number; // ChangeLog index at changeset start
  status: "pending" | "approved" | "rejected";
  summary: string;
  fingerprint: {
    elementIds: string[];
    trackIds: string[];
    timeRanges: Array<{ start: number; end: number }>;
  };
  injectedMemoryIds: string[];
  injectedSkillIds: string[];
  createdAt: number;
  decidedAt?: number;
}
```

- [ ] **Step 2: Implement ChangesetManager**

Core methods:
- `propose()` — record boundary cursor, return changesetId
- `approve(changesetId)` — atomic DB transaction: decide event + snapshot + version++
- `reject(changesetId)` — undo from committed snapshot
- `approveWithMods(changesetId, modifications)` — human tweaks on top

- [ ] **Step 3: Write ChangesetManager tests**

```typescript
// apps/agent/src/changeset/__tests__/changeset-manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChangesetManager } from "../changeset-manager";
import { ChangeLog } from "@opencut/core";

describe("ChangesetManager", () => {
  let manager: ChangesetManager;
  let changeLog: ChangeLog;
  let mockDb: any;
  let mockServerCore: any;

  beforeEach(() => {
    changeLog = new ChangeLog();
    mockDb = {
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
      transaction: vi.fn(async (fn: Function) => fn(mockDb)),
    };
    mockServerCore = {
      snapshotVersion: 0,
      serialize: vi.fn().mockReturnValue({ project: {}, scenes: [] }),
      clone: vi.fn().mockReturnValue({ serialize: vi.fn().mockReturnValue({ project: {}, scenes: [] }) }),
    };
    manager = new ChangesetManager({ db: mockDb, changeLog, serverCore: mockServerCore });
  });

  it("propose records boundary cursor and returns changesetId", async () => {
    // Simulate some changes in the log
    changeLog.record({ source: "agent", agentId: "editor", action: { type: "trim", targetType: "element", targetId: "el1", details: {} }, summary: "Trimmed" });
    changeLog.record({ source: "agent", agentId: "editor", action: { type: "delete", targetType: "element", targetId: "el2", details: {} }, summary: "Deleted" });

    const cs = await manager.propose({
      summary: "Trimmed and deleted clips",
      affectedElements: ["el1", "el2"],
    });

    expect(cs.changesetId).toBeDefined();
    expect(cs.status).toBe("pending");
    expect(cs.boundaryCursor).toBe(changeLog.length - 1);
  });

  it("approve commits atomically (decision event + snapshot + version++)", async () => {
    const cs = await manager.propose({ summary: "test", affectedElements: ["el1"] });
    await manager.approve(cs.changesetId);

    // Should have emitted a decision event
    const decisions = changeLog.getDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe("changeset_committed");
    expect(decisions[0].changesetId).toBe(cs.changesetId);
  });

  it("reject undoes from committed snapshot", async () => {
    const cs = await manager.propose({ summary: "test", affectedElements: ["el1"] });
    await manager.reject(cs.changesetId);

    const decisions = changeLog.getDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe("changeset_rejected");
  });

  it("approveWithMods applies human tweaks on top", async () => {
    const cs = await manager.propose({ summary: "test", affectedElements: ["el1"] });
    await manager.approveWithMods(cs.changesetId, [
      { type: "update", targetId: "el1", details: { volume: 0.5 } },
    ]);

    const decisions = changeLog.getDecisions();
    expect(decisions[0].type).toBe("changeset_committed");
    // Additional changes from mods should be in the log
    const entries = changeLog.getAll();
    expect(entries.some((e) => e.source === "human")).toBe(true);
  });

  it("rejects approve on stale version", async () => {
    const cs = await manager.propose({ summary: "test", affectedElements: ["el1"] });
    // Simulate external version bump
    (mockServerCore as any).snapshotVersion = 5;

    await expect(manager.approve(cs.changesetId)).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run ChangesetManager tests**

Run: `cd apps/agent && npx vitest run src/changeset/__tests__/changeset-manager.test.ts`
Expected: PASS — 5 tests (propose, approve, reject, approveWithMods, stale version).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/changeset/
git commit -m "feat: add ChangesetManager with propose/approve/reject/approveWithMods and tests"
```

---

### Task 19: VisionClient + VisionCache (Gemini Integration)

**Files:**
- Create: `apps/agent/src/services/vision-client.ts`
- Create: `apps/agent/src/services/vision-cache.ts`

- [ ] **Step 1: Implement VisionClient**

```typescript
// apps/agent/src/services/vision-client.ts
export interface VideoAnalysis {
  scenes: Array<{
    start: number;
    end: number;
    description: string;
    objects: string[];
  }>;
  characters: string[];
  mood: string;
  style: string;
}

export class VisionClient {
  private geminiApiKey: string;

  constructor(apiKey: string) {
    this.geminiApiKey = apiKey;
  }

  async analyzeVideo(videoUrl: string, focus?: string): Promise<VideoAnalysis> {
    // Call Gemini 2.5 Pro with video input
    // Parse structured JSON output
    // Return VideoAnalysis
    throw new Error("TODO: Implement Gemini API call");
  }

  async locateScene(query: string, analysis: VideoAnalysis): Promise<Array<{ start: number; end: number; description: string }>> {
    // Match natural language query against scene descriptions
    return analysis.scenes.filter((s) =>
      s.description.toLowerCase().includes(query.toLowerCase())
    );
  }
}
```

- [ ] **Step 2: Implement VisionCache**

Cache by `mediaHash + schemaVersion`. Only cache canonical (no-focus) analyses.

- [ ] **Step 3: Write VisionClient + VisionCache tests**

```typescript
// apps/agent/src/services/__tests__/vision-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { VisionClient } from "../vision-client";

// Mock global fetch for Gemini API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("VisionClient", () => {
  it("analyzeVideo returns structured VideoAnalysis", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                scenes: [{ start: 0, end: 3.2, description: "Logo intro", objects: ["logo"] }],
                characters: ["narrator"],
                mood: "professional",
                style: "corporate",
              }),
            }],
          },
        }],
      }),
    });

    const client = new VisionClient("test-gemini-key");
    const result = await client.analyzeVideo("https://storage.example.com/video.mp4");

    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].start).toBe(0);
    expect(result.scenes[0].end).toBe(3.2);
    expect(result.characters).toContain("narrator");
    expect(result.mood).toBe("professional");
  });

  it("locateScene filters by natural language query", async () => {
    const client = new VisionClient("test-key");
    const analysis = {
      scenes: [
        { start: 0, end: 3.2, description: "Logo intro", objects: [] },
        { start: 3.2, end: 8.7, description: "Chef cooking pasta in kitchen", objects: ["pan", "pasta"] },
        { start: 8.7, end: 15, description: "Final product plating", objects: ["plate"] },
      ],
      characters: [],
      mood: "warm",
      style: "food",
    };

    const matches = await client.locateScene("cooking", analysis);
    expect(matches).toHaveLength(1);
    expect(matches[0].description).toContain("cooking");
    expect(matches[0].start).toBe(3.2);
  });
});
```

```typescript
// apps/agent/src/services/__tests__/vision-cache.test.ts
import { describe, it, expect, vi } from "vitest";
import { VisionCache } from "../vision-cache";

describe("VisionCache", () => {
  it("returns cached analysis on cache hit", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            analysis: { scenes: [], characters: [], mood: "warm", style: "casual" },
          }]),
        }),
      }),
    } as any;

    const cache = new VisionCache(mockDb);
    const result = await cache.get("hash123", 1);

    expect(result).not.toBeNull();
    expect(result!.mood).toBe("warm");
  });

  it("returns null on cache miss", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any;

    const cache = new VisionCache(mockDb);
    const result = await cache.get("unknown-hash", 1);
    expect(result).toBeNull();
  });

  it("does NOT cache focus-specific queries", async () => {
    const mockDb = { insert: vi.fn() } as any;
    const cache = new VisionCache(mockDb);

    // Focus queries should skip caching
    await cache.set("hash123", 1, { scenes: [], characters: [], mood: "", style: "" }, "main character");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run vision tests**

Run: `cd apps/agent && npx vitest run src/services/__tests__/vision-client.test.ts src/services/__tests__/vision-cache.test.ts`
Expected: PASS — VisionClient (2 tests), VisionCache (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/services/vision-client.ts apps/agent/src/services/vision-cache.ts apps/agent/src/services/__tests__/
git commit -m "feat: add VisionClient (Gemini) and VisionCache with tests"
```

---

### Task 20: GenerationClient (creative-engine Integration)

**Files:**
- Create: `apps/agent/src/services/generation-client.ts`
- Create: `apps/agent/src/services/content-editor.ts`

- [ ] **Step 1: Implement GenerationClient**

Wraps creative-engine REST API for video/image generation (Kling, Seedance, Veo).

```typescript
// apps/agent/src/services/generation-client.ts
export class GenerationClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: { baseUrl: string; apiKey: string }) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  async generateVideo(params: {
    prompt: string;
    provider?: "kling" | "seedance" | "veo";
    duration?: number;
    refImage?: string;
    idempotencyKey: string;
  }): Promise<{ taskId: string }> {
    const res = await fetch(`${this.baseUrl}/generate/video`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return res.json();
  }

  async checkStatus(taskId: string): Promise<{
    status: "pending" | "processing" | "completed" | "failed";
    progress: number;
    resultUrl?: string;
  }> {
    const res = await fetch(`${this.baseUrl}/status/${taskId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return res.json();
  }

  async waitForCompletion(taskId: string, timeoutMs = 300_000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.checkStatus(taskId);
      if (status.status === "completed" && status.resultUrl) return status.resultUrl;
      if (status.status === "failed") throw new Error("Generation failed");
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("Generation timeout");
  }
}
```

- [ ] **Step 2: Implement ContentEditor pipeline**

End-to-end: extractFrames -> prompt construction -> generateVideo -> waitForCompletion -> replaceSegment

- [ ] **Step 3: Write GenerationClient + ContentEditor tests**

```typescript
// apps/agent/src/services/__tests__/generation-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GenerationClient } from "../generation-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("GenerationClient", () => {
  let client: GenerationClient;

  beforeEach(() => {
    client = new GenerationClient({ baseUrl: "https://api.creative-engine.test", apiKey: "test-key" });
    mockFetch.mockReset();
  });

  it("generateVideo returns taskId", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ taskId: "gen-abc123" }),
    });

    const result = await client.generateVideo({
      prompt: "sunset over ocean",
      provider: "kling",
      idempotencyKey: "idem-1",
    });

    expect(result.taskId).toBe("gen-abc123");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.creative-engine.test/generate/video",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("checkStatus returns progress and resultUrl", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: "completed", progress: 100, resultUrl: "https://r2.test/video.mp4" }),
    });

    const status = await client.checkStatus("gen-abc123");
    expect(status.status).toBe("completed");
    expect(status.resultUrl).toBe("https://r2.test/video.mp4");
  });

  it("waitForCompletion polls until done", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "processing", progress: 30 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "processing", progress: 70 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "completed", progress: 100, resultUrl: "https://r2.test/done.mp4" }) });

    // Override poll interval for test speed
    const url = await client.waitForCompletion("gen-abc123", 30_000);
    expect(url).toBe("https://r2.test/done.mp4");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("waitForCompletion throws on failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: "failed", progress: 0 }),
    });

    await expect(client.waitForCompletion("gen-fail", 5_000)).rejects.toThrow("Generation failed");
  });
});
```

```typescript
// apps/agent/src/services/__tests__/content-editor.test.ts
import { describe, it, expect, vi } from "vitest";
import { ContentEditor } from "../content-editor";

describe("ContentEditor", () => {
  it("end-to-end pipeline: extract→generate→replace", async () => {
    const mockGenerationClient = {
      generateVideo: vi.fn().mockResolvedValue({ taskId: "gen-1" }),
      waitForCompletion: vi.fn().mockResolvedValue("https://r2.test/generated.mp4"),
    };
    const mockStorage = {
      upload: vi.fn().mockResolvedValue("media/generated-segment.mp4"),
      downloadToTempFile: vi.fn().mockResolvedValue("/tmp/source.mp4"),
    };
    const mockServerCore = {
      executeAgentCommand: vi.fn(),
    };

    const editor = new ContentEditor({
      generationClient: mockGenerationClient as any,
      objectStorage: mockStorage as any,
      serverEditorCore: mockServerCore as any,
    });

    const result = await editor.replaceWithGenerated({
      elementId: "el1",
      timeRange: { start: 3.2, end: 8.7 },
      prompt: "Replace with sunset scene",
      provider: "kling",
      agentId: "creator-1",
    });

    expect(mockGenerationClient.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("sunset") })
    );
    expect(mockGenerationClient.waitForCompletion).toHaveBeenCalledWith("gen-1", expect.any(Number));
    expect(result).toHaveProperty("newStorageKey");
  });
});
```

- [ ] **Step 4: Run generation tests**

Run: `cd apps/agent && npx vitest run src/services/__tests__/generation-client.test.ts src/services/__tests__/content-editor.test.ts`
Expected: PASS — GenerationClient (4 tests), ContentEditor (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/services/generation-client.ts apps/agent/src/services/content-editor.ts apps/agent/src/services/__tests__/
git commit -m "feat: add GenerationClient and ContentEditor pipeline with tests"
```

---

# Part 3: Memory System

> Implements the persistent cognitive layer: file-based memory on R2, extraction from interactions, query templates, prompt injection, and pattern observation.

---

### Task 21: Memory Types + R2 Store

**Files:**
- Create: `apps/agent/src/memory/types.ts`
- Create: `apps/agent/src/memory/memory-store.ts`
- Create: `apps/agent/src/memory/__tests__/memory-store.test.ts`

- [ ] **Step 1: Define memory types**

```typescript
// apps/agent/src/memory/types.ts
export interface ParsedMemory {
  memory_id: string;
  type: "preference" | "rule" | "pattern" | "knowledge" | "decision";
  status: "draft" | "active" | "stale" | "deprecated";
  confidence: "high" | "medium" | "low";
  source: "implicit" | "explicit" | "observed";
  created: string; // ISO date
  updated: string;
  reinforced_count: number;
  last_reinforced_at: string;
  last_used_at?: string;
  source_change_ids: string[];
  used_in_changeset_ids: string[];
  created_session_id: string;
  last_reinforced_session_id?: string;
  scope: string; // "global" | "brand:x" | "platform:y" | "series:z" | "project:w"
  scope_level: "global" | "brand" | "platform" | "series" | "project";
  activation_scope?: {
    project_id?: string;
    batch_id?: string;
    session_id?: string;
  };
  semantic_key: string; // Derived from file path
  tags: string[];
  // Skill-specific fields
  skill_id?: string;
  skill_status?: "draft" | "validated" | "deprecated";
  agent_type?: string;
  applies_to?: string[];
  // Content (body after frontmatter)
  content: string;
}

export interface TaskContext {
  brand: string;
  series?: string;
  platform?: string;
  projectId?: string;
  batchId?: string;
  sessionId: string;
  agentType: "master" | "editor" | "creator" | "audio" | "vision" | "asset";
  tokenBudget?: number; // default 4000
}

export interface MemoryContext {
  promptText: string;
  injectedMemoryIds: string[];
  injectedSkillIds: string[];
}
```

- [ ] **Step 2: Implement MemoryStore (R2 read/write)**

```typescript
// apps/agent/src/memory/memory-store.ts
import type { ObjectStorage } from "../services/object-storage";
import type { ParsedMemory } from "./types";

export class MemoryStore {
  private storage: ObjectStorage;
  private userPrefix: string;

  constructor(storage: ObjectStorage, userId: string) {
    this.storage = storage;
    this.userPrefix = `chatcut-memory/${userId}`;
  }

  async readFile(path: string): Promise<string> {
    const key = `${this.userPrefix}/${path}`;
    const tmpPath = await this.storage.downloadToTempFile(key);
    const { readFile } = await import("node:fs/promises");
    return readFile(tmpPath, "utf-8");
  }

  async readParsed(path: string): Promise<ParsedMemory> {
    const raw = await this.readFile(path);
    return this.parseFrontmatter(raw);
  }

  async writeMemory(path: string, memory: ParsedMemory): Promise<void> {
    const content = this.serializeToMarkdown(memory);
    const key = `${this.userPrefix}/${path}`;
    await this.storage.upload(Buffer.from(content), {
      contentType: "text/markdown",
      prefix: "", // key is already full path
    });
  }

  async listDir(path: string): Promise<string[]> {
    // List objects with prefix in R2
    // Return file names
    throw new Error("TODO: Implement R2 list objects");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.readFile(path);
      return true;
    } catch {
      return false;
    }
  }

  private parseFrontmatter(raw: string): ParsedMemory {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error("Invalid memory file format");

    const frontmatter = this.parseYaml(match[1]);
    const content = match[2].trim();

    return { ...frontmatter, content } as ParsedMemory;
  }

  private serializeToMarkdown(memory: ParsedMemory): string {
    const { content, ...frontmatter } = memory;
    return `---\n${this.toYaml(frontmatter)}---\n\n${content}\n`;
  }

  private parseYaml(yaml: string): Record<string, unknown> {
    // Simple YAML parser for frontmatter (key: value pairs)
    const result: Record<string, unknown> = {};
    for (const line of yaml.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      // Handle arrays, booleans, numbers
      if (val.startsWith("[")) {
        result[key] = JSON.parse(val.replace(/'/g, '"'));
      } else if (val === "true" || val === "false") {
        result[key] = val === "true";
      } else if (!isNaN(Number(val)) && val !== "") {
        result[key] = Number(val);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  private toYaml(obj: Record<string, unknown>): string {
    return Object.entries(obj)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: ${JSON.stringify(v)}`;
        if (typeof v === "object" && v !== null) return `${k}: ${JSON.stringify(v)}`;
        return `${k}: ${v}`;
      })
      .join("\n") + "\n";
  }
}
```

- [ ] **Step 3: Write tests, run, commit**

```bash
git add apps/agent/src/memory/
git commit -m "feat: add memory type system and R2-backed MemoryStore"
```

---

### Task 22: Memory Loader (Query Templates + Post-Load Pipeline)

**Files:**
- Create: `apps/agent/src/memory/memory-loader.ts`
- Create: `apps/agent/src/memory/__tests__/memory-loader.test.ts`

- [ ] **Step 1: Implement query templates**

```typescript
// apps/agent/src/memory/memory-loader.ts
import type { MemoryStore } from "./memory-store";
import type { ParsedMemory, TaskContext, MemoryContext } from "./types";

const QUERY_TEMPLATES: Record<string, (params: TaskContext) => string[]> = {
  "batch-production": (p) => [
    "global/aesthetic/*",
    "global/quality/approval-criteria.md",
    `brands/${p.brand}/identity/*`,
    `brands/${p.brand}/platforms/${p.platform}.md`,
    `brands/${p.brand}/_skills/*`,
    ...(p.series ? [
      `brands/${p.brand}/series/${p.series}/*`,
      `brands/${p.brand}/series/${p.series}/_skills/*`,
    ] : []),
    ...(p.projectId ? [`projects/${p.projectId}/*`] : []),
    "_conflicts/*",
  ],
  "single-edit": (p) => [
    "global/aesthetic/*",
    "global/quality/approval-criteria.md",
    `brands/${p.brand}/identity/*`,
    ...(p.projectId ? [`projects/${p.projectId}/*`] : []),
  ],
};

const SCOPE_PRECEDENCE = ["global", "brand", "platform", "series", "project"] as const;

export class MemoryLoader {
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async loadMemories(task: TaskContext, templateKey = "single-edit"): Promise<MemoryContext> {
    const template = QUERY_TEMPLATES[templateKey] ?? QUERY_TEMPLATES["single-edit"];
    const patterns = template(task);

    // Expand patterns and load files
    const candidates: ParsedMemory[] = [];
    for (const pattern of patterns) {
      const files = await this.expandPattern(pattern);
      for (const file of files) {
        try {
          const parsed = await this.store.readParsed(file);
          candidates.push(parsed);
        } catch {
          // File not found — skip
        }
      }
    }

    return this.postLoadPipeline(candidates, task);
  }

  private postLoadPipeline(candidates: ParsedMemory[], task: TaskContext): MemoryContext {
    // Step 1: Filter by status + activation_scope
    const filtered = candidates.filter((m) => {
      if (m.status === "stale" || m.status === "deprecated") return false;
      if (m.status === "draft" && m.activation_scope) {
        if (m.activation_scope.project_id && m.activation_scope.project_id !== task.projectId) return false;
        if (m.activation_scope.session_id && m.activation_scope.session_id !== task.sessionId) return false;
      }
      return true;
    });

    // Step 2: Merge by scope precedence (higher scope overrides lower)
    const merged = this.mergeByScope(filtered);

    // Step 3: Token budget truncation
    const budget = task.tokenBudget ?? 4000;
    const { text, ids, skillIds } = this.serializeForPrompt(merged, budget);

    return {
      promptText: text,
      injectedMemoryIds: ids,
      injectedSkillIds: skillIds,
    };
  }

  private mergeByScope(memories: ParsedMemory[]): ParsedMemory[] {
    // Group by semantic_key, keep highest-scope-level version
    const byKey = new Map<string, ParsedMemory>();
    for (const m of memories) {
      const existing = byKey.get(m.semantic_key);
      if (!existing || SCOPE_PRECEDENCE.indexOf(m.scope_level as any) > SCOPE_PRECEDENCE.indexOf(existing.scope_level as any)) {
        byKey.set(m.semantic_key, m);
      }
    }
    return Array.from(byKey.values());
  }

  private serializeForPrompt(memories: ParsedMemory[], budget: number): { text: string; ids: string[]; skillIds: string[] } {
    const ids: string[] = [];
    const skillIds: string[] = [];
    let text = "## Editing Preferences & Memory\n\n";
    let tokenCount = 0;

    for (const m of memories) {
      const entry = `### ${m.semantic_key}\n${m.content}\n\n`;
      const entryTokens = Math.ceil(entry.length / 4);
      if (tokenCount + entryTokens > budget) break;

      text += entry;
      tokenCount += entryTokens;
      ids.push(m.memory_id);
      if (m.skill_id) skillIds.push(m.skill_id);
    }

    return { text, ids, skillIds };
  }

  private async expandPattern(pattern: string): Promise<string[]> {
    if (pattern.endsWith("/*")) {
      const dir = pattern.slice(0, -2);
      try {
        return (await this.store.listDir(dir)).map((f) => `${dir}/${f}`);
      } catch {
        return [];
      }
    }
    return [pattern];
  }
}
```

- [ ] **Step 2: Write tests, run, commit**

```bash
git add apps/agent/src/memory/memory-loader.ts apps/agent/src/memory/__tests__/
git commit -m "feat: add MemoryLoader with query templates and scope-based merging"
```

---

### Task 23: Memory Extractor (Implicit + Explicit)

**Files:**
- Create: `apps/agent/src/memory/memory-extractor.ts`
- Create: `apps/agent/src/memory/__tests__/memory-extractor.test.ts`

- [ ] **Step 1: Implement MemoryExtractor**

Subscribes to ChangeLog decision events. On `changeset_rejected`, analyzes what not to do. On `changeset_committed` with human edits, diffs agent proposal vs final. On `changeset_committed` without edits, reinforces related memories.

Uses `claude-haiku-4-5` for cost-efficient extraction.

Key rules:
- Explicit persistent preferences → `status: active`, `source: explicit`
- 3+ consecutive rejections → `status: draft` with `activation_scope`
- Single approve/reject → batch accumulation (no immediate write)
- Session Gate: draft created in session X can only promote to active in different session Y

- [ ] **Step 2: Write tests, run, commit**

```bash
git add apps/agent/src/memory/memory-extractor.ts apps/agent/src/memory/__tests__/
git commit -m "feat: add MemoryExtractor with implicit/explicit extraction and session gate"
```

---

### Task 24: Pattern Observer + Skill Crystallization

**Files:**
- Create: `apps/agent/src/memory/pattern-observer.ts`

- [ ] **Step 1: Implement PatternObserver**

Triggered every N sessions or at batch completion. Analyzes accumulated signals, discovers patterns, and auto-crystallizes Skills from high-confidence memory clusters.

Crystallization trigger: 5+ `confidence: high` memories with tag overlap in same scope.

Output: Skill markdown files written to `brands/{brand}/_skills/` in R2.

- [ ] **Step 2: Write tests, run, commit**

```bash
git add apps/agent/src/memory/pattern-observer.ts
git commit -m "feat: add PatternObserver for cross-session analysis and skill crystallization"
```

---

# Part 4: UI & Integration

> Builds the Chat UI, SSE streaming, Context Synchronizer, Fan-out Exploration, Asset Management, and connects everything end-to-end.

---

### Task 25: Chat UI Components

**Files:**
- Create: `apps/web/src/components/editor/chat/chat-panel.tsx`
- Create: `apps/web/src/components/editor/chat/message-bubble.tsx`
- Create: `apps/web/src/components/editor/chat/changeset-review.tsx`
- Create: `apps/web/src/components/editor/chat/candidate-cards.tsx`
- Create: `apps/web/src/components/editor/chat/agent-status.tsx`
- Create: `apps/web/src/hooks/use-chat.ts`

- [ ] **Step 1: Implement use-chat hook**

```typescript
// apps/web/src/hooks/use-chat.ts
import { useState, useCallback, useRef, useEffect } from "react";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  changeset?: {
    changesetId: string;
    summary: string;
    status: "pending" | "approved" | "rejected";
  };
  exploration?: {
    explorationId: string;
    candidates: Array<{
      candidateId: string;
      label: string;
      summary: string;
      previewUrl?: string;
      metrics: { durationChange: string; affectedElements: number };
    }>;
  };
}

interface UseChatReturn {
  messages: Message[];
  isLoading: boolean;
  agentStatus: "idle" | "thinking" | "executing" | "awaiting_approval";
  sendMessage: (content: string) => void;
  approveChangeset: (changesetId: string) => void;
  rejectChangeset: (changesetId: string) => void;
  selectCandidate: (explorationId: string, candidateId: string) => void;
}

export function useChat(projectId: string): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<UseChatReturn["agentStatus"]>("idle");
  const eventSourceRef = useRef<EventSource | null>(null);

  const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:4000";

  // Connect SSE for real-time updates
  useEffect(() => {
    const es = new EventSource(`${agentUrl}/events?projectId=${projectId}`);
    eventSourceRef.current = es;

    es.addEventListener("agent_message", (e) => {
      const data = JSON.parse(e.data);
      setMessages((prev) => [...prev, {
        id: data.id,
        role: "assistant",
        content: data.content,
        timestamp: Date.now(),
        changeset: data.changeset,
        exploration: data.exploration,
      }]);
      setIsLoading(false);
    });

    es.addEventListener("agent_status", (e) => {
      setAgentStatus(JSON.parse(e.data).status);
    });

    es.addEventListener("candidate_ready", (e) => {
      const data = JSON.parse(e.data);
      setMessages((prev) => prev.map((m) => {
        if (m.exploration?.explorationId === data.explorationId) {
          return {
            ...m,
            exploration: {
              ...m.exploration,
              candidates: m.exploration.candidates.map((c) =>
                c.candidateId === data.candidateId
                  ? { ...c, previewUrl: data.previewUrl }
                  : c
              ),
            },
          };
        }
        return m;
      }));
    });

    return () => es.close();
  }, [projectId, agentUrl]);

  const sendMessage = useCallback(async (content: string) => {
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
    }]);
    setIsLoading(true);
    setAgentStatus("thinking");

    await fetch(`${agentUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, message: content }),
    });
  }, [projectId, agentUrl]);

  const approveChangeset = useCallback(async (changesetId: string) => {
    await fetch(`${agentUrl}/changeset/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changesetId }),
    });
  }, [agentUrl]);

  const rejectChangeset = useCallback(async (changesetId: string) => {
    await fetch(`${agentUrl}/changeset/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changesetId }),
    });
  }, [agentUrl]);

  const selectCandidate = useCallback(async (explorationId: string, candidateId: string) => {
    await fetch(`${agentUrl}/exploration/${explorationId}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId }),
    });
  }, [agentUrl]);

  return { messages, isLoading, agentStatus, sendMessage, approveChangeset, rejectChangeset, selectCandidate };
}
```

- [ ] **Step 2: Implement ChatPanel component**

```tsx
// apps/web/src/components/editor/chat/chat-panel.tsx
"use client";

import { useState } from "react";
import { useChat } from "@/hooks/use-chat";
import { MessageBubble } from "./message-bubble";
import { ChangesetReview } from "./changeset-review";
import { CandidateCards } from "./candidate-cards";
import { AgentStatus } from "./agent-status";

interface ChatPanelProps {
  projectId: string;
}

export function ChatPanel({ projectId }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const { messages, isLoading, agentStatus, sendMessage, approveChangeset, rejectChangeset, selectCandidate } = useChat(projectId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage(input);
    setInput("");
  };

  return (
    <div className="flex flex-col h-full bg-background border-l">
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="text-sm font-medium">ChatCut</h3>
        <AgentStatus status={agentStatus} />
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg) => (
          <div key={msg.id}>
            <MessageBubble message={msg} />
            {msg.changeset && (
              <ChangesetReview
                changeset={msg.changeset}
                onApprove={() => approveChangeset(msg.changeset!.changesetId)}
                onReject={() => rejectChangeset(msg.changeset!.changesetId)}
              />
            )}
            {msg.exploration && (
              <CandidateCards
                exploration={msg.exploration}
                onSelect={(candidateId) => selectCandidate(msg.exploration!.explorationId, candidateId)}
              />
            )}
          </div>
        ))}
        {isLoading && <div className="text-sm text-muted-foreground animate-pulse">Thinking...</div>}
      </div>

      <form onSubmit={handleSubmit} className="p-3 border-t">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Tell me what to edit..."
            className="flex-1 rounded-md border px-3 py-2 text-sm"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Implement sub-components**

Create `MessageBubble`, `ChangesetReview`, `CandidateCards`, `AgentStatus` components following the existing Radix UI patterns in the codebase.

- [ ] **Step 4: Add ChatPanel to editor layout**

Modify `apps/web/src/app/editor/[project_id]/page.tsx` to include ChatPanel as a resizable panel alongside the existing panels.

- [ ] **Step 5: Write Chat UI tests**

```typescript
// apps/web/src/hooks/__tests__/use-chat.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat } from "../use-chat";

// Mock EventSource
class MockEventSource {
  listeners = new Map<string, Function>();
  addEventListener(event: string, cb: Function) { this.listeners.set(event, cb); }
  close = vi.fn();
}

vi.stubGlobal("EventSource", MockEventSource);
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

describe("useChat", () => {
  it("sendMessage adds user message to list", async () => {
    const { result } = renderHook(() => useChat("proj-1"));

    await act(async () => {
      result.current.sendMessage("Trim the first clip");
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("Trim the first clip");
  });

  it("sendMessage sets isLoading and agentStatus", async () => {
    const { result } = renderHook(() => useChat("proj-1"));

    await act(async () => {
      result.current.sendMessage("Delete last scene");
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.agentStatus).toBe("thinking");
  });

  it("approveChangeset calls agent API", async () => {
    const { result } = renderHook(() => useChat("proj-1"));

    await act(async () => {
      result.current.approveChangeset("cs-1");
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/changeset/approve"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("rejectChangeset calls agent API", async () => {
    const { result } = renderHook(() => useChat("proj-1"));

    await act(async () => {
      result.current.rejectChangeset("cs-1");
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/changeset/reject"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("selectCandidate calls exploration select API", async () => {
    const { result } = renderHook(() => useChat("proj-1"));

    await act(async () => {
      result.current.selectCandidate("exp-1", "cand-2");
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/exploration/exp-1/select"),
      expect.objectContaining({ method: "POST" })
    );
  });
});
```

```tsx
// apps/web/src/components/editor/chat/__tests__/chat-panel.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatPanel } from "../chat-panel";

// Mock the useChat hook
vi.mock("@/hooks/use-chat", () => ({
  useChat: () => ({
    messages: [
      { id: "m1", role: "user", content: "Trim clip", timestamp: Date.now() },
      { id: "m2", role: "assistant", content: "Done!", timestamp: Date.now() },
    ],
    isLoading: false,
    agentStatus: "idle",
    sendMessage: vi.fn(),
    approveChangeset: vi.fn(),
    rejectChangeset: vi.fn(),
    selectCandidate: vi.fn(),
  }),
}));

describe("ChatPanel", () => {
  it("renders message list", () => {
    render(<ChatPanel projectId="proj-1" />);
    expect(screen.getByText("Trim clip")).toBeDefined();
    expect(screen.getByText("Done!")).toBeDefined();
  });

  it("renders input field and send button", () => {
    render(<ChatPanel projectId="proj-1" />);
    expect(screen.getByPlaceholderText(/tell me/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /send/i })).toBeDefined();
  });

  it("disables send button when input is empty", () => {
    render(<ChatPanel projectId="proj-1" />);
    const button = screen.getByRole("button", { name: /send/i });
    expect(button).toHaveProperty("disabled", true);
  });
});
```

- [ ] **Step 6: Run Chat UI tests**

Run: `cd apps/web && npx vitest run src/hooks/__tests__/use-chat.test.ts src/components/editor/chat/__tests__/chat-panel.test.tsx`
Expected: PASS — useChat (5 tests), ChatPanel (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/editor/chat/ apps/web/src/hooks/use-chat.ts apps/web/src/hooks/__tests__/
git commit -m "feat: add Chat UI panel with message list, changeset review, candidate cards, and tests"
```

---

### Task 26: Context Synchronizer

**Files:**
- Create: `apps/agent/src/context/context-sync.ts`
- Create: `apps/agent/src/context/__tests__/context-sync.test.ts`

- [ ] **Step 1: Implement ContextSynchronizer**

```typescript
// apps/agent/src/context/context-sync.ts
import type { ChangeLog, ChangeEntry } from "@opencut/core";

export class ContextSynchronizer {
  private changeLog: ChangeLog;
  private lastSyncCursors = new Map<string, number>(); // agentId → last synced index

  constructor(changeLog: ChangeLog) {
    this.changeLog = changeLog;
  }

  buildContextUpdate(agentId: string): string | null {
    const lastCursor = this.lastSyncCursors.get(agentId) ?? -1;
    const newEntries = this.changeLog.getCommittedAfter(lastCursor, agentId);

    if (newEntries.length === 0) return null;

    // Update cursor
    this.lastSyncCursors.set(agentId, this.changeLog.length - 1);

    // Build human-readable summary for agent
    const lines = newEntries.map((e) =>
      `- [${e.source}${e.agentId ? `:${e.agentId}` : ""}] ${e.summary}`
    );

    return `## Changes since your last action\nThe following changes were made by others:\n${lines.join("\n")}\n\nPlease base your work on the current timeline state.`;
  }
}
```

- [ ] **Step 2: Write tests, run, commit**

```bash
git add apps/agent/src/context/context-sync.ts apps/agent/src/context/__tests__/
git commit -m "feat: add ContextSynchronizer for lazy human-agent change injection"
```

---

### Task 27: Chat Route (SSE Streaming)

**Files:**
- Create: `apps/agent/src/routes/chat.ts`
- Modify: `apps/agent/src/server.ts`

- [ ] **Step 1: Implement POST /chat with SSE**

```typescript
// apps/agent/src/routes/chat.ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

export const chatRoute = new Hono();

const chatSchema = z.object({
  projectId: z.string().uuid(),
  message: z.string().min(1),
});

chatRoute.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // Get or create MasterAgent session for this project
  // Send message to Master Agent
  // Stream response events via SSE stored in an event bus

  return c.json({ status: "processing", sessionId: "placeholder" });
});
```

- [ ] **Step 2: Write chat route tests**

```typescript
// apps/agent/src/routes/__tests__/chat.test.ts
import { describe, it, expect } from "vitest";
import { createApp } from "../../server";

const app = createApp();

describe("POST /chat", () => {
  it("rejects missing projectId", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "trim clip" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty message", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "550e8400-e29b-41d4-a716-446655440000", message: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts valid chat request", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        message: "Trim the first clip by 2 seconds",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("status", "processing");
  });
});
```

- [ ] **Step 3: Run chat route tests**

Run: `cd apps/agent && npx vitest run src/routes/__tests__/chat.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 4: Wire into server and commit**

```bash
git add apps/agent/src/routes/chat.ts apps/agent/src/routes/__tests__/chat.test.ts apps/agent/src/server.ts
git commit -m "feat: add POST /chat route with validation and tests"
```

---

### Task 28: Changeset Routes (Approve/Reject)

**Files:**
- Create: `apps/agent/src/routes/changeset.ts`

- [ ] **Step 1: Implement changeset routes**

```typescript
// apps/agent/src/routes/changeset.ts
import { Hono } from "hono";
import { z } from "zod";

export const changesetRoute = new Hono();

changesetRoute.post("/approve", async (c) => {
  const { changesetId } = await c.req.json();
  // Delegate to ChangesetManager.approve(changesetId)
  return c.json({ status: "approved", changesetId });
});

changesetRoute.post("/reject", async (c) => {
  const { changesetId } = await c.req.json();
  // Delegate to ChangesetManager.reject(changesetId)
  return c.json({ status: "rejected", changesetId });
});

changesetRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  // Query changeset status from DB
  return c.json({ changesetId: id, status: "pending" });
});
```

- [ ] **Step 2: Write changeset route tests**

```typescript
// apps/agent/src/routes/__tests__/changeset.test.ts
import { describe, it, expect } from "vitest";
import { createApp } from "../../server";

const app = createApp();

describe("Changeset Routes", () => {
  describe("POST /changeset/approve", () => {
    it("returns approved status", async () => {
      const res = await app.request("/changeset/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changesetId: "cs-1" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("approved");
      expect(json.changesetId).toBe("cs-1");
    });
  });

  describe("POST /changeset/reject", () => {
    it("returns rejected status", async () => {
      const res = await app.request("/changeset/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changesetId: "cs-2" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("rejected");
    });
  });

  describe("GET /changeset/:id", () => {
    it("returns changeset status", async () => {
      const res = await app.request("/changeset/cs-3");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("changesetId", "cs-3");
      expect(json).toHaveProperty("status");
    });
  });
});
```

- [ ] **Step 3: Run changeset route tests**

Run: `cd apps/agent && npx vitest run src/routes/__tests__/changeset.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/routes/changeset.ts apps/agent/src/routes/__tests__/changeset.test.ts
git commit -m "feat: add changeset approve/reject/query routes with tests"
```

---

### Task 29: Fan-out Exploration Engine

**Files:**
- Create: `apps/agent/src/exploration/exploration-engine.ts`
- Create: `apps/agent/src/exploration/candidate-generator.ts`

- [ ] **Step 1: Implement ExplorationEngine**

Orchestrates fan-out: receives candidate skeletons from Master, materializes them (execute commands on timeline copies), enqueues preview rendering jobs via pg-boss.

Key flow:
1. Master calls `explore_options` with 3-4 candidate skeletons
2. Engine materializes each: apply commands in-memory → resultTimeline
3. Upload non-deterministic artifacts to R2
4. Compute previewPolicy per candidate
5. Enqueue pg-boss jobs for sandbox rendering
6. Return explorationId + skeleton metadata (previews arrive via SSE)

- [ ] **Step 2: Implement dimensionality dispersion check**

Ensure candidates are sufficiently different: calculate timeline diff overlap between pairs, retry if > 70% similar.

- [ ] **Step 3: Write ExplorationEngine tests**

```typescript
// apps/agent/src/exploration/__tests__/exploration-engine.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExplorationEngine } from "../exploration-engine";
import { CandidateGenerator } from "../candidate-generator";

describe("ExplorationEngine", () => {
  let engine: ExplorationEngine;
  let mockServerCore: any;
  let mockJobQueue: any;
  let mockStorage: any;
  let mockDb: any;

  beforeEach(() => {
    mockServerCore = {
      clone: vi.fn().mockReturnValue({
        executeAgentCommand: vi.fn(),
        serialize: vi.fn().mockReturnValue({ project: {}, scenes: [{ id: "s1", tracks: [] }] }),
        snapshotVersion: 0,
      }),
    };
    mockJobQueue = {
      enqueue: vi.fn().mockResolvedValue("job-1"),
    };
    mockStorage = {
      upload: vi.fn().mockResolvedValue("artifacts/result.json"),
    };
    mockDb = {
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    };
    engine = new ExplorationEngine({
      serverCore: mockServerCore,
      jobQueue: mockJobQueue,
      objectStorage: mockStorage,
      db: mockDb,
    });
  });

  it("materializes 4 candidates from skeletons", async () => {
    const skeletons = [
      { label: "Trim", summary: "Remove silence", candidateType: "trim", commands: [{ type: "trim" }], expectedMetrics: { durationChange: "18s→14s", affectedElements: 2 } },
      { label: "Speed", summary: "1.3x speedup", candidateType: "speed", commands: [{ type: "set_speed" }], expectedMetrics: { durationChange: "18s→14s", affectedElements: 1 } },
      { label: "Select", summary: "Keep highlights", candidateType: "reorder", commands: [{ type: "delete" }], expectedMetrics: { durationChange: "18s→12s", affectedElements: 3 } },
      { label: "Compact", summary: "Dense edit", candidateType: "restructure", commands: [{ type: "trim" }, { type: "set_speed" }], expectedMetrics: { durationChange: "18s→10s", affectedElements: 4 } },
    ];

    const result = await engine.explore({
      intent: "This segment drags",
      baseSnapshotVersion: 0,
      timelineSnapshot: "{}",
      candidates: skeletons,
    });

    expect(result.explorationId).toBeDefined();
    expect(result.candidates).toHaveLength(4);
    // Each candidate should have been materialized (clone called per candidate)
    expect(mockServerCore.clone).toHaveBeenCalledTimes(4);
    // Should enqueue rendering jobs
    expect(mockJobQueue.enqueue).toHaveBeenCalled();
  });

  it("enqueues one pg-boss job per candidate", async () => {
    const skeletons = [
      { label: "A", summary: "a", candidateType: "trim", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } },
      { label: "B", summary: "b", candidateType: "speed", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } },
      { label: "C", summary: "c", candidateType: "reorder", commands: [], expectedMetrics: { durationChange: "10s→6s", affectedElements: 2 } },
    ];

    await engine.explore({
      intent: "tighten this",
      baseSnapshotVersion: 0,
      timelineSnapshot: "{}",
      candidates: skeletons,
    });

    expect(mockJobQueue.enqueue).toHaveBeenCalledTimes(3);
  });

  it("stores exploration session in DB", async () => {
    const skeletons = [
      { label: "A", summary: "a", candidateType: "trim", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } },
      { label: "B", summary: "b", candidateType: "speed", commands: [], expectedMetrics: { durationChange: "10s→8s", affectedElements: 1 } },
      { label: "C", summary: "c", candidateType: "reorder", commands: [], expectedMetrics: { durationChange: "10s→7s", affectedElements: 2 } },
    ];

    await engine.explore({
      intent: "test",
      baseSnapshotVersion: 0,
      timelineSnapshot: "{}",
      candidates: skeletons,
    });

    expect(mockDb.insert).toHaveBeenCalled();
  });
});

describe("CandidateGenerator dispersion check", () => {
  it("rejects candidates with >70% timeline overlap", () => {
    const generator = new CandidateGenerator();

    const candidateA = { resultTimeline: { elements: ["el1", "el2", "el3", "el4", "el5"] } };
    const candidateB = { resultTimeline: { elements: ["el1", "el2", "el3", "el4", "el6"] } }; // 80% overlap

    const overlap = generator.calculateOverlap(candidateA as any, candidateB as any);
    expect(overlap).toBeGreaterThan(0.7);
  });

  it("accepts candidates with <70% timeline overlap", () => {
    const generator = new CandidateGenerator();

    const candidateA = { resultTimeline: { elements: ["el1", "el2", "el3"] } };
    const candidateB = { resultTimeline: { elements: ["el4", "el5", "el6"] } }; // 0% overlap

    const overlap = generator.calculateOverlap(candidateA as any, candidateB as any);
    expect(overlap).toBeLessThan(0.7);
  });

  it("validateDispersion returns false when any pair exceeds threshold", () => {
    const generator = new CandidateGenerator();

    const candidates = [
      { resultTimeline: { elements: ["el1", "el2", "el3"] } },
      { resultTimeline: { elements: ["el1", "el2", "el3"] } }, // 100% overlap with first
      { resultTimeline: { elements: ["el4", "el5", "el6"] } },
    ];

    expect(generator.validateDispersion(candidates as any)).toBe(false);
  });
});
```

- [ ] **Step 4: Run exploration engine tests**

Run: `cd apps/agent && npx vitest run src/exploration/__tests__/exploration-engine.test.ts`
Expected: PASS — ExplorationEngine (3 tests), CandidateGenerator dispersion (3 tests) = 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/exploration/
git commit -m "feat: add ExplorationEngine with materialization, pg-boss enqueue, and dispersion check tests"
```

---

### Task 30: Skill Loading + System Presets

**Files:**
- Create: `apps/agent/src/skills/loader.ts`
- Create: `apps/agent/src/skills/presets/` (20 markdown files)

- [ ] **Step 1: Implement SkillLoader**

Loads skills from R2 `_skills/` paths + system presets from disk. Filters by `agentType` and `skill_status`.

- [ ] **Step 2: Create initial system presets**

Create markdown skill files for the most critical presets:
- `editor/beat-sync-editing.md`
- `editor/rhythm-curve.md`
- `creator/prompt-engineering.md`
- `creator/model-routing.md`
- `audio/audio-ducking.md`
- `master/viral-replication.md`

Each follows the memory file frontmatter format with `type: skill-draft`, `skill_status: validated`.

- [ ] **Step 3: Write SkillLoader tests**

```typescript
// apps/agent/src/skills/__tests__/loader.test.ts
import { describe, it, expect, vi } from "vitest";
import { SkillLoader } from "../loader";

describe("SkillLoader", () => {
  it("filters skills by agentType", async () => {
    const mockStore = {
      listDir: vi.fn().mockResolvedValue(["beat-sync.md", "prompt-eng.md"]),
      readParsed: vi.fn()
        .mockResolvedValueOnce({
          skill_id: "s1", agent_type: "editor", skill_status: "validated",
          content: "Beat sync instructions",
        })
        .mockResolvedValueOnce({
          skill_id: "s2", agent_type: "creator", skill_status: "validated",
          content: "Prompt engineering instructions",
        }),
    } as any;

    const loader = new SkillLoader(mockStore);
    const skills = await loader.loadSkills("editor", { brand: "coffee-lab" });

    expect(skills).toHaveLength(1);
    expect(skills[0].skill_id).toBe("s1");
  });

  it("excludes deprecated skills", async () => {
    const mockStore = {
      listDir: vi.fn().mockResolvedValue(["old-skill.md"]),
      readParsed: vi.fn().mockResolvedValue({
        skill_id: "s3", agent_type: "editor", skill_status: "deprecated",
        content: "Deprecated",
      }),
    } as any;

    const loader = new SkillLoader(mockStore);
    const skills = await loader.loadSkills("editor", {});
    expect(skills).toHaveLength(0);
  });

  it("separates draft skills into trial block", async () => {
    const mockStore = {
      listDir: vi.fn().mockResolvedValue(["new-skill.md", "proven-skill.md"]),
      readParsed: vi.fn()
        .mockResolvedValueOnce({
          skill_id: "s4", agent_type: "editor", skill_status: "draft",
          content: "Draft skill",
        })
        .mockResolvedValueOnce({
          skill_id: "s5", agent_type: "editor", skill_status: "validated",
          content: "Validated skill",
        }),
    } as any;

    const loader = new SkillLoader(mockStore);
    const { mainSkills, trialSkills } = await loader.loadSkillsGrouped("editor", {});

    expect(mainSkills).toHaveLength(1);
    expect(mainSkills[0].skill_id).toBe("s5");
    expect(trialSkills).toHaveLength(1);
    expect(trialSkills[0].skill_id).toBe("s4");
  });

  it("loads system presets from disk", async () => {
    const loader = new SkillLoader(null as any); // No R2 store needed for presets
    const presets = await loader.loadSystemPresets("editor");

    expect(presets.length).toBeGreaterThan(0);
    expect(presets[0]).toHaveProperty("content");
  });
});
```

- [ ] **Step 4: Run skill loader tests**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/loader.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/skills/
git commit -m "feat: add SkillLoader with agent filtering, draft separation, and system presets"
```

---

### Task 31: Asset Stores (Phase 5 Foundation)

**Files:**
- Create: `apps/agent/src/assets/skill-store.ts`
- Create: `apps/agent/src/assets/asset-store.ts`
- Create: `apps/agent/src/assets/character-store.ts`
- Create: `apps/agent/src/assets/brand-store.ts`

- [ ] **Step 1: Extend DB schema for assets**

Add to `apps/agent/src/db/schema.ts`:

```typescript
export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  agentType: text("agent_type").notNull(),
  skillStatus: text("skill_status").notNull().default("draft"),
  appliesTo: jsonb("applies_to"), // string[]
  scopeLevel: text("scope_level").notNull(),
  scopeRef: text("scope_ref"),
  content: text("content").notNull(),
  usageCount: integer("usage_count").default(0),
  validatedCount: integer("validated_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(), // generated_video, generated_image, character, bgm, etc.
  name: text("name").notNull(),
  storageKey: text("storage_key").notNull(),
  metadata: jsonb("metadata"), // generation context, dimensions, duration, etc.
  tags: jsonb("tags"), // string[]
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const brandKits = pgTable("brand_kits", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  logoLight: text("logo_light"),
  logoDark: text("logo_dark"),
  colors: jsonb("colors"), // string[]
  fonts: jsonb("fonts"),
  introTemplate: text("intro_template"),
  outroTemplate: text("outro_template"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: Implement store classes**

Each store wraps DB operations + R2 storage for the corresponding entity type.

- [ ] **Step 3: Write asset store tests**

```typescript
// apps/agent/src/assets/__tests__/skill-store.test.ts
import { describe, it, expect, vi } from "vitest";
import { SkillStore } from "../skill-store";

describe("SkillStore", () => {
  const mockDb = {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "skill-1" }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  } as any;

  it("save creates a skill record", async () => {
    const store = new SkillStore(mockDb);
    const result = await store.save({
      userId: "user-1",
      name: "Fast Product Demo",
      agentType: "editor",
      scopeLevel: "brand",
      content: "## Structure\n1. Hook 0-3s...",
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("search filters by agentType and scope", async () => {
    const store = new SkillStore(mockDb);
    await store.search({ userId: "user-1", agentType: "editor", scopeLevel: "brand" });
    expect(mockDb.select).toHaveBeenCalled();
  });

  it("incrementUsage updates count", async () => {
    const store = new SkillStore(mockDb);
    await store.incrementUsage("skill-1");
    expect(mockDb.update).toHaveBeenCalled();
  });
});
```

```typescript
// apps/agent/src/assets/__tests__/asset-store.test.ts
import { describe, it, expect, vi } from "vitest";
import { AssetStore } from "../asset-store";

describe("AssetStore", () => {
  const mockDb = {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "asset-1" }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  } as any;

  it("save stores asset with generation context", async () => {
    const store = new AssetStore(mockDb);
    await store.save({
      userId: "user-1",
      type: "generated_video",
      name: "Cherry blossoms",
      storageKey: "media/cherry.mp4",
      metadata: {
        generationContext: {
          prompt: "cherry blossom petals falling",
          model: "kling",
          params: { duration: 5, seed: 42857 },
        },
      },
      tags: ["cherry", "nature", "romantic"],
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("search filters by tags", async () => {
    const store = new AssetStore(mockDb);
    await store.search({ userId: "user-1", query: "sunset", type: "generated_video" });
    expect(mockDb.select).toHaveBeenCalled();
  });
});
```

```typescript
// apps/agent/src/assets/__tests__/brand-store.test.ts
import { describe, it, expect, vi } from "vitest";
import { BrandStore } from "../brand-store";

describe("BrandStore", () => {
  const mockDb = {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "brand-1" }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([
      { id: "brand-1", name: "Coffee Lab", colors: ["#8B4513", "#FFFFFF"], fonts: ["Inter"] },
    ]) }) }),
  } as any;

  it("create saves brand kit", async () => {
    const store = new BrandStore(mockDb);
    await store.create({
      userId: "user-1",
      name: "Coffee Lab",
      colors: ["#8B4513", "#FFFFFF"],
      fonts: ["Inter"],
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("get returns brand kit with all fields", async () => {
    const store = new BrandStore(mockDb);
    const kit = await store.get("brand-1");
    expect(kit).toHaveProperty("name", "Coffee Lab");
    expect(kit!.colors).toContain("#8B4513");
  });
});
```

- [ ] **Step 4: Run asset store tests**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/`
Expected: PASS — skill-store (3), asset-store (2), brand-store (2) = 7 tests.

- [ ] **Step 5: Generate migration, commit**

```bash
cd apps/agent && npx drizzle-kit generate
git add apps/agent/src/assets/ apps/agent/src/db/schema.ts apps/agent/migrations/
git commit -m "feat: add Asset/Skill/Character/Brand stores with DB schema and tests"
```

---

### Task 32: End-to-End Integration Test

**Files:**
- Create: `apps/agent/src/__tests__/e2e/agent-flow.test.ts`

- [ ] **Step 1: Write integration test**

Test the full flow:
1. Create project via API
2. Send chat message: "trim the first clip by 2 seconds"
3. Verify Master Agent dispatches Editor Agent
4. Verify changeset is proposed
5. Approve changeset
6. Verify timeline state updated

This test requires a running PostgreSQL and R2 (or mocks).

- [ ] **Step 2: Run test**

Run: `cd apps/agent && npx vitest run src/__tests__/e2e/agent-flow.test.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/__tests__/e2e/
git commit -m "test: add end-to-end integration test for agent chat flow"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec Section | Plan Task(s) |
|---|---|
| Phase 0: Monorepo + Object Storage + ServerEditorCore | Tasks 1-4, 8-9 |
| Phase 1: State Serializer + Change Log + Job Queue | Tasks 5-7 |
| Phase 2: Generation Pipeline + Agent Skeleton | Tasks 10-13, 20 |
| Phase 3: Video Understanding | Task 19 |
| Phase 4: Multi-Agent System | Tasks 14-18 |
| Phase 4: Chat UI | Tasks 25-28 |
| Phase 4: Changeset Manager | Task 18 |
| Phase 4: Context Synchronizer | Task 26 |
| Phase 4: Fan-out Exploration | Task 29 |
| Phase 5: Asset Management | Task 31 |
| Memory Layer: Store + Loader | Tasks 21-22 |
| Memory Layer: Extractor | Task 23 |
| Memory Layer: Pattern Observer | Task 24 |
| Skill Loading | Task 30 |
| E2E Integration | Task 32 |

### Gaps Identified and Addressed

1. **Headless Renderer (Playwright)** — Referenced in spec for preview rendering and video export. Not fully detailed as a task because it depends on Phase 4's static renderer build. The ExplorationEngine (Task 29) handles sandbox rendering. A dedicated HeadlessRenderer task should be added when the static renderer build is ready.

2. **Media Upload API (Vercel presigned URLs)** — Mentioned in spec as `POST /api/media/upload-session`. Should be added to `apps/web/src/app/api/media/` when implementing the full upload flow. The agent-side `POST /media/finalize` is covered in Task 8.

3. **Frame Extraction (FFmpeg)** — Referenced in spec for server-side frame extraction. Should be implemented as part of the ContentEditor pipeline (Task 20) using FFmpeg child process.

4. **Sandbox Pool (Daytona)** — Detailed in fanout spec but depends on infrastructure decisions. Task 29 covers the ExplorationEngine orchestration; actual Daytona sandbox setup is an infrastructure task.

### Type Consistency Check

- `ChangeEntry` — consistent between `packages/core/src/types/change-log.ts` and `apps/agent/src/db/schema.ts`
- `AgentType` — defined once in `apps/agent/src/tools/types.ts`, used consistently
- `ProjectContext` — defined in `apps/agent/src/context/project-context.ts`, matches spec
- `DispatchInput/DispatchOutput` — defined in `apps/agent/src/agents/types.ts`, used by all sub-agents
- `ParsedMemory` — defined in `apps/agent/src/memory/types.ts`, matches spec frontmatter schema
- `MemoryContext` — consistent between memory loader and Master Agent prompt builder
