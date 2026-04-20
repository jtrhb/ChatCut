# ChatCut Wiring Audit — Design vs Implementation

Date: 2026-04-20
Scope: `apps/agent/src/`, `apps/web/src/`, `packages/core/src/` audited against `docs/chatcut-*.md` and `.omc/plans/`.

---

## TL;DR

| Tier | Severity | What | Effort |
|------|----------|------|--------|
| 1 | **Bug** | Web UI never reaches the agent (3 wire-format mismatches + unmounted panel) | minutes |
| 2 | **Dormant infra** | Master Agent's memory / exploration / extractor / observer / synchronizer / job-queue all exist as classes but are never constructed in `main()` | hours |
| 3 | **Spec gap** | `commitMutation` (DB-backed snapshot persistence), per-project core routing, Playwright `HeadlessRenderer`, Daytona sandbox pool — designed in detail, no code yet | days |

The implementation is far more complete than `chatcut-agent-advanced-agent-borrowing.md` suggests — most modules exist with tests. The actual gap is the **last-mile production wiring** in `apps/agent/src/index.ts` and the **client-server wire format**.

---

## A. Design ≠ Implementation

| # | Design says | Code does | Source |
|---|---|---|---|
| 1 | `commitMutation`: single DB transaction writes snapshot + ChangeLog + bumps `snapshotVersion` | `ServerEditorCore` is purely in-memory: `validateVersion` + `_version++`. No clone-then-commit, no DB write, no transaction. | `plan §3.3.1` vs `apps/agent/src/services/server-editor-core.ts` |
| 2 | Per-project `ServerEditorCore` routed by `projectId` | `index.ts:75-87` boots **one** singleton `ServerEditorCore.fromSnapshot({…empty})` shared across all sessions. | `plan §3.3.2` vs `apps/agent/src/index.ts` |
| 3 | `GET /project/:id` hydrates from latest committed snapshot | Route exists; no DB read path; the singleton in-memory core is the only source. | `plan §3.3.3` vs `apps/agent/src/routes/project.ts` |
| 4 | SSE filter scoped per session | `routes/events.ts:21` requires `sessionId`, but `apps/web/src/hooks/use-chat.ts:67` opens `?projectId=…` → no events ever match → UI never gets streaming updates. | `plan §7.10` vs `use-chat.ts` |
| 5 | Chat POST payload `{projectId, message, sessionId?}` | Web client sends `{projectId, content}` (`use-chat.ts:132`). Field-name mismatch → every send fails Zod parse. | `routes/chat.ts:30` vs `use-chat.ts:132` |
| 6 | `/changeset/approve|reject` require `x-user-id` (B5 IDOR closure) | Web `approveChangeset`/`rejectChangeset` (`use-chat.ts:144-180`) send no `x-user-id` header → always 401. | `routes/changeset.ts:54` vs `use-chat.ts` |
| 7 | `ExplorationEngine.explore(...)` should record real `projectId` | `exploration-engine.ts:188` hardcodes `projectId: "default"` with TODO comment. | `fanout §7.4` vs code |
| 8 | Context Synchronizer Lazy Sync injects Human edits into Master messages | `ContextSynchronizer` class exists at `context/context-sync.ts` but **no caller anywhere** — Master never invokes `buildContextUpdate`. | `agent-system §3.5`, `plan §7.4` vs grep |
| 9 | Two-level concurrency: writeLock + intra-turn order-preserving partition | Both implemented. ✓ | `tool-evolution P4` ✓ |
| 10 | `MemoryExtractor` subscribes to `ChangeLog.on("decision")` | Subscription set up in constructor, but **no `MemoryExtractor` is ever instantiated** outside tests. The "approve→extract memory" feedback loop is dead. | `memory-layer §4.1` vs grep |

---

## B. Built but not wired into `main()`

These exist as full modules with tests but no production wiring through `createWiredMasterAgent` / `apps/agent/src/index.ts`:

