import asyncio
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db

router = APIRouter()


def _put_setting(key: str, value: str) -> None:
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


@router.get("/settings")
def get_settings():
    rows = {r["key"]: r["value"] for r in db.query("SELECT key, value FROM settings")}
    return {
        "auto_scan": rows.get("auto_scan", "1") == "1",
        "auto_scan_minutes": int(rows.get("auto_scan_minutes", "30")),
    }


class SettingsIn(BaseModel):
    auto_scan: bool | None = None
    auto_scan_minutes: int | None = None


@router.post("/settings")
def set_settings(body: SettingsIn):
    if body.auto_scan is not None:
        _put_setting("auto_scan", "1" if body.auto_scan else "0")
    if body.auto_scan_minutes is not None:
        _put_setting("auto_scan_minutes", str(max(5, min(1440, body.auto_scan_minutes))))
    return get_settings()


@router.post("/autoscan/run")
def autoscan_now():
    """Check every online root for new files right now."""
    from ..jobs import pipeline
    from ..jobs.runner import manager

    if manager.any_running():
        raise HTTPException(409, "jobs are already running")
    asyncio.run_coroutine_threadsafe(pipeline.auto_scan_once(), manager.loop)
    return {"ok": True}


@router.post("/models/download")
def download_models():
    """Fetch the face-recognition models (~280 MB). The desktop app has no CLI,
    so this endpoint is the only way to enable People there."""
    from ..jobs import models as models_job
    from ..jobs.runner import manager

    if manager.any_running("models"):
        raise HTTPException(409, "model download already running")
    if all((config.FACE_MODEL_DIR / n).exists() for n in models_job.NEEDED):
        return {"ok": True, "already_present": True}
    job_id = manager.create("models")
    manager.start(job_id, models_job.run_model_download(job_id))
    return {"job_id": job_id}


def _app_version() -> str:
    """Version of the server that is actually running — not a build-time
    constant baked into the UI, so it stays truthful after an in-app update."""
    try:
        from importlib.metadata import version

        return version("smriti-photos")
    except Exception:
        pass
    try:  # source checkout: the package isn't installed
        import tomllib

        pyproject = config.PROJECT_ROOT / "pyproject.toml"
        return tomllib.loads(pyproject.read_text())["project"]["version"] + "-dev"
    except Exception:
        return "dev"


_VERSION = _app_version()


@router.get("/health")
def health():
    return {"ok": True, "version": _VERSION}


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
              db.query("SELECT media_type, COUNT(*) n FROM files WHERE status='active' "
                       "AND id NOT IN (SELECT file_id FROM locked_items) GROUP BY media_type")}
    return {
        "photos": counts.get("photo", 0),
        "videos": counts.get("video", 0),
        "missing": db.query_one("SELECT COUNT(*) n FROM files WHERE status='missing'")["n"],
        "with_gps": db.query_one("SELECT COUNT(*) n FROM metadata WHERE gps_lat IS NOT NULL")["n"],
        "geocoded": db.query_one("SELECT COUNT(*) n FROM file_places")["n"],
        "faces": db.query_one("SELECT COUNT(*) n FROM faces")["n"],
        "persons": db.query_one("SELECT COUNT(*) n FROM persons WHERE name IS NOT NULL")["n"],
        # People the People page will actually show. `persons` above counts only
        # NAMED people, so it is 0 on a library full of unnamed clusters — and
        # faces alone prove nothing, since a face only becomes a person once
        # FACE_MIN_CLUSTER_SIZE of them cluster together. Anything that offers
        # to send someone to People has to ask this, or it promises an empty page.
        "people_visible": db.query_one(
            "SELECT COUNT(*) n FROM persons p WHERE p.is_hidden=0 AND EXISTS ("
            " SELECT 1 FROM faces fa JOIN files f ON f.id=fa.file_id "
            " WHERE fa.person_id=p.id AND f.status='active' "
            " AND f.id NOT IN (SELECT file_id FROM locked_items))")["n"],
        "face_pending": db.query_one(
            "SELECT COUNT(*) n FROM files WHERE status='active' AND media_type='photo' AND face_scanned=0")["n"],
        "db_bytes": os.path.getsize(config.DB_PATH) if config.DB_PATH.exists() else 0,
        "thumbs_bytes": _dir_size(config.THUMBS_DIR),
        "previews_bytes": _dir_size(config.PREVIEWS_DIR),
        "face_model_ready": (config.FACE_MODEL_DIR / "det_10g.onnx").exists()
                            and (config.FACE_MODEL_DIR / "w600k_r50.onnx").exists(),
    }
