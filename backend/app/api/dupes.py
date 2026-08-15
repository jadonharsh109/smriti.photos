import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from .. import config, db
from ..jobs import dupes as dupes_job
from ..jobs.runner import manager
from ..services import volumes as vol_svc
from ..workers import video_worker

router = APIRouter()

ITEM_FIELDS = ("SELECT f.id, f.rel_path, f.filename, f.size_bytes, f.media_type, f.content_hash, "
               "m.width, m.height, m.taken_at FROM files f LEFT JOIN metadata m ON m.file_id=f.id ")


class IdsIn(BaseModel):
    file_ids: list[int]


class DismissIn(BaseModel):
    file_id_a: int
    file_id_b: int


@router.get("/dupes/exact")
def exact():
    groups = []
    rows = db.query(
        "SELECT content_hash, COUNT(*) n FROM files "
        "WHERE status='active' AND content_hash IS NOT NULL "
        "AND id NOT IN (SELECT file_id FROM locked_items) "
        "GROUP BY content_hash HAVING n > 1 ORDER BY n DESC LIMIT 500",
    )
    for r in rows:
        items = db.query(
            ITEM_FIELDS + "WHERE f.content_hash=? AND f.status='active' "
            "AND f.id NOT IN (SELECT file_id FROM locked_items)", (r["content_hash"],))
        items = [dict(i) for i in items]
        best = max(items, key=lambda i: ((i["width"] or 0) * (i["height"] or 0), i["size_bytes"]))
        for i in items:
            i["is_suggested_keeper"] = i["id"] == best["id"]
        groups.append({
            "kind": "video-quick" if r["content_hash"].startswith("q:") else "exact",
            "items": items,
        })
    return groups


@router.get("/dupes/near")
def near():
    groups = []
    for g in db.query("SELECT * FROM dupe_groups WHERE kind='near' ORDER BY id"):
        items = db.query(
            ITEM_FIELDS + "JOIN dupe_group_items dgi ON dgi.file_id=f.id "
            "WHERE dgi.group_id=? AND f.status='active' "
            "AND f.id NOT IN (SELECT file_id FROM locked_items)", (g["id"],),
        )
        keepers = {r["file_id"] for r in db.query(
            "SELECT file_id FROM dupe_group_items WHERE group_id=? AND is_suggested_keeper=1", (g["id"],))}
        items = [dict(i) | {"is_suggested_keeper": i["id"] in keepers} for i in items]
        if len(items) > 1:
            groups.append({"kind": "near", "group_id": g["id"], "items": items})
    return groups


@router.post("/dupes/run")
def run():
    if manager.any_running("neardup"):
        raise HTTPException(409, "near-dup job already running")
    job_id = manager.create("neardup")
    manager.start(job_id, dupes_job.run_near_dupes(job_id))
    return {"job_id": job_id}


@router.post("/dupes/dismiss")
def dismiss(body: DismissIn):
    a, b = sorted((body.file_id_a, body.file_id_b))
    db.execute("INSERT OR IGNORE INTO dupe_dismissals (file_id_a, file_id_b) VALUES (?,?)", (a, b))
    return {"ok": True}


@router.post("/dupes/groups/{group_id}/dismiss")
def dismiss_group(group_id: int):
    ids = [r["file_id"] for r in db.query("SELECT file_id FROM dupe_group_items WHERE group_id=?", (group_id,))]
    with db.transaction() as conn:
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = sorted((ids[i], ids[j]))
                conn.execute("INSERT OR IGNORE INTO dupe_dismissals (file_id_a, file_id_b) VALUES (?,?)", (a, b))
        conn.execute("DELETE FROM dupe_group_items WHERE group_id=?", (group_id,))
        conn.execute("DELETE FROM dupe_groups WHERE id=?", (group_id,))
    return {"ok": True}


@router.post("/dupes/verify")
def verify(body: IdsIn):
    """Confirm quick-hash video candidates by full-file hashing (on demand)."""
    out = {}
    for fid in body.file_ids[:20]:
        row = db.query_one("SELECT * FROM files WHERE id=?", (fid,))
        if not row:
            continue
        abs_path = vol_svc.abs_path_for_file(row)
        if abs_path is None:
            out[fid] = None
            continue
        out[fid] = video_worker.full_hash(abs_path)
    return out


@router.post("/dupes/export")
def export(body: IdsIn):
    """Write the chosen discard paths to a text file — the app never deletes originals."""
    lines = []
    for fid in body.file_ids:
        row = db.query_one(
            "SELECT f.rel_path, v.last_mount_path FROM files f JOIN volumes v ON v.id=f.volume_id WHERE f.id=?",
            (fid,),
        )
        if row and row["last_mount_path"]:
            lines.append(f"{row['last_mount_path'].rstrip('/')}/{row['rel_path']}")
    config.EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = config.EXPORTS_DIR / f"duplicates-{int(time.time())}.txt"
    path.write_text("\n".join(lines) + "\n")
    return PlainTextResponse("\n".join(lines), headers={"X-Export-Path": str(path)})
