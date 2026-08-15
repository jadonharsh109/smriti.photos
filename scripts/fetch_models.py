"""One-time face-model download (~280 MB). Thin wrapper kept for the README
workflow — the logic lives in the app package (also exposed as `smriti models`)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.fetch_models import download  # noqa: E402

if __name__ == "__main__":
    download()
