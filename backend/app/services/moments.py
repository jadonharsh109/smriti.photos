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
    "SELECT f.id, f.media_type, m.taken_at, q.sharpness "
    "FROM files f JOIN metadata m ON m.file_id = f.id "
    "LEFT JOIN file_quality q ON q.file_id = f.id "
    "WHERE f.status='active' AND f.media_type='photo' AND m.taken_at IS NOT NULL "
    "AND f.id NOT IN (SELECT file_id FROM locked_items) "
    # the movie half of a Live Photo is not a photograph anyone took
    "AND f.id NOT IN (SELECT video_file_id FROM file_motion WHERE video_file_id IS NOT NULL) "
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


def _still(row, dest: str) -> str | None:
    """A photo, decoded here rather than by ffmpeg.

    Originals are HEIC as often as not and the bundled ffmpeg cannot read them;
    Pillow can, with pillow_heif registered. Decoding here also means a moment
    can be made of photos whose drive is not plugged in, off the cached
    preview — the same trick that lets them be searchable."""
    from PIL import Image, ImageOps

    src = None
    for p in (thumbs.preview_path(row["id"]), thumbs.thumb_path(row["id"])):
        if p.exists():
            src = str(p)
            break
    if src is None:
        ap = vol_svc.abs_path_for_file(db.query_one("SELECT * FROM files WHERE id=?", (row["id"],)))
        if ap and os.path.exists(ap):
            src = ap
    if src is None:
        return None
    try:
        img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    except Exception:
        return None
    # twice the output size, so the slow zoom never runs out of pixels;
    # framed slightly above centre because that is where faces are
    img = ImageOps.fit(img, (W * 2, H * 2), Image.LANCZOS, centering=(0.5, 0.42))
    img.save(dest, "JPEG", quality=92)
    return dest


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
        # same way, which reads as a camera fault rather than a choice
        z = ("min(1+0.0016*on,1.13)" if i % 2 == 0 else "max(1.13-0.0016*on,1.0)")
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
           workdir: str, on_progress=None) -> float:
    """Render the montage. Returns its duration in seconds."""
    os.makedirs(workdir, exist_ok=True)
    stills, kept = [], []
    for i, r in enumerate(rows):
        p = _still(r, os.path.join(workdir, f"{i:03d}.jpg"))
        if p:
            stills.append(p)
            kept.append(r)
        if on_progress:
            on_progress(i + 1, len(rows))
    if len(stills) < MIN_ITEMS:
        raise MomentError(f"only {len(stills)} photos could be read — need at least {MIN_ITEMS}")

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
    return total