| Module | File | Wiring gap |
|---|---|---|
| **MemoryLoader** | `memory/memory-loader.ts` | `MasterAgent` accepts it as optional dep (`master-agent.ts:109`); `index.ts` never constructs/passes it → `loadMemoriesFor()` always returns `null` → no memory ever injected into prompts. |
| **MemoryStore** | `memory/memory-store.ts` | Constructed only inside the `skillsRouter` block (`index.ts:226`), not handed to MasterAgent → `writeMemory` throws if called → memory writer token never claimed at boot. |
| **MemoryExtractor** | `memory/memory-extractor.ts` | Never instantiated in production. The whole "approve→extract→reinforce" feedback loop is dead. |
| **PatternObserver** | `memory/pattern-observer.ts` | Imported in `index.ts:21` and a `maybeTriggerAnalysis` helper exists, but `main()` never constructs an observer or calls the helper. Skill auto-crystallization (Phase 5) is dormant. |
| **SessionMemory** | `memory/session-memory.ts` | Class with `record / getEntries`. No consumer; `runtime.ts` doesn't call it for compaction or session continuity. |
| **ExplorationEngine** | `exploration/exploration-engine.ts` | `MasterAgent.explore_options` checks `if (this.explorationEngine)` and returns `"not configured"` because `createWiredMasterAgent` doesn't accept/pass `explorationEngine`. Master can never trigger fan-out. |
| **ContentEditor** | `services/content-editor.ts` | Full extract→generate→replace pipeline exists. Not used by any sub-agent or tool executor. |
| **ContextSynchronizer** | `context/context-sync.ts` | See A.8. |
| **ExtensionRegistry** | `extensions/extension-registry.ts` | No registration sites; nothing reads it. |
| **JobQueue (pg-boss)** | `services/job-queue.ts` | `ExplorationEngine` calls `jobQueue.enqueue("preview-render", …)`, but: (a) no `JobQueue` instance is ever created or started in `main()` (no `boss.start()`), (b) **no worker** is registered for `preview-render` → enqueued jobs starve. |
| **ChatPanel** | `apps/web/src/components/editor/chat/*` | All five components exist (panel, bubble, status, changeset-review, candidate-cards) but `Grep ChatPanel` finds **no other importer** — never mounted in any editor layout. |
| **/skills route** | `routes/skills.ts` | Conditionally mounted only when both `DATABASE_URL` and `R2_BUCKET` are set; otherwise "disabled" warning at boot. |
| **AssetToolExecutor** | `tools/asset-tool-executor.ts` | Same condition + needs `EMBEDDING_API_URL`; otherwise asset tools return `"no registered executor"`. |

---

## C. Designed, no code yet

| Module | Spec source | Status |
|---|---|---|
| **HeadlessRenderer (Playwright)** | `plan §7.9` | No Playwright import, no `services/headless-renderer.ts`. Server-side preview/export Phase 4 deliverable absent. |
| **Daytona sandbox pool / SandboxPoolManager** | `fanout §5.2`, §8.x | No code. Even if a worker existed for `preview-render`, the sandbox pool is absent. |
| **In-process MCP server / `create_sdk_mcp_server`** | `architecture §3.12` | No MCP runtime. Master tools are Anthropic-SDK tool blocks, not MCP-registered. (May be intentional under the `AgentRuntime` contract abstraction — confirm.) |
| **Vision Agent → Gemini API bridge** | `agent-system §4.5` | `services/vision-client.ts` exists; verify `analyze_video` tool actually invokes it end-to-end (likely a stub). |
| **SAM2 client-side spatial snap** | `ux-design §Spatial Snapping` | No client implementation. Tool-evolution R6-3 explicitly classified this as a "client-side concern" so this is by design. |
| **Multimodal indication input** (text + spatial + temporal) | `ux-design` | Web hook only handles text. |
| **Ghost preview state machine** | `ux-design §Ghost Lifecycle` | No `ghost-store` / `ghost-state.ts`; UI uses simple changeset attachment, no proposed/previewing/accepted/invalidated/stale states. |
| **Conflict marker / `_conflicts/` flow** | `memory-layer §7.2` | `MemoryStore` lacks conflict-marker write paths; cross-session conflict resolution dialog cannot fire. |
| **Multimodal embedding for video search** | `memory-layer §6` | Phase 5 — not present. (Expected per docs.) |

