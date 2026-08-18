"""Score how sharp each photo is, so Cleanup can surface the blurry ones.

Reads the 512px thumbnails that already exist rather than the originals. That is
what lets this run against a library someone built months ago without
re-indexing anything, and what makes it cheap enough to re-run whenever the
rules change — the same bargain the Documents sorter makes.

The trade is honest: obvious blur — camera shake, badly missed focus, motion —
survives downscaling and is caught. A subtle focus miss that only shows at full
size will not be. "Obvious enough to delete" is the useful category here anyway.

Metric is variance of the Laplacian: convolve with a discrete Laplacian kernel
and take the variance of the response. Flat, soft images have little
high-frequency energy and score low; crisp edges score high.
"""
import asyncio
import time

import numpy as np
from PIL import Image

from .. import config, db
from ..services import purge  # artifact() — thumbnails live at the same sharded paths
from .runner import manager

BATCH = 200


def _sharpness(path) -> float | None:
    """Variance of the Laplacian over a greyscale thumbnail."""
    try:
        with Image.open(path) as im:
            g = np.asarray(im.convert("L"), dtype=np.float32)
    except Exception:
        return None  # unreadable or truncated cache file — not worth a job failure
    if g.ndim != 2 or min(g.shape) < 8:
        return None

    # 4-neighbour discrete Laplacian, interior only (no padding artefacts).
    lap = (
        g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:] - 4.0 * g[1:-1, 1:-1]
    )
    return float(lap.var())


def _score(job_id: int, rows: list) -> tuple[int, int]:
    scored = skipped = 0
    now = int(time.time())
    last = 0.0
    batch: list[tuple] = []

    for i, r in enumerate(rows):
        if manager.is_cancelled(job_id):
            break
        path = purge.artifact(config.THUMBS_DIR, r["id"])
        val = _sharpness(path) if path.exists() else None
        if val is None:
            skipped += 1
        else:
            batch.append((r["id"], val, "thumb", now))
            scored += 1

        if len(batch) >= BATCH:
            db.executemany(
                "INSERT INTO file_quality (file_id, sharpness, source, scored_at) VALUES (?,?,?,?) "
                "ON CONFLICT(file_id) DO UPDATE SET sharpness=excluded.sharpness, "
                "source=excluded.source, scored_at=excluded.scored_at",
                batch,
            )
            batch.clear()

        t = time.monotonic()
        if t - last >= 0.5:  # the publish throttle every job uses
            last = t
            manager.update(job_id, total=len(rows), done=i + 1, errors=skipped)

    if batch:
        db.executemany(
            "INSERT INTO file_quality (file_id, sharpness, source, scored_at) VALUES (?,?,?,?) "
            "ON CONFLICT(file_id) DO UPDATE SET sharpness=excluded.sharpness, "
            "source=excluded.source, scored_at=excluded.scored_at",
            batch,
        )
    return scored, skipped


async def run_blur_scan(job_id: int, rescore: bool = False) -> None:
    """Score photos that have no score yet, or every photo when `rescore`."""
    where = (
        "WHERE f.status='active' AND f.media_type='photo'"
        if rescore
        else "WHERE f.status='active' AND f.media_type='photo' "
        "AND f.id NOT IN (SELECT file_id FROM file_quality)"
    )
    rows = db.query(f"SELECT f.id FROM files f {where} ORDER BY f.id")
    if not rows:
        manager.finish(job_id, "done", "every photo already has a sharpness score")
        return

    manager.update(job_id, total=len(rows), done=0, message=f"checking {len(rows):,} photos…")
    scored, skipped = await asyncio.to_thread(_score, job_id, rows)

    if manager.is_cancelled(job_id):
        manager.finish(job_id, "cancelled", f"stopped after {scored:,} photos")
        return
    manager.finish(
        job_id,
        "done",
        f"{scored:,} photos checked" + (f" · {skipped:,} had no thumbnail yet" if skipped else ""),
    )
