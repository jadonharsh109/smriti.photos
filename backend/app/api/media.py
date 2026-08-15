import os
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from send2trash import send2trash

from .. import db
from ..services import thumbs
from ..services import volumes as vol_svc

router = APIRouter()

IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}

VIDEO_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
               ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
               ".3gp": "video/3gpp", ".wmv": "video/x-ms-wmv", ".mts": "video/mp2t", ".m2ts": "video/mp2t"}


def _file_or_404(file_id: int):
    row = db.query_one("SELECT * FROM files WHERE id=?", (file_id,))
    if not row:
        raise HTTPException(404, "no such file")
    return row


@router.get("/thumb/{file_id}")
def thumb(file_id: int):
    p = thumbs.thumb_path(file_id)
    if not p.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(p, media_type="image/webp", headers=IMMUTABLE)


@router.get("/preview/{file_id}")
def preview(file_id: int):
    row = _file_or_404(file_id)
    if row["media_type"] == "video":
        return thumb(file_id)
    p = thumbs.preview_path(file_id)
    if not p.exists():
        abs_path = vol_svc.abs_path_for_file(row)
        if abs_path is None or not os.path.exists(abs_path):
            return thumb(file_id)  # drive offline: degrade to grid thumb
        if thumbs.ensure_preview(file_id, abs_path) is None:
            return thumb(file_id)
    return FileResponse(p, media_type="image/webp", headers=IMMUTABLE)


@router.get("/media/{file_id}")
def media(file_id: int, request: Request):
    row = _file_or_404(file_id)
    abs_path = vol_svc.abs_path_for_file(row)
    if abs_path is None or not os.path.exists(abs_path):
        raise HTTPException(404, "original not available (drive offline?)")
    ext = os.path.splitext(abs_path)[1].lower()
    if row["media_type"] == "video":
        return _range_response(abs_path, request, VIDEO_TYPES.get(ext, "application/octet-stream"))
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
            "webp": "image/webp", "heic": "image/heic", "heif": "image/heif",
            "tif": "image/tiff", "tiff": "image/tiff", "bmp": "image/bmp",
            "avif": "image/avif"}.get(ext.lstrip("."), "application/octet-stream")
    return FileResponse(abs_path, media_type=mime, filename=row["filename"])


def _range_response(path: str, request: Request, content_type: str):
    file_size = os.path.getsize(path)
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=content_type,
                            headers={"Accept-Ranges": "bytes"})
    m = re.match(r"bytes=(\d*)-(\d*)", range_header)
    if not m:
        raise HTTPException(416, "bad range")
    start = int(m.group(1)) if m.group(1) else 0
    end = int(m.group(2)) if m.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        raise HTTPException(416, "range out of bounds")

    def iterfile(chunk=1024 * 256):
        remaining = end - start + 1
        with open(path, "rb") as f:
            f.seek(start)
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        iterfile(), status_code=206, media_type=content_type,
        headers={"Content-Range": f"bytes {start}-{end}/{file_size}",
                 "Accept-Ranges": "bytes", "Content-Length": str(end - start + 1)},
    )


class DeleteIn(BaseModel):
    file_ids: list[int]


@router.post("/files/delete")
def delete_files(body: DeleteIn):
    """Move originals to the macOS Trash (recoverable — never a permanent
    unlink) and drop them from the index. Files whose drive is offline are
    skipped untouched so a retry with the drive mounted still works."""
    trashed = 0
    skipped_offline = 0
    errors: list[dict] = []
    for fid in body.file_ids:
        row = db.query_one("SELECT * FROM files WHERE id=?", (fid,))
        if not row:
            continue
        abs_path = vol_svc.abs_path_for_file(row)
        if abs_path is None or not os.path.exists(abs_path):
            skipped_offline += 1
            continue
        try:
            send2trash(abs_path)
        except Exception as e:  # noqa: BLE001 - report per-file, keep going
            errors.append({"id": fid, "error": str(e)})
            continue
        db.execute("DELETE FROM files WHERE id=?", (fid,))  # cascades everywhere
        for p in (thumbs.thumb_path(fid), thumbs.preview_path(fid)):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
        trashed += 1
    return {"trashed": trashed, "skipped_offline": skipped_offline, "errors": errors}


@router.get("/files/{file_id}")
def file_detail(file_id: int):
    row = _file_or_404(file_id)
    meta = db.query_one("SELECT * FROM metadata WHERE file_id=?", (file_id,))
    place = db.query_one("SELECT * FROM file_places WHERE file_id=?", (file_id,))
    persons = db.query(
        "SELECT DISTINCT p.id, p.name FROM faces fa JOIN persons p ON p.id=fa.person_id WHERE fa.file_id=?",
        (file_id,),
    )
    vol = db.query_one("SELECT label, last_mount_path, is_online FROM volumes WHERE id=?", (row["volume_id"],))
    return {
        **dict(row),
        "metadata": dict(meta) if meta else None,
        "place": dict(place) if place else None,
        "persons": [dict(p) for p in persons],
        "volume": dict(vol) if vol else None,
    }
