import os

from fastapi import APIRouter, HTTPException

from ..services import volumes as vol_svc

router = APIRouter()


@router.get("/volumes")
def volumes():
    return vol_svc.refresh_volumes()


@router.get("/fs/list")
def fs_list(path: str = "/Volumes"):
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        raise HTTPException(404, f"not a directory: {path}")
    entries = []
    media_count = 0
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    if e.is_dir(follow_symlinks=False):
                        entries.append({"name": e.name, "path": e.path})
                    elif e.is_file(follow_symlinks=False):
                        from .. import config

                        ext = os.path.splitext(e.name)[1].lower()
                        if ext in config.PHOTO_EXTS or ext in config.VIDEO_EXTS:
                            media_count += 1
                except OSError:
                    continue
    except PermissionError:
        raise HTTPException(403, f"no permission to read {path}")
    entries.sort(key=lambda x: x["name"].lower())
    parent = os.path.dirname(path) if path != "/" else None
    return {"path": path, "parent": parent, "dirs": entries, "media_count": media_count}
