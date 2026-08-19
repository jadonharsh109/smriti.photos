"""Finding Live Photos: the still and the movie that are one moment.

A Live Photo arrives as two files. Apple ties them together with a UUID it
writes into both — `com.apple.quicktime.content.identifier` in the movie, the
same string inside the still's MakerNote — and that is the only honest way to
pair them. Filenames are not: measured on a real library, `IMG_3570.HEIC` and
`IMG_3570.MOV` share a name while being a photograph and an unrelated
26-second video shot three weeks apart.

The movie half costs nothing — `video_worker` already runs ffprobe and now
keeps that one extra tag. The still half needs the file opened, so this reads
the first 256 KB of each candidate photo and looks for any identifier a movie
claimed. 256 KB rather than 64 KB because the MakerNote sits a little way in:
at 64 KB only 6 of 13 known Live Photos were found, at 256 KB all 13 were, for
2.1 ms per photo.

It stops as soon as every outstanding identifier has found its still, so a
library with no Live Photos costs one query and a library with a handful costs
a handful of reads rather than a full pass.
"""
import asyncio
import json
import os
import re
import subprocess
import sys
import time

from .. import config, db
from ..services import volumes as vol_svc
from .runner import manager

HEAD_BYTES = 256_000
UUID = re.compile(rb"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")

# Only stills can be the photograph half.
STILL_EXTS = (".heic", ".heif", ".jpg", ".jpeg", ".png")


_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _probe_unprobed_videos(job_id: int) -> int:
    """Read the identifier out of videos that were indexed before this existed.

    A scan only re-processes files whose size or mtime changed, so on a library
    that was built before Live Photos were understood no video would ever be
    looked at again and the feature would appear to do nothing. Probing here
    costs one ffprobe per video, once — the same call the scan makes.

    Videos with no identifier are recorded as '' rather than left NULL, so
    "asked, and it is not a Live Photo" is distinguishable from "never asked"
    and nothing gets probed twice.
    """
    rows = db.query(
        "SELECT f.* FROM files f JOIN metadata m ON m.file_id = f.id "
        "WHERE f.status='active' AND f.media_type='video' AND m.content_id IS NULL"
    )
    if not rows:
        return 0
    manager.update(job_id, total=len(rows), done=0, message=f"checking {len(rows):,} videos…")
    found = 0
    last = 0.0
    for i, r in enumerate(rows):
        if manager.is_cancelled(job_id):
            break
        path = vol_svc.abs_path_for_file(r)
        cid = ""
        if path and os.path.exists(path):
            try:
                out = subprocess.run(
                    [config.FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", path],
                    capture_output=True, timeout=30, **_NO_WINDOW,
                )
                tags = (json.loads(out.stdout or b"{}").get("format") or {}).get("tags") or {}
                cid = tags.get("com.apple.quicktime.content.identifier") or ""
            except Exception:
                cid = ""          # unreadable: treat as "asked, not a live photo"
        else:
            continue              # drive offline — leave it NULL and retry later
        db.execute("UPDATE metadata SET content_id=? WHERE file_id=?", (cid, r["id"]))
        if cid:
            found += 1
        now = time.monotonic()
        if now - last >= 0.5:
            last = now
            manager.update(job_id, done=i + 1, message=f"{found} live photo clips found")
    return found


def _pending_identifiers() -> dict[str, int]:
    """content_id -> video file id, for movies whose still we have not found."""
    rows = db.query(
        "SELECT m.content_id, m.file_id FROM metadata m JOIN files f ON f.id = m.file_id "
        "WHERE m.content_id IS NOT NULL AND m.content_id != '' "
        "AND f.media_type = 'video' AND f.status = 'active' "
        "AND m.content_id NOT IN (SELECT content_id FROM file_motion WHERE content_id IS NOT NULL)"
    )
    return {r["content_id"]: r["file_id"] for r in rows}


def _candidates() -> list:
    """Stills we have not already resolved."""
    return db.query(
        "SELECT f.* FROM files f WHERE f.status = 'active' AND f.media_type = 'photo' "
        "AND f.id NOT IN (SELECT file_id FROM file_motion) ORDER BY f.id"
    )


def _scan(job_id: int, pending: dict[str, int], rows: list) -> tuple[int, int]:
    """Read the head of each still until every identifier has its photograph."""
    found = read = 0
    last = 0.0
    for i, r in enumerate(rows):
        if manager.is_cancelled(job_id) or not pending:
            break
        path = vol_svc.abs_path_for_file(r)
        if not path or os.path.splitext(path)[1].lower() not in STILL_EXTS:
            continue
        try:
            with open(path, "rb") as f:
                head = f.read(HEAD_BYTES)
        except OSError:
            continue                      # drive pulled, or no permission
        read += 1
        for u in set(UUID.findall(head)):
            cid = u.decode()
            video_id = pending.pop(cid, None)
            if video_id is None:
                continue
            db.execute(
                "INSERT OR REPLACE INTO file_motion (file_id, video_file_id, content_id, source) "
                "VALUES (?,?,?,'apple')",
                (r["id"], video_id, cid),
            )
            found += 1

        now = time.monotonic()
        if now - last >= 0.5:             # the publish throttle every job uses
            last = now
            manager.update(job_id, total=len(rows), done=i + 1,
                           message=f"{found} live photos paired")
    return found, read


async def run_motion_scan(job_id: int) -> None:
    await asyncio.to_thread(_probe_unprobed_videos, job_id)
    pending = await asyncio.to_thread(_pending_identifiers)
    if not pending:
        manager.finish(job_id, "done", "no live photos waiting to be paired")
        return

    rows = await asyncio.to_thread(_candidates)
    manager.update(job_id, total=len(rows), done=0,
                   message=f"looking for {len(pending):,} live photos…")
    found, read = await asyncio.to_thread(_scan, job_id, pending, rows)

    if manager.is_cancelled(job_id):
        manager.finish(job_id, "cancelled", f"stopped after pairing {found:,}")
        return
    # Identifiers still outstanding usually mean the still was never added to
    # the library — the movie is there, its photograph is not.
    msg = f"{found:,} live photos paired"
    if pending:
        msg += f" · {len(pending):,} clips whose photo isn't in the library"
    manager.finish(job_id, "done", msg)
