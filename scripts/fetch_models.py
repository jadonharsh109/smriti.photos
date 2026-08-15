"""One-time download of the InsightFace buffalo_l model pack (~280 MB) into
data/models/buffalo_l/. This is the ONLY network access the app ever needs
(besides pip/npm at setup) — everything at runtime is offline."""
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import config  # noqa: E402

URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
NEEDED = ("det_10g.onnx", "w600k_r50.onnx")


def main() -> None:
    dest = config.FACE_MODEL_DIR
    dest.mkdir(parents=True, exist_ok=True)
    if all((dest / n).exists() for n in NEEDED):
        print(f"models already present in {dest}")
        return
    zip_path = dest / "buffalo_l.zip"
    print(f"downloading {URL} …")

    def hook(blocks, bs, total):
        done = blocks * bs
        if total > 0:
            pct = min(100, done * 100 // total)
            print(f"\r  {done // 1024 // 1024} MB / {total // 1024 // 1024} MB ({pct}%)", end="", flush=True)

    urllib.request.urlretrieve(URL, zip_path, reporthook=hook)
    print("\nextracting…")
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = Path(info.filename).name
            if name in NEEDED:
                with z.open(info) as src, open(dest / name, "wb") as out:
                    out.write(src.read())
    zip_path.unlink()
    missing = [n for n in NEEDED if not (dest / n).exists()]
    if missing:
        raise SystemExit(f"missing after extract: {missing}")
    print(f"done — models in {dest}")


if __name__ == "__main__":
    main()
