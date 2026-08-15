"""EXIF / date extraction helpers. Import-safe for pool workers: no db access."""
import re
from datetime import datetime, timezone

EXIF_IFD = 0x8769
GPS_IFD = 0x8825

TAG_MAKE = 271
TAG_MODEL = 272
TAG_ORIENTATION = 274
TAG_DATETIME = 306
TAG_DT_ORIGINAL = 0x9003
TAG_ISO = 0x8827
TAG_FNUMBER = 0x829D
TAG_EXPOSURE = 0x829A
TAG_FOCAL = 0x920A

_FILENAME_PATTERNS = [
    # IMG_20190601_123456, PXL_20200101_..., VID_20190601...
    re.compile(r"(?:19|20)\d{6}[_-]\d{6}"),
    # 2019-06-01 12.34.56 / 2019-06-01_12-34-56
    re.compile(r"(?:19|20)\d{2}-\d{2}-\d{2}[ _.]\d{2}[-.]\d{2}[-.]\d{2}"),
    # IMG-20190601-WA0001 (WhatsApp), bare 20190601
    re.compile(r"(?:19|20)\d{6}"),
    # 2019-06-01
    re.compile(r"(?:19|20)\d{2}-\d{2}-\d{2}"),
]


def _clean(v):
    if isinstance(v, str):
        v = v.strip().strip("\x00")
        return v or None
    return v


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def parse_exif(pil_exif) -> dict:
    """Extract fields of interest from a PIL Image.getexif() object."""
    out: dict = {}
    try:
        out["camera_make"] = _clean(pil_exif.get(TAG_MAKE))
        out["camera_model"] = _clean(pil_exif.get(TAG_MODEL))
        out["orientation"] = pil_exif.get(TAG_ORIENTATION)
        dt = None
        try:
            ifd = pil_exif.get_ifd(EXIF_IFD)
            dt = _clean(ifd.get(TAG_DT_ORIGINAL))
            out["iso"] = ifd.get(TAG_ISO) if isinstance(ifd.get(TAG_ISO), int) else None
            out["f_number"] = _to_float(ifd.get(TAG_FNUMBER))
            exp = ifd.get(TAG_EXPOSURE)
            if exp is not None:
                ev = _to_float(exp)
                if ev and 0 < ev < 1:
                    out["exposure"] = f"1/{round(1 / ev)}"
                elif ev is not None:
                    out["exposure"] = f"{ev:g}"
            out["focal_length"] = _to_float(ifd.get(TAG_FOCAL))
        except Exception:
            pass
        if not dt:
            dt = _clean(pil_exif.get(TAG_DATETIME))
        parsed = parse_exif_datetime(dt) if dt else None
        if parsed:
            out["taken_at"] = parsed.strftime("%Y-%m-%d %H:%M:%S")
            out["taken_at_ts"] = int(parsed.timestamp())
            out["taken_at_src"] = "exif"
        try:
            gps = pil_exif.get_ifd(GPS_IFD)
            latlon = _parse_gps_ifd(gps)
            if latlon:
                out["gps_lat"], out["gps_lon"] = latlon
        except Exception:
            pass
    except Exception:
        pass
    return {k: v for k, v in out.items() if v is not None}


def parse_exif_datetime(s: str) -> datetime | None:
    s = s.strip()
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            d = datetime.strptime(s[:19], fmt)
            if 1980 <= d.year <= 2100:
                return d
        except ValueError:
            continue
    return None


def _parse_gps_ifd(gps: dict):
    def dms(vals, ref, neg_refs):
        try:
            d = float(vals[0]) + float(vals[1]) / 60 + float(vals[2]) / 3600
        except (TypeError, ValueError, IndexError, ZeroDivisionError):
            return None
        if ref in neg_refs:
            d = -d
        return d

    lat = dms(gps.get(2), gps.get(1), ("S",))
    lon = dms(gps.get(4), gps.get(3), ("W",))
    if lat is None or lon is None or (lat == 0 and lon == 0):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def date_from_filename(name: str) -> datetime | None:
    for pat in _FILENAME_PATTERNS:
        m = pat.search(name)
        if not m:
            continue
        raw = re.sub(r"[^0-9]", "", m.group(0))
        try:
            if len(raw) >= 14:
                d = datetime.strptime(raw[:14], "%Y%m%d%H%M%S")
            elif len(raw) == 8:
                d = datetime.strptime(raw, "%Y%m%d")
            else:
                continue
            if 1990 <= d.year <= 2100:
                return d
        except ValueError:
            continue
    return None


def parse_iso6709(s: str):
    """'+37.3349-122.0090+000.000/' -> (lat, lon)"""
    m = re.match(r"([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)", s.strip())
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if lat == 0 and lon == 0:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def parse_video_creation_time(s: str) -> datetime | None:
    s = s.strip().replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is not None:
        # Known v1 approximation: QuickTime times are UTC; we drop tz info
        # (local-time offset from GPS is a post-v1 refinement).
        d = d.astimezone(timezone.utc).replace(tzinfo=None)
    if not (1980 <= d.year <= 2100):
        return None
    return d
