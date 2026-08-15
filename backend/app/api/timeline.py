from fastapi import APIRouter

from .. import db
from ..services import filters

router = APIRouter()

ITEM_SQL = ("SELECT f.id, f.media_type, m.width, m.height, m.duration_s, "
            "substr(m.taken_at, 1, 10) AS day "
            "FROM files f {joins} WHERE {where} "
            "ORDER BY m.taken_at DESC, f.id DESC")


@router.get("/timeline/buckets")
def buckets(person_id: int | None = None, country: str | None = None, city: str | None = None,
            album_id: int | None = None, event_id: int | None = None, solo: int = 0,
            media_type: str | None = None):
    joins, where, params = filters.build(person_id, country, city, album_id, event_id, solo=bool(solo),
                                         media_type=media_type)
    rows = db.query(
        f"SELECT substr(m.taken_at, 1, 10) AS day, COUNT(*) n FROM files f {joins} "
        f"WHERE {where} GROUP BY day ORDER BY day DESC",
        params,
    )
    return [{"day": r["day"], "count": r["n"]} for r in rows]


@router.get("/timeline/items")
def items(day: str | None = None, limit: int = 1000, offset: int = 0,
          person_id: int | None = None, country: str | None = None, city: str | None = None,
          album_id: int | None = None, event_id: int | None = None, solo: int = 0,
          media_type: str | None = None):
    joins, where, params = filters.build(person_id, country, city, album_id, event_id, day, solo=bool(solo),
                                         media_type=media_type)
    rows = db.query(
        ITEM_SQL.format(joins=joins, where=where) + " LIMIT ? OFFSET ?",
        (*params, min(limit, 2000), offset),
    )
    return [dict(r) for r in rows]
