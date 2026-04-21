import pytest

from src.auth import AuthError
from src.handlers import handle_render_preview, handle_status, handle_stub

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
    def test_returns_phase_marker(self):
        assert handle_stub("secret", KEYS, phase="5") == {
            "error": "not implemented",
            "phase": "5",
        }

    def test_rejects_bad_auth(self):
        with pytest.raises(AuthError):
            handle_stub("wrong", KEYS, phase="5")
