# Plan: Phase 3 Full Implementation — Modal-Native GPU Service + Preview Pipeline

Supersedes the prior Playwright/HeadlessRenderer-in-agent plan (see git history of this file before 2026-04-21). Architecture pivoted to a dedicated Python service on Modal per 2026-04-21 brainstorm.

Source: `.omc/plans/wiring-audit-remediation.md` Phase 3 acceptance criteria. The audit's "browser pool inside agent" wording is treated as one valid implementation; this plan picks a different one.

Date: 2026-04-21

**Status:**
- Stage A — CLOSED + APPROVED. 4 commits.
- Stage B — CLOSED + APPROVED. 7 commits (incl. 2nd pivot to MLT, see §0.b). 113 tests passing. Manual B.7 staging smoke (`modal serve` + ffprobe) is the user's.
- Stage C — CLOSED + APPROVED. 11 commits. 1156 agent + 120 gpu = 1276 tests passing.
- Stage D — CLOSED + APPROVED WITH NITS. 2 commits. 1170 agent tests passing (+14). Reviewer carried-over notes folded into Stage E:
   - MEDIUM #1: extend web `ToolProgressSseEvent` to declare `explorationId/candidateId` (closed in E.6)
   - MEDIUM #2: candidate_ready has no web handler (closed in E.6)
   - LOW #3: `safeForLog` not applied to synthetic toolCallId (defense-in-depth, defer to user-supplied-ID future path)
- Stage E — CLOSED + APPROVED. 6 commits (5 stage + 1 reviewer-fix). 1213 agent tests passing (+43). All 10 reviewer findings (1 HIGH + 4 MED + 3 LOW + 2 NIT) FIXED in bd0d7f7a; re-review verdict: APPROVE.
- Stage F — CLOSED. 2 commits. HeadlessRenderer + RENDERER_BASE_URL deleted (acceptance grep returns nothing); R2 lifecycle ops runbook expanded; §3.6 Daytona superseded by Modal documented; Phase 3 marked closed in audit plan; top-level README mentions services/gpu + Modal setup.

**Phase 3: COMPLETE** — Modal-native GPU service shipped end-to-end. 1207 agent tests + 120 gpu tests passing.

---

## 0. Why this changed (vs prior plan)

The prior plan (commit 33587efc landed the scaffold) wired a chromium pool inside `apps/agent` driving a Vite-bundled renderer host. That works but:

- bloats every agent container with ~500MB chromium
- forces every render to share agent CPU/RAM
- only solves preview render — vision, generation, and transcription still need separate GPU plumbing
- locks us out of horizontal GPU scale-out beyond a single agent process

Modal credit availability (4× B200 + L4/A100 tiers) plus the fact that ChatCut needs GPU across multiple workloads (preview render, video generation, vision analysis, transcription) makes a dedicated Python GPU service the right primitive. Preview render becomes one workload of four; the others stub now and fill in during Phase 5+.

The `HeadlessRenderer` scaffold (`apps/agent/src/services/headless-renderer.ts`) is **deprecated by this plan**. Stage F removes it cleanly.

### 0.b Second pivot (2026-04-21) — MLT instead of chromium-in-Modal

Stage A leaned Q1c (chromium-in-Modal reusing the apps/web SceneExporter). During Stage B planning we questioned whether we needed chromium at all. After confirming compositing matters and the exporter must be fast, we surveyed open-source options and chose **MLT Framework** (`libmlt` / `melt`) — the multi-track NLE engine behind Shotcut, Kdenlive, and Flowblade.

Why MLT:
- 20+ years mature, proven in 3 production OSS NLEs
- Multi-track compositing, transitions, filters, audio mixing built-in
- GPU acceleration via Movit (OpenGL renderer) + h264_nvenc (ffmpeg backend)
- Python bindings (`python3-mlt`) and CLI (`melt`)
- Container weight: ~100MB (vs ~500MB for chromium)
- We write a thin `SerializedEditorState → MLT XML` translator (~200 LOC) and let melt do the rendering

Q1 closes with **Q1d** (see §6) and supersedes the prior Q1a/Q1b/Q1c options.

Asset URL resolution (`mediaId` → R2 URL) and the candidate snapshot's storage_key in the job payload are Stage C concerns, surfaced from the B.0 spike.

