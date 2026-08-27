"""Turning a set of photographs into something you watch instead of scroll.

A library is a filing cabinet, and nobody opens a filing cabinet to feel
something. This is the other use for the same photographs: a minute of them,
in order, moving slowly, with music — the difference between having your
memories and being handed one.

Smriti starts this from further along than most. The hard question is usually
*which photos belong together*, and events already answer it — a trip is
already a row with a name and a date range, clustered by the gaps between
shutter presses. What is left is choosing well from inside it, and choosing
well is mostly about leaving things out: the eleven near-identical frames of
the same view, the ones that came out soft, the second half of a burst.

Photos only, for now. A clip carries its own audio and its own pacing, and
both fight the montage; doing it properly is its own piece of work rather than
a flag on this one.
"""
import os
import subprocess
from dataclasses import dataclass

from .. import config, db
from . import thumbs
from . import volumes as vol_svc

W, H, FPS = 1920, 1080, 30
HOLD, FADE = 3.4, 0.9          # seconds a photo is held, seconds of crossfade
TITLE_HOLD = 2.6
MIN_ITEMS = 4
MAX_ITEMS = 16                 # ~50s; past that nobody reaches the end


class MomentError(RuntimeError):
    """Not enough to make one, or ffmpeg would not."""


@dataclass
class Source:
    kind: str          # 'event' | 'person' | 'place' | 'day'
    ref: str
    title: str
    subtitle: str


# ---- choosing what goes in ---------------------------------------------------

_BASE = (
    "SELECT f.id, f.media_type, f.volume_id, m.taken_at, q.sharpness "
    "FROM files f JOIN metadata m ON m.file_id = f.id "
    "LEFT JOIN file_quality q ON q.file_id = f.id "
    "WHERE f.status='active' AND f.media_type='photo' AND m.taken_at IS NOT NULL "
    "AND f.id NOT IN (SELECT file_id FROM locked_items) "
    # the movie half of a Live Photo is not a photograph anyone took
    "AND f.id NOT IN (SELECT video_file_id FROM file_motion WHERE video_file_id IS NOT NULL) "
    # a receipt or a screenshot in the middle of a montage breaks the spell —
    # same tombstone-aware rule the timeline uses
    "AND f.id NOT IN (SELECT file_id FROM file_kinds WHERE kind != 'photo') "
)


def source_for(kind: str, ref: str) -> Source:
    """What this moment is of, and what to call it."""
    if kind == "event":
        row = db.query_one("SELECT title, start_ts FROM events WHERE id=?", (int(ref),))
        if not row:
            raise MomentError("no such event")
        title = row["title"] or "A day out"
        # event titles already read "Rishikesh · May 28, 2024"; split rather
        # than print the separator on screen
        head, _, tail = title.partition(" · ")
        return Source(kind, ref, head, tail)
    if kind == "person":
        row = db.query_one("SELECT name FROM persons WHERE id=?", (int(ref),))
        if not row:
            raise MomentError("no such person")
        return Source(kind, ref, row["name"] or "Someone", "over the years")
    if kind == "place":
        return Source(kind, ref, ref, "over the years")
    if kind == "day":
        return Source(kind, ref, "On this day", ref)
    raise MomentError(f"unknown kind {kind!r}")


def candidates(kind: str, ref: str) -> list:
    if kind == "event":
        return db.query(_BASE + "AND f.id IN (SELECT file_id FROM event_items WHERE event_id=?) "
                                "ORDER BY m.taken_at", (int(ref),))
    if kind == "person":
        return db.query(_BASE + "AND f.id IN (SELECT file_id FROM faces WHERE person_id=?) "
                                "ORDER BY m.taken_at", (int(ref),))
    if kind == "place":
        return db.query(_BASE + "AND f.id IN (SELECT file_id FROM file_places WHERE city=?) "
                                "ORDER BY m.taken_at", (ref,))
    if kind == "day":
        return db.query(_BASE + "AND strftime('%m-%d', m.taken_at) = ? ORDER BY m.taken_at", (ref,))
    raise MomentError(f"unknown kind {kind!r}")


