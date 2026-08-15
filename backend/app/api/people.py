from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config, db
from ..jobs import faces as faces_job
from ..jobs.runner import manager
from ..services import thumbs
from ..services import volumes as vol_svc

router = APIRouter()


class PersonPatch(BaseModel):
    name: str | None = None
    is_hidden: bool | None = None


class MergeIn(BaseModel):
    from_id: int
    to_id: int


class FaceAssign(BaseModel):
    person_id: int | None


@router.get("/people")
def list_people(include_hidden: bool = False):
    where = "" if include_hidden else "WHERE p.is_hidden=0"
    rows = db.query(
        f"SELECT p.id, p.name, p.is_hidden, "
        # cover: prefer the stored one, but never a face from a locked photo
        "(SELECT fa.id FROM faces fa JOIN files fv ON fv.id=fa.file_id "
        " WHERE fa.person_id=p.id AND fv.status='active' "
        " AND fv.id NOT IN (SELECT file_id FROM locked_items) "
        " ORDER BY (fa.id = p.cover_face_id) DESC, fa.det_score DESC LIMIT 1) AS cover_face_id, "
        "(SELECT COUNT(DISTINCT fa.file_id) FROM faces fa JOIN files f ON f.id=fa.file_id "
        " WHERE fa.person_id=p.id AND f.status='active' "
        " AND f.id NOT IN (SELECT file_id FROM locked_items)) AS photo_count "
        f"FROM persons p {where} ORDER BY photo_count DESC",
    )
    return [dict(r) for r in rows if r["photo_count"] > 0]


@router.get("/people/{person_id}")
def person_detail(person_id: int):
    row = db.query_one("SELECT id, name, is_hidden, cover_face_id FROM persons WHERE id=?", (person_id,))
    if not row:
        raise HTTPException(404, "no such person")
    return dict(row)


@router.patch("/people/{person_id}")
def patch_person(person_id: int, body: PersonPatch):
    if body.name is not None:
        db.execute("UPDATE persons SET name=? WHERE id=?", (body.name.strip() or None, person_id))
    if body.is_hidden is not None:
        db.execute("UPDATE persons SET is_hidden=? WHERE id=?", (1 if body.is_hidden else 0, person_id))
    return {"ok": True}


@router.post("/people/merge")
def merge(body: MergeIn):
    if body.from_id == body.to_id:
        raise HTTPException(400, "cannot merge a person into itself")
    for pid in (body.from_id, body.to_id):
        if not db.query_one("SELECT id FROM persons WHERE id=?", (pid,)):
            raise HTTPException(404, f"no such person {pid}")
    with db.transaction() as conn:
        conn.execute("UPDATE faces SET person_id=? WHERE person_id=?", (body.to_id, body.from_id))
        conn.execute("DELETE FROM persons WHERE id=?", (body.from_id,))
    faces_job.recompute_centroid(body.to_id)
    return {"ok": True}


@router.get("/people/{person_id}/faces")
def person_faces(person_id: int, limit: int = 200):
    rows = db.query(
        "SELECT fa.id, fa.file_id, fa.det_score, fa.assign_src FROM faces fa "
        "JOIN files f ON f.id=fa.file_id WHERE fa.person_id=? AND f.status='active' "
        "AND f.id NOT IN (SELECT file_id FROM locked_items) "
        "ORDER BY fa.det_score DESC LIMIT ?",
        (person_id, limit),
    )
    return [dict(r) for r in rows]


@router.post("/faces/{face_id}/assign")
def assign_face(face_id: int, body: FaceAssign):
    face = db.query_one("SELECT * FROM faces WHERE id=?", (face_id,))
    if not face:
        raise HTTPException(404, "no such face")
    old_person = face["person_id"]
    db.execute("UPDATE faces SET person_id=?, assign_src='manual' WHERE id=?", (body.person_id, face_id))
    for pid in {old_person, body.person_id} - {None}:
        faces_job.recompute_centroid(pid)
    return {"ok": True}


@router.get("/faces/{face_id}/thumb")
def face_thumb(face_id: int, lt: str | None = None):
    from ..services import lock

    face = db.query_one("SELECT * FROM faces WHERE id=?", (face_id,))
    if not face:
        raise HTTPException(404, "no such face")
    if lock.is_locked_file(face["file_id"]) and not lock.check_token(lt):
        raise HTTPException(401, "locked")
    file_row = db.query_one("SELECT * FROM files WHERE id=?", (face["file_id"],))
    abs_path = vol_svc.abs_path_for_file(file_row) if file_row else None
    p = thumbs.ensure_face_crop(face, abs_path)
    if p is None:
        p = thumbs.thumb_path(face["file_id"])
        if not p.exists():
            raise HTTPException(404, "no image available")
    return FileResponse(p, media_type="image/webp",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.post("/faces/scan")
def face_scan():
    if manager.any_running("faces"):
        raise HTTPException(409, "face scan already running")
    if not (config.FACE_MODEL_DIR / "det_10g.onnx").exists():
        raise HTTPException(400, "face models not downloaded — run: uv run python scripts/fetch_models.py")
    job_id = manager.create("faces")
    manager.start(job_id, faces_job.run_face_scan(job_id))
    return {"job_id": job_id}


@router.post("/faces/recluster")
def recluster():
    if manager.any_running("faces") or manager.any_running("recluster"):
        raise HTTPException(409, "a face job is already running")
    job_id = manager.create("recluster")
    manager.start(job_id, faces_job.run_recluster(job_id))
    return {"job_id": job_id}


@router.post("/faces/reset")
def reset_people():
    """Forget every person — names, manual fixes, clusters — and regroup all
    faces from scratch. Detections/embeddings are kept, so no re-scan needed."""
    if manager.any_running("faces") or manager.any_running("recluster"):
        raise HTTPException(409, "a face job is already running")
    with db.transaction() as conn:
        conn.execute("UPDATE faces SET person_id=NULL, assign_src=NULL")
        conn.execute("DELETE FROM persons")
    job_id = manager.create("recluster")
    manager.start(job_id, faces_job.run_recluster(job_id))
    return {"job_id": job_id}
