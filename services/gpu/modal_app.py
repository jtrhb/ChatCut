"""Modal app — 4 GPU workload endpoints + status endpoint.

This module is the Modal-specific glue. All testable logic lives in
src/handlers.py; this file translates handler exceptions to HTTP
responses and wires Modal-native infrastructure (Image, Secret, Dict,
.spawn for background work).

Deploy:    modal deploy modal_app.py
Local:     modal serve modal_app.py

Stage A status: render_preview produces a synthetic 1KB MP4 placeholder
(stage acceptance is wire shape, not playable bytes). Stage B replaces
_do_render with the real render pipeline per Q1 (chromium-in-modal).
"""

from __future__ import annotations

import os
from typing import Any

import modal
from fastapi import HTTPException, Request

from src.auth import AuthError
from src.handlers import handle_render_preview, handle_status, handle_stub
from src.jobs import JobState, mark_done, mark_failed, update_progress

APP_NAME = "chatcut-gpu"

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        "boto3>=1.35",
        "pydantic>=2.9",
        "fastapi[standard]>=0.115",
    )
    .add_local_python_source("src")
)

# Job state shared across endpoints + the spawned _do_render worker.
# TTL handled implicitly by Modal Dict (keys live until evicted under memory pressure
# or explicitly deleted). The agent's pg-boss row remains the canonical record.
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
    if isinstance(exc, LookupError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────
# render_preview — real shape, Stage A placeholder body
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
    _do_render.spawn(
        job_id=result["jobId"],
        exploration_id=payload["explorationId"],
        candidate_id=payload["candidateId"],
        timeline=payload["timeline"],
    )
    return result


@app.function(image=image, gpu="T4", secrets=[r2_secret], timeout=120)
def _do_render(
    job_id: str,
    exploration_id: str,
    candidate_id: str,
    timeline: dict[str, Any],
) -> None:
    """Background render. Stage A: synthetic placeholder bytes. Stage B
    replaces this with the real renderer per Q1 (chromium-in-modal)."""
    from src.r2 import R2Config, R2Uploader

    try:
        s = JobState.model_validate(job_dict[job_id])
        s = update_progress(s, 50)
        job_dict[job_id] = s.model_dump()

        # Stage A placeholder — just enough bytes to exercise the upload path.
        # NOT a playable MP4; Stage B's render_timeline(timeline) replaces this.
        synthetic = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00" + b"\x00" * 1000

        uploader = R2Uploader(R2Config.from_env())
        key = uploader.upload_preview(
            exploration_id=exploration_id,
            candidate_id=candidate_id,
            body=synthetic,
        )
        job_dict[job_id] = mark_done(s, key).model_dump()
    except Exception as e:
        try:
            s = JobState.model_validate(job_dict[job_id])
        except Exception:
            return
        job_dict[job_id] = mark_failed(s, str(e)).model_dump()


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
# Stubs — Phase 5 fills these in. Each declares its eventual GPU tier
# but kept as 501 stubs for now so deploy shape is final.
# ─────────────────────────────────────────────────────────────────────


def _stub(request: Request) -> dict[str, str]:
    try:
        return handle_stub(request.headers.get("x-api-key"), _api_keys(), phase="5")
    except Exception as e:
        raise _to_http(e) from e


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
