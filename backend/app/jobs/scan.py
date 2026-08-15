"""Scan job: walk a library root, diff against the index, fan out to a process
pool, batch-write results. Incremental rescan is the same code path — unchanged
files are skipped by the (size, mtime) diff. Survives drive unplug."""
import asyncio
import os
import time
from concurrent.futures import ProcessPoolExecutor

from .. import config, db, workers
from ..services import thumbs
from ..services import volumes as vol_svc
from ..workers import image_worker, video_worker
from .runner import manager

META_COLS = ("taken_at", "taken_at_ts", "taken_at_src", "width", "height", "orientation",
             "camera_make", "camera_model", "iso", "f_number", "exposure", "focal_length",
             "duration_s", "video_codec", "gps_lat", "gps_lon")

IN_FLIGHT = 64


def _walk(root_abs: str, mount: str) -> list[tuple[str, str, int, int, str]]:
    out = []
    skip_dirs = {str(config.DATA_DIR), "node_modules", ".venv"}
    for dirpath, dirnames, filenames in os.walk(root_abs):
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".") and os.path.join(dirpath, d) not in skip_dirs
                       and d not in ("node_modules", ".venv", "__pycache__")]
        for name in filenames:
            if name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext in config.PHOTO_EXTS:
                mtype = "photo"
            elif ext in config.VIDEO_EXTS:
                mtype = "video"
            else:
                continue
            abs_path = os.path.join(dirpath, name)
            try:
                st = os.stat(abs_path)
            except OSError:
                continue
            rel = os.path.relpath(abs_path, mount)
            out.append((abs_path, rel, st.st_size, st.st_mtime_ns, mtype))
    return out


async def run_scan(job_id: int, root_id: int) -> None:
    root = db.query_one("SELECT * FROM roots WHERE id=?", (root_id,))
    if not root:
        manager.finish(job_id, "failed", "root not found")
        return
    mount = vol_svc.mount_path_for_volume(root["volume_id"])
    if mount is None:
        manager.finish(job_id, "failed", "volume is offline — attach the drive and retry")
        return
    root_abs = os.path.join(mount, root["rel_path"]) if root["rel_path"] else mount
    if not os.path.isdir(root_abs):
        manager.finish(job_id, "failed", f"folder not found: {root_abs}")
        return

    manager.update(job_id, message="walking folder tree…")
    found = await asyncio.to_thread(_walk, root_abs, mount)

    prefix = root["rel_path"] + "/" if root["rel_path"] else ""
    existing = {r["rel_path"]: r for r in db.query(
        "SELECT id, rel_path, size_bytes, mtime_ns, content_hash, status FROM files "
        "WHERE volume_id=? AND (rel_path LIKE ? OR ?='')",
        (root["volume_id"], prefix + "%", prefix),
    )}

    to_process: list[tuple[int, str, str]] = []  # (file_id, abs_path, media_type)
    seen: set[str] = set()
    now = int(time.time())
    with db.transaction() as conn:
        for abs_path, rel, size, mtime_ns, mtype in found:
            seen.add(rel)
            ex = existing.get(rel)
            if ex is None:
                cur = conn.execute(
                    "INSERT INTO files (volume_id, rel_path, filename, media_type, size_bytes, mtime_ns, indexed_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (root["volume_id"], rel, os.path.basename(rel), mtype, size, mtime_ns, now),
                )
                to_process.append((cur.lastrowid, abs_path, mtype))
            else:
                changed = ex["size_bytes"] != size or ex["mtime_ns"] != mtime_ns
                incomplete = ex["content_hash"] is None or not thumbs.thumb_path(ex["id"]).exists()
                if changed or incomplete:
                    conn.execute(
                        "UPDATE files SET size_bytes=?, mtime_ns=?, status='active', face_scanned=0, indexed_at=? WHERE id=?",
                        (size, mtime_ns, now, ex["id"]),
                    )
                    to_process.append((ex["id"], abs_path, mtype))
                elif ex["status"] == "missing":
                    conn.execute("UPDATE files SET status='active' WHERE id=?", (ex["id"],))

    total = len(to_process)
    manager.update(job_id, total=total, message=f"{len(found)} files found, {total} to index")

    interrupted = False
    done = errors = 0
    batch: list[dict] = []
    workers_n = max(1, min(8, (os.cpu_count() or 4) - 2))
    pool = ProcessPoolExecutor(
        max_workers=workers_n, initializer=workers.pool_init,
        initargs=(config.THUMB_MAX_DIM, config.THUMB_WEBP_QUALITY),
    )
    loop = asyncio.get_running_loop()

    def submit(item):
        file_id, abs_path, mtype = item
        fn = image_worker.process if mtype == "photo" else video_worker.process
        return loop.run_in_executor(pool, fn, file_id, abs_path, str(thumbs.thumb_path(file_id)))

    try:
        it = iter(to_process)
        pending: set = set()
        exhausted = False
        last_pub = 0.0
        while True:
            while not exhausted and len(pending) < IN_FLIGHT and not manager.is_cancelled(job_id):
                try:
                    pending.add(submit(next(it)))
                except StopIteration:
                    exhausted = True
            if not pending:
                break
            finished, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for fut in finished:
                try:
                    res = fut.result()
                except Exception as e:  # BrokenProcessPool etc.
                    res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                done += 1
                if res.get("ok"):
                    batch.append(res)
                else:
                    errors += 1
                    if not os.path.ismount(mount) and mount != "/":
                        interrupted = True
            if len(batch) >= config.SCAN_BATCH_SIZE:
                _flush(batch)
                batch = []
            if time.monotonic() - last_pub > 0.5:
                manager.update(job_id, done=done, errors=errors)
                last_pub = time.monotonic()
            if interrupted or manager.is_cancelled(job_id):
                break
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        if batch:
            _flush(batch)
        manager.update(job_id, done=done, errors=errors)

    if manager.is_cancelled(job_id):
        manager.finish(job_id, "cancelled")
        return
    if interrupted:
        db.execute("UPDATE volumes SET is_online=0 WHERE id=?", (root["volume_id"],))
        manager.finish(job_id, "interrupted",
                       "drive disconnected — nothing was marked missing; rescan after reattaching")
        return

    # Completed normally: files under this root that vanished are now 'missing'
    # (soft delete — albums/faces/names survive a drive round-trip).
    gone = [existing[rel]["id"] for rel in existing
            if rel not in seen and existing[rel]["status"] == "active"]
    for i in range(0, len(gone), 500):
        chunk = gone[i:i + 500]
        db.execute(f"UPDATE files SET status='missing' WHERE id IN ({','.join('?' * len(chunk))})", chunk)
    manager.finish(job_id, "done",
                   f"indexed {done - errors} of {total} ({errors} errors, {len(gone)} missing)")


def _flush(batch: list[dict]) -> None:
    db.executemany(
        "UPDATE files SET content_hash=?, phash=? WHERE id=?",
        [(r["content_hash"], r.get("phash"), r["file_id"]) for r in batch],
    )
    db.executemany(
        f"INSERT OR REPLACE INTO metadata (file_id, {', '.join(META_COLS)}) "
        f"VALUES (?{', ?' * len(META_COLS)})",
        [(r["file_id"], *[r.get(c) for c in META_COLS]) for r in batch],
    )
