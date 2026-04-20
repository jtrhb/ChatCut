# Plan: Wiring Audit Remediation

Source audit: `docs/chatcut-wiring-audit.md`
Date: 2026-04-20
Scope: close all gaps in §A, §B, §C, §D of the audit.

---

## Strategy

The 30-odd findings cluster into 5 dependency-ordered phases. Phases 0, 4 and the parallelisable subset of Phase 5 can ship the day they land. Phases 1, 2, 3 are sequenced because each unblocks the next:

```
Phase 0 (UI wire fixes)      ──┐
Phase 1 (wire dormant modules) │
   needs nothing new            ├─ ship as you go
Phase 4 (onProgress completion)─┘

Phase 2 (server-authoritative core, commitMutation, per-project routing)
       ↓
Phase 3 (HeadlessRenderer + preview-render worker; Daytona decision)
       ↓
Phase 5 (parallel: Vision↔Gemini bridge, Ghost FSM, conflict markers, multimodal)
```

Each phase lists: **tasks**, **files**, **acceptance**, **risks**, **estimated days** (1d ≈ uninterrupted senior dev).

---

## Phase 0 — UI wire fixes (Tier 1 of audit) — 0.5 d

Goal: end-to-end chat actually works in the editor.

### Tasks

| # | Task | File | Change |
|---|---|---|---|
| 0.1 | Fix chat payload field name | `apps/web/src/hooks/use-chat.ts:132` | Send `message` not `content`; pass through `sessionId` from POST response on subsequent sends. |
| 0.2 | Capture sessionId from POST response | `apps/web/src/hooks/use-chat.ts:116-142` | Store in `useState<string>()`; subsequent sends include it. |
| 0.3 | Fix SSE URL to use sessionId | `apps/web/src/hooks/use-chat.ts:67` | Re-open EventSource with `?sessionId=...` once sessionId is known; gate on it. |
| 0.4 | Add `x-user-id` to changeset fetches | `apps/web/src/hooks/use-chat.ts:144-180` | Read userId from auth context (or `localStorage` placeholder during B1 migration); set header on approve/reject. |
| 0.5 | Mount ChatPanel | `apps/web/src/components/editor/*` | Find editor root layout; mount `<ChatPanel projectId={...}/>` in the right rail. Verify width, scroll, no z-index regressions. |

### Acceptance

- [ ] Send "trim 3s" → POST returns 200 → SSE delivers events for the same sessionId only
- [ ] Approve/reject return 200, not 401
- [ ] ChatPanel renders alongside timeline; can be collapsed
- [ ] Manual smoke: send → wait → see SSE message bubble appear

### Risks

- Auth wiring on web might not yet expose userId. Document the source-of-truth and pick one (Better Auth session, localStorage stub, or header injected at SSR).

---

## Phase 1 — Wire dormant Master Agent modules (Tier 2) — 2 d

Goal: every module under `apps/agent/src/{memory,context,exploration,extensions}` reachable from `index.ts main()`.

### Tasks

