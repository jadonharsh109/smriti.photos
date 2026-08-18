"""Reading a Google Takeout export: what is inside it, and how to write a
repaired copy of it into a folder Smriti can index.

Three facts about Takeout shape everything in here, all three measured against
a real export rather than assumed:

  * A photo and its `.supplemental-metadata.json` routinely land in DIFFERENT
    zip parts — 200 of 288 pairs did in the reference export. Pairing therefore
    has to be resolved across every selected archive at once, which is why
    `scan_archives` takes the whole list and no caller ever pairs per-zip.

  * A photo that belongs to an album appears TWICE, byte for byte: once under
    `Photos from YYYY` and once under the album. Extracting both would double
    the disk cost and hand Cleanup a pile of "duplicates" that are one photo.
    Both paths are still created — that is what mirroring the Takeout layout
    promises — but the second is a hardlink, so the bytes exist once.

  * Most photos still carry their EXIF. The ones that do not are exactly the
    ones no filename can rescue (`Snapchat-1092218619.jpg`), and the sidecar is
    their only source of a date. That is the whole case for the repair step.

Nothing here touches the database, and nothing here writes to the archives.
"""
from __future__ import annotations

import os
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .. import config
from . import zipstream

# Google localizes the "Google Photos" folder, so the photos root is found by
# looking for media rather than by matching an English name.
SIDECAR_SUFFIXES = (".supplemental-metadata.json", ".suppl.json", ".json")

# A year bucket ends with the year in every localization we have seen
# ("Photos from 2024", "Fotos von 2024"). Anything else is an album. Getting
# this wrong only decides which of two identical copies is the hardlink target.
_YEAR_BUCKET = re.compile(r"(?:19|20)\d{2}\s*$")

# "IMG_1234(1).jpg" pairs with "IMG_1234.jpg(1).json" — Google moves the index
_DUP_INDEX = re.compile(r"^(?P<stem>.+?)\((?P<n>\d+)\)(?P<ext>\.[^.]*)$")

_WIN_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                 *(f"LPT{i}" for i in range(1, 10))}

MEDIA_EXTS = config.PHOTO_EXTS | config.VIDEO_EXTS


@dataclass(frozen=True)
class Entry:
    """One file inside one archive."""
    archive: str        # absolute path of the .zip it lives in
    name: str           # full entry name, decoded
    size: int
    crc: int
    raw: str = ""       # the name as zipfile knows it — what open() needs when
                        # a pre-UTF-8 archive made `name` a re-decode

    @property
    def key(self) -> str:
        return self.raw or self.name

    @property
    def basename(self) -> str:
        return self.name.rsplit("/", 1)[-1]

    @property
    def container(self) -> str:
        """The folder immediately above the file — a year bucket or an album."""
        parts = self.name.split("/")
        return parts[-2] if len(parts) >= 2 else ""


@dataclass
class MediaItem:
    entry: Entry
    sidecar: Entry | None = None

    @property
    def is_album(self) -> bool:
        return bool(self.entry.container) and not _YEAR_BUCKET.search(self.entry.container)


@dataclass
class Manifest:
    items: list[MediaItem] = field(default_factory=list)
    containers: dict[str, int] = field(default_factory=dict)
    albums: dict[str, int] = field(default_factory=dict)
    photos: int = 0
    videos: int = 0
    photos_root: str = "Google Photos"   # localized in non-English exports
    unique_bytes: int = 0        # what extraction actually costs on disk
    duplicate_paths: int = 0     # album copies that become hardlinks
    orphan_sidecars: int = 0     # metadata whose photo is in a part not selected
    paired: int = 0
    non_media: int = 0
    archives: list[str] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.items)


# ---- reading the archives ---------------------------------------------------

def _decode(info: zipfile.ZipInfo) -> str:
    """Entry names are UTF-8 when the flag bit says so; without it zipfile
    falls back to cp437 and mangles anything non-ASCII, so undo that."""
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


