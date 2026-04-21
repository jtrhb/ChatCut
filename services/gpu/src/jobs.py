"""Job state model + Modal Dict helpers.

The agent enqueues jobs via render_preview; Modal returns a job_id; the
agent polls /status/:id. JobState is the wire shape between Modal and
the agent. Modal Dict TTL is set at the @app.dict declaration site.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field

JobStatus = Literal["queued", "running", "done", "failed"]


class JobResult(BaseModel):
    storage_key: str


class JobState(BaseModel):
    job_id: str
    state: JobStatus
    progress: int = Field(default=0, ge=0, le=100)
    result: JobResult | None = None
    error: str | None = None


def new_job_id() -> str:
    return uuid.uuid4().hex


def initial_state(job_id: str) -> JobState:
    return JobState(job_id=job_id, state="queued", progress=0)


def update_progress(state: JobState, progress: int) -> JobState:
    """Monotonic clamped progress; transitions queued→running on first call."""
    clamped = max(state.progress, max(0, min(100, progress)))
    return state.model_copy(update={"state": "running", "progress": clamped})


def mark_done(state: JobState, storage_key: str) -> JobState:
    return state.model_copy(
        update={
            "state": "done",
            "progress": 100,
            "result": JobResult(storage_key=storage_key),
        }
    )


def mark_failed(state: JobState, error: str) -> JobState:
    return state.model_copy(update={"state": "failed", "error": error})
