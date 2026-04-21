# Intent UX Design Review — ChatCut

**Date:** 2026-04-21
**Author:** design-review pass after Phase 5 closure
**Source article:** Jakob Nielsen, *"Intent UX"* — `https://jakobnielsenphd.substack.com/p/intent-ux`
**Companion doc:** `chatcut-ux-design.md` (existing UX baseline)

A review of ChatCut's current UI through the lens of Jakob Nielsen's
"Intent UX" framework. The aim is to identify which Phase 6+ UI work
will move us furthest toward the post-chat AI-product paradigm Nielsen
describes — and which deferred Phase 5 stages are already on that
critical path.

---

## TL;DR

ChatCut already has six of the data-layer pieces Nielsen says Intent
UX requires (most products score 1–2). **The leverage isn't in the
chat panel — it's in making the timeline and preview the orchestration
surface.** Two deferred Phase 5 Stage 2s (5b ghost UI + 5d canvas
overlay) are the highest-impact next moves for Intent-UX alignment.

---

## Nielsen's framework (synthesis)

### The shift

| Era | User role | Interaction unit |
|---|---|---|
| Batch (1960s) | Workflow author | Submitted job |
| Command/GUI (1960–2025) | Operator | Step at a time |
| Intent (2026+) | **Supervisor** | **Outcome + constraints + delegation boundary** |

> "You no longer tell the computer *how*. You tell it *what* you want
> accomplished."

### The triple-layered architecture

1. **Intent Surface** — multimodal capture; implicit context (calendar,
   active screen, cursor hesitation); avoid the articulation barrier.
2. **Orchestration Surface** — proposed plan + provenance + consent
   *before* execution; post-action receipts after; conflict negotiation
   for collaborative intent.
3. **Direct-Manipulation Surface** — fallback for granular correction;
   user manipulates *plans*, not raw controls.

### Reframed usability metrics

| Old | New (Intent-UX) |
|---|---|
| Discoverability | Intent Capture — vague request → structured action |
| Error prevention | Clarification quality — best question prevents biggest mistake |
| Time to learn | Ease of delegation |
| Execution efficiency | **Verification efficiency** — execution is cheap, evaluation is the bottleneck |
| System status | Execution transparency |
| User satisfaction | Trust calibration with counterfactual explanation |

### Anti-patterns Nielsen names

- **Articulation barrier** — chat-as-input forces literacy + prompt
  engineering on everyone; ~50% of users in rich countries lack the
  literacy to write good prompts.
- **Plausibility trap** — clean AI output triggers authority bias.
- **Cognitive atrophy loop** — users become passengers; designs should
  be "cognitive exoskeletons, not wheelchairs."
- **Slow-AI anxiety** — long jobs without conceptual breadcrumbs cause
  sunk-cost-fallacy acceptance of substandard output.

### The "intent by discovery" patterns (longer term)

Semantic topographies, direct object manipulation, Socratic scaffolding,
ephemeral generative UIs, multimodal curation, subtractive sculpting.

---

## Where ChatCut already aligns

| Nielsen principle | Existing ChatCut implementation |
|---|---|
| Permission choreography | `propose_changes` tool + changeset approve/reject (B5 IDOR-closed) |
| Execution transparency | Per-session SSE event stream (`tool.progress`, `agent.turn_*`) |
| Counterfactual explanation | `explore_options` fan-out (4 candidates) |
| Provenance | Changeset stamps `injectedMemoryIds` / `injectedSkillIds` per spec §9.4 |
| Trust calibration | Phase 5b `confidence ∈ [0,1]` per ghost (LLM self-report) |
| Subtractive sculpting | Timeline IS this — clips exist, agent removes/trims |

Six of six at the data layer. **Almost none rendered yet.**

---

## Gaps Nielsen would flag

### Gap 1 — The chat panel is doing too much work

Today the chat is the only place where *plan*, *progress*, *approval*,
and *result* surface. Nielsen's Orchestration Surface says these
should fragment to where the user's eye already is — the timeline
(for ghost approval) and the preview (for "show me the diff").

**Highest-leverage moves:**
- Ship **5b Stage 2** (web ghost UI) — confidence-coded ghost overlay
  on timeline = ZERO chat noise for the "delete clip 3" turn. The
  chat reduces to a single "OK done" rather than a 5-bubble approve /
  preview / commit thread.
- Ship **5d Stage 2** (canvas overlay) — user gestures the box on the
  preview, externalizing intent without the articulation barrier.

### Gap 2 — Evaluation, not execution, is the bottleneck

The current changeset card shows a one-line summary + Approve / Reject.
This makes the user trust the agent's *prose about* what it did, not
what it actually did. Verification efficiency is the bottleneck, same
as everyone's.

