"""Stream a ZIP of original files without ever holding one in memory or on disk.

A selection can easily be tens of gigabytes of photos and video, so the archive
is generated as the response body is consumed: each source file is read in
chunks, written into the zip, and flushed straight out to the client.

Stored, not deflated — JPEG, HEIC and H.264 are already compressed, so
deflating them burns CPU proportional to the library size for roughly nothing.
"""
from __future__ import annotations

import os
import time
import zipfile
from collections.abc import Iterator
from pathlib import PurePath

CHUNK = 1 << 20  # 1 MiB


class _Sink:
    """Minimal writable, non-seekable file object that hands whatever ZipFile
    writes back to the generator. ZipFile needs tell(); when seekable() is
    False it emits data descriptors instead of rewriting local headers."""

    def __init__(self) -> None:
        self._parts: list[bytes] = []
        self._pos = 0

    def write(self, data: bytes) -> int:
        self._parts.append(bytes(data))
        self._pos += len(data)
        return len(data)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:  # noqa: D102 - required by the file protocol
        pass

    def seekable(self) -> bool:
        return False

    def drain(self) -> bytes:
        if not self._parts:
            return b""
        out = b"".join(self._parts)
        self._parts.clear()
        return out


def unique_names(paths: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """(abs_path, preferred_name) -> (abs_path, name unique within the archive).

    Selections routinely span folders that reuse filenames (IMG_0001.jpg in
    2019/ and 2020/), and a zip with duplicate entries extracts unpredictably.
    Disambiguate the way a file manager does, by suffixing a counter.
    """
    seen: dict[str, int] = {}
    out: list[tuple[str, str]] = []
    for abs_path, name in paths:
        key = name.casefold()  # macOS and Windows are case-insensitive
        if key not in seen:
            seen[key] = 1
            out.append((abs_path, name))
            continue
        stem, ext = os.path.splitext(name)
        while True:
            seen[key] += 1
            candidate = f"{stem} ({seen[key]}){ext}"
            if candidate.casefold() not in seen:
                seen[candidate.casefold()] = 1
                out.append((abs_path, candidate))
                break
    return out


def safe_name(name: str) -> str:
    """Strip anything that would let an entry escape the extraction directory
    or break on Windows. Zip-slip protection: the archive is built from our own
    index, but filenames come from the user's disk."""
    name = PurePath(name).name  # drops any directory component, incl. "../"
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    name = name.strip(" .") or "file"
    return name[:200]


def stream_zip(entries: list[tuple[str, str]]) -> Iterator[bytes]:
    """Yield the bytes of a zip containing `entries` as (abs_path, arcname).

    Files that vanish or become unreadable mid-stream are skipped: the archive
    is already streaming, so failing outright would hand the user a truncated
    download with no explanation.
    """
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for abs_path, arcname in entries:
            try:
                st = os.stat(abs_path)
            except OSError:
                continue
            # Carry the source mtime across, otherwise every extracted file
            # lands on ZipInfo's 1980-01-01 default and the export sorts by
            # date as one undifferentiated blob. ZIP has no pre-1980 support,
            # so clamp rather than raise on an absurd timestamp.
            ts = time.localtime(max(st.st_mtime, 315532800))  # 1980-01-01
            info = zipfile.ZipInfo(arcname, date_time=ts[:6])
            info.compress_type = zipfile.ZIP_STORED
            info.file_size = st.st_size
            info.external_attr = (st.st_mode & 0xFFFF) << 16  # keep unix perms
            try:
                with open(abs_path, "rb") as src, zf.open(info, "w") as dest:
                    while chunk := src.read(CHUNK):
                        dest.write(chunk)
                        if data := sink.drain():
                            yield data
            except OSError:
                continue
            if data := sink.drain():
                yield data
    if data := sink.drain():  # central directory
        yield data
