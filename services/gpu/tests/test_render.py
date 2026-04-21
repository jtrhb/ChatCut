"""Tests for the render orchestrator.

The melt subprocess is mocked via the `melt_runner` kwarg so tests run
without melt installed locally. We verify orchestration: command shape,
GPU fallback, output handling, error paths, work-dir cleanup.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from src.render import (
    MeltResult,
    RenderError,
    RenderOpts,
    render_timeline,
)
from src.timeline_to_mlt import Profile


class _FakeDownloader:
    """Writes a non-empty placeholder file at every requested dest_path."""

    def __init__(self):
        self.calls: list[dict] = []

    def download_to_path(self, *, key: str, dest_path: str) -> None:
        self.calls.append({"key": key, "dest_path": dest_path})
        Path(dest_path).write_bytes(b"FAKE-CLIP")


def _state() -> dict:
    return {
        "project": {"settings": {"fps": 30, "canvasSize": {"width": 1280, "height": 720}}},
        "scenes": [
            {
                "id": "s1",
                "name": "main",
                "isMain": True,
                "bookmarks": [],
                "tracks": [
                    {
                        "id": "vt1",
                        "type": "video",
                        "isMain": True,
                        "muted": False,
                        "hidden": False,
                        "elements": [
                            {
                                "id": "v1",
                                "name": "v1",
                                "type": "video",
                                "mediaId": "clip-1",
                                "startTime": 0,
                                "duration": 2,
                                "trimStart": 0,
                                "trimEnd": 0,
                                "transform": {
                                    "scale": 1.0,
                                    "position": {"x": 0, "y": 0},
                                    "rotate": 0,
                                },
                                "opacity": 1.0,
                            }
                        ],
                    }
                ],
            }
        ],
        "activeSceneId": "s1",
    }


def _fake_runner_writes_output(*, mp4_bytes: bytes = b"FAKE-MP4-BYTES"):
    """Returns a MeltRunner that writes mp4_bytes to the output path
    extracted from `-consumer avformat:<path>` arg, then returns rc=0."""
    captured: dict = {}

    def runner(cmd: list[str]) -> MeltResult:
        captured["cmd"] = cmd
        # Parse `-consumer avformat:<path>` to find where to write
        idx = cmd.index("-consumer")
        consumer_arg = cmd[idx + 1]
        assert consumer_arg.startswith("avformat:")
        out_path = consumer_arg[len("avformat:") :]
        Path(out_path).write_bytes(mp4_bytes)
        return MeltResult(returncode=0)

    return runner, captured


# ────────────────────────────────────────────────────────────


class TestHappyPath:
    def test_returns_mp4_bytes_from_melt_output(self, tmp_path):
        runner, _captured = _fake_runner_writes_output(mp4_bytes=b"OUT")
        result = render_timeline(
            _state(),
            downloader=_FakeDownloader(),
            melt_runner=runner,
        )
        assert result == b"OUT"

    def test_uses_h264_nvenc_when_use_gpu_true(self):
        runner, captured = _fake_runner_writes_output()
        render_timeline(
            _state(),
            downloader=_FakeDownloader(),
            opts=RenderOpts(use_gpu=True),
            melt_runner=runner,
        )
        assert "vcodec=h264_nvenc" in captured["cmd"]

    def test_uses_libx264_when_use_gpu_false(self):
        runner, captured = _fake_runner_writes_output()
        render_timeline(
            _state(),
            downloader=_FakeDownloader(),
            opts=RenderOpts(use_gpu=False),
            melt_runner=runner,
        )
        assert "vcodec=libx264" in captured["cmd"]

    def test_includes_aac_audio_codec(self):
        runner, captured = _fake_runner_writes_output()
        render_timeline(_state(), downloader=_FakeDownloader(), melt_runner=runner)
        assert "acodec=aac" in captured["cmd"]

    def test_downloads_referenced_assets_with_prefix(self):
        runner, _ = _fake_runner_writes_output()
        downloader = _FakeDownloader()
        render_timeline(
            _state(),
            downloader=downloader,
            opts=RenderOpts(media_key_prefix="assets/v1"),
            melt_runner=runner,
        )
        assert downloader.calls[0]["key"] == "assets/v1/clip-1"


class TestGpuFallback:
    def test_h264_nvenc_failure_falls_back_to_libx264(self, caplog):
        captured: dict = {"runs": []}

        def runner(cmd: list[str]) -> MeltResult:
            captured["runs"].append(list(cmd))
            if "vcodec=h264_nvenc" in cmd:
                return MeltResult(returncode=1, stderr="No NVIDIA GPU found")
            # libx264 attempt — write output and succeed
            idx = cmd.index("-consumer")
            out = cmd[idx + 1][len("avformat:") :]
            Path(out).write_bytes(b"x264-OUT")
            return MeltResult(returncode=0)

        with caplog.at_level(logging.WARNING):
            result = render_timeline(
                _state(),
                downloader=_FakeDownloader(),
                opts=RenderOpts(use_gpu=True),
                melt_runner=runner,
            )
        assert result == b"x264-OUT"
        assert len(captured["runs"]) == 2
        assert "vcodec=h264_nvenc" in captured["runs"][0]
        assert "vcodec=libx264" in captured["runs"][1]
        assert any("h264_nvenc" in r.message for r in caplog.records)

    def test_no_fallback_when_use_gpu_false(self):
        runs: list[list[str]] = []

        def runner(cmd: list[str]) -> MeltResult:
            runs.append(list(cmd))
            return MeltResult(returncode=1, stderr="no fallback expected")

        with pytest.raises(RenderError):
            render_timeline(
                _state(),
                downloader=_FakeDownloader(),
                opts=RenderOpts(use_gpu=False),
                melt_runner=runner,
            )
        assert len(runs) == 1


class TestErrorPaths:
    def test_melt_nonzero_after_fallback_raises_render_error(self):
        def runner(cmd: list[str]) -> MeltResult:
            return MeltResult(returncode=2, stderr="catastrophic failure" * 50)

        with pytest.raises(RenderError, match="rc=2"):
            render_timeline(
                _state(), downloader=_FakeDownloader(), melt_runner=runner
            )

    def test_melt_zero_but_no_output_raises_render_error(self):
        def runner(cmd: list[str]) -> MeltResult:
            # Don't write anything; return success
            return MeltResult(returncode=0)

        with pytest.raises(RenderError, match="no output"):
            render_timeline(
                _state(), downloader=_FakeDownloader(), melt_runner=runner
            )

    def test_melt_zero_but_empty_output_raises_render_error(self):
        def runner(cmd: list[str]) -> MeltResult:
            idx = cmd.index("-consumer")
            out = cmd[idx + 1][len("avformat:") :]
            Path(out).write_bytes(b"")  # empty file
            return MeltResult(returncode=0)

        with pytest.raises(RenderError):
            render_timeline(
                _state(), downloader=_FakeDownloader(), melt_runner=runner
            )

    def test_render_error_message_truncates_long_stderr(self):
        def runner(cmd: list[str]) -> MeltResult:
            return MeltResult(returncode=2, stderr="X" * 5000)

        with pytest.raises(RenderError) as exc_info:
            render_timeline(
                _state(),
                downloader=_FakeDownloader(),
                opts=RenderOpts(use_gpu=False),
                melt_runner=runner,
            )
        assert len(str(exc_info.value)) < 1000


class TestCleanup:
    def test_work_dir_removed_on_success(self, monkeypatch):
        captured: dict = {}
        runner, _ = _fake_runner_writes_output()
        # Patch tempfile.mkdtemp to capture the path
        import tempfile as _tmp

        original_mkdtemp = _tmp.mkdtemp

        def spy_mkdtemp(*args, **kwargs):
            path = original_mkdtemp(*args, **kwargs)
            captured["work"] = path
            return path

        monkeypatch.setattr(_tmp, "mkdtemp", spy_mkdtemp)
        render_timeline(_state(), downloader=_FakeDownloader(), melt_runner=runner)
        assert not Path(captured["work"]).exists()

    def test_work_dir_removed_on_failure(self, monkeypatch):
        captured: dict = {}
        import tempfile as _tmp

        original_mkdtemp = _tmp.mkdtemp

        def spy_mkdtemp(*args, **kwargs):
            path = original_mkdtemp(*args, **kwargs)
            captured["work"] = path
            return path

        monkeypatch.setattr(_tmp, "mkdtemp", spy_mkdtemp)

        def runner(cmd: list[str]) -> MeltResult:
            return MeltResult(returncode=1, stderr="boom")

        with pytest.raises(RenderError):
            render_timeline(
                _state(),
                downloader=_FakeDownloader(),
                opts=RenderOpts(use_gpu=False),
                melt_runner=runner,
            )
        assert not Path(captured["work"]).exists()


class TestProfileOverride:
    def test_passes_profile_to_translator(self):
        runner, captured = _fake_runner_writes_output()
        render_timeline(
            _state(),
            downloader=_FakeDownloader(),
            opts=RenderOpts(profile=Profile(width=1920, height=1080, fps=60)),
            melt_runner=runner,
        )
        # The MLT XML is written to <work>/timeline.mlt before melt runs.
        # We can't read it post-cleanup, but the cmd's first arg points to it.
        # Cmd shape: ['melt', '<path>', '-consumer', ...]
        assert captured["cmd"][0] == "melt"
        assert captured["cmd"][1].endswith(".mlt")
