"""Offline reverse geocoding: batch every GPS-tagged file through the
GeoNames-based reverse_geocoder (mode=1 — its default mode=2 spawns
multiprocessing workers, which misbehaves inside a server process)."""
import asyncio

from .. import db
from ..services.countries import COUNTRY_NAMES
from .runner import manager


async def run_geocode(job_id: int, force: bool = False) -> None:
    where = "" if force else "AND f.id NOT IN (SELECT file_id FROM file_places)"
    rows = db.query(
        f"SELECT f.id, m.gps_lat, m.gps_lon FROM files f JOIN metadata m ON m.file_id=f.id "
        f"WHERE m.gps_lat IS NOT NULL {where}",
    )
    if not rows:
        manager.finish(job_id, "done", "no new GPS-tagged files")
        return
    manager.update(job_id, total=len(rows), message="reverse geocoding…")

    coords = [(r["gps_lat"], r["gps_lon"]) for r in rows]
    results = await asyncio.to_thread(_geocode, coords)

    payload = []
    for r, res in zip(rows, results):
        cc = res.get("cc") or ""
        payload.append((r["id"], cc, COUNTRY_NAMES.get(cc, cc or None),
                        res.get("admin1") or None, res.get("name") or None))
    db.executemany(
        "INSERT OR REPLACE INTO file_places (file_id, country_code, country, state, city) VALUES (?,?,?,?,?)",
        payload,
    )
    manager.update(job_id, done=len(rows))
    manager.finish(job_id, "done", f"geocoded {len(rows)} files")


def _geocode(coords):
    import reverse_geocoder as rg

    return rg.search(coords, mode=1)
