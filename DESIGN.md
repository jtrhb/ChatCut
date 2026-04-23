---
version: alpha
name: ChatCut
description: Visual identity for an AI editing copilot — surgical, dense, calm. Pro-NLE palette, single accent, every AI affordance tinted on top of the real workspace.
colors:
  background: "#0d0d10"
  surface: "#1a1a20"
  surface-raised: "#22232a"
  border: "#2a2b33"
  primary: "#5fb3a8"
  primary-dim: "#3d8a82"
  warning: "#d4a358"
  danger: "#d97a7a"
  text-primary: "#e8e8e8"
  text-secondary: "#9a9a9a"
  text-muted: "#6a6a6a"
  on-primary: "#0d0d10"
  on-warning: "#0d0d10"
  on-danger: "#0d0d10"
typography:
  display:
    fontFamily: Inter
    fontSize: 1.75rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.01em
  h1:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.005em
  h2:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1.4
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.01em
  caption:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: 400
    lineHeight: 1.35
  timecode:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1
    fontFeature: '"tnum" 1'
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.6875rem
    fontWeight: 400
    lineHeight: 1.3
rounded:
  none: 0px
  sm: 4px
  md: 6px
  lg: 8px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
components:
  preview-pane:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.none}"
  timeline-track:
    backgroundColor: "{colors.surface}"
    height: 56px
  clip:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: 0px
  ghost-high-confidence:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
  ghost-medium-confidence:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
  ghost-low-confidence:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
  lineage-glyph:
    textColor: "{colors.primary}"
    height: 8px
  holding-strip:
    backgroundColor: "{colors.surface}"
    height: 80px
    padding: 8px
  holding-strip-thumb:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.sm}"
    size: 64px
  provenance-badge:
    backgroundColor: "{colors.background}"
    textColor: "{colors.primary}"
    rounded: "{rounded.pill}"
    size: 14px
  status-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 6px
  bubble:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 8px
  bubble-question:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
  bubble-warning:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.warning}"
    rounded: "{rounded.md}"
  prompt-field:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 8px
  prompt-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 4px
  breadcrumb:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    padding: 8px
  drawer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 16px
  toolbar:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-secondary}"
    height: 40px
  context-bubble-anchor:
    backgroundColor: "{colors.primary}"
    size: 6px
    rounded: "{rounded.pill}"
  cta-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 8px
  chip-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-warning}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 4px
  chip-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 4px
  separator:
    backgroundColor: "{colors.border}"
    height: 1px
---

## Overview

ChatCut is an AI editing copilot for professional creators and marketing
teams. Its visual language is **architectural minimalism over a dark
canvas, with a single accent color carrying every interactive
affordance.** The product should feel like a serious tool — closer to
DaVinci Resolve and Final Cut than to any "AI chatbot with timeline
attached."

The defining principle: **AI never takes its own panel.** Every AI
affordance — ghost overlays, lineage glyphs, provenance badges, pinned
bubbles — is rendered as a translucent or thin-line tint *on top of*
the existing editor surfaces (timeline, preview pane, holding strip).
The visual signal: AI is the workspace's quiet collaborator, not a
parallel window competing for attention.

Two corollaries that drop out of this:

- **Single accent (muted teal `#5fb3a8`).** Confidence-coded
  alternates exist (amber for medium-confidence, muted red for
  low-confidence), but they're for *trust calibration*, not visual
  richness. Resist the temptation to add a fourth accent for "info" or
  "neutral active state" — the dark surface itself plays that role.
- **Dense type, sparse color.** The interface is information-rich and
  visually quiet. Type appears almost monochrome (off-white on near-
  black). Color appears only where it carries meaning (confidence,
  provenance, system status).

Companion docs: `docs/chatcut-ux-vision.md` for the full UX rationale,
`docs/intent-ux-design-review.md` for the underlying Intent-UX
framework, `docs/chatcut-discussion-summary.md` for product positioning.

