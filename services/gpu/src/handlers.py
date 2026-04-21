"""Pure-Python handler functions invoked by the Modal web endpoints.

Kept Modal-free so endpoint logic is testable without the Modal SDK.
modal_app.py wraps these in @modal.fastapi_endpoint and translates
exceptions to HTTPException responses.
"""

from __future__ import annotations

from collections.abc import MutableMapping
from typing import Any

from src.auth import verify_api_key
from src.jobs import JobState, initial_state, new_job_id


def handle_render_preview(
    payload: dict[str, Any],
    api_key: str | None,
    expected_keys: list[str | None],
    job_dict: MutableMapping[str, dict],
) -> dict[str, str]:
    """Validate + create initial job state. Returns {jobId}.

    The Modal endpoint spawns the actual render after this returns.
    Raises AuthError on bad key, ValueError on bad payload.
    """
    verify_api_key(api_key, expected_keys)
    _require(payload, "explorationId")
    _require(payload, "candidateId")
    _require(payload, "timeline")
    job_id = new_job_id()
    job_dict[job_id] = initial_state(job_id).model_dump()
    return {"jobId": job_id}


def handle_status(
    job_id: str,
    api_key: str | None,
    expected_keys: list[str | None],
    job_dict: MutableMapping[str, dict],
) -> dict[str, Any]:
    verify_api_key(api_key, expected_keys)
    raw = job_dict.get(job_id)
    if raw is None:
        raise LookupError(f"unknown job_id: {job_id}")
    return JobState.model_validate(raw).model_dump()


def handle_stub(
    api_key: str | None,
    expected_keys: list[str | None],
    phase: str,
) -> dict[str, str]:
    """Generic 501-shape body for stub endpoints."""
    verify_api_key(api_key, expected_keys)
    return {"error": "not implemented", "phase": phase}


def _require(payload: dict, field: str) -> None:
    if payload.get(field) is None:
        raise ValueError(f"missing required field: {field}")
