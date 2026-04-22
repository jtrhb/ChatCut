# ChatCut Discussion Summary

This document consolidates our recent ChatCut discussions across product research interpretation, repository/document review, UI/UX direction, review/diff interaction design, and practical product strategy. It is written as an internal working note so future contributors can quickly understand the current thinking, tradeoffs, and recommended next steps.

---

## 1. Executive summary

ChatCut should not position itself as a fully autonomous AI video editor. The strongest product direction is an **AI copilot for professional creators and enterprise marketing teams** that removes repetitive editing labor while preserving human control over creative judgment, critical timing, and brand/legal safety.

Across both the repository documentation and the user research, the same principle appears repeatedly:

- Users want **copilot, not autopilot**.
- AI should handle repetitive, structured, and reviewable work.
- Humans must retain control over keyframes, pacing, hook selection, brand expression, factual claims, and copyright-sensitive decisions.

That implies a product strategy centered on:

1. **Semantic media retrieval**
2. **Technical-term subtitle correction**
3. **Brand constraint enforcement**
4. **Automated variant generation for campaigns**
5. **Preview-first, reviewable AI edits rather than direct irreversible edits**

---

## 2. Repository and documentation review

### 2.1 Overall repo assessment

The `jtrhb/ChatCut` repository shows a serious amount of thinking and design work. The strongest areas are the architecture notes, agent system thinking, tool-system evolution, and human-in-the-loop editing model. The core design direction is coherent:

- server-authoritative editing
- agent-driven planning and execution
- change logs and reversible edits
- preview/commit workflow
- exploration fan-out for variant generation
- a memory / profile layer for creator and brand preferences

However, the repo also has a documentation governance problem: there is too much high-value material without a clear source-of-truth hierarchy.

### 2.2 Key strengths

The documentation demonstrates unusually strong strategic depth for an early-stage product:

- `docs/chatcut-plan.md` and related architecture docs show a credible **server-first + human-in-the-loop** direction.
- `docs/chatcut-agent-system.md` shows good intuition around agents, isolation, execution boundaries, and tool orchestration.
- `docs/chatcut-tool-system-evolution.md` and related `.omc` planning/spec files are some of the most implementation-ready documents in the repo.
- The UX thinking around preview-first and explicit review is directionally strong.
- The codex review notes are useful because they capture implementation gaps, open wiring issues, and prior fixes.

### 2.3 Main documentation problems

The biggest documentation problems are structural, not intellectual.

#### Root README conflict

The root README still presents the project largely as OpenCut, while the ChatCut docs describe a distinct AI-copilot, server-first system. This causes positioning confusion.

#### OpenCut fork vs. new product ambiguity

The repo is visibly a fork and still carries OpenCut naming in several places, but some docs speak as if ChatCut is already a fully distinct product. This should be clarified explicitly.

#### Too many authoritative-looking documents

There is currently no single clear map of:

- what is current truth
- what is aspirational proposal
- what is historical review archive
- what belongs to legacy OpenCut vs. ChatCut-specific design

#### `.omc/` should not remain as-is in the public repo

Some `.omc` contents contain useful plan/spec material, but runtime memory, sessions, and internal project-memory artifacts do not belong in a clean public repo state. The durable pieces should be migrated into `docs/`, and the rest should be ignored.

### 2.4 Recommended repo/documentation cleanup

Recommended immediate cleanup:

1. Rewrite the root README to clearly explain ChatCut’s current state and relationship to OpenCut.
2. Add `docs/README.md` to define document categories and sources of truth.
3. Add `docs/status.md` to track what is implemented, partial, deferred, or still speculative.
4. Move durable `.omc` plan/spec material into `docs/`.
5. Remove or ignore ephemeral `.omc` artifacts such as session summaries and project memory.

---

## 3. Product research synthesis

### 3.1 What the research says

The product research on professional creators and enterprise marketing teams strongly supports a narrow and practical product direction.

The most important conclusions are:

- Professional creators care deeply about **quality, pacing, accuracy, and stylistic control**.
- Enterprise marketing teams care deeply about **brand consistency, copyright traceability, batch throughput, and ROI-oriented variation generation**.
- Users consistently define the ideal AI role as **copilot rather than autopilot**.
- The highest-priority pain points are:
  - semantic B-roll / media retrieval
  - technical-term subtitle correction
  - batch A/B variant generation
  - brand VI lock / brand rule enforcement

### 3.2 Implication for positioning

ChatCut should not be marketed as “one prompt generates your entire final video.” That framing is misaligned with the research.

A better positioning is:

> ChatCut is an AI video editing copilot for professional creators and marketing teams. It eliminates repetitive editing labor—subtitles, retrieval, rough-cut setup, brand-safe variation, and export workflows—while preserving timeline control, reviewability, and creative ownership.

A shorter internal version:

> Not a replacement for creators. A machine for removing mechanical editing work.

### 3.3 Two user modes, one shared foundation

The research indicates two distinct top-level modes built on the same editing runtime.

#### Creator Mode

Primary value:

- glossary-aware subtitle correction
- semantic B-roll retrieval
- rough-cut assistance
- chart / motion graphic generation
- style profile application
- preservation of manual fine-cut control

#### Campaign Mode

Primary value:

- brand-safe hook variation
- batch generation of campaign variants
- logo / font / VI enforcement
- copyright-safe asset usage
- preview grid + approval workflow
- batch export

The product should probably share one editing and review substrate, but expose two work modes with different emphasis.

---

## 4. Strategic product roadmap

### 4.1 Recommended MVP order

The best commercial MVP is probably **Campaign Mode first**, because:

- value is easier to quantify
- batch labor savings are obvious
- brand/compliance workflows justify higher pricing
- manual A/B test generation is currently expensive and repetitive

#### Phase 0 — trustworthy editing substrate

Must-have system capabilities:

- server-authoritative timeline state
- reversible changesets
- preview before commit
- explicit approve/reject workflow
- locked tracks / locked objects / locked keyframes
- low-resolution preview rendering
- export job queue
- change log / version history

#### Phase 1 — Campaign MVP

Build:

- Brand Kit
- Hook variant generation
- campaign variant preview grid
- brand compliance checks
- copyright-aware asset policy
- bulk approval / bulk export

#### Phase 1.5 — Creator subtitles + semantic B-roll

Build:

- terminology-aware subtitle pipeline
- low-confidence review flow
- semantic retrieval over owned/commercial/generative asset sources
- insertion into timeline via previewable changesets

#### Phase 2 — Creator copilot rough cut + charts

Build:

- transcript-aware rough-cut proposals
- style profile application
- chart and info-graphic animation generation
- editable motion outputs on timeline

#### Phase 3 — performance feedback loop

Build:

- campaign performance feedback ingestion
- variant-level result attribution
- recommendation loop for future hook/visual selection

---

## 5. Review/Diff panel: the core product innovation surface

### 5.1 Why code-style diff is not enough

A key part of our discussion focused on why video review cannot simply copy code review.

Code diff answers:

- what lines changed?

Video diff must answer:

- what part of the timeline changed?
- why did AI change it?
- what did this change affect?
- what is risky?
- what should remain under human control?

So the video review surface should not be a line-by-line technical diff. It should be a **reviewable changeset workspace** organized around time, intent, risk, and user control.

### 5.2 Recommended review model

A strong review system for ChatCut should include:

- timeline-based change navigation
- before/after preview
- grouped changes by user-facing intent rather than atomic low-level operations
- risk-based prioritization
- partial acceptance of grouped changes
- explicit protection of locked elements
- visual indication of deleted/modified/inserted timeline content
- enterprise compliance and copyright visibility where relevant

### 5.3 Proposed review elements

Core review components discussed:

#### Summary bar

Show:

- total changes proposed
- changes requiring review
- high-risk items
- compliance failures
- estimated time saved

#### Changed moments bar

A timeline strip that lets the user jump directly to changed regions.