**Highest-leverage moves:**
- Side-by-side timeline diff in the changeset review modal: ghost
  layer vs. current state, with a scrubber pre-positioned at the
  affected timecode.
- "Why this?" disclosure on each changeset showing
  `injectedMemoryIds` + `injectedSkillIds` in human-readable form.
  We *have* the data — we just don't render it.

### Gap 3 — Cognitive atrophy loop in a creative tool

Nielsen warns: if users only ever say "fix it" and the agent fixes it,
they deskill. ChatCut is a *creative* tool, not a productivity tool —
the user's taste IS the product. We should bias toward "intent by
discovery" patterns.

**Highest-leverage moves:**
- `explore_options` already ships 4 candidates — but the candidate
  cards stack vertically in chat. Borrow Nielsen's "semantic
  topographies": lay them out as a 2D map (e.g. pace × tone axes) so
  the user *discovers* preferences by dragging rather than ranking.
- Subtractive sculpting on the timeline: agent proposes a maximalist
  12-clip cut → user shift-clicks to delete clips → agent re-proposes
  preserving the user's deletions. Today they'd type "remove clips 3,
  7, 11" — articulation barrier.

### Gap 4 — Slow-AI anxiety in fan-out exploration

Modal MP4 renders take seconds-minutes per candidate, but **fan-out is
N×render**. Nielsen would say: progress bars are useless past 30
seconds; you need *conceptual breadcrumbs* (which clip is rendering,
what assumption it's testing) and salvage value (let the user freeze a
partial-quality preview if 1/4 candidates is "good enough" already).

**Highest-leverage moves:**
- Stream rough preview frames as Modal renders proceed, not just the
  final MP4. We have `tool.progress` SSE infra — extend the worker to
  emit thumbnail strips at 25% / 50% / 75% checkpoints.
- "Pick this one even though others still rendering" — early-exit
  saves 75% of compute when a candidate is obviously right at second 5.

### Gap 5 — Articulation barrier is the immediate crisis

Nielsen hits this hardest. Text prompts are the worst possible
interface for taste. Phase 5d shipped the agent contract for
`annotatedFrame` + spatial annotations — Stage 2 is the canvas
overlay. **This is the highest-impact single piece of deferred work
for Intent-UX alignment.**

---

## Recommendations ranked by leverage

| # | Move | Effort | Impact | Status |
|---|---|---|---|---|
| 1 | **5b Stage 2** — web ghost UI on timeline | ~2d | Moves orchestration off chat onto timeline; flips product feel from "AI chatbot" to "AI collaborator" | Deferred |
| 2 | Confidence-coded ghost border styling | ~0.5d | Already shipping `confidence` field; CSS work; trust calibration on by default | Subset of #1 |
| 3 | **5d Stage 2** — canvas overlay for spatial intent | ~1.5d | Defeats articulation barrier; pairs with multimodal input shipped in 5d Stage 1 | Deferred |
| 4 | "Why this?" provenance pop-over on changesets | ~1d | Uses data the agent already stamps; users trust without our asking | New |
| 5 | Stream-thumbnail breadcrumbs from preview-render worker | ~1.5d | Defeats slow-AI anxiety in fan-out; salvage value on early-exit | New (depends on NEW-1 sessionId fix) |
| 6 | Semantic-topography candidate layout (2D map) | ~3-5d | `explore_options` becomes discovery surface, not a list | New, larger |
| 7 | Subtractive-sculpting flow (delete-then-replan) | ~2d | Inverts the prompt → output direction; user taste drives the loop | New |

---

## Strategic framing

ChatCut's Phase 5 work didn't just close audit gaps — it built the
primitives Nielsen says Intent UX requires. The product is structurally
ready to be one of the few AI tools that gets *past* the chat-as-
everything paradigm. The remaining gap is almost entirely a
**rendering** problem: agent emits ghost diffs + confidence scores +
provenance + conflict markers, web discards or under-renders all of
them.

Phase 6 — if we run one — should be **"Make the timeline the
orchestration surface."** That single framing covers items 1, 2, 3, 4
in the table above and would give us a product that's qualitatively
different from prompt-based competitors.

---

## What this doc is NOT

- Not a committed plan. No commit hashes, no decision blocks, no
  acceptance criteria. Phase-grade plans go in `.omc/plans/`.
- Not a critique of Phase 1–5. Those landed clean. This is a
  forward-looking design lens, not a retrospective.
- Not exhaustive. Nielsen's "intent by discovery" patterns
  (ephemeral generative UIs, multimodal curation, Socratic
  scaffolding) are mentioned but not elaborated; they're worth a
  separate pass once items 1–4 ship.

If we want to commit to any of the leverage items, the next step is a
`.omc/plans/phase-6-intent-ux.md` with the standard Tasks + Decisions +
Acceptance structure mirroring Phase 5's rhythm.
