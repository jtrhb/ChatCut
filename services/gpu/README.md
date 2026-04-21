# ChatCut GPU Service

Modal-deployed Python service hosting GPU workloads:

| Endpoint          | Purpose              | Status                  |
|-------------------|----------------------|-------------------------|
| `render_preview`  | Exploration previews | Stage A placeholder; Stage B real |
| `generate_video`  | AI generation        | Phase 5 stub (501)      |
| `analyze_video`   | Vision               | Phase 5 stub (501)      |
| `transcribe`      | Audio                | Phase 5 stub (501)      |
| `status`          | Job state poll       | real                    |

Plan: `.omc/plans/phase-3-headless-renderer.md`.

## Setup

```bash
cd services/gpu
uv sync
```

First run downloads Python 3.12 and project deps into `.venv/`.

## Local development

```bash
modal serve modal_app.py
```

Prints temporary HTTPS URLs for each endpoint. Reloads on file change.
Requires a Modal account and `modal token new` once.

## Deploy

```bash
modal deploy modal_app.py
```

## Tests

```bash
uv run pytest        # 29 unit tests across auth, jobs, r2, handlers
uv run ruff check .  # lint
```

`tests/` cover the pure-Python modules. `modal_app.py` is integration-tested
via `modal serve` against a staging deployment — its logic is intentionally
thin (delegates to `src/handlers.py`).

## Required Modal Secrets

Created once via Modal dashboard or CLI (`modal secret create ...`):

- `chatcut-gpu-api-key`
  - `GPU_SERVICE_API_KEY` (required)
  - `GPU_SERVICE_API_KEY_SECONDARY` (optional, used during rotation)
- `chatcut-gpu-r2`
  - `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`

## R2 lifecycle policy

The R2 bucket should have a 24h expiration policy on the `previews/` prefix
(applied via Cloudflare dashboard → bucket → Settings → Object Lifecycle).
This is the only guard against accumulating preview MP4s; the agent does
not run a cleanup job (see Stage F of the plan).

## Architecture (agent ↔ this service)

```
POST /render_preview     → {jobId}     spawns background render, returns immediately
POST /generate_video     → 501         Phase 5
POST /analyze_video      → 501         Phase 5
POST /transcribe         → 501         Phase 5
GET  /status?job_id=...  → JobState    poll for progress + result
```

Auth: `X-API-Key` header on every request.

Job state lives in a Modal `Dict`. The agent's pg-boss row is the
canonical record; Modal Dict is best-effort short-term storage so the
agent can poll without us round-tripping through our DB. If the Dict
entry is missing when the agent polls, the agent treats it as failure
and retries via pg-boss.
