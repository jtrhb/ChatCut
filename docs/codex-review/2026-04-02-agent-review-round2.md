# Agent Codebase Review — Round 2 (2026-04-02)

**Reviewer**: Claude Opus 4.6  
**Scope**: `apps/agent/src/`, `packages/core/`, cross-referenced against `docs/chatcut-*.md` and prior `docs/codex-review/` findings  
**Method**: Read all design docs and 5 prior review documents first, then audited every source file. Ran `tsc --noEmit` and `vitest run`.

---

## Test & Type-Check Status

| Check | Result |
|-------|--------|
| `vitest run` (before fixes) | **43/44** suites, **745/745** tests |
| `vitest run` (after fixes) | **44/44** suites, **752/752** tests |
| `tsc --noEmit` (agent) | All errors from `node_modules` only (drizzle-orm, vitest, rolldown) |
| `tsc --noEmit` (core) | Clean |

---

## Findings

### Severity: BUG (broken now)

#### B1. `chat.test.ts` imports a deleted export

**File**: `src/routes/__tests__/chat.test.ts:3`  
**Status**: RESOLVED — removed dead `chat` import, test app now uses `createChatRouter` with DI

```ts
import { chat, createChatRouter } from "../chat.js";
```

`chat.ts` only exports `createChatRouter`. The standalone `chat` singleton was removed in the DI refactor (commit `07dd9eac`, W1 resolution), but the test still references it. Line 8 (`app.route("/chat", chat)`) crashes because `chat` is `undefined`.

**Impact**: 1/44 test suites broken. The 5 tests under the default `POST /chat` describe block never execute.

**Fix**: Remove the `chat` import, create the test app via `createChatRouter` with a stub SessionManager (like the DI-wired block already does on line 11-13).

---

#### B2. Double app creation causes split-brain services

**File**: `src/index.ts:38` and `src/index.ts:88`  
**Status**: RESOLVED — extracted `createServices()`, single `createApp()` call with shared services

```ts
const app = createApp({ skillContracts });           // line 38 — creates SessionManager A
// ... wires masterAgent with SessionManager A ...
const wiredApp = createApp({ skillContracts, messageHandler }); // line 88 — creates SessionManager B
serve({ fetch: wiredApp.fetch, port }, ...);          // serves app B
```

`createApp()` instantiates fresh `SessionStore`, `SessionManager`, `TaskRegistry`, `EventBus` each time it's called. The MasterAgent is wired to services from app **A**, but the HTTP server serves app **B**. When a user creates a session via the chat route (app B's SessionManager), the MasterAgent's runtime (wired to app A's SessionManager) will never see it.

**Impact**: In production, session turn tracking and event emission will silently fail — the MasterAgent operates on a phantom service graph.

**Fix**: Create services once, pass them into `createApp` as dependencies, or restructure `createApp` to accept an existing `messageHandler` without re-creating services.

---

#### B3. MasterAgent is singleton across all requests — no per-session dispatch

**File**: `src/server.ts:41-50`, `src/index.ts:69-78`  
**Status**: RESOLVED — turn tracking moved to `createMessageHandler` with per-request `sessionId`; `handleUserMessage` now returns `tokensUsed`

The `createMessageHandler` captures a single `masterAgent` instance. When the chat route calls `messageHandler(message, sessionId)`, the handler calls `masterAgent.handleUserMessage(message)` — **discarding the sessionId**. The MasterAgent's runtime was bound to a hardcoded "default" session at startup (`index.ts:66`).

**Impact**: All concurrent users share one conversation history in the NativeAPIRuntime's `messages` array. Messages from user A will appear in user B's context. This is a correctness bug, not just a scalability issue.

**Fix**: Either create a new MasterAgent per session (expensive but correct), or make `handleUserMessage` accept a sessionId and route it to the correct message history.

---

### Severity: INCOMPLETE WIRING (compiles but doesn't work at runtime)

#### W1. Sub-agent tool executor is a permanent stub

**File**: `src/index.ts:42-44`  
**Status**: OPEN

