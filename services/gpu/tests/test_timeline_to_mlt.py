"""Tests for the SerializedEditorState → MLT XML translator.

Fixtures cover the v1 feature matrix from plan §0.b:
1. single video clip (smallest valid timeline)
2. multi-clip cut sequence on one track (concatenation)
3. multi-track composite (2 video tracks layered)
4. text overlay over video
5. audio track with volume + mute
6. trim and gap-padding (blank entries)
7. error and skip paths (no scenes, sticker/effect tracks, missing media)
"""

from __future__ import annotations

import logging
from xml.etree import ElementTree as ET

import pytest

from src.timeline_to_mlt import (
    Profile,
    TranslateError,
    timeline_to_mlt,
)


def _state(scene_tracks: list[dict], **overrides) -> dict:
    """Builds a minimal SerializedEditorState wrapping the given tracks."""
    base = {
        "project": {
            "settings": {
                "fps": 30,
                "canvasSize": {"width": 1280, "height": 720},
            },
        },
        "scenes": [
            {
                "id": "scene-1",
                "name": "Main",
                "isMain": True,
                "tracks": scene_tracks,
                "bookmarks": [],
            }
        ],
        "activeSceneId": "scene-1",
    }
    base.update(overrides)
    return base


def _video_clip(
    *,
    id: str = "v1",
    media_id: str = "media-1",
    start: float = 0,
    duration: float = 5,
    trim_start: float = 0,
    transform: dict | None = None,
    opacity: float = 1.0,
) -> dict:
    return {
        "id": id,
        "name": id,
        "type": "video",
        "mediaId": media_id,
        "startTime": start,
        "duration": duration,
        "trimStart": trim_start,
        "trimEnd": 0,
        "transform": transform or {"scale": 1.0, "position": {"x": 0, "y": 0}, "rotate": 0},
        "opacity": opacity,
    }


def _video_track(elements: list[dict], *, id: str = "vt1", is_main: bool = True) -> dict:
    return {
        "id": id,
        "name": id,
        "type": "video",
        "isMain": is_main,
        "muted": False,
        "hidden": False,
        "elements": elements,
    }


def _audio_track(elements: list[dict], *, id: str = "at1") -> dict:
    return {"id": id, "name": id, "type": "audio", "muted": False, "elements": elements}


def _text_track(elements: list[dict], *, id: str = "tt1") -> dict:
    return {"id": id, "name": id, "type": "text", "hidden": False, "elements": elements}


# ────────────────────────────────────────────────────────────


class TestSingleVideoClip:
    def test_minimal_timeline_produces_valid_mlt(self):
        state = _state([_video_track([_video_clip(duration=5)])])
        xml = timeline_to_mlt(state, {"media-1": "/tmp/clip.mp4"})
        root = ET.fromstring(xml)

        assert root.tag == "mlt"
        # Profile present with our resolution + fps
        prof = root.find("profile")
        assert prof is not None
        assert prof.get("width") == "1280"
        assert prof.get("frame_rate_num") == "30"

        # Exactly one producer + one playlist + one tractor with one track
        assert len(root.findall("producer")) == 1
        assert len(root.findall("playlist")) == 1
        tractor = root.find("tractor")
        assert tractor is not None
        assert len(tractor.find("multitrack").findall("track")) == 1

    def test_clip_in_out_in_frames(self):
        state = _state([_video_track([_video_clip(duration=5, trim_start=2)])])
        xml = timeline_to_mlt(state, {"media-1": "/tmp/clip.mp4"})
        root = ET.fromstring(xml)
        producer = root.find("producer")
        # 30fps * 2s trim = 60, +5s duration = 5*30=150 frames, so out = 60+150-1=209
        assert producer.get("in") == "60"
        assert producer.get("out") == "209"
        entry = root.find("playlist/entry")
        assert entry.get("in") == "60"
        assert entry.get("out") == "209"


class TestMultiClipCut:
    def test_two_clips_concatenated_on_one_track(self):
        state = _state(
            [
                _video_track(
                    [
                        _video_clip(id="a", media_id="m1", start=0, duration=3),
                        _video_clip(id="b", media_id="m2", start=3, duration=2),
                    ]
                )
            ]
        )
        xml = timeline_to_mlt(state, {"m1": "/tmp/a.mp4", "m2": "/tmp/b.mp4"})
        root = ET.fromstring(xml)
        # 2 producers, 1 playlist with 2 entries
        assert len(root.findall("producer")) == 2
        playlist = root.find("playlist")
        entries = playlist.findall("entry")
        assert len(entries) == 2

    def test_gap_between_clips_inserts_blank(self):
        state = _state(
            [
                _video_track(
                    [
                        _video_clip(id="a", media_id="m1", start=0, duration=2),
                        _video_clip(id="b", media_id="m2", start=5, duration=2),  # 3s gap
                    ]
                )
            ]
        )
        xml = timeline_to_mlt(state, {"m1": "/tmp/a.mp4", "m2": "/tmp/b.mp4"})
        root = ET.fromstring(xml)
        playlist = root.find("playlist")
        children = list(playlist)
        # entry, blank(90 frames = 3s @ 30fps), entry
        assert children[0].tag == "entry"
        assert children[1].tag == "blank"
        assert children[1].get("length") == "90"
        assert children[2].tag == "entry"


