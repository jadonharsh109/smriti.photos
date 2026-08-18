import os
import shutil
import sys
from pathlib import Path

_PKG_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = _PKG_DIR.parents[1]
# running from a source checkout vs. installed into site-packages (brew/pip)
_IS_REPO = (PROJECT_ROOT / "pyproject.toml").exists() and (PROJECT_ROOT / "frontend").exists()


def _default_data_dir() -> Path:
    for env in ("SMRITI_DATA_DIR", "PHOTOS_DATA_DIR"):
        if os.environ.get(env):
            return Path(os.environ[env]).expanduser()
    if _IS_REPO:
        return PROJECT_ROOT / "data"
    return Path.home() / ".smriti"


DATA_DIR = _default_data_dir()
DB_PATH = DATA_DIR / "library.db"
THUMBS_DIR = DATA_DIR / "thumbs"
PREVIEWS_DIR = DATA_DIR / "previews"
FACE_CROPS_DIR = DATA_DIR / "facecrops"
MODELS_DIR = DATA_DIR / "models"
EXPORTS_DIR = DATA_DIR / "exports"
# installed wheels bundle the built frontend inside the package as webui/
FRONTEND_DIST = (PROJECT_ROOT / "frontend" / "dist") if _IS_REPO else (_PKG_DIR / "webui")

THUMB_MAX_DIM = 512          # grid thumbs (2x DPR for ~250px rows)
PREVIEW_MAX_DIM = 1600       # lightbox previews, generated lazily
THUMB_WEBP_QUALITY = 75
PREVIEW_WEBP_QUALITY = 82
PREVIEW_CACHE_MAX_BYTES = 10 * 1024**3   # LRU cap for lazy previews

SCAN_BATCH_SIZE = 200        # rows per DB commit during scans
VIDEO_QUICKHASH_CHUNK = 1024 * 1024

EVENT_GAP_HOURS = 6.0
EVENT_MIN_ITEMS = 3

NEAR_DUP_MAX_HAMMING = 8

# Blur: variance of the Laplacian over the 512px thumbnail. Calibrated against
# a textured test image blurred by known amounts, measured through the same
# 512px WebP the app actually stores:
#     sharp 2890 · slightly soft 1770 · clearly blurry 250 · very blurry 38
# Every tier sits well below "slightly soft", so a sharp photo is never flagged;
# the tiers look identical on a test set with four discrete blur levels and
# spread out on a real library, where sharpness is a continuum.
# Absolute rather than percentile, so a library of uniformly sharp photos
# correctly reports nothing rather than always indicting its worst 5%.
BLUR_CEILINGS = {"gentle": 100.0, "normal": 400.0, "aggressive": 1200.0}

FACE_MODEL_DIR = MODELS_DIR / "buffalo_l"
FACE_DET_SIZE = 640
FACE_DET_SCORE_MIN = 0.55
FACE_MATCH_THRESHOLD = 0.45  # cosine sim for incremental person assignment
FACE_MERGE_SIM = 0.55        # merge clusters this similar (same person split by HDBSCAN);
                             # calibrated: distinct-person centroids sit < 0.3, splits > 0.6
FACE_MIN_CLUSTER_SIZE = 4
FACE_MAX_WORKERS = 2

PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mts", ".m2ts", ".3gp", ".wmv"}

def _tool(name: str) -> str:
    """Absolute path to a bundled/system tool. The desktop app ships its own
    ffmpeg and points SMRITI_FFMPEG/SMRITI_FFPROBE at it — a GUI-launched app
    inherits the launchd/Explorer PATH, which has no Homebrew in it. Falling
    back to which() keeps the CLI/Homebrew install behaving exactly as before."""
    env = os.environ.get(f"SMRITI_{name.upper()}")
    if env:
        return env
    exe = ".exe" if sys.platform == "win32" else ""
    return shutil.which(name) or f"{name}{exe}"


FFMPEG = _tool("ffmpeg")
FFPROBE = _tool("ffprobe")


def ensure_dirs() -> None:
    for d in (DATA_DIR, THUMBS_DIR, PREVIEWS_DIR, FACE_CROPS_DIR, MODELS_DIR, EXPORTS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def shard_path(base: Path, file_id: int, suffix: str = ".webp") -> Path:
    shard = f"{file_id % 256:02x}"
    d = base / shard
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{file_id}{suffix}"
