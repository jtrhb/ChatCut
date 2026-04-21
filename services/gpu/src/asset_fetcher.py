"""Asset fetcher (Phase 3 Stage B.3.a).

Walks the timeline state, collects every referenced mediaId / library
sourceUrl, downloads each from R2 to a working directory, and returns a
resolver dict that the timeline_to_mlt translator consumes.

The R2 key convention is configurable via media_key_prefix (default
"media"). Stage C will wire the agent-side convention once that's
documented; until then "media/{mediaId}" is the working assumption.

Library audio (sourceUrl-based) is logged as "not yet supported in v1"
and skipped — the agent's ExplorationEngine doesn't currently produce
library audio in fan-out candidates per B.0 spike.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class _Downloader(Protocol):
    def download_to_path(self, *, key: str, dest_path: str) -> None: ...


def collect_media_refs(state: dict[str, Any]) -> tuple[set[str], set[str]]:
    """Walks all scenes' tracks and returns (mediaIds, libraryUrls).

    Note: walks ALL scenes, not just the active one. The translator picks
    the active scene; we err on the side of fetching every referenced
    asset so a scene-switch mid-render never hits a missing-asset failure.
    """
    media_ids: set[str] = set()
    library_urls: set[str] = set()
    for scene in state.get("scenes") or []:
        for track in scene.get("tracks") or []:
            for el in track.get("elements") or []:
                etype = el.get("type")
                if etype in ("video", "image"):
                    mid = el.get("mediaId")
                    if mid:
                        media_ids.add(mid)
                elif etype == "audio":
                    if el.get("sourceType") == "library":
                        url = el.get("sourceUrl")
                        if url:
                            library_urls.add(url)
                    else:
                        mid = el.get("mediaId")
                        if mid:
                            media_ids.add(mid)
    return media_ids, library_urls


def fetch_assets(
    state: dict[str, Any],
    *,
    downloader: _Downloader,
    work_dir: Path,
    media_key_prefix: str = "media",
) -> Mapping[str, str]:
    """Download all media referenced by the timeline.

    Returns a mapping of mediaId → local file path, ready to pass as
    media_resolver to timeline_to_mlt. Failed downloads are logged and
    skipped — the translator will then warn-and-skip the dependent
    elements (graceful degradation per Stage B's "v1 features only;
    out-of-scope skips with explicit log lines" policy).
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    media_ids, library_urls = collect_media_refs(state)

    if library_urls:
        logger.warning(
            "library audio not supported in v1: %d urls skipped",
            len(library_urls),
        )

    resolver: dict[str, str] = {}
    for mid in sorted(media_ids):
        key = f"{media_key_prefix.rstrip('/')}/{mid}"
        local = work_dir / mid
        try:
            downloader.download_to_path(key=key, dest_path=str(local))
        except Exception as e:  # pragma: no cover (defensive)
            logger.warning("asset download failed for mediaId=%s key=%s: %s", mid, key, e)
            continue
        resolver[mid] = str(local)
    return resolver