```ts
const toolExecutor = async (name: string, input: unknown) => {
  return { error: `Tool ${name} not yet wired to a real executor` };
};
```

All 6 sub-agents receive this stub. When any sub-agent calls a tool (e.g., EditorAgent calls `trim_clip`), it will always receive `{ error: "Tool trim_clip not yet wired..." }`. The sub-agents have correct tool definitions and pipeline wiring — only the final executor is dead.

**Impact**: The entire sub-agent tree is functional in structure but inert in execution. Every dispatch will produce an LLM response that's frustrated by consistent tool failures.

---

#### W2. Static routes use no-DI stubs in production app

**File**: `src/server.ts:117-119`  
**Status**: RESOLVED — routes now use DI factories (`createCommandsRouter`, `createProjectRouter`, `createMediaRouter`) with `InfrastructureDeps`

```ts
app.route("/commands", commands);   // always returns { success: true, snapshotVersion: 1 }
app.route("/project", project);     // always returns { snapshotVersion: 0, timeline: null }
app.route("/media", media);         // always returns { mediaId: "placeholder" }
```

These routes import the default no-deps singletons. The DI factories (`createCommandsRouter`, `createProjectRouter`, `createMediaRouter`) exist but aren't used by `createApp`. The hardcoded responses make these routes useless in production.

**Contrast**: `chat`, `events`, `status` routes are properly DI-wired.

---

#### W3. ExplorationEngine DB call is a bare stub

**File**: `src/exploration/exploration-engine.ts:176-185`  
**Status**: RESOLVED — typed `ExplorationDB` interface, `.insert(explorationSessions)` with correct table reference and column names

```ts
await this.db
  .insert()
  .values({ explorationId, intent, ... });
```

`.insert()` with no table argument is not valid Drizzle ORM. Real Drizzle requires `this.db.insert(explorations).values({...})`. The `db: any` type hides this at compile time. At runtime this would throw.

**Note**: ExplorationEngine isn't instantiated in `index.ts` (it's an optional dep of MasterAgent), so this doesn't crash the app today. But it will when wired.

---

#### W4. Memory system fully disconnected from MasterAgent prompt

**Files**: `src/memory/*.ts`, `src/agents/master-agent.ts:197-238`  
**Status**: OPEN

`MemoryLoader`, `MemoryExtractor`, `MemorySelector`, and `PatternObserver` are all implemented and tested — but none are instantiated in `index.ts` or wired into `MasterAgent.buildSystemPrompt()`. The `ProjectContext.memoryContext` field exists (with `promptText`, `injectedMemoryIds`, `injectedSkillIds`) but is always empty at runtime.

The MasterAgent builds its prompt using only:
- `delegationContractSection` (static)
- `activeSkills` section (from SkillLoader)
- `agentIdentity` (hardcoded text)

No memory injection occurs. The entire Memory Layer infrastructure is built and tested, but the wiring point into the prompt builder is missing.

**Note**: This is partially a design-phase boundary (R2 backend not yet connected), but the wiring gap exists even at the code level — there's no TODO or conditional integration point.

---

### Severity: CODE QUALITY

#### Q1. Sub-agent classes are 95% copy-paste

**Files**: `src/agents/editor-agent.ts`, `creator-agent.ts`, `audio-agent.ts`, `vision-agent.ts`, `asset-agent.ts`  
**Status**: RESOLVED — extracted `SubAgent` base class in `sub-agent.ts`; each agent is now a thin config wrapper (~20 lines)

All 5 files share identical structure:
- Same constructor signature
- Same `dispatch()` method body (differing only in tool defs, model string, token budget)
- Same `buildSystemPrompt()` pattern (differing only in identity text)

~325 lines of near-duplicate code. A single parameterized `SubAgent` class with a config object would reduce this to ~70 lines + 5 config objects of ~15 lines each.

---

#### Q2. SkillLoader `buildSkillPaths` ignores global scope

**File**: `src/skills/loader.ts:167-178`  
**Status**: RESOLVED — added `global/_skills/` path + deduplication by `skill_id` (most specific scope wins)

