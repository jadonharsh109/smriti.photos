"""Cleanup: the two views that are not about duplicates.

**Blurry** — photos scored by `jobs/blur.py`, worst first.
**Missing** — photos whose originals were deleted outside Smriti.

Neither of these deletes an original. Blurry hands file ids to the existing
`POST /files/delete`, which routes through the system Trash; Missing only drops
rows whose files a completed scan already confirmed are gone.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db
from ..jobs import blur as blur_job
from ..jobs.runner import manager
from ..services import purge

router = APIRouter()


@router.get("/cleanup/blurry")
def blurry(sensitivity: str = "normal", limit: int = 300):
    """Softest photos first.

    Sharpness is relative, so this is a threshold rather than a verdict — a
    photo of fog or a plain sky is genuinely low-detail and can land here
    without being a bad photo. Nothing is ever deleted automatically; this is a
    review queue.
    """
    ceiling = config.BLUR_CEILINGS.get(sensitivity)
    if ceiling is None:
        raise HTTPException(400, f"sensitivity must be one of {', '.join(config.BLUR_CEILINGS)}")

    rows = db.query(
        "SELECT f.id, f.filename, q.sharpness "
        "FROM file_quality q JOIN files f ON f.id = q.file_id "
        "WHERE f.status='active' AND q.sharpness < ? "
        "AND f.id NOT IN (SELECT file_id FROM locked_items) "
        "ORDER BY q.sharpness ASC LIMIT ?",
        (ceiling, max(1, min(limit, 1000))),
    )
    scored = db.query_one("SELECT COUNT(*) n FROM file_quality")["n"]
    unscored = db.query_one(
        "SELECT COUNT(*) n FROM files WHERE status='active' AND media_type='photo' "
        "AND id NOT IN (SELECT file_id FROM file_quality)"
    )["n"]
    return {
        "items": [dict(r) for r in rows],
        "scored": scored,
        "unscored": unscored,
        "sensitivity": sensitivity,
        "ceiling": ceiling,
    }


@router.post("/cleanup/blur/scan")
def run_blur(rescore: bool = False):
    if manager.any_running("blur"):
        raise HTTPException(409, "already checking")
    job_id = manager.create("blur")
    manager.start(job_id, blur_job.run_blur_scan(job_id, rescore))
    return {"job_id": job_id}


@router.get("/cleanup/missing")
def missing(limit: int = 300):
    """Photos a completed scan found were no longer on disk.

    Safe by construction: `jobs/scan.py` marks nothing missing when a drive
    disconnects mid-scan, so an unplugged drive can never fill this list.
    """
    rows = db.query(
        "SELECT f.id, f.filename, f.rel_path, v.label AS volume "
        "FROM files f JOIN volumes v ON v.id = f.volume_id "
        "WHERE f.status='missing' ORDER BY f.id LIMIT ?",
        (max(1, min(limit, 1000)),),
    )
    total = db.query_one("SELECT COUNT(*) n FROM files WHERE status='missing'")["n"]
    return {"items": [dict(r) for r in rows], "total": total}


class ForgetIn(BaseModel):
    file_ids: list[int] | None = None   # None = every missing file


@router.post("/cleanup/missing/forget")
def forget_missing(body: ForgetIn):
    """Drop rows for files that are already gone, and reclaim their caches."""
    if body.file_ids:
        marks = ",".join("?" * len(body.file_ids))
        rows = db.query(
            f"SELECT id FROM files WHERE status='missing' AND id IN ({marks})", body.file_ids
        )
    else:
        rows = db.query("SELECT id FROM files WHERE status='missing'")

    ids = [r["id"] for r in rows]
    if not ids:
        return {"forgotten": 0}
    purge.purge_files(None, ids)
    purge.drop_orphan_people()
    return {"forgotten": len(ids)}