class TestMultiTrackComposite:
    def test_two_video_tracks_create_composite_transition(self):
        state = _state(
            [
                _video_track([_video_clip(media_id="bg", duration=5)], id="vt-bg"),
                _video_track([_video_clip(media_id="fg", duration=5)], id="vt-fg", is_main=False),
            ]
        )
        xml = timeline_to_mlt(state, {"bg": "/tmp/bg.mp4", "fg": "/tmp/fg.mp4"})
        root = ET.fromstring(xml)
        tractor = root.find("tractor")
        # 2 tracks in multitrack, 1 composite transition
        assert len(tractor.find("multitrack").findall("track")) == 2
        transitions = tractor.findall("transition")
        assert len(transitions) == 1
        # composite uses qtblend
        svc = transitions[0].find("./property[@name='mlt_service']")
        assert svc is not None
        assert svc.text == "qtblend"
        a_track = transitions[0].find("./property[@name='a_track']")
        b_track = transitions[0].find("./property[@name='b_track']")
        assert a_track.text == "0"
        assert b_track.text == "1"


class TestTextOverlay:
    def test_text_track_uses_pango_producer(self):
        text_el = {
            "id": "t1",
            "name": "Title",
            "type": "text",
            "content": "Hello, World",
            "fontFamily": "Inter",
            "fontSize": 64,
            "color": "#ff0000",
            "background": {"enabled": False, "color": "#000000"},
            "textAlign": "center",
            "fontWeight": "bold",
            "fontStyle": "normal",
            "textDecoration": "none",
            "startTime": 0,
            "duration": 3,
            "trimStart": 0,
            "trimEnd": 0,
            "transform": {"scale": 1.0, "position": {"x": 0, "y": 0}, "rotate": 0},
            "opacity": 1.0,
        }
        state = _state([_text_track([text_el])])
        xml = timeline_to_mlt(state, {})
        root = ET.fromstring(xml)
        producer = root.find("producer")
        svc = producer.find("./property[@name='mlt_service']")
        assert svc.text == "pango"
        text_prop = producer.find("./property[@name='text']")
        assert text_prop.text == "Hello, World"
        size_prop = producer.find("./property[@name='size']")
        assert size_prop.text == "64"
        color_prop = producer.find("./property[@name='fgcolour']")
        assert color_prop.text == "0xFF0000FF"  # red, opaque
        weight_prop = producer.find("./property[@name='weight']")
        assert weight_prop.text == "700"  # bold

    def test_text_with_background_emits_bgcolour(self):
        text_el = {
            "id": "t1",
            "name": "Title",
            "type": "text",
            "content": "Hi",
            "fontFamily": "Inter",
            "fontSize": 32,
            "color": "#ffffff",
            "background": {"enabled": True, "color": "#0000ff"},
            "textAlign": "center",
            "fontWeight": "normal",
            "fontStyle": "normal",
            "textDecoration": "none",
            "startTime": 0,
            "duration": 2,
            "trimStart": 0,
            "trimEnd": 0,
            "transform": {"scale": 1.0, "position": {"x": 0, "y": 0}, "rotate": 0},
            "opacity": 1.0,
        }
        state = _state([_text_track([text_el])])
        xml = timeline_to_mlt(state, {})
        root = ET.fromstring(xml)
        bg_prop = root.find("producer/property[@name='bgcolour']")
        assert bg_prop is not None
        assert bg_prop.text == "0x0000FFFF"


class TestAudioTrack:
    def _audio_el(self, **kw) -> dict:
        return {
            "id": kw.get("id", "a1"),
            "name": "narration",
            "type": "audio",
            "sourceType": kw.get("sourceType", "upload"),
            "mediaId": kw.get("mediaId", "music"),
            "sourceUrl": kw.get("sourceUrl"),
            "startTime": kw.get("startTime", 0),
            "duration": kw.get("duration", 5),
            "trimStart": 0,
            "trimEnd": 0,
            "volume": kw.get("volume", 1.0),
            "muted": kw.get("muted", False),
        }

    def test_upload_audio_emits_file_producer(self):
        state = _state([_audio_track([self._audio_el(mediaId="music")])])
        xml = timeline_to_mlt(state, {"music": "/tmp/music.mp3"})
        root = ET.fromstring(xml)
        resource = root.find("producer/property[@name='resource']")
        assert resource.text == "/tmp/music.mp3"

    def test_volume_below_one_attaches_volume_filter(self):
        state = _state([_audio_track([self._audio_el(volume=0.5)])])
        xml = timeline_to_mlt(state, {"music": "/tmp/music.mp3"})
        root = ET.fromstring(xml)
        gain = root.find("producer/filter/property[@name='gain']")
        assert gain is not None
        assert gain.text == "0.5"

    def test_muted_audio_sets_gain_zero(self):
        state = _state([_audio_track([self._audio_el(muted=True, volume=0.8)])])
        xml = timeline_to_mlt(state, {"music": "/tmp/music.mp3"})
        root = ET.fromstring(xml)
        gain = root.find("producer/filter/property[@name='gain']")
        assert gain.text == "0"

    def test_library_audio_uses_resolver_for_source_url(self):
        state = _state([_audio_track([self._audio_el(sourceType="library", sourceUrl="https://lib/track.mp3")])])
        xml = timeline_to_mlt(state, {"https://lib/track.mp3": "/tmp/cached.mp3"})
        root = ET.fromstring(xml)
        resource = root.find("producer/property[@name='resource']")
        assert resource.text == "/tmp/cached.mp3"


