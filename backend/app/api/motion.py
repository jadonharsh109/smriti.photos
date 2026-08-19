"""Live Photos: pairing a still with the movie that belongs to it."""
from fastapi import APIRouter, HTTPException

from .. import db
from ..jobs import motion as motion_job
from ..jobs.runner import manager

router = APIRouter()


@router.post("/motion/scan")
def run_motion():
    """Find Live Photos. Runs after every scan; this is for a library that was
    built before Smriti understood them, where the videos need one pass to be
    asked whether they are one half of a photograph."""
    if manager.any_running("motion"):
        raise HTTPException(409, "already looking for live photos")
    job_id = manager.create("motion")
    manager.start(job_id, motion_job.run_motion_scan(job_id))
    return {"job_id": job_id}


@router.get("/motion/summary")
def summary():
    return {
        "live": db.query_one(
            "SELECT COUNT(*) n FROM file_motion mo JOIN files f ON f.id = mo.file_id "
            "WHERE f.status='active'")["n"],
        "unpaired_clips": db.query_one(
            "SELECT COUNT(*) n FROM metadata m JOIN files f ON f.id = m.file_id "
            "WHERE m.content_id IS NOT NULL AND m.content_id != '' AND f.status='active' "
            "AND m.content_id NOT IN (SELECT content_id FROM file_motion "
            "                         WHERE content_id IS NOT NULL)")["n"],
        "videos_unchecked": db.query_one(
            "SELECT COUNT(*) n FROM metadata m JOIN files f ON f.id = m.file_id "
            "WHERE f.media_type='video' AND f.status='active' AND m.content_id IS NULL")["n"],
    }
