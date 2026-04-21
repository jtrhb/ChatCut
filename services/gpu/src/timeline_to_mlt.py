"""SerializedEditorState → MLT XML translator (Phase 3 Stage B.1).

Pure-Python translator. No I/O — takes a parsed timeline dict + a
media_resolver mapping (mediaId → local file path) and returns an MLT XML
string ready to feed `melt`.

v1 feature scope (per plan §0.b + B.0 spike):
- Video tracks: file producers with trim
- Audio tracks: file producers with trim + volume
- Text tracks: pango producers
- Image elements within video tracks: pixbuf producers
- Static transforms (position, scale) + opacity via qtblend filter
- Multi-track compositing via tractor + composite transitions

Out-of-scope for v1 (silently skipped with explicit warning log):
- Sticker tracks, effect tracks
- Animation keyframes (would need a per-frame renderer; deferred)
- BlendMode beyond "normal"
- rotate transform (qtblend doesn't support rotation directly)
- Crossfade transitions (uses hard cut between elements)

The translator is dict-based rather than pydantic-typed so it can
tolerate slightly malformed input from the agent without exploding —
any divergence is logged so Stage E reviews observe parity gaps.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from xml.etree import ElementTree as ET

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Profile:
    """Render output spec. Defaults are preview-grade per plan."""

    width: int = 1280
    height: int = 720
    fps: int = 30


class TranslateError(Exception):
    """Raised when the timeline cannot be translated (no scenes, malformed)."""


def timeline_to_mlt(
    state: dict[str, Any],
    media_resolver: Mapping[str, str],
    *,
    profile: Profile | None = None,
) -> str:
    """Returns an MLT XML string."""
    scene = _pick_scene(state)
    project = state.get("project") or {}
    settings = project.get("settings") or {}
    canvas = settings.get("canvasSize") or {}

    p = profile or Profile(
        width=int(canvas.get("width") or 1280),
        height=int(canvas.get("height") or 720),
        fps=int(settings.get("fps") or 30),
    )

    mlt = ET.Element("mlt", attrib={"LC_NUMERIC": "C", "version": "7.0.0"})
    ET.SubElement(
        mlt,
        "profile",
        attrib={
            "description": f"{p.width}x{p.height} {p.fps}fps",
            "width": str(p.width),
            "height": str(p.height),
            "frame_rate_num": str(p.fps),
            "frame_rate_den": "1",
            "sample_aspect_num": "1",
            "sample_aspect_den": "1",
            "display_aspect_num": str(p.width),
            "display_aspect_den": str(p.height),
            "colorspace": "709",
            "progressive": "1",
        },
    )

    builder = _Builder(p, media_resolver, mlt)
    track_playlists: list[tuple[ET.Element, str]] = []
    for track in scene.get("tracks") or []:
        result = builder.build_track(track)
        if result is not None:
            track_playlists.append(result)

    tractor = ET.SubElement(mlt, "tractor", attrib={"id": "main"})
    multitrack = ET.SubElement(tractor, "multitrack")
    for playlist, _ttype in track_playlists:
        ET.SubElement(multitrack, "track", attrib={"producer": playlist.get("id", "")})

    # Composite each video track above the previous via mlt_service=composite.
    # First video track is the base (a_track=0), subsequent are b_track=N.
    visual_indices = [i for i, (_, t) in enumerate(track_playlists) if t in ("video", "text")]
    base_visual = visual_indices[0] if visual_indices else None
    if base_visual is not None:
        out_frames = max(builder.total_frames - 1, 0)
        for b_idx in visual_indices[1:]:
            transition = ET.SubElement(
                tractor,
                "transition",
                attrib={"id": f"composite_{b_idx}", "in": "0", "out": str(out_frames)},
            )
            _set_property(transition, "a_track", str(base_visual))
            _set_property(transition, "b_track", str(b_idx))
            _set_property(transition, "mlt_service", "qtblend")
            _set_property(transition, "compositing", "0")  # 0 = normal blend mode

    return ET.tostring(mlt, encoding="unicode", xml_declaration=True)


# ─────────────────────────────────────────────────────────────────────


def _pick_scene(state: dict[str, Any]) -> dict[str, Any]:
    scenes = state.get("scenes") or []
    if not scenes:
        raise TranslateError("no scenes in timeline")
    active_id = state.get("activeSceneId")
    if active_id:
        for s in scenes:
            if s.get("id") == active_id:
                return s
    for s in scenes:
        if s.get("isMain"):
            return s
    return scenes[0]


class _Builder:
    def __init__(
        self,
        profile: Profile,
        media_resolver: Mapping[str, str],
        mlt: ET.Element,
    ):
        self.profile = profile
        self.media = media_resolver
        self.mlt = mlt
        self._producer_counter = 0
        self._playlist_counter = 0
        self.total_frames = 0

    def build_track(self, track: dict[str, Any]) -> tuple[ET.Element, str] | None:
        ttype = track.get("type")
        if ttype == "video":
            return self._build_visual_track(track), "video"
        if ttype == "audio":
            return self._build_audio_track(track), "audio"
        if ttype == "text":
            return self._build_text_track(track), "text"
        if ttype in ("sticker", "effect"):
            logger.warning(
                "skipping %s track id=%s (not in v1 scope)",
                ttype,
                track.get("id"),
            )
            return None
        logger.warning("unknown track type %r — skipping id=%s", ttype, track.get("id"))
        return None

    def _build_visual_track(self, track: dict[str, Any]) -> ET.Element:
        playlist = ET.SubElement(self.mlt, "playlist", attrib={"id": self._next_playlist_id()})
        elements = sorted(track.get("elements") or [], key=lambda e: e.get("startTime", 0))
        cursor = 0
        for el in elements:
            start_f = self._sec_to_frames(el.get("startTime", 0))
            duration_f = self._sec_to_frames(el.get("duration", 0))
            trim_start_f = self._sec_to_frames(el.get("trimStart", 0))
            if duration_f <= 0:
                logger.warning("element %s has zero duration — skipping", el.get("id"))
                continue
            if start_f > cursor:
                ET.SubElement(playlist, "blank", attrib={"length": str(start_f - cursor)})
                cursor = start_f
            etype = el.get("type")
            if etype not in ("video", "image"):
                logger.warning("unexpected element type %r in visual track", etype)
                continue
            resource = self._resolve_media(el)
            if not resource:
                continue
            producer = self._make_file_producer(
                resource,
                in_frames=trim_start_f,
                out_frames=trim_start_f + duration_f - 1,
                is_image=(etype == "image"),
            )
            self._apply_visual_filters(producer, el)
            ET.SubElement(
                playlist,
                "entry",
                attrib={
                    "producer": producer.get("id", ""),
                    "in": str(trim_start_f),
                    "out": str(trim_start_f + duration_f - 1),
                },
            )
            cursor += duration_f
        self.total_frames = max(self.total_frames, cursor)
        return playlist

    def _build_audio_track(self, track: dict[str, Any]) -> ET.Element:
        playlist = ET.SubElement(self.mlt, "playlist", attrib={"id": self._next_playlist_id()})
        elements = sorted(track.get("elements") or [], key=lambda e: e.get("startTime", 0))
        cursor = 0
        for el in elements:
            start_f = self._sec_to_frames(el.get("startTime", 0))
            duration_f = self._sec_to_frames(el.get("duration", 0))
            trim_start_f = self._sec_to_frames(el.get("trimStart", 0))
            if duration_f <= 0:
                continue
            if start_f > cursor:
                ET.SubElement(playlist, "blank", attrib={"length": str(start_f - cursor)})
                cursor = start_f
            resource = self._resolve_audio(el)
            if not resource:
                continue
            producer = self._make_file_producer(
                resource,
                in_frames=trim_start_f,
                out_frames=trim_start_f + duration_f - 1,
                is_image=False,
            )
            self._apply_audio_filters(producer, el)
            ET.SubElement(
                playlist,
                "entry",
                attrib={
                    "producer": producer.get("id", ""),
                    "in": str(trim_start_f),
                    "out": str(trim_start_f + duration_f - 1),
                },
            )
            cursor += duration_f
        self.total_frames = max(self.total_frames, cursor)
        return playlist

    def _build_text_track(self, track: dict[str, Any]) -> ET.Element:
        playlist = ET.SubElement(self.mlt, "playlist", attrib={"id": self._next_playlist_id()})
        elements = sorted(track.get("elements") or [], key=lambda e: e.get("startTime", 0))
        cursor = 0
        for el in elements:
            start_f = self._sec_to_frames(el.get("startTime", 0))
            duration_f = self._sec_to_frames(el.get("duration", 0))
            if duration_f <= 0:
                continue
            if start_f > cursor:
                ET.SubElement(playlist, "blank", attrib={"length": str(start_f - cursor)})
                cursor = start_f
            producer = self._make_pango_producer(el, duration_f)
            self._apply_visual_filters(producer, el)
            ET.SubElement(
                playlist,
                "entry",
                attrib={
                    "producer": producer.get("id", ""),
                    "in": "0",
                    "out": str(duration_f - 1),
                },
            )
            cursor += duration_f
        self.total_frames = max(self.total_frames, cursor)
        return playlist

    def _make_file_producer(
        self,
        resource: str,
        *,
        in_frames: int,
        out_frames: int,
        is_image: bool,
    ) -> ET.Element:
        producer = ET.SubElement(
            self.mlt,
            "producer",
            attrib={
                "id": self._next_producer_id(),
                "in": str(max(in_frames, 0)),
                "out": str(max(out_frames, in_frames)),
            },
        )
        if is_image:
            _set_property(producer, "mlt_service", "pixbuf")
        _set_property(producer, "resource", resource)
        return producer

    def _make_pango_producer(self, el: dict[str, Any], duration_f: int) -> ET.Element:
        producer = ET.SubElement(
            self.mlt,
            "producer",
            attrib={
                "id": self._next_producer_id(),
                "in": "0",
                "out": str(max(duration_f - 1, 0)),
            },
        )
        _set_property(producer, "mlt_service", "pango")
        _set_property(producer, "text", str(el.get("content", "")))
        _set_property(producer, "family", str(el.get("fontFamily", "Sans")))
        _set_property(producer, "size", str(int(el.get("fontSize", 48))))
        _set_property(producer, "fgcolour", _color_to_mlt(el.get("color", "#ffffff")))
        bg = el.get("background") or {}
        if bg.get("enabled"):
            _set_property(producer, "bgcolour", _color_to_mlt(bg.get("color", "#000000")))
        if el.get("fontWeight") == "bold":
            _set_property(producer, "weight", "700")
        return producer

    def _apply_visual_filters(self, producer: ET.Element, el: dict[str, Any]) -> None:
        transform = el.get("transform") or {}
        scale = float(transform.get("scale", 1.0))
        pos = transform.get("position") or {}
        rotate = float(transform.get("rotate", 0))
        opacity = float(el.get("opacity", 1.0))

        target_w = int(self.profile.width * scale)
        target_h = int(self.profile.height * scale)
        rect_x = int((self.profile.width - target_w) / 2 + float(pos.get("x", 0)))
        rect_y = int((self.profile.height - target_h) / 2 + float(pos.get("y", 0)))

        is_default = (
            scale == 1.0
            and rect_x == 0
            and rect_y == 0
            and opacity == 1.0
        )
        if not is_default:
            f = ET.SubElement(producer, "filter")
            _set_property(f, "mlt_service", "qtblend")
            _set_property(f, "rect", f"{rect_x} {rect_y} {target_w} {target_h}")
            _set_property(f, "opacity", str(opacity))
            _set_property(f, "compositing", "0")  # normal

        if rotate:
            logger.warning(
                "element %s has rotate=%s — qtblend doesn't support rotation; ignored (Phase 5)",
                el.get("id"),
                rotate,
            )
        if el.get("animations"):
            logger.warning(
                "element %s has animations — using first-keyframe value (Phase 5)",
                el.get("id"),
            )
        if el.get("effects"):
            logger.warning("element %s has effects — skipping (Phase 5)", el.get("id"))
        bm = el.get("blendMode")
        if bm and bm != "normal":
            logger.warning(
                "element %s has blendMode=%r — using normal (Phase 5)",
                el.get("id"),
                bm,
            )

    def _apply_audio_filters(self, producer: ET.Element, el: dict[str, Any]) -> None:
        if el.get("muted"):
            f = ET.SubElement(producer, "filter")
            _set_property(f, "mlt_service", "volume")
            _set_property(f, "gain", "0")
            return
        volume = float(el.get("volume", 1.0))
        if volume != 1.0:
            f = ET.SubElement(producer, "filter")
            _set_property(f, "mlt_service", "volume")
            _set_property(f, "gain", str(volume))

    def _resolve_media(self, el: dict[str, Any]) -> str | None:
        media_id = el.get("mediaId")
        if not media_id:
            logger.warning("element %s has no mediaId — skipping", el.get("id"))
            return None
        resource = self.media.get(media_id)
        if not resource:
            logger.warning(
                "element %s mediaId %s not in resolver — skipping",
                el.get("id"),
                media_id,
            )
            return None
        return resource

    def _resolve_audio(self, el: dict[str, Any]) -> str | None:
        if el.get("sourceType") == "library":
            url = el.get("sourceUrl")
            if not url:
                logger.warning("library audio %s has no sourceUrl — skipping", el.get("id"))
                return None
            # Renderer pre-downloads library URLs; resolver maps URL → local path.
            resolved = self.media.get(url)
            if not resolved:
                logger.warning(
                    "library audio %s sourceUrl %s not pre-downloaded — skipping",
                    el.get("id"),
                    url,
                )
                return None
            return resolved
        return self._resolve_media(el)

    def _sec_to_frames(self, seconds: float) -> int:
        return round(float(seconds) * self.profile.fps)

    def _next_producer_id(self) -> str:
        self._producer_counter += 1
        return f"producer{self._producer_counter}"

    def _next_playlist_id(self) -> str:
        self._playlist_counter += 1
        return f"playlist{self._playlist_counter}"


def _set_property(parent: ET.Element, name: str, value: str) -> None:
    prop = ET.SubElement(parent, "property", attrib={"name": name})
    prop.text = value


def _color_to_mlt(color: str) -> str:
    """Convert CSS hex (#RRGGBB or #RRGGBBAA) to MLT (0xRRGGBBAA, opaque default)."""
    c = color.strip()
    if c.startswith("#") and len(c) == 7:
        return f"0x{c[1:].upper()}FF"
    if c.startswith("#") and len(c) == 9:
        return f"0x{c[1:].upper()}"
    return color