## Colors

The palette is **5 dark neutrals + 3 confidence-coded accents + 3
text tones.** The neutrals stack progressively to create depth without
shadow.

### Neutrals

- **`background` (`#0d0d10`)** — the canvas. Used behind everything.
  Near-black but warmed slightly toward blue to read as "matte" rather
  than "OLED black." This is the only color a user sees fill more than
  20% of the screen.
- **`surface` (`#1a1a20`)** — primary panel surface. Holding strip,
  toolbar background, drawer surface, status-pill chrome. ~10% lighter
  than background — present but quiet.
- **`surface-raised` (`#22232a`)** — for clips, thumbnails, prompt
  fields, bubbles. Anything the user directly manipulates. Provides
  the subtle layering that makes the active path readable against
  passive chrome.
- **`border` (`#2a2b33`)** — used sparingly. Only for component
  separators where surface-raised would not provide enough contrast.

### Accents (confidence-coded)

The three accent colors are NOT aesthetic choices. They map to the
confidence value the agent emits with every proposal (`confidence ∈
[0, 1]`).

- **`primary` (`#5fb3a8`)** — muted teal. **High confidence (≥0.7).**
  Solid borders on ghosts, active button states, primary CTAs, the
  lineage-glyph dots, the active prompt-field chip, the
  provenance-badge fill. This is "the agent's voice" wherever it
  appears. Contrast vs `background`: ~8:1 (passes WCAG AA).
- **`primary-dim` (`#3d8a82`)** — desaturated primary. Used for
  primary-color states that need to recede (inactive nav, secondary
  fills inside a primary container).
- **`warning` (`#d4a358`)** — amber. **Medium confidence (0.4–0.7).**
  Dashed borders on medium-confidence ghosts, pacing-related warnings,
  the bubble-warning text color. Contrast vs `background`: ~9:1
  (passes WCAG AA).
- **`danger` (`#c46a6a`)** — muted red. **Low confidence (<0.4) or
  destructive operations.** Dashed borders on low-confidence ghosts,
  reject-action affordances, license-expiration warnings. Contrast
  vs `background`: ~5:1 (passes WCAG AA, tight).

### Text

- **`text-primary` (`#e8e8e8`)** — body text, headlines, anything
  needing direct readability. Contrast vs `background`: ~16:1.
- **`text-secondary` (`#9a9a9a`)** — labels, metadata, status pill
  text, breadcrumb segments. Contrast vs `background`: ~7:1.
- **`text-muted` (`#6a6a6a`)** — disabled states, captions, very
  low-priority text. Contrast vs `background`: ~4:1 — fails WCAG AA
  for normal text but passes WCAG AA for ≥18px body or ≥14px bold.
  **Do not use `text-muted` for any text smaller than label size or
  any text the user must read to act.**

### "On-color" tokens

When primary/warning/danger fills are used as backgrounds (rare —
mostly for the small filled provenance-badge interior), text on top
must use `on-primary` / `on-warning` / `on-danger` — all of which
resolve to `background`. This guarantees high contrast on filled
chips/badges.

### Intentionally-orphaned tokens

Two color tokens are defined in the front matter but **deliberately not
consumed by any component definition**, and the linter will warn about
them. This is intentional:

- **`primary-dim` (`#3d8a82`)** — reserved for **non-text decorative
  use only** (desaturated borders on inactive ghosts, recede-state
  fills behind a text layer of a different color). It fails WCAG AA
  as a textColor on any of our surfaces, by design — its purpose is
  to recede. The linter cannot verify "non-text only," so the orphan
  warning is the cost of keeping it available.
- **`text-muted` (`#6a6a6a`)** — reserved for **disabled-state text
  only**. The prose's density rules forbid it for any text the user
  must read to act. Wiring it to a component would create a WCAG AA
  failure for any non-disabled use, so it stays orphaned and is
  applied via direct CSS where appropriate.

## Typography

