"""Rendering a moment, as a job.

Minutes of ffmpeg with a progress bar, so it belongs in the jobs table with
everything else rather than blocking a request. The row is written first and
filled in at the end: a moment that is still rendering is a real thing the UI
can show, and one that failed should say why rather than vanish.
"""
import asyncio
import os
import shutil
import time

from .. import config, db
from ..services import moments as svc
from .runner import manager


async def run_render(job_id: int, moment_id: int) -> None:
    row = db.query_one("SELECT * FROM moments WHERE id=?", (moment_id,))
    if not row:
        manager.finish(job_id, "failed", "that moment is gone")
        return
    db.execute("UPDATE moments SET status='rendering', error=NULL WHERE id=?", (moment_id,))
    work = str(config.MOMENTS_DIR / f".work-{moment_id}")
    rel = f"moment-{moment_id}.mp4"
    out = str(config.MOMENTS_DIR / rel)

    def progress(done: int, total: int) -> None:
        manager.update(job_id, total=total + 1, done=done, message=f"reading {done} of {total} photos")

    try:
        src = svc.source_for(row["kind"], row["ref"])
        # a few more than fit: render drops the softest after looking at them
        picks = svc.curate(svc.candidates(row["kind"], row["ref"]), target=svc.MAX_ITEMS + 4)
        if len(picks) < svc.MIN_ITEMS:
            raise svc.MomentError(
                f"only {len(picks)} usable photos here — a moment needs at least {svc.MIN_ITEMS}")
        track = svc.pick_track(row["track"], seed=moment_id)
        manager.update(job_id, total=len(picks) + 1, done=0, message="reading photos…")

        def work_fn():
            return svc.render(src, picks, out, track, work, on_progress=progress)

        manager.update(job_id, message="putting it together…")
        duration, used = await asyncio.to_thread(work_fn)
    except svc.MomentError as e:
        db.execute("UPDATE moments SET status='failed', error=? WHERE id=?", (str(e), moment_id))
        manager.finish(job_id, "failed", str(e))
        return
    except Exception as e:                      # ffmpeg died, disk full, …
        msg = f"{type(e).__name__}: {e}"
        db.execute("UPDATE moments SET status='failed', error=? WHERE id=?", (msg, moment_id))
        manager.finish(job_id, "failed", msg)
        return
    finally:
        shutil.rmtree(work, ignore_errors=True)

    db.execute(
        "UPDATE moments SET status='ready', rel_path=?, duration_s=?, bytes=?, item_count=?, "
        "cover_file_id=?, track=? WHERE id=?",
        (rel, duration, os.path.getsize(out), len(used), used[0]["id"],
         (track or {}).get("file"), moment_id))
    manager.update(job_id, done=len(picks) + 1)
    manager.finish(job_id, "done", f"{len(used)} photos, {duration:.0f} seconds")


def create(kind: str, ref: str, track: str | None = None) -> int:
    src = svc.source_for(kind, ref)
    cur = db.execute(
        "INSERT INTO moments (kind, ref, title, subtitle, track, created_at) VALUES (?,?,?,?,?,?)",
        (kind, str(ref), src.title, src.subtitle, track, int(time.time())))
    return cur.lastrowid
