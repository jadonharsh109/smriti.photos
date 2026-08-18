"""Google Takeout import: look before you leap, then heal.

`analyze` exists so the import is never a surprise. It reads only the archives'
central directories — a fraction of a second even for tens of gigabytes — and
answers the questions worth answering first: how many photos, how much disk,
which albums, and whether the set of parts looks complete.

An import heals photos into a folder and stops there. Adding that folder to the
library is a separate decision, made through the ordinary "add a folder" path,
which is why nothing here registers a root.
"""
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..jobs import takeout as takeout_job
from ..jobs.runner import manager
from ..services import takeout as tk

router = APIRouter()


class AnalyzeIn(BaseModel):
    archives: list[str]


class ImportIn(BaseModel):
    archives: list[str]
    destination: str
    write_exif: bool = True


def _validate(paths: list[str]) -> list[str]:
    if not paths:
        raise HTTPException(400, "select at least one Takeout .zip")
    out = []
    for p in paths[:200]:
        full = os.path.abspath(os.path.expanduser(p))
        if not os.path.isfile(full):
            raise HTTPException(404, f"no such file: {p}")
        out.append(full)
    return out


@router.post("/takeout/analyze")
def analyze(body: AnalyzeIn):
    """What importing these archives would produce. Reads no media."""
    paths = _validate(body.archives)
    man = tk.scan_archives(paths)

    # Google hands out an export in numbered parts. Metadata whose photo is in
    # a part that was not selected is the strongest available signal that the
    # set is incomplete — and a silent half-import is the worst outcome here.
    incomplete = man.orphan_sidecars > max(20, man.total // 20)
    return {
        "archives": [os.path.basename(p) for p in paths],
        "unreadable": man.unreadable,
        "photos": man.photos,
        "videos": man.videos,
        "total": man.total,
        "bytes": man.unique_bytes,
        "duplicate_paths": man.duplicate_paths,
        "with_metadata": man.paired,
        "orphan_sidecars": man.orphan_sidecars,
        "looks_incomplete": incomplete,
        "photos_root": man.photos_root,
        "albums": [{"name": k.strip(), "count": v}
                   for k, v in sorted(man.albums.items(), key=lambda kv: -kv[1])],
        "year_folders": sorted(k for k in man.containers if k not in man.albums),
    }


@router.post("/takeout/import")
def start_import(body: ImportIn):
    paths = _validate(body.archives)
    dest = os.path.abspath(os.path.expanduser(body.destination))
    if not os.path.isdir(dest):
        raise HTTPException(400, f"not a folder: {body.destination}")
    if not os.access(dest, os.W_OK):
        raise HTTPException(403, f"cannot write to {body.destination}")
    # Importing into a folder that is inside one of the archives' own directory
    # is fine; importing while a scan is running is not — both would write the
    # same rows and the scan would race the files being created under it.
    if manager.any_running("takeout"):
        raise HTTPException(409, "an import is already running")
    if manager.any_running("scan"):
        raise HTTPException(409, "wait for the current scan to finish, then try again")

    job_id = manager.create("takeout")
    manager.start(job_id, takeout_job.run_import(job_id, paths, dest, body.write_exif))
    return {"job_id": job_id}


def _watched_paths() -> list[str]:
    """Absolute paths of every watched folder, from the volumes table rather
    than from the disk — no mount probing, so this stays cheap enough to call
    whenever the library page renders."""
    out = []
    for r in db.query(
        "SELECT r.rel_path, v.last_mount_path FROM roots r JOIN volumes v ON v.id=r.volume_id"
    ):
        mount = r["last_mount_path"]
        if not mount:
            continue
        out.append(os.path.join(mount, *r["rel_path"].split("/")) if r["rel_path"] else mount)
    return out


def _covered(path: str, roots: list[str]) -> bool:
    target = os.path.normcase(os.path.abspath(path))
    for root in roots:
        r = os.path.normcase(os.path.abspath(root))
        if target == r or target.startswith(r.rstrip(os.sep) + os.sep):
            return True
    return False


@router.get("/takeout/imports")
def list_imports():
    """Finished imports, and whether their folder is in the library yet.

    The UI uses this to offer the choice the import deliberately does not make
    on the user's behalf."""
    roots = _watched_paths()
    out = []
    for r in db.query(
        "SELECT i.*, (SELECT COUNT(DISTINCT album_name) FROM takeout_album_items t "
        " WHERE t.import_id=i.id) AS albums "
        "FROM takeout_imports i WHERE i.finished_at IS NOT NULL ORDER BY i.id DESC LIMIT 20"
    ):
        row = dict(r)
        row["in_library"] = _covered(row["dest_path"], roots)
        row["exists"] = os.path.isdir(row["dest_path"])
        out.append(row)
    return out
