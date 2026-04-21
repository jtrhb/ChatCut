# Phase 5 — Status & Handoff

**Date:** 2026-04-21
**Branch:** `main` (69 commits ahead of `origin/main`)
**Plan:** `.omc/plans/phase-5.md`

Phase 5 closed all six sub-phases of the audit-driven wiring remediation
plan. This document captures what landed, what was intentionally
deferred for later implementation, and pre-existing issues that
surfaced during reviews but live outside Phase 5 scope.

---

## ✅ Achieved (six sub-phases)

| # | Sub-phase | Feature commit | Close-out commit(s) | Reviewer verdict |
|---|---|---|---|---|
| 5a | Vision Agent ↔ Gemini end-to-end | `70f533bb` + `5942082c` | `ed5f90d7` | APPROVE |
| 5e | Session memory wiring (compaction + summarizer + prompt injection) | `6fcc017c` | `b5489ef2` + `4f4ed42b` | APPROVE |
| 5c | Conflict marker `_conflicts/` flow (write + load + prompt-inject) | `3f0a298a` | `e569f162` + `818de002` | APPROVE |
| 5d Stage 1 | Multimodal indication input (agent contract + threading) | `dcb95b99` | `8287d2ae` | APPROVE |
| 5b Stage 1 | Ghost preview state machine + agent emission contract | `9a6a33f4` | `e506ceb3` | APPROVE |
| 5f | ExtensionRegistry deferral docs | `6d9bc8af` | `59f34fb9` | APPROVE |

### Per-sub-phase highlights

- **5a Vision** — `VisionClient` v2 (Gemini Files API + header auth + timeouts + SCHEMA_VERSION), `VisionToolExecutor` wired at boot, end-to-end integration test against stubbed Gemini, DB-backed `VisionCache` dedup verified.
- **5e Session memory** — `SessionCompactor` with 150_000-token threshold + Anthropic-summarizer factory; per-session async mutex with rejection-safe tail capture in `createMessageHandler`; `applyCompaction` combined-write on `SessionManager`; system-prompt injection of summary; `agent.session_compacted` runtime event.
- **5c Conflict markers** — `MemoryStore.writeConflictMarker` (token-gated) + `readConflictMarker` + `listConflictMarkers`; `MemoryLoader.loadConflictMarkers` newest-first; `MemoryExtractor` writes on consecutive-rejection threshold; YAML scalar escaping via `serializeYamlScalar` for `:`/`\n`/leading-special chars; "Active conflicts" prompt section.
- **5d Stage 1 Multimodal** — `routes/chat.ts` Zod schema for `annotations` (1..N spatial + 0..N temporal + `ghostRef`) and `annotatedFrame` (mediaType enum + 12MB base64 cap); 16MB body limit middleware; `MessageHandler` 4th+5th args; `master-agent.runTurn` extended; `AgentRuntime.run` accepts multi-block `userContent` for vision blocks (text + image source); prompt-injection guard via backtick rendering.
- **5b Stage 1 Ghost preview** — `ProposedElement` schema (ghostId, kind, dependsOn) + `confidence` field on `PendingChangeset`; `ChangesetManager` emits `changeset.proposed | .approved | .rejected` on `EventBus` with proposing-turn `sessionId` echo; pure-TS state machine in `@opencut/core` (`proposed → previewing → accepted → committed` + off-paths `invalidated/stale`); `propagateStale` fixed-point algorithm; SSE serializer flat-shape fix with envelope-wins spread order.
- **5f Deferral docs** — Top-of-file deferral docstring on `ExtensionRegistry` covering STATUS/WHY/WHEN/WHAT-NOT-TO-DO; audit plan §5f marked DEFERRED with cross-reference to the docstring.

### Verification

- **Tests:** `apps/agent` 1349/1349 vitest pass; `packages/core` 84/84 pass
- **Type-check:** zero new tsc errors in any Phase 5 file (pre-existing errors documented below are out of scope)
- **Lint:** biome clean on all Phase 5 files

---

## 🚧 Left behind (intentional deferrals, awaiting future work)

### 5d Stage 2 — Web canvas overlay UI

Stage 1 shipped the agent contract; Stage 2 is the browser UI that
captures annotations and the annotated preview frame. Deferred per
user choice (option a) and CLAUDE.md UI-verification rule (browser
testing required).

**Scope:**
1. Annotation tool on the preview canvas (`apps/web/src/components/editor/preview/preview-interaction-overlay.tsx` already exists as scaffolding)
2. Rectangle-draw mode (0..1 normalized coords matching `SpatialAnnotationSchema`)
3. Temporal-range mode (`startSec` / `endSec`, validated client-side to match the `endSec > startSec` server refine)
4. Optional free-text label scribble
5. Frame capture: snapshot the preview canvas at annotation time → base64 PNG/JPEG → POST as `annotatedFrame.base64`
6. Wire into `useChat` `sendMessage()` so annotations + annotatedFrame flow alongside the message text
7. UX for ghost references (`ghostRef.ghostId`) — depends on 5b Stage 2 landing first

