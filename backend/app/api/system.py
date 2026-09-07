import asyncio
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db
from ..services import aggregates, reveal

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
    try:
        ui = json.loads(rows.get("ui") or "{}")
    except ValueError:
        ui = {}
    return {
        "auto_scan": rows.get("auto_scan", "1") == "1",
        "auto_scan_minutes": int(rows.get("auto_scan_minutes", "30")),
        # How the window looks — theme, accent, sizes. Kept here rather than in
        # the page's localStorage because the desktop app serves the page from
        # an ephemeral port, and a new port is a new origin with empty storage:
        # every launch forgot the thumbnail size.
        "ui": ui if isinstance(ui, dict) else {},
    }


class SettingsIn(BaseModel):
    auto_scan: bool | None = None
    auto_scan_minutes: int | None = None
    ui: dict | None = None


@router.post("/settings")
def set_settings(body: SettingsIn):
    if body.auto_scan is not None:
        _put_setting("auto_scan", "1" if body.auto_scan else "0")
    if body.auto_scan_minutes is not None:
        _put_setting("auto_scan_minutes", str(max(5, min(1440, body.auto_scan_minutes))))
    if body.ui is not None:
        # merge, so a window that only knows some keys cannot erase the rest
        merged = {**get_settings()["ui"], **{k: v for k, v in body.ui.items() if isinstance(k, str)}}
        _put_setting("ui", json.dumps(merged)[:4096])
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
    # `file_manager` is what the host OS calls the thing "Show in …" opens, so
    # the button can name it rather than guessing from the browser's UA — the
    # window opens wherever the server is, not wherever the tab is.
    return {"ok": True, "version": _VERSION, "file_manager": reveal.manager_name()}


@router.get("/stats")
def stats():
    """Library totals, from `library_stats` (services/aggregates.py).

    This used to run ten COUNTs and then walk every cached thumbnail and
    preview on disk — two seconds per 300,000 files, on each of the four pages
    that ask. The counts are now refreshed when a job finishes; the walk runs
    in a thread, at most every few hours."""
    s = aggregates.stats()
    aggregates.refresh_sizes_soon()
    return {
        "photos": s.get("photos", 0),
        "videos": s.get("videos", 0),
        "missing": s.get("missing", 0),
        "with_gps": s.get("with_gps", 0),
        "geocoded": s.get("geocoded", 0),
        "faces": s.get("faces", 0),
        "live": s.get("live", 0),
        # NAMED people; `people_visible` is what the People page will show.
        "persons": s.get("persons", 0),
        "people_visible": s.get("people_visible", 0),
        "face_pending": s.get("face_pending", 0),
        "db_bytes": s.get("db_bytes", 0),
        "thumbs_bytes": s.get("thumbs_bytes", 0),
        "previews_bytes": s.get("previews_bytes", 0),
        "face_model_ready": (config.FACE_MODEL_DIR / "det_10g.onnx").exists()
                            and (config.FACE_MODEL_DIR / "w600k_r50.onnx").exists(),
    }