| # | Task | Files | Change |
|---|---|---|---|
| 1.1 | Extend `createWiredMasterAgent` signature | `apps/agent/src/server.ts:98-122` | Accept optional `memoryStore`, `memoryLoader`, `explorationEngine`, `contextSynchronizer`. Forward to `MasterAgent` ctor. |
| 1.2 | Construct `MemoryStore` at boot | `apps/agent/src/index.ts` (after R2 wiring) | Build `MemoryStore(r2, userScopePrefix)`; hand to MasterAgent. Ensure it boots even when only R2 is configured (skill router currently has its own copy — share one instance). |
| 1.3 | Construct `MemoryLoader` | `apps/agent/src/index.ts` | `new MemoryLoader({ store, templates: defaultTemplates })`; pass to MasterAgent. |
| 1.4 | Construct `MemoryExtractor` | `apps/agent/src/index.ts` | `new MemoryExtractor({ changeLog, writeMemory: masterAgent.getMemoryWriter(), llmClient })`; happens after MasterAgent (it claims the writer token). Subscribes itself to `changeLog.on("decision")` in its constructor. |
| 1.5 | Construct + schedule `PatternObserver` | `apps/agent/src/index.ts` | `new PatternObserver({ store, writeMemory, llmClient })`; call `maybeTriggerAnalysis(observer, brand, series)` from MasterAgent post-turn hook (exists already in `index.ts:32`). |
| 1.6 | Construct `ContextSynchronizer` | `apps/agent/src/index.ts` | `new ContextSynchronizer({ changeLog })`; pass to MasterAgent. |
| 1.7 | Wire `ContextSynchronizer.buildContextUpdate()` | `apps/agent/src/agents/master-agent.ts:301` (`runTurn`) | Before calling `runtime.run`, call `contextSynchronizer.buildContextUpdate("master")`; if non-null, prepend to messages as `{role:"user", content: …}`. |
| 1.8 | Construct `ExplorationEngine` | `apps/agent/src/index.ts` | `new ExplorationEngine({ serverCore, jobQueue, objectStorage, db })`; pass to MasterAgent. Engine requires JobQueue + DB + R2 — gate behind those env vars like AssetToolExecutor (1.10). |
| 1.9 | Start JobQueue | `apps/agent/src/index.ts` | `const jobQueue = new JobQueue({ connectionString: process.env.DATABASE_URL })`; `await jobQueue.start();` at boot. Gate on `DATABASE_URL`. |
| 1.10 | Register stub `preview-render` worker | `apps/agent/src/index.ts` | `jobQueue.registerWorker("preview-render", async (job) => { /* TODO Phase 3 */ })`; emit a stub `candidate_ready` event so the FE pipeline is end-to-end testable before Playwright lands. |
| 1.11 | Fix `projectId: "default"` in ExplorationEngine | `apps/agent/src/exploration/exploration-engine.ts:188` | Take `projectId` from `ExploreParams`; thread from `master-agent.ts:551` (`explore_options` handler) via `currentIdentity.projectId`. |
| 1.12 | Wire ContentEditor into Creator agent | `apps/agent/src/agents/creator-agent.ts` + `apps/agent/src/tools/creator-tools.ts` | Inject `ContentEditor` via deps; `replace_segment` tool calls `contentEditor.replaceWithGenerated(...)`. |

### Acceptance

- [ ] On a fresh boot with `DATABASE_URL` + `R2_BUCKET` + `ANTHROPIC_API_KEY`: every line in the boot log is "wired" (no "disabled" warnings except expected ones).
- [ ] Send chat that names a stored brand → MemoryLoader injects promptText; verify via `EventBus` `tool.called` payload or by inspecting the assistant's reasoning.
- [ ] Approve a changeset → `MemoryExtractor` writes a `draft` memory under the right scope (verify by reading R2 path).
- [ ] Master invokes `explore_options` → `ExplorationEngine.explore()` returns 4 candidate IDs → 4 jobs visible in pg-boss.
- [ ] Send 2 messages with a UI-side edit between them → second message's prompt contains "## You last operated…" injected by Context Sync.

### Risks

- **MemoryStore singleton**: skills router currently builds its own. De-duplicate by hoisting MemoryStore construction above both consumers.
- **MemoryExtractor LLM cost**: it triggers per `changeset_committed`. Use Haiku as spec'd (`memory-layer §4.1`) and confirm its construction site in `index.ts` passes the right model name.
- **PatternObserver triggering**: confirm where `maybeTriggerAnalysis` should be called from. `MasterAgent` doesn't have a "post-turn hook" today — easiest is to add an EventBus listener for `agent.turn_end` in `index.ts`.

---

## Phase 2 — Server-authoritative core (A.1, A.2, A.3) — 4 d

Goal: persistent multi-project state, `commitMutation` clone-then-commit, project hydration.

### Tasks