#### Main preview with multiple comparison modes

Potential modes:

- before / after toggle
- split view
- wipe view
- ghost overlay
- audio diff

#### Change list grouped by user intent

Examples:

- Opening Hook
- Pacing
- Subtitles
- B-roll
- Brand Compliance
- Audio

#### Detail inspector

For the selected change:

- before
- after
- rationale
- impact
- source/license if asset-related
- risk level
- accept/reject/edit/try alternatives

#### Timeline diff mode

Visual markers directly on tracks for:

- inserted content
- removed content (ghost blocks)
- modified content
- locked regions
- risky regions

#### Variant review grid for campaign workflows

Instead of forcing users into one-by-one timeline review, campaign mode should surface a batch-oriented preview grid with per-variant brand, license, and risk status.

### 5.4 Design principle

The review surface should answer this user question quickly:

> Did AI overstep anywhere that matters?

Not:

> Can I inspect every low-level operation the model performed?

---

## 6. Jakob Nielsen’s “Intent by Discovery” and what it means for ChatCut

A major part of the discussion focused on Jakob Nielsen’s argument that AI UX shifts users from **operators** to **supervisors**, and that systems should support:

- intent capture
- execution transparency
- verification efficiency
- trust calibration

The article’s concepts were directionally useful, but directly rendering all of them as fixed UI layers made the UI too heavy.

### 6.1 What we borrowed successfully

The most valuable concepts for ChatCut were:

- intent is often discovered progressively, not fully articulated up front
- users need bounded delegation
- direct manipulation should remain central
- systems should reveal more only when needed
- exploration spaces can help when users are choosing among possibilities
- user memory/preferences should be visible and editable, not hidden black-box state

### 6.2 What not to do

We explicitly concluded that ChatCut should **not** expose its internal conceptual model too literally.

That means users should not be forced to navigate obvious top-level tabs called:

- Mission
- Orchestration
- Execution
- Receipt
- Memory

Those are system concepts, not user mental-model concepts.

---

## 7. Progressive disclosure and a better UI mental model

### 7.1 Key conclusion

The strongest UI conclusion from the discussion was:

> Keep the editing canvas primary. Let AI appear contextually.

Users should feel like they are still using a video editor, not operating an AI control console.

### 7.2 Better render model

Recommended model:

**Persistent canvas + ephemeral controls**

Always visible:

- player
- timeline
- lightweight AI dock

Only visible when needed:

- preflight card
- localized review bubbles
- exception drawer
- variant grid
- history / receipt detail

### 7.3 AI Dock as entry point

Instead of exposing agent abstractions, the AI entry surface should speak in task terms users already understand, such as:

- Rough cut
- Fix subtitles
- Find B-roll
- Generate hook variants
- Check brand compliance

This reduces cognitive load and aligns with existing editing workflows.

### 7.4 Preflight card instead of a full contract page

The system still needs bounded delegation, but the UI should compress it into a lightweight task confirmation card.

Example:

- what AI will change
- what it will not change
- whether output is preview only
- next action button

### 7.5 Guardrail chips instead of a settings-heavy lock manager

Important immutable boundaries—logo safety, subtitle style, VI color, keyframes, BGM beat timing—should appear as simple chips or locks in context, not as a heavy control surface.

### 7.6 Controls disappear; state remains lightly visible

One of the strongest design principles from the discussion was:

- controls should be ephemeral
- state should persist in compressed form

Examples:

- temporary review buttons appear only when a relevant object/change is selected
- timeline markers remain to show what AI changed
- lock state remains visible as lightweight chips
- receipts/history remain available but collapsed

### 7.7 Review only exceptions by default

Rather than opening a giant review workspace every time, the system should collapse safe edits and say something like:

- 27 safe edits are folded
- 3 decisions need your judgment

This is critical because execution becomes cheap in AI systems; human verification becomes the bottleneck.

### 7.8 Object-local controls

The most natural interaction model is for controls to appear next to the selected object.

Examples:

- click subtitle → edit/apply to all/add to glossary
- click B-roll → replace/view candidates/require owned assets only
- click removed ghost clip → restore/keep removed/shorten instead/lock this beat

This is more intuitive than pushing all possible actions into a global side panel.

### 7.9 Batch mode should remain contextual

The campaign variant grid should not be permanently visible. It should appear only when the user is working on variation-generation tasks.

Otherwise, the main UI should still feel like a familiar editor.

---

## 8. Core UX principles we converged on

The following principles summarize the UI strategy we converged on.

### 8.1 Editing-first, AI-second

The app should still look and feel primarily like an editor.

### 8.2 Expose user tasks, not system architecture

Surface user-intuitive verbs like:

- fix subtitles
- find B-roll
- generate hooks
- check brand

Not internal abstractions like mission/orchestration/receipt.

### 8.3 Disclose based on risk

Low-risk tasks should require minimal explanation.

High-risk tasks should show scope, boundaries, and require explicit preview/review.

### 8.4 Fold safe changes; highlight exceptions

The review model should focus user attention on dangerous or subjective edits.

### 8.5 Let direct manipulation become intent input

Dragging, replacing, deleting, locking, and adjusting timeline objects should teach the system preferences without forcing the user to switch to a separate settings/configuration experience.

### 8.6 Keep memory visible and editable

Creator Profile and Brand Kit should not be hidden black-box memory systems. They should be inspectable, editable, overridable, and partially writable from normal UI actions.

### 8.7 Support partial acceptance and local correction

Users should be able to accept only part of a grouped change and reject or modify the rest.

---

## 9. Proposed product surfaces

Rather than fixed heavyweight tabs, the product should likely organize itself into a few contextual surfaces.

### 9.1 Editing Canvas

Always visible.

Contains:

- player
- timeline
- selected-object context

### 9.2 AI Dock

Always present but lightweight.

Purpose:

- capture user tasks
- offer shortcuts to common AI jobs
- display small status/preflight information

### 9.3 Preflight Card

Appears after the user initiates an AI job.

Purpose:

- bounded delegation
- scope confirmation
- guardrail visibility

### 9.4 Context Bubble

Appears near selected changes or timeline objects.

Purpose:

- local accept/reject/edit/lock/replace actions

### 9.5 Exception Drawer

Appears only when there are unresolved risky items.

Purpose:

- review the few issues requiring human judgment

### 9.6 History / Receipt Panel

Usually collapsed.

Purpose:

- versioning
- rollback
- audit trail
- enterprise approvals and compliance traceability

---

## 10. Immediate recommendations

### Product

1. Position ChatCut clearly as an AI copilot, not an autonomous editor.
2. Use one shared substrate with two user-facing modes:
   - Creator Mode
   - Campaign Mode
3. Build Campaign Mode first if commercial validation is the priority.
4. Preserve reviewable changesets and human approval as a core product invariant.

### UX

1. Keep the editing canvas primary.
2. Make AI contextual and task-oriented.
3. Use progressive disclosure aggressively.
4. Collapse safe changes by default.
5. Show controls only where and when they are needed.
6. Keep persistent state low-noise but visible.
7. Let timeline/object interactions become preference learning opportunities.

### Docs / repo

1. Clarify README and product positioning.
2. Define documentation source-of-truth structure.
3. Clean up `.omc` contents.
4. Track open vs. implemented state in one place.

---

## 11. Final synthesis

The core ChatCut opportunity is not “AI that can edit videos end to end with one prompt.”

The real opportunity is:

> A trustworthy AI editing copilot that understands meaning, brand constraints, and timeline structure well enough to remove repetitive work—while preserving creative ownership and making every important AI action previewable, reviewable, and reversible.

That means the breakthrough is not only model capability. It is the combination of:

- semantic understanding
- robust editing substrate
- constraint-aware generation and retrieval
- human-in-the-loop review
- UI that feels familiar, progressive, and low-friction

If ChatCut gets that combination right, it can occupy a real middle ground between template-heavy consumer editors and heavy professional tools with shallow AI features.
