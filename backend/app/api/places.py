from fastapi import APIRouter, HTTPException

from .. import db
from ..jobs import geocode as geocode_job
from ..jobs.runner import manager

router = APIRouter()


@router.get("/places/summary")
def summary():
    rows = db.query(
        "SELECT pl.country, pl.city, COUNT(*) n, "
        "(SELECT pl2.file_id FROM file_places pl2 "
        " JOIN files f2 ON f2.id=pl2.file_id JOIN metadata m2 ON m2.file_id=f2.id "
        " WHERE pl2.country=pl.country AND COALESCE(pl2.city,'')=COALESCE(pl.city,'') AND f2.status='active' "
        " AND f2.id NOT IN (SELECT file_id FROM locked_items) "
        " ORDER BY m2.taken_at DESC LIMIT 1) AS cover "
        "FROM file_places pl JOIN files f ON f.id=pl.file_id "
        "WHERE f.status='active' AND pl.country IS NOT NULL "
        "AND f.id NOT IN (SELECT file_id FROM locked_items) "
        "GROUP BY pl.country, pl.city ORDER BY pl.country, n DESC",
    )
    countries: dict[str, dict] = {}
    for r in rows:
        c = countries.setdefault(r["country"], {"country": r["country"], "count": 0, "cities": []})
        c["count"] += r["n"]
        c["cover"] = c.get("cover") or r["cover"]
        if r["city"]:
            c["cities"].append({"city": r["city"], "count": r["n"], "cover": r["cover"]})
    return sorted(countries.values(), key=lambda c: -c["count"])


@router.get("/places/points")
def points(precision: int = 1):
    if not 0 <= precision <= 4:
        raise HTTPException(400, "precision 0-4")
    rows = db.query(
        "SELECT ROUND(m.gps_lat, ?) lat, ROUND(m.gps_lon, ?) lon, COUNT(*) n, "
        "MIN(pl.city) city, MIN(pl.country) country "
        "FROM metadata m JOIN files f ON f.id=m.file_id "
        "LEFT JOIN file_places pl ON pl.file_id=m.file_id "
        "WHERE m.gps_lat IS NOT NULL AND f.status='active' "
        "AND f.id NOT IN (SELECT file_id FROM locked_items) "
        "GROUP BY ROUND(m.gps_lat, ?), ROUND(m.gps_lon, ?)",
        (precision, precision, precision, precision),
    )
    return [dict(r) for r in rows]


@router.post("/places/geocode")
def run_geocode(force: bool = False):
    if manager.any_running("geocode"):
        raise HTTPException(409, "geocode already running")
    job_id = manager.create("geocode")
    manager.start(job_id, geocode_job.run_geocode(job_id, force))
    return {"job_id": job_id}