def scan_archives(paths: list[str]) -> Manifest:
    """Read every archive's central directory — no extraction — and return what
    importing them would produce. Fast enough to run while the user waits."""
    man = Manifest(archives=list(paths))
    media: dict[str, Entry] = {}
    sidecars: dict[str, Entry] = {}
    roots: dict[str, int] = {}

    for p in paths:
        try:
            zf = zipfile.ZipFile(p)
            infos = zf.infolist()
        except (zipfile.BadZipFile, OSError) as e:
            man.unreadable.append(f"{os.path.basename(p)}: {type(e).__name__}")
            continue
        with zf:
            for info in infos:
                if info.is_dir():
                    continue
                name = _decode(info)
                entry = Entry(p, name, info.file_size, info.CRC, info.filename)
                low = name.lower()
                if low.endswith(".json"):
                    sidecars[name] = entry
                elif os.path.splitext(low)[1] in MEDIA_EXTS:
                    # A later archive re-listing the same path is the same file
                    media.setdefault(name, entry)
                    parts = name.split("/")
                    if len(parts) >= 3:
                        roots[parts[-3]] = roots.get(parts[-3], 0) + 1
                else:
                    man.non_media += 1

    matched: set[str] = set()
    for name, entry in sorted(media.items()):
        sc = _find_sidecar(name, sidecars)
        if sc is not None:
            matched.add(sc.name)
        item = MediaItem(entry, sc)
        man.items.append(item)
        man.containers[entry.container] = man.containers.get(entry.container, 0) + 1
        if item.is_album:
            man.albums[entry.container] = man.albums.get(entry.container, 0) + 1
        if os.path.splitext(name.lower())[1] in config.VIDEO_EXTS:
            man.videos += 1
        else:
            man.photos += 1

    _pair_across_containers(man, sidecars, matched)
    _share_within_duplicates(man)
    man.paired = sum(1 for i in man.items if i.sidecar is not None)

    man.orphan_sidecars = len(sidecars) - len(matched)
    if roots:
        man.photos_root = max(roots.items(), key=lambda kv: kv[1])[0]

    seen: set[tuple[int, int]] = set()
    for item in man.items:
        key = (item.entry.crc, item.entry.size)
        if key in seen:
            man.duplicate_paths += 1
        else:
            seen.add(key)
            man.unique_bytes += item.entry.size
    return man


def _strip_sidecar_suffix(basename: str) -> str:
    for suffix in SIDECAR_SUFFIXES:
        if basename.lower().endswith(suffix):
            return basename[: -len(suffix)]
    return basename


def _pair_across_containers(man: Manifest, sidecars: dict[str, Entry],
                            matched: set[str]) -> None:
    """Adopt metadata that was filed under a different folder than the photo.

    A photo in an album exists twice, and Takeout may put the sidecar beside
    either copy — so the album's copy can carry the metadata for a photo whose
    year-folder copy is the one we hold (or vice versa, when the twin is in a
    part the user has not downloaded). The two are byte-identical, so metadata
    filed against one describes the other exactly.

    Only a unique candidate is accepted: two different photos that happen to
    share a filename must never trade dates and GPS with each other.
    """
    index: dict[str, list[Entry]] = {}
    for name, entry in sidecars.items():
        if name in matched:
            continue
        stem = _strip_sidecar_suffix(name.rpartition("/")[2]).lower()
        index.setdefault(stem, []).append(entry)

    for item in man.items:
        if item.sidecar is not None:
            continue
        cands = index.get(item.entry.basename.lower())
        if cands and len(cands) == 1:
            item.sidecar = cands[0]
            matched.add(cands[0].name)


def _share_within_duplicates(man: Manifest) -> None:
    """Every copy of one photo gets the metadata any copy of it has.

    The copies are the same bytes (Takeout duplicates album members verbatim),
    so this moves a known date onto a copy that was filed without one instead
    of leaving identical files described differently."""
    found: dict[tuple[int, int], Entry] = {}
    for item in man.items:
        if item.sidecar is not None:
            found.setdefault((item.entry.crc, item.entry.size), item.sidecar)
    if not found:
        return
    for item in man.items:
        if item.sidecar is None:
            item.sidecar = found.get((item.entry.crc, item.entry.size))


def _find_sidecar(media_name: str, sidecars: dict[str, Entry]) -> Entry | None:
    """Match a photo to its metadata, through every naming rule Google uses.

    Fuzzy rules only fire when they hit exactly one candidate — a wrong sidecar
    would stamp one photo's date and GPS onto another, which is worse than
    having no metadata at all."""
    for suffix in SIDECAR_SUFFIXES:
        hit = sidecars.get(media_name + suffix)
        if hit is not None:
            return hit

    folder, _, base = media_name.rpartition("/")
    pool = {n: e for n, e in sidecars.items() if n.rpartition("/")[0] == folder}
    if not pool:
        return None

    lower = {n.lower(): e for n, e in pool.items()}
    for suffix in SIDECAR_SUFFIXES:
        hit = lower.get((media_name + suffix).lower())
        if hit is not None:
            return hit

    # "IMG_1234(1).jpg" -> "IMG_1234.jpg(1).json"
    m = _DUP_INDEX.match(base)
    if m:
        moved = f"{m['stem']}{m['ext']}({m['n']})"
        for suffix in SIDECAR_SUFFIXES:
            hit = lower.get(f"{folder}/{moved}{suffix}".lower())
            if hit is not None:
                return hit

    # Long names are truncated before the suffix is appended, so the sidecar
    # stem is a prefix of the photo's name. Accept only a unique candidate.
    cands = []
    for n, e in pool.items():
        stem = n.rpartition("/")[2]
        for suffix in SIDECAR_SUFFIXES:
            if stem.lower().endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        if len(stem) >= 12 and base.lower().startswith(stem.lower()):
            cands.append(e)
    return cands[0] if len(cands) == 1 else None


