import os
import re
import secrets
import time

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from send2trash import send2trash

from .. import db
from ..services import lock, thumbs, zipstream
from ..services import volumes as vol_svc

router = APIRouter()

IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


def _guard_locked(file_id: int, lt: str | None) -> None:
    """Locked files' bytes require the unlock token (query param `lt` —
    <img>/<video> tags can't send headers)."""
    if lock.is_locked_file(file_id) and not lock.check_token(lt):
        raise HTTPException(401, "locked")

VIDEO_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
               ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
               ".3gp": "video/3gpp", ".wmv": "video/x-ms-wmv", ".mts": "video/mp2t", ".m2ts": "video/mp2t"}


def _file_or_404(file_id: int):
    row = db.query_one("SELECT * FROM files WHERE id=?", (file_id,))
    if not row:
        raise HTTPException(404, "no such file")
    return row


@router.get("/thumb/{file_id}")
def thumb(file_id: int, lt: str | None = None):
    _guard_locked(file_id, lt)
    p = thumbs.thumb_path(file_id)
    if not p.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(p, media_type="image/webp", headers=IMMUTABLE)


@router.get("/preview/{file_id}")
def preview(file_id: int, lt: str | None = None):
    _guard_locked(file_id, lt)
    row = _file_or_404(file_id)
    if row["media_type"] == "video":
        return thumb(file_id, lt)
    p = thumbs.preview_path(file_id)
    if not p.exists():
        abs_path = vol_svc.abs_path_for_file(row)
        if abs_path is None or not os.path.exists(abs_path):
            return thumb(file_id)  # drive offline: degrade to grid thumb
        if thumbs.ensure_preview(file_id, abs_path) is None:
            return thumb(file_id)
    return FileResponse(p, media_type="image/webp", headers=IMMUTABLE)


@router.get("/media/{file_id}")
def media(file_id: int, request: Request, lt: str | None = None, dl: int = 0):
    _guard_locked(file_id, lt)
    row = _file_or_404(file_id)
    abs_path = vol_svc.abs_path_for_file(row)
    if abs_path is None or not os.path.exists(abs_path):
        raise HTTPException(404, "original not available (drive offline?)")
    ext = os.path.splitext(abs_path)[1].lower()
    if row["media_type"] == "video":
        # dl=1: the lightbox's download button. Without an explicit attachment
        # disposition a video just navigates and plays instead of saving.
        return _range_response(abs_path, request, VIDEO_TYPES.get(ext, "application/octet-stream"),
                               filename=row["filename"] if dl else None)
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
            "webp": "image/webp", "heic": "image/heic", "heif": "image/heif",
            "tif": "image/tiff", "tiff": "image/tiff", "bmp": "image/bmp",
            "avif": "image/avif"}.get(ext.lstrip("."), "application/octet-stream")
    return FileResponse(abs_path, media_type=mime, filename=row["filename"])


def _range_response(path: str, request: Request, content_type: str, filename: str | None = None):
    file_size = os.path.getsize(path)
    disposition = {"Content-Disposition": f'attachment; filename="{filename}"'} if filename else {}
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=content_type,
                            headers={"Accept-Ranges": "bytes", **disposition})
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
                 "Accept-Ranges": "bytes", "Content-Length": str(end - start + 1),
                 **disposition},
    )


class DeleteIn(BaseModel):
    file_ids: list[int]


@router.post("/files/delete")
def delete_files(body: DeleteIn):
    """Move originals to the system Trash (recoverable — never a permanent
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


class ExportIn(BaseModel):
    file_ids: list[int]


# Prepared exports, held only long enough for the browser to start the GET.
# Two steps because the download has to be a plain <a download> GET: a fetch()
# would buffer the whole archive in memory, and a selection can be many GB.
_EXPORTS: dict[str, tuple[list[int], float]] = {}
_EXPORT_TTL = 600.0


def _sweep_exports() -> None:
    now = time.monotonic()
    for tok in [t for t, (_, exp) in _EXPORTS.items() if exp < now]:
        _EXPORTS.pop(tok, None)


@router.post("/files/export")
def prepare_export(body: ExportIn, x_locked_token: str | None = Header(default=None)):
    """Validate a selection and hand back a token to download it as a zip."""
    _sweep_exports()
    if not body.file_ids:
        raise HTTPException(400, "nothing selected")

    ids, total, offline = [], 0, 0
    for fid in body.file_ids[:20000]:
        row = db.query_one("SELECT * FROM files WHERE id=?", (fid,))
        if not row:
            continue
        # locked originals stay locked, even in bulk
        if lock.is_locked_file(fid) and not lock.check_token(x_locked_token):
            raise HTTPException(401, "selection contains locked items — unlock first")
        abs_path = vol_svc.abs_path_for_file(row)
        if abs_path is None or not os.path.exists(abs_path):
            offline += 1
            continue
        ids.append(fid)
        total += row["size_bytes"] or 0

    if not ids:
        raise HTTPException(
            404, "none of the selected files are available (drive not connected?)")

    token = secrets.token_urlsafe(16)
    _EXPORTS[token] = (ids, time.monotonic() + _EXPORT_TTL)
    return {"token": token, "count": len(ids), "bytes": total, "skipped_offline": offline}


@router.get("/files/export/{token}")
def download_export(token: str):
    """Stream the prepared selection as a zip. Single use."""
    _sweep_exports()
    entry = _EXPORTS.pop(token, None)
    if entry is None:
        raise HTTPException(404, "export link expired — start the export again")
    ids, _ = entry

    entries: list[tuple[str, str]] = []
    for fid in ids:
        row = db.query_one("SELECT * FROM files WHERE id=?", (fid,))
        if not row:
            continue
        abs_path = vol_svc.abs_path_for_file(row)
        if abs_path and os.path.exists(abs_path):
            entries.append((abs_path, zipstream.safe_name(row["filename"])))
    entries = zipstream.unique_names(entries)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"smriti-export-{stamp}.zip"
    return StreamingResponse(
        zipstream.stream_zip(entries),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            # length is unknown while streaming; keep proxies from buffering
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/files/{file_id}")
def file_detail(file_id: int, lt: str | None = None):
    _guard_locked(file_id, lt)
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
