"""Lazy 1600px previews with an LRU-capped cache, plus face-crop thumbs."""
import io
import os
import random
import subprocess
import tempfile

from .. import config


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


def ensure_face_crop(face_row, abs_path: str | None) -> str | None:
    """Square-ish crop around a face bbox, cached by face id."""
    dest = config.shard_path(config.FACE_CROPS_DIR, face_row["id"])
    if dest.exists():
        return str(dest)
    src = preview_path(face_row["file_id"])
    src = str(src) if src.exists() else abs_path
    if src is None:
        return None
    from PIL import Image, ImageOps

    try:
        img = Image.open(src)
        img.load()
    except Exception:
        return None
    if os.path.abspath(src) == os.path.abspath(abs_path or ""):
        img = ImageOps.exif_transpose(img)
    W, H = img.size
    x, y, w, h = face_row["x"] * W, face_row["y"] * H, face_row["w"] * W, face_row["h"] * H
    cx, cy, half = x + w / 2, y + h / 2, max(w, h) * 0.75
    box = (max(0, int(cx - half)), max(0, int(cy - half)),
           min(W, int(cx + half)), min(H, int(cy + half)))
    crop = img.crop(box)
    if crop.mode not in ("RGB", "L"):
        crop = crop.convert("RGB")
    crop.thumbnail((256, 256))
    tmp = str(dest) + ".tmp"
    crop.save(tmp, "WEBP", quality=80)
    os.replace(tmp, dest)
    return str(dest)
