from __future__ import annotations

import logging
from pathlib import Path

from src.asset_fetcher import collect_media_refs, fetch_assets


class _FakeDownloader:
    def __init__(self, raise_on_keys: set[str] | None = None):
        self.calls: list[dict] = []
        self._raise_on = raise_on_keys or set()

    def download_to_path(self, *, key: str, dest_path: str) -> None:
        self.calls.append({"key": key, "dest_path": dest_path})
        if key in self._raise_on:
            raise RuntimeError(f"R2 unreachable for {key}")
        Path(dest_path).write_bytes(b"FAKE")


def _state(scenes: list[dict]) -> dict:
    return {
        "project": {"settings": {"fps": 30, "canvasSize": {"width": 1280, "height": 720}}},
        "scenes": scenes,
        "activeSceneId": scenes[0]["id"] if scenes else None,
    }


def _video_el(mid: str) -> dict:
    return {"id": f"v-{mid}", "type": "video", "mediaId": mid, "duration": 1, "startTime": 0}


def _audio_el_upload(mid: str) -> dict:
    return {
        "id": f"a-{mid}",
        "type": "audio",
        "sourceType": "upload",
        "mediaId": mid,
        "duration": 1,
        "startTime": 0,
    }


def _audio_el_library(url: str) -> dict:
    return {
        "id": "lib-audio",
        "type": "audio",
        "sourceType": "library",
        "sourceUrl": url,
        "duration": 1,
        "startTime": 0,
    }


def _scene(track_elements: list[tuple[str, list[dict]]]) -> dict:
    return {
        "id": "s1",
        "name": "main",
        "isMain": True,
        "bookmarks": [],
        "tracks": [
            {"id": f"t{i}", "name": f"t{i}", "type": ttype, "elements": els}
            for i, (ttype, els) in enumerate(track_elements)
        ],
    }


# ────────────────────────────────────────────────────────────


class TestCollectMediaRefs:
    def test_collects_video_media_ids(self):
        state = _state([_scene([("video", [_video_el("a"), _video_el("b")])])])
        media, urls = collect_media_refs(state)
        assert media == {"a", "b"}
        assert urls == set()

    def test_collects_audio_upload_media_ids(self):
        state = _state([_scene([("audio", [_audio_el_upload("song")])])])
        media, urls = collect_media_refs(state)
        assert media == {"song"}
        assert urls == set()

    def test_collects_library_audio_urls_separately(self):
        state = _state(
            [_scene([("audio", [_audio_el_library("https://lib/track.mp3")])])]
        )
        media, urls = collect_media_refs(state)
        assert media == set()
        assert urls == {"https://lib/track.mp3"}

    def test_walks_all_scenes_not_just_active(self):
        state = {
            "project": {"settings": {"fps": 30, "canvasSize": {"width": 1280, "height": 720}}},
            "activeSceneId": "s1",
            "scenes": [
                {"id": "s1", "name": "x", "isMain": True, "tracks": [
                    {"id": "t", "type": "video", "elements": [_video_el("a")]},
                ], "bookmarks": []},
                {"id": "s2", "name": "y", "isMain": False, "tracks": [
                    {"id": "t", "type": "video", "elements": [_video_el("b")]},
                ], "bookmarks": []},
            ],
        }
        media, _ = collect_media_refs(state)
        assert media == {"a", "b"}

    def test_dedupes_repeated_media_ids(self):
        state = _state([_scene([("video", [_video_el("a"), _video_el("a")])])])
        media, _ = collect_media_refs(state)
        assert media == {"a"}

    def test_skips_elements_without_media_id(self):
        state = _state([_scene([("video", [{"id": "v", "type": "video", "duration": 1}])])])
        media, _ = collect_media_refs(state)
        assert media == set()


class TestFetchAssets:
    def test_downloads_each_media_id_to_work_dir(self, tmp_path):
        state = _state([_scene([("video", [_video_el("a"), _video_el("b")])])])
        downloader = _FakeDownloader()
        resolver = fetch_assets(state, downloader=downloader, work_dir=tmp_path / "work")
        assert set(resolver.keys()) == {"a", "b"}
        # Each path lives under work_dir
        for path in resolver.values():
            assert path.startswith(str(tmp_path / "work"))
        assert {c["key"] for c in downloader.calls} == {"media/a", "media/b"}

    def test_uses_custom_media_key_prefix(self, tmp_path):
        state = _state([_scene([("video", [_video_el("a")])])])
        downloader = _FakeDownloader()
        fetch_assets(
            state,
            downloader=downloader,
            work_dir=tmp_path / "work",
            media_key_prefix="assets/v1",
        )
        assert downloader.calls[0]["key"] == "assets/v1/a"

    def test_creates_work_dir_if_missing(self, tmp_path):
        target = tmp_path / "doesnt-exist-yet"
        assert not target.exists()
        fetch_assets(
            _state([_scene([("video", [_video_el("a")])])]),
            downloader=_FakeDownloader(),
            work_dir=target,
        )
        assert target.exists()

    def test_skips_failed_downloads_with_warning(self, tmp_path, caplog):
        state = _state([_scene([("video", [_video_el("a"), _video_el("b")])])])
        downloader = _FakeDownloader(raise_on_keys={"media/a"})
        with caplog.at_level(logging.WARNING):
            resolver = fetch_assets(state, downloader=downloader, work_dir=tmp_path / "work")
        assert "a" not in resolver
        assert "b" in resolver
        assert any("a" in r.message and "failed" in r.message for r in caplog.records)

    def test_library_audio_logs_warning_and_is_skipped(self, tmp_path, caplog):
        state = _state(
            [_scene([("audio", [_audio_el_library("https://lib/x.mp3")])])]
        )
        downloader = _FakeDownloader()
        with caplog.at_level(logging.WARNING):
            resolver = fetch_assets(state, downloader=downloader, work_dir=tmp_path / "work")
        assert resolver == {}
        assert any("library audio" in r.message for r in caplog.records)

    def test_empty_timeline_returns_empty_resolver(self, tmp_path):
        state = _state([_scene([])])
        resolver = fetch_assets(
            state, downloader=_FakeDownloader(), work_dir=tmp_path / "work"
        )
        assert resolver == {}
