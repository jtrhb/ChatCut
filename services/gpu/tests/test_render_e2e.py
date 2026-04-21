"""End-to-end render pipeline test (Phase 3 Stage B.6).

Exercises the full Stage B path:
    SerializedEditorState
      → asset_fetcher.fetch_assets (downloads source clips)
      → timeline_to_mlt (produces MLT XML)
      → melt subprocess (mocked: captures XML + writes fake MP4)
      → bytes returned to caller

melt is not installed in CI, so the subprocess is mocked. The mock
captures the MLT XML written to disk by render.py and asserts its
structure matches what the translator should produce for the fixture.
This catches integration bugs that unit tests miss — field name typos
between asset_fetcher and translator, missing fields in the state shape,
ordering issues in producer ID counters, etc.

The B.7 manual smoke deploy + ffprobe playback check covers the
melt-actually-works half (those assertions need real MLT installed).
"""

from __future__ import annotations

from pathlib import Path
from xml.etree import ElementTree as ET

from src.render import MeltResult, RenderOpts, render_timeline
from src.timeline_to_mlt import Profile

# Render at the fixture's source canvas (1920x1080) for the structural
# assertions below. Production's modal_app uses RenderOpts default
# (1280x720 preview) — covered separately in test_profile_drives_xml_*
FIXTURE_PROFILE = Profile(width=1920, height=1080, fps=30)


# ────────────────────────────────────────────────────────────
# Realistic fan-out fixture: 2 video tracks (bg + overlay) + 1 audio + 1 text
# ────────────────────────────────────────────────────────────


