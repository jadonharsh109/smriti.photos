import os

from fastapi import APIRouter

from .. import config, db

router = APIRouter()


@router.get("/health")
def health():
    return {"ok": True}


def _dir_size(path) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for f in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


@router.get("/stats")
def stats():
    counts = {r["media_type"]: r["n"] for r in
              db.query("SELECT media_type, COUNT(*) n FROM files WHERE status='active' GROUP BY media_type")}
    return {
        "photos": counts.get("photo", 0),
        "videos": counts.get("video", 0),
        "missing": db.query_one("SELECT COUNT(*) n FROM files WHERE status='missing'")["n"],
        "with_gps": db.query_one("SELECT COUNT(*) n FROM metadata WHERE gps_lat IS NOT NULL")["n"],
        "geocoded": db.query_one("SELECT COUNT(*) n FROM file_places")["n"],
        "faces": db.query_one("SELECT COUNT(*) n FROM faces")["n"],
        "persons": db.query_one("SELECT COUNT(*) n FROM persons WHERE name IS NOT NULL")["n"],
        "face_pending": db.query_one(
            "SELECT COUNT(*) n FROM files WHERE status='active' AND media_type='photo' AND face_scanned=0")["n"],
        "db_bytes": os.path.getsize(config.DB_PATH) if config.DB_PATH.exists() else 0,
        "thumbs_bytes": _dir_size(config.THUMBS_DIR),
        "previews_bytes": _dir_size(config.PREVIEWS_DIR),
        "face_model_ready": (config.FACE_MODEL_DIR / "det_10g.onnx").exists()
                            and (config.FACE_MODEL_DIR / "w600k_r50.onnx").exists(),
    }
