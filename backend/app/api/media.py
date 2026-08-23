import os
import secrets
import time

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from send2trash import send2trash

from .. import db
from ..services import lock, reveal, thumbs, zipstream
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


# The trailing filename is cosmetic but load-bearing for downloads: the desktop
# webview names the saved file from the URL's last path segment, so
# /api/media/123 would save as an extension-less "123". Ignored server-side.
@router.get("/media/{file_id}/{filename}")
@router.get("/media/{file_id}")
def media(file_id: int, lt: str | None = None, dl: int = 0,
          filename: str | None = None):
    _guard_locked(file_id, lt)
    row = _file_or_404(file_id)
    abs_path = vol_svc.abs_path_for_file(row)
    if abs_path is None or not os.path.exists(abs_path):
        raise HTTPException(404, "original not available (drive offline?)")
    ext = os.path.splitext(abs_path)[1].lower()
    if row["media_type"] == "video":
        # Byte ranges are FileResponse's job, not ours.
        #
        # This used to be a hand-rolled range handler, and it read "bytes=-N"
        # as "up to byte N" instead of "the last N bytes". A suffix range is
        # exactly how a player reaches the moov atom of a QuickTime/MP4 that
        # was not written with faststart — iPhone .MOV, DJI, Snapchat, anything
        # straight off a camera, because a recorder cannot know the file's
        # shape until it stops. They got the file's first N bytes back under a
        # Content-Range claiming to be the tail, found no metadata where the
        # file said it was, and gave up — which the viewer then reported as the
        # original being unreadable, on a file that was sitting right there.
        #
        # Starlette implements the whole of RFC 7233 here, multi-range and
        # If-Range included, and adds ETag/Last-Modified on the way.
        #
        # dl=1: the lightbox's download button. Without an explicit attachment
        # disposition a video just navigates and plays instead of saving.
        return FileResponse(abs_path, media_type=VIDEO_TYPES.get(ext, "application/octet-stream"),
                            filename=row["filename"] if dl else None)
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
            "webp": "image/webp", "heic": "image/heic", "heif": "image/heif",
            "tif": "image/tiff", "tiff": "image/tiff", "bmp": "image/bmp",
            "avif": "image/avif"}.get(ext.lstrip("."), "application/octet-stream")
    return FileResponse(abs_path, media_type=mime, filename=row["filename"])


@router.post("/files/{file_id}/reveal")
def reveal_file(file_id: int, lt: str | None = None):
    """Open the original's folder in Finder/Explorer, with it selected.

    Deliberately a POST: it has a side effect out in the world (a window opens),
    and nothing about it should be repeated by a prefetch or a reload."""
    _guard_locked(file_id, lt)
    row = _file_or_404(file_id)
    abs_path = vol_svc.abs_path_for_file(row)
    if abs_path is None or not os.path.exists(abs_path):
        # Two different problems that both end here, and telling someone to
        # plug in a drive that is already plugged in helps nobody: a null path
        # means the volume is not mounted, a path that simply isn't there means
        # the file was deleted or moved out from under us.
        vol = db.query_one("SELECT label FROM volumes WHERE id=?", (row["volume_id"],))
        where = f"“{vol['label']}”" if vol else "its drive"
        raise HTTPException(404, f"connect {where} to show this file" if abs_path is None
                            else f"{row['filename']} is no longer at that path — "
                                 "it was moved or deleted outside Smriti")
    try:
        reveal.reveal(abs_path)
    except reveal.RevealError as e:
        raise HTTPException(500, f"couldn’t open {reveal.manager_name()}: {e}") from e
    return {"ok": True, "path": abs_path}


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
    filename = f"smriti-export-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    return {"token": token, "filename": filename,
            "count": len(ids), "bytes": total, "skipped_offline": offline}


# The filename is part of the PATH, not just Content-Disposition, because
# WKWebView's download handler only sees the URL — it names the saved file
# after the last path segment. With the token last, every export saved as a
# random extension-less blob that would not open.
@router.get("/files/export/{token}/{filename}")
@router.get("/files/export/{token}")
def download_export(token: str, filename: str = "smriti-export.zip"):
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

    # the path segment is client-supplied; never echo it back unsanitised
    name = zipstream.safe_name(filename)
    if not name.lower().endswith(".zip"):
        name += ".zip"
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
    motion = db.query_one("SELECT video_file_id FROM file_motion WHERE file_id=?", (file_id,))
    vol = db.query_one("SELECT label, last_mount_path, is_online FROM volumes WHERE id=?", (row["volume_id"],))
    return {
        **dict(row),
        "metadata": dict(meta) if meta else None,
        "place": dict(place) if place else None,
        "persons": [dict(p) for p in persons],
        # the movie half of a Live Photo, so the viewer can play the moment
        "motion_file_id": motion["video_file_id"] if motion else None,
        "volume": dict(vol) if vol else None,
    }
