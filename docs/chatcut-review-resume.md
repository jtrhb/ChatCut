# ChatCut UltraReview — Resume Log

Session state for resuming the ultrareview + fix sequence.
Updated: 2026-04-17 after B3 committed (B1 + B2 + B3 done).

---

## Repo state

- Branch: `main`
- Latest commits:
  ```
  0837a430 feat(agent): master mints per-dispatch taskId + rolls back on throw (B3 phase 2b)
  df303fc1 feat(agent): route editor tools through CommandManager for rollback (B3 phase 2a)
  976138a4 fix(agent): type ToolPipeline ctx as ToolContext (B1 follow-up)
  21071ebc feat(core): add per-taskId command tagging + rollbackByTaskId (B3 phase 1)
  2dc6317b fix(agent): prevent orphan tool_use on executor throw (B2)
  fd52fba7 refactor(agent): plumb sessionId/userId/projectId end-to-end (B1)
  12fe9b25 chore: add .omc project state and update gitignore  ← pre-review baseline
  ```
- Test baseline: **957 tests pass** in `apps/agent` (76 test files, ~3.5s) + **32 tests** in `packages/core`
- Uncommitted: `bun.lock` (516-line diff from fresh `bun install`). Decide separately: commit as `chore:` or revert.
- Bun install path: `~/.bun/bin/bun` — export before running: `export PATH="$HOME/.bun/bin:$PATH"`
- Run tests: `cd apps/agent && bun run test` (or `cd packages/core && bun run test`)

---

## Ultrareview findings (from 3 parallel reviewers)

Three reviewers hit the same root cause from different angles: **`userId`/`sessionId` were never plumbed end-to-end**. B1 resolved the plumbing; the enforcement / multi-tenant surface still needs work.

### Ship-blocker clusters

1. **Tenant isolation** — addressed partially by B1. Still open:
   - No auth middleware — `routes/chat.ts` reads `x-user-id` header as stub
   - `AssetStore.search` query itself (in `apps/agent/src/assets/asset-store.ts:45-69`) never filters by `userId` even when passed — see security C2
   - `routes/skills.ts:19` still `userId: "default"`
   - SSE `/events` broadcasts all sessions (security C4) — **B7** addresses
   - `ChangesetManager` IDOR (security C3) — **B5** addresses
   - `/project/:id` returns single shared ServerEditorCore (security C5)

2. **Spec-level gaps** remaining:
   - ~~No per-dispatch `taskId` → no `rollbackByTaskId` (spec §5.4)~~ — **B3 done (2026-04-17)**
   - Master is not the sole memory writer; `loadMemories` never called — **B4**
   - No review-lock / StaleStateError / 409 on concurrent human edits — **B5**
   - Context Synchronizer uses all entries, not committed-only (change-log.ts:46 slice behavior)
   - `ClaudeSDKRuntime` absent (only `NativeAPIRuntime`)

3. **Memory leaks** — **B6**: unbounded Maps in `SessionStore`, `ChangesetManager.changesets`, `TaskRegistry.tasks`, `index.ts:26 lastAnalysisAt`, `OverflowStore` never disposed, EventBus history `.shift()` O(n)

4. **Latent NPE** — `index.ts:99-105` AssetToolExecutor constructed with `{} as any` for assetStore/brandStore/objectStorage — **B8**

### Known-safe (don't re-audit)

- SSRF guard in `asset-tool-executor.ts:235-282` — TOCTOU-resistant, covers IPv6-mapped, link-local, metadata IPs
- Drizzle usage parameterized throughout; no `eval`/`Function()`/`child_process`
- ToolPipeline state machine with key-release-on-failure
- `buildOrderPreservingBatches` correctly fail-closed

---

## Done (committed)

### B1 — Plumb identity end-to-end (fd52fba7)

Threaded `(userId, sessionId, projectId)` from request through session → MasterAgent → ToolPipeline ctx → raw executor. Replaced hardcoded `userId: "unscoped"` in `AssetToolExecutor` with `ctx.userId` (falls back to "unscoped" for dev paths until auth middleware lands).

