"""Drive detection. Volumes are identified by disk UUID (diskutil), not mount
path, so a drive is recognized wherever it mounts."""
import os
import plistlib
import subprocess
from pathlib import Path

from .. import db


def _diskutil_info(mount_path: str) -> dict:
    try:
        out = subprocess.run(
            ["diskutil", "info", "-plist", mount_path],
            capture_output=True, timeout=15,
        )
        if out.returncode != 0:
            return {}
        return plistlib.loads(out.stdout)
    except Exception:
        return {}


def list_mounts() -> list[dict]:
    mounts = [{"mount_path": "/", "label": "Macintosh HD", "internal": True}]
    vol_root = Path("/Volumes")
    if vol_root.is_dir():
        for p in sorted(vol_root.iterdir()):
            if not p.is_dir() or p.name.startswith("."):
                continue
            try:
                if p.resolve() == Path("/"):
                    continue  # the "Macintosh HD" symlink
            except OSError:
                continue
            mounts.append({"mount_path": str(p), "label": p.name, "internal": False})
    return mounts


def refresh_volumes() -> list[dict]:
    """Sync mounted drives with the volumes table; mark unmounted ones offline."""
    mounts = list_mounts()
    online_ids = set()
    result = []
    for m in mounts:
        info = _diskutil_info(m["mount_path"])
        uuid = info.get("VolumeUUID") or f"path:{m['mount_path']}"
        label = info.get("VolumeName") or m["label"]
        row = db.query_one("SELECT * FROM volumes WHERE disk_uuid=?", (uuid,))
        if row:
            db.execute(
                "UPDATE volumes SET label=?, last_mount_path=?, is_online=1 WHERE id=?",
                (label, m["mount_path"], row["id"]),
            )
            vol_id = row["id"]
        else:
            cur = db.execute(
                "INSERT INTO volumes (disk_uuid, label, last_mount_path, is_online) VALUES (?,?,?,1)",
                (uuid, label, m["mount_path"]),
            )
            vol_id = cur.lastrowid
        online_ids.add(vol_id)
        free = total = None
        try:
            st = os.statvfs(m["mount_path"])
            free, total = st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize
        except OSError:
            pass
        result.append({"id": vol_id, "disk_uuid": uuid, "label": label,
                       "mount_path": m["mount_path"], "is_online": True,
                       "internal": m["internal"], "free_bytes": free, "total_bytes": total})
    known = db.query("SELECT id FROM volumes")
    for r in known:
        if r["id"] not in online_ids:
            db.execute("UPDATE volumes SET is_online=0 WHERE id=?", (r["id"],))
    return result


def volume_for_path(path: str) -> tuple[int, str, str]:
    """Map an absolute path -> (volume_id, mount_path, rel_path). Registers the
    volume if needed."""
    path = os.path.abspath(path)
    best = None
    for v in refresh_volumes():
        mp = v["mount_path"]
        if path == mp or path.startswith(mp.rstrip("/") + "/"):
            if best is None or len(mp) > len(best["mount_path"]):
                best = v
    if best is None:
        raise ValueError(f"No mounted volume contains {path}")
    rel = os.path.relpath(path, best["mount_path"])
    if rel == ".":
        rel = ""
    return best["id"], best["mount_path"], rel


def mount_path_for_volume(volume_id: int) -> str | None:
    """Current mount path if the volume is online, else None."""
    row = db.query_one("SELECT * FROM volumes WHERE id=?", (volume_id,))
    if not row or not row["is_online"] or not row["last_mount_path"]:
        return None
    if not os.path.ismount(row["last_mount_path"]) and row["last_mount_path"] != "/":
        db.execute("UPDATE volumes SET is_online=0 WHERE id=?", (volume_id,))
        return None
    return row["last_mount_path"]


def abs_path_for_file(file_row) -> str | None:
    mp = mount_path_for_volume(file_row["volume_id"])
    if mp is None:
        return None
    return os.path.join(mp, file_row["rel_path"])