| # | Task | Files | Change |
|---|---|---|---|
| 2.1 | DB schema for projects + snapshots | `apps/agent/src/db/schema.ts` + new migration | Add `projects` table: `id, user_id, name, timeline_snapshot JSONB, snapshot_version INT, last_committed_change_id TEXT, created_at, updated_at`. |
| 2.2 | `ServerEditorCore.cloneRuntime()` | `apps/agent/src/services/server-editor-core.ts` (extend) | Deep-clone EditorCore + CommandManager history + pending boundary cursor + version. Returns a new `ServerEditorCore` instance that mutations land on. |
| 2.3 | `ServerEditorCore.replaceRuntime(clone)` | same | Atomically swap `_core`, `_version`, history. Must be synchronous (no await between assignments). |
| 2.4 | `commitMutation(command, changeEntry)` | new `apps/agent/src/services/commit-mutation.ts` | (1) clone runtime, (2) execute on clone, (3) DB tx: insert change_log + update projects {snapshot, version+1, last_committed_change_id}, (4) on tx success: replace runtime; on tx fail: clone is GC'd, live untouched. |
| 2.5 | Wire `commitMutation` into command paths | `apps/agent/src/services/server-editor-core.ts:executeHumanCommand`, `executeAgentCommand` | Replace direct `execute` with `commitMutation(...)`. |
| 2.6 | Per-project `ServerEditorCore` registry | new `apps/agent/src/services/core-registry.ts` | `Map<projectId, ServerEditorCore>` with lazy loader: on miss, fetch snapshot from DB, hydrate via `ServerEditorCore.fromSnapshot`, cache. Eviction policy: LRU with 30-min idle (mirrors SessionStore). |
| 2.7 | Replace singleton boot | `apps/agent/src/index.ts:75-87` | Remove the bootstrap empty-timeline core. All consumers (commands route, ChangesetManager, ExplorationEngine, Master tool exec) take `coreRegistry.get(projectId)` instead. |
| 2.8 | `GET /project/:id` hydration | `apps/agent/src/routes/project.ts` | Return `coreRegistry.get(projectId).serialize()`. |
| 2.9 | Commands route wiring | `apps/agent/src/routes/commands.ts:11` | `coreRegistry.get(req.body.projectId)` instead of injected core. |

### Acceptance

- [ ] Boot agent, restart it → project state preserved (snapshot table inspection).
- [ ] Two parallel projects don't bleed state (test by alternating commands across two project IDs).
- [ ] DB tx failure (simulate by killing DB mid-commit) → in-memory state unchanged on next read.
- [ ] `snapshotVersion` strictly monotonic per project; ChangesetManager `requireDecidable` continues to detect stale state.
- [ ] All existing tests in `services/__tests__/server-editor-core.test.ts` still pass after refactor.

### Risks

- **Test fixture explosion**: many existing tests instantiate ServerEditorCore directly. Either keep `fromSnapshot` factory unchanged (recommended) and add `commitMutation` as additive, or update all test fixtures.
- **History persistence**: spec §3.3.2 says "Undo/redo is session-scoped" and history is rebuilt-from-snapshot at boot. Confirm — do not try to persist CommandManager history.
- **Single-instance execution model**: spec §3.3.2 explicitly limits MVP to one Agent service instance. Document the `core-registry` does not scale across processes; `ProjectWriteLock` is in-memory.

---

## Phase 3 — Preview rendering pipeline (C: HeadlessRenderer + Daytona decision) — 3 d (or formally defer)

Goal: `preview-render` worker actually produces playable previews.

### Tasks

| # | Task | Files | Change |
|---|---|---|---|
| 3.1 | Add Playwright dependency | `apps/agent/package.json` | `playwright`, install `chromium` via `npx playwright install --with-deps chromium`. |
| 3.2 | `HeadlessRenderer` service | new `apps/agent/src/services/headless-renderer.ts` | Per spec `plan §7.9`: browser pool, `renderFrame(project, time): Promise<Blob>`, `exportVideo(project, opts): Promise<{storageKey}>`. Uses temp file + uploadToR2; never holds full ArrayBuffer in memory. |
| 3.3 | Renderer-friendly static build | `apps/web` build pipeline | Phase 4 deliverable per spec — produce a static HTML/JS bundle of the renderer that Playwright can load via `file://`. May require pulling renderer module out of Next.js. |
| 3.4 | Replace preview-render worker stub | `apps/agent/src/index.ts:1.10` | Worker now: download media via `objectStorage.downloadToTempFile`, call `headlessRenderer.exportVideo` for the candidate's `resultTimeline`, upload preview to R2, emit SSE `candidate_ready`. |
| 3.5 | Preview URL endpoint | new `apps/agent/src/routes/exploration.ts` (or extend `routes/project.ts`) | `GET /api/exploration/:id/preview/:candidateId` mints signed URL from R2 storageKey. |
| 3.6 | Daytona sandbox pool — **decide** | doc decision | Choose: (a) implement `SandboxPoolManager` per `fanout §5.2-5.4`, or (b) defer and run all preview renders in-process on Agent service (single-instance bottleneck, but simpler). Recommendation: defer to post-MVP; add issue link. |

### Acceptance