Key additions:
- `tools/types.ts` — exported `ToolContext` interface
- `session/types.ts` — `AgentSession.userId?`, `CreateSessionParams.userId?`
- `agents/types.ts` — `DispatchInput.identity?`
- `agents/master-agent.ts` — `currentIdentity` set per turn via `handleUserMessage(..., identity)`, picked up by pipeline ctx and forwarded to dispatches
- `agents/sub-agent.ts` + `agents/create-agent-pipeline.ts` — `RawToolExecutor` type accepts optional `ToolContext` 3rd arg
- `routes/chat.ts` — reads `x-user-id` header as auth stub; rejects cross-tenant session reuse
- `tools/asset-tool-executor.ts` — `resolveUserId(ctx)` for search + save
- `index.ts` — `toolExecutor` closure forwards ctx to editor/asset executors

New regression tests:
- `tools/__tests__/asset-tool-executor.test.ts` — "threads ctx.userId into assetStore.search" + "falls back to 'unscoped' when missing"

### B2 — Runtime orphan tool_use (2dc6317b)

`NativeAPIRuntime.run` single-tool-use branch at `runtime.ts:180` had no try/catch — executor throws left orphan tool_use, 400s next API call. Extracted `runSingle()` that always emits `is_error` tool_result on failure, symmetric with parallel branch. Improved max-iter message to include iteration limit + tool-call count.

New regression test:
- `agents/__tests__/runtime.test.ts` — "emits an is_error tool_result when executor throws (single block)"

### B3 — Per-dispatch taskId + rollbackByTaskId (21071ebc, df303fc1, 0837a430)

Shipped in 3 phases (+ 1 B1 follow-up `976138a4` fixing a `ToolPipeline` ctx typing drift the phased typecheck surfaced).

**Phase 1 — core plumbing (`21071ebc`):** `ChangeEntry.taskId?`, `ExecuteOptions.taskId?`, `CommandManager.history` switched to `{command, options}` tuples, `CommandManager.undoByTaskId(taskId)` walks history in reverse and unwinds matching entries without pushing onto the redo stack, emits `command:rollback`. `EditorCore.executeAgentCommand(cmd, agentId, taskId?)` + `EditorCore.rollbackByTaskId(taskId)`. 11 new tests.

**Phase 2a — server-safe Command + editor-tools routing (`df303fc1`):** New `ServerTracksSnapshotCommand` (takes explicit EditorCore — unlike the browser `TracksSnapshotCommand` that reads the singleton). `ServerEditorCore` gains `executeAgentCommand(cmd, agentId, taskId?)`, `rollbackByTaskId(taskId)` (bumps version once post-rollback), and `applyTracksAsCommand(before, after, agentId, taskId?)`. `EditorToolExecutor` stores active `ToolContext` as an instance field set on `executeImpl` entry / cleared in finally; `_applyTracks` reads it to construct a tagged snapshot command. Every write tool (trim, split, delete, move, add, set_speed, set_volume, add_effect, update_text, add_keyframe, reorder, batch_edit) now participates in rollback without signature changes. 13 new tests including full rollback integration (multi-op dispatch unwinds cleanly).

**Phase 2b — master dispatch rollback (`0837a430`):** `MasterAgent` gains optional `serverCore: ServerEditorCore` dep. `handleDispatch` mints `dispatch-<nanoid(10)>` taskId per call, threads into `DispatchInput.identity.taskId`, wraps dispatcher in try/catch, calls `serverCore.rollbackByTaskId(taskId)` on throw and returns `{ error: "Sub-agent dispatch failed: ..." }`. Rollback errors are swallowed so the original dispatch error remains the signal. Write lock still releases in finally. `createWiredMasterAgent` + `index.ts` production wiring pass the real `serverEditorCore`. 7 new tests including: nanoid taskIds are unique per dispatch, rollback not called on success, rollback is best-effort when serverCore absent.

**Test delta:** `apps/agent` 941 → 957; `packages/core` 29 → 32.

