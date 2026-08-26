"""Semantic-search indexing: one CLIP embedding per photo and video.

Reads the cached thumbnail rather than the original, which is not a compromise
but the point. A thumbnail is 512px and the model sees 256, so nothing is lost
at the size it looks at — and every file has one from the moment it was first
scanned. Photos on a drive that is currently unplugged get indexed and stay
searchable, which is the case a library spread over external disks lives in.
"""
import asyncio
import time
from concurrent.futures import ProcessPoolExecutor

from .. import config, db
from ..services import thumbs
from ..services import volumes as vol_svc
from ..workers import clip_worker
from .runner import manager

IN_FLIGHT = 8


def pending_count() -> int:
    return db.query_one(
        "SELECT COUNT(*) n FROM files f WHERE f.status='active' AND f.id NOT IN "
        "(SELECT file_id FROM file_clip WHERE model=?)", (config.CLIP_MODEL,))["n"]


def _source(row) -> str | None:
    """The cheapest image that still shows what the photo is of."""
    for p in (thumbs.thumb_path(row["id"]), thumbs.preview_path(row["id"])):
        if p.exists():
            return str(p)
    import os

    abs_path = vol_svc.abs_path_for_file(row)
    return abs_path if abs_path and os.path.exists(abs_path) else None


async def run_clip_scan(job_id: int) -> None:
    rows = db.query(
        "SELECT f.* FROM files f WHERE f.status='active' AND f.id NOT IN "
        "(SELECT file_id FROM file_clip WHERE model=?)", (config.CLIP_MODEL,))
    todo, skipped = [], 0
    for r in rows:
        src = _source(r)
        if src:
            todo.append((r["id"], src))
        else:
            skipped += 1

    manager.update(job_id, total=len(todo),
                   message=f"reading photos ({skipped} skipped, nothing to read)" if skipped
                   else "reading photos…")
    if not todo:
        manager.finish(job_id, "done", "everything is already searchable")
        return

    pool = ProcessPoolExecutor(max_workers=config.CLIP_MAX_WORKERS,
                              initializer=clip_worker.pool_init,
                              initargs=(str(config.CLIP_MODEL_DIR),))
    loop = asyncio.get_running_loop()
    done = errors = 0
    batch: list[tuple[int, str, bytes]] = []
    try:
        it = iter(todo)
        pending: set = set()
        exhausted = False
        last_pub = 0.0
        while True:
            while not exhausted and len(pending) < IN_FLIGHT and not manager.is_cancelled(job_id):
                try:
                    fid, path = next(it)
                    pending.add(loop.run_in_executor(pool, clip_worker.process, fid, path))
                except StopIteration:
                    exhausted = True
            if not pending:
                break
            finished, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for fut in finished:
                try:
                    res = fut.result()
                except Exception as e:
                    res = {"ok": False, "error": str(e)}
                done += 1
                if not res.get("ok"):
                    errors += 1
                    continue
                batch.append((res["file_id"], config.CLIP_MODEL, res["embedding"]))
            # one commit per batch rather than per photo: the writer is a single
            # connection under a lock, and 3000 of them is the whole job's cost
            if len(batch) >= config.SCAN_BATCH_SIZE:
                _store(batch)
                batch = []
            if time.monotonic() - last_pub > 0.5:
                manager.update(job_id, done=done, errors=errors,
                               message=f"{done} of {len(todo)} indexed")
                last_pub = time.monotonic()
            if manager.is_cancelled(job_id):
                break
    finally:
        _store(batch)
        pool.shutdown(wait=False, cancel_futures=True)
        manager.update(job_id, done=done, errors=errors)

    if manager.is_cancelled(job_id):
        # Partial is genuinely useful here — what was indexed stays indexed and
        # is searchable, and running again picks up exactly what is left.
        manager.finish(job_id, "cancelled", f"stopped — {done} indexed and searchable")
    else:
        manager.finish(job_id, "done", f"{done - errors} photos are now searchable")


def _store(batch: list[tuple[int, str, bytes]]) -> None:
    if batch:
        db.executemany(
            "INSERT INTO file_clip (file_id, model, embedding) VALUES (?,?,?) "
            "ON CONFLICT(file_id) DO UPDATE SET model=excluded.model, embedding=excluded.embedding",
            batch)