ChatCut uses **two typefaces only: Inter for UI text, JetBrains Mono
for timecode and technical labels.** Both are open-source and
distributed via Google Fonts. Deliberate choice — fewer fonts means
the interface reads as one tool, not a federation of widgets.

- **Inter** is variable-weight, designed for screen rendering, and is
  the de facto standard for modern dense UIs (Linear, Vercel, Stripe,
  Figma). The Inter family handles everything from `display` headers
  down to `caption` annotations.
- **JetBrains Mono** is used for **timecodes** (`00:01:42:14` style),
  framerate readouts, and any place tabular alignment matters. The
  `tnum` OpenType feature is enabled by default on `timecode` so digit
  widths stay consistent during playback (no wobble as numbers
  increment).

### Type scale

The scale is intentionally short — 9 named styles, no in-between sizes.
Designers and agents should pick the closest existing token rather than
introducing new sizes.

| Token | Size | Use |
|---|---|---|
| `display` | 1.75rem / 28px | Empty-state hero ("describe the video you want") only |
| `h1` | 1.25rem / 20px | Drawer titles, modal headers |
| `h2` | 1rem / 16px | Section headers inside drawers/panels |
| `body-md` | 0.875rem / 14px | Default body text, prompt-field input |
| `body-sm` | 0.8125rem / 13px | Bubble text, secondary content |
| `label` | 0.75rem / 12px | Status pills, prompt chips, badges |
| `caption` | 0.6875rem / 11px | Lineage labels, provenance hints, micro-meta |
| `timecode` | 0.75rem / 12px | Mono. Timecode displays. |
| `mono-sm` | 0.6875rem / 11px | Mono. Frame counters, technical labels. |

### Density rules

- **Caption text (≤11px) is reserved for in-context hints** anchored
  to a specific clip/bubble/glyph. Never use it as primary content.
- **Body text appears in tight blocks** — no more than 60 characters
  per line on the prompt field, no more than 80 in the drawer. The
  drawer is for thinking, not reading articles.
- **One-to-three-word labels** are the default everywhere visual
  density matters (timeline, holding strip, badges). Reserve full
  sentences for the bubble surface and the drawer.

## Layout

ChatCut uses a **4px base spacing grid.** Every visual gap, padding,
and margin should resolve to one of the named scale values. Inventing
intermediate values (10px, 14px) breaks rhythm and signals undisciplined
implementation.

| Token | px | Use |
|---|---|---|
| `xs` | 4 | Tight stacks of icons, badge interior, glyph spacing |
| `sm` | 8 | Default gap inside small components (chips, badges, pills) |
| `md` | 12 | Default gap inside medium components (bubbles, prompt fields) |
| `lg` | 16 | Default gap between sibling components, drawer interior padding |
| `xl` | 24 | Section separators, holding strip vertical padding |
| `xxl` | 32 | Major surface separators (preview ↔ timeline) |

### Track and clip dimensions

- **Timeline track height: 56px.** Calibrated so a 64px holding-strip
  thumb can drag onto a track with visible insertion guides on both
  sides. Below 48px, lineage glyphs would crowd; above 72px, the
  timeline density drops below the 200-clip-on-screen target from the
  engineering plan.
- **Holding strip height: 80px.** Container for 64px thumbs with 8px
  vertical padding.
- **Holding strip thumbnail: 64px square.** Tall enough to render a
  meaningful frame preview at 16:9 aspect; small enough to fit ~12 in
  the visible viewport on a typical 14" laptop without scrolling.

### Surface stacking

Surfaces stack vertically:
1. `background` (canvas) — the deepest layer
2. `surface` (panels, holding strip, toolbar) — the chrome layer
3. `surface-raised` (clips, thumbs, bubbles, prompt fields) — the
   interactive layer

Going beyond three stack levels is a smell. If a fourth layer feels
needed, the design probably wants a separator (`border` token) instead
of more depth.

## Elevation & Depth

