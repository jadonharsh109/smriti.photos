#!/usr/bin/env python3
"""Prove the embedded runtime actually works. Run it WITH THE BUNDLED
INTERPRETER, ideally from inside an assembled (and signed) bundle:

    Smriti.app/Contents/Resources/runtime/bin/python3.12 verify_runtime.py

This is the highest-value test in the packaging pipeline: it exercises library
validation, nested-dylib resolution and ProcessPoolExecutor spawn semantics
with no UI in the way. If this passes signed + hardened, most of the packaging
risk is gone.

Every check prints PASS/FAIL/SKIP; exit code is the number of failures.
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

RESULTS: list[tuple[str, str, str]] = []


def check(name: str):
    """Decorator: run a check, record PASS/FAIL/SKIP from its return value."""
    def wrap(fn):
        try:
            detail = fn()
            RESULTS.append(("SKIP" if detail and detail.startswith("skip:") else "PASS",
                            name, detail or ""))
        except Exception as e:
            RESULTS.append(("FAIL", name, f"{type(e).__name__}: {e}"))
            if os.environ.get("VERIFY_TRACE"):
                traceback.print_exc()
        return fn
    return wrap


def mb(n: float) -> str:
    return f"{n / 1048576:.1f} MB"


def main() -> int:
    print(f"\ninterpreter : {sys.executable}")
    print(f"version     : {sys.version.split()[0]}")
    print(f"prefix      : {sys.prefix}\n")

    runtime_root = Path(sys.prefix).resolve()

    # ---- 1. the interpreter is self-contained -------------------------------
    @check("interpreter is relocatable and self-contained")
    def _():
        # sys.path[0] is always this script's own directory — not a runtime leak
        script_dir = Path(__file__).resolve().parent
        strays = [p for p in sys.path
                  if p and Path(p).resolve() != script_dir
                  and not Path(p).resolve().is_relative_to(runtime_root)]
        assert not strays, f"sys.path escapes the runtime: {strays}"
        return f"{len(sys.path)} entries, all inside {runtime_root.name}/"

    # ---- 2. every third-party import ----------------------------------------
    @check("all third-party modules import")
    def _():
        mods = ["fastapi", "uvicorn", "starlette", "sse_starlette", "pydantic",
                "PIL", "pillow_heif", "numpy", "scipy.fftpack", "imagehash",
                "onnxruntime", "reverse_geocoder", "send2trash",
                "sklearn.cluster", "sklearn.decomposition"]
        for m in mods:
            __import__(m)
        import onnxruntime
        import numpy
        return f"{len(mods)} modules · onnxruntime {onnxruntime.__version__} · numpy {numpy.__version__}"

    @check("HEIC decoding is registered")
    def _():
        from pillow_heif import register_heif_opener
        register_heif_opener()
        from PIL import Image
        assert "HEIF" in Image.OPEN or "HEIC" in Image.OPEN, "heif opener not registered"
        return "pillow-heif opener active"

    @check("sklearn HDBSCAN + PCA load (scipy pruning was not too aggressive)")
    def _():
        from sklearn.cluster import HDBSCAN
        from sklearn.decomposition import PCA
        import numpy as np
        X = np.random.RandomState(0).rand(40, 8).astype(np.float32)
        labels = HDBSCAN(min_cluster_size=4).fit_predict(X)
        PCA(n_components=4, random_state=0).fit_transform(X)
        return f"clustered {len(labels)} points"

    # ---- 3. app package layout survived the journey -------------------------
    @check("smriti_server installed-layout branch is taken")
    def _():
        from smriti_server import config
        assert config._IS_REPO is False, "_IS_REPO is True inside the bundle — DATA_DIR would point into the app!"
        return f"_IS_REPO=False · DATA_DIR={config.DATA_DIR}"

    @check("built React UI is present")
    def _():
        from smriti_server import config
        idx = config.FRONTEND_DIST / "index.html"
        assert idx.exists(), f"missing {idx}"
        assets = list((config.FRONTEND_DIST / "assets").glob("*.js"))
        assert assets, "no JS assets"
        return f"{idx.parent.name}/ · {len(assets)} js chunks"

    @check("SQL migrations are real files on disk")
    def _():
        from smriti_server import db
        found = sorted(p.name for p in db.MIGRATIONS_DIR.glob("*.sql"))
        assert "0001_init.sql" in found and "0002_locked.sql" in found, found
        return " ".join(found)

    # ---- 4. offline geocoder ------------------------------------------------
    @check("reverse_geocoder dataset is bundled (no GeoNames download)")
    def _():
        import reverse_geocoder as rg
        csv = Path(rg.__file__).parent / "rg_cities1000.csv"
        assert csv.exists(), "rg_cities1000.csv was pruned — the app would silently download it into CWD"
        return f"rg_cities1000.csv {mb(csv.stat().st_size)}"

    @check("offline reverse geocoding resolves a real coordinate")
    def _():
        import reverse_geocoder as rg
        got = rg.search([(28.6139, 77.2090)], mode=1)[0]
        assert got.get("cc") == "IN", got
        return f"28.61,77.21 -> {got.get('name')}, {got.get('admin1')} ({got['cc']})"

    # ---- 5. bundled tools ---------------------------------------------------
    @check("ffmpeg/ffprobe resolve and run")
    def _():
        import subprocess
        from smriti_server import config
        for tool in (config.FFPROBE, config.FFMPEG):
            if not os.path.isabs(tool):
                return f"skip: {tool} not absolute (no bundled ffmpeg yet)"
            r = subprocess.run([tool, "-version"], capture_output=True, timeout=30)
            assert r.returncode == 0, f"{tool} exited {r.returncode}"
        return f"{Path(config.FFMPEG).name}, {Path(config.FFPROBE).name} OK"

    @check("send2trash resolves its platform backend")
    def _():
        from send2trash import send2trash as fn
        impl = fn.__module__
        if sys.platform == "darwin":
            import ctypes.util
            for fw in ("CoreServices", "Foundation"):
                assert ctypes.util.find_library(fw), f"cannot locate {fw}"
        return f"backend={impl}"

    # ---- 6. THE risk: ProcessPoolExecutor + spawn ---------------------------
    @check("ProcessPoolExecutor spawns workers and indexes a photo")
    def _():
        import tempfile
        from concurrent.futures import ProcessPoolExecutor
        from PIL import Image
        from smriti_server import workers
        from smriti_server.workers import image_worker

        tmp = Path(tempfile.mkdtemp(prefix="smriti-verify-"))
        srcs = []
        for i in range(4):
            p = tmp / f"p{i}.jpg"
            Image.new("RGB", (900, 600), (30 * i, 90, 160)).save(p, quality=88)
            srcs.append(p)

        with ProcessPoolExecutor(max_workers=4, initializer=workers.pool_init,
                                 initargs=(512, 75)) as pool:
            out = list(pool.map(image_worker.process,
                                range(len(srcs)), [str(s) for s in srcs],
                                [str(tmp / f"t{i}.webp") for i in range(len(srcs))]))
        bad = [r for r in out if not r.get("ok")]
        assert not bad, f"worker errors: {bad[:2]}"
        assert all((tmp / f"t{i}.webp").stat().st_size > 100 for i in range(len(srcs)))
        return f"{len(out)} photos through a 4-worker spawn pool, thumbs written"

    @check("onnxruntime face models load inside a spawned worker")
    def _():
        from smriti_server import config
        det = config.FACE_MODEL_DIR / "det_10g.onnx"
        rec = config.FACE_MODEL_DIR / "w600k_r50.onnx"
        if not (det.exists() and rec.exists()):
            return f"skip: models not in {config.FACE_MODEL_DIR}"

        # The risky part is loading two ~190MB ONNX sessions inside a *spawned*
        # interpreter under a signed bundle — not the detection result. So a
        # synthetic image exercises it fine; VERIFY_FACE_IMAGE only upgrades the
        # check to also assert real detections.
        import tempfile
        from concurrent.futures import ProcessPoolExecutor
        from PIL import Image
        from smriti_server.workers import face_worker

        real = os.environ.get("VERIFY_FACE_IMAGE")
        if real and os.path.exists(real):
            img_path, expect_faces = real, True
        else:
            tmp = Path(tempfile.mkdtemp(prefix="smriti-verify-")) / "blank.jpg"
            Image.new("RGB", (900, 700), (120, 120, 130)).save(tmp, quality=85)
            img_path, expect_faces = str(tmp), False

        with ProcessPoolExecutor(
            max_workers=2, initializer=face_worker.pool_init,
            initargs=(str(config.FACE_MODEL_DIR), config.FACE_DET_SIZE, config.FACE_DET_SCORE_MIN),
        ) as pool:
            res = list(pool.map(face_worker.process, [1, 2], [img_path, img_path]))

        bad = [r for r in res if not r.get("ok")]
        assert not bad, f"face worker errors: {bad[:1]}"
        n = len(res[0]["faces"])
        if not expect_faces:
            return f"2 workers each built both ONNX sessions (synthetic image, {n} faces)"
        assert n > 0, "models loaded but detected 0 faces — check the test image"
        dim = len(res[0]["faces"][0]["embedding"]) // 4
        return f"{n} faces detected in 2 spawned workers, {dim}-d embeddings"

    # ---- 7. bytecode is launch-cheap ----------------------------------------
    @check("bytecode precompiled with unchecked-hash")
    def _():
        import importlib.util as iu
        site = Path(iu.find_spec("fastapi").origin).parent
        pycs = list(site.rglob("*.pyc"))
        assert pycs, "no .pyc files — every launch would recompile"
        flags = int.from_bytes(pycs[0].read_bytes()[4:8], "little")
        assert flags & 0b01, f"timestamp-invalidated .pyc (flags={flags:#b}) — recompiles every launch"
        assert not (flags & 0b10), f"checked-hash .pyc (flags={flags:#b}) — still stats the source"
        return f"{len(pycs)} .pyc in fastapi/, flags={flags:#04b} (unchecked-hash)"

    # ---- report -------------------------------------------------------------
    width = max(len(n) for _, n, _ in RESULTS)
    fails = 0
    print("-" * (width + 30))
    for status, name, detail in RESULTS:
        mark = {"PASS": "✓", "FAIL": "✗", "SKIP": "–"}[status]
        print(f" {mark} {name.ljust(width)}  {detail.removeprefix('skip:').strip()}")
        fails += status == "FAIL"
    print("-" * (width + 30))
    passed = sum(1 for s, _, _ in RESULTS if s == "PASS")
    skipped = sum(1 for s, _, _ in RESULTS if s == "SKIP")
    print(f" {passed} passed, {fails} failed, {skipped} skipped\n")
    return fails


if __name__ == "__main__":
    # MUST stay guarded: spawn re-imports __main__ in every worker, so an
    # unguarded body here would fork-bomb the moment the pool starts.
    sys.exit(main())
