"""Importing a Google Takeout export.

Extraction is the easy half — measured at ~1.2 GB/s, it is never the thing the
user waits for. The parts worth being careful about are the ones that lose data
if they are wrong:

  * **Free space.** A Takeout is downloaded as zips and then extracted beside
    them, so the import needs roughly its own size again. Running out halfway
    through leaves a half-imported folder, so the check happens before anything
    is written and refuses rather than truncates.
  * **Resume.** A 100 GB import that dies at 80% must not start over, so a file
    that is already on disk at its full size is left alone.
  * **Never a partial file.** Everything is written to a temporary name and
    renamed into place, so an interrupted import leaves whole files or nothing.

The import stops once the bytes are on disk. It does not index anything and it
does not touch the library: healing a Takeout export and deciding to live with
those photos are two different decisions, and only the first one is being asked
for here. The result is an ordinary folder of ordinary photos, which the user
can add through the normal "add a folder" path whenever they want — or never.

Albums are the one thing that has to wait: they need file ids, which only exist
after a scan. So they are recorded now and applied by `apply_pending_albums`
after whichever scan eventually covers them.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import zipfile
from pathlib import Path

from .. import db
from ..services import takeout as tk
from ..services import volumes as vol_svc
from .runner import manager

SPACE_MARGIN = 1.02   # a little headroom for directory entries and rounding


def _record(dest: Path, archives: list[str], plans: list[tk.Plan]) -> int:
    """Persist the import and its album membership before extraction starts.

    Written up front on purpose: album membership is derived from the archives,
    not from what succeeded, so a cancelled import that is resumed later still
    knows which photos belonged to which album."""
    cur = db.execute(
        "INSERT INTO takeout_imports (dest_path, archives, created_at) VALUES (?,?,?)",
        (str(dest), json.dumps(archives), int(time.time())),
    )
    import_id = cur.lastrowid
    rows = []
    for p in plans:
        for album, path in p.album_paths:
            rows.append((import_id, album.strip(), path.relative_to(dest).as_posix()))
    if rows:
        db.executemany(
            "INSERT OR IGNORE INTO takeout_album_items (import_id, album_name, rel_path) "
            "VALUES (?,?,?)",
            rows,
        )
    return import_id


def _link_or_copy(src: Path, dest: Path) -> None:
    """Second (and third) home for a photo that Takeout duplicated.

    A hardlink keeps the mirrored folder layout honest while storing the bytes
    once. Filesystems that cannot do it — exFAT on an external drive, most
    obviously — get a real copy instead."""
    if dest.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dest)
    except (OSError, NotImplementedError):
        shutil.copy2(src, dest)


def _extract(job_id: int, plans: list[tk.Plan], write_exif: bool) -> dict:
    """The blocking half: runs in a worker thread."""
    zips: dict[str, zipfile.ZipFile] = {}

    def open_zip(path: str) -> zipfile.ZipFile:
        zf = zips.get(path)
        if zf is None:
            zf = zips[path] = zipfile.ZipFile(path)
        return zf

    stats = {"written": 0, "skipped": 0, "linked": 0, "repaired": 0, "errors": 0,
             "bytes": 0, "undated": 0}
    total = len(plans)
    last = 0.0
    try:
        for i, plan in enumerate(plans):
            if manager.is_cancelled(job_id):
                break
            entry = plan.item.entry
            try:
                zf = open_zip(entry.archive)

                plan.dest.parent.mkdir(parents=True, exist_ok=True)
                # Already there at full size? A repaired file is slightly larger
                # than the archived one, never smaller, so this is safe to skip.
                fresh = True
                if plan.dest.exists() and plan.dest.stat().st_size >= entry.size:
                    stats["skipped"] += 1
                    fresh = False
                else:
                    tmp = plan.dest.with_name(plan.dest.name + ".part")
                    with zf.open(entry.key) as src, open(tmp, "wb") as out:
                        while chunk := src.read(1 << 20):
                            out.write(chunk)
                    os.replace(tmp, plan.dest)
                    stats["written"] += 1
                    stats["bytes"] += entry.size

                # A file already on disk is still re-examined when metadata for
                # it exists: importing the rest of an export later is exactly
                # how a photo that arrived without a date finally gets one.
                # `repair` fills only absent fields, so this is idempotent.
                if fresh or plan.item.sidecar is not None:
                    sidecar = tk.read_sidecar(plan.item.sidecar, open_zip)
                    wrote, stamp = tk.repair(plan.dest, sidecar, write_exif)
                    if wrote:
                        stats["repaired"] += 1
                    if stamp is None:
                        stats["undated"] += 1

                for link in plan.links:
                    _link_or_copy(plan.dest, link)
                    stats["linked"] += 1
            except Exception:
                stats["errors"] += 1
                try:
                    plan.dest.with_name(plan.dest.name + ".part").unlink(missing_ok=True)
                except OSError:
                    pass

            now = time.monotonic()
            if now - last >= 0.5:      # the publish throttle every job uses
                last = now
                manager.update(job_id, total=total, done=i + 1, errors=stats["errors"],
                               message=f"{stats['written']:,} copied · {stats['repaired']:,} dates restored")
    finally:
        for zf in zips.values():
            try:
                zf.close()
            except Exception:
                pass
    return stats


def apply_albums(import_id: int) -> int:
    """Turn the Takeout album folders into real Smriti albums.

    Runs after the scan, because until then the photos have no file ids. An
    album that already exists is added to rather than duplicated, so importing
    the remaining parts of an export later extends the same albums."""
    row = db.query_one("SELECT * FROM takeout_imports WHERE id=?", (import_id,))
    if not row:
        return 0
    dest = row["dest_path"]
    try:
        volume_id, _, root_rel = vol_svc.volume_for_path(dest)
    except ValueError:
        return 0

    items = db.query(
        "SELECT album_name, rel_path FROM takeout_album_items WHERE import_id=? ORDER BY album_name, rel_path",
        (import_id,),
    )
    by_album: dict[str, list[str]] = {}
    for it in items:
        rel = f"{root_rel}/{it['rel_path']}" if root_rel else it["rel_path"]
        by_album.setdefault(it["album_name"], []).append(rel)

    made = 0
    for name, rels in by_album.items():
        file_ids = []
        for i in range(0, len(rels), 400):
            chunk = rels[i:i + 400]
            marks = ",".join("?" * len(chunk))
            file_ids += [r["id"] for r in db.query(
                f"SELECT id FROM files WHERE volume_id=? AND rel_path IN ({marks})",
                (volume_id, *chunk))]
        if not file_ids:
            continue
        existing = db.query_one("SELECT id FROM albums WHERE name=?", (name,))
        album_id = existing["id"] if existing else db.execute(
            "INSERT INTO albums (name, created_at) VALUES (?,?)", (name, int(time.time()))
        ).lastrowid
        start = db.query_one(
            "SELECT COALESCE(MAX(position), -1) AS p FROM album_items WHERE album_id=?", (album_id,)
        )["p"] + 1
        db.executemany(
            "INSERT OR IGNORE INTO album_items (album_id, file_id, position) VALUES (?,?,?)",
            [(album_id, fid, start + n) for n, fid in enumerate(file_ids)],
        )
        made += 1
    if made:
        db.execute("UPDATE takeout_imports SET albums_applied=1 WHERE id=?", (import_id,))
    return made


def apply_pending_albums() -> int:
    """Give any finished import its albums, once its photos have file ids.

    Called after every scan. Until the user adds the imported folder there is
    nothing to match, so this finds nothing and costs one indexed query; the
    moment they do add it, the albums appear without them asking."""
    total = 0
    for row in db.query(
        "SELECT id FROM takeout_imports WHERE albums_applied=0 AND finished_at IS NOT NULL"
    ):
        try:
            total += apply_albums(row["id"])
        except Exception:  # noqa: BLE001 - never fail a scan over this
            pass
    return total


async def run_import(job_id: int, archives: list[str], destination: str,
                     write_exif: bool = True) -> None:
    manager.update(job_id, message="reading the archives…")
    man = await asyncio.to_thread(tk.scan_archives, archives)
    if man.unreadable:
        manager.finish(job_id, "failed", "could not read: " + "; ".join(man.unreadable))
        return
    if not man.items:
        manager.finish(job_id, "failed",
                       "no photos or videos found in those files — are they Google Photos takeouts?")
        return

    dest_root = Path(destination).expanduser() / tk.safe_component(man.photos_root)
    try:
        dest_root.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        manager.finish(job_id, "failed", f"cannot write to {destination}: {e}")
        return

    free = shutil.disk_usage(dest_root).free
    need = int(man.unique_bytes * SPACE_MARGIN)
    if free < need:
        manager.finish(job_id, "failed",
                       f"not enough free space — this import needs {need / 1e9:.1f} GB "
                       f"and the disk has {free / 1e9:.1f} GB")
        return

    plans = await asyncio.to_thread(tk.plan_extraction, man, dest_root)
    import_id = _record(dest_root, archives, plans)
    manager.update(job_id, total=len(plans), done=0,
                   message=f"copying {len(plans):,} photos and videos…")

    stats = await asyncio.to_thread(_extract, job_id, plans, write_exif)
    manager.update(job_id, done=len(plans), errors=stats["errors"])

    if manager.is_cancelled(job_id):
        manager.finish(job_id, "cancelled",
                       f"stopped after {stats['written']:,} files — run the import again to carry on")
        return

    written = stats["written"] + stats["skipped"]
    db.execute("UPDATE takeout_imports SET finished_at=? WHERE id=?",
               (int(time.time()), import_id))

    summary = (f"{written:,} photos and videos ready in {dest_root.name}"
               + (f" · {stats['repaired']:,} dates restored" if stats["repaired"] else "")
               + (f" · {stats['linked']:,} album copies linked" if stats["linked"] else "")
               + (f" · {stats['errors']:,} failed" if stats["errors"] else "")
               # Worth saying out loud: these are the photos whose metadata is
               # in a part of the export that was not selected.
               + (f" · {stats['undated']:,} still without a date"
                  if stats["undated"] else ""))
    # Deliberately the end of the road: nothing is indexed and no folder is
    # watched until the user says so.
    manager.finish(job_id, "done", summary)