def _fixture_state() -> dict:
    """Multi-track fan-out candidate roughly mirroring what
    ExplorationEngine produces post-command-application: a base video
    track, an overlay video track at 50% scale + 70% opacity, an audio
    track playing through, and a centered text title for the first 2s."""
    return {
        "project": {
            "settings": {
                "fps": 30,
                "canvasSize": {"width": 1920, "height": 1080},
                "background": {"type": "color", "color": "#000000"},
            },
            "metadata": {"id": "p1", "name": "fan-out-candidate", "duration": 5},
        },
        "scenes": [
            {
                "id": "scene-main",
                "name": "Main",
                "isMain": True,
                "bookmarks": [],
                "tracks": [
                    {
                        "id": "vt-bg",
                        "name": "background",
                        "type": "video",
                        "isMain": True,
                        "muted": False,
                        "hidden": False,
                        "elements": [
                            {
                                "id": "v-bg",
                                "name": "bg-clip",
                                "type": "video",
                                "mediaId": "bg-source",
                                "startTime": 0,
                                "duration": 5,
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
                    },
                    {
                        "id": "vt-overlay",
                        "name": "overlay",
                        "type": "video",
                        "isMain": False,
                        "muted": True,
                        "hidden": False,
                        "elements": [
                            {
                                "id": "v-overlay",
                                "name": "pip",
                                "type": "video",
                                "mediaId": "overlay-source",
                                "startTime": 1,
                                "duration": 3,
                                "trimStart": 0.5,
                                "trimEnd": 0,
                                "transform": {
                                    "scale": 0.5,
                                    "position": {"x": 200, "y": 100},
                                    "rotate": 0,
                                },
                                "opacity": 0.7,
                            }
                        ],
                    },
                    {
                        "id": "at-music",
                        "name": "music",
                        "type": "audio",
                        "muted": False,
                        "elements": [
                            {
                                "id": "a-music",
                                "name": "bg-music",
                                "type": "audio",
                                "sourceType": "upload",
                                "mediaId": "music-source",
                                "startTime": 0,
                                "duration": 5,
                                "trimStart": 0,
                                "trimEnd": 0,
                                "volume": 0.6,
                            }
                        ],
                    },
                    {
                        "id": "tt-title",
                        "name": "title",
                        "type": "text",
                        "hidden": False,
                        "elements": [
                            {
                                "id": "t-title",
                                "name": "title-text",
                                "type": "text",
                                "content": "Fan-out Candidate A",
                                "fontFamily": "Inter",
                                "fontSize": 72,
                                "color": "#ffffff",
                                "background": {"enabled": True, "color": "#000000"},
                                "textAlign": "center",
                                "fontWeight": "bold",
                                "fontStyle": "normal",
                                "textDecoration": "none",
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
                    },
                ],
            }
        ],
        "activeSceneId": "scene-main",
    }


class _CapturingDownloader:
    def __init__(self):
        self.calls: list[dict] = []

    def download_to_path(self, *, key: str, dest_path: str) -> None:
        self.calls.append({"key": key, "dest_path": dest_path})
        Path(dest_path).write_bytes(b"FAKE-MEDIA-" + key.encode())


def _capturing_runner(captured: dict, mp4_bytes: bytes = b"FAKE-MP4-OUT"):
    """Returns a melt_runner that captures the MLT XML written before invocation."""

    def runner(cmd: list[str]) -> MeltResult:
        # cmd[1] is the path to timeline.mlt
        timeline_path = Path(cmd[1])
        captured["xml"] = timeline_path.read_text(encoding="utf-8")
        captured["cmd"] = list(cmd)

        # Write fake MP4 to the avformat output path
        idx = cmd.index("-consumer")
        out_path = Path(cmd[idx + 1][len("avformat:") :])
        out_path.write_bytes(mp4_bytes)
        return MeltResult(returncode=0)

    return runner


# ────────────────────────────────────────────────────────────
# Tests
# ────────────────────────────────────────────────────────────


class TestE2ERenderPipeline:
    def test_returns_mp4_bytes_for_realistic_fixture(self):
        captured: dict = {}
        result = render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured, mp4_bytes=b"REAL-OUT"),
        )
        assert result == b"REAL-OUT"

    def test_xml_contains_4_playlists_one_per_track(self):
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured),
        )
        root = ET.fromstring(captured["xml"])
        # bg video, overlay video, audio, text → 4 playlists
        assert len(root.findall("playlist")) == 4

    def test_xml_has_4_producers_one_per_element(self):
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured),
        )
        root = ET.fromstring(captured["xml"])
        # 1 bg video + 1 overlay video + 1 music + 1 text = 4 producers
        assert len(root.findall("producer")) == 4

    def test_xml_overlay_video_has_qtblend_filter_for_scale_and_opacity(self):
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured),
        )
        root = ET.fromstring(captured["xml"])
        # Overlay producer references the overlay-source resource
        for producer in root.findall("producer"):
            resource = producer.find("./property[@name='resource']")
            if resource is not None and "overlay-source" in resource.text:
                # qtblend filter from scale=0.5, opacity=0.7, pos=(200,100)
                # at 1920x1080 profile: target=960x540, centered + offset
                #   x = (1920-960)/2 + 200 = 680
                #   y = (1080-540)/2 + 100 = 370
                blend_filter = producer.find("./filter")
                assert blend_filter is not None
                rect = blend_filter.find("./property[@name='rect']")
                assert rect is not None
                assert rect.text == "680 370 960 540"
                opacity = blend_filter.find("./property[@name='opacity']")
                assert opacity.text == "0.7"
                return
        raise AssertionError("overlay-source producer not found in MLT XML")

    def test_xml_audio_track_has_volume_filter(self):
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured),
        )
        root = ET.fromstring(captured["xml"])
        for producer in root.findall("producer"):
            resource = producer.find("./property[@name='resource']")
            if resource is not None and "music-source" in resource.text:
                gain = producer.find("./filter/property[@name='gain']")
                assert gain.text == "0.6"
                return
        raise AssertionError("music-source producer not found")

    def test_xml_text_producer_uses_pango_with_correct_props(self):
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured),
        )
        root = ET.fromstring(captured["xml"])
        for producer in root.findall("producer"):
            svc = producer.find("./property[@name='mlt_service']")
            if svc is not None and svc.text == "pango":
                text = producer.find("./property[@name='text']")
                assert text.text == "Fan-out Candidate A"
                size = producer.find("./property[@name='size']")
                assert size.text == "72"
                weight = producer.find("./property[@name='weight']")
                assert weight.text == "700"  # bold
                bg = producer.find("./property[@name='bgcolour']")
                assert bg.text == "0x000000FF"
                return
        raise AssertionError("pango (text) producer not found")

    def test_xml_tractor_composites_visual_tracks(self):
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured),
        )
        root = ET.fromstring(captured["xml"])
        tractor = root.find("tractor")
        # All 4 tracks are bound (incl. audio + text)
        assert len(tractor.find("multitrack").findall("track")) == 4
        # Composite transitions between visual tracks (bg, overlay, text =
        # 3 visual tracks → 2 composite transitions over the base)
        transitions = tractor.findall("transition")
        assert len(transitions) == 2

    def test_downloader_called_for_each_unique_media_id(self):
        downloader = _CapturingDownloader()
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=downloader,
            opts=RenderOpts(use_gpu=False, profile=FIXTURE_PROFILE),
            melt_runner=_capturing_runner(captured),
        )
        keys = sorted(c["key"] for c in downloader.calls)
        # 3 unique media: bg-source, overlay-source, music-source
        assert keys == ["media/bg-source", "media/music-source", "media/overlay-source"]

    def test_profile_drives_xml_resolution_and_fps(self):
        captured: dict = {}
        render_timeline(
            _fixture_state(),
            downloader=_CapturingDownloader(),
            opts=RenderOpts(use_gpu=False, profile=Profile(width=1280, height=720, fps=24)),
            melt_runner=_capturing_runner(captured),
        )
        root = ET.fromstring(captured["xml"])
        prof = root.find("profile")
        assert prof.get("width") == "1280"
        assert prof.get("height") == "720"
        assert prof.get("frame_rate_num") == "24"
        # 5s clip @ 24fps = 120 frames; bg producer should reflect this
        for producer in root.findall("producer"):
            resource = producer.find("./property[@name='resource']")
            if resource is not None and "bg-source" in resource.text:
                # in=0, out=120-1=119
                assert producer.get("in") == "0"
                assert producer.get("out") == "119"
                return
        raise AssertionError("bg-source producer missing")
