import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db

router = APIRouter()


class AlbumIn(BaseModel):
    name: str


class AlbumPatch(BaseModel):
    name: str | None = None
    cover_file_id: int | None = None


class ItemsIn(BaseModel):
    file_ids: list[int]


@router.get("/albums")
def list_albums():
    return [dict(r) for r in db.query(
        "SELECT a.*, (SELECT COUNT(*) FROM album_items ai WHERE ai.album_id=a.id) AS count, "
        "COALESCE(a.cover_file_id, (SELECT ai.file_id FROM album_items ai WHERE ai.album_id=a.id "
        "ORDER BY ai.position LIMIT 1)) AS cover "
        "FROM albums a ORDER BY a.created_at DESC",
    )]


@router.post("/albums")
def create_album(body: AlbumIn):
    cur = db.execute("INSERT INTO albums (name, created_at) VALUES (?,?)", (body.name, int(time.time())))
    return {"id": cur.lastrowid}


@router.get("/albums/{album_id}")
def album_detail(album_id: int):
    row = db.query_one("SELECT * FROM albums WHERE id=?", (album_id,))
    if not row:
        raise HTTPException(404, "no such album")
    items = db.query(
        "SELECT f.id, f.media_type, m.width, m.height, m.duration_s, ai.position "
        "FROM album_items ai JOIN files f ON f.id=ai.file_id "
        "LEFT JOIN metadata m ON m.file_id=f.id "
        "WHERE ai.album_id=? AND f.status='active' ORDER BY ai.position",
        (album_id,),
    )
    return {**dict(row), "items": [dict(i) for i in items]}


@router.patch("/albums/{album_id}")
def patch_album(album_id: int, body: AlbumPatch):
    if body.name is not None:
        db.execute("UPDATE albums SET name=? WHERE id=?", (body.name, album_id))
    if body.cover_file_id is not None:
        db.execute("UPDATE albums SET cover_file_id=? WHERE id=?", (body.cover_file_id, album_id))
    return {"ok": True}


@router.delete("/albums/{album_id}")
def delete_album(album_id: int):
    db.execute("DELETE FROM albums WHERE id=?", (album_id,))
    return {"ok": True}


@router.post("/albums/{album_id}/items")
def add_items(album_id: int, body: ItemsIn):
    row = db.query_one("SELECT COALESCE(MAX(position), -1) AS p FROM album_items WHERE album_id=?", (album_id,))
    pos = row["p"] + 1
    with db.transaction() as conn:
        for i, fid in enumerate(body.file_ids):
            conn.execute(
                "INSERT OR IGNORE INTO album_items (album_id, file_id, position) VALUES (?,?,?)",
                (album_id, fid, pos + i),
            )
    return {"ok": True}


@router.post("/albums/{album_id}/items/remove")
def remove_items(album_id: int, body: ItemsIn):
    with db.transaction() as conn:
        for fid in body.file_ids:
            conn.execute("DELETE FROM album_items WHERE album_id=? AND file_id=?", (album_id, fid))
    return {"ok": True}


@router.post("/albums/{album_id}/reorder")
def reorder(album_id: int, body: ItemsIn):
    with db.transaction() as conn:
        for i, fid in enumerate(body.file_ids):
            conn.execute("UPDATE album_items SET position=? WHERE album_id=? AND file_id=?", (i, album_id, fid))
    return {"ok": True}
