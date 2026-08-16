#!/usr/bin/env python3
"""Keep the desktop shell's version in step with pyproject.toml.

pyproject.toml is the single source of truth. Cargo.toml is generated from it,
and tauri.conf.json deliberately omits `version` so Tauri falls back to Cargo.

    python desktop/scripts/sync_version.py            # write Cargo.toml
    python desktop/scripts/sync_version.py --check    # verify only, exit 1 on drift
    python desktop/scripts/sync_version.py --expect v0.2.0

`--expect` is what CI uses: it asserts the git tag matches pyproject, so a
mistagged release fails immediately instead of shipping mislabelled artifacts.
"""
from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = ROOT / "pyproject.toml"
CARGO = ROOT / "desktop" / "src-tauri" / "Cargo.toml"


def project_version() -> str:
    return tomllib.loads(PYPROJECT.read_text())["project"]["version"]


def cargo_version(text: str) -> str | None:
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return m.group(1) if m else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="report drift without writing")
    ap.add_argument("--expect", help="git tag that must match (with or without a leading v)")
    args = ap.parse_args()

    version = project_version()

    if args.expect:
        want = args.expect.lstrip("v")
        # NSIS and MSI both require a plain 3-part numeric version
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            print(f"✗ version {version!r} is not X.Y.Z — Windows installers reject prereleases")
            return 1
        if want != version:
            print(f"✗ tag v{want} does not match pyproject.toml version {version}")
            print(f"  bump pyproject.toml to {want}, or retag as v{version}")
            return 1
        print(f"✓ tag matches pyproject.toml: {version}")

    current = cargo_version(CARGO.read_text())
    if current == version:
        print(f"✓ Cargo.toml already at {version}")
        return 0

    if args.check:
        print(f"✗ Cargo.toml is {current}, pyproject.toml is {version}")
        return 1

    text = CARGO.read_text()
    CARGO.write_text(re.sub(r'^version\s*=\s*"[^"]+"',
                            f'version = "{version}"', text, count=1, flags=re.MULTILINE))
    print(f"✓ Cargo.toml {current} -> {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
