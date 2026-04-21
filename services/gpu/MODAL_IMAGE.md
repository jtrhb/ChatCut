# ChatCut GPU Service — Modal Image Lineage

This file tracks the evolution of the Modal container image defined in
`services/gpu/modal_app.py`. **Every change** to the `image = modal.Image...`
block (apt deps, pip deps, base image, GPU drivers, model weights, file
additions) MUST add a dated entry below documenting what changed and why.

This is the single source of intent for image evolution — git log alone
becomes archaeology when debugging "when did X stop working" or "why did
the cold-start time double."

Per-stage reviewer checks that this file is updated whenever the image
definition is touched.

---

## 2026-04-21 — Stage A bootstrap (commits e335a39f → 58cd2ca8)

**Image:**
```python
modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        "boto3>=1.35",
        "pydantic>=2.9",
        "fastapi[standard]>=0.115",
    )
    .add_local_python_source("src")
```

**What:** Initial Stage A image. ffmpeg apt for the Stage A render placeholder
(Stage A uses synthetic bytes — ffmpeg isn't actually invoked yet, but reserved
for Stage B). boto3 for R2 uploads. pydantic for JobState. fastapi for the
`@modal.fastapi_endpoint` route handlers.

**Why:** Bootstrap. Minimal viable image to register all 6 endpoints and
exercise the Stage A wire shape (synthetic placeholder bytes, real R2 upload).

**Approx size:** ~250MB (uncompressed) — debian-slim base + ffmpeg apt layer
+ ~100MB pip deps. Not yet measured against a live Modal deploy.

**GPU:** None wired into image. T4 declared on `_do_render` function but
unused at this stage (placeholder bytes don't need encoding).

---

## 2026-04-21 — Stage B MLT integration (commit pending)

**Image:**
```python
modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "ffmpeg",
        "melt",
        "libmlt-7",
        "libmlt-data",
        "frei0r-plugins",
    )
    .pip_install(
        "boto3>=1.35",
        "pydantic>=2.9",
        "fastapi[standard]>=0.115",
    )
    .add_local_python_source("src")
```

**What changed:** added 4 apt packages for the MLT NLE engine:
- `melt` — CLI used by `render.render_timeline` to render MLT XML → MP4
- `libmlt-7` — runtime library (Debian bookworm package name)
- `libmlt-data` — MLT data files (presets, schemas)
- `frei0r-plugins` — standard MLT plugin set (filters, transitions)

**Why:** Stage B.5 wires the MLT-based render pipeline. `_do_render`
now invokes `render.render_timeline` which writes MLT XML and shells
out to `melt`. Without these packages the subprocess would 127.

**Approx size delta:** ~+100MB estimated (melt + libmlt + frei0r ≈ 50MB,
shared deps ≈ 50MB). Reviewer to confirm against first staging deploy.

**GPU:** Still none. Stock Debian ffmpeg lacks NVENC support (it's not
built with `--enable-nvenc --enable-cuda`). `_do_render` currently sets
`use_gpu=False` in RenderOpts so the h264_nvenc retry is skipped, going
straight to libx264 software encode. Acceptable for v1 preview-grade
rendering (5–10s clips at 720p encode in <8s on CPU).

**Next image change (deferred):** swap base to `nvcr.io/nvidia/cuda` +
custom-built ffmpeg with NVENC, then re-add `gpu="T4"` to the
`@app.function(...)` for `_do_render` and flip `use_gpu=True`. Tracked
as a Stage F backlog item; gives ~10× encode speedup.
