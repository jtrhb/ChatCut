# Wiring Audit Remediation — Phase 1–5 Status & Handoff

**Date:** 2026-04-21
**Branch:** `main` (pushed through `32126082`; this doc adds one more commit)
**Audit source:** `docs/chatcut-wiring-audit.md`
**Master plan:** `.omc/plans/wiring-audit-remediation.md`

The wiring-audit remediation plan grouped 30+ findings into six
dependency-ordered phases (Phase 0 prep + Phases 1–5 main work).
This doc captures what landed, what was intentionally deferred, and
pre-existing issues surfaced during reviews that live outside the
current scope.

---

## Phase summary

| Phase | Scope | Status | Highlights |
|---|---|---|---|
| 0 | UI wire fixes (Tier 1 — chat payload, sessionId capture, SSE filter, x-user-id, ChatPanel mount) | ✅ Closed pre-Phase-1 (visible in current `apps/web/src/hooks/use-chat.ts` patterns) | Chat round-trip works end-to-end; SSE per-session filter active |
| 1 | Wire dormant Master Agent modules (memory, context-sync, exploration, JobQueue, ContentEditor) | ✅ Closed | All boot-log lines now read "wired" instead of "disabled" |
| 2 | Server-authoritative core — per-project routing, `commitMutation` clone-then-commit, project hydration | ✅ Closed | Persistent multi-project state; route-level 409/403/IDOR mapping |
| 3 | Preview rendering pipeline — **Modal-native, NOT Playwright/HeadlessRenderer** | ✅ Closed (Stage F closure 2026-04-21) | services/gpu/ Python skeleton + MLT translator + R2 + fan-out → 4 MP4 candidates rendered via Modal |
| 4 | Tool-evolution onProgress emitters (vision + generation clients → EventBus) | ✅ Closed | `tool.progress` reaches web SSE consumer |
| 5 | Six parallelisable items (Vision/Gemini, Ghosts, Conflicts, Multimodal, Session memory, ExtensionRegistry) | ✅ Closed (with two web-overlay Stage 2s deferred) | Detailed below |

---

## Phase 1 — Wire dormant Master Agent modules

**Plan ref:** `wiring-audit-remediation.md` §"Phase 1"
**Estimate:** 2 d • **Actual:** ~1.5 d in commits

### Sub-phases

| # | Sub-phase | Feature commit(s) | Close-out commit |
|---|---|---|---|
| 1A | Memory infrastructure wired into MasterAgent boot (MemoryStore + MemoryLoader + MemoryExtractor + ContextSynchronizer) | `b26142fd` + smoke test `478cd708` | `a821f1c9` |
| 1B | JobQueue start + ExplorationEngine construction + projectId fix | `b7c098dd` | (folded into 1A close-out) |
| 1C | ContentEditor wired via Creator agent's `generate_into_segment` | `1019b027` | (folded into 1A close-out) |

### Achieved

- `MemoryStore` is the **single** R2-backed singleton shared by `MasterAgent` (writer-token holder) and the `/skills` route — split-brain duplicate eliminated
- `MemoryLoader` injects `promptText` into the system prompt at turn entry; per-dispatch sub-agent loads append `injectedMemoryIds` for §9.4 traceability
- `MemoryExtractor` subscribes to `changeLog` decisions; writes draft memories on accept, conflict markers on consecutive rejection (the 5c flow extends this)
- `ContextSynchronizer` builds delta-injection text on every turn so the master sees committed changes that landed since its last turn
- `JobQueue` (pg-boss) starts at boot with `DATABASE_URL`; stub `preview-render` worker registered for end-to-end testability ahead of Phase 3
- `ExplorationEngine` constructed when JobQueue + DB + R2 are present; `projectId: "default"` hardcode replaced with current-turn identity threading
- Reviewer findings: 2 HIGH + 3 MEDIUM closed in `a821f1c9`

---

## Phase 2 — Server-authoritative core

