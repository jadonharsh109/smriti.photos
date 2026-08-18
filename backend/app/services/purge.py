"""Taking files out of the library — the rows and everything derived from them.

Two callers need exactly this: removing a watched folder, and forgetting photos
whose originals were deleted outside Smriti. They are one operation with two
reasons, so they share one implementation rather than growing a second copy that
drifts out of step with the first.

**Nothing here touches a file on disk.** Deleting originals is `POST
/files/delete`, which routes through the system Trash. This only ever removes
Smriti's own rows and its own caches.
"""
import time
from pathlib import Path

from .. import config, db
from ..jobs.runner import manager

CHUNK = 500


def artifact(base: Path, ident: int, suffix: str = ".webp") -> Path:
    """`config.shard_path` without its mkdir — creating shard directories on the
    way out would leave empty ones behind for files that never had a thumbnail."""
    return base / f"{ident % 256:02x}" / f"{ident}{suffix}"


def _unlink(p: Path) -> None:
    try:
        p.unlink(missing_ok=True)
    except OSError:
        pass  # a cache file we cannot remove is not worth failing the job over


def purge_files(job_id: int | None, ids: list[int]) -> int:
    """Delete these files' rows and caches in batches. -> how many went.

    Batched because the whole app shares one SQLite connection behind one lock:
    a single transaction over tens of thousands of deletes freezes every other
    request, SSE included.
    """
    total = len(ids)
    last = 0.0
    for i in range(0, total, CHUNK):
        chunk = ids[i : i + CHUNK]
        marks = ",".join("?" * len(chunk))

        # Face crops are keyed by face id, not file id, so they have to be
        # collected before the cascade takes the rows away.
        face_ids = [r["id"] for r in db.query(f"SELECT id FROM faces WHERE file_id IN ({marks})", chunk)]

        db.execute(f"DELETE FROM files WHERE id IN ({marks})", chunk)  # cascades everywhere

        for fid in chunk:
            _unlink(artifact(config.THUMBS_DIR, fid))
            _unlink(artifact(config.PREVIEWS_DIR, fid))
        for face_id in face_ids:
            _unlink(artifact(config.FACE_CROPS_DIR, face_id))

        now = time.monotonic()
        if job_id is not None and now - last >= 0.5:  # the throttle every job uses
            last = now
            manager.update(job_id, total=total, done=min(i + CHUNK, total))
    return total


def drop_orphan_people() -> None:
    """faces.person_id is ON DELETE SET NULL, so a person whose every photo just
    left would otherwise linger in People as an empty entry."""
    db.execute(
        "DELETE FROM persons WHERE id NOT IN (SELECT person_id FROM faces WHERE person_id IS NOT NULL)"
    )
