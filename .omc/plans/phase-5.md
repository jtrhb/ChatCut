# Plan: Phase 5 — Remaining §C audit items (combined)

Six independent sub-phases, all derived from `.omc/plans/wiring-audit-remediation.md` §"Phase 5 — Remaining §C items". Order chosen to stage risk: smallest/agent-only first, biggest/web-heavy last.

Date: 2026-04-21

**Status:**
- 5a — pending. Vision Agent ↔ Gemini end-to-end (verify + integration test).
- 5e — pending. Session memory wiring (compaction + summary persistence).
- 5c — pending. Conflict marker `_conflicts/` flow.
- 5d — pending. Multimodal indication input.
- 5b — pending. Ghost preview state machine.
- 5f — pending. ExtensionRegistry deferral note.

Per-sub-phase reviewer pass after each commit set, matching the Phase 3 rhythm. Each sub-phase below has its own §"Tasks" + §"Decisions" block; decisions need user confirmation before code lands.

---

## 0. Recon highlights (what's already wired vs net-new)

| Sub-phase | Existing in tree | Net-new |
|-----------|------------------|---------|
| **5a** Vision | `vision-client.ts` (real Gemini REST call), `vision-tools.ts` (3 tools), `vision-cache.ts` (DB-backed), `vision-agent.ts` registered as `dispatch_vision` | Integration test against stubbed Gemini; verify cache hit path |
| **5b** Ghost | timeline + preview render machinery; `use-chat.ts` SSE consumer | `apps/web/src/lib/ghost/`, `use-ghosts.ts`, ghost layer in timeline, `changeset_update` SSE handler, conflict-detection wiring |
| **5c** Conflicts | `MemoryExtractor` has rejection counting + signal classification; `MemoryLoader` template already includes `_conflicts/*` (audit claim verified) | `MemoryStore.writeConflictMarker`, extractor → marker handoff, prompt surfacing |
| **5d** Multimodal | `routes/chat.ts` Zod schema; `master-agent.runTurn` passes plain string; `preview-interaction-overlay.tsx` exists | Schema fields (`temporal`, `spatial`, `ghostRef`); annotation overlay; `MessageParam` content-block wrapping in runtime |
| **5e** Session memory | `SessionMemory` class with `record/summarize/toPromptText`; `AgentSession.metadata` is open | `summary` field on AgentSession; compaction trigger in runtime; system-prompt injection of summary |
| **5f** Extension registry | `ExtensionRegistry` exists with full API | Zero callers — just deferral docs |

---

## 1. Sub-phase 5a — Vision Agent ↔ Gemini end-to-end (~0.5d, was 1d)

Audit overestimated; the wiring is already in place. Real work is **verification + integration test + any audit-discovered fixes**.

### Tasks

| # | Task | Location |
|---|------|----------|
| 5a.1 | Audit `vision-client.ts` against actual Gemini API contract — check request shape, error handling, progress emission, timeout behavior | `apps/agent/src/services/vision-client.ts` |
| 5a.2 | Audit `vision-tools.ts` — verify all three tools (`analyze_video`, `locate_scene`, `describe_frame`) wire client output cleanly into the tool-pipeline schema | `apps/agent/src/tools/vision-tools.ts` |
| 5a.3 | Verify `VisionCache` keys by `mediaHash + schemaVersion` and that schema version bumps invalidate; spot-check the DB-backed cache | `apps/agent/src/services/vision-cache.ts` |
| 5a.4 | Integration test: stub Gemini fetch (canned `VideoAnalysis` JSON) → exercise `vision-agent.dispatch_vision` → assert structured scenes returned + cached | new test |

### Decisions (need lean confirmation)

