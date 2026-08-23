from fastapi import APIRouter, HTTPException

from .. import db
from ..jobs import geocode as geocode_job
from ..jobs.runner import manager

router = APIRouter()


@router.get("/places/summary")
def summary():
    """Countries, the states within them, and the cities within those.

    Three levels rather than two because "India · 942 photos" over a flat run of
    thirty cities says very little about where you have been; the state is the
    grouping people actually think in. The geocoder is offline and admin-1 is
    not always resolvable, so a city with no state is not dropped or invented —
    it is returned in a group with `state: null`, which the page shows directly
    under the country with no sub-heading at all.
    """
    rows = db.query(
        "SELECT pl.country, pl.state, pl.city, COUNT(*) n, "
        "(SELECT pl2.file_id FROM file_places pl2 "
        " JOIN files f2 ON f2.id=pl2.file_id JOIN metadata m2 ON m2.file_id=f2.id "
        " WHERE pl2.country=pl.country AND COALESCE(pl2.state,'')=COALESCE(pl.state,'') "
        " AND COALESCE(pl2.city,'')=COALESCE(pl.city,'') AND f2.status='active' "
        " AND f2.id NOT IN (SELECT file_id FROM locked_items) "
        " ORDER BY m2.taken_at DESC LIMIT 1) AS cover "
        "FROM file_places pl JOIN files f ON f.id=pl.file_id "
        "WHERE f.status='active' AND pl.country IS NOT NULL "
        "AND f.id NOT IN (SELECT file_id FROM locked_items) "
        "GROUP BY pl.country, pl.state, pl.city ORDER BY pl.country, n DESC",
    )
    countries: dict[str, dict] = {}
    for r in rows:
        country = countries.setdefault(
            r["country"], {"country": r["country"], "count": 0, "cover": None, "states": {}}
        )
        country["count"] += r["n"]
        # A country's cover is the first row it has, which the ORDER BY makes
        # its busiest place — the same rule as before the states went in.
        country["cover"] = country["cover"] or r["cover"]
        if not r["city"]:
            continue
        # `or None` folds an empty string into the same bucket as NULL: both
        # mean "the geocoder could not name a state", and two groups for one
        # absence would be a distinction the user cannot see the point of.
        key = r["state"] or None
        state = country["states"].setdefault(key, {"state": key, "count": 0, "cities": []})
        state["count"] += r["n"]
        # Rows arrive busiest-first per country, so cities need no sort of their
        # own — appending keeps them in that order within each state.
        state["cities"].append({"city": r["city"], "count": r["n"], "cover": r["cover"]})

    out = []
    for country in sorted(countries.values(), key=lambda c: -c["count"]):
        states = sorted(country["states"].values(), key=lambda st: -st["count"])
        # Cities the geocoder could not place in a state go first, so they read
        # as "in this country" rather than as a stray group after the named ones.
        states.sort(key=lambda st: st["state"] is not None)
        out.append({**country, "states": states})
    return out


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
