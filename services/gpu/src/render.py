"""Render orchestrator (Phase 3 Stage B.3.b).

Glues the three Stage B halves together:
  1. asset_fetcher.fetch_assets — downloads referenced media to /tmp
  2. timeline_to_mlt — builds MLT XML for the melt CLI
  3. melt subprocess — produces an MP4 on disk; we read the bytes back

GPU strategy: tries h264_nvenc first (T4 NVENC on Modal). If that fails
(e.g. `modal serve` local dev with no CUDA, or a malformed timeline that
trips the encoder), falls back to libx264 software encode and retries
once. Both paths use the same MLT XML — the only difference is the
codec arg passed to melt's avformat consumer.

The melt subprocess invocation is injectable (`melt_runner` kwarg) so
unit tests can run end-to-end without the actual melt binary installed.
The default runner shells out via subprocess.run with a 120s timeout.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from src.asset_fetcher import fetch_assets
from src.timeline_to_mlt import Profile, timeline_to_mlt

logger = logging.getLogger(__name__)


class RenderError(Exception):
    """Raised when melt fails to produce a valid MP4."""


class _Downloader(Protocol):
    def download_to_path(self, *, key: str, dest_path: str) -> None: ...


@dataclass(frozen=True)
class MeltResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class RenderOpts:
    profile: Profile = field(default_factory=Profile)
    use_gpu: bool = True
    media_key_prefix: str = "media"
    timeout_sec: int = 120


MeltRunner = Callable[[list[str]], MeltResult]


def render_timeline(
    state: dict[str, Any],
    *,
    downloader: _Downloader,
    opts: RenderOpts | None = None,
    melt_runner: MeltRunner | None = None,
) -> bytes:
    """Renders the timeline to MP4 bytes.

    Cleans its temporary work dir on every exit path, including failures.
    Caller doesn't need to manage tempdirs.
    """
    o = opts or RenderOpts()
    runner = melt_runner or _default_melt_runner(o.timeout_sec)

    work = Path(tempfile.mkdtemp(prefix="chatcut-render-"))
    try:
        media_dir = work / "assets"
        resolver = fetch_assets(
            state,
            downloader=downloader,
            work_dir=media_dir,
            media_key_prefix=o.media_key_prefix,
        )

        xml = timeline_to_mlt(state, resolver, profile=o.profile)
        timeline_path = work / "timeline.mlt"
        output_path = work / "output.mp4"
        timeline_path.write_text(xml, encoding="utf-8")

        codec = "h264_nvenc" if o.use_gpu else "libx264"
        cmd = _build_cmd(timeline_path, output_path, codec)
        result = runner(cmd)

        if result.returncode != 0 and o.use_gpu:
            logger.warning(
                "melt failed with h264_nvenc (rc=%d); retrying with libx264. stderr-tail: %s",
                result.returncode,
                _tail(result.stderr),
            )
            cmd = _build_cmd(timeline_path, output_path, "libx264")
            result = runner(cmd)

        if result.returncode != 0:
            raise RenderError(
                f"melt failed (rc={result.returncode}); stderr-tail: {_tail(result.stderr)}"
            )
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RenderError(
                f"melt exited 0 but produced no output at {output_path}"
            )
        return output_path.read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _build_cmd(timeline_path: Path, output_path: Path, codec: str) -> list[str]:
    return [
        "melt",
        str(timeline_path),
        "-consumer",
        f"avformat:{output_path}",
        f"vcodec={codec}",
        "acodec=aac",
        "ab=128k",
    ]


def _default_melt_runner(timeout_sec: int) -> MeltRunner:
    def run(cmd: list[str]) -> MeltResult:
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
                timeout=timeout_sec,
            )
        except subprocess.TimeoutExpired as e:
            return MeltResult(
                returncode=124,  # standard timeout exit code
                stderr=f"melt timed out after {timeout_sec}s: {e}",
            )
        return MeltResult(
            returncode=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
        )

    return run


def _tail(text: str | None, n: int = 500) -> str:
    if not text:
        return ""
    return text[-n:]


# Re-export for downstream callers
__all__ = ["MeltResult", "MeltRunner", "RenderError", "RenderOpts", "render_timeline"]