**Known limitation (acceptable):** Rollback is LIFO-safe when the rolled-back taskId group is the most recent. If a second `taskId-B` dispatch lands between a `taskId-A` command group and the rollback, unwinding `taskId-A` restores `taskId-B`'s pre-state instead of `taskId-A`'s pre-state. In the current architecture the Master dispatches one sub-agent at a time under a write lock, so interleaving doesn't occur in practice. Documented in test `rollbackByTaskId leaves commands tagged with other taskIds in place`.

---

## Pending (ordered by original priority)

### B4 — Master sole memory writer (est. 1 day)

- `agents/master-agent.ts:handleUserMessage` — call `loadMemories(taskContext, "master")` at entry; inject `promptText` into system prompt; stamp `injectedMemoryIds/SkillIds` onto any created changeset
- `memory/memory-store.ts:writeMemory` — gate on a Master-owned writer token (or move the method onto Master)
- `memory/memory-extractor.ts:47` — current `changeLog.on("decision", ...)` writes directly; route through Master instead
- Spec ref: `docs/chatcut-memory-layer.md §9.4`

### B5 — Changeset review-lock + StaleStateError + owner check (est. 0.5 day)

- `changeset/changeset-manager.ts:propose` — record `baseSnapshotVersion` + `reviewLock=true`
- `approve/reject` — compare current `serverCore.snapshotVersion` to stored base; check `ChangeLog.getCommittedAfter(boundaryCursor)` for any `source==="human"` entries
- `routes/changeset.ts` — return 409 on stale; verify `(projectId, userId)` matches stored changeset owner before action
- `ChangesetManager.changesets` must persist `{userId, projectId}` per changeset (closes security C3 IDOR)

### B6 — LRU/TTL on unbounded Maps (est. 0.5 day)

- `session/session-store.ts:sessions` Map — add TTL eviction (30-min idle per overflow pattern)
- `changeset/changeset-manager.ts:changesets` — evict committed/rejected after N days
- `tasks/task-registry.ts:tasks` — retention policy
- `index.ts:26 lastAnalysisAt` — move inside a class with LRU
- `events/event-bus.ts:34-36` — ring buffer instead of `shift()` O(n)
- `tools/overflow-store.ts` — add `dispose()` and call from master-agent shutdown

### B7 — SSE event filter by session (est. 1 hour)

- `routes/events.ts:9-28` — replace `eventBus.onAll(...)` with per-session filter keyed on `sessionId` (or `userId`/`projectId`). Drops security C4 cross-tenant leak.
- Needs: caller to provide sessionId in SSE subscription URL or header.

### B8 — Replace `{} as any` stubs (est. 30 min)

- `index.ts:99-105` — `AssetToolExecutor` constructed with `{} as any` for `assetStore`/`brandStore`/`objectStorage`. Decide:
  - (a) Fail-fast at boot when deps missing (skip constructing the executor — current code does this conditionally on `EMBEDDING_API_URL`, but stub-deps path still NPEs on first call)
  - (b) Wire real `AssetStore`/`BrandStore`/`ObjectStorage` instances (requires DB + R2 creds at boot)
- Also `index.ts:162-163` — `skillsRouter` deps have same stub

---

## How to resume

1. `export PATH="$HOME/.bun/bin:$PATH"` (bun not in default PATH)
2. `cd /Users/bing/Documents/ChatCut && git status` — confirm on main at 2dc6317b
3. `cd apps/agent && bun run test` — confirm 941 pass
4. Pick next task from pending list above
5. Follow phased execution rule from `CLAUDE.md`: ≤5 files per phase, verify tests between phases, commit at natural boundaries
6. Update this file when closing each B-item

## Reference

- Ultrareview reports live in transcripts (no on-disk artifacts). Key findings summarized above.
- Design docs (authoritative): `docs/chatcut-agent-system.md`, `chatcut-architecture.md`, `chatcut-memory-layer.md`, `chatcut-tool-system-evolution.md`
- Project guidance: repo `CLAUDE.md` (phased execution, forced verification, edit integrity rules)
