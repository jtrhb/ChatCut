"""Modal app — 4 GPU workload endpoints + status endpoint.

This module is the Modal-specific glue. All testable logic lives in
src/handlers.py; this file translates handler exceptions to HTTP
responses and wires Modal-native infrastructure (Image, Secret, Dict,
.spawn for background work).

Deploy:    modal deploy modal_app.py
Local:     modal serve modal_app.py

Stage B status (post-MLT pivot, Q1d): render_preview produces a real
playable MP4 via render.render_timeline (translator → asset fetcher →
melt subprocess). Stage A's placeholder bytes survive as the default
when handlers.do_render_body is called with render_fn=None — that path
is exercised only by tests now; production deploys wire the real
render_fn below.
"""

from __future__ import annotations

import os
from typing import Any

import modal
from fastapi import HTTPException, Request

from src.auth import AuthError
from src.handlers import (
    StubNotImplementedError,
    handle_render_preview,
    handle_status,
    handle_stub,
)

APP_NAME = "chatcut-gpu"

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        # Stage B MLT pivot — see services/gpu/MODAL_IMAGE.md for lineage
        "ffmpeg",
        "melt",
        "libmlt-7",
        "libmlt-data",
        "frei0r-plugins",
    )
    .pip_install(
        "boto3>=1.35",
        "pydantic>=2.9",
        "fastapi[standard]>=0.115",
    )
    .add_local_python_source("src")
)

# Job state shared across endpoints + the spawned _do_render worker.
# Modal Dict has no native per-key TTL; entries persist until overwritten
# (the next render with the same job_id) or until Dict.clear() is called.
# The agent's pg-boss row is canonical; Stage D.3's 90s poll cap is the
# recovery mechanism for stuck/missing entries (plan §5/R4).
job_dict = modal.Dict.from_name(f"{APP_NAME}-jobs", create_if_missing=True)

api_secret = modal.Secret.from_name(
    f"{APP_NAME}-api-key",
    required_keys=["GPU_SERVICE_API_KEY"],
)
r2_secret = modal.Secret.from_name(
    f"{APP_NAME}-r2",
    required_keys=[
        "R2_ENDPOINT_URL",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET",
    ],
)


def _api_keys() -> list[str | None]:
    """Primary + optional secondary key for rotation windows."""
    return [
        os.environ.get("GPU_SERVICE_API_KEY"),
        os.environ.get("GPU_SERVICE_API_KEY_SECONDARY"),
    ]


