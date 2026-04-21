import pytest

from src.r2 import R2Config, R2Uploader, preview_storage_key


class TestPreviewStorageKey:
    def test_canonical_shape(self):
        assert preview_storage_key("exp1", "cand1") == "previews/exp1/cand1.mp4"

    def test_rejects_empty_exploration_id(self):
        with pytest.raises(ValueError, match="empty"):
            preview_storage_key("", "cand1")

    def test_rejects_empty_candidate_id(self):
        with pytest.raises(ValueError, match="empty"):
            preview_storage_key("exp1", "")

    def test_rejects_path_traversal_in_exploration_id(self):
        with pytest.raises(ValueError, match="unsafe"):
            preview_storage_key("../etc", "cand1")

    def test_rejects_path_traversal_in_candidate_id(self):
        with pytest.raises(ValueError, match="unsafe"):
            preview_storage_key("exp1", "../bad")

    def test_rejects_slash_in_id(self):
        with pytest.raises(ValueError, match="unsafe"):
            preview_storage_key("exp/1", "cand1")

    def test_accepts_uuids_and_underscores(self):
        assert preview_storage_key("a_b-1", "C-2_d") == "previews/a_b-1/C-2_d.mp4"


class _FakeS3Client:
    def __init__(self, get_object_body: bytes = b""):
        self.calls: list[dict] = []
        self.downloads: list[dict] = []
        self.get_object_calls: list[dict] = []
        self._get_object_body = get_object_body

    def put_object(self, *, Bucket, Key, Body, ContentType):
        self.calls.append(
            {"Bucket": Bucket, "Key": Key, "Body": Body, "ContentType": ContentType}
        )
        return {"ETag": "fake"}

    def download_file(self, Bucket, Key, Filename):
        self.downloads.append({"Bucket": Bucket, "Key": Key, "Filename": Filename})

    def get_object(self, *, Bucket, Key):
        self.get_object_calls.append({"Bucket": Bucket, "Key": Key})

        class _Body:
            def __init__(self, b: bytes):
                self._b = b

            def read(self) -> bytes:
                return self._b

        return {"Body": _Body(self._get_object_body)}


def _cfg() -> R2Config:
    return R2Config(
        endpoint_url="https://r2.example",
        access_key_id="ak",
        secret_access_key="sk",
        bucket="chatcut",
    )


class TestR2Uploader:
    def test_upload_preview_returns_key_and_calls_put(self):
        client = _FakeS3Client()
        uploader = R2Uploader(_cfg(), client=client)
        key = uploader.upload_preview(
            exploration_id="exp1",
            candidate_id="cand1",
            body=b"\x00\x01\x02",
        )
        assert key == "previews/exp1/cand1.mp4"
        assert len(client.calls) == 1
        call = client.calls[0]
        assert call["Bucket"] == "chatcut"
        assert call["Key"] == "previews/exp1/cand1.mp4"
        assert call["Body"] == b"\x00\x01\x02"
        assert call["ContentType"] == "video/mp4"

    def test_upload_preview_respects_custom_content_type(self):
        client = _FakeS3Client()
        uploader = R2Uploader(_cfg(), client=client)
        uploader.upload_preview(
            exploration_id="e",
            candidate_id="c",
            body=b"x",
            content_type="video/webm",
        )
        assert client.calls[0]["ContentType"] == "video/webm"

    def test_upload_propagates_unsafe_id(self):
        uploader = R2Uploader(_cfg(), client=_FakeS3Client())
        with pytest.raises(ValueError, match="unsafe"):
            uploader.upload_preview(
                exploration_id="../etc",
                candidate_id="c",
                body=b"x",
            )

    def test_download_to_path_calls_s3_download_file(self):
        client = _FakeS3Client()
        uploader = R2Uploader(_cfg(), client=client)
        uploader.download_to_path(key="media/clip1.mp4", dest_path="/tmp/clip1.mp4")
        assert client.downloads == [
            {"Bucket": "chatcut", "Key": "media/clip1.mp4", "Filename": "/tmp/clip1.mp4"}
        ]

    def test_download_bytes_returns_get_object_body(self):
        client = _FakeS3Client(get_object_body=b'{"hello":"world"}')
        uploader = R2Uploader(_cfg(), client=client)
        result = uploader.download_bytes(key="explorations/exp1/snap.json")
        assert result == b'{"hello":"world"}'
        assert client.get_object_calls == [
            {"Bucket": "chatcut", "Key": "explorations/exp1/snap.json"}
        ]


class TestR2ConfigFromEnv:
    def test_reads_all_required_vars(self, monkeypatch):
        monkeypatch.setenv("R2_ENDPOINT_URL", "https://r2.example")
        monkeypatch.setenv("R2_ACCESS_KEY_ID", "ak")
        monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "sk")
        monkeypatch.setenv("R2_BUCKET", "chatcut")
        cfg = R2Config.from_env()
        assert cfg.endpoint_url == "https://r2.example"
        assert cfg.bucket == "chatcut"

    def test_raises_on_missing(self, monkeypatch):
        monkeypatch.delenv("R2_ENDPOINT_URL", raising=False)
        monkeypatch.setenv("R2_ACCESS_KEY_ID", "ak")
        monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "sk")
        monkeypatch.setenv("R2_BUCKET", "chatcut")
        with pytest.raises(RuntimeError, match="R2_ENDPOINT_URL"):
            R2Config.from_env()