```ts
private buildSkillPaths(params: { brand?: string; series?: string }): string[] {
  const paths: string[] = [];
  if (params.brand) {
    paths.push(`brands/${params.brand}/_skills/`);
    // ...
  }
  return paths;  // empty if no brand!
}
```

If `params.brand` is undefined, zero paths are returned — no skills are loaded from the store. The design doc specifies a `global/_skills/` path for scope-level `global`. The `loadSystemPresets()` method covers local presets, but R2-stored global skills would be silently ignored.

---

#### Q3. VerificationAgent has no tools

**File**: `src/agents/verification-agent.ts:33`  
**Status**: OPEN

```ts
tools: [],
```

The Verification Agent is dispatched with zero tool access. It relies entirely on LLM reasoning to produce a JSON verdict. Without tools, it can't actually inspect the timeline state, compare frames, or verify anything beyond what's in its text prompt.

The design doc doesn't mandate tools for verification, but the agent can't meaningfully verify edits without read access to the timeline or vision tools.

---

#### Q4. `accessMode` is implicit for 4 of 6 dispatch tools

**File**: `src/tools/master-tools.ts`  
**Status**: RESOLVED — all dispatch schemas now include `accessMode` with correct defaults matching `DISPATCH_ROUTES`

`DispatchVision`, `DispatchCreator`, `DispatchAudio`, `DispatchAsset` schemas don't include `accessMode` in their Zod schemas. Only `DispatchEditor` allows the LLM to specify it. The fallback in `DISPATCH_ROUTES` provides defaults, but this means:
- The LLM can't request read-only access for a Creator dispatch (always gets `read_write`)
- Write lock acquisition is based on defaults, not on the LLM's actual intent

---

### NOT Issues (Design Phase Boundaries)

These are intentionally unimplemented per the phased plan and should not be treated as bugs:

| Item | Phase | Status |
|------|-------|--------|
| Content generation pipeline (Kling/Veo/Seedance APIs) | Phase 2 | Tool definitions exist, backends not connected |
| Sandbox preview rendering (Daytona + Playwright) | Phase 4 | ExplorationEngine enqueues jobs, no worker |
| Real R2/PostgreSQL connections | Phase 0 | Schema and MemoryStore exist, not wired in index.ts |
| YAML frontmatter (vs JSON subset) | Deferred | Documented as open decision |
| bun test runner compat | Known | 4 test files still can't run on bun |

---

## Summary

| Severity | Count | Resolved | Items |
|----------|-------|----------|-------|
| **BUG** | 3 | **3/3** | B1 (broken test) ✓, B2 (split-brain services) ✓, B3 (shared-session singleton) ✓ |
| **Incomplete Wiring** | 4 | **2/4** | W1 (stub executor), W2 (non-DI routes) ✓, W3 (fake DB call) ✓, W4 (memory disconnected) |
| **Code Quality** | 4 | **3/4** | Q1 (sub-agent duplication) ✓, Q2 (missing global skill path) ✓, Q3 (toolless verifier), Q4 (implicit accessMode) ✓ |
| **Design Phase** | 5 | — | Correctly deferred per plan |

### Priority

1. **B2 + B3** — Most critical. Split-brain services and shared-session singleton make the agent silently incorrect in any multi-request scenario. These two are related and should be fixed together.
2. **B1** — Quick fix (5 min). Restores 1/44 test suite.
3. **W1** — Bottleneck for sub-agent functionality. Without a real executor, no sub-agent can do meaningful work.
4. **Q1** — Highest-value refactor. Eliminates ~250 lines of duplication.

### Relation to Prior Reviews

All 23 findings from the 4 prior review rounds (2026-04-01 through 2026-04-02) remain resolved. This review found 11 new issues that were not covered by prior reviews:
- B2 and B3 are architectural issues introduced by the wiring work in commits `646471d4` and `ef3ab52b`
- B1 is a regression from the W1 (dead route exports) fix in commit `07dd9eac`
- W1-W4 and Q1-Q4 are pre-existing conditions not previously examined at this granularity
