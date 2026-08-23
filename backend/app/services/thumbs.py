"""Lazy 1600px previews with an LRU-capped cache, plus face-crop thumbs."""
import io
import os
import random
import subprocess
import tempfile

from .. import config

# the server process must decode HEIC too (workers register this themselves)
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:
    pass


def preview_path(file_id: int):
    return config.shard_path(config.PREVIEWS_DIR, file_id)


def thumb_path(file_id: int):
    return config.shard_path(config.THUMBS_DIR, file_id)


def ensure_preview(file_id: int, abs_path: str) -> str | None:
    """Generate (or return cached) 1600px WebP preview for a photo."""
    dest = preview_path(file_id)
    if dest.exists():
        os.utime(dest)  # touch for LRU
        return str(dest)
    img = _decode_full(abs_path)
    if img is None:
        return None
    from PIL import ImageOps

    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((config.PREVIEW_MAX_DIM, config.PREVIEW_MAX_DIM))
    tmp = str(dest) + ".tmp"
    img.save(tmp, "WEBP", quality=config.PREVIEW_WEBP_QUALITY, method=4)
    os.replace(tmp, dest)
    if random.random() < 0.05:
        _evict_lru()
    return str(dest)


def _decode_full(abs_path: str):
    from PIL import Image

    try:
        img = Image.open(abs_path)
        img.load()
        return img
    except Exception:
        pass
    # Fallback: macOS sips handles some HEICs that libheif rejects
    try:
        from PIL import Image

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tf:
            tmp_out = tf.name
        r = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-Z", str(config.PREVIEW_MAX_DIM), abs_path, "--out", tmp_out],
            capture_output=True, timeout=60,
        )
        if r.returncode == 0 and os.path.getsize(tmp_out) > 0:
            with open(tmp_out, "rb") as f:
                data = f.read()
            os.remove(tmp_out)
            return Image.open(io.BytesIO(data))
        os.remove(tmp_out)
    except Exception:
        pass
    return None


def _evict_lru() -> None:
    entries = []
    total = 0
    for shard in config.PREVIEWS_DIR.iterdir():
        if not shard.is_dir():
            continue
        for f in shard.iterdir():
            try:
                st = f.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, f))
            total += st.st_size
    if total <= config.PREVIEW_CACHE_MAX_BYTES:
        return
    entries.sort()  # oldest first
    for _, size, f in entries:
        try:
            f.unlink()
        except OSError:
            continue
        total -= size
        if total <= config.PREVIEW_CACHE_MAX_BYTES * 0.9:
            break


def face_crop_path(face_id: int):
    """Where this version's crop lives. The version is in the name so that
    raising FACE_CROP_DIM regenerates rather than serving the old, smaller
    file — and so the previous one stays put as a fallback for a face whose
    original now sits on an unplugged drive."""
    return config.shard_path(config.FACE_CROPS_DIR, face_id,
                             suffix=f".v{config.FACE_CROP_VER}.webp")


def ensure_face_crop(face_row, abs_path: str | None) -> str | None:
    """Square-ish crop around a face bbox, cached by face id. Prefers the
    original file (sharpest), then the preview; never falls back to the
    whole photo — callers degrade explicitly."""
    dest = face_crop_path(face_row["id"])
    if dest.exists():
        return str(dest)
    # Anything an older version already produced. Worth keeping around: it is
    # the only thing standing between a face on an offline volume and a card
    # with no picture on it at all.
    legacy = config.shard_path(config.FACE_CROPS_DIR, face_row["id"])
    from PIL import Image, ImageOps

    img = None
    if abs_path and os.path.exists(abs_path):
        img = _decode_full(abs_path)  # handles HEIC + sips fallback
        if img is not None:
            img = ImageOps.exif_transpose(img)
    if img is None:
        pv = preview_path(face_row["file_id"])
        if pv.exists():
            try:
                img = Image.open(pv)
                img.load()
            except Exception:
                img = None
    fallback = str(legacy) if legacy.exists() else None
    if img is None:
        return fallback
    W, H = img.size
    try:
        x, y, w, h = (float(face_row["x"]) * W, float(face_row["y"]) * H,
                      float(face_row["w"]) * W, float(face_row["h"]) * H)
    except (TypeError, ValueError):
        return fallback
    cx, cy, half = x + w / 2, y + h / 2, max(w, h) * 0.85
    box = (max(0, int(cx - half)), max(0, int(cy - half)),
           min(W, int(cx + half)), min(H, int(cy + half)))
    if box[2] - box[0] < 8 or box[3] - box[1] < 8:
        return fallback
    crop = img.crop(box)
    if crop.mode not in ("RGB", "L"):
        crop = crop.convert("RGB")
    # LANCZOS, not the default: this is one hard downscale from a full-size
    # photo to a face, which is exactly where a cheaper filter shows.
    crop.thumbnail((config.FACE_CROP_DIM, config.FACE_CROP_DIM), Image.Resampling.LANCZOS)
    tmp = str(dest) + ".tmp"
    crop.save(tmp, "WEBP", quality=config.FACE_CROP_WEBP_QUALITY, method=4)
    os.replace(tmp, dest)
    return str(dest)
