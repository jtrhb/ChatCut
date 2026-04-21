# ChatCut GPU Service

Modal-deployed Python service hosting GPU workloads:

| Endpoint          | Purpose              | Status                  |
|-------------------|----------------------|-------------------------|
| `render_preview`  | Exploration previews | Stage E shipped (real MP4 via MLT) |
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
uv run pytest        # unit tests across auth, jobs, r2, handlers
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

## R2 lifecycle policy (ops runbook)

Two prefixes accumulate during fan-out and need lifecycle expiration:

| Prefix          | Lifetime | Why                                                         |
|-----------------|----------|-------------------------------------------------------------|
| `previews/`     | 24h      | Rendered MP4s. Signed URLs in candidate_ready use 24h TTL.  |
| `explorations/` | 24h      | Per-candidate snapshot JSONs uploaded by ExplorationEngine. |

The 24h preview TTL must match `PREVIEW_SIGNED_URL_TTL_SEC` in
`apps/agent/src/services/previews-config.ts` — a longer R2 expiration is
fine but a shorter one would point at deleted objects.

### Apply via Cloudflare dashboard

1. Cloudflare dashboard → R2 → select your bucket
2. Settings → Object Lifecycle Rules → **Add rule**
3. Rule for `previews/`:
   - Name: `previews-24h`
   - Scope: prefix `previews/`
   - Action: **Delete objects after 1 day**
4. Repeat with name `explorations-24h` and prefix `explorations/`.
5. Save. Cloudflare runs the sweeper roughly daily; do not expect
   second-precise expiration.

### Verify

```bash
# Read the live lifecycle configuration via Wrangler (>=3.60).
# The subcommand is `get`, not `list` — `list` only exists at the
# parent `wrangler r2 bucket` level.
wrangler r2 bucket lifecycle get <bucket>

# Or, inspect with the AWS CLI pointed at R2's S3-compatible endpoint
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
    s3api get-bucket-lifecycle-configuration --bucket <bucket>
```

You should see two `Rules` entries with `Status: Enabled` and `Expiration: { Days: 1 }`.

### Why this is the only cleanup

The agent does **not** run a cleanup job. The Modal `_do_render` worker
uploads via `R2Uploader.upload_preview` and never tracks lifetime; the
ExplorationEngine writes snapshots and never deletes them. R2's bucket-
side policy is the single source of truth — if it's missing, storage
costs grow linearly with fan-out volume.

If lifecycle is misconfigured for any reason, the manual recovery is:

```bash
# 1. DRY RUN — list what would be deleted, no writes.
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
    s3 ls s3://<bucket>/previews/ --recursive

# 2. ACTUAL DELETE — irreversible. R2 has no soft-delete by default;
#    once this returns, the objects are gone. Re-run the dry-run above
#    until the listing matches what you actually want to remove.
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
    s3 rm s3://<bucket>/previews/ --recursive
```

(Replace `<bucket>` and `<account-id>` with your values. The previews/
prefix only ever holds rendered MP4s, so an unscoped `rm --recursive`
is safe inside that prefix — but double-check via the dry-run anyway.)

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
