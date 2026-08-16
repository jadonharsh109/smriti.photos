#!/usr/bin/env python3
"""Fetch the static ffmpeg/ffprobe binaries that ship inside the app.

    python desktop/scripts/fetch_ffmpeg.py --triple aarch64-apple-darwin

Smriti shells out to these (never links them), so they stay separate
executables in Contents/Resources/bin. The app points SMRITI_FFMPEG /
SMRITI_FFPROBE at them — a GUI-launched app inherits launchd's PATH, which has
no Homebrew in it, so bare-name lookup finds nothing.

Prints each binary's --enable-gpl status, because distributing a GPL build
carries source-availability obligations an LGPL build does not.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES_PATH = ROOT / "desktop" / "sources.json"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path, expect: str | None) -> Path:
    if dest.exists() and expect and sha256(dest) == expect:
        print(f"  cached  {dest.name}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetch   {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    # urlretrieve's default User-Agent gets a 403 from some build servers
    req = urllib.request.Request(url, headers={"User-Agent": "smriti-build/1.0"})
    last = 0.0
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            got += len(chunk)
            if total and time.monotonic() - last > 1.0:
                last = time.monotonic()
                print(f"\r          {got // 1048576} / {total // 1048576} MB", end="", flush=True)
    print()
    got = sha256(tmp)
    if expect and got != expect:
        tmp.unlink()
        raise SystemExit(f"sha256 mismatch for {url}\n  expected {expect}\n  got      {got}")
    if not expect:
        print(f"  NOTE    no pinned sha256 — add to sources.json:\n          {got}")
    tmp.replace(dest)
    return dest


def install_macos(cfg: dict, cache: Path, out: Path) -> list[Path]:
    written = []
    for tool in ("ffmpeg", "ffprobe"):
        url = cfg[f"{tool}_url"]
        archive = fetch(url, cache / f"{tool}{''.join(Path(url).suffixes)}", cfg.get(f"{tool}_sha256"))
        target = out / tool
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as z:
                member = next(i for i in z.infolist() if Path(i.filename).name == tool)
                with z.open(member) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        else:  # .gz
            with gzip.open(archive, "rb") as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
        target.chmod(target.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        written.append(target)
    return written


def install_windows(cfg: dict, cache: Path, out: Path) -> list[Path]:
    archive = fetch(cfg["url"], cache / Path(cfg["url"]).name, cfg.get("sha256"))
    # ffplay is a GUI media player we never invoke — 17 MB of dead weight
    skip = {"ffplay.exe"}
    written = []
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            name = Path(info.filename).name
            if name.lower() in skip:
                continue
            # lgpl-shared builds put the av*.dll next to the exes; Windows
            # resolves DLLs from the executable's own directory, so copying
            # them alongside is all that's needed — no PATH manipulation
            if name.lower().endswith((".exe", ".dll")) and "/bin/" in info.filename.replace("\\", "/"):
                target = out / name
                with z.open(info) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                written.append(target)
    return written


def report_license(binaries: list[Path]) -> None:
    """`ffmpeg -version` prints its configure flags — the only reliable way to
    know whether a prebuilt binary is GPL or LGPL."""
    for b in binaries:
        if b.name not in ("ffmpeg", "ffmpeg.exe"):
            continue
        try:
            r = subprocess.run([str(b), "-version"], capture_output=True, timeout=30, text=True)
        except OSError as e:
            print(f"  WARN    could not run {b.name}: {e}")
            return
        out = r.stdout
        gpl = "--enable-gpl" in out
        nonfree = "--enable-nonfree" in out
        ver = out.splitlines()[0] if out else "?"
        print(f"\n  {ver}")
        print(f"  license : {'GPL' if gpl else 'LGPL'}{' + NONFREE (undistributable!)' if nonfree else ''}")
        if gpl:
            print("            GPL build — we invoke it as a separate process, so the app is not")
            print("            derived from it, but shipping the binary still carries GPLv2+")
            print("            source-availability obligations. Prefer an LGPL build.")
        # the only two things the app actually asks ffmpeg to do
        enc = subprocess.run([str(b), "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=30)
        print(f"  mjpeg   : {'present' if 'mjpeg' in enc.stdout else 'MISSING — poster frames would fail'}")


def main() -> None:
    sources = json.loads(SOURCES_PATH.read_text())
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--triple", required=True, choices=list(sources["ffmpeg"]["targets"]))
    ap.add_argument("--out", type=Path, default=ROOT / "desktop" / "src-tauri" / "payload" / "bin")
    ap.add_argument("--cache", type=Path, default=ROOT / "desktop" / ".cache")
    args = ap.parse_args()

    cfg = sources["ffmpeg"]["targets"][args.triple]
    if not any(v for k, v in cfg.items() if k.endswith("url")):
        raise SystemExit(f"no ffmpeg source configured for {args.triple} in {SOURCES_PATH}")

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"\nFetching ffmpeg for {args.triple}")
    written = (install_windows if "windows" in args.triple else install_macos)(cfg, args.cache, args.out)

    report_license(written)
    total = sum(p.stat().st_size for p in written)
    print(f"\n  {len(written)} files, {total / 1048576:.1f} MB -> {args.out}")


if __name__ == "__main__":
    main()
