from fastapi import APIRouter

from .. import db
from ..services import favourites, filters

router = APIRouter()

# `fav` is the album id interpolated, not bound: it comes from our own row and
# is an int, and inlining it lets SQLite see a constant so the EXISTS is a
# primary-key probe per row rather than a subquery it has to re-plan.
ITEM_SQL = ("SELECT f.id, f.media_type, m.width, m.height, m.duration_s, "
            "substr(m.taken_at, 1, 10) AS day, "
            "EXISTS (SELECT 1 FROM file_motion mo WHERE mo.file_id = f.id) AS live, "
            "EXISTS (SELECT 1 FROM album_items af "
            "        WHERE af.file_id = f.id AND af.album_id = {fav}) AS fav "
            "FROM files f {joins} WHERE {where} "
            "ORDER BY m.taken_at DESC, f.id DESC")


@router.get("/timeline/buckets")
def buckets(person_id: int | None = None, country: str | None = None, city: str | None = None,
            album_id: int | None = None, event_id: int | None = None, solo: int = 0,
            media_type: str | None = None, kind: str | None = None, live: int = 0):
    """The scroll skeleton: one row per day, and just enough shape to predict
    how tall that day will be.

    `ar` is the summed width/height of the day's media. The grid lays photos out
    in justified rows, so a day's height depends on the shape of what is in it,
    not only how many there are — a day of portraits packs into far fewer rows
    than a day of panoramas. Without this the client has to guess, guesses high,
    and then corrects every day as it scrolls past, which moves the ground under
    the reader. One float per day is a cheap price for not doing that.

    The COALESCE mirrors what the grid falls back to for media whose dimensions
    were never read (3x2), so the estimate matches what gets rendered."""
    joins, where, params = filters.build(person_id, country, city, album_id, event_id, solo=bool(solo),
                                         media_type=media_type, kind=kind, live=bool(live))
    rows = db.query(
        f"SELECT substr(m.taken_at, 1, 10) AS day, COUNT(*) n, "
        f"SUM(CAST(COALESCE(m.width, 3) AS REAL) / COALESCE(NULLIF(m.height, 0), 2)) AS ar "
        f"FROM files f {joins} WHERE {where} GROUP BY day ORDER BY day DESC",
        params,
    )
    return [{"day": r["day"], "count": r["n"], "ar": round(r["ar"] or 0.0, 3)} for r in rows]


@router.get("/timeline/items")
def items(day: str | None = None, limit: int = 1000, offset: int = 0,
          person_id: int | None = None, country: str | None = None, city: str | None = None,
          album_id: int | None = None, event_id: int | None = None, solo: int = 0,
          media_type: str | None = None, kind: str | None = None, live: int = 0):
    joins, where, params = filters.build(person_id, country, city, album_id, event_id, day, solo=bool(solo),
                                         media_type=media_type, kind=kind, live=bool(live))
    rows = db.query(
        ITEM_SQL.format(joins=joins, where=where, fav=favourites.album_id()) + " LIMIT ? OFFSET ?",
        (*params, min(limit, 2000), offset),
    )
    return [dict(r) for r in rows]