**Plan ref:** `wiring-audit-remediation.md` §"Phase 2"
**Estimate:** 4 d • **Actual:** ~3 d in commits

### Sub-phases

| # | Sub-phase | Feature commit(s) | Close-out commit(s) |
|---|---|---|---|
| 2A | Per-project core registry + `replaceRuntime` | `43040d10` | `3f5904a5` (1 HIGH + 3 MED + 1 LOW) |
| 2B | `commitMutation` atomic primitive (clone-then-commit-then-replace) | `a3459a19` | (folded into later passes) |
| 2C | Drizzle adapters for snapshot source + mutation DB; `/commands` route persists via `commitMutation` | `87103cbf` + `802ccaff` | `7f54a318` (HIGH #2 + #3) + `f61b5d6b` (HIGH #4 + #5 + MED #6 + #7) |
| 2D | `GET /project/:id` hydrates via CoreRegistry | `573cdb01` | `bd64a408` (CRITICAL #1 + MEDIUM #9) |

### Achieved

- `CoreRegistry` keys per-project `ServerEditorCore` instances; multiple browser tabs editing different projects no longer share runtime state
- `commitMutation` is the only path that mutates persistent project state — clone-current-snapshot → apply commands → diff → drizzle write → atomic `replaceRuntime` swap; aborts cleanly on conflict
- Drizzle schemas for `projects` + `change_log` ship with proper FK + unique-index constraints; mutation DB ↔ snapshot source split for read/write segregation
- Routes return semantic HTTP status codes:
  - `409 Conflict` on `StaleStateError` (editor state changed during review)
  - `403 Forbidden` on `ChangesetOwnerMismatchError` (IDOR closure — security C3)
  - `401 Unauthorized` BEFORE body parsing on `/changeset/approve` + `/reject` so the body schema doesn't leak via error responses
- Reviewer pass uncovered + closed: 2 HIGH atomicity bugs (clone-vs-replace ordering), 5 MED route-safety issues, 1 CRITICAL deploy gap, plus plan blockers

---

## Phase 3 — Modal-native GPU service + preview pipeline

**Plan ref:** `wiring-audit-remediation.md` §"Phase 3 status (2026-04-21): CLOSED"
**Estimate:** original 5d under HeadlessRenderer scaffold; **actual ~12d under Modal-native** after second pivot

The original Phase 3 plan called for an in-process Chromium pool +
Playwright + Daytona sandbox. **Both pivoted out:** the renderer
scaffold (`HeadlessRenderer`) was deleted; Daytona was superseded by
Modal-native GPU execution. The plan file's Phase 3 section is marked
**SUPERSEDED**; the actual closed scope is documented at
`.omc/plans/phase-3-headless-renderer.md` and the per-stage commits
below.

### Stages

| Stage | Scope | Key commits |
|---|---|---|
| A | `services/gpu/` Python skeleton + auth + jobs domain; Modal app shell + handlers + Bun aliases; R2 client wrapper + storage-key validator | `e335a39f` + `b45f137f` + `f00835d5` + reviewer pass `58cd2ca8` (3 HIGH + 4 MED + 1 LOW) |
| B | SerializedEditorState → MLT XML translator; R2 download + asset_fetcher; render orchestrator (translator + assets + melt); MLT image rebuild; e2e render pipeline (mock melt + XML capture) | `f96cef0f` (B.0 docs) + `c3a13c3b` (B.1) + `16b95779` (B.3.a) + `5b6204ab` (B.3.b) + `a6530447` (B.4+B.5) + `ad7e0641` (B.6) + reviewer pass `0205a6a9` (1 CRITICAL + 4 HIGH + 3 MED + 1 LOW) |
| C | `gpu-service-client.ts` HTTP client + FastAPI detail unwrap; preview-render worker uses gpu-service-client + env wiring; `render_preview` accepts `snapshotStorageKey`; extract preview-render handler + integration test | `e8b5816a` (C.0 docs) + `76503dad` (C.1) + `3c51a62a` (C.2) + `5e5a4c82` (C.3+C.4) + `a4057094` (C.5+C.6) + `8d2fdfe2` (C.7) + reviewer passes `31b219fa` (HIGH #2 #3 + MED #5 #7 #9) + `bc03bbcf` (HIGH #1 + MED #10) + `7f07873f` (gpu-side MED #4 #5 #6) + tsc narrow `9afacda6` |
| D | Poll-job backoff (1.5s → 5s after 30s no-change) + `onProgress` callback; preview-render worker emits `tool.progress` + `exploration.candidate_ready` over EventBus | `cae38f89` (D.1) + `c622bbd0` (D.2-D.4) |
| E | Preview render writeback to `exploration_sessions`; `/exploration` route reads DB + mounts in `server.ts`; preview-render worker mints signed URL; web SSE `candidate_ready` handler + MP4 video card; fan-out e2e integration test | `c3c2ba12` (E.1+E.2) + `2ab5b762` (E.3+E.4) + `5ee7cdee` (E.5) + `233d679d` (E.6) + `c6ff2409` (E.7) + reviewer pass `bd0d7f7a` (HIGH-1, MED-1..4, LOW-1..2, NIT-1..2) |
| F | HeadlessRenderer scaffold delete + cleanup; R2 ops runbook + Daytona supersession docs + Phase 3 closure + top-level README | `04e31235` (F.1+F.2+F.3) + `f8dd9154` (F.4-F.7) + reviewer pass `1ef3e7ba` (MED + 2 LOW + 2 NIT) |

### Achieved

- User triggers `explore_options` → 4 candidate jobs enqueue on pg-boss → preview-render worker calls Modal `render_preview` → MLT/melt renders 5–10s MP4 → R2 stores result → web `candidate_ready` SSE delivers signed URL → MP4 plays in chat candidate card
- `tool.progress` SSE updates surface via `wrappedProgress` plumbing through the tool pipeline
- Daytona decision documented as superseded; HeadlessRenderer scaffold + ~500MB Chromium pool path deleted from the tree (no dead code)
- R2 lifecycle: `previews/{explorationId}/` cleared after 24h via bucket policy

---

## Phase 4 — Tool-evolution onProgress emission

**Plan ref:** `wiring-audit-remediation.md` §"Phase 4"
**Estimate:** 0.5 d • **Actual:** ~1 d after reviewer pass

### Commits

| Commit | Scope |
|---|---|
| `8e580dc9` | Wire `tool.progress` emitters in vision + generation clients |
| `68008cdd` | Close reviewer atomicity + chain-wire blockers (HIGH #8 + MEDIUM #1 #6 #10) |
| `066b15c7` | Close web-side reviewer blockers (HIGH #2 + MEDIUM #9) |
| `0c3449bb` | Test pin for chain-wire contract that Pass A's loosened assertions left uncovered |

### Achieved

- `analyze_video` (vision) emits `onProgress` at upload start/done + generation start/parse done
- `generate_video` emits `onProgress` per poll cycle with `{progress%}`
- `tool.progress` SSE event reaches `apps/web/src/hooks/use-chat.ts` and renders as in-line progress text (Phase 4 reviewer HIGH #2: surfaced in its own state, not by abusing the typed `AgentStatus` union)

---

## Phase 5 — Remaining §C items (six parallelisable sub-phases)

**Plan ref:** `.omc/plans/phase-5.md`
**Sequenced:** smallest/agent-only first, biggest/web-heavy last, pure-docs closing
**Order:** 5a → 5e → 5c → 5d → 5b → 5f

### Sub-phases

| # | Sub-phase | Feature commit | Close-out commit(s) | Reviewer verdict |
|---|---|---|---|---|
| 5a | Vision Agent ↔ Gemini end-to-end | `70f533bb` + `5942082c` | `ed5f90d7` | APPROVE |
| 5e | Session memory wiring (compaction + summarizer + prompt injection) | `6fcc017c` | `b5489ef2` + `4f4ed42b` | APPROVE |
| 5c | Conflict marker `_conflicts/` flow | `3f0a298a` | `e569f162` + `818de002` | APPROVE |
| 5d Stage 1 | Multimodal indication input (agent contract + threading) | `dcb95b99` | `8287d2ae` | APPROVE |
| 5b Stage 1 | Ghost preview state machine + agent emission | `9a6a33f4` | `e506ceb3` | APPROVE |
| 5f | ExtensionRegistry deferral docs | `6d9bc8af` | `59f34fb9` | APPROVE |

### Per-sub-phase highlights

- **5a Vision** — `VisionClient` v2 (Gemini Files API + header auth + timeouts + SCHEMA_VERSION-keyed cache); `VisionToolExecutor` wired at boot; e2e integration test against stubbed Gemini; cache-hit path verified.
- **5e Session memory** — `SessionCompactor` (150_000-token threshold + Anthropic summarizer factory); per-session async mutex with rejection-safe tail capture; `applyCompaction` combined-write on `SessionManager`; system-prompt injection of summary; `agent.session_compacted` runtime event.
- **5c Conflict markers** — `MemoryStore.writeConflictMarker` (token-gated) + `readConflictMarker` + `listConflictMarkers`; `MemoryLoader.loadConflictMarkers` newest-first; `MemoryExtractor` writes on consecutive-rejection threshold (≥2 prior); YAML scalar escaping; "Active conflicts" prompt section.
- **5d Stage 1 Multimodal** — `routes/chat.ts` Zod schema for `annotations` (1..N spatial + temporal + `ghostRef`) + `annotatedFrame` (mediaType enum + 12MB base64 cap); 16MB body-limit middleware; `MessageHandler` 4th+5th args; `AgentRuntime.run` accepts multi-block `userContent` for vision blocks; backtick prompt-injection guard.
- **5b Stage 1 Ghost preview** — `ProposedElement` schema (ghostId, kind, dependsOn) + `confidence` field on `PendingChangeset`; `ChangesetManager` emits `changeset.proposed | .approved | .rejected` on `EventBus`; pure-TS state machine in `@opencut/core` (`proposed → previewing → accepted → committed` + off-paths `invalidated/stale`); `propagateStale` fixed-point algorithm; SSE serializer flat-shape fix with envelope-wins spread order.
- **5f Deferral docs** — Top-of-file deferral docstring on `ExtensionRegistry` (STATUS/WHY/WHEN/WHAT-NOT-TO-DO); audit plan §5f marked DEFERRED with cross-reference.

---

## 🚧 Left behind (intentional deferrals)

### 5d Stage 2 — Web canvas overlay UI

Stage 1 shipped the agent contract; Stage 2 is the browser UI that
captures annotations and the annotated preview frame. Deferred per
user choice (option a) and CLAUDE.md UI-verification rule.

**Scope:**
1. Annotation tool on the preview canvas (`apps/web/src/components/editor/preview/preview-interaction-overlay.tsx` already exists as scaffolding)
2. Rectangle-draw mode (0..1 normalized coords matching `SpatialAnnotationSchema`)
3. Temporal-range mode (`startSec` / `endSec`, validated client-side to match the `endSec > startSec` server refine)
4. Optional free-text label scribble
5. Frame capture: snapshot the preview canvas → base64 PNG/JPEG → POST as `annotatedFrame.base64`
6. Wire into `useChat` `sendMessage()` so annotations + annotatedFrame flow alongside message text
7. UX for ghost references (`ghostRef.ghostId`) — depends on 5b Stage 2 landing first

**Acceptance:** user draws a rectangle on the preview, types "remove this", and the agent receives the box coords + the rendered preview frame as a multimodal vision input.

---

### 5b Stage 2 — Web ghost preview UI

Stage 1 shipped the agent emission + pure-TS state machine; Stage 2
is the React rendering layer. Deferred per user choice (option a) and
the same UI-verification rule.

**Scope:**
1. NEW `apps/web/src/hooks/use-ghosts.ts` — internal `Map<ghostId, GhostRecord>`; subscribes to SSE; folds events through `applyChangesetDecision` from `@opencut/core`
2. SSE consumer wiring: read `changeset.proposed | .approved | .rejected` from the existing per-session stream (data is now flat — `evt.proposedElements`, `evt.confidence`, etc. — per the Phase 5b CRIT-1 fix)
3. Spawn ghosts in `proposed` state on `changeset.proposed`; transition through `previewing` (on hover/UI mount) → `accepted` (on user click) → `committed` (on changeset commit)
4. Extend `apps/web/src/components/editor/panels/timeline/timeline-element.tsx` to render a ghost layer with confidence-driven border styling:
   - `confidence < 0.4` → dashed yellow
   - `0.4 ≤ confidence < 0.7` → solid blue
   - `confidence ≥ 0.7` → solid green
5. Stale propagation UI: faded styling for `stale` ghosts; tooltip explaining "upstream change invalidated this preview"
6. Approve/reject buttons that call `applyChangesetDecision` and POST to `/changeset/approve` / `/reject`

**Acceptance:** agent proposes a clip deletion → user sees a ghost overlay on the timeline element with confidence-coded border → click approve → ghost transitions to `committed` and the timeline reflects the change.

---

## ⚠️ Pre-existing issues surfaced during reviews (out of scope)

These were observed while implementing Phases 1–5 but predate the
work and were not regressed by it. Each warrants a separate ticket.

### NEW-1 — `preview-render-worker` SSE events drop at session filter — **FIXED (2026-04-22)**

**Severity:** MEDIUM
**Location:** `apps/agent/src/services/preview-render-worker.ts:158-170` and `:259-268`
**Origin:** Phase 3 Stage E (sessionId never threaded at this worker)

The `tool.progress` and `exploration.candidate_ready` events emitted by
the preview-render worker omit `sessionId`. The per-session SSE filter
at `apps/agent/src/routes/events.ts:37` drops events whose `sessionId`
doesn't match the subscriber's session. The Phase 5b CRIT-1 close-out
fixed the consumer-side read shape in `use-chat.ts`, but the consumer
never receives the worker's events because they fail the
session-equality check upstream.

**Other `tool.progress` emit sites** (e.g. `tool-pipeline.ts:298-309`)
DO carry `sessionId` via the Phase 5a HIGH-1 `wrappedProgress`
plumbing and benefit from the Phase 5b CRIT-1 read fix immediately.
Only the preview-render worker is affected.

**Fix landed (2026-04-22):** `sessionId` is now optional on
`ExploreParams` and `PreviewRenderJobData`; threaded from
`master-agent.ts` (`explore_options` case) → `ExplorationEngine.explore`
→ `jobQueue.enqueue("preview-render", ...)` → worker emits at top level
of both `RuntimeEvent` envelopes. Reviewer-cycle additions: a soft warn
fires at the master-agent call site if `currentIdentity?.sessionId` is
missing (smoke signal that turn identity wasn't propagated upstream),
and the failed-terminal `tool.progress` emit is also pinned by test —
poll-job.ts fires `onProgress` on terminal failure (real or
synthesized) so the user-facing "render failed: …" surface inherits
the same per-session routing.

#### NEW-1 follow-up — `exploration_sessions` row should persist `sessionId`

**Severity:** LOW (deferred; not blocking NEW-1 closure)
**Location:** `apps/agent/src/db/schema.ts` (`exploration_sessions` table)
+ `apps/agent/src/exploration/exploration-engine.ts` (insert at end of `explore()`)

NEW-1 closes the in-flight SSE delivery path. It does NOT survive page
reload mid-render: if the user reloads while a candidate is still
rendering, the worker's `candidate_ready` emit fires with the original
sessionId but the new tab subscribes with a new sessionId — the SSE
filter drops it. The `/exploration` route already mints fresh signed
URLs for completed renders via Stage E.2 writeback, so terminal
state is recoverable, but real-time progress for a still-rendering
candidate after reload is not.

**Fix shape:** add a `sessionId text` column to the
`exploration_sessions` schema; persist it from `ExploreParams.sessionId`
at insert time; on reconnect the route can join sessions by
`(projectId, sessionId)` to replay terminal state. Leave this as a
follow-up because (a) reload-mid-render is rare and (b) it's a schema
migration, not a runtime fix — out of scope for the closing audit
fix.

**Migration mechanic (re-review LOW follow-up):**
- Column must be **nullable** — `ExploreParams.sessionId` is optional
  per `apps/agent/src/exploration/exploration-engine.ts:60-65`, so
  cron-sweep and other server-initiated callers will write NULL.
- Use `bunx drizzle-kit push` (the project's only configured
  drizzle-kit script — see `apps/agent/package.json:12` `db:push`) to
  apply the schema after editing `apps/agent/src/db/schema.ts`. If a
  generate-then-apply flow is preferred, add a `db:generate` script
  first; do not hand-write the migration SQL.
- Wire the route-side replay at `apps/agent/src/routes/events.ts`
  (the per-session SSE subscribe site — `streamSSE` at line 30, the
  same place the per-session filter at line 37 drops mismatched
  events). On subscribe, look up `exploration_sessions WHERE
  projectId=? AND sessionId=?` for any rows whose terminal state
  (`preview_storage_keys` / `preview_render_failures`) is populated
  and re-fire a one-shot `candidate_ready` (or `candidate_failed`)
  for each before joining the live event stream. Without this
  read-and-replay step the schema column is dead weight.
  (`apps/agent/src/routes/exploration.ts` is the HTTP polling
  fallback for completed renders — not the SSE channel.)

---

### Multi-tab cross-session SSE gap (5b deferred per Q5=a)

**Severity:** MEDIUM (intentional v1 deferral)
**Location:** `apps/agent/src/changeset/changeset-manager.ts` `finalizeDecision()`

A second browser tab open to the same project (different chat session)
will NOT see `changeset.approved` / `.rejected` SSE updates because
the manager echoes the proposing-turn's `sessionId` and the per-session
SSE filter is strict-equality. Tab B's ghosts stay in `proposed` style
after Tab A approves the changeset.

Documented at the emit site with two future remediation paths:
1. `projectId:` filter fallback in `routes/events.ts` matching when
   the subscriber has no sessionId set but owns the project
2. Emit a second broadcast event on a project-scoped channel

---

### Undo of accepted ghost / ghost-of-ghost (5b deferred per Q5=a)

**Severity:** LOW (intentional v1 deferral)
**Location:** N/A — feature gap, not a code bug

The current Phase 5b state machine has no `accepted → proposed` or
`committed → proposed` transitions. Once a ghost commits, it's
permanent from the ghost-overlay perspective; undo flows through the
underlying ChangeLog / `ServerEditorCore`. A "ghost of a ghost" (the
agent proposes a change to a ghost not yet committed) is also outside
v1 scope.

---

### Pre-existing tsc errors (multiple files, not Phase-N regressions)

These were flagged by `npx tsc --noEmit` throughout Phase 5
verification but exist on `main` independent of any Phase-N commit.
None block runtime behavior — they're type-system drifts and missing
annotations.

| File | Error | Origin |
|---|---|---|
| `apps/agent/src/agents/runtime.ts:203` | Anthropic SDK `ToolUseBlock` type drift (missing `type` discriminator on imported type) | SDK upgrade |
| `apps/agent/src/db/schema.ts:25,36,44,50` | Drizzle implicit `any` on `projects` / `changeLog` self-referential FK helpers | Drizzle schema pattern |
| `apps/agent/src/services/embedding-client.ts:44` | `unknown` → object cast missing | Pre-existing |
| `apps/agent/src/services/object-storage.ts:113` | S3Client SDK version mismatch (smithy middleware step types) | AWS SDK version pin |
| `apps/agent/src/routes/__tests__/exploration.test.ts` | Multiple `body is of type 'unknown'` after `c.req.json()` | Hono response type |
| `apps/agent/src/routes/__tests__/skills.test.ts` | Same as above | Hono response type |
| `apps/agent/src/tools/__tests__/fail-closed-defaults.test.ts:75` | `accessMode` missing from local `ToolDefinition` cast | Test fixture drift |
| `apps/web/src/hooks/use-chat.ts:404,428` | `m.changeset!` non-null assertion (biome `noNonNullAssertion`) | Pre-existing |

**Fix:** out of scope — bundle into a separate "tsc/biome cleanup" pass.

---

## Standing rules honored across all phases

- **Per-stage reviewer pass after every commit set** — every sub-phase
  of every phase was reviewed; close-outs were re-reviewed where the
  first pass returned REQUEST CHANGES. No "self-approve in same
  context" violations.
- **"Address them all"** — every reviewer finding was either fixed in
  a close-out commit or explicitly documented as out-of-scope deferral
  with a cross-reference at the code site (5b MED-2 multi-tab, NEW-1
  preview-render-worker).
- **Decisions confirmed before code lands** — every Phase 5 sub-phase's
  Decisions block was answered by the user before implementation
  started; the same gate held for Phase 1–4 architectural choices
  (e.g. Modal vs. Daytona pivot).
- **CLAUDE.md UI-verification rule** — both web-heavy stages
  (5d Stage 2, 5b Stage 2) deferred rather than shipped untested.
- **Phased execution** (no >5-file commits, separate cleanup before
  refactor) — every phase split into stages with explicit acceptance
  blocks.

---

## Verification (post-Phase-5)

- **Tests:** `apps/agent` 1349/1349 vitest pass; `packages/core` 84/84 pass; `services/gpu` Python suite pass (verified during Phase 3 Stage F closure).
- **Type-check:** zero new tsc errors in any Phase 1–5 file. Pre-existing errors documented above are out of scope.
- **Lint:** biome clean on every Phase 1–5 file. Pre-existing web `m.changeset!` warnings are out of scope.
- **End-to-end smoke (manual):** chat round-trip via `apps/web/src/hooks/use-chat.ts` works; SSE delivers per-session events; changeset approve/reject returns 200 + drives `EventBus`; fan-out exploration renders 4 MP4 candidates via Modal.

---

## Next likely work (priority-ranked)

1. **5b Stage 2 — Web ghost preview UI.** Largest user-facing payoff;
   agent contract is already shipping ghost data the web is currently
   discarding.
2. ~~**NEW-1 fix — sessionId threading at preview-render-worker.**~~
   **Closed 2026-04-22** — see "NEW-1 — `preview-render-worker` SSE
   events drop at session filter — FIXED" above. Reload-recovery
   follow-up (persist `sessionId` on `exploration_sessions` row) is
   tracked there as LOW.
3. **5d Stage 2 — Web canvas overlay UI.** Smaller scope than 5b
   Stage 2 but blocked on UX decisions about the annotation tool
   affordances.
4. **tsc/biome cleanup pass.** Boring but reduces friction on every
   future review.
5. **Multi-tab cross-session SSE delivery.** Filed as documented
   deferral on 5b; bumps to a real ticket the moment a second tab
   stalemate is reproducible in user reports.

The `wiring-audit-remediation.md` audit plan now has every Phase 1–5
row marked complete (or DEFERRED with a cross-reference).