- **5a-Q1: Gemini model parameterization.** Today `vision-client.ts:35` hardcodes `gemini-2.5-pro`. Lean: keep hardcoded for v1; promote to env var only if a second consumer (e.g. cheaper `gemini-2.5-flash` for thumbnails) appears.
- **5a-Q2: Schema-version bump policy.** `mediaHash + schemaVersion` is the cache key. When does `schemaVersion` bump? Lean: bump on output-shape changes only (adding/removing a field on `VideoAnalysis`), NOT on prompt tweaks — prompt-side changes ride on the next mediaHash mismatch.
- **5a-Q3: Test depth.** Lean: stub at the `fetch` boundary (canned JSON) + assert tool-pipeline output. Skip Gemini-specific edge cases (rate limits, partial JSON) — those belong to a Gemini integration suite, not a Phase 5 test.

### Acceptance

- All three vision tools have unit tests against stubbed Gemini.
- Cache hit/miss paths covered.
- `VisionAgent.dispatch_vision({prompt})` returns structured `VideoAnalysis` end-to-end.

---

## 2. Sub-phase 5e — Session memory wiring (1d)

Net-new infrastructure: `SessionMemory` class exists; nothing calls `summarize()` automatically and there's no compaction trigger.

### Tasks

| # | Task | Location |
|---|------|----------|
| 5e.1 | Add `summary?: string` field to `AgentSession` shape | `apps/agent/src/session/types.ts` |
| 5e.2 | Add token-threshold compaction trigger in `MasterAgent.runTurn` (or a hook layer): when in-context history exceeds threshold, call `SessionMemory.summarize()` and persist | `apps/agent/src/agents/master-agent.ts` + new `compactSession` helper |
| 5e.3 | Inject `session.summary` into the system prompt on subsequent turns so the agent has continuity after compaction | `apps/agent/src/agents/master-agent.ts` (system prompt builder) |
| 5e.4 | Persist `summary` on `SessionStore.update` when compaction fires | `apps/agent/src/session/session-store.ts` |
| 5e.5 | Tests: compaction triggers at threshold; summary survives session resume; system prompt carries it forward | new test |

### Decisions