def _to_http(exc: Exception) -> HTTPException:
    if isinstance(exc, AuthError):
        return HTTPException(status_code=401, detail=str(exc))
    if isinstance(exc, StubNotImplementedError):
        return HTTPException(
            status_code=501,
            detail={"error": "not implemented", "phase": exc.phase},
        )
    if isinstance(exc, LookupError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────
# render_preview — real wire shape, Stage A placeholder body
# ─────────────────────────────────────────────────────────────────────


@app.function(image=image, secrets=[api_secret], min_containers=1)
@modal.fastapi_endpoint(method="POST")
def render_preview(payload: dict[str, Any], request: Request) -> dict[str, str]:
    try:
        result = handle_render_preview(
            payload, request.headers.get("x-api-key"), _api_keys(), job_dict
        )
    except Exception as e:
        raise _to_http(e) from e
    # Stage C.2 contract: snapshotStorageKey replaces inline timeline.
    # _do_render fetches the JSON from R2 itself.
    _do_render.spawn(
        job_id=result["jobId"],
        exploration_id=payload["explorationId"],
        candidate_id=payload["candidateId"],
        snapshot_storage_key=payload["snapshotStorageKey"],
    )
    return result


@app.function(image=image, secrets=[r2_secret], timeout=300)
def _do_render(
    job_id: str,
    exploration_id: str,
    candidate_id: str,
    snapshot_storage_key: str,
) -> None:
    """Background render. Body in handlers.do_render_body for testability.

    Stage C.2 contract: snapshot_storage_key replaces the inline timeline
    dict. We fetch the candidate's serialized snapshot from R2 here
    (single-source-of-truth — same R2Uploader is used for the output
    upload), then parse + pass to render_fn.

    GPU is currently not declared (no `gpu=` arg) because the Stage B
    Modal image ships stock Debian ffmpeg, which lacks NVENC support.
    `render_timeline(use_gpu=False)` skips the h264_nvenc attempt
    accordingly. When MODAL_IMAGE.md gets a CUDA-ffmpeg variant,
    re-add `gpu="T4"` here and flip `use_gpu=True`.

    Timeout budget split (reviewer Stage B HIGH #4):
    - Modal envelope: 300s — covers fetch + render + upload + state writes
    - Inner melt subprocess: 120s (RenderOpts default) — encode-only
    Leaves ~3 minutes for asset fetch + R2 upload + Dict writes around
    the encode, so a slow R2 fetch can't kill the container mid-render.
    """
    import json

    from src.handlers import do_render_body
    from src.jobs import JobState, mark_failed
    from src.r2 import R2Config, R2Uploader
    from src.render import RenderOpts
    from src.render import render_timeline as _render_timeline

    r2 = R2Uploader(R2Config.from_env())

    # Reviewer Stage C MED #5: wrap the snapshot fetch + parse so a
    # NoSuchKey, oversize-rejection (ValueError from MED #4 cap),
    # connection drop, or malformed JSON propagates a clean failed
    # state to the agent's poll loop instead of escaping the spawned
    # function and leaving the job stuck on `running` until the agent
    # times out at 90s.
    try:
        snapshot_bytes = r2.download_bytes(key=snapshot_storage_key)
        timeline = json.loads(snapshot_bytes)
    except Exception as fetch_err:
        try:
            s = JobState.model_validate(job_dict[job_id])
            job_dict[job_id] = mark_failed(
                s, f"snapshot fetch failed: {fetch_err}"
            ).model_dump()
        except Exception:
            # Eviction race: nothing we can do. Agent's 90s poll cap recovers.
            pass
        return

    def render_fn(state: dict[str, Any]) -> bytes:
        return _render_timeline(
            state,
            downloader=r2,
            opts=RenderOpts(use_gpu=False),
        )

    do_render_body(
        uploader=r2,
        job_dict=job_dict,
        job_id=job_id,
        exploration_id=exploration_id,
        candidate_id=candidate_id,
        timeline=timeline,
        render_fn=render_fn,
    )


# ─────────────────────────────────────────────────────────────────────
# status — read-only query, no GPU
# ─────────────────────────────────────────────────────────────────────


@app.function(image=image, secrets=[api_secret])
@modal.fastapi_endpoint(method="GET")
def status(job_id: str, request: Request) -> dict[str, Any]:
    try:
        return handle_status(
            job_id, request.headers.get("x-api-key"), _api_keys(), job_dict
        )
    except Exception as e:
        raise _to_http(e) from e


# ─────────────────────────────────────────────────────────────────────
# Stubs — Phase 5 fills these in. handle_stub raises
# StubNotImplementedError → HTTP 501 (per plan §A.4).
# ─────────────────────────────────────────────────────────────────────


def _stub(request: Request) -> dict[str, str]:
    try:
        handle_stub(request.headers.get("x-api-key"), _api_keys(), phase="5")
    except Exception as e:
        raise _to_http(e) from e
    return {}  # unreachable: handle_stub always raises


@app.function(image=image, secrets=[api_secret])
@modal.fastapi_endpoint(method="POST")
def generate_video(payload: dict[str, Any], request: Request) -> dict[str, str]:
    return _stub(request)


@app.function(image=image, secrets=[api_secret])
@modal.fastapi_endpoint(method="POST")
def analyze_video(payload: dict[str, Any], request: Request) -> dict[str, str]:
    return _stub(request)


@app.function(image=image, secrets=[api_secret])
@modal.fastapi_endpoint(method="POST")
def transcribe(payload: dict[str, Any], request: Request) -> dict[str, str]:
    return _stub(request)