def curate(rows: list, target: int = MAX_ITEMS) -> list:
    """Choose from a pile, mostly by leaving things out.

    Three passes, cheapest first. One frame per near-duplicate group, because
    a montage that shows the same view four times reads as broken rather than
    thorough. Then the soft ones, where anything knows how sharp they are.
    Then an even spread across the elapsed time, so what comes out is the shape
    of the day rather than the twenty minutes someone got trigger-happy."""
    if not rows:
        return []

    # 1. one per burst. The keeper the duplicates pass already nominated, if it
    #    nominated one — no reason for two features to disagree about which of
    #    four identical frames is the good one.
    seen_groups: set[int] = set()
    keepers = {r["file_id"] for r in db.query(
        "SELECT file_id FROM dupe_group_items WHERE is_suggested_keeper=1")}
    group_of = {r["file_id"]: r["group_id"]
                for r in db.query("SELECT group_id, file_id FROM dupe_group_items")}
    deduped = []
    for r in rows:
        g = group_of.get(r["id"])
        if g is None:
            deduped.append(r)
            continue
        if g in seen_groups:
            continue
        # prefer the nominated keeper; if this is not it, wait for it
        if keepers and r["id"] not in keepers and any(
                x["id"] in keepers and group_of.get(x["id"]) == g for x in rows):
            continue
        seen_groups.add(g)
        deduped.append(r)

    # 1b. photos whose originals are actually reachable, while enough are: a
    #     mixed event — half on this disk, half on one in a drawer — should be
    #     built from the half that can be read at full size, not padded with
    #     512px thumbnails. When too few are reachable the cache fallback
    #     stands, deliberately: a moment of an unplugged trip can still be
    #     asked for, it is just never *suggested*.
    online = {r["id"] for r in db.query("SELECT id FROM volumes WHERE is_online=1")}
    reachable = [r for r in deduped if r["volume_id"] in online]
    if len(reachable) >= MIN_ITEMS:
        deduped = reachable

    # 2. the soft ones — only where the blur scan has actually run. A library
    #    that never ran it should get a montage anyway, not an empty one.
    scored = [r for r in deduped if r["sharpness"] is not None]
    if len(scored) >= 12 and len(scored) > len(deduped) * 0.6:
        cut = sorted(s["sharpness"] for s in scored)[len(scored) // 4]
        deduped = [r for r in deduped if r["sharpness"] is None or r["sharpness"] >= cut]

    # 3. an even spread across the whole stretch, not the first N
    if len(deduped) <= target:
        return deduped
    step = len(deduped) / target
    return [deduped[int(i * step)] for i in range(target)]


# ---- turning them into frames ------------------------------------------------

def _font(size: int):
    from PIL import ImageFont

    for path in ("/System/Library/Fonts/Helvetica.ttc",
                 "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "C:/Windows/Fonts/segoeui.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                pass
    return ImageFont.load_default(size=size)


def _centering(img, file_id: int) -> tuple[float, float]:
    """Where to put the 16:9 crop, so the people in the photo stay in it.

    The library already knows where every face is. Framing the crop on the
    union of them — instead of a fixed "slightly above centre" guess — is what
    keeps the slow zoom from pushing someone's head off the top of the frame:
    zoompan zooms toward the middle, so whatever is centred is what survives."""
    faces = db.query("SELECT x, y, w, h FROM faces WHERE file_id=?", (file_id,))
    if not faces:
        return (0.5, 0.42)
    x0 = min(f["x"] for f in faces)
    y0 = min(f["y"] for f in faces)
    x1 = max(f["x"] + f["w"] for f in faces)
    y1 = max(f["y"] + f["h"] for f in faces)
    fcx, fcy = (x0 + x1) / 2, (y0 + y1) / 2
    iw, ih = img.size
    # ImageOps.fit places the crop window proportionally: 0 = flush left/top,
    # 1 = flush right/bottom. Solve for the value that puts the face centre at
    # the crop centre, then clamp into the image.
    if iw * H > ih * W:            # wider than 16:9 — cropping left/right
        crop_w = ih * W / H
        cx = 0.5 if iw <= crop_w else min(1.0, max(0.0, (fcx * iw - crop_w / 2) / (iw - crop_w)))
        return (cx, 0.5)
    crop_h = iw * H / W            # taller — cropping top/bottom, the usual portrait case
    cy = 0.42 if ih <= crop_h else min(1.0, max(0.0, (fcy * ih - crop_h / 2) / (ih - crop_h)))
    return (0.5, cy)


# Above this closed-minus-open margin, a face is a blink. Calibrated on a real
# library: 260 random face crops scored and eyeballed — everything past 0.025
# was genuinely shut or downcast eyes, everything below -0.02 was wide open,
# and the band between is squints and profiles, which stay.
BLINK_MARGIN = 0.025
_blink_cache: tuple | None | bool = None


def _blink_scorer():
    """CLIP, asked one narrow question per face: are the eyes shut?

    The library stores face boxes but no eye landmarks, and shipping a
    dedicated blink model for one filter would be absurd — while the search
    model, if it has been downloaded, answers this zero-shot on a face crop.
    Returns None where CLIP is absent; a montage must not grow a
    prerequisite, it just skips the check it cannot make."""
    global _blink_cache
    if _blink_cache is not None:
        return _blink_cache or None
    try:
        import numpy as np

        from ..fetch_clip import present
        if not present():
            _blink_cache = False
            return None
        from .search import engine
        eng = engine()
        closed = ["a photo of a face with both eyes closed",
                  "a person blinking, eyes shut",
                  "a portrait of someone with closed eyes"]
        opened = ["a photo of a face with eyes open",
                  "a person looking at the camera with open eyes",
                  "a portrait of someone with wide open eyes"]
        tv = eng.encode_text(closed + opened)
        c = tv[: len(closed)].mean(0)
        o = tv[len(closed):].mean(0)
        c, o = c / np.linalg.norm(c), o / np.linalg.norm(o)
        _blink_cache = (eng, c, o)
    except Exception:
        _blink_cache = False
        return None
    return _blink_cache


def _eyes_closed(img, file_id: int) -> float:
    """The worst blink in the photo — max closed-minus-open margin across its
    faces. One person mid-blink spoils the frame, so the max is the score.
    Tiny background faces are skipped: no eye detail survives at that size,
    and their answer would be noise either way."""
    scorer = _blink_scorer()
    if scorer is None:
        return 0.0
    eng, cvec, ovec = scorer
    faces = db.query(
        "SELECT x, y, w, h FROM faces WHERE file_id=? AND w*h >= 0.008 AND det_score > 0.6",
        (file_id,))
    if not faces:
        return 0.0
    W, H = img.size
    worst = -1.0
    for f in faces:
        x, y, w, h = f["x"] * W, f["y"] * H, f["w"] * W, f["h"] * H
        mx, my = w * 0.3, h * 0.3
        crop = img.crop((max(0, int(x - mx)), max(0, int(y - my)),
                         min(W, int(x + w + mx)), min(H, int(y + h + my))))
        if min(crop.size) < 48:
            continue
        try:
            emb = eng.encode_image(crop)
        except Exception:
            return 0.0
        worst = max(worst, float(emb @ cvec - emb @ ovec))
    return worst


def _sharpness(img) -> float:
    """Gradient variance on a small grayscale copy — enough to rank the frames
    of one event against each other, which is all it is used for."""
    import numpy as np

    g = np.asarray(img.convert("L").resize((480, 270)), dtype=np.float32)
    return float(np.var(np.diff(g, axis=0)) + np.var(np.diff(g, axis=1)))


# 1.5x the output frame: the zoom peaks at 1.09, so ffmpeg never has to invent
# pixels, and a 1600px preview upscales far less than the old 2x demanded.
_UP = 1.5


def _still(row, dest: str) -> tuple[str, float, float] | None:
    """A photo, decoded here rather than by ffmpeg, best copy first.

    The original, wherever its drive is plugged in — this is the render that
    ends up projected on someone's TV, and a 512px thumbnail blown up to 4K is
    where the "why is my memory blurry" report came from. The cached preview
    and thumbnail remain the fallback that lets a moment be made of photos
    whose drive is offline. HEIC originals go through the same decoder the
    preview pipeline uses."""
    from PIL import Image, ImageOps

    img = None
    ap = vol_svc.abs_path_for_file(db.query_one("SELECT * FROM files WHERE id=?", (row["id"],)))
    if ap and os.path.exists(ap):
        img = thumbs._decode_full(ap)          # handles HEIC + sips fallback
        if img is not None:
            img = ImageOps.exif_transpose(img)
    if img is None:
        for p in (thumbs.preview_path(row["id"]), thumbs.thumb_path(row["id"])):
            if p.exists():
                try:
                    img = ImageOps.exif_transpose(Image.open(p))
                    break
                except Exception:
                    img = None
    if img is None:
        return None
    img = img.convert("RGB")
    # blink is judged before the 16:9 crop — the face boxes are normalised to
    # the photo as shot, not to whatever framing survives the fit
    blink = _eyes_closed(img, row["id"])
    img = ImageOps.fit(img, (int(W * _UP), int(H * _UP)), Image.LANCZOS,
                       centering=_centering(img, row["id"]))
    img.save(dest, "JPEG", quality=92)
    return dest, _sharpness(img), blink


def _title_card(src: Source, under, dest: str) -> str:
    """The opening frame: the event's own name over its own cover, darkened."""
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

    base = Image.new("RGB", (W * 2, H * 2), (10, 13, 24))
    if under is not None:
        try:
            bg = ImageOps.exif_transpose(Image.open(under)).convert("RGB")
            bg = ImageOps.fit(bg, (W * 2, H * 2), Image.LANCZOS, centering=(0.5, 0.42))
            bg = bg.filter(ImageFilter.GaussianBlur(26))
            base = ImageEnhance.Brightness(bg).enhance(0.38)
        except Exception:
            pass
    d = ImageDraw.Draw(base)
    title_f, sub_f = _font(150), _font(64)
    tw = d.textbbox((0, 0), src.title, font=title_f)
    d.text(((W * 2 - (tw[2] - tw[0])) / 2, H * 2 * 0.40), src.title,
           font=title_f, fill=(246, 248, 253))
    if src.subtitle:
        sw = d.textbbox((0, 0), src.subtitle, font=sub_f)
        d.text(((W * 2 - (sw[2] - sw[0])) / 2, H * 2 * 0.40 + 190), src.subtitle,
               font=sub_f, fill=(178, 188, 214))
    base.save(dest, "JPEG", quality=92)
    return dest


# ---- the filtergraph ---------------------------------------------------------

def build_graph(n_slides: int, holds: list[float]) -> tuple[str, str, float]:
    """-> (filter_complex, final video label, total seconds).

    zoompan is handed exactly one input frame per slide and asked for `d`
    frames of output. Feeding it a looped stream instead makes it emit `d`
    frames for every frame it receives, which turns a twenty-second montage
    into a five-minute one — quietly, and only visible in the duration."""
    filt, labels = [], []
    for i, hold in enumerate(holds):
        d = max(2, int(hold * FPS))
        # alternate the direction so consecutive slides do not all drift the
        # same way, which reads as a camera fault rather than a choice. 1.09,
        # down from 1.13: with the crop now framed on the faces, 9% is drift
        # you feel without ever cutting a forehead off.
        z = ("min(1+0.0011*on,1.09)" if i % 2 == 0 else "max(1.09-0.0011*on,1.0)")
        filt.append(
            f"[{i}:v]zoompan=z='{z}':d={d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            f":s={W}x{H}:fps={FPS},setsar=1,format=yuv420p[v{i}]")
        labels.append(f"[v{i}]")

    chain, prev = [], labels[0]
    off = holds[0] - FADE
    for i in range(1, len(labels)):
        lbl = f"[x{i}]"
        chain.append(f"{prev}{labels[i]}xfade=transition=fade:duration={FADE}:offset={off:.3f}{lbl}")
        prev = lbl
        off += holds[i] - FADE
    total = sum(holds) - FADE * (len(holds) - 1)
    return ";".join(filt + chain), prev, total


def music_tracks() -> list[dict]:
    """What is on offer, from the manifest that ships beside the files."""
    import json

    d = config.MUSIC_DIR
    man = d / "manifest.json"
    if not man.exists():
        return []
    try:
        return json.loads(man.read_text())["tracks"]
    except Exception:
        return []


def pick_track(name: str | None, seed: int = 0) -> dict | None:
    tracks = music_tracks()
    if not tracks:
        return None
    if name:
        for t in tracks:
            if t["file"] == name or t["title"].lower() == name.lower():
                return t
    return tracks[seed % len(tracks)]


def render(src: Source, rows: list, out_path: str, track: dict | None,
           workdir: str, on_progress=None) -> tuple[float, list]:
    """Render the montage. Returns (duration seconds, the rows actually used) —
    curation offers more than fit and the soft ones are dropped in here."""
    os.makedirs(workdir, exist_ok=True)
    decoded: list[tuple[dict, str, float, float]] = []   # (row, path, sharpness, blink)
    for i, r in enumerate(rows):
        got = _still(r, os.path.join(workdir, f"{i:03d}.jpg"))
        if got:
            decoded.append((r, *got))
        if on_progress:
            on_progress(i + 1, len(rows))
    if len(decoded) < MIN_ITEMS:
        raise MomentError(f"only {len(decoded)} photos could be read — need at least {MIN_ITEMS}")
    # Membership is decided here, where the pixels have actually been looked
    # at; order stays chronological. Blinks go first — a frame held for three
    # seconds on someone mid-blink is the one everyone in it will notice —
    # then the softest, down to what fits. Never below the minimum: a moment
    # made entirely of blinks is still that event, eyes and all.
    blinky = sorted((d for d in decoded if d[3] >= BLINK_MARGIN), key=lambda d: -d[3])
    for d in blinky:
        if len(decoded) <= MIN_ITEMS:
            break
        decoded.remove(d)
    if len(decoded) > MAX_ITEMS:
        floor = sorted(d[2] for d in decoded)[len(decoded) - MAX_ITEMS - 1]
        decoded = [d for d in decoded if d[2] > floor][:MAX_ITEMS]
    kept = [d[0] for d in decoded]
    stills = [d[1] for d in decoded]

    card = _title_card(src, stills[0], os.path.join(workdir, "title.jpg"))
    paths = [card] + stills
    holds = [TITLE_HOLD] + [HOLD] * len(stills)

    graph, last, total = build_graph(len(paths), holds)
    ins: list[str] = []
    for p in paths:
        ins += ["-i", p]

    amaps: list[str] = []
    if track:
        ins += ["-stream_loop", "-1", "-i", str(config.MUSIC_DIR / track["file"])]
        ai = len(paths)
        # trimmed to the montage, faded at both ends, and held well under the
        # pictures — this is a soundtrack, not the point
        graph += (f";[{ai}:a]atrim=0:{total:.3f},asetpts=PTS-STARTPTS,"
                  f"afade=t=in:st=0:d=1.6,afade=t=out:st={max(0, total - 2.2):.3f}:d=2.2,"
                  f"volume=0.34[aout]")
        amaps = ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-shortest"]

    cmd = [config.FFMPEG, "-y", "-v", "error", *ins,
           "-filter_complex", graph, "-map", last, *amaps,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(FPS), out_path]
    res = subprocess.run(cmd, capture_output=True, timeout=900)
    if res.returncode != 0:
        raise MomentError((res.stderr or b"").decode(errors="replace").strip()[-400:]
                          or "ffmpeg failed")
    return total, kept
