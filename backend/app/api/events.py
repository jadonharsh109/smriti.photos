from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..jobs import events as events_job
from ..jobs.runner import manager

router = APIRouter()


class EventPatch(BaseModel):
    title: str


@router.get("/events")
def list_events():
    return [dict(r) for r in db.query(
        "SELECT e.id, e.title, e.start_ts, e.end_ts, e.is_user_titled, "
        "(SELECT COUNT(*) FROM event_items ei JOIN files f ON f.id=ei.file_id "
        " WHERE ei.event_id=e.id AND f.status='active' "
        " AND f.id NOT IN (SELECT file_id FROM locked_items)) AS count, "
        # cover: the stored one unless it's locked, else the newest visible item
        "(SELECT ei.file_id FROM event_items ei JOIN files f ON f.id=ei.file_id "
        " LEFT JOIN metadata m ON m.file_id=f.id "
        " WHERE ei.event_id=e.id AND f.status='active' "
        " AND f.id NOT IN (SELECT file_id FROM locked_items) "
        " ORDER BY (ei.file_id = e.cover_file_id) DESC, m.taken_at DESC LIMIT 1) AS cover_file_id "
        "FROM events e ORDER BY e.start_ts DESC",
    ) if r["count"] > 0]


@router.patch("/events/{event_id}")
def rename_event(event_id: int, body: EventPatch):
    if not db.query_one("SELECT id FROM events WHERE id=?", (event_id,)):
        raise HTTPException(404, "no such event")
    db.execute("UPDATE events SET title=?, is_user_titled=1 WHERE id=?", (body.title, event_id))
    return {"ok": True}


@router.post("/events/rebuild")
def rebuild():
    if manager.any_running("events"):
        raise HTTPException(409, "event rebuild already running")
    job_id = manager.create("events")
    manager.start(job_id, events_job.run_events_rebuild(job_id))
    return {"job_id": job_id}