---

## D. Tool-evolution spec status (`docs/chatcut-tool-system-evolution.md`)

| Section | Status | Notes |
|---|---|---|
| §1 Result budgets (overflow `Map` + `summarize` + `read_overflow`) | ✓ wired | `master-agent.ts:131-154` |
| §2 Fail-closed flags + order-preserving batches | ✓ wired | `runtime.ts:163-203`, `tool-pipeline.ts` |
| §3 `isEnabled` / `formatToolsForApi` context | ✓ wired | `format-for-api.ts`, `tools/types.ts` |
| §4 Master deferred loading + `resolve_tools` | ✓ wired | `deferred-registry.ts`, `resolve-tools-tool.ts` |
| §5 `descriptionSuffix` | ✓ wired | in types + format |
| §6 `onProgress` + `visualHints` | **Partial** | Pipeline accepts `onProgress`; **no tool actually calls it**; `tool.progress` event type defined but never emitted. Acceptance test 3 ("EventBus receives `tool.progress`") would fail in production. |

---

## Three Fix Tiers

### Tier 1 — UI is broken end-to-end (minutes per fix)

1. Fix `use-chat.ts:132` → send `message` not `content`.
2. Fix `use-chat.ts:67` → SSE URL needs `?sessionId=` (capture sessionId from the POST response, drive SSE off it).
3. Add `x-user-id` header to `approveChangeset` / `rejectChangeset` fetches.
4. Mount `<ChatPanel/>` in the editor layout (currently orphaned in `apps/web/src/components/editor/chat/`).

### Tier 2 — Master Agent is missing half its brain (hours, additive in `index.ts` + `createWiredMasterAgent`)

5. Construct & pass `MemoryStore` + `MemoryLoader` to MasterAgent (writer token + per-turn injection).
6. Construct & pass `ExplorationEngine` so `explore_options` works.
7. Construct `MemoryExtractor`, subscribe to `ChangeLog.on("decision")`.
8. Construct `PatternObserver`, schedule via `maybeTriggerAnalysis`.
9. Construct `ContextSynchronizer`, call `buildContextUpdate()` at the top of `runTurn`.
10. Start `JobQueue` (`boss.start()`) and register a `preview-render` worker (even a no-op stub unblocks fan-out).

### Tier 3 — Spec gaps blocking Phase 4 closure (days)

11. `commitMutation` clone-then-commit + DB persistence on `ServerEditorCore` (snapshot + ChangeLog in same tx).
12. Per-project routing for `ServerEditorCore` (replace single-instance boot with per-project map).
13. `HeadlessRenderer` (Playwright) so `preview-render` workers have something to call.
14. Daytona sandbox pool (or explicit decision to defer fan-out preview rendering past Phase 4).

---

## Out of scope for this audit

- `packages/core/` Command system audit (37+ files; spec calls for de-singletonization).
- `apps/web/src/services/storage` IndexedDB → R2 migration completeness.
- Test-suite coverage gaps for the dormant modules listed in §B.
- Security review beyond the IDOR closures already documented in `routes/changeset.ts`.

---

## Appendix — Verification commands

```bash
# Confirm no MasterAgent wiring of memoryStore/memoryLoader/explorationEngine
grep -n "memoryStore\|memoryLoader\|explorationEngine" apps/agent/src/server.ts apps/agent/src/index.ts

# Confirm no MemoryExtractor / ContextSynchronizer instantiation in src
grep -rn "new MemoryExtractor\|new ContextSynchronizer" apps/agent/src --include='*.ts' \
  | grep -v __tests__

# Confirm JobQueue is never started
grep -rn "boss\.start\|jobQueue\.start" apps/agent/src --include='*.ts'

# Confirm ChatPanel orphan
grep -rn "ChatPanel\|chat-panel" apps/web/src --include='*.ts*' | grep -v 'chat-panel.tsx'

# Confirm Playwright / Daytona absent
grep -rn "playwright\|chromium\|daytona\|sandbox" apps/agent/src --include='*.ts'
```
