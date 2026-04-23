# ChatCut UX Vision — Synthesis of one design conversation

**Date:** 2026-04-22
**Author:** captured from a single working session
**Companion docs:**
- `intent-ux-design-review.md` — Nielsen's Intent UX framework applied to ChatCut. Seeded much of this work.
- `chatcut-discussion-summary.md` — parallel product-positioning thread (copilot vs autopilot, Creator vs Campaign mode, MVP ordering).
- `chatcut-ux-design.md` — existing UX baseline.

This doc captures the **mental model + interaction design + engineering
plan** that emerged from one push to answer: "given the Intent-UX
direction, what does the product actually look and feel like, and how do
we build it without it becoming sluggish?"

It is not a committed plan. There are no acceptance criteria, commit
hashes, or phase boundaries. Phase-grade plans go in `.omc/plans/`.
This is the design lens future contributors should think *with*, not
the contract they execute *against*.

---

## TL;DR

The biggest single design insight: **there are not many timelines.
There is one canonical path through a graph of moments**, and every
"timeline" people normally talk about (media bin, generation output,
exploration variants, edit history, nested compositions) is just a
different traversal of that same graph. Collapsing five UI metaphors
into one is the entire UX win.

Three orthogonal threads support that core:

1. **The unified-graph surface.** One active path. Lineage glyphs
   above clips reveal alternatives/refinements. A holding strip below
   contains unbound moments tagged with their provenance. No separate
   panels for sources, generations, history, or compositions.
2. **Communication has a location.** The agent never speaks from a
   chat panel. It speaks from where it's working — pinned bubbles on
   clips, contextual prompt fields scoped to selection, ambient status
   strips on the things being processed. A summoned drawer exists for
   the rare prose moments. Voice is the underrated power channel.
3. **Workspace on canvas, chrome on React.** A DOM-based React app
   cannot stay smooth at the density this design implies. The timeline
   and holding strip render via WebGL (PixiJS); React handles only the
   chrome. Aggressive LOD, virtualization, web workers for decoding,
   and tight memory discipline are all required, not optional.

The whole thing is harder to build than "AI chatbox + edit timeline +
asset bin," which is the path of least resistance every other AI editor
is taking. The reward is a product that's **qualitatively** different
rather than incrementally so.

---

## 1. The mental model: one path through a graph of moments

### 1.1 The reframe

Stop thinking about "timeline" as a noun. Think about **moments and
their lineage** as the underlying data model, and "timelines" as just
different *views* over that one graph.

A **moment** is any piece of time-based media. It has:

- A duration
- A source (camera, generation, derived-from-edit)
- A lineage (the parent moment(s) it was made from)
- A binding state (placed in the active cut, or unbound)

That's the whole vocabulary. Everything you currently call a "timeline"
is just a particular traversal of this graph:

| What people call it | What it actually is |
|---|---|
| Media bin / source clips | Unbound moments (root nodes — no parent edits) |
| Generation output | A moment whose parent is a model call |
| `explore_options` candidates | Sibling branches at one point in the active path |
| Edit timeline / working cut | The currently-selected path through the graph |
| Final cut | A path stamped "published" |
| Version history | The genealogy from any moment back to its roots |
| Nested composition | A moment whose source is "an arrangement of other moments" (recursive) |

Five distinct UI metaphors collapse into one. That's the whole
simplification. The agent/changeset model in the codebase is *already*
a partial DAG — this UX direction elevates an existing internal
structure to the primary user-facing concept rather than inventing
something new.

### 1.2 What the user actually sees

**One canonical path through time** — the active cut, what would render
if you exported now. That occupies the screen. Center stage, no
competing surface.

**Alternatives are revealed in place, never on a different page.** Above
each clip in the active path, a tiny lineage indicator: a stack of
three dots means "3 sibling alternatives," a thin row of micro-thumbnails
means "this moment was refined 5 times." Hover/click to expand → the
alternatives unfold as layered ghost lanes lifted directly above the
clip in the same column, scrubbable in unison. Pick one → it becomes
the active path segment. Others recede but remain accessible.

**Source media is just unbound moments** sitting in a thin holding strip
(vertical or below the timeline). Drop one onto the active path → it
binds with the trivial lineage "raw, used as-is." Drag it back off →
it unbinds. No separate "media bin" metaphor.

**Generation outputs follow the same binding rule.** If you generated
*into* a slot (slot-as-prompt — see §3), the output is bound. If you
generated standalone, the output joins the holding strip as an unbound
moment until you place it. Same data, different state.

**Nested compositions are recursive.** Clicking into a composition is
*not* "switching to a different timeline" — it's descending into a
moment whose internal structure happens to be its own sub-graph with
its own active path. Breadcrumb at the top shows nesting depth. Same
surface, recursive.

### 1.3 The metaphor that makes this intuitive

Not infinite canvas. Not git branch tree (too explicit; users don't
want to manage branches). Not multi-tab editing (too parallel; dilutes
attention).

**A road with optional detours.** The main road is the active cut. At
each junction along it, there might be a small sign: "3 alternative
routes through here." Click the sign → the alternatives lift into view
as overlays at that segment. Pick one → it becomes the main road. The
unchosen detours don't disappear; they're still signed at the junction,
you can swap back any time.

You always know where you are: on the main road, moving forward in
time. You always know what else exists: signs at junctions tell you.
You never have to "find your work elsewhere."

### 1.4 The single bird's-eye sentence

> ChatCut should not present timelines. It should present **one active
> path through a living graph of moments**, with every source clip,
> generation, alternative, refinement, and historical version reachable
> as adjacency at the position where it matters.

That single reframe makes the slot-as-prompt, layered-transparency,
lasso-on-canvas, and folded-changes ideas all consistent — they're
each a specific surface manifesting the same underlying model. Without
this frame, they'd just be loosely-related design tricks. With it,
they're one product.

---

## 2. Why infinite canvas is wrong here

Infinite canvas is the fashionable answer for AI tools right now
(ChatGPT Canvas, every agent-builder, half the Y Combinator AI
products). It's wrong for ChatCut specifically — and the reason is a
clue to what's actually more innovative.

### 2.1 Why it's wrong

Video editing has a **canonical artifact** — one timeline, one
timecode, one playhead. Infinite canvas is the right metaphor when
there's no single primary thing (Figma boards, brainstorming, agent
topology). The moment you have a canonical artifact, the canvas
dilutes attention rather than focuses it.