# ---- metadata from a sidecar -----------------------------------------------

@dataclass
class Sidecar:
    taken_at: datetime | None = None
    lat: float | None = None
    lon: float | None = None


def read_sidecar(entry: Entry | None, open_zip) -> Sidecar:
    """Parse one sidecar. `open_zip` maps an archive path to an open ZipFile.

    It is a callable rather than a dict on purpose: a sidecar frequently lives
    in a part that holds no media at all, so the caller cannot know which
    archives it will need until it gets here. Passing a prebuilt dict made a
    metadata-only part raise KeyError and read as "this photo has no metadata",
    which is silent and exactly wrong."""
    if entry is None:
        return Sidecar()
    import json

    try:
        raw = json.loads(open_zip(entry.archive).read(entry.key))
    except Exception:
        return Sidecar()
    out = Sidecar()
    ts = ((raw.get("photoTakenTime") or {}).get("timestamp")
          or (raw.get("creationTime") or {}).get("timestamp"))
    if ts:
        try:
            # Naive UTC, matching services/exif.parse_video_creation_time: the
            # capture timezone is not in the export, and inventing one from GPS
            # is a bigger promise than this feature makes.
            out.taken_at = datetime.fromtimestamp(int(ts), timezone.utc).replace(tzinfo=None)
        except (ValueError, OSError, OverflowError):
            pass
    for key in ("geoData", "geoDataExif"):
        geo = raw.get(key) or {}
        lat, lon = geo.get("latitude"), geo.get("longitude")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and (lat or lon):
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                out.lat, out.lon = float(lat), float(lon)
                break
    return out


# ---- destination paths ------------------------------------------------------

def safe_component(name: str) -> str:
    """A single path component that every platform will accept.

    Album names come straight from Google and really do contain emoji and
    trailing spaces ("After a Long Time with an Idiot "), and Windows rejects a
    trailing space or dot outright."""
    out = zipstream.safe_name(name)          # strips separators, ../ and the
    stem = out.split(".")[0].upper()          # characters Windows forbids
    if stem in _WIN_RESERVED:
        out = "_" + out
    return out or "_"


@dataclass
class Plan:
    """One unit of extraction: the file to write, plus any identical copies of
    it that become hardlinks."""
    item: MediaItem
    dest: Path
    links: list[Path] = field(default_factory=list)
    album_paths: list[tuple[str, Path]] = field(default_factory=list)


def plan_extraction(man: Manifest, root: Path) -> list[Plan]:
    """Map the manifest onto real paths under `root`, mirroring the Takeout
    folders and collapsing byte-identical copies onto one file."""
    plans: dict[tuple[int, int], Plan] = {}
    taken: set[str] = set()
    order: list[Plan] = []

    # Year buckets first, so the canonical copy is the one in Photos from YYYY
    # and the album entry is the link. Stable regardless of archive order.
    for item in sorted(man.items, key=lambda i: (i.is_album, i.entry.name)):
        folder = root / safe_component(item.entry.container or "Photos")
        dest = folder / safe_component(item.entry.basename)
        key = dest.as_posix().lower()
        if key in taken:
            dest = folder / _dedupe_name(folder, item.entry.basename, taken)
        taken.add(dest.as_posix().lower())

        ck = (item.entry.crc, item.entry.size)
        primary = plans.get(ck)
        if primary is None:
            p = Plan(item, dest)
            plans[ck] = p
            order.append(p)
        else:
            primary.links.append(dest)
            p = primary
        if item.is_album:
            p.album_paths.append((item.entry.container, dest))
    return order


def _dedupe_name(folder: Path, basename: str, taken: set[str]) -> str:
    stem, ext = os.path.splitext(safe_component(basename))
    for n in range(2, 10000):
        cand = f"{stem} ({n}){ext}"
        if (folder / cand).as_posix().lower() not in taken:
            return cand
    return f"{stem} ({os.urandom(4).hex()}){ext}"


# ---- repair -----------------------------------------------------------------

EXIF_IFD, GPS_IFD = 0x8769, 0x8825
_JPEG_EXTS = {".jpg", ".jpeg"}


