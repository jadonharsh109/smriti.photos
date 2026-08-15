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
        "SELECT e.*, (SELECT COUNT(*) FROM event_items ei JOIN files f ON f.id=ei.file_id "
        "WHERE ei.event_id=e.id AND f.status='active') AS count "
        "FROM events e ORDER BY e.start_ts DESC",
    )]


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
