"""Documents section: run the sorter, see what it found, correct it."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..jobs import classify as classify_job
from ..jobs.runner import manager
from ..services import aggregates
from ..services import kinds as kinds_svc

router = APIRouter()


class IdsIn(BaseModel):
    file_ids: list[int]


@router.get("/kinds/summary")
def summary():
    """Counts per kind, for the Documents page's filter chips — from the
    maintained library totals (services/aggregates.py)."""
    stats = aggregates.stats()
    counts = {k[5:]: v for k, v in stats.items() if k.startswith("kind:") and v > 0}
    out = [{"kind": k, "label": kinds_svc.label(k), "count": n}
           for k, n in sorted(counts.items(), key=lambda kv: -kv[1])]
    return {"kinds": out, "total": sum(k["count"] for k in out)}


@router.post("/kinds/classify")
def run_classify():
    if manager.any_running("classify"):
        raise HTTPException(409, "already sorting")
    job_id = manager.create("classify")
    manager.start(job_id, classify_job.run_classify(job_id))
    return {"job_id": job_id}


@router.post("/kinds/not-document")
def not_document(body: IdsIn):
    """Send files back to the timeline, permanently.

    Recorded as source='manual' rather than deleted so the next classification
    pass cannot undo the correction — the same contract faces use for a
    manually assigned person."""
    if not body.file_ids:
        raise HTTPException(400, "nothing selected")
    # Stored as kind='photo' rather than deleted: the row is a tombstone that
    # tells the next classification pass to leave this file alone. Every query
    # that asks "is this a document?" filters on kind != 'photo', so the
    # tombstone reads as an ordinary photo everywhere in the UI.
    with db.transaction() as conn:
        conn.executemany(
            "INSERT INTO file_kinds (file_id, kind, confidence, source) VALUES (?, 'photo', 1.0, 'manual') "
            "ON CONFLICT(file_id) DO UPDATE SET kind='photo', confidence=1.0, source='manual'",
            [(fid,) for fid in body.file_ids],
        )
        conn.executemany("UPDATE files SET doc = 0 WHERE id = ?", [(fid,) for fid in body.file_ids])
    aggregates.files_changed(body.file_ids)
    return {"ok": True, "restored": len(body.file_ids)}
