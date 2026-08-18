import asyncio
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..jobs import pipeline
from ..jobs import roots as roots_job
from ..jobs import scan as scan_job
from ..jobs.runner import manager
from ..services import volumes as vol_svc

router = APIRouter()


class RootIn(BaseModel):
    path: str


class ScanIn(BaseModel):
    root_id: int


@router.get("/roots")
def list_roots():
    rows = db.query(
        "SELECT r.id, r.rel_path, r.volume_id, v.label, v.last_mount_path, v.is_online, "
        "(SELECT COUNT(*) FROM files f WHERE f.volume_id=r.volume_id AND f.status='active' "
        " AND (r.rel_path='' OR f.rel_path LIKE r.rel_path || '/%')) AS file_count "
        "FROM roots r JOIN volumes v ON v.id=r.volume_id ORDER BY r.id",
    )
    out = []
    for r in rows:
        abs_path = os.path.join(r["last_mount_path"] or "?", r["rel_path"]) if r["rel_path"] else (r["last_mount_path"] or "?")
        out.append({**dict(r), "abs_path": abs_path})
    return out


@router.post("/roots")
def add_root(body: RootIn):
    if not os.path.isdir(body.path):
        raise HTTPException(400, f"not a directory: {body.path}")
    volume_id, _, rel = vol_svc.volume_for_path(body.path)
    existing = db.query_one("SELECT id FROM roots WHERE volume_id=? AND rel_path=?", (volume_id, rel))
    if existing:
        return {"id": existing["id"], "existed": True}
    cur = db.execute("INSERT INTO roots (volume_id, rel_path) VALUES (?,?)", (volume_id, rel))
    return {"id": cur.lastrowid, "existed": False}


@router.get("/roots/{root_id}/removal")
def removal_preview(root_id: int):
    """What removing this folder would actually take out of the library.

    The UI asks before it deletes, and "1,234 photos" is only honest if it is
    the number this specific removal would touch — files still covered by
    another watched folder are not counted, because they are not going."""
    root = db.query_one("SELECT * FROM roots WHERE id=?", (root_id,))
    if not root:
        raise HTTPException(404, "no such folder")
    doomed = roots_job._ids_under(root)
    for other in db.query("SELECT * FROM roots WHERE id!=?", (root_id,)):
        doomed -= roots_job._ids_under(other)
    if not doomed:
        return {"files": 0, "photos": 0, "videos": 0, "faces": 0, "locked": 0}
    marks = ",".join("?" * len(doomed))
    ids = list(doomed)
    kinds = {r["media_type"]: r["n"] for r in db.query(
        f"SELECT media_type, COUNT(*) n FROM files WHERE id IN ({marks}) GROUP BY media_type", ids)}
    return {
        "files": len(ids),
        "photos": kinds.get("photo", 0),
        "videos": kinds.get("video", 0),
        "faces": db.query_one(f"SELECT COUNT(*) n FROM faces WHERE file_id IN ({marks})", ids)["n"],
        # worth calling out separately: these are deliberately hidden photos
        "locked": db.query_one(
            f"SELECT COUNT(*) n FROM locked_items WHERE file_id IN ({marks})", ids)["n"],
    }


@router.delete("/roots/{root_id}")
def delete_root(root_id: int):
    """Stop watching a folder AND take its photos out of the library.

    Runs as a job: a large folder is tens of thousands of row deletes plus the
    thumbnail, preview and face-crop caches. Nothing on disk is touched."""
    if not db.query_one("SELECT id FROM roots WHERE id=?", (root_id,)):
        raise HTTPException(404, "no such folder")
    if manager.any_running("scan") or manager.any_running("remove"):
        raise HTTPException(409, "wait for the current scan to finish, then try again")
    job_id = manager.create("remove", root_id=root_id)
    manager.start(job_id, roots_job.run_remove_root(job_id, root_id))
    return {"job_id": job_id}


@router.post("/scan")
def start_scan(body: ScanIn):
    if manager.any_running("scan"):
        raise HTTPException(409, "a scan is already running")
    job_id = manager.create("scan", root_id=body.root_id)
    manager.start(job_id, scan_job.run_scan(job_id, body.root_id))
    return {"job_id": job_id}


@router.post("/process")
def start_pipeline(body: ScanIn):
    """Index the root, then auto-run every processing step in sequence."""
    if manager.any_running("scan"):
        raise HTTPException(409, "a scan is already running")
    if not db.query_one("SELECT id FROM roots WHERE id=?", (body.root_id,)):
        raise HTTPException(404, "no such root")
    asyncio.run_coroutine_threadsafe(pipeline.run_pipeline(body.root_id), manager.loop)
    return {"ok": True}