Editors already navigate by *time* (J/K/L, scrub, in/out). Adding
spatial pan-and-zoom on top is friction stacked on muscle memory that
already works. And the one thing canvas is genuinely good at —
non-linear branching exploration — is needed at exactly one moment in
the product: `explore_options` fan-out. That's a bounded modal, not a
worldview.

### 2.2 What's more innovative

The deepest insight: **video editing's "infinite canvas" already
exists, and it's the timeline.** It's infinite along one axis (time),
bounded along the other (tracks). That asymmetry matches the medium.

Three directions that lean into the asymmetry instead of fighting it:

1. **Temporal canvas, not spatial canvas.** The "infinite" dimension
   is *time*, panned via scrub. Alternative cuts hover *above* the
   canonical timeline as translucent ghost lanes. Scrub once → all
   branches play together at the same timecode. You compare by
   listening, not by zooming.

2. **Layered transparency, not zoomed sprawl.** Borrowed from
   Photoshop's layer panel: multiple competing edits exist as stacked
   overlays on the same timeline. Tab through them with `[` and `]`,
   don't pan to them. One canvas, many candidates, zero zoom-out.

3. **Time-as-document.** The video becomes a scrollable artifact like
   a long-form text. AI conversations attach as marginalia anchored to
   specific timecodes (Google Docs comments at `00:01:23`). "Infinity"
   is temporal scroll. This is the most foreign-feeling and the most
   genuinely new — and it matches how editors already think (logging
   notes, mental bookmarks, "the bit at 1:23 needs work").

### 2.3 The honest tradeoff

Infinite canvas would be **easier to ship and more familiar to a VC
pitch deck**, because every design system has it now. Picking the
temporal/layered/document direction means rejecting a known-good
pattern, which is a real cost — but it's also the only way to feel
different from every other AI editor that ships next quarter.

**Cheap test**: prototype direction 2 (layered transparency on a single
timeline) first. It's the smallest delta from current architecture
(ghosts already exist; they need a tab-cycle and a "show all" mode),
and if it doesn't land, the other two definitely won't.

---

## 3. Combining edit and generation: slot-as-prompt + unification

ChatCut isn't just an AI editor of existing footage; it's also a
generative tool (text → video, reference → video). The naive solution
is two modes side-by-side ("Edit" tab, "Generate" tab), with generated
clips dropping into a media bin to be dragged onto the timeline. This
is what every competitor does. It's wrong because it forces the user
to choose mode upfront and disconnects generation from editing context.

### 3.1 The core insight

**Generation is a tool the timeline calls, not a separate mode.**

