import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("PHOTOS_DATA_DIR", PROJECT_ROOT / "data"))
DB_PATH = DATA_DIR / "library.db"
THUMBS_DIR = DATA_DIR / "thumbs"
PREVIEWS_DIR = DATA_DIR / "previews"
FACE_CROPS_DIR = DATA_DIR / "facecrops"
MODELS_DIR = DATA_DIR / "models"
EXPORTS_DIR = DATA_DIR / "exports"
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"

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

FACE_MODEL_DIR = MODELS_DIR / "buffalo_l"
FACE_DET_SIZE = 640
FACE_DET_SCORE_MIN = 0.55
FACE_MATCH_THRESHOLD = 0.45  # cosine sim for incremental person assignment
FACE_MIN_CLUSTER_SIZE = 4
FACE_MAX_WORKERS = 2

PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mts", ".m2ts", ".3gp", ".wmv"}

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def ensure_dirs() -> None:
    for d in (DATA_DIR, THUMBS_DIR, PREVIEWS_DIR, FACE_CROPS_DIR, MODELS_DIR, EXPORTS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def shard_path(base: Path, file_id: int, suffix: str = ".webp") -> Path:
    shard = f"{file_id % 256:02x}"
    d = base / shard
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{file_id}{suffix}"