---

## 1. Goal (audit acceptance criteria, unchanged)

- User selects fan-out → 4–16 candidates render in <30s wall time
- Each candidate card has a playable 5–10s MP4
- R2 cleanup removes `previews/{explorationId}/` after 24h
- §3.6 Daytona decision: **superseded by Modal** — documented in Stage F

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  apps/agent (Bun/Hono)                                                   │
│                                                                          │
│   pg-boss preview-render worker                                          │
│   ├─ gpu-service-client.enqueueRender({timeline, ids}) → {jobId}        │
│   ├─ poll gpu-service-client.getJobStatus(jobId) every ~1.5s            │
│   │    └─ forward progress → eventBus.emit(tool.progress) → SSE         │
│   ├─ on done: write storageKey → exploration_sessions DB                │
│   │           emit(candidate_ready)                                     │
│   └─ on failed: write preview_render_failures + emit tool.error         │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │ HTTPS, X-API-Key header
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  services/gpu/  (NEW Python project, deployed via `modal deploy`)        │
│                                                                          │
│   modal_app.py — App + image (debian-slim + ffmpeg + py deps)           │
│                                                                          │
│   @app.function(gpu="T4", min_containers=1, secrets=[GPU_API_KEY])      │
│   @web_endpoint(method="POST", label="render_preview")                  │
│   def render_preview(req) → {jobId}    [returns immediately, spawns]    │
│                                                                          │
│   @app.function(gpu="L4", min_containers=0)                             │
│   @web_endpoint(method="POST", label="generate_video")                  │
│   def generate_video(req) → {jobId}    [STUB — Phase 5]                 │
│                                                                          │
│   @app.function(gpu="L4", min_containers=0)                             │
│   @web_endpoint(method="POST", label="analyze_video")                   │
│   def analyze_video(req) → {jobId}     [STUB — Phase 5]                 │
│                                                                          │
│   @app.function(gpu="L4", min_containers=0)                             │
│   @web_endpoint(method="POST", label="transcribe")                      │
│   def transcribe(req) → {jobId}        [STUB — Phase 5]                 │
│                                                                          │
│   @web_endpoint(method="GET", label="status")                           │
│   def status(job_id) → {state, progress?, result?, error?}              │
│                                                                          │
│   Job state: Modal Dict (key=job_id, TTL=1h)                            │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │ Modal-side: subprocess + R2 boto3 client
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Cloudflare R2 — `previews/{explorationId}/{candidateId}.mp4`            │
│  24h lifecycle policy on `previews/` prefix                              │
└──────────────────────────────────────────────────────────────────────────┘
```

Note: the agent never holds the canonical job state. Modal Dict holds it short-term so the agent can poll; the pg-boss row in our DB is canonical. If Modal Dict TTLs the entry while pg-boss still has work, the worker treats it as a failure and retries via pg-boss.

---

## 3. Stages

Each stage independently shippable + reviewable. Same per-phase rhythm as Phase 2/4 (test → impl → smoke → commit → reviewer pass → fixes → commit).

### Stage A — `services/gpu/` skeleton + Modal app shell (1d)

**Goal**: a deployed Modal app exposing 4 web endpoints (3 stubs + 1 real-shaped render_preview that returns synthetic bytes), `X-API-Key` auth, status endpoint, Modal Dict job state, README, and Bun-side aliases.

| # | Task | Location |
|---|---|---|
| A.1 | `services/gpu/` directory: `pyproject.toml`, `uv.lock`, `.python-version` (3.12), `ruff.toml`, `pytest.ini` | new |
| A.2 | `services/gpu/modal_app.py` — App, image (`debian-slim` + `ffmpeg` + `boto3` + `pydantic`), shared `JobState` model, Modal Dict named `gpu_jobs` | new |
| A.3 | Stub `render_preview` web_endpoint — accepts payload, generates job_id, writes `{state: "queued"}` to Dict, kicks off background `.spawn()` that synthesizes 1KB of placeholder bytes and uploads to R2. Returns `{jobId}`. | A.2 |
| A.4 | Stub `generate_video`, `analyze_video`, `transcribe` web_endpoints — each returns HTTP 501 with `{error: "not implemented", phase: "5"}` | A.2 |
| A.5 | `status` GET endpoint — reads job_id from Dict, returns shape `{state, progress?, result?, error?}` | A.2 |
| A.6 | Auth: `Modal.Secret("gpu-api-key")` with `GPU_SERVICE_API_KEY` value; middleware verifies `X-API-Key` header on all endpoints, returns 401 on mismatch | A.2 |
| A.7 | R2 client: `services/gpu/src/r2.py` wrapping boto3 (R2 endpoint URL, access key, secret) — Modal Secret pulls from env | new |
| A.8 | Pytest: unit tests for auth, status shape, R2 client mocking. Run via `uv run pytest`. | new |
| A.9 | `services/gpu/README.md` — `modal deploy`, `modal serve`, env var list, deploy URL pattern | new |
| A.10 | Root `package.json`: `gpu:serve`, `gpu:deploy`, `gpu:test`, `gpu:lint` script aliases shelling into `services/gpu/` (uv-based) | edit |
| A.11 | `.gitignore`: ignore `services/gpu/.venv`, `__pycache__`, `.modal_volumes` | edit |
| A.12 | CI: skip `services/gpu/` tests when `MODAL_TOKEN_ID` not present (gated). Note in README. | CI config |

**Acceptance**: `bun run gpu:serve` (Modal dev mode) yields a live URL. `curl -H "X-API-Key: $GPU_SERVICE_API_KEY" -X POST $URL/render_preview -d '{"explorationId":"x","candidateId":"y","timeline":{}}'` returns `{jobId: "..."}`. Polling `/status/...` cycles `queued → running → done` and the result includes a real (placeholder) R2 storage_key.

### Stage B — `render_preview` via MLT (3d, increased from 1.5d)

**Goal**: render_preview produces a playable MP4 from a real `SerializedEditorState`. v1 feature scope (from B.0 spike): multi-track video compositing, hard cuts, single audio track, static text overlays, static transforms. Out-of-scope for v1: animation keyframes (use first-keyframe value), effect tracks, sticker tracks, crossfade transitions, BlendMode beyond normal.

| # | Task | Location |
|---|---|---|
| B.0 | Plan rewrite + MODAL_IMAGE.md seed (Stage B preamble) | docs |
| B.1 | `services/gpu/src/timeline_to_mlt.py` — pure-Python `SerializedEditorState → MLT XML` translator covering v1 features | new |
| B.2 | TDD fixtures: 4 sample SerializedEditorStates (single clip, multi-clip cut, multi-track composite, text overlay). Assert valid MLT XML. | new test |
| B.3 | `services/gpu/src/render.py` — asset fetcher (R2 → local /tmp) + `render_timeline(state) → bytes` orchestrator: calls B.1, downloads assets, runs `melt timeline.xml -consumer avformat:... vcodec=h264_nvenc`, reads result | new |
| B.4 | Modal image rebuild: add `apt_install("melt", "libmlt++7", "libmlt-data", "frei0r-plugins")` + ffmpeg-cuda variant. CPU `libx264` fallback for local dev. Append MODAL_IMAGE.md entry. | edit modal_app.py + MODAL_IMAGE.md |
| B.5 | Wire `render.render_timeline` into `handlers.do_render_body` — replace placeholder `body_bytes` arg | edit handlers.py + modal_app.py |
| B.6 | E2E test: real fixture → MLT XML → melt subprocess → MP4 → ffprobe asserts duration/codec/dimensions | new test |
| B.7 | Smoke: deploy to Modal staging, render the fixture, download from R2, play in QuickTime/VLC | manual |

**Acceptance**: real `SerializedEditorState` (multi-track composite with text overlay) → 5–10s playable MP4 in R2. Render <8s on Modal T4 for a 5s clip. Out-of-scope features either silently degrade (animations → first-keyframe value) or get logged as "skipped" (effect/sticker tracks).

### Stage C — Agent dispatcher + snapshot-storage-key contract (1.5d, increased from 0.75d)

**Goal**: agent calls Modal via `gpu-service-client`. The GPU endpoint contract is rewritten so render_preview accepts `snapshotStorageKey` (R2 key) instead of an inline `timeline` dict — Modal-side fetches the snapshot itself, eliminating multi-MB request bodies for big projects.

**Decisions resolved 2026-04-21** (see §6):
- **C-Q1 (CHOSEN: snapshotStorageKey)**: ExplorationEngine already pre-uploads each candidate's serialized snapshot to R2. The pg-boss job payload now carries that storage_key instead of the raw timelineSnapshot. Renderer fetches from R2 inside `_do_render` via the same R2Uploader used for the output upload.
- **C-Q2 (CHOSEN: client unwraps `detail`)**: FastAPI's HTTPException wraps body under `{"detail": ...}`. The gpu-service-client unwraps `body.detail.{error,phase}` in its typed error mapping for 4xx/5xx; the agent never sees the FastAPI envelope.

| # | Task | Location |
|---|---|---|
| C.0 | Plan rewrite (this commit) — surface C-Q1 / C-Q2 decisions, restructure tasks | docs |
| C.1 | ExplorationEngine: capture R2 storage_key from `objectStorage.upload(...)` return + thread `snapshotStorageKey` into `jobQueue.enqueue("preview-render", ...)` payload (replaces raw `timelineSnapshot`) | edit `apps/agent/src/exploration/exploration-engine.ts` + tests |
| C.2 | GPU service contract: render_preview endpoint payload changes from `{timeline}` to `{snapshotStorageKey}`. `_do_render` fetches JSON via R2Uploader.download_bytes (NEW helper), parses, then proceeds. handlers.handle_render_preview validates snapshotStorageKey shape. | edit `services/gpu/modal_app.py` + `src/handlers.py` + `src/r2.py` + tests |
| C.3 | `apps/agent/src/services/gpu-service-client.ts` (NEW) — `enqueueRender({explorationId, candidateId, snapshotStorageKey})`, `getJobStatus(jobId)`, typed response shapes. Uses `fetch`, `X-API-Key` from env. Throws typed errors on 4xx/5xx, unwrapping FastAPI `detail` envelope. | new |
| C.4 | gpu-service-client tests — mock fetch, verify wire shape, auth header, 4xx/5xx error mapping including 501-detail unwrap | new test |
| C.5 | `apps/agent/src/index.ts` preview-render worker: replace HeadlessRenderer scaffold path with gpu-service-client.enqueueRender; worker holds open until polled-to-done (Stage D wires the real polling). | edit |
| C.6 | Env vars: `GPU_SERVICE_BASE_URL`, `GPU_SERVICE_API_KEY`. Boot warning if missing. | edit `apps/agent/src/env.ts` |
| C.7 | Worker integration test: mock gpu-service-client returns synthetic jobId + status sequence, assert worker handles enqueue → poll → complete lifecycle | new test |

**Acceptance**:
- Agent + GPU service unit tests green.
- Worker boot logs `[boot] gpu-service-client wired (URL=...)`.
- ExplorationEngine emits a job payload with `snapshotStorageKey` (verified via integration test against in-memory job queue).
- HeadlessRenderer scaffold remains untouched (deletion is Stage F).

### Stage D — Progress polling + SSE forwarding (0.5d)

**Goal**: per-candidate progress reaches the web UI through the existing tool.progress pipeline (Phase 4).

| # | Task | Location |
|---|---|---|
| D.1 | Worker polls `getJobStatus(jobId)` every 1.5s with backoff cap 5s after 30s no-change | edit `index.ts` |
| D.2 | Map `{state, progress}` → `safeProgress({toolName: "render_preview", pct, message})` per existing helper | edit |
| D.3 | Timeout: hard cap 90s per render. On timeout → mark failed, emit tool.error, do not block worker | edit |
| D.4 | Test: poll loop with mock client that emits `running 0,25,50,75 → done`, assert SSE event sequence shape + final candidate_ready | new test |

**Acceptance**: integration test asserts at least 4 progress events between enqueue and done, plus 1 candidate_ready.

### Stage E — Fan-out e2e + DB + web wiring (0.75d)

**Goal**: fan-out of 4 candidates produces 4 storage keys in DB and 4 SSE events to web. Same as old Stage C, retargeted at Modal client.

| # | Task | Location |
|---|---|---|
| E.1 | Worker writes `exploration_sessions.preview_storage_keys[candidateId] = storageKey` on done | edit |
| E.2 | Worker writes `exploration_sessions.preview_render_failures[candidateId] = {message, ts}` on failed | edit (schema migration) |
| E.3 | `routes/exploration.ts`: replace hardcoded storageKey with DB lookup. Distinguish 404 (no row), 503 (R2 down), 422 (failed render). | edit |
| E.4 | Mount `createExplorationRouter` in `server.ts` infrastructure block | edit |
| E.5 | EventBus: emit `candidate_ready` carrying `{explorationId, candidateId, previewUrl}` (signed URL minted in worker before emit) | edit |
| E.6 | Web: `apps/web/src/hooks/use-chat.ts` SSE switch handles `candidate_ready`, sets the card's video src directly (Q6a from old plan, retained) | edit |
| E.7 | Integration test: simulated ExplorationEngine produces 4 candidates, mock GPU service end-to-end, assert all 4 storage keys in DB + 4 SSE candidate_ready + 4 progress streams | new test |

**Acceptance**: with Modal staging deployment + real DB, manual fan-out produces 4 candidate_ready events within 30s. Each card plays a working MP4.

### Stage F — Cleanup, deprecation, decisions (0.5d)

| # | Task | Location |
|---|---|---|
| F.1 | Delete `apps/agent/src/services/headless-renderer.ts` and its tests | rm |
| F.2 | Delete HeadlessRenderer boot wiring in `index.ts` (no fallback — see Q5) | edit |
| F.3 | Remove RENDERER_BASE_URL env var references | edit |
| F.4 | R2 lifecycle: doc the bucket-side 24h policy on `previews/` prefix in `services/gpu/README.md` + ops runbook | docs |
| F.5 | §3.6 Daytona decision document — superseded by Modal; rationale in `.omc/plans/wiring-audit-remediation.md` | edit |
| F.6 | Mark Phase 3 closed in `.omc/plans/wiring-audit-remediation.md` with "shipped via Modal-native architecture" | edit |
| F.7 | Update top-level README to mention `services/gpu/` and how to set up Modal locally | edit |

**Acceptance**: `grep -ri HeadlessRenderer apps/agent/` returns nothing. Phase 3 audit row reads "closed". Onboarding doc covers Modal setup.

---

## 4. Estimate

- Stage A: 1d
- Stage B: 3d (MLT translator + asset fetcher + image rebuild + e2e tests; was 1.5d before MLT pivot)
- Stage C: 1.5d (was 0.75d; +0.75 for snapshotStorageKey contract change spanning agent + GPU service)
- Stage D: 0.5d
- Stage E: 0.75d
- Stage F: 0.5d

**Total: ~7.25d** (Stage B grew +1.5d for MLT pivot; Stage C grew +0.75d for snapshotStorageKey contract — both buy real architectural simplicity)

---

## 5. Risks

- **R1: Modal cold-start.** First render after idle hits container cold-start (~10–30s for chromium image). Mitigation: `min_containers=1` for `render_preview` (~$5/mo per kept-warm container); $0 for stubbed workloads.
- **R2: MLT XML translator parity (Q1d path).** `SerializedEditorState` has features MLT doesn't natively map (our pluggable `EffectDefinition` system, animation keyframes with arbitrary interpolation curves, custom BlendModes). v1 picks a strict subset (cuts + multi-track composite + static text + static transforms); anything outside silently degrades or is skipped. Mitigation: each non-v1 feature gets an explicit "skipped/degraded" log line so divergence between in-editor preview and rendered preview is observable. Stage E reviews divergence reports before declaring Phase 3 closed.
- **R3: Modal image grows past container disk quota.** Adding melt + libmlt + frei0r + ffmpeg-cuda + (later) torch/whisper risks hitting Modal's image limits. Mitigation: `services/gpu/MODAL_IMAGE.md` tracks the lineage and recorded size at each change; if approaching limits, split per-workload images (render uses one image, generate uses another).
- **R4: Modal Dict TTL race.** If Dict TTLs the job_state while the agent is mid-poll, the worker sees a missing entry and must distinguish "job done long ago" from "job lost". Mitigation: TTL=1h (longer than any render), and worker treats missing-entry as "consult R2 for the storage_key directly before giving up".
- **R5: Auth secret rotation.** Shared API key in env. Rotation requires coordinated deploys. Mitigation: support two valid keys at once during rotation window (Modal-side accepts either); document the rotation procedure.
- **R6: R2 egress.** Modal pulls source assets from R2 (multi-MB clips) and pushes MP4 back. Cost: ~$0.01/GB egress between Modal (AWS) and Cloudflare (R2 has no egress fee). For 16 candidates × 50MB each ≈ $0.008 per fan-out. Acceptable.

---

## 6. Decision points (need your answers before Stage A)

Same defaults-with-explicit-confirmation pattern as the prior plan. Lean noted; call out anything to override.

### Q1. `render_preview` rendering approach inside Modal — CLOSED 2026-04-21

- ~~Q1a: Chromium + Playwright + apps/web SceneExporter (~500MB)~~
- ~~Q1b: Pure ffmpeg `filter_complex` (weeks to write a compositing compiler)~~
- ~~Q1c: Ship Q1a now, defer Q1b~~
- **Q1d (CHOSEN)**: MLT Framework (`libmlt` / `melt`) — server-side multi-track NLE engine used by Shotcut, Kdenlive, and Flowblade. We write a `SerializedEditorState → MLT XML` translator (~200 LOC) and let melt do the rendering with Movit GPU compositing + h264_nvenc encoding. Container ~100MB. v1 feature scope per §0.b. B.0 spike found the timeline shape, lineage tracked in `MODAL_IMAGE.md`.

### Q2. GPU tier for `render_preview`

- **Q2a (Lean)**: T4 — cheapest GPU, plenty for h264_nvenc 1080p encode. ~$0.59/hr on Modal. B200 is overkill for video encoding (saved for future generation workload).
- Q2b: L4 — mid-tier, faster cold-start (~$1.10/hr), better if we ever bump to 4K previews.
- Q2c: CPU-only — works with libx264; renders ~3× slower; no GPU billing. Use if Modal credit runs out.

### Q3. Job state storage on Modal side

- **Q3a (Lean)**: Modal Dict — built-in, free, TTL configurable. Agent's pg-boss row remains canonical.
- Q3b: Direct write to our Postgres from Modal (cross-service write, requires DB credential in Modal).
- Q3c: Redis sidecar in Modal. Adds infra; no clear win over Dict.

### Q4. Agent ↔ Modal job lifecycle

- **Q4a (Lean)**: pg-boss worker enqueues Modal job, then polls until done within the same job handler. Simpler; pg-boss handles retries on worker crash. Worker holds a connection for ≤90s per render.
- Q4b: pg-boss worker fires-and-forgets to Modal. Modal webhooks back when done; agent reconciles in a second handler. More moving parts; better for renders >5min.

### Q5. HeadlessRenderer scaffold disposition

- **Q5a (Lean)**: Delete in Stage F. Clean break, no dual paths.
- Q5b: Keep behind a feature flag as a fallback. Defensive but invites stagnation; the unused path will rot.

### Q6. Stage gating

- **Q6a (Lean)**: Per-stage commits with reviewer pass after each, matching Phase 2 + Phase 4 rhythm.
- Q6b: Single bundled push at the end (5d batch).

### Q7. CI gating for `services/gpu/`

- **Q7a (Lean)**: Skip `services/gpu/` tests in CI when `MODAL_TOKEN_ID` is unset. Local dev runs them via `uv run pytest`. Set up a separate Modal CI token only when we have a billing model for CI minutes.
- Q7b: Always run; require CI to have a Modal token. Shifts cost calculus to "every PR pays for Modal CI minutes".

---

## 7. After your answers

Once Q1–Q7 land, I start Stage A. If any answer changes the architecture diagram, I re-circulate this doc before any code lands.

If a question turns out to require an answer I don't have during execution (e.g. Modal-specific quirk we didn't anticipate), I stop and ask rather than improvise.

---

## 8. Out of scope for Phase 3

- Implementing `generate_video`, `analyze_video`, `transcribe` (stubs only). Those are Phase 5.
- Authoring the bucket-side R2 lifecycle policy via IaC (this plan documents the manual step; IaC is Phase 5+).
- Multi-region Modal deployments. Single region (closest to R2) for now.
- GPU autoscaling tuning — `min_containers=1` on render, `min_containers=0` on stubs is the starting baseline.
