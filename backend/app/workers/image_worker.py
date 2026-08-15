"""Photo pipeline: one read of the file yields hash + thumb + pHash + EXIF.
Runs in a ProcessPoolExecutor — must never touch the DB."""
import hashlib
import io
import os
from datetime import datetime

from ..services import exif as exif_svc

_MAX_DIM = None
_QUALITY = None


def pool_init(thumb_max_dim: int, thumb_quality: int) -> None:
    global _MAX_DIM, _QUALITY
    _MAX_DIM, _QUALITY = thumb_max_dim, thumb_quality
    from pillow_heif import register_heif_opener

    register_heif_opener()


def process(file_id: int, abs_path: str, thumb_path: str) -> dict:
    try:
        return _process(file_id, abs_path, thumb_path)
    except Exception as e:  # per-file failures must not kill the scan
        return {"file_id": file_id, "ok": False, "error": f"{type(e).__name__}: {e}"}


def _process(file_id: int, abs_path: str, thumb_path: str) -> dict:
    from PIL import Image, ImageOps
    import imagehash

    with open(abs_path, "rb") as f:
        data = f.read()
    content_hash = hashlib.blake2b(data, digest_size=32).hexdigest()

    img = Image.open(io.BytesIO(data))
    width, height = img.size
    meta = exif_svc.parse_exif(img.getexif())
    # Orientation 6/8 rotate 90°: report display dimensions
    if meta.get("orientation") in (5, 6, 7, 8):
        width, height = height, width

    small = _decode_small(img, abs_path)
    small = ImageOps.exif_transpose(small)
    if small.mode not in ("RGB", "L"):
        small = small.convert("RGB")
    small.thumbnail((_MAX_DIM, _MAX_DIM))

    phash = int(str(imagehash.phash(small)), 16)
    if phash >= 1 << 63:  # store as signed 64-bit for SQLite
        phash -= 1 << 64

    tmp = thumb_path + ".tmp"
    small.save(tmp, "WEBP", quality=_QUALITY, method=4)
    os.replace(tmp, thumb_path)

    if "taken_at" not in meta:
        d = exif_svc.date_from_filename(os.path.basename(abs_path))
        src = "filename"
        if d is None:
            d = datetime.fromtimestamp(os.path.getmtime(abs_path))
            src = "mtime"
        meta["taken_at"] = d.strftime("%Y-%m-%d %H:%M:%S")
        meta["taken_at_ts"] = int(d.timestamp())
        meta["taken_at_src"] = src

    return {
        "file_id": file_id,
        "ok": True,
        "content_hash": content_hash,
        "phash": phash,
        "width": width,
        "height": height,
        **meta,
    }


def _decode_small(img, abs_path: str):
    """Cheapest decode that yields >= thumb size: embedded HEIC thumbnail when
    big enough, JPEG draft-mode downscale, else full decode."""
    ext = os.path.splitext(abs_path)[1].lower()
    if ext in (".heic", ".heif"):
        try:
            thumbs = img.info.get("thumbnails") or []
            best = None
            for t in thumbs:
                im = t.to_pillow() if hasattr(t, "to_pillow") else None
                if im is not None and max(im.size) >= _MAX_DIM:
                    if best is None or max(im.size) < max(best.size):
                        best = im
            if best is not None:
                return best
        except Exception:
            pass
    if img.format == "JPEG":
        try:
            img.draft("RGB", (_MAX_DIM * 2, _MAX_DIM * 2))
        except Exception:
            pass
    img.load()
    return img
