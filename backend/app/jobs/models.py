"""Face-model download as a real job. The desktop app has no CLI, so this is
the only way to enable People there — progress rides the existing jobs table +
SSE stream, so the UI needs no new plumbing."""
import asyncio
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from .. import config
from ..fetch_models import NEEDED, URL
from .runner import manager


class _Cancelled(Exception):
    """Raised out of the progress hook to abort urlretrieve."""


def _download(job_id: int, dest: Path) -> None:
    """Blocking download + extract; runs in a worker thread."""
    zip_path = dest / "buffalo_l.zip"
    last = 0.0

    def hook(blocks: int, bs: int, total: int) -> None:
        nonlocal last
        if manager.is_cancelled(job_id):
            raise _Cancelled()
        if total <= 0:
            return
        now = time.monotonic()
        if now - last < 0.5:  # same publish throttle the scan jobs use
            return
        last = now
        done = min(blocks * bs, total)
        manager.update(job_id, total=total, done=done,
                       message=f"downloading… {done // 1048576} of {total // 1048576} MB")

    try:
        urllib.request.urlretrieve(URL, zip_path, reporthook=hook)
        manager.update(job_id, message="extracting…")
        with zipfile.ZipFile(zip_path) as z:
            for info in z.infolist():
                name = Path(info.filename).name
                if name not in NEEDED:
                    continue
                tmp = dest / f"{name}.part"
                # stream it — the 174 MB recognition model must not land in RAM
                with z.open(info) as src, open(tmp, "wb") as out:
                    while chunk := src.read(1 << 20):
                        out.write(chunk)
                tmp.replace(dest / name)
    finally:
        zip_path.unlink(missing_ok=True)  # never leave a 280 MB partial behind


async def run_model_download(job_id: int) -> None:
    dest = config.FACE_MODEL_DIR
    dest.mkdir(parents=True, exist_ok=True)
    if all((dest / n).exists() for n in NEEDED):
        manager.finish(job_id, "done", "models already downloaded")
        return

    manager.update(job_id, message="contacting github.com…")
    try:
        await asyncio.to_thread(_download, job_id, dest)
    except _Cancelled:
        for n in NEEDED:
            (dest / n).unlink(missing_ok=True)
        manager.finish(job_id, "cancelled", "download cancelled")
        return
    except (urllib.error.URLError, OSError, zipfile.BadZipFile) as e:
        manager.finish(job_id, "failed", f"download failed: {type(e).__name__}: {e}")
        return

    missing = [n for n in NEEDED if not (dest / n).exists()]
    if missing:
        manager.finish(job_id, "failed", f"incomplete download — missing {', '.join(missing)}")
        return
    manager.finish(job_id, "done", "face models ready — scan for faces to build People")
