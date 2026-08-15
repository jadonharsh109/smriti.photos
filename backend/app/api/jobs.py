import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from .. import db
from ..jobs.runner import manager

router = APIRouter()


@router.get("/jobs")
def list_jobs(limit: int = 30):
    return [dict(r) for r in db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,))]


@router.get("/jobs/stream")
async def jobs_stream(request: Request):
    q = manager.subscribe()

    async def gen():
        try:
            yield {"event": "hello", "data": "{}"}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                    etype = event.pop("__type", "job")
                    yield {"event": etype, "data": json.dumps(event)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            manager.unsubscribe(q)

    return EventSourceResponse(gen())


@router.get("/jobs/{job_id}")
def get_job(job_id: int):
    row = db.query_one("SELECT * FROM jobs WHERE id=?", (job_id,))
    if not row:
        raise HTTPException(404, "no such job")
    return dict(row)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int):
    manager.request_cancel(job_id)
    return {"ok": True}
