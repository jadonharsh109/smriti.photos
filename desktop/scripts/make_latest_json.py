#!/usr/bin/env python3
"""Build the `latest.json` manifest the in-app updater polls.

    python desktop/scripts/make_latest_json.py \
        --version 0.1.6 --tag v0.1.6 \
        --repo jadonharsh109/smriti.photos \
        --artifacts staged/ --out latest.json

Scans for Tauri's updater artifacts and their `.sig` files and emits one entry
per platform found. Platforms that did not build are simply absent — the
updater treats a missing platform as "no update available", so a failed
Windows build never offers a Mac user a broken download.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Tauri's platform keys -> how to recognise that platform's update payload.
# The .sig sits next to the artifact, produced by the same signing key.
PLATFORMS = {
    "darwin-aarch64": lambda p: p.name.endswith(".app.tar.gz"),
    "windows-x86_64": lambda p: p.name.endswith("-setup.exe"),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--artifacts", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--notes", default="")
    args = ap.parse_args()

    base = f"https://github.com/{args.repo}/releases/download/{args.tag}"
    files = [p for p in args.artifacts.rglob("*") if p.is_file()]

    platforms: dict[str, dict[str, str]] = {}
    for key, matches in PLATFORMS.items():
        for f in files:
            if not matches(f):
                continue
            sig = f.with_name(f.name + ".sig")
            if not sig.exists():
                print(f"  ! {f.name}: no .sig alongside it — skipping {key}", file=sys.stderr)
                print("    (was TAURI_SIGNING_PRIVATE_KEY set during the build?)", file=sys.stderr)
                continue
            platforms[key] = {
                "signature": sig.read_text().strip(),
                "url": f"{base}/{f.name}",
            }
            print(f"  {key}: {f.name}")
            break
        else:
            print(f"  {key}: not built for this release")

    if not platforms:
        print("no signed updater artifacts found — refusing to write an empty manifest",
              file=sys.stderr)
        return 1

    args.out.write_text(json.dumps({
        "version": args.version,
        "notes": args.notes or f"Smriti {args.version}",
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }, indent=2) + "\n")
    print(f"\nwrote {args.out} ({len(platforms)} platform(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
