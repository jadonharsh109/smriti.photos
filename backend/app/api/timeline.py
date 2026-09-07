from fastapi import APIRouter
from fastapi.responses import Response

from .. import db
from ..services import aggregates, favourites, filters

router = APIRouter()

# The row shape every grid renders, as SQLite builds it (see db.query_json):
# one JSON document per request, no Python objects in between.
#
# `fav` is the album id interpolated, not bound: it comes from our own row and
# is an int, and inlining it lets SQLite see a constant so the EXISTS is a
# primary-key probe per row rather than a subquery it has to re-plan.
ITEM_JSON = (
    "SELECT json_group_array(json_object("
    " 'id', q.id, 'media_type', q.media_type, 'width', q.width, 'height', q.height, "
    " 'duration_s', q.duration_s, 'day', q.day, 'live', q.live, 'fav', q.fav) "
    " ORDER BY q.taken_at DESC, q.id DESC) "
    "FROM (SELECT f.id, f.media_type, m.width, m.height, m.duration_s, m.day, m.taken_at, f.live, "
    "      EXISTS (SELECT 1 FROM album_items af WHERE af.file_id = f.id AND af.album_id = {fav}) AS fav "
    "      FROM files f {joins} WHERE {where} "
    "      ORDER BY m.taken_at DESC, f.id DESC LIMIT ? OFFSET ?) q"
)

_AR = "SUM(CAST(COALESCE(m.width, 3) AS REAL) / COALESCE(NULLIF(m.height, 0), 2))"

_BUCKET_JSON = "json_group_array(json_object('day', q.day, 'count', q.n, 'ar', q.ar) ORDER BY q.day DESC)"

# The Photos page's own views, cached as the bytes they are sent as. Keyed on
# the aggregates' day version, so a refresh — a scan, a lock, a delete — drops
# them and the next request rebuilds from day_buckets (2 ms at 300,000 files).
_plain_cache: dict[str, tuple[int, bytes]] = {}


def _json(doc: str | bytes) -> Response:
    return Response(content=doc, media_type="application/json")


@router.get("/timeline/buckets")
def buckets(person_id: int | None = None, country: str | None = None, city: str | None = None,
            state: str | None = None,
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

    The Photos page's own views — everything, photos, videos, Live Photos — are
    read from `day_buckets`, which the job runner keeps current: 2 ms at
    300,000 files where the GROUP BY it replaced took 260. Filtered views (a
    person, a place, an album, an event, the Documents page) are bounded
    subsets and are computed live over the flags."""
    if filters.is_plain(person_id, country, city, album_id, event_id, bool(solo), kind, state):
        scope = "live" if live else (media_type if media_type in ("photo", "video") else "all")
        version = aggregates.days_version()
        hit = _plain_cache.get(scope)
        if hit and hit[0] == version:
            return _json(hit[1])
        doc = db.query_json(
            f"SELECT {_BUCKET_JSON} FROM (SELECT day, n, ar FROM day_buckets WHERE scope = ?) q", (scope,))
        _plain_cache[scope] = (version, doc.encode())
        return _json(doc)

    joins, where, params = filters.build(person_id, country, city, album_id, event_id, solo=bool(solo),
                                         media_type=media_type, kind=kind, live=bool(live), state=state)
    # The COALESCE mirrors what the grid falls back to for media whose
    # dimensions were never read (3x2), so the estimate matches what renders.
    return _json(db.query_json(
        f"SELECT {_BUCKET_JSON} FROM (SELECT m.day AS day, COUNT(*) AS n, ROUND({_AR}, 3) AS ar "
        f"FROM files f {joins} WHERE {where} GROUP BY m.day) q",
        params,
    ))


@router.get("/timeline/items")
def items(day: str | None = None, limit: int = 1000, offset: int = 0,
          person_id: int | None = None, country: str | None = None, city: str | None = None,
          state: str | None = None,
          album_id: int | None = None, event_id: int | None = None, solo: int = 0,
          media_type: str | None = None, kind: str | None = None, live: int = 0):
    joins, where, params = filters.build(person_id, country, city, album_id, event_id, day, solo=bool(solo),
                                         media_type=media_type, kind=kind, live=bool(live), state=state)
    return _json(db.query_json(
        ITEM_JSON.format(joins=joins, where=where, fav=favourites.album_id()),
        (*params, min(limit, 2000), offset),
    ))
