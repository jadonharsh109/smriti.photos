#!/usr/bin/env python3
"""How many people have actually downloaded Smriti.

Counts installers only — the .dmg, the .zip and the Windows setup.exe. The rest
of a release is the app talking to itself: latest.json is the updater checking
on every launch, Smriti.app.tar.gz is the payload it then pulls. Those run
several times higher and measure installs that already exist, so counting them
would flatter the number rather than report it.

    python scripts/downloads.py           # totals
    python scripts/downloads.py --by-tag  # and a breakdown per release
"""
import json
import re
import sys
import urllib.request

REPO = "jadonharsh109/smriti.photos"
API = f"https://api.github.com/repos/{REPO}/releases?per_page=100"
IS_INSTALLER = re.compile(r"(\.dmg|-aarch64\.zip|setup\.exe)$")


def main() -> int:
    req = urllib.request.Request(API, headers={"User-Agent": "smriti-downloads"})
    with urllib.request.urlopen(req, timeout=30) as r:
        releases = json.load(r)

    mac = win = updater = wheel = 0
    per_tag = {}
    for rel in releases:
        tag_total = 0
        for a in rel.get("assets", []):
            n, c = a["name"], a["download_count"]
            if n.endswith(".dmg") or n.endswith("-aarch64.zip"):
                mac += c; tag_total += c
            elif n.endswith("setup.exe"):
                win += c; tag_total += c
            elif n in ("latest.json",) or n == "Smriti.app.tar.gz":
                updater += c
            elif n.endswith(".whl") or n.endswith(".tar.gz"):
                wheel += c
        if tag_total:
            per_tag[rel["tag_name"]] = tag_total

    print(f"  macOS installers    {mac:>6}")
    print(f"  Windows installers  {win:>6}")
    print(f"  {'people (total)':<19} {mac + win:>6}")
    print()
    print(f"  python wheel/sdist  {wheel:>6}")
    print(f"  updater traffic     {updater:>6}   (the app checking and updating itself, not people)")

    if "--by-tag" in sys.argv and per_tag:
        print("\n  installers by release:")
        for tag, c in sorted(per_tag.items(), key=lambda kv: -kv[1]):
            print(f"    {tag:<10} {c:>4}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