class TestTransformAndOpacity:
    def test_default_transform_skips_qtblend_filter(self):
        state = _state([_video_track([_video_clip(duration=2)])])
        xml = timeline_to_mlt(state, {"media-1": "/tmp/a.mp4"})
        root = ET.fromstring(xml)
        producer = root.find("producer")
        # No filter when transform + opacity are default
        assert producer.find("filter") is None

    def test_scaled_clip_emits_qtblend_with_centered_rect(self):
        state = _state(
            [
                _video_track(
                    [
                        _video_clip(
                            duration=2,
                            transform={"scale": 0.5, "position": {"x": 0, "y": 0}, "rotate": 0},
                        )
                    ]
                )
            ]
        )
        xml = timeline_to_mlt(state, {"media-1": "/tmp/a.mp4"})
        root = ET.fromstring(xml)
        rect = root.find("producer/filter/property[@name='rect']")
        # 1280x720 * 0.5 = 640x360, centered at ((1280-640)/2, (720-360)/2) = (320, 180)
        assert rect is not None
        assert rect.text == "320 180 640 360"

    def test_partial_opacity_emits_qtblend_filter(self):
        state = _state([_video_track([_video_clip(duration=2, opacity=0.5)])])
        xml = timeline_to_mlt(state, {"media-1": "/tmp/a.mp4"})
        root = ET.fromstring(xml)
        op = root.find("producer/filter/property[@name='opacity']")
        assert op is not None
        assert op.text == "0.5"


class TestSkipsAndWarnings:
    def test_sticker_track_is_skipped(self, caplog):
        state = _state([{"id": "st", "type": "sticker", "elements": []}])
        with caplog.at_level(logging.WARNING):
            xml = timeline_to_mlt(state, {})
        assert any("sticker" in r.message and "skip" in r.message for r in caplog.records)
        # Tractor still exists; no playlists for the sticker track
        root = ET.fromstring(xml)
        assert len(root.findall("playlist")) == 0

    def test_effect_track_is_skipped(self, caplog):
        state = _state([{"id": "ef", "type": "effect", "elements": []}])
        with caplog.at_level(logging.WARNING):
            timeline_to_mlt(state, {})
        assert any("effect" in r.message for r in caplog.records)

    def test_missing_media_resolver_skips_clip(self, caplog):
        state = _state([_video_track([_video_clip(media_id="missing")])])
        with caplog.at_level(logging.WARNING):
            xml = timeline_to_mlt(state, {})  # empty resolver
        root = ET.fromstring(xml)
        assert len(root.findall("producer")) == 0
        assert any("missing" in r.message for r in caplog.records)

    def test_blendmode_other_than_normal_warns(self, caplog):
        clip = _video_clip(duration=2)
        clip["blendMode"] = "multiply"
        state = _state([_video_track([clip])])
        with caplog.at_level(logging.WARNING):
            timeline_to_mlt(state, {"media-1": "/tmp/a.mp4"})
        assert any("blendMode" in r.message for r in caplog.records)

    def test_no_scenes_raises(self):
        state = {"project": {}, "scenes": [], "activeSceneId": None}
        with pytest.raises(TranslateError, match="no scenes"):
            timeline_to_mlt(state, {})

    def test_picks_active_scene_when_specified(self):
        state = {
            "project": {"settings": {"fps": 30, "canvasSize": {"width": 1280, "height": 720}}},
            "scenes": [
                {"id": "s1", "name": "x", "isMain": True, "tracks": [], "bookmarks": []},
                {
                    "id": "s2",
                    "name": "y",
                    "isMain": False,
                    "tracks": [_video_track([_video_clip(duration=1)])],
                    "bookmarks": [],
                },
            ],
            "activeSceneId": "s2",
        }
        xml = timeline_to_mlt(state, {"media-1": "/tmp/x.mp4"})
        root = ET.fromstring(xml)
        # s2 has the clip; if we picked s1 (the main but not active) there'd be no producer
        assert len(root.findall("producer")) == 1


class TestProfileOverride:
    def test_explicit_profile_wins_over_state_canvas(self):
        state = _state([_video_track([_video_clip(duration=1)])])
        xml = timeline_to_mlt(
            state,
            {"media-1": "/tmp/a.mp4"},
            profile=Profile(width=1920, height=1080, fps=60),
        )
        root = ET.fromstring(xml)
        prof = root.find("profile")
        assert prof.get("width") == "1920"
        assert prof.get("frame_rate_num") == "60"
        # Frame counts use the override fps: 1s * 60 = 60 frames
        producer = root.find("producer")
        assert producer.get("out") == "59"
