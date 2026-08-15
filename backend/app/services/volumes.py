"""Drive detection. Volumes are identified by a stable identity — disk UUID on
macOS (diskutil), the volume GUID on Windows, mount path elsewhere — so a
drive is recognized wherever it mounts. rel_paths are stored POSIX-style
("/" separators) on every platform."""
import os
import shutil
import sys
from pathlib import Path

from .. import db

IS_MACOS = sys.platform == "darwin"
IS_WINDOWS = sys.platform == "win32"


# ---- per-platform: mount enumeration + stable identity ----------------------

if IS_MACOS:
    import plistlib
    import subprocess

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

    def _volume_identity(mount_path: str, fallback_label: str) -> tuple[str, str]:
        info = _diskutil_info(mount_path)
        uuid = info.get("VolumeUUID") or f"path:{mount_path}"
        label = info.get("VolumeName") or fallback_label
        return uuid, label

elif IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    _DRIVE_REMOVABLE, _DRIVE_FIXED = 2, 3

    def list_mounts() -> list[dict]:
        k32 = ctypes.windll.kernel32
        mounts = []
        for drive in os.listdrives():  # e.g. "C:\\"
            dtype = k32.GetDriveTypeW(drive)
            if dtype not in (_DRIVE_REMOVABLE, _DRIVE_FIXED):
                continue  # skip network/optical drives
            mounts.append({
                "mount_path": drive,
                "label": drive.rstrip("\\/"),
                "internal": dtype == _DRIVE_FIXED,
            })
        return mounts

    def _volume_identity(mount_path: str, fallback_label: str) -> tuple[str, str]:
        k32 = ctypes.windll.kernel32
        root = mount_path if mount_path.endswith("\\") else mount_path + "\\"
        uuid = None
        guid_buf = ctypes.create_unicode_buffer(50)
        # volume GUID path: stable across reboots and drive-letter changes
        if k32.GetVolumeNameForVolumeMountPointW(root, guid_buf, 50) and guid_buf.value:
            uuid = guid_buf.value
        label = fallback_label
        name_buf = ctypes.create_unicode_buffer(261)
        serial = wintypes.DWORD()
        if k32.GetVolumeInformationW(root, name_buf, 261, ctypes.byref(serial), None, None, None, 0):
            if name_buf.value:
                label = name_buf.value
            if uuid is None and serial.value:
                uuid = f"serial:{serial.value:08x}"
        return uuid or f"path:{mount_path}", label

else:  # generic POSIX (Linux, …)

    def list_mounts() -> list[dict]:
        mounts = [{"mount_path": "/", "label": "System", "internal": True}]
        user = os.environ.get("USER", "")
        for base in ("/media", f"/media/{user}", f"/run/media/{user}", "/mnt"):
            b = Path(base)
            if not b.is_dir():
                continue
            for p in sorted(b.iterdir()):
                if p.is_dir() and os.path.ismount(p):
                    mounts.append({"mount_path": str(p), "label": p.name, "internal": False})
        return mounts

    def _volume_identity(mount_path: str, fallback_label: str) -> tuple[str, str]:
        return f"path:{mount_path}", fallback_label


# ---- shared logic -----------------------------------------------------------

def refresh_volumes() -> list[dict]:
    """Sync mounted drives with the volumes table; mark unmounted ones offline."""
    mounts = list_mounts()
    online_ids = set()
    result = []
    for m in mounts:
        uuid, label = _volume_identity(m["mount_path"], m["label"])
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
            du = shutil.disk_usage(m["mount_path"])
            free, total = du.free, du.total
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


def _contains(mount_path: str, path: str) -> bool:
    m = os.path.normcase(os.path.abspath(mount_path))
    p = os.path.normcase(os.path.abspath(path))
    if p == m or p == m.rstrip(os.sep):
        return True
    return p.startswith(m if m.endswith(os.sep) else m + os.sep)


def volume_for_path(path: str) -> tuple[int, str, str]:
    """Map an absolute path -> (volume_id, mount_path, rel_path). Registers the
    volume if needed. rel_path always uses "/" separators."""
    path = os.path.abspath(path)
    best = None
    for v in refresh_volumes():
        if _contains(v["mount_path"], path):
            if best is None or len(v["mount_path"]) > len(best["mount_path"]):
                best = v
    if best is None:
        raise ValueError(f"No mounted volume contains {path}")
    rel = os.path.relpath(path, best["mount_path"])
    if rel == ".":
        rel = ""
    return best["id"], best["mount_path"], rel.replace(os.sep, "/")


def mount_path_for_volume(volume_id: int) -> str | None:
    """Current mount path if the volume is online, else None."""
    row = db.query_one("SELECT * FROM volumes WHERE id=?", (volume_id,))
    if not row or not row["is_online"] or not row["last_mount_path"]:
        return None
    mp = row["last_mount_path"]
    is_root = mp == "/" or (len(mp.rstrip("\\/")) == 2 and mp[1] == ":")  # "/" or "C:"
    if not is_root and not os.path.ismount(mp):
        db.execute("UPDATE volumes SET is_online=0 WHERE id=?", (volume_id,))
        return None
    if is_root and not os.path.isdir(mp):
        db.execute("UPDATE volumes SET is_online=0 WHERE id=?", (volume_id,))
        return None
    return mp


def abs_path_for_file(file_row) -> str | None:
    mp = mount_path_for_volume(file_row["volume_id"])
    if mp is None:
        return None
    rel = file_row["rel_path"]
    return os.path.join(mp, *rel.split("/")) if rel else mp