**Acceptance:** user can draw a rectangle on the preview, type "remove this", and the agent receives the box coords + the rendered preview frame as a multimodal vision input.

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

These were observed while implementing Phase 5 but predate the work
and were not regressed by it. Each warrants a separate ticket.

### NEW-1 — `preview-render-worker` SSE events drop at session filter

**Severity:** MEDIUM
**Location:** `apps/agent/src/services/preview-render-worker.ts:158-170` and `:259-268`
**Origin:** Phase 3 Stage E (verified by `git blame` — sessionId never threaded at this worker)

The `tool.progress` and `exploration.candidate_ready` events emitted by
the preview-render worker omit `sessionId`. The per-session SSE filter
at `apps/agent/src/routes/events.ts:37` drops events whose `sessionId`
doesn't match the subscriber's session. So even though the Phase 5b
CRIT-1 close-out fixed the consumer-side read shape in `use-chat.ts`,
the consumer never receives the worker's events because they fail the
session-equality check upstream.

**Other `tool.progress` emit sites** (e.g. `tool-pipeline.ts:298-309`)
DO carry `sessionId` via the Phase 5a HIGH-1 `wrappedProgress` plumbing
and benefit from the Phase 5b CRIT-1 read fix immediately. Only the
preview-render worker is affected.

**Fix:** thread `sessionId` into `PreviewRenderJobData` at enqueue time;
include it in both worker emit objects so the route filter matches.

---

### 5b multi-tab cross-session SSE gap

**Severity:** MEDIUM (intentional v1 deferral per Q5=a)
**Location:** `apps/agent/src/changeset/changeset-manager.ts` `finalizeDecision()`

A second browser tab open to the same project (different chat session)
will NOT see `changeset.approved` / `.rejected` SSE updates because
the manager echoes the proposing-turn's `sessionId` and the per-session
SSE filter is strict-equality. Tab B's ghosts stay in `proposed` style
after Tab A approves the changeset.

Documented at the emit site with two future remediation paths:
1. Add a `projectId:` filter fallback in `routes/events.ts` matching
   when the subscriber has no sessionId set but owns the project
2. Emit a second broadcast event on a project-scoped channel

---

### Undo of accepted ghost / ghost-of-ghost

**Severity:** LOW (intentional v1 deferral per Q5=a)
**Location:** N/A — feature gap, not a code bug

The current Phase 5b state machine has no `accepted → proposed` or
`committed → proposed` transitions. Once a ghost commits, it's
permanent from the ghost-overlay perspective; undo flows through the
underlying ChangeLog / SerialEditorCore. A "ghost of a ghost" (the
agent proposes a change to a ghost not yet committed) is also outside
v1 scope.

---

### Pre-existing tsc errors (multiple files, not Phase 5 regressions)

These were flagged by `npx tsc --noEmit` throughout Phase 5 verification
but exist on `main` independent of any Phase 5 commit. None block
runtime behavior — they're type-system drifts and missing annotations.

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

## Sequencing

The plan's recommended sequence held: 5a → 5e → 5c → 5d → 5b → 5f.
Smallest/agent-only first, biggest/web-heavy last, pure-docs closing
the phase. The per-stage reviewer rhythm (review → close findings →
re-review where needed) caught real defects in every sub-phase except
5f (which only had paraphrase + path nits).

## Standing rules honored

- **Per-stage reviewer pass after every commit set** — every sub-phase
  was reviewed; close-outs were re-reviewed where the first pass
  returned REQUEST CHANGES. No "self-approve in same context" violations.
- **"Address them all"** — every reviewer finding was either fixed in
  a close-out commit or explicitly documented as out-of-scope deferral
  (5b MED-2 multi-tab, NEW-1 preview-render-worker).
- **Decisions confirmed before code lands** — every sub-phase's
  Decisions block was answered by the user before implementation
  started; no surprises.
- **CLAUDE.md UI-verification rule** — both web-heavy stages
  (5d Stage 2, 5b Stage 2) deferred rather than shipped untested.

---

## Next likely work

In rough priority order, ranked by user-visible value:

1. **5b Stage 2 — Web ghost preview UI.** Largest user-facing payoff;
   agent contract is already shipping ghost data the web is currently
   discarding.
2. **NEW-1 fix — sessionId threading at preview-render-worker.**
   Unblocks the existing `tool.progress` + `candidate_ready` SSE
   handlers that have been silently dead since Phase 3 Stage E.
3. **5d Stage 2 — Web canvas overlay UI.** Smaller scope than 5b
   Stage 2 but blocked on UX decisions about the annotation tool
   affordances.
4. **tsc/biome cleanup pass.** Boring but reduces friction on every
   future review.

The `wiring-audit-remediation.md` audit plan now has every Phase 5 row
marked complete (or DEFERRED with a cross-reference). Phases 1–4 were
already closed before Phase 5 began.
