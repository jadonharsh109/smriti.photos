from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from .. import db
from ..jobs import events as events_job
from ..jobs.runner import manager

router = APIRouter()


class EventPatch(BaseModel):
    title: str


@router.get("/events")
def list_events(year: int | None = None, limit: int | None = None, offset: int = 0):
    """Events with something visible in them, newest first.

    `item_count` and `cover_file_id` are maintained columns (migration 0014,
    services/aggregates.py) — the cover is guaranteed to be an active, unlocked
    member, else the newest one. The per-event subqueries this replaces took
    470 ms on 5,000 events, and shipped all 5,000 as one 600 KB response; a
    caller can now ask for one year, or a page.
    """
    where = ["e.item_count > 0"]
    params: list = []
    if year is not None:
        # local-time year bounds, matching how titles and the year list are cut
        where.append("e.start_ts >= ? AND e.start_ts < ?")
        params += [int(datetime(year, 1, 1).timestamp()), int(datetime(year + 1, 1, 1).timestamp())]
    inner = (f"SELECT e.id, e.title, e.start_ts, e.end_ts, e.is_user_titled, e.item_count, e.cover_file_id "
             f"FROM events e WHERE {' AND '.join(where)} ORDER BY e.start_ts DESC")
    if limit is not None:
        inner += " LIMIT ? OFFSET ?"
        params += [max(1, min(limit, 5000)), max(0, offset)]
    # built by SQLite in one step — see db.query_json for why
    return Response(media_type="application/json", content=db.query_json(
        "SELECT json_group_array(json_object('id', q.id, 'title', q.title, 'start_ts', q.start_ts, "
        "'end_ts', q.end_ts, 'is_user_titled', q.is_user_titled, 'count', q.item_count, "
        "'cover_file_id', q.cover_file_id) ORDER BY q.start_ts DESC) FROM (" + inner + ") q", params))


@router.get("/events/years")
def years():
    """How the events spread over years, for a page that shows one at a time."""
    rows = db.query(
        "SELECT CAST(strftime('%Y', start_ts, 'unixepoch', 'localtime') AS INTEGER) AS year, "
        "COUNT(*) AS events, SUM(item_count) AS items "
        "FROM events WHERE item_count > 0 GROUP BY year ORDER BY year DESC")
    return [dict(r) for r in rows]


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
