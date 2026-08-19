"""Video pipeline: ffprobe metadata + quick-hash + poster frame.
Runs in a ProcessPoolExecutor — must never touch the DB."""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime

from .. import config
from ..services import exif as exif_svc

_QUALITY = 75
_MAX_DIM = 512
_CHUNK = 1024 * 1024

# Windows spawns a console window per child process by default. Indexing a
# library means one ffprobe (and often one ffmpeg) per video, so without this
# a scan machine-guns black terminals across the screen for its whole duration.
_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def pool_init(thumb_max_dim: int, thumb_quality: int) -> None:
    global _MAX_DIM, _QUALITY
    _MAX_DIM, _QUALITY = thumb_max_dim, thumb_quality


def process(file_id: int, abs_path: str, thumb_path: str) -> dict:
    try:
        return _process(file_id, abs_path, thumb_path)
    except Exception as e:
        return {"file_id": file_id, "ok": False, "error": f"{type(e).__name__}: {e}"}


def quick_hash(abs_path: str) -> str:
    size = os.path.getsize(abs_path)
    h = hashlib.blake2b(digest_size=32)
    h.update(str(size).encode())
    with open(abs_path, "rb") as f:
        h.update(f.read(_CHUNK))
        if size > 2 * _CHUNK:
            f.seek(-_CHUNK, os.SEEK_END)
            h.update(f.read(_CHUNK))
    return "q:" + h.hexdigest()


def full_hash(abs_path: str) -> str:
    h = hashlib.blake2b(digest_size=32)
    with open(abs_path, "rb") as f:
        while chunk := f.read(4 * _CHUNK):
            h.update(chunk)
    return h.hexdigest()


def _process(file_id: int, abs_path: str, thumb_path: str) -> dict:
    content_hash = quick_hash(abs_path)
    meta: dict = {}

    probe = subprocess.run(
        [config.FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", abs_path],
        capture_output=True, timeout=60, **_NO_WINDOW,
    )
    info = json.loads(probe.stdout or b"{}")
    fmt = info.get("format", {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}

    width = height = None
    rotation = 0
    for s in info.get("streams", []):
        if s.get("codec_type") == "video":
            width, height = s.get("width"), s.get("height")
            meta["video_codec"] = s.get("codec_name")
            stags = {k.lower(): v for k, v in (s.get("tags") or {}).items()}
            try:
                rotation = int(float(stags.get("rotate", 0)))
            except ValueError:
                rotation = 0
            for sd in s.get("side_data_list", []) or []:
                if "rotation" in sd:
                    try:
                        rotation = int(float(sd["rotation"]))
                    except (TypeError, ValueError):
                        pass
            break
    if width and height and abs(rotation) % 180 == 90:
        width, height = height, width
    meta["width"], meta["height"] = width, height

    try:
        meta["duration_s"] = round(float(fmt.get("duration")), 2)
    except (TypeError, ValueError):
        pass

    loc = tags.get("com.apple.quicktime.location.iso6709") or tags.get("location") or tags.get("location-eng")
    if loc:
        latlon = exif_svc.parse_iso6709(loc)
        if latlon:
            meta["gps_lat"], meta["gps_lon"] = latlon

    # A Live Photo's movie half carries the UUID that ties it to its still.
    # Its presence is also what distinguishes a 3-second Live Photo component
    # from an ordinary video, which matters before any pairing happens.
    cid = tags.get("com.apple.quicktime.content.identifier")
    if cid:
        meta["content_id"] = cid

    ct = tags.get("com.apple.quicktime.creationdate") or tags.get("creation_time")
    d = exif_svc.parse_video_creation_time(ct) if ct else None
    src = "video"
    if d is None:
        d = exif_svc.date_from_filename(os.path.basename(abs_path))
        src = "filename"
    if d is None:
        d = datetime.fromtimestamp(os.path.getmtime(abs_path))
        src = "mtime"
    meta["taken_at"] = d.strftime("%Y-%m-%d %H:%M:%S")
    meta["taken_at_ts"] = int(d.timestamp())
    meta["taken_at_src"] = src

    _poster(abs_path, thumb_path, meta.get("duration_s"))

    return {"file_id": file_id, "ok": True, "content_hash": content_hash, "phash": None,
            **{k: v for k, v in meta.items() if v is not None}}


def _poster(abs_path: str, thumb_path: str, duration: float | None) -> None:
    # ffmpeg builds often lack a webp encoder — extract a JPEG frame, convert with PIL
    tmp = thumb_path + ".tmp.jpg"
    try:
        for ss in ("1", "0"):
            if duration is not None and float(ss) >= duration:
                continue
            r = subprocess.run(
                [config.FFMPEG, "-y", "-v", "quiet", "-ss", ss, "-i", abs_path, "-frames:v", "1",
                 "-vf", f"scale='min({_MAX_DIM},iw)':-2", tmp],
                capture_output=True, timeout=120, **_NO_WINDOW,
            )
            if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 0:
                from PIL import Image

                Image.open(tmp).save(thumb_path, "WEBP", quality=_QUALITY)
                return
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
