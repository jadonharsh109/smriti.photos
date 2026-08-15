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


def _face_crop_box(face_row, W: int, H: int) -> tuple[int, int, int, int] | None:
    """Balanced square crop for a face, Google Photos style: sized from the
    face with margin around the head, eyes on the upper-third line, centered
    on the face midline via landmarks. Shifts (never truncates) the square at
    frame edges so the crop stays square; falls back to a bbox-centered crop
    for faces without stored landmarks."""
    import numpy as np

    try:
        x, y, w, h = (float(face_row["x"]) * W, float(face_row["y"]) * H,
                      float(face_row["w"]) * W, float(face_row["h"]) * H)
    except (TypeError, ValueError):
        return None
    if w < 4 or h < 4:
        return None

    eye_mid = midline_x = None
    try:
        blob = face_row["landmarks"]
    except (IndexError, KeyError):
        blob = None
    if blob:
        lm = np.frombuffer(blob, dtype=np.float32)
        if lm.size == 10 and np.isfinite(lm).all():
            pts = lm.reshape(5, 2) * np.array([W, H], dtype=np.float32)
            eye_mid = (pts[0] + pts[1]) / 2
            mouth_mid = (pts[3] + pts[4]) / 2
            em = float(np.linalg.norm(mouth_mid - eye_mid))
            if em > 2:
                # eye-mouth distance is ~36% of head height: 4.6x of it leaves
                # comfortable air above the hair and below the chin
                side = max(4.6 * em, 1.55 * max(w, h))
                midline_x = float(eye_mid[0] + mouth_mid[0]) / 2
            else:
                eye_mid = None

    if eye_mid is not None and midline_x is not None:
        side = min(side, W, H)
        left = midline_x - side / 2
        top = float(eye_mid[1]) - 0.40 * side  # eye line at 40% from the top
    else:
        side = min(1.7 * max(w, h), W, H)
        left = x + w / 2 - side / 2
        top = y + h / 2 - side / 2

    left = int(round(max(0.0, min(left, W - side))))
    top = int(round(max(0.0, min(top, H - side))))
    side = int(round(side))
    if side < 8:
        return None
    return (left, top, left + side, top + side)


def ensure_face_crop(face_row, abs_path: str | None) -> str | None:
    """Square landmark-balanced crop around a face, cached by face id. Prefers
    the original file (sharpest), then the preview; never falls back to the
    whole photo — callers degrade explicitly."""
    # v2: landmark-based framing — a new cache name so old bbox crops regenerate
    dest = config.shard_path(config.FACE_CROPS_DIR, face_row["id"], suffix=".v2.webp")
    if dest.exists():
        return str(dest)
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
    if img is None:
        return None
    box = _face_crop_box(face_row, *img.size)
    if box is None:
        return None
    crop = img.crop(box)
    if crop.mode not in ("RGB", "L"):
        crop = crop.convert("RGB")
    crop.thumbnail((512, 512))
    tmp = str(dest) + ".tmp"
    crop.save(tmp, "WEBP", quality=85)
    os.replace(tmp, dest)
    return str(dest)