- **5e-Q1: Compaction trigger.** Lean: token-count threshold (e.g. 30 000 of the 200K context window — leaves headroom for the next turn + tool calls + injected memory). Alternatives: turn count (simpler but inaccurate for long single-turn tool spirals), hybrid.
- **5e-Q2: Summary generator.** Lean: cheap+fast separate LLM call (`claude-haiku-4-5`) with a fixed "summarize this conversation in N bullets" prompt. Alternative: template-extract from `SessionMemory.entries` without an LLM (faster + free but loses conversational nuance).
- **5e-Q3: Summary location.** Lean: explicit `AgentSession.summary` field (`text` in DB if persisted; in-memory if not). Alternative: stash inside `metadata` jsonb — flexible but harder to query.
- **5e-Q4: Replacement vs. layering.** When compaction fires, do we (a) drop pre-summary messages from the in-context history (true compaction; fits the audit's "compaction path" framing), or (b) keep them as a long tail with the summary as a header (safer but pointless if the goal is context-window relief)? Lean: (a) — anything else isn't actually compaction.

### Acceptance

- Long conversation → token threshold crossed → compaction fires → next turn sees summary in system prompt + dropped pre-summary messages.
- Session resume after restart sees the persisted summary, not just the message tail.

---

## 3. Sub-phase 5c — Conflict marker `_conflicts/` flow (~0.75d)

Memory loader already enumerates `_conflicts/*` (verified). Need to: (a) detect contradictions, (b) write the marker file, (c) make sure the agent surfaces them in prompts.

### Tasks

| # | Task | Location |
|---|------|----------|
| 5c.1 | Add `MemoryStore.writeConflictMarker({target, signal, reason})` — writes to `_conflicts/{markerId}.md` with frontmatter pointing at the conflicting memory file | `apps/agent/src/memory/memory-store.ts` |
| 5c.2 | `MemoryExtractor` calls writeConflictMarker when it detects a high-severity rejection that contradicts an existing memory (re-uses the existing rejection-counting logic at `memory-extractor.ts:256-277`) | `apps/agent/src/memory/memory-extractor.ts` |
| 5c.3 | Verify `loadCandidatesFromTemplate` includes `_conflicts/*` (audit said it does — confirmed; just add a regression test) | new test |
| 5c.4 | System prompt: conflict markers get a dedicated "Active conflicts" section so the LLM sees them naturally | `apps/agent/src/agents/master-agent.ts` (prompt builder) |
| 5c.5 | Tests: synthesize a contradiction → marker file appears → next prompt carries it | new test |

### Decisions

- **5c-Q1: Trigger threshold.** Lean: 3 consecutive rejections of similar action against the same target. Single-shot is too noisy; the `countConsecutiveRejections` helper already exists.
- **5c-Q2: Marker file shape.** Lean: `_conflicts/{ISO-timestamp}-{actionType}-{shortHash}.md` with YAML frontmatter (`{conflictsWith: [paths], severity, lastSeenAt}`) + free-text body. ISO prefix gives natural sort order.
- **5c-Q3: Prompt surfacing.** Lean: dedicated "Active conflicts (do not repeat)" section in the system prompt, fed by the `_conflicts/*` loader hits. Alternative: prepend to user message — less reliable, and conflicts aren't user content.
- **5c-Q4: Conflict resolution / clearing.** Lean: out-of-scope for Phase 5c. The marker stays until manually cleared (or a future "user accepted variant of this previously-rejected pattern" flow ages it out). Document this gap.

### Acceptance

- 3 consecutive rejections of `delete clip X` → `_conflicts/{ts}-delete-{hash}.md` appears.
- Next conversation turn includes the marker in the system prompt.
- Loader template test asserts `_conflicts/*` glob still resolves.

---

## 4. Sub-phase 5d — Multimodal indication input (1.5d)

Full-stack: web canvas overlay → chat schema fields → MasterAgent prompt threading → Anthropic content-block wrapping.

### Tasks

| # | Task | Location |
|---|------|----------|
| 5d.1 | Extend chat schema with optional `temporal` (`{startSec, endSec}`), `spatial` (`{x, y, w, h}` 0..1 normalized), `ghostRef` (`{ghostId}`) | `apps/agent/src/routes/chat.ts:30` |
| 5d.2 | Web canvas overlay for circle/box drawing + free-text annotation; emits the schema shape on send | `apps/web/src/components/editor/panels/preview/preview-interaction-overlay.tsx` (or new sibling) |
| 5d.3 | Pass annotations through `MasterAgent.runTurn` into the model: serialize spatial/temporal as a structured prefix in the user message + (for spatial annotations only) attach the **annotated frame** (overlay drawn on the captured frame *before* base64 encoding) as an Anthropic vision block. Annotation drawn on the frame is what carries the "I mean THIS one" signal — raw frame + coords-as-text is strictly worse | `apps/agent/src/agents/master-agent.ts:runTurn` |
| 5d.4 | Defer SAM2 client snap (audit §6 R6-3 explicitly defers this — tracked as Phase 5d.4 deferred row in plan, not implemented) | n/a |
| 5d.5 | Tests: chat route accepts new fields; runTurn passes them to the model; web overlay round-trips a draw → send → echo back | new tests |

### Decisions

- **5d-Q1: How does Claude get visual grounding for spatial annotations?** Two distinct vision needs are at play:
   1. *Video content understanding* — Gemini's domain (the existing Vision Agent, 5a)
   2. *User intent grounding* — "which of the three similar objects did the user circle?" — the annotation itself is the signal
   Options: **(a)** coords + descriptive text only (Claude guesses across ambiguity), **(b)** raw frame + coords-as-text as Anthropic vision block, **(c)** Vision Agent dispatch only (Gemini describes; Claude reads the description), **(d)** **annotated frame** (the captured frame with the user's box/circle drawn on top, *then* base64-encoded) as Anthropic vision block + coords in the schema for programmatic use, with Gemini dispatch deferred to follow-up only when Claude needs deeper scene/temporal context.
   Lean: **(d)**. Reasons: (a) loses intent grounding entirely; (b) is strictly worse than (d) — the overlay drawn on the frame is what makes "I mean THIS one" unambiguous, raw-frame-plus-text-coords forces Claude to reconstruct visualization from numbers; (c) duplicates work and loses direct visual grounding for spatial cases; (d) keeps Gemini's video-understanding role intact, gives Claude direct "see what was circled" signal, and pays vision-block cost (~1.5K tokens per *annotated* message — most messages have no annotation and pay nothing).
- **5d-Q2: Annotation persistence.** Lean: ephemeral. Annotations clear from the overlay on send and don't replay on session resume — they're a one-shot indication. (If users want recall, that's a separate feature.)
- **5d-Q3: Multiple annotations per message.** Lean: support 1..N spatial + 0..N temporal in the schema (arrays), but UI defaults to single-shot (drag once → annotation locked in).
- **5d-Q4: Coordinate space.** Lean: 0..1 normalized against preview canvas (resolution-independent), NOT pixel coords. Server side, the same normalized form lands in the prompt.

### Acceptance

- User can draw a box on the preview, type "remove this", press send.
- Server receives `{message, spatial: [{x,y,w,h}], temporal?: {...}}` + a base64 still frame.
- The model reply references the annotated region in some grounded way (verify in integration test by mocking the model and asserting the formatted prompt).

---

## 5. Sub-phase 5b — Ghost preview state machine (2d)

Largest sub-phase. Net-new across web. State machine + store + timeline rendering + invalidation logic + UX confidence indicator.

### Tasks

| # | Task | Location |
|---|------|----------|
| 5b.1 | Define ghost state machine: `proposed → previewing → accepted → committed`; off-paths `invalidated` + `stale`. Pure TS, no React. Includes transition validators. | new `apps/web/src/lib/ghost/ghost-state.ts` |
| 5b.2 | Verify or add `changeset_update` SSE event consumption (audit recon shows it's NOT wired on web today — that's a prerequisite). Confirm event payload shape matches what the agent emits. | `apps/web/src/hooks/use-chat.ts` + agent-side check |
| 5b.3 | New `useGhosts` hook: subscribes to changeset SSE, holds Map<ghostId, GhostState>, exposes `accept` / `reject` / `dismiss` actions | new `apps/web/src/hooks/use-ghosts.ts` |
| 5b.4 | Render ghost layer in timeline alongside committed elements: faded variant of the timeline-element render, with confidence-coded border | `apps/web/src/components/editor/panels/timeline/timeline-element.tsx` (extend) |
| 5b.5 | Conflict / stale detection: when a committed Change Log entry edits an underlying element, mark dependent ghosts `stale`. Hook listens to whatever SSE event signals committed mutations. | `use-ghosts.ts` + Change Log SSE wiring check |
| 5b.6 | Confidence indicator: per-ghost border style by confidence band (high/medium/low). Confidence comes from the changeset payload. | timeline-element styling |
| 5b.7 | Tests: state machine transitions; useGhosts subscribes + reduces SSE; stale invalidation on conflicting commit | new tests |

### Decisions

- **5b-Q1: Ghost store location.** Lean: dedicated `useGhosts` hook with internal Map state (not Zustand). Alternative: extend `preview-store` (couples concerns). Pure-React local state in the timeline panel is too narrow — ghosts can outlive a single panel mount.
- **5b-Q2: SSE `changeset_update` payload.** Need to verify the event shape the agent emits today (only `status` flips for approve/reject?). If the payload doesn't carry the proposed timeline diff, ghosts have nothing to render — that's a blocking dependency. Lean: extend the agent-side emit to include the proposed elements, gated behind a Phase 5b flag if needed for backward compat.
- **5b-Q3: Stale invalidation trigger.** Lean: react to the existing changeset-committed signal (which we already emit). Each ghost carries `dependsOn: [elementId, ...]`; if any dependency appears in a committed mutation's affected-elements set, ghost flips to `stale`. Alternative: time-based polling — wasteful.
- **5b-Q4: Confidence value source.** Where does confidence come from? Lean: the LLM's own self-report in the proposed changeset (a `confidence: number` field on each proposed element). If it's not there today, default to "medium" and add the field to the changeset schema as part of 5b. Alternative: derive heuristically (number of dependencies, action type) — fragile.
- **5b-Q5: Out-of-scope for v1.** Lean: undo of an accepted ghost (re-spawning the proposed state) is NOT in 5b — needs a richer history model. Same for ghost-of-a-ghost (chained proposals).

### Acceptance

- LLM proposes a changeset → SSE `changeset_update(proposed)` → ghost appears on timeline with confidence-coded border.
- User accepts → state transitions through `previewing → accepted → committed` → ghost converts to a real element.
- User edits an underlying element → ghost flips to `stale`.
- State-machine unit tests cover all transitions including off-paths.

---

## 6. Sub-phase 5f — ExtensionRegistry deferral (~0.25d, docs)

Per `borrowing-review Round 10`: 先要有 extension contract，再谈 extension ecosystem. Registry exists with no callers; document the "wait for first concrete extension" decision.

### Tasks

| # | Task | Location |
|---|------|----------|
| 5f.1 | Add a deferral docstring at the top of `extension-registry.ts` explaining the "no callers, awaiting first concrete extension contract" decision. Reference borrowing-review Round 10. | `apps/agent/src/extensions/extension-registry.ts` |
| 5f.2 | Mark the audit-plan row as "deferred — see extension-registry.ts header" | `.omc/plans/wiring-audit-remediation.md` |

### Decisions

None. Pure docs.

### Acceptance

- Future contributor reading `extension-registry.ts` understands why it's unwired, what would prompt wiring, and where the broader rationale lives.

---

## 7. Sequencing + estimates

| Sub-phase | Estimate | Why this position |
|-----------|----------|-------------------|
| 5a | 0.5d | Smallest. Validates the "verify + integration test" loop. |
| 5e | 1d | Agent-internal. Pairs with 5a's pattern. |
| 5c | 0.75d | Memory layer extension. Builds on 5e's session-prompt context. |
| 5d | 1.5d | First full-stack. Introduces the web ↔ agent rhythm. |
| 5b | 2d | The big one. Web-heavy. Save until the rhythm is established. |
| 5f | 0.25d | Pure docs. Closes the phase. |

**Total: ~6d** (audit's per-phase total was 6.5d; -0.5d from 5a being already-wired).

Per-stage commit pattern + reviewer pass after each sub-phase, matching Phase 3.

---

## 8. Out of scope for Phase 5

- SAM2 client-side snap (5d-deferred per audit).
- Undo of accepted ghosts (5b-Q5).
- Conflict-marker auto-resolution / aging (5c-Q4).
- Extension contract design (5f → wait for first real extension).
- Multi-modal *output* (image generation in chat replies) — separate roadmap item.

---

## 9. Decision questions awaiting confirmation

To unblock 5a:
- 5a-Q1, 5a-Q2, 5a-Q3

To unblock 5e:
- 5e-Q1 (token threshold), 5e-Q2 (summary generator), 5e-Q3 (location), 5e-Q4 (replacement vs layering)

To unblock 5c:
- 5c-Q1, 5c-Q2, 5c-Q3, 5c-Q4

To unblock 5d:
- 5d-Q1 (visual grounding shape — annotated frame to Claude + Gemini deferred), 5d-Q2, 5d-Q3, 5d-Q4

To unblock 5b:
- 5b-Q1, 5b-Q2 (the load-bearing one — depends on whether agent's `changeset_update` already carries the proposed diff), 5b-Q3, 5b-Q4 (confidence source), 5b-Q5

5f has no decisions.

If any answer changes the architecture, this plan re-circulates before the affected sub-phase starts.
