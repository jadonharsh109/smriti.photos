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
# Face crops are drawn as the round cover on a People card, which is ~300 CSS px
# at a wide window — 600 device px on a Retina screen. They were capped at 256
# and visibly soft because of it. `FACE_CROP_VER` is part of the filename, so
# raising either one leaves existing crops in place and regenerates on demand.
FACE_CROP_DIM = 512
FACE_CROP_WEBP_QUALITY = 86
FACE_CROP_VER = 2
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

# ---- semantic search (MobileCLIP-S0) ----------------------------------------
# Apple's MobileCLIP rather than OpenAI's CLIP ViT-B/32: better zero-shot at
# roughly an eighth of the vision compute, which is the number that matters
# when every photo in a library gets encoded on a CPU. fp32 on purpose — the
# CPU execution provider handles fp16 badly, and the model's own config pins
# its vision tower to fp32.
#
# CLIP_MODEL is written into every row it produces, so changing the model here
# invalidates old embeddings rather than silently comparing vectors from two
# different spaces — which would not error, it would just quietly rank wrong.
CLIP_MODEL = "mobileclip_s0"
CLIP_MODEL_DIR = MODELS_DIR / CLIP_MODEL
CLIP_DIM = 512
# MobileCLIP resizes the short edge to 256 and centre-crops, and — unlike every
# OpenAI CLIP — does NOT apply the CLIP mean/std afterwards. Its preprocessor
# says do_normalize: false, so pixels reach it as plain 0..1. Normalising them
# "correctly" here would cost most of the accuracy without failing anywhere.
CLIP_IMAGE_SIZE = 256
CLIP_CONTEXT_LEN = 77
CLIP_MAX_WORKERS = 2
# Where to stop calling something a result. CLIP scores everything, so without
# a cutoff a search returns the whole library ranked — the first screen right
# and the rest confidently wrong, which reads as the search being broken.
#
# Measured on a real library: genuine matches top out around 0.23-0.30 and
# fall to noise by about rank 50, while the median photo sits near 0.10. A
# query for something the library does not contain at all peaks below 0.20 —
# so that is the floor, and it is what lets "nothing looks like that" be an
# answer rather than 200 wrong photos.
#
# The proportional cutoff does the rest: a query only keeps what scores within
# a fraction of its own best hit, so a strong, specific query stays tight and
# a broad one ("a group of friends", true of a hundred photos) stays wide.
CLIP_MIN_SCORE = 0.20
CLIP_REL_CUTOFF = 0.80

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
