import pytest

from src.auth import AuthError
from src.handlers import (
    PLACEHOLDER_MP4_BYTES,
    StubNotImplementedError,
    do_render_body,
    handle_render_preview,
    handle_status,
    handle_stub,
)
from src.jobs import initial_state

KEYS: list[str | None] = ["secret"]


class TestHandleRenderPreview:
    def test_creates_job_and_returns_id(self):
        store: dict = {}
        result = handle_render_preview(
            {"explorationId": "e", "candidateId": "c", "timeline": {"v": 1}},
            "secret",
            KEYS,
            store,
        )
        assert "jobId" in result
        assert result["jobId"] in store
        assert store[result["jobId"]]["state"] == "queued"
        assert store[result["jobId"]]["progress"] == 0

    def test_rejects_bad_auth(self):
        with pytest.raises(AuthError):
            handle_render_preview(
                {"explorationId": "e", "candidateId": "c", "timeline": {}},
                "wrong",
                KEYS,
                {},
            )

    def test_rejects_missing_field(self):
        for missing in ("explorationId", "candidateId", "timeline"):
            payload: dict = {"explorationId": "e", "candidateId": "c", "timeline": {}}
            del payload[missing]
            with pytest.raises(ValueError, match=missing):
                handle_render_preview(payload, "secret", KEYS, {})

    def test_unique_job_ids_across_calls(self):
        store: dict = {}
        ids = set()
        for _ in range(20):
            r = handle_render_preview(
                {"explorationId": "e", "candidateId": "c", "timeline": {}},
                "secret",
                KEYS,
                store,
            )
            ids.add(r["jobId"])
        assert len(ids) == 20

    def test_rejects_path_traversal_in_exploration_id(self):
        with pytest.raises(ValueError, match="unsafe"):
            handle_render_preview(
                {"explorationId": "../etc", "candidateId": "c", "timeline": {}},
                "secret",
                KEYS,
                {},
            )

    def test_rejects_path_traversal_in_candidate_id(self):
        with pytest.raises(ValueError, match="unsafe"):
            handle_render_preview(
                {"explorationId": "e", "candidateId": "../bad", "timeline": {}},
                "secret",
                KEYS,
                {},
            )

    def test_no_dict_entry_created_on_invalid_id(self):
        store: dict = {}
        with pytest.raises(ValueError):
            handle_render_preview(
                {"explorationId": "../etc", "candidateId": "c", "timeline": {}},
                "secret",
                KEYS,
                store,
            )
        assert store == {}


class TestHandleStatus:
    def test_returns_job_state(self):
        store = {
            "j1": {
                "job_id": "j1",
                "state": "running",
                "progress": 50,
                "result": None,
                "error": None,
            }
        }
        result = handle_status("j1", "secret", KEYS, store)
        assert result["state"] == "running"
        assert result["progress"] == 50

    def test_raises_lookup_for_unknown_id(self):
        with pytest.raises(LookupError, match="unknown"):
            handle_status("nope", "secret", KEYS, {})

    def test_rejects_bad_auth(self):
        with pytest.raises(AuthError):
            handle_status("j1", "wrong", KEYS, {})


class TestHandleStub:
    def test_raises_stub_not_implemented_with_phase(self):
        with pytest.raises(StubNotImplementedError) as exc_info:
            handle_stub("secret", KEYS, phase="5")
        assert exc_info.value.phase == "5"

    def test_rejects_bad_auth_before_raising_not_implemented(self):
        with pytest.raises(AuthError):
            handle_stub("wrong", KEYS, phase="5")


class _FakeUploader:
    def __init__(self, raises: Exception | None = None):
        self._raises = raises
        self.calls: list[dict] = []

    def upload_preview(
        self, *, exploration_id, candidate_id, body, content_type="video/mp4"
    ):
        self.calls.append(
            {
                "exploration_id": exploration_id,
                "candidate_id": candidate_id,
                "body": body,
                "content_type": content_type,
            }
        )
        if self._raises:
            raise self._raises
        return f"previews/{exploration_id}/{candidate_id}.mp4"


class TestDoRenderBody:
    def _seed(self, job_id: str = "j1") -> dict:
        store: dict = {}
        store[job_id] = initial_state(job_id).model_dump()
        return store

    def test_happy_path_writes_done_with_storage_key(self):
        store = self._seed()
        uploader = _FakeUploader()
        do_render_body(
            uploader=uploader,
            job_dict=store,
            job_id="j1",
            exploration_id="exp",
            candidate_id="cand",
            timeline={},
        )
        assert store["j1"]["state"] == "done"
        assert store["j1"]["progress"] == 100
        assert store["j1"]["result"]["storage_key"] == "previews/exp/cand.mp4"
        assert len(uploader.calls) == 1

    def test_records_failure_when_uploader_raises(self):
        store = self._seed()
        uploader = _FakeUploader(raises=RuntimeError("R2 unreachable"))
        do_render_body(
            uploader=uploader,
            job_dict=store,
            job_id="j1",
            exploration_id="exp",
            candidate_id="cand",
            timeline={},
        )
        assert store["j1"]["state"] == "failed"
        assert "R2 unreachable" in store["j1"]["error"]

    def test_unknown_job_id_returns_silently(self):
        # Eviction race: agent enqueued, Dict was cleared before render.
        store: dict = {}
        uploader = _FakeUploader()
        do_render_body(
            uploader=uploader,
            job_dict=store,
            job_id="missing",
            exploration_id="exp",
            candidate_id="cand",
            timeline={},
        )
        assert store == {}
        assert uploader.calls == []

    def test_uploads_placeholder_bytes_by_default(self):
        store = self._seed()
        uploader = _FakeUploader()
        do_render_body(
            uploader=uploader,
            job_dict=store,
            job_id="j1",
            exploration_id="exp",
            candidate_id="cand",
            timeline={},
        )
        assert uploader.calls[0]["body"] == PLACEHOLDER_MP4_BYTES

    def test_accepts_custom_body_bytes_for_stage_b(self):
        store = self._seed()
        uploader = _FakeUploader()
        custom = b"REAL MP4 BYTES"
        do_render_body(
            uploader=uploader,
            job_dict=store,
            job_id="j1",
            exploration_id="exp",
            candidate_id="cand",
            timeline={},
            body_bytes=custom,
        )
        assert uploader.calls[0]["body"] == custom


class TestPlaceholderBytes:
    def test_has_ftyp_marker(self):
        # Sanity check: an accidental zero-length placeholder would fail
        # silently otherwise. Reviewer flag MED #7.
        assert PLACEHOLDER_MP4_BYTES[4:8] == b"ftyp"
        assert len(PLACEHOLDER_MP4_BYTES) > 64
