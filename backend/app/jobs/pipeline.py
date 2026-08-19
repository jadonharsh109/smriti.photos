"""One-click pipeline: scan a root, then run every processing step in order
(documents → geocode → events → near-duplicates → faces → people). Each stage is a normal
job row, so the SSE stream / activity log shows exactly what's happening.

Also hosts the auto-scan watcher: a background loop that periodically
re-scans every online root and runs the processing steps whenever the
index actually changed."""
import asyncio
import time

from .. import config, db
from ..services import volumes as vol_svc
from . import classify as classify_job
from . import dupes as dupes_job
from . import events as events_job
from . import faces as faces_job
from . import geocode as geocode_job
from . import motion as motion_job
from . import scan as scan_job
from . import takeout as takeout_job
from .runner import manager


async def _wait_idle(*kinds: str) -> None:
    while any(manager.any_running(k) for k in kinds):
        await asyncio.sleep(2)


async def _stage(kind: str, coro_factory, root_id: int | None = None) -> str:
    await _wait_idle(kind)
    job_id = manager.create(kind, root_id=root_id)
    await manager._guard(job_id, coro_factory(job_id))
    row = db.query_one("SELECT status FROM jobs WHERE id=?", (job_id,))
    return row["status"] if row else "failed"


async def run_post_scan() -> None:
    # First, and deliberately: it is metadata-only and finishes in well under a
    # second, and until it has run every screenshot is still sitting in the main
    # timeline. Cheapest stage, and the one whose absence is most visible.
    await _stage("classify", lambda jid: classify_job.run_classify(jid))
    # Straight after the scan: it needs the identifiers ffprobe just collected,
    # and everything downstream should already know a Live Photo is one item.
    await _stage("motion", lambda jid: motion_job.run_motion_scan(jid))
    await _stage("geocode", lambda jid: geocode_job.run_geocode(jid, False))
    await _stage("events", lambda jid: events_job.run_events_rebuild(jid))
    await _stage("neardup", lambda jid: dupes_job.run_near_dupes(jid))
    if (config.FACE_MODEL_DIR / "det_10g.onnx").exists():
        await _wait_idle("faces", "recluster")
        if await _stage("faces", lambda jid: faces_job.run_face_scan(jid)) == "done":
            await _wait_idle("faces", "recluster")
            await _stage("recluster", lambda jid: faces_job.run_recluster(jid))
    # A Takeout import records its albums but cannot apply them — the photos
    # have no ids until a scan covers them, which only happens if the user
    # chooses to add the folder. This is that moment, whenever it arrives.
    await asyncio.to_thread(takeout_job.apply_pending_albums)


async def run_pipeline(root_id: int) -> None:
    status = await _stage("scan", lambda jid: scan_job.run_scan(jid, root_id), root_id=root_id)
    if status != "done":
        return  # nothing to process if indexing didn't finish
    await run_post_scan()


# ---- auto-scan watcher ------------------------------------------------------

def _setting(key: str, default: str) -> str:
    row = db.query_one("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row and row["value"] is not None else default


def _fingerprint() -> tuple:
    # deliberately excludes indexed_at: perpetually-erroring files are retried
    # (and re-stamped) every scan, which must not read as "library changed".
    # mtime residues keep the sum inside 64-bit while still moving on any edit.
    row = db.query_one(
        "SELECT COUNT(*) AS total, COALESCE(MAX(id),0) AS max_id, "
        "COALESCE(SUM(status='active'),0) AS active, "
        "COALESCE(SUM(mtime_ns % 1000000007),0) AS mt FROM files"
    )
    return (row["total"], row["max_id"], row["active"], row["mt"])


async def auto_scan_once() -> bool:
    """Re-scan every online root; if anything changed, run the full
    processing chain. Returns whether changes were found."""
    changed = False
    for r in db.query("SELECT id, volume_id FROM roots"):
        if vol_svc.mount_path_for_volume(r["volume_id"]) is None:
            continue  # drive offline — skip silently, retry next cycle
        before = _fingerprint()
        status = await _stage(
            "scan", lambda jid, rid=r["id"]: scan_job.run_scan(jid, rid), root_id=r["id"]
        )
        if status == "done" and _fingerprint() != before:
            changed = True
    if changed:
        await run_post_scan()
    return changed


async def volume_watch_loop() -> None:
    """Notice drives being attached/removed within seconds: sync the volumes
    table, push a 'volumes' SSE event so the UI updates live, and kick an
    immediate auto-scan check when something was attached."""
    prev_sig: tuple | None = None
    prev_online: dict[str, str] = {}  # mount_path -> label
    while True:
        try:
            mounts = await asyncio.to_thread(vol_svc.list_mounts)  # cheap: no per-disk queries
            sig = tuple(sorted(m["mount_path"] for m in mounts))
            if prev_sig is None:
                prev_sig = sig
                prev_online = {m["mount_path"]: m["label"] for m in mounts}
            elif sig != prev_sig:
                vols = await asyncio.to_thread(vol_svc.refresh_volumes)
                now = {v["mount_path"]: v["label"] for v in vols}
                attached = [{"mount_path": p, "label": lb} for p, lb in now.items() if p not in prev_online]
                removed = [{"mount_path": p, "label": lb} for p, lb in prev_online.items() if p not in now]
                prev_sig, prev_online = sig, now
                manager.publish_event("volumes", {"attached": attached, "removed": removed})
                if attached and _setting("auto_scan", "1") == "1" and not manager.any_running():
                    await auto_scan_once()
        except Exception:
            pass  # the watcher must never die
        await asyncio.sleep(3)


async def auto_scan_loop() -> None:
    """Background watcher: checks the library on a user-set interval."""
    last_run = 0.0
    while True:
        await asyncio.sleep(60)
        try:
            if _setting("auto_scan", "1") != "1":
                continue
            interval_s = max(5, int(_setting("auto_scan_minutes", "30"))) * 60
            if time.time() - last_run < interval_s:
                continue
            if manager.any_running():
                continue  # something else is busy — try again next minute
            last_run = time.time()
            await auto_scan_once()
        except Exception:
            pass  # the watcher must never die