def _dms(v: float) -> tuple[float, float, float]:
    v = abs(v)
    d = int(v)
    m = int((v - d) * 60)
    s = (v - d - m / 60) * 3600
    return (float(d), float(m), round(s, 4))


def build_exif(dt: datetime | None, lat: float | None, lon: float | None,
               base=None) -> bytes:
    """EXIF payload carrying a capture date and/or GPS.

    `Exif.get_ifd()` hands back a COPY in several Pillow versions, so writing
    into it is silently lost — sub-IFDs have to be assigned back whole."""
    from PIL import Image

    ex = base if base is not None else Image.Exif()
    if dt is not None:
        stamp = dt.strftime("%Y:%m:%d %H:%M:%S")
        ex[306] = stamp
        sub = dict(ex.get_ifd(EXIF_IFD))
        sub.setdefault(0x9003, stamp)
        sub.setdefault(0x9004, stamp)
        ex[EXIF_IFD] = sub
    if lat is not None and lon is not None:
        gps = dict(ex.get_ifd(GPS_IFD))
        gps.update({1: "N" if lat >= 0 else "S", 2: _dms(lat),
                    3: "E" if lon >= 0 else "W", 4: _dms(lon)})
        ex[GPS_IFD] = gps
    raw = ex.tobytes()
    # tobytes() already emits the APP1 "Exif\0\0" header; splice_exif adds its
    # own, and a doubled header is a segment strict readers quietly reject.
    return raw[6:] if raw.startswith(b"Exif\x00\x00") else raw


def splice_exif(jpeg: bytes, payload: bytes) -> bytes:
    """Replace a JPEG's APP1/Exif segment without touching a single byte of
    compressed image data — no decode, no re-encode, no quality loss."""
    if jpeg[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    body = b"Exif\x00\x00" + payload
    app1 = b"\xff\xe1" + (len(body) + 2).to_bytes(2, "big") + body

    out = bytearray(b"\xff\xd8")
    i = 2
    inserted = False
    while i < len(jpeg) - 1:
        if jpeg[i] != 0xFF:
            break
        marker = jpeg[i + 1]
        if marker == 0xDA:                     # start of scan: the rest is data
            break
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            out += jpeg[i:i + 2]
            i += 2
            continue
        seg_len = int.from_bytes(jpeg[i + 2:i + 4], "big")
        seg = jpeg[i:i + 2 + seg_len]
        if marker == 0xE1 and jpeg[i + 4:i + 10] == b"Exif\x00\x00":
            seg = b""                          # drop the segment being replaced
        elif marker == 0xE0 and not inserted:  # keep JFIF first, then ours
            out += seg
            out += app1
            inserted = True
            i += 2 + seg_len
            continue
        elif not inserted:
            out += app1
            inserted = True
        out += seg
        i += 2 + seg_len
    if not inserted:
        out += app1
    out += jpeg[i:]
    return bytes(out)


def repair(path: Path, sc: Sidecar, write_exif: bool) -> tuple[bool, datetime | None]:
    """Give a freshly written file the date and place Takeout stripped from it.

    Returns (exif_was_written, timestamp_used). Existing EXIF always wins: a
    camera's own record of when and where a photo was taken is not ours to
    overwrite, so only genuinely absent fields are filled in.
    """
    from PIL import Image

    from . import exif as exif_svc

    ext = path.suffix.lower()
    have_date = have_gps = False
    existing = None
    if ext in _JPEG_EXTS:
        try:
            with Image.open(path) as im:
                existing = im.getexif()
                meta = exif_svc.parse_exif(existing)
            have_date = "taken_at" in meta
            have_gps = "gps_lat" in meta
        except Exception:
            existing = None

    wrote = False
    if (write_exif and ext in _JPEG_EXTS and existing is not None
            and ((sc.taken_at and not have_date) or (sc.lat is not None and not have_gps))):
        try:
            raw = path.read_bytes()
            payload = build_exif(None if have_date else sc.taken_at,
                                 None if have_gps else sc.lat,
                                 None if have_gps else sc.lon,
                                 base=existing)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(splice_exif(raw, payload))
            os.replace(tmp, path)
            wrote = True
        except Exception:
            # A photo that keeps its original bytes and loses only its metadata
            # is a far better outcome than a corrupted one.
            try:
                path.with_name(path.name + ".tmp").unlink(missing_ok=True)
            except OSError:
                pass

    stamp = sc.taken_at
    if stamp is None and not have_date:
        stamp = exif_svc.date_from_filename(path.name)
    if stamp is not None:
        try:
            ts = stamp.replace(tzinfo=timezone.utc).timestamp()
            os.utime(path, (ts, ts))
        except (OSError, OverflowError, ValueError):
            pass
    return wrote, stamp