- [ ] User selects fan-out → 4 candidates render in <30s on dev machine
- [ ] Each card has playable 5-10s MP4
- [ ] R2 cleanup task removes `previews/{explorationId}/` after 24h
- [ ] Decision documented for §3.6

### Risks

- **Renderer build extraction** is the highest-risk single task — Next.js coupling may be deep. Spike this first (1 day timebox); if blocked, formally defer fan-out preview rendering and keep the rest of fan-out (text-only candidates) shipping.
- **Memory**: each Chromium ≈ 250-500 MB. In-process pool of 4 is the spec's expected baseline.

---

## Phase 4 — Tool-evolution closure (§D.§6 onProgress) — 0.5 d

Goal: pass the spec's acceptance test #3 ("EventBus receives `tool.progress` event").

### Tasks

| # | Task | Files | Change |
|---|---|---|---|
| 4.1 | Verify Pipeline emits `tool.progress` on EventBus | `apps/agent/src/tools/tool-pipeline.ts` (already partially wired) | Confirm the `wrappedProgress` block from `tool-evolution §6` exists; add if missing. |
| 4.2 | First emitter: `analyze_video` | `apps/agent/src/services/vision-client.ts` (or vision tool wrapper) | Long Gemini call → emit `onProgress({step, totalSteps, text})` at: upload start, upload done, generation start, parse done. |
| 4.3 | Second emitter: `generate_video` | `apps/agent/src/services/generation-client.ts:waitForCompletion` | Already polls — emit `onProgress` per poll cycle with `{progress%}`. |
| 4.4 | Web client `tool.progress` handler | `apps/web/src/hooks/use-chat.ts:71` (SSE message switch) | Recognise event, surface as inline message bubble or progress dot. |

### Acceptance

- [ ] `analyze_video` test asserts at least 2 `tool.progress` events emitted for one call
- [ ] Tool-evolution Section 6 acceptance test #3 passes

### Risks

- None significant.

---

## Phase 5 — Remaining §C items (parallelisable) — 1-3 d each, independent

Each task in this phase is independent and can be picked up by separate developers.

### 5a. Vision Agent ↔ Gemini end-to-end — 1 d

| # | Task | Files |
|---|---|---|
| 5a.1 | Audit `vision-client.ts` for actual Gemini SDK call | `apps/agent/src/services/vision-client.ts` |
| 5a.2 | Wire `analyze_video` tool to call client | `apps/agent/src/tools/vision-tools.ts` |
| 5a.3 | Verify `VisionCache` keys by `mediaHash + schemaVersion` | `apps/agent/src/services/vision-cache.ts` |
| 5a.4 | Integration test: stub Gemini, assert tool returns structured scenes | new test |

### 5b. Ghost preview state machine — 2 d

| # | Task | Files |
|---|---|---|
| 5b.1 | Define ghost state machine: `proposed → previewing → accepted → committed` (+ `invalidated`/`stale`) | new `apps/web/src/lib/ghost/ghost-state.ts` |
| 5b.2 | Subscribe ghost store to changeset SSE events | new `apps/web/src/hooks/use-ghosts.ts` |
| 5b.3 | Render ghosts in timeline | `apps/web/src/components/editor/panels/timeline/*` |
| 5b.4 | Conflict detection: ghost stale when underlying element edited | tied to Change Log SSE |
| 5b.5 | Confidence indicator (border style) per ghost | UX spec §"Confidence Indicator" |

### 5c. Conflict marker `_conflicts/` flow — 1 d

| # | Task | Files |
|---|---|---|
| 5c.1 | `MemoryStore.writeConflictMarker(target, signal)` | `apps/agent/src/memory/memory-store.ts` |
| 5c.2 | `MemoryExtractor` calls writeConflictMarker on contradiction detection | `apps/agent/src/memory/memory-extractor.ts` |
| 5c.3 | `loadCandidatesFromTemplate` includes `_conflicts/*` (already in spec; verify) | `apps/agent/src/memory/memory-loader.ts` |
| 5c.4 | MasterAgent surfaces conflict naturally in prompt (see `memory-layer §7.2`) | system prompt section |

### 5d. Multimodal indication input — 1.5 d

| # | Task | Files |
|---|---|---|
| 5d.1 | Extend chat schema | `apps/agent/src/routes/chat.ts:30` add optional `temporal`, `spatial`, `ghostRef` |
| 5d.2 | Web canvas overlay for circle/box drawing | `apps/web/src/components/editor/panels/preview/*` |
| 5d.3 | Pass annotations through to MasterAgent prompt | `apps/agent/src/agents/master-agent.ts:runTurn` |
| 5d.4 | (Defer SAM2 client snap — spec §6 R6-3 explicitly client-side; out of scope here) | n/a |

