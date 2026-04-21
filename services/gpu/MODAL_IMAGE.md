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

## (next) Stage B — MLT pivot

Pending — will land in Stage B.4 commit. Adds:
- `apt_install("melt", "libmlt++7", "libmlt-data", "frei0r-plugins")` for the
  MLT NLE engine + standard plugin set
- ffmpeg-cuda variant (replacing the plain `ffmpeg` apt) for `h264_nvenc`
  hardware encoding via melt's avformat consumer
- Estimated +100MB; reviewer to confirm actual size delta on first deploy