ChatCut intentionally uses **no shadows.** Depth is communicated by:

1. **Surface lightness stacking** (background → surface →
   surface-raised — each ~10% lighter than the layer below)
2. **Subtle 1px borders** in the `border` color where surface stacking
   alone is insufficient
3. **Translucent overlays** for ephemeral elements (ghosts, drawer
   open animation)

Why no shadows: shadows imply physical metaphor (paper on paper). The
interface is information-dense and digital-native. Shadows would add
visual noise without communicating new information, and they perform
poorly in canvas/WebGL rendering compared to solid color stacks.

The one exception: the **drawer** when summoned uses a 16px-wide soft
gradient at its top edge to suggest it's lifting off the timeline.
This is a depth cue, not a shadow — purely a translucency gradient
from `background` to transparent.

## Shapes

| Token | px | Use |
|---|---|---|
| `none` | 0 | Preview pane, full-bleed surfaces |
| `sm` | 4 | Clips, thumbnails, holding-strip thumbs, prompt chips |
| `md` | 6 | Bubbles, prompt fields, contextual UI |
| `lg` | 8 | Drawer, modal overlays |
| `pill` | 999 | Status pills, provenance badges, the context-bubble-anchor dot |

The corner-radius philosophy: **the more ephemeral or
human-attention-demanding an element, the rounder it is.** Clips
(structural, persistent) are nearly square. Bubbles (the agent
talking) are noticeably rounded. Status pills (transient ambient
state) are fully pill-shaped. This visual rhythm tells the user
"persistent things look architectural; conversational things look
soft."

## Components

This section names the components specific to ChatCut's unified-graph
surface. Each is normatively defined in the YAML front matter; the
prose below explains the *why*.

### Ghost system (the heart of the surface)

A ghost is an overlay rendered ON TOP of the canonical timeline that
represents an agent proposal not yet committed. Three confidence
variants:

- **High confidence (≥0.7) → `ghost-high-confidence`** — solid 1px
  teal (`primary`) border, 30% fill opacity over the underlying clip.
- **Medium confidence (0.4–0.7) → `ghost-medium-confidence`** — dashed
  1px amber (`warning`) border, 25% fill opacity.
- **Low confidence (<0.4) → `ghost-low-confidence`** — dashed 1px red
  (`danger`) border, 20% fill opacity.

The opacity descent intentionally tracks confidence: lower confidence
= more transparent = less visually committal. Trust calibration is
encoded in the rendering, not in a separate confidence label.

A ghost in `expanded` state (junction-sign clicked, three alternates
lifted) gets the same border styling but is positioned 56px above the
active clip in the same column. The active clip beneath dims to 60%
brightness while alternatives are auditioning.

### Lineage glyphs (the unified-graph signal)

Two glyph types appear above clips on the active path:

- **Three-dot stack (`••• ` aligned vertically or horizontally)** —
  signals "this clip has N sibling alternatives." Always teal
  (`primary`). Click to expand into the ghost-stack interaction above.
- **Micro-thumbnail row (4 small frames)** — signals "this clip has
  been refined N times." Color-neutral (uses the actual frame
  thumbnails). Click to walk the lineage upward.

Density rule: **glyphs appear only above clips that have lineage to
show.** A pristine raw clip has no glyphs. This means a typical
timeline reads as mostly empty space above clips, with occasional
glyphs marking where the agent has worked. Visual quietness is the
signal that the agent has been measured, not aggressive.

### Holding strip & provenance badges

The holding strip is a horizontal tray of unbound moments below the
timeline. Every thumbnail carries a corner badge (bottom-right, 14px
pill, teal) with one of four icons:

- **Camera icon** — raw footage uploaded by the user
- **Spark icon** — content generated by an AI model
- **Branch icon** — a variant from a prior session or exploration
- **Refresh icon** — a re-edit of an existing committed clip

The badges are the same shape, size, and color — only the icon
differs. This is the visual signal that the holding strip is one tray,
not four federated bins.