### 5e. Session memory layer — 1 d

| # | Task | Files |
|---|---|---|
| 5e.1 | Wire `SessionMemory` into `runtime.ts` compaction path | `apps/agent/src/agents/runtime.ts` |
| 5e.2 | Store summary alongside `AgentSession.messages` for resume | `apps/agent/src/session/session-store.ts` |

### 5f. ExtensionRegistry — defer

Extension registry exists with no callers. Per `borrowing-review Round 10` ("先要有 extension contract，再谈 extension ecosystem"), defer until at least one concrete extension exists. Document the deferral.

---

## Cross-cutting concerns

### Tests
- After each task, run `bun run test --filter @opencut/agent` (per `tool-evolution §0`) and `bun run test --filter @opencut/web`.
- Add at least one integration test per phase that exercises the full wire (HTTP → agent → DB → SSE).

### Observability
- The audit identifies a `tool.progress` gap; the `borrowing-review §13` calls out broader observability gaps. While wiring Phase 1, ensure every newly-instantiated module emits at least its construction event to `EventBus` for boot-log visibility.

### Migration safety
- Phase 2 (DB schema) requires `bun run db:push` or a Drizzle migration. Ensure `apps/agent/migrations/` has the new migration file and that `drizzle.config.ts` picks it up.
- Phase 0-1 are additive only — should ship behind no flag.
- Phase 2 is NOT additive (replaces singleton core); coordinate cutover.

### What this plan does NOT cover
- Tool pipeline hook system extensibility (`borrowing-review Round 4`) beyond the existing impl
- Sub-agent fork / fresh / resume semantics (`borrowing-review Round 5`) beyond the current single-shot dispatch
- Full prompt section catalog refactor (`borrowing-review Round 2`) — section builder already exists, content modularization is a separate effort
- Plugin/MCP marketplace (`borrowing-review Round 10`) — explicit deferral
- `packages/core/` Command system audit (37+ files; spec §0.4 calls for de-singletonization)
- Phase 5 of the original plan (Asset Agent assets/character/brand stores beyond what's already written)

---

## Phase summary table

| Phase | Days | Touches | Prerequisites | Ships independently |
|---|---|---|---|---|
| 0 | 0.5 | `apps/web/src/hooks/use-chat.ts` + ChatPanel mount | none | yes |
| 1 | 2 | `apps/agent/src/index.ts`, `server.ts`, `master-agent.ts:runTurn` | none | yes |
| 2 | 4 | `services/server-editor-core.ts`, new `commit-mutation.ts`, `core-registry.ts`, DB schema | none (but DB migration) | replaces singleton — coordinate cutover |
| 3 | 3 (or defer 3.6) | new `services/headless-renderer.ts`, `routes/exploration.ts`, web renderer build | Phase 1 (preview-render worker stub), Phase 2 (per-project core) | yes after prereqs |
| 4 | 0.5 | `vision-client.ts`, `generation-client.ts`, `use-chat.ts` SSE | Phase 1 (EventBus wired) | yes |
| 5a-e | 1-2 each | varied | Phase 1 + Phase 2 | each independent |
| 5f | 0 | doc only | n/a | deferral |

**Total: ~10-13 days** for one engineer end-to-end, or 3 engineers × 4-5 days with parallelism (0+1 single dev, 2 single dev, 3+5 parallel).

---

## Acceptance for "all four sections closed"

A reviewer should be able to run, top to bottom, the audit's verification block:

```bash
grep -n "memoryStore\|memoryLoader\|explorationEngine" apps/agent/src/server.ts apps/agent/src/index.ts
grep -rn "new MemoryExtractor\|new ContextSynchronizer" apps/agent/src --include='*.ts' | grep -v __tests__
grep -rn "boss\.start\|jobQueue\.start" apps/agent/src --include='*.ts'
grep -rn "ChatPanel\|chat-panel" apps/web/src --include='*.ts*' | grep -v 'chat-panel.tsx'
grep -rn "playwright\|chromium\|daytona\|sandbox" apps/agent/src --include='*.ts'
```

…and see hits in every category (where applicable; Daytona may be intentionally absent per §3.6 decision).
