"""Removing a folder from the library.

Deleting the `roots` row was all this used to do, which left every photo the
folder had contributed still in the timeline, still in People and Places, with
nothing watching the folder and no way to get rid of them. On a 10,000-photo
folder that is 10,000 orphans and a few hundred MB of thumbnails that nothing
will ever reclaim.

Removing the photos too is the only honest reading of "remove this folder", so
that is what this does — to the database and the caches. **It never touches a
file on disk.** Deleting the originals is what `POST /files/delete` is for, and
that one goes through the system Trash.

Runs as a job because a big folder means tens of thousands of row deletes and
twice as many unlinks: far too slow to hold an HTTP request open, and far too
slow to hold the single global SQLite lock in one transaction.
"""
import asyncio
import time
from pathlib import Path

from .. import config, db
from .runner import manager

CHUNK = 500


def _artifact(base: Path, ident: int, suffix: str = ".webp") -> Path:
    """`config.shard_path` without its mkdir — creating directories on the way
    out would leave empty shards behind for files that never had a thumbnail."""
    return base / f"{ident % 256:02x}" / f"{ident}{suffix}"


def _unlink(p: Path) -> None:
    try:
        p.unlink(missing_ok=True)
    except OSError:
        pass  # a cache file we cannot remove is not worth failing the job over


def _ids_under(root) -> set[int]:
    """File ids inside a root.

    Matched in Python rather than with `rel_path LIKE ?||'/%'` because a folder
    named "50% off" or "report_final" contains LIKE wildcards, and an unescaped
    pattern would quietly match the wrong files — the one place in this feature
    where being wrong means deleting someone else's photos from their library.
    """
    rel = (root["rel_path"] or "").strip("/")
    rows = db.query("SELECT id, rel_path FROM files WHERE volume_id=?", (root["volume_id"],))
    if not rel:
        return {r["id"] for r in rows}
    prefix = rel + "/"
    return {r["id"] for r in rows if r["rel_path"] == rel or (r["rel_path"] or "").startswith(prefix)}


def _purge(job_id: int, ids: list[int]) -> None:
    """Delete rows and caches in batches, reporting progress as it goes."""
    total = len(ids)
    last = 0.0
    for i in range(0, total, CHUNK):
        chunk = ids[i : i + CHUNK]
        marks = ",".join("?" * len(chunk))

        # face crops are keyed by face id, so they have to be collected before
        # the cascade takes the rows away
        face_ids = [r["id"] for r in db.query(f"SELECT id FROM faces WHERE file_id IN ({marks})", chunk)]

        db.execute(f"DELETE FROM files WHERE id IN ({marks})", chunk)  # cascades everywhere

        for fid in chunk:
            _unlink(_artifact(config.THUMBS_DIR, fid))
            _unlink(_artifact(config.PREVIEWS_DIR, fid))
        for face_id in face_ids:
            _unlink(_artifact(config.FACE_CROPS_DIR, face_id))

        now = time.monotonic()
        if now - last >= 0.5:  # the publish throttle every other job uses
            last = now
            manager.update(job_id, total=total, done=min(i + CHUNK, total))


async def run_remove_root(job_id: int, root_id: int) -> None:
    root = db.query_one("SELECT * FROM roots WHERE id=?", (root_id,))
    if not root:
        manager.finish(job_id, "failed", "that folder is no longer in the library")
        return

    # A file still inside another folder you watch is not yours to delete —
    # nested and overlapping roots are allowed, and the scan treats them as one.
    doomed = _ids_under(root)
    for other in db.query("SELECT * FROM roots WHERE id!=?", (root_id,)):
        doomed -= _ids_under(other)

    ids = sorted(doomed)
    manager.update(job_id, total=len(ids), done=0, message=f"removing {len(ids):,} photos from the library…")

    if ids:
        await asyncio.to_thread(_purge, job_id, ids)

    # faces.person_id is ON DELETE SET NULL, so people whose every photo just
    # went would otherwise linger as empty entries in People.
    db.execute(
        "DELETE FROM persons WHERE id NOT IN (SELECT person_id FROM faces WHERE person_id IS NOT NULL)"
    )
    # albums and events are user-facing groupings; their membership cascaded
    # away, and an emptied album is left alone rather than silently deleted.

    db.execute("DELETE FROM roots WHERE id=?", (root_id,))  # last, so a crash leaves it retryable

    manager.update(job_id, done=len(ids))
    manager.finish(
        job_id,
        "done",
        f"folder removed · {len(ids):,} photos taken out of the library (files on disk untouched)"
        if ids
        else "folder removed",
    )
