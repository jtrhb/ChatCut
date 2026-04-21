"""Pure-Python handler functions invoked by the Modal web endpoints.

Kept Modal-free so endpoint logic is testable without the Modal SDK.
modal_app.py wraps these in @modal.fastapi_endpoint and translates
exceptions to HTTPException responses.
"""

from __future__ import annotations

from collections.abc import Callable, MutableMapping
from typing import Any, Protocol

from src.auth import verify_api_key
from src.jobs import (
    JobState,
    initial_state,
    mark_done,
    mark_failed,
    new_job_id,
    update_progress,
)
from src.r2 import preview_storage_key

# Stage A placeholder — an MP4-shaped 'ftyp' box prefix + zero-padding so
# the upload path is exercised end-to-end. NOT a playable MP4. Stage B's
# real renderer is wired via the render_fn callable on do_render_body
# (modal_app's _do_render closes over render.render_timeline). The
# placeholder remains the default for unit tests calling do_render_body
# without render_fn.
PLACEHOLDER_MP4_BYTES = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00" + b"\x00" * 1000


class _UploaderLike(Protocol):
    def upload_preview(
        self,
        *,
        exploration_id: str,
        candidate_id: str,
        body: bytes,
        content_type: str = ...,
    ) -> str: ...


class StubNotImplementedError(Exception):
    """Raised by handle_stub. modal_app translates to HTTP 501."""

    def __init__(self, phase: str):
        super().__init__(f"not implemented; planned for phase {phase}")
        self.phase = phase


def handle_render_preview(
    payload: dict[str, Any],
    api_key: str | None,
    expected_keys: list[str | None],
    job_dict: MutableMapping[str, dict],
) -> dict[str, str]:
    """Validate + create initial job state. Returns {jobId}.

    Validates id segments + snapshotStorageKey at the handler boundary
    (not deferred to R2 upload/fetch) so a malicious caller can't
    allocate Dict slots / spawn budget on bad input. preview_storage_key
    raises ValueError on path-traversal; modal_app translates to HTTP 400.

    Stage C.2 contract: payload carries snapshotStorageKey (R2 object key
    where ExplorationEngine pre-uploaded the candidate's serialized
    timeline). The renderer fetches the JSON from R2; we don't accept
    inline timeline dicts anymore.
    """
    verify_api_key(api_key, expected_keys)
    _require(payload, "explorationId")
    _require(payload, "candidateId")
    _require(payload, "snapshotStorageKey")
    preview_storage_key(payload["explorationId"], payload["candidateId"])
    _validate_snapshot_key(payload["snapshotStorageKey"])
    job_id = new_job_id()
    job_dict[job_id] = initial_state(job_id).model_dump()
    return {"jobId": job_id}


def _validate_snapshot_key(key: str) -> None:
    """Reject empty / null-byte keys.

    R2 keys are flat strings (no filesystem traversal semantics), so we
    don't need to reject `..` for security reasons — but null bytes will
    trip the underlying boto3 client and we want a clean 400 instead.
    Auth covers caller authorization; this is just basic shape checking.
    """
    if not isinstance(key, str) or not key:
        raise ValueError("snapshotStorageKey must be a non-empty string")
    if "\x00" in key:
        raise ValueError("snapshotStorageKey contains null byte")


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
) -> None:
    """Validates auth, then raises StubNotImplementedError → HTTP 501.

    The stub endpoints accept a payload (so Phase 5 implementations can
    read it without changing the wire shape), but Stage A returns 501
    regardless of payload contents.
    """
    verify_api_key(api_key, expected_keys)
    raise StubNotImplementedError(phase)


def do_render_body(
    *,
    uploader: _UploaderLike,
    job_dict: MutableMapping[str, dict],
    job_id: str,
    exploration_id: str,
    candidate_id: str,
    timeline: dict[str, Any],
    render_fn: Callable[[dict[str, Any]], bytes] | None = None,
) -> None:
    """Stage A/B render body. Lives here (not in modal_app) for testability.

    `render_fn(timeline) → bytes` is the actual render. Defaults to a
    closure that returns PLACEHOLDER_MP4_BYTES so Stage A tests and
    legacy callers keep working. modal_app wires render.render_timeline
    (curried with the R2 downloader) for real renders.

    On success: writes done state with the R2 storage key.
    On render failure: best-effort writes failed state. If the failed-
    state Dict.put ALSO fails, the original render error is re-raised so
    Modal logs it visibly. The agent's poll cap (Stage D.3, 90s) is the
    final recovery — by design, not silently swallowed.

    If the Dict entry for job_id is missing entirely (TTL eviction, race),
    the function returns without writing — the agent will treat the
    missing entry as failure and retry via pg-boss.
    """
    actual_render = render_fn or (lambda _: PLACEHOLDER_MP4_BYTES)
    try:
        s = JobState.model_validate(job_dict[job_id])
        # "Started" signal only — progress jumps 1 → 100 at done. Granular
        # 10/30/60/90 milestones are deferred to a later stage (would need
        # a progress_cb threaded through render.render_timeline). Reviewer
        # Stage B HIGH #5: docstring previously claimed milestones existed.
        s = update_progress(s, 1)
        try:
            job_dict[job_id] = s.model_dump()
        except Exception:
            # Intermediate progress is non-critical; render still proceeds.
            pass

        body_bytes = actual_render(timeline)

        key = uploader.upload_preview(
            exploration_id=exploration_id,
            candidate_id=candidate_id,
            body=body_bytes,
        )
        job_dict[job_id] = mark_done(s, key).model_dump()
    except Exception as render_err:
        try:
            s = JobState.model_validate(job_dict[job_id])
        except Exception:
            return
        try:
            job_dict[job_id] = mark_failed(s, str(render_err)).model_dump()
        except Exception:
            raise render_err from None


def _require(payload: dict, field: str) -> None:
    if payload.get(field) is None:
        raise ValueError(f"missing required field: {field}")
