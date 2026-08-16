#!/usr/bin/env python3
"""Assemble the embedded CPython runtime that ships inside the desktop app.

Fetches a relocatable python-build-standalone distribution, installs the
smriti wheel into its own site-packages (no venv — venvs bake absolute paths
into pyvenv.cfg and are instantly non-relocatable), prunes what the app never
uses, and precompiles bytecode.

    python desktop/scripts/build_runtime.py \
        --triple aarch64-apple-darwin \
        --wheel dist/smriti_photos-0.1.5-py3-none-any.whl

Deliberately NOT PyInstaller: the app relaunches via `sys.executable`, uses
ProcessPoolExecutor with spawn, globs migrations off disk, and depends on
reverse_geocoder resolving a data file via __file__. All four work with a real
interpreter and break when frozen.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = json.loads((ROOT / "desktop" / "sources.json").read_text())

# Directories under site-packages that are safe to delete wholesale.
# NOTE: only directories literally named tests/test — never modules like
# sklearn.utils._testing or scipy._lib._testutils, which are imported at runtime.
PRUNE_DIR_NAMES = {"tests", "test", "__pycache__"}

# Stdlib packages the app never touches.
PRUNE_STDLIB = [
    "test", "idlelib", "turtledemo", "pydoc_data", "ensurepip",
    "tkinter", "lib2to3", "distutils",
]

# Tcl/Tk ships ~20MB and is only reachable through PIL.ImageTk, which we never import.
PRUNE_GLOBS = [
    "lib/tcl8*", "lib/tk8*", "lib/libtcl8*", "lib/libtk8*", "lib/itcl4*", "lib/thread2*",
    "lib/python3.12/lib-dynload/_tkinter*",
    "lib/pkgconfig", "include",
    "DLLs/tcl8*", "DLLs/tk8*", "DLLs/_tkinter*", "tcl",
]

# Suffixes with no runtime value once wheels are installed.
PRUNE_SUFFIXES = {".pyi", ".pyx", ".pxd", ".a", ".chm"}

# onnxruntime tooling subpackages — not imported by onnxruntime/__init__.py.
# verify_runtime.py asserts the import still works after this.
PRUNE_SITE_PACKAGES = [
    "onnxruntime/transformers", "onnxruntime/quantization", "onnxruntime/tools",
    "onnxruntime/datasets", "onnxruntime/backend",
    "sklearn/datasets/data", "sklearn/datasets/images", "sklearn/datasets/descr",
    "pip", "setuptools", "pkg_resources", "wheel",
]

# Never delete these, whatever the rules above say.
KEEP = [
    "reverse_geocoder/rg_cities1000.csv",   # 7.5MB — this IS the offline geocoder
    "smriti_server/webui",                  # the built React app
    "smriti_server/migrations",             # globbed off disk by db.py
]


def log(msg: str) -> None:
    print(f"  {msg}", flush=True)


def fetch(url: str, dest: Path, sha256: str | None) -> Path:
    if dest.exists() and sha256 and _sha256(dest) == sha256:
        log(f"cached  {dest.name}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"fetch   {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    last = [0.0]

    def hook(blocks: int, bs: int, total: int) -> None:
        if total <= 0 or time.monotonic() - last[0] < 1.0:
            return
        last[0] = time.monotonic()
        print(f"\r          {blocks * bs // 1048576} / {total // 1048576} MB", end="", flush=True)

    urllib.request.urlretrieve(url, tmp, reporthook=hook)
    print()
    got = _sha256(tmp)
    if sha256 and got != sha256:
        tmp.unlink()
        raise SystemExit(f"sha256 mismatch for {url}\n  expected {sha256}\n  got      {got}")
    if not sha256:
        log(f"WARNING: no pinned sha256; got {got}")
    tmp.replace(dest)
    return dest


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def extract_python(archive: Path, out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    log(f"extract {archive.name}")
    with tarfile.open(archive) as tf:
        # archives are rooted at python/ — strip that level
        members = []
        for m in tf.getmembers():
            parts = Path(m.name).parts
            if len(parts) <= 1 or parts[0] != "python":
                continue
            m.name = str(Path(*parts[1:]))
            members.append(m)
        tf.extractall(out, members=members, filter="tar")


def python_exe(runtime: Path, triple: str) -> Path:
    if "windows" in triple:
        return runtime / "python.exe"
    return runtime / "bin" / "python3.12"


# Packages with compiled extensions: these MUST come from prebuilt wheels or the
# build silently tries to compile against the target interpreter (needs a
# toolchain, and cross-target builds would produce the wrong architecture).
# reverse-geocoder is deliberately absent — it is sdist-only on PyPI and pure
# Python, so it builds anywhere. Mirrors the Homebrew formula's --only-binary list.
NATIVE_PACKAGES = [
    "onnxruntime", "numpy", "scipy", "scikit-learn", "pillow", "pillow-heif",
    "pydantic-core", "PyWavelets", "uvloop", "watchfiles", "httptools",
]


def install_wheel(runtime: Path, triple: str, wheel: Path) -> None:
    py = python_exe(runtime, triple)
    log(f"install {wheel.name}")
    uv = shutil.which("uv")
    if uv:
        # uv takes one package per flag; pip takes them comma-separated.
        # --link-mode=copy is NOT optional: uv hardlinks from its global cache by
        # default, and ditto / DMG creation / codesign --force all break hardlinks
        # in confusing ways.
        flags = [a for p in NATIVE_PACKAGES for a in ("--only-binary", p)]
        cmd = [uv, "pip", "install", "--python", str(py), "--no-cache",
               *flags, "--link-mode=copy", str(wheel)]
    else:
        cmd = [str(py), "-m", "pip", "install", "--no-cache-dir",
               "--only-binary", ",".join(NATIVE_PACKAGES), str(wheel)]
    subprocess.run(cmd, check=True)


def _protected(path: Path, site: Path) -> bool:
    try:
        rel = path.relative_to(site).as_posix()
    except ValueError:
        return False
    return any(rel == k or rel.startswith(k + "/") for k in KEEP)


def prune(runtime: Path, triple: str) -> int:
    site = site_packages(runtime, triple)
    freed = 0

    def rm(p: Path) -> None:
        nonlocal freed
        if not p.exists() or _protected(p, site):
            return
        freed += du(p)
        shutil.rmtree(p) if p.is_dir() else p.unlink()

    stdlib = site.parent
    for name in PRUNE_STDLIB:
        rm(stdlib / name)
    for pat in PRUNE_GLOBS:
        for p in runtime.glob(pat):
            rm(p)
    for rel in PRUNE_SITE_PACKAGES:
        rm(site / rel)

    # walk bottom-up so removing a dir doesn't invalidate the walk
    for dirpath, dirnames, filenames in os.walk(runtime, topdown=False):
        d = Path(dirpath)
        for name in list(dirnames):
            if name in PRUNE_DIR_NAMES:
                rm(d / name)
        for name in filenames:
            if Path(name).suffix in PRUNE_SUFFIXES:
                rm(d / name)

    # Console scripts bake an absolute shebang (POSIX) or launcher path
    # (Windows) at install time, so they break the moment the runtime moves.
    # Nothing invokes them — the shell runs `python -c` — so drop them all and
    # keep only the interpreter itself.
    # exact names — a "python" prefix match would keep python3-config, whose
    # baked-in absolute paths are exactly what we are trying to get rid of
    keep_bin = {"python", "python3", "python3.12", "python.exe", "pythonw.exe"}
    for bindir in (runtime / "bin", runtime / "Scripts"):
        if not bindir.is_dir():
            continue
        for p in bindir.iterdir():
            if p.name not in keep_bin:
                rm(p)

    # Pruning can strand symlinks (e.g. python3-config -> python3.12-config).
    # Tauri's resource walker treats a broken link as a hard error, so clear
    # them out — and do it last, after everything else has been removed.
    for dirpath, _, filenames in os.walk(runtime):
        for name in filenames:
            p = Path(dirpath) / name
            if p.is_symlink() and not p.exists():
                p.unlink()
                freed += 0
    return freed


def site_packages(runtime: Path, triple: str) -> Path:
    if "windows" in triple:
        return runtime / "Lib" / "site-packages"
    return runtime / "lib" / "python3.12" / "site-packages"


def compile_bytecode(runtime: Path, triple: str) -> None:
    """unchecked-hash is essential: default timestamp invalidation compares .pyc
    against .py mtimes, and ditto/DMG/NSIS/codesign all perturb them. A mismatch
    makes CPython recompile on every import — and the install dir isn't writable,
    so the recompile is discarded and repeated every launch, forever."""
    py = python_exe(runtime, triple)
    lib = site_packages(runtime, triple).parent
    log("compile bytecode (unchecked-hash)")
    subprocess.run(
        [str(py), "-m", "compileall", "-q", "-j", "0",
         "--invalidation-mode", "unchecked-hash", str(lib)],
        check=False,  # a few stdlib samples always fail to parse; harmless
    )


def du(path: Path) -> int:
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for f in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


def mb(n: int) -> str:
    return f"{n / 1048576:.1f} MB"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--triple", required=True, choices=list(SOURCES["python"]["targets"]))
    ap.add_argument("--wheel", required=True, type=Path)
    ap.add_argument("--out", type=Path,
                    default=ROOT / "desktop" / "src-tauri" / "payload" / "runtime")
    ap.add_argument("--cache", type=Path, default=ROOT / "desktop" / ".cache")
    ap.add_argument("--no-prune", action="store_true", help="skip pruning (debugging)")
    args = ap.parse_args()

    if not args.wheel.exists():
        raise SystemExit(f"wheel not found: {args.wheel}\nBuild it first:  uv build --wheel -o dist")

    spec = SOURCES["python"]
    url = spec["url_template"].format(
        release=spec["release"], version=spec["version"], triple=args.triple)
    archive = args.cache / Path(url).name

    print(f"\nBuilding runtime for {args.triple}")
    fetch(url, archive, spec["targets"][args.triple]["sha256"])
    extract_python(archive, args.out)
    before = du(args.out)
    install_wheel(args.out, args.triple, args.wheel)
    installed = du(args.out)

    freed = 0 if args.no_prune else prune(args.out, args.triple)
    compile_bytecode(args.out, args.triple)
    final = du(args.out)

    (args.out / "BUILD_INFO.json").write_text(json.dumps({
        "triple": args.triple,
        "python": f"{spec['version']}+{spec['release']}",
        "wheel": args.wheel.name,
        "pruned_bytes": freed,
        "final_bytes": final,
    }, indent=2))

    print(f"\n  interpreter   {mb(before)}")
    print(f"  + wheel       {mb(installed)}")
    print(f"  - pruned      {mb(freed)}")
    print(f"  + bytecode    {mb(final - (installed - freed))}")
    print(f"  = final       {mb(final)}")
    print(f"\n  {args.out}")


if __name__ == "__main__":
    main()