Every gap on the timeline is implicit generative intent. The duration
is already specified (it's the slot length). The framerate is already
specified (project settings). The audio context is locked (the
surrounding tracks). The neighboring shots constrain the look (color
temperature, lens, framing energy). When the user creates a gap or
selects a placeholder, that gap *is* the prompt context.

So instead of: *"prompt your video into existence in a separate tab,
then drag it in"* — you get: *"the timeline has a 4-second hole on
track 2 between two warm-toned interview shots; type 'kitchen, hands
chopping vegetables' into the gap and the agent generates pre-fitted
footage for that exact slot."*

The output isn't an asset floating in a bin — it's pre-bound to the
slot it was generated *for*. Reject it and the slot reopens. Accept it
and it commits like any other ghost.

### 3.2 Three concrete manifestations

1. **Slot-driven generation.** Click an empty timeline region → ghost
   overlay appears asking for prompt/reference → generation runs with
   the slot metadata as implicit context. The timeline becomes a
   *template* the model fills in. This is exactly how film editors
   brief a B-roll shoot: "4 seconds, kitchen, warm light, tight on
   hands." The slot encodes those constraints automatically — the user
   doesn't have to type them.

2. **Reference-by-pointing doubles as a generation prompt.** The same
   lasso/box canvas annotation surface unifies. Lasso a region in an
   existing clip → "remove this and inpaint what's behind." Drop a
   reference image onto the lasso → "match this look in this region."
   The annotation IS the prompt; you never leave the preview.

3. **Layered transparency unifies edit-ghosts and generate-ghosts.**
   Generated candidates are *just more ghosts on the same timeline*,
   stacked as transparent layers at the relevant timecode. An edit
   solution (trim and reuse existing footage) and a generation
   solution (synthesize new pixels) appear *side by side as competing
   ghost layers* for the same slot. The user reviews them in the same
   surface, with the same accept/reject gestures, the same
   confidence shading. The data model treats them identically: both are
   `ProposedElement` rows with different `kind` discriminators.

### 3.3 The unifying frame

Edits and generations are both **proposals against the timeline's
current state.** A trim removes pixels you have; a generation adds
pixels you didn't. The user-facing primitive is "proposal," not
"edit vs. generate." That single conceptual collapse is the whole
insight — everything else is mechanical follow-through.

### 3.4 Bonus: lazy-evaluated film

Don't render generated pixels in full quality until the user accepts
the ghost. While it's a ghost, it's a low-fidelity preview (a few
frames at 240p — the stream-thumbnail breadcrumbs idea from the Intent
UX review). This compresses generation cost to "things the user
committed to," not "every speculative variant." The Modal worker
infrastructure (Phase 3) already does this for `explore_options`
previews — generation slots into the same machinery; it just calls a
different model on the worker side.

### 3.5 Self-critique: where the slot-as-prompt flow is NOT yet intuitive

The conceptual model is clean, but the v1 user journey has real
friction worth naming honestly:

1. **Discoverability of "the gap is a prompt."** A blank region on a
   timeline traditionally means "I haven't put a clip here yet" — not
   "I am an input field." Without an explicit affordance (a hover `+`,
   a tooltip, *something*), the slot is invisible as a feature. Adding
   the affordance brings back UI noise we just argued against.
   *Mitigation:* a soft `+` glyph on hover that expands into a tiny
   prompt input. Doesn't add a separate panel; it appears contextually.

2. **The duration cage.** If the user knows they want roughly 4s of
   B-roll, they have to commit to 4s *before* seeing what the model
   produces. Maybe the best result is 7s. The slot becomes a cage that
   forces dimension-locking before exploration.
   *Mitigation:* the agent can counter-propose ("I think this wants
   6s — expand the slot?"). Slot-as-starting-point, not slot-as-cage.

3. **First-use is broken.** A new user opens ChatCut with a text prompt
   and an empty project. There is no timeline. There is no slot. Where
   do they type? If we make the empty timeline itself one giant slot,
   we've reinvented the prompt box we were trying to avoid.
   *Mitigation:* the genuinely-empty timeline IS a single special slot
   with one large affordance: "describe the video you want, or drop a
   reference." Once *anything* exists on the timeline, the slot
   mechanic takes over and the giant prompt box disappears.

4. **Iteration cost.** "Warmer," "shorter," "different angle" are the
   workhorse loop of generative work. A ghost needs to support
   **in-place refinement** with the previous prompt pre-filled —
   otherwise users reject-and-re-prompt repeatedly, which is expensive.
   *Mitigation:* clicking an existing ghost re-opens the prompt
   overlay with previous text pre-filled. One gesture for
   create-and-refine.

5. **Audio doesn't fit cleanly.** Slot-as-prompt maps to video tracks
   where clips have discrete boundaries. Music beds run for minutes;
   voiceover doesn't have pre-carved slots. The metaphor strains the
   moment generation is non-visual.
   *Mitigation:* audio gets its own slot model on its own track. Music
   track-as-slot; voiceover clips as slots scoped to speech timing.
   Needs explicit thought, not hand-waving.

### 3.6 Honest pragmatic verdict

The most intuitive parts of the proposal are the **lasso-on-canvas
unification** and the **layered ghost candidates**. The slot-as-prompt
piece is conceptually clean but has the discoverability and bootstrap
problems above.

**Ship the lasso unification first.** It's the most genuinely intuitive
of the three ideas, has no bootstrap problem, and works identically
for edit and generation use cases on day one. The slot-as-prompt and
layered-candidates ideas are stronger conceptually but need 2–3
specific UX answers we haven't fully designed yet.

---

## 4. User-agent communication: voice has a location

The hardest design question, because the previous sections banished
the chat panel as a primary surface — but communication still has to
happen.

### 4.1 The principle

**The agent's voice has a location.** Communication happens at the
spot where the work is, not in a separate channel that demands
attention. The user's intent is expressed through the surface they're
already touching, and the agent's response appears anchored to whatever
it's about.

Communication splits into three channels — used in roughly this
proportion:

| Channel | Share of communication | Mechanism |
|---|---|---|
| **Gestural / implicit** | ~70% | Direct manipulation IS the message |
| **Ambient / contextual** | ~25% | Tiny prompt fields and pinned bubbles |
| **Full conversational** | ~5% | Summoned drawer, dismissed when done |

Every "AI editor" today inverts this — they make full conversational
the primary, ambient the secondary, gestural an afterthought. That's
the wrong shape for a creative tool.

### 4.2 Channel 1: Gestural / implicit (the bulk)

Direct manipulation is communication.

- Dragging a clip earlier on the timeline = "I want this earlier" (the agent learns pacing preference)
- Locking a clip = "do not modify this" (the agent treats it as a hard constraint)
- Lassoing a region of the preview = "this part is what I'm referring to" (spatial intent without articulation)
- Rejecting a ghost = "not this" (the agent learns negative preference)
- Accepting a ghost = "this, yes" (the agent reinforces the pattern)
- Dragging an unbound moment from the holding strip onto a slot = "I want this here"

These don't *feel* like communication. They feel like editing. That's
the win — the cognitive overhead is zero. The agent watches everything
and learns silently. ~70% of intent is communicated this way without
anyone calling it "communication."

### 4.3 Channel 2: Ambient / contextual

Quick, scoped, no ceremony. Two surfaces:

#### The context-bound prompt field

A single thin input strip pinned to the active selection (not the
screen — the *selection*). It moves with what's selected. Its contents:

- **Nothing selected** → faint global field: `ask, edit, or generate…`
- **One clip selected** → field scoped to that clip: `modify this clip…` with a small chip in the field reading `[clip-7]`
- **Multiple clips selected** → `apply to 4 clips…` with a chip reading `[4 clips]`
- **A slot selected** → the slot-driven generation prompt

**The killer feature: the field itself shows what context is bound.**
Tiny chips inside the input display what's "in scope" before the
cursor. The user can drop a chip with a click, or add one by dragging
something into the field — a memory item, a reference clip, another
moment from the holding strip. The agent's responses are scoped to
the same chips. This eliminates the prompt-re-explanation problem
entirely. You never type "for the third clip on track 2, the
warm-toned one between the speaking heads…" — the field already knows.

#### Pinned bubbles on the surface

When the agent has something to say about a specific moment, it
doesn't post a chat message. It attaches a small bubble to the
relevant clip or ghost. Anchored to time, anchored to position.
Examples:

- `?` bubble on a ghost — "I removed 3 ums but left 1 (it sets up a beat — keep?)"
- `!` bubble — "B-roll license expires in 30 days for this clip"
- `~` bubble — "Inspired by your last edit, try this style?"
- `…` bubble while working — soft pulsing, then resolves to a result bubble

Bubbles fade in. One click expands. One click dismisses. There's no
scrolling history because each bubble lives where it's about. If you
want to find what the agent said about clip 7 last week, you scrub to
clip 7. The history isn't a transcript — it's the timeline itself.

### 4.4 Channel 3: Full conversational (rare, summoned)

For the genuinely-extended back-and-forth — debugging a complex
direction, getting structural feedback, asking "why isn't this
working?" — there's a slim drawer summoned by keyboard shortcut (or a
small dock-corner button). It slides up from the bottom edge.

It IS a chat. But with one critical distinction from every other AI
chat: **every message in it has a "show on timeline" affordance.**
Click the affordance → the playhead scrubs to the moment being
discussed, the relevant clip is selected, and (if applicable) a ghost
appears. The drawer is a thinking tool that *projects back into the
workspace*. It's not a parallel workspace.

Dismiss the drawer with one keystroke. The conversation is preserved
(you can reopen it to continue) but it's never blocking the surface.

### 4.5 The underrated power channel: voice

For an editing tool specifically, **voice is enormously underrated.**
The editor is watching footage. Both hands are on shortcuts. Eyes are
on the preview. Typing breaks all of that.

Push-to-talk (hold a key, speak intent, release) is faster than typing
for almost every operation. The user's voice runs through transcription
→ into the same context-bound input field → submitted. The slowest
input mode (typing) becomes optional rather than mandatory.

**The interaction nobody else has:** voice combined with scrubbing.
While the user scrubs through footage, they say "tighten the gap
between these two clips" — the agent takes both the verbal directive
AND the playhead position AND the clips currently in frame. No
selection step. No prompt-re-explanation. The intent is captured at
the speed of speech, scoped by the temporal cursor.

This is the closest a creative tool has ever come to "thinking out loud."

### 4.6 Agent status: speaking from where it's working

Long operations don't go in a chat. They appear *in the location they're
about*:

- A render job → progress strip on the affected clip itself, the way
  Phase 3 already designs but rendered as part of the clip rather than
  a side panel.
- A search across all clips → subtle highlight pulse on candidate
  matches as they're found, in real time.
- A multi-step plan → progress dots on each affected clip, lighting up
  sequentially as steps complete.
- A blocked/stuck operation → a `?` bubble on the specific clip that's
  blocking, asking the question that's needed to unblock.

You always know what the agent is doing because you can see what it's
pointing at. There's no opaque "thinking…" indicator divorced from the
work.

**Interruption / steering**: while the agent is working, a small
"redirect" affordance lets the user say "wait — these clips, not those"
or "skip the audio pass" mid-stream. This is usually missing from agent
UIs and it's exactly where they feel most opaque. Mid-operation
steerability is the difference between an assistant and a colleague.

### 4.7 Trust calibration in every agent voice

Per the Intent UX framework: every agent communication carries its
**confidence** visibly.

- A ghost at 0.95 confidence renders as a solid teal-bordered overlay
- A ghost at 0.40 renders with a thin amber dashed border
- A bubble's color and weight reflect the same calibration
- A drawer answer cites which memory or skill it consulted ("from your
  style profile" or "based on your last 3 hook-variant choices")

The user is never asked to trust the agent blindly. Every utterance
comes with its provenance and its confidence pinned to it.

### 4.8 The one-sentence summary

> The agent communicates by **pinning itself to whatever it's talking
> about**, and the user communicates by **gesturing on the surface
> they're already touching**, with prose as a summoned tool rather than
> a permanent workspace — and voice as the secret-weapon input channel
> that closes the typing-is-friction gap entirely.

### 4.9 Honest tradeoffs

- **Discoverability of the gestural channel.** First-time users won't
  know that lassoing a region IS a prompt, or that locking a clip IS
  a constraint. Onboarding has to teach this — once. After that it's
  invisible. The risk: if the onboarding is bad, users think the
  product is "just an editor with a tiny prompt bar," and they never
  find the depth.
- **Power users may want a persistent chat history.** They may want to
  scroll back and see "what did I ask you to do last Tuesday?" — and
  the timeline-as-history doesn't preserve verbal context across
  sessions. *Solvable:* the drawer's contents persist between sessions,
  even when collapsed; opening it shows the last conversation.
- **Voice input requires a transcription pipeline that doesn't suck.**
  Mediocre transcription kills the entire interaction. Pick a real STT
  (Whisper, Deepgram, etc.) and treat latency / accuracy as a hard
  constraint. This is engineering work, not design work — but it's
  load-bearing.
- **Bubbles can pile up on a busy timeline.** If 30 ghosts each have
  their own bubble, the timeline gets noisy. *Solution:* bubbles
  aggregate by intent group ("3 questions about pacing decisions") when
  there are too many at one zoom level, expand on hover.
- **Some users genuinely want to type prose first and look at results
  second.** The summoned drawer covers them. They're a small minority
  for a creative tool, but they exist (especially among users who came
  from prompt-based generators rather than from editing tools). Don't
  punish them; just don't optimize for them.

---

## 5. Visual prototypes (gpt-image-2 prompts)

These are the prompts used to generate hero shots of the unified-graph
surface. Preserved here so future contributors can regenerate, iterate,
or extend the visual language. Two prompt sets exist:

- **Set A:** the original 6 prompts from `intent-ux-design-review.md`
  (Intent-UX-specific surfaces — chat reduction, candidate map,
  provenance pop-over, canvas annotation, exception drawer, render
  breadcrumbs). Reference that doc.
- **Set B (this section):** the unified-graph hero shots that emerged
  after the bird's-eye-view conversation.

### 5.1 Style anchors (apply to every prompt in Set B)

Dark professional NLE palette:

- Near-black background `#0d0d10`
- Charcoal panels `#1a1a20`
- Single accent: muted teal `#5fb3a8` (high-confidence)
- Secondary: amber `#d4a358` (medium-confidence)
- Tertiary: muted red `#c46a6a` (low-confidence)
- Ghost overlays: 30% opacity, dashed 1px borders
- Type sparingly — 1-3 word labels max (image models still mangle long text)

**Negative phrase to add to every prompt:**
`no chat panel, no media bin sidebar, no separate generation tab, no project sidebar.`

(Image models default to inserting these because every "AI editor"
training image has one. Without the negative, you get hybrids that
defeat the point.)

### 5.2 Prompt 1 — Hero (the unified surface)

> Wide 16:9 mockup of a professional video editor in a dark theme. Top
> third: video preview pane showing a documentary frame. Middle third:
> a single horizontal multi-track timeline (3 tracks) with clip blocks.
> Above some — not all — of the clips on the active track, tiny glyphs
> sit just above the clip border: a stack of three small dots (meaning
> "3 alternatives exist for this clip"), or a thin row of 4
> micro-thumbnails (meaning "this clip has been refined 4 times"). The
> glyphs are subtle, single-color teal. Bottom third: a thin horizontal
> **holding strip** containing about 8 small clip thumbnails in a row
> — each with a tiny corner badge: some show a small camera icon (raw
> footage), some show a small spark/sparkle icon (generated), one
> shows a small branch icon (variant from a past session). Far right
> edge: a slim caption strip with a single line of text "3 ghosts · 2
> unplaced." NO media bin panel, NO chat panel, NO separate "generated"
> or "library" tab. The visual hierarchy says: *one timeline, one
> holding strip, everything lives here.* Mood: surgical, dense, calm.
> Ratio 16:9.

### 5.3 Prompt 2 — Junction sign expanded

> Close-up 16:9 of a single segment of a video editor timeline, dark
> theme. The user has clicked a small "stack-of-three-dots" glyph
> above one of the clips on the active track. **Three ghost-lane clips
> have lifted upward** above the active clip — they occupy a small
> expanded region directly *above* the current clip, in the same
> vertical column, each with a thin dashed border (one teal, two
> amber). The active clip below them is dimmed to about 60% brightness
> to indicate "auditioning alternatives." A small chevron icon at the
> bottom-left of the stack hints that it collapses back. The user's
> cursor hovers on the middle ghost. No modal, no popover, no separate
> window — the alternatives appear *in the same surface* as the active
> timeline. The rest of the timeline (clips to the left and right) is
> unchanged and fully visible. Mood: forensic inspection, no context
> switch. Ratio 16:9.

### 5.4 Prompt 3 — Holding strip close-up

> 3:2 close-up shot of just the lower portion of a video editor: the
> **holding strip** (a thin horizontal tray of unbound media). The
> strip contains a row of about 9 small clip thumbnails, all the same
> size and shape. The differentiation is in **tiny corner badges** on
> each thumbnail: small camera icon for 4 of them (raw footage), small
> spark/sparkle icon for 3 of them (generated), small branch icon for
> 1 (variant from a past session), small refresh-arrow icon for 1 (a
> re-edit of an existing clip). All badges are the same muted teal,
> single line weight. A user's cursor is mid-drag on one of the
> spark-badged thumbnails, pulling it upward; a faint horizontal guide
> line above shows where it would snap into the active timeline. NO
> separate "Library" or "Generated Media" panel — the whole strip is
> one tray, sources and generations as peers. Mood: democratic,
> unified. Ratio 3:2.

### 5.5 Prompt 4 — Lineage walk

> 9:16 vertical mockup. Top of frame: a single clip from a video
> editor timeline, rendered larger than usual, like a focused
> inspection. Below it (or stacked behind it, slightly receding into
> perspective), **a vertical stack of 5 smaller versions of that same
> clip** — each one is a small thumbnail card, each progressively
> smaller and dimmer than the one above it, like a deck of cards going
> into the distance. Each card carries a single tiny label: top reads
> "now", below "color", below "AI fill", below "trim", below "raw". A
> faint vertical line connects them all, suggesting genealogy. A
> subtle right-arrow icon on each card hints "tap to revert."
> Background is dark and minimal. NO separate version-history panel
> exists in the frame — this IS the version history, hanging from the
> clip itself. Mood: archaeological, lineage-as-substance. Ratio 9:16.

### 5.6 Prompt 5 — Recursive composition

> 16:9 mockup of the same video editor surface as Prompt 1 (timeline
> center, holding strip below, lineage glyphs above clips), but with
> **one critical addition at the top**: a horizontal breadcrumb trail
> above the preview pane reading "**Project › Hook Sequence › Logo
> Animation**" with right-pointing chevrons separating the segments
> and the last segment slightly highlighted. The current view IS the
> inside of "Logo Animation" — visually identical in layout to the
> top-level project view (same timeline structure, same holding strip
> below, same lineage glyphs), just with content specific to a logo
> animation (shorter clips, motion-graphic looking thumbnails). The
> signal is unmistakable: nesting deeper into a composition does not
> switch to a different mode — the surface is identical, recursive. A
> tiny back-arrow on the left of the breadcrumb returns up one level.
> Mood: fractal, consistent. Ratio 16:9.

### 5.7 Prompt 6 — Cold start (first-use empty state)

> 16:9 mockup of the ChatCut application on first launch, dark theme.
> The app frame is rendered exactly as the production version, but
> **almost everything is empty**: the preview pane at the top shows a
> single black frame; the timeline area in the middle shows only thin
> track outlines (no clips, no ghosts, no lineage glyphs); the holding
> strip at the bottom is empty with a single ghost-line placeholder
> reading "media will appear here." Center of the screen, slightly
> above the empty timeline, **one large soft-rounded prompt input**
> with a faint inner glow reads in a single line: "**describe the
> video you want, or drop a reference here.**" To the right of the
> input, a small icon row offers 3 actions: paste-from-clipboard,
> drop-image, drop-video — all small monochrome icons, no labels. NO
> separate "create project" wizard, NO template gallery, NO splash
> screen. One decision, one surface, ready to start. Mood: clean,
> generous, low-friction. Ratio 16:9.

### 5.8 Production notes

- **Run prompts 1, 2, 6 first.** If those land, the unified-graph
  thesis is communicated. The other three are amplifications.
- **Lineage glyphs are the single most distinctive visual.** If the
  model omits them in prompt 1, regenerate — they're the whole hook
  of the new mental model. The first-pass image we generated showed
  them too subtly; explicit re-prompting ("at least 3 clips on V1
  should display a small stack of three teal dots directly above the
  clip's top edge, and 1 clip should display a horizontal row of 4
  micro-thumbnails") fixed it.
- **Provenance badges on the holding strip are the second-most
  distinctive thing.** Same pattern: explicit re-prompting fixed it
  on round 2 ("4 thumbnails get a small camera icon, 3 get a small
  spark icon, 1 gets a branch icon, 1 gets a refresh icon").
- **One clip in "alternatives expanded" state should appear in the
  hero**, not only in Prompt 2. Combine the hero (Prompt 1) and the
  expanded interaction (Prompt 2) into a single image when possible
  — it shows resting state and the killer interaction simultaneously.
- **Aspect ratios are deliberate:** 16:9 to match real editor
  screenshots; 3:2 for the holding-strip close-up (feels like an
  inspection); 9:16 for the lineage card-stack (makes the receding
  genealogy dramatic).
- **Color discipline matters:** if the model brings in extra accent
  colors (purple, orange, blue), the screenshots will look like a
  generic SaaS product instead of a pro-NLE. Re-emphasize the
  single-teal accent rule in regenerations.

### 5.9 The 7th prompt (optional)

A **side-by-side audition** — the layered-transparency mode where all
4 alternatives at one timecode play simultaneously as stacked
translucent overlays, audio scrubber bar at the bottom showing 4
muted waveforms with one in solid teal (the currently-audible one).
Captures the "comparison without context switch" power-user case.
Generate only if the first 6 land.

---

## 6. Engineering plan: how to make it smooth

The design above is dense. A React-DOM app cannot stay smooth at this
density — you'd hit a wall around 50 clips. The path that actually
works is borrowed from Figma, Resolve, and Photoshop: **canvas-based
renderer for the workspace, React only for the chrome.**

### 6.1 The core architectural shift

The timeline + holding strip should be **a single WebGL2 canvas** (with
Canvas2D fallback), not a React component tree. React renders the
chrome — toolbar, breadcrumb, status pills, drawer, prompt field.
Everything inside the timeline area is the renderer's domain.

Reference architectures:
- **Figma** is canvas + React chrome
- **tldraw** is canvas + React chrome
- **DaVinci Resolve** is OpenGL + Qt chrome

The library choice for ChatCut is **PixiJS for 2D** (mature,
well-tested) or **PixiJS v8 with WebGPU** for forward-leaning.

What you get from this:

- One `<canvas>` element instead of thousands of DOM nodes
- Hit-testing in JS against an explicit scene graph (faster than DOM
  event delegation at scale)
- Pan/zoom as matrix transforms (~free) instead of DOM scroll + reflow
- Animations on the renderer's ticker (`requestAnimationFrame`-driven),
  not React state changes
- Damage tracking — only dirty regions repaint each frame

The cost is real: months of careful engineering. But it's the only path
that makes the design viable.

### 6.2 Tiered LOD by zoom

At full zoom-out, don't render thumbnails — render aggregated color
strips representing the average color of clip ranges. As the user zooms
in, progressively reveal: clip thumbnails → lineage glyphs →
provenance badges → micro-thumbnail breadcrumbs. Same idea as map
tiles, applied to a timeline. A 200-clip project at zoom-out should
render as fast as a 5-clip project.

### 6.3 Virtualize everything that scrolls

Holding strip with 50+ thumbnails: only the visible window plus a
small buffer exists in the scene graph. Off-screen thumbnails are
unloaded entirely (textures freed, GL buffers released). Same for the
timeline: only clips in the current viewport plus a small horizontal
buffer get rendered.

### 6.4 Web Worker offloading — non-negotiable

The main thread must stay clear for input + render. Push to workers:

- **Waveform decoding/rendering** → worker chunks the audio, returns
  pre-rendered waveform image data, transferred zero-copy as ImageBitmap.
- **Video frame extraction** → WebCodecs in a worker, returns
  ImageBitmap textures ready for GL upload.
- **Thumbnail strip generation** → same pipeline, worker decodes
  representative frames, returns texture atlases.
- **SSE event diffing** → events arrive on a worker, diff against
  current state there, post small deltas to main.
- **Voice transcription** → either local Whisper-in-WASM or streamed
  to a remote STT, never on main thread.

`OffscreenCanvas` lets workers render directly to GPU surfaces without
ever touching the main thread's memory pressure.

### 6.5 State management — narrow subscriptions only

The reactive store (Zustand, Jotai, or Solid signals if you want
fine-grained reactivity for the chrome) holds canonical timeline state.
The renderer subscribes to *narrow slices* — when a single ghost's
confidence changes, only that ghost's scene-graph node is dirty, not
the whole timeline.

**The trap to avoid at all costs:** a single big component subscribed
to the whole store. Every state change re-renders everything. This is
the most common cause of "the app feels heavy" in React apps that try
to do canvas-style work without canvas. Use atom-style or
selector-with-shallow-equality patterns religiously.

### 6.6 Animation on the renderer's ticker, not React state

Every transition — bubble fade-ins, ghost proposals appearing,
alternatives lifting above clips, lineage glyphs pulsing on confidence
change — runs on PixiJS's ticker as time-based property animations.
Animating these via React state would cause tree re-renders at 60fps,
which is exactly the antipattern.

The chrome animations (drawer slide-up, modal fades, prompt-field
grow) can stay as CSS transitions because they're outside the canvas
surface and their re-render cost is bounded.

### 6.7 Memory discipline

A real project will have:

- 100+ source video files (gigabytes total, mostly not loaded)
- Hundreds of clips, each with thumbnails + waveform
- Generated content in the holding strip
- Pre-fetched preview MP4s

Web memory ceiling is harsh — practically ~2-4GB. The strategy:

- **Source videos**: never fully load, HTTP range requests for the
  bytes currently needed.
- **Thumbnail strips & waveforms**: lazy generation on first
  scroll-into-view, LRU cache, eviction after N seconds out of view.
- **GL textures**: explicit `texture.destroy()` on eviction,
  reference-counted so shared textures aren't freed early.
- **ImageBitmaps**: explicit `.close()` when no longer needed (the GC
  can't free them).

Build a memory dashboard into dev mode. If you can't see the memory
curve growing during normal use, you can't catch leaks.

### 6.8 The video preview is its own beast

Playing back the active path through the moment graph in real time,
with cuts between sources, is non-trivial. Three options ranked by
difficulty:

- **Easy**: For *committed* state and *exploration candidates*, the
  preview-render worker (Phase 3, already shipping) produces actual
  MP4s — play them in a real `<video>` element. Done.
- **Medium**: For *uncommitted ghosts*, render preview as a single
  *representative frame* (not playback). The frame is generated
  client-side by sampling the source at the relevant timestamp.
  v1-acceptable.
- **Hard**: Real-time playback of uncommitted ghost compositions
  requires a client-side renderer that essentially reproduces what the
  GPU worker does — multi-source frame composition, audio mixing,
  transition rendering, all at 30/60fps. **This is months of work.**
  Don't ship it for v1. Use the Medium path and call out "click to
  render a full preview" as the explicit affordance.

This is the single biggest engineering decision in the whole stack.
Be honest with yourself about which tier you can afford in v1.

### 6.9 SSE → store → render path

The Phase 5 SSE infrastructure already gives you `tool.progress`,
`changeset.proposed`, `exploration.candidate_ready`, etc. The hot path:

- Event arrives on a Worker (or main, depending on EventSource limits)
- Worker parses, computes diff against current store state, posts a
  small delta object to main
- Main applies the delta to the store atomically (one store write, not N)
- Subscribers fire → affected scene-graph nodes marked dirty
- Next `requestAnimationFrame` paints only dirty regions

Avoid: per-event React re-renders, buffering events until "idle"
(latency kills perceived smoothness), wrapping each event in a setState
call (causes scheduler noise).

### 6.10 Performance budget from day 1

Don't ship without a profiling harness. Real targets, measured
continuously in CI:

- 60fps on M1 / equivalent for projects up to **200 clips** with 4
  active ghosts
- 30fps minimum on integrated graphics (Intel UHD 620)
- Frame time budget: <16ms for 60fps, with 8ms hard ceiling for the
  render pass (leaving 8ms for input + JS)
- Memory growth: <100MB per hour of normal editing (anything more is a
  leak)
- Time to interactive: <2s on cold load with a 50-clip project
- SSE event → visible UI update: <50ms

Wire these to a perf dashboard in dev builds. If a PR regresses any
number, fail CI.

### 6.11 Where to start, given the current Next.js app

The current `apps/web` is Next.js + React + DOM. The realistic plan:

1. **Spike**: build a standalone PixiJS-based timeline component that
   renders 200 clips with lineage glyphs at 60fps, in isolation.
   Validate the architecture works before integrating.
2. **Integrate**: drop the spike into the existing app, replacing only
   the timeline component. Keep all chrome (drawer, prompt field,
   breadcrumb, status pills) as React.
3. **Migrate the holding strip**: same renderer, second viewport.
   Shares textures with the timeline (same clips appear in both).
4. **Workers second**: once the rendering path is clean, push
   waveform/thumbnail generation off-main. Don't do this first —
   premature optimization.
5. **Memory discipline last**: once everything works, profile a
   2-hour editing session, find the leaks, fix them. There will be leaks.

For the **v0 prototype** to validate the UX before committing to
canvas: DOM-based with `react-window`-style virtualization will get you
to ~50 clips at 60fps. Use that to validate the design lands with
users. Once it lands, do the canvas migration in earnest.

### 6.12 Honest tradeoffs

- **Canvas-based UI breaks browser accessibility tools.** Screen
  readers can't see canvas content. You'll need to maintain a parallel
  ARIA tree for accessibility, which is real work. Figma does this;
  it's solved but not free.
- **Browser DevTools can't inspect canvas elements.** Build your own
  scene-graph inspector for debugging. Pixi has decent tooling, but
  it's not Chrome DevTools.
- **The team needs canvas/WebGL skills.** This is a different mental
  model from React component composition. Hire or train accordingly.
- **The first 6 months will feel slower than just shipping a DOM
  version.** Spike velocity matters; this is a long-tail bet on
  smoothness.

### 6.13 The one-sentence summary

> The smoothness comes from putting the workspace on canvas like a
> real creative tool, restricting React to the chrome, virtualizing
> aggressively, decoding everything off-main, and being honest with
> yourself that real-time uncommitted-ghost playback is months of work
> that v1 should defer.

---

## 7. WICG html-in-canvas — track but don't bet (yet)

The proposal at https://github.com/WICG/html-in-canvas lets you keep
HTML elements as canvas children (`<canvas layoutsubtree>`) and call
`drawElementImage()` to composite their *rendered output* into your
canvas surface. The DOM still exists, still lays out, still gets
events. You write back a CSS transform to keep the source element
aligned with where you drew it.

### 7.1 Status (as of 2026-04-22)

- **Not a shipped standard.** WICG proposal, ~20 months in, still
  behind a Chromium flag (`chrome://flags/#canvas-draw-element`).
- **No Safari/Firefox commitment.**
- **2,790 GitHub stars** — significant interest, but stars ≠ shipped.

### 7.2 Why "make all chromes in canvas with this" is the wrong question

Two reasons:

**1. It doesn't solve the perf problem you'd be using it for.**
The slowness of a React-DOM-based editor with hundreds of clips comes
from React reconciliation, browser layout/style recalculation, and
paint of many small elements. html-in-canvas changes how the *final
composition* happens. The DOM still exists, still lays out, still
styles, still triggers reconciliation. You've added canvas composition
cost on top of all the existing costs, not subtracted them.

So if you used it to render the timeline clips, you'd be slower than
pure canvas + WebGL textures. The right architecture for the timeline
is still PixiJS/WebGL drawing clip thumbnails as GL textures, not
"render each clip as a `<div>` and composite it into canvas via
`drawElementImage()`."

**2. The browser support story is a startup-killer for v1.**
- Chromium-only, behind a flag, in April 2026
- Origin Trials are time-bounded (you can't deploy on them indefinitely)
- ~30%+ of users on Safari/Firefox would get nothing or a fallback
- WICG proposals routinely revise API shape before shipping
- WebKit/Gecko might be 1–3 years behind even when Chromium ships stable

You cannot bet ChatCut v1 on this.

### 7.3 The genuine future use case

The clever thing the proposal solves is: canvas-based UIs lose
accessibility, text quality, and form input fidelity. html-in-canvas
lets you have **canvas-driven composition AND DOM-quality content** for
the parts where that matters.

For ChatCut, the obvious application **isn't** "render the chrome in
canvas" — it's "render **the bubbles and the prompt field** in canvas
at the timeline position they belong to, with full accessibility and
input fidelity preserved."

A lineage label, a context-bound prompt input, a pinned `?` bubble
with rich text — those want HTML rendering, anchored to a
canvas-positioned clip. html-in-canvas would solve the coordination
problem elegantly when it ships.

### 7.4 The realistic plan

1. **v1 (now → 12 months):** ship the architecture from §6. Pure
   canvas/WebGL workspace, React DOM chrome, off-screen ARIA mirror
   for canvas content. Watch html-in-canvas's progress in Chromium
   stable + cross-browser commitment.
2. **v1.5 (when html-in-canvas hits Chromium stable AND has WebKit/Gecko
   commitment, probably 2027–2028):** spike rendering the bubble +
   prompt-field layer using html-in-canvas inside the timeline canvas.
   If it lands cleanly, ship it as a progressive enhancement.
3. **v2+ (when html-in-canvas is widely supported, probably 2028+):**
   consider rich-text labels (lineage descriptions, transcript overlays)
   inside the canvas via this API, instead of doing canvas-native text
   layout.

### 7.5 The verdict

> html-in-canvas is a real future tool — for the bubble + prompt-field
> layer specifically — but it's a 2027+ bet, doesn't reduce the perf
> cost of the parts you'd be tempted to use it for, and using it for
> "all the chrome" misunderstands which problem it solves.

Track it. Don't build on it. The architecture in §6 doesn't change.

---

## 8. What this is NOT

Defensive boundary-setting so future contributors don't read this as
arguing for things it doesn't argue for:

- **Not a replacement for `chatcut-discussion-summary.md`.** That doc
  covers product positioning (copilot vs autopilot), MVP ordering
  (Campaign Mode first), and repo governance. This doc is the *UX
  execution lens* for the same product, not an alternative product
  thesis.
- **Not infinite canvas dressed up.** §2 explicitly rejects spatial
  pan-and-zoom as the primary surface. The "graph of moments" is a
  data-model concept, not a 2D scene users navigate.
- **Not git-style branch trees in the UI.** The lineage DAG is the
  data model; the user surface reveals branches in-place at the
  position they affect, never as a separate "branches view."
- **Not multi-tab editing.** Only one timeline is "active" at any
  moment; alternatives are stacked overlays, not parallel tabs.
- **Not a permanent chat panel disguised as a "drawer."** The drawer
  is summoned, dismissed in one keystroke, and exists for the rare
  prose moment. Default state is collapsed. The bulk of communication
  is gestural and ambient (§4).
- **Not committed to canvas-for-everything.** §6 is explicit:
  workspace on canvas, chrome on React DOM. Going full-canvas on the
  chrome via html-in-canvas (§7) is not a v1 path.
- **Not a phase-grade plan.** No commits, no acceptance criteria, no
  scope boundaries. Phase plans live in `.omc/plans/`.
- **Not exhaustive.** Audio editing specifics, collaboration semantics
  (multi-user editing on the same project), undo/redo at scale, and
  mobile/tablet adaptation are all out of scope here. Each warrants
  its own pass.

---

## 9. Aggregate honest tradeoffs

Pulled together from the per-section tradeoff lists above so a reader
can see the cost surface in one place:

| Section | Tradeoff | Mitigation |
|---|---|---|
| §1 unified-graph | Mental model is non-standard; editors trained on bin/sequence/comp will need to recalibrate | Compensating win: new users never have to learn the old model |
| §1 unified-graph | DAG can balloon; old branches need pruning UX | Aggressive collapse beyond N steps from active path |
| §1 unified-graph | Power users may want side-by-side comparison | Layered transparency mode covers it (audio cycles via `[` `]`) |
| §2 reject-canvas | Picking the temporal/layered direction means rejecting a known-good pattern | The only way to feel different from every AI editor shipping next quarter |
| §3 slot-as-prompt | Discoverability of "the gap is a prompt" | Hover `+` glyph affordance |
| §3 slot-as-prompt | Duration cage forces dimension-locking before exploration | Agent counter-proposes ("this wants 6s — expand?") |
| §3 slot-as-prompt | First-use bootstrap is broken | Empty timeline IS one giant slot with the prompt input |
| §3 slot-as-prompt | Iteration cost (refine without recreate) | Click ghost re-opens prompt with previous text |
| §3 slot-as-prompt | Audio doesn't fit cleanly | Audio-track-as-slot model, designed explicitly |
| §4 communication | Discoverability of gestural channel | Onboarding teaches once; risk if onboarding is bad |
| §4 communication | Power users want persistent chat history | Drawer contents persist between sessions |
| §4 communication | Voice needs good STT or it dies | Pick a real STT; treat latency/accuracy as load-bearing |
| §4 communication | Bubbles can pile up | Aggregate by intent group at busy zoom levels |
| §4 communication | Some users want prose-first | Summoned drawer covers them; don't optimize for them |
| §6 engineering | Canvas breaks browser accessibility | Maintain off-screen ARIA mirror (Figma does this) |
| §6 engineering | Browser DevTools can't inspect canvas | Build a scene-graph inspector |
| §6 engineering | Team needs canvas/WebGL skills | Hire or train |
| §6 engineering | First 6 months feel slower than DOM | Long-tail bet on smoothness |
| §6 engineering | Real-time ghost playback is months of work | v1 ships frame-preview only; "render full preview" as explicit action |
| §7 html-in-canvas | Tempting but not v1-viable | Track Chromium stable + WebKit/Gecko commitment; revisit 2027+ |

---

## 10. Next steps (if you decide to commit)

This section is a menu, not a plan. Pick what fits the current quarter.

### 10.1 Cheapest validation: confirm the design lands with users

- Spike a DOM-based v0 prototype using `react-window` virtualization
- 50-clip ceiling, two tracks, lineage glyphs above 5 clips, holding
  strip with provenance badges below
- Skip workers, skip canvas, skip generation — just the visual + the
  click interactions
- Put it in front of 3–5 real editors. Ask them to find specific
  things on the timeline; observe whether the lineage glyphs and
  holding-strip badges register as affordances or as decoration
- If users don't find them, redesign the affordances before committing
  to canvas

### 10.2 Architectural spike: validate the engineering plan

- Standalone PixiJS-based timeline component, no React integration
- Synthesize 200 clips with random thumbnails
- Render lineage glyphs and provenance badges
- Pan, zoom, scrub at 60fps
- Measure frame time and memory growth
- This gates the canvas migration

### 10.3 Smallest user-facing improvement that unblocks the rest

- Layered ghost mode on the existing timeline (5b Stage 2 in
  `wiring-audit-remediation-status.md`)
- The agent already ships `confidence` and ghost data
- The web layer already discards or under-renders it
- Shipping this validates the "alternatives in place" interaction at
  current architectural scale

### 10.4 Voice-first input experiment

- Push-to-talk binding (hold `\`` to talk)
- Whisper-WASM or remote STT
- Pipe transcribed text into the existing prompt field
- Validates whether voice-while-scrubbing is as transformative as
  predicted, or whether typing remains preferred

### 10.5 The "if we commit to it all" sequence

If the validations above all land:

1. Engineering: PixiJS timeline migration, behind a feature flag
2. Engineering: holding strip migration, sharing the renderer
3. Design: implement the 6 hero-shot prototypes as actual components
4. Design: wire context-bound prompt field with chip metadata
5. Design: pinned bubble system for agent voice
6. Engineering: web worker offload for thumbnails + waveforms
7. Engineering: SSE delta path through worker → store → renderer
8. Design: voice channel with transcription pipeline
9. Engineering: memory discipline + dev dashboard
10. Engineering: parallel ARIA mirror for accessibility

Each step is its own milestone, each validates before the next.

---

## 11. Final synthesis

Three sentences capture the whole thing:

> ChatCut should not present timelines, asset bins, generation outputs,
> exploration candidates, edit histories, or nested compositions as
> separate UI surfaces. It should present **one canonical path through
> a graph of moments**, with all of those things reachable as
> adjacency at the position where they matter — and communicate with
> the agent through gestures on that surface, with a small ambient
> channel for short prose and a summoned drawer for the rare extended
> conversation, with voice as the input channel that closes the
> typing-is-friction gap. The whole thing renders on canvas because no
> React-DOM app can stay smooth at this density, and the engineering
> investment is real but the alternative is a product that looks and
> feels like every other AI editor shipping this quarter.

If ChatCut commits to this direction, the product becomes structurally
different from prompt-based competitors in a way users can feel within
the first 30 seconds of opening the app — not from features, but from
the underlying mental model of how editing, generation, history, and
review unify into one surface.
