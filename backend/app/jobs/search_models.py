"""CLIP model download as a real job, so the desktop app — which has no CLI —
can enable search. Progress rides the existing jobs table and SSE stream.

Three files rather than the face pack's one zip, so the progress bar is scaled
across the whole set: a bar that fills, resets, and fills again reads as a
retry rather than as the second of three files.
"""
import asyncio
import time
import urllib.error
import urllib.request

from .. import config
from ..fetch_clip import FILES, NEEDED, TOTAL_MB
from .runner import manager


class _Cancelled(Exception):
    """Raised out of the progress hook to abort urlretrieve."""


def _download(job_id: int) -> None:
    """Blocking download; runs in a worker thread."""
    dest = config.CLIP_MODEL_DIR
    dest.mkdir(parents=True, exist_ok=True)
    total_bytes = TOTAL_MB * 1048576
    before = 0
    last = 0.0
    for name, (url, mb, what) in FILES.items():
        if (dest / name).exists():
            before += mb * 1048576
            continue

        def hook(blocks: int, bs: int, total: int, _before=before, _what=what) -> None:
            nonlocal last
            if manager.is_cancelled(job_id):
                raise _Cancelled()
            now = time.monotonic()
            if now - last < 0.5:
                return
            last = now
            done = _before + blocks * bs
            manager.update(job_id, total=total_bytes, done=min(done, total_bytes),
                           message=f"downloading the {_what}… "
                                   f"{done // 1048576} of {TOTAL_MB} MB")

        # .part first: a truncated .onnx looks complete to everything except
        # onnxruntime, which fails with a protobuf error naming no cause.
        tmp = dest / f"{name}.part"
        try:
            urllib.request.urlretrieve(url, tmp, reporthook=hook)
            tmp.replace(dest / name)
        finally:
            tmp.unlink(missing_ok=True)
        before += mb * 1048576


async def run_download(job_id: int) -> None:
    dest = config.CLIP_MODEL_DIR
    if all((dest / n).exists() for n in NEEDED):
        manager.finish(job_id, "done", "the search model is already downloaded")
        return

    manager.update(job_id, message="contacting huggingface.co…")
    try:
        await asyncio.to_thread(_download, job_id)
    except _Cancelled:
        for n in NEEDED:
            (dest / n).unlink(missing_ok=True)
        manager.finish(job_id, "cancelled", "download cancelled")
        return
    except (urllib.error.URLError, OSError) as e:
        manager.finish(job_id, "failed", f"download failed: {type(e).__name__}: {e}")
        return

    missing = [n for n in NEEDED if not (dest / n).exists()]
    if missing:
        manager.finish(job_id, "failed", f"incomplete download — missing {', '.join(missing)}")
        return
    manager.finish(job_id, "done", "search model ready — build the index to start searching")