### Pinned bubbles

Bubbles are how the agent speaks. Each bubble is anchored to a clip,
ghost, or timeline position via a 6px teal dot
(`context-bubble-anchor`) connected by a 1px line to the bubble body.
Three variants:

- **Default (`bubble`)** — informational. White text, no accent border.
- **Question (`bubble-question`)** — agent asking for input. Teal
  text, single `?` glyph in the corner.
- **Warning (`bubble-warning`)** — agent surfacing a constraint or
  risk. Amber text, single `!` glyph.

Bubbles fade in over 200ms. Click expands; click outside dismisses.
The history isn't a transcript — it's anchored on the timeline. To
"see what the agent said about clip 7 last Tuesday," scrub to clip 7.

### Context-bound prompt field

The prompt field is the active-input ambient channel (UX vision §4.3).
It pins itself to the current selection and shows the bound context
as inline chips. When nothing is selected, it floats at the bottom of
the workspace as a faint global field. When a clip is selected, it
attaches to the clip's right edge with a `[clip-N]` chip pre-filled.
The field is `body-md` typography on `surface-raised`.

### Status pills

The two ambient status pills (`3 ghosts · 2 unplaced` style) live
top-right and bottom-right of the workspace respectively. They use
`label` typography on `surface`, `text-secondary` color, fully
pill-shaped. They are the only persistent ambient signal that doesn't
attach to a specific element — they describe global state.

### Breadcrumb

For nested compositions: `Project › Hook Sequence › Logo Animation`.
Lives at the top of the workspace, using `label` typography in
`text-secondary`. The current segment (rightmost) is in `text-primary`
to indicate "you are here." Click any earlier segment to return up
one level. The breadcrumb is the *only* nav UI in the entire product
— no sidebar, no tabs, no panels.

### Drawer

The summoned conversation drawer (UX vision §4.4). Slides up from the
bottom edge on keyboard shortcut. `surface` background, 16px padding,
8px corner radius on the top-left and top-right only. Contains a
standard chat thread but with a "show on timeline" affordance on
every message. Dismissed with the same shortcut.

## Do's and Don'ts

### Do

- **Use `primary` (teal) only for AI-confidence-high signals,
  user-active interactive states, and the lineage glyphs.** Anything
  else dilutes the trust calibration semantics.
- **Stack surfaces by lightness** rather than by shadow.
- **Keep visual quietness.** A typical workspace screenshot should
  show roughly 80% dark neutral, 15% subtly-different surfaces, and
  ≤5% accent color.
- **Prefer 1-3 word labels** in any UI element smaller than `body-md`.
- **Resolve every spacing value to a named scale token.** Never use
  arbitrary values (10px, 14px, 18px).
- **Animate via the renderer's ticker** (canvas surfaces) or CSS
  transitions (DOM chrome), never via React state-driven loops.

### Don't

- **Don't introduce a fourth accent color.** No purple "info" tokens,
  no orange "active" tokens, no blue "link" tokens. The palette is
  intentionally narrow.
- **Don't use shadows.** Use surface stacking and 1px borders.
- **Don't use `text-muted` for any text the user must read to act.**
  Reserve it for disabled states and decorative captions.
- **Don't put AI affordances in their own panel.** Ghosts on the
  timeline. Bubbles anchored to clips. Prompts attached to selection.
  No floating "AI tool" sidebar exists in this product.
- **Don't use serif fonts.** Inter for everything except timecodes.
- **Don't use color to mean two different things.** Teal is "agent
  high-confidence + active state + lineage signal." It does not also
  mean "primary brand color in a marketing sense" or "completed
  status." If a new semantic need arises that doesn't fit the existing
  three-color confidence scheme, find a non-color way to encode it
  (icon, weight, animation).
- **Don't decorate.** Every visual element should carry meaning. If
  you can remove an element without losing communicative function, it
  shouldn't be there in the first place.
