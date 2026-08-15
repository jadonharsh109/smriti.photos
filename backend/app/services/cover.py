"""Automatic person cover selection.

Scores every face of a person on the signals that make a good cover photo —
detection confidence, face size in frame, pixel resolution, distance from the
frame edges (no chopped foreheads/chins), composition, frontal pose (from the
5-point landmarks), sharpness, lighting, whether the person is the primary
subject of the photo, and how typical the face is of the person (embedding
similarity to the centroid, which demotes occluded faces — sunglasses, masks,
hands — since those embed far from the person's average).

Scoring is two-stage: everything except sharpness/lighting comes straight from
the DB. Faces scanned before quality metrics existed get their sharpness and
lighting backfilled lazily from the preview, but only for the handful of
top-ranked candidates, so re-picking covers never turns into a full re-scan.
Near-identical shots (burst duplicates, by pHash) don't crowd out distinct
candidates from the backfill budget.
"""
import os

import numpy as np

from .. import db
from . import thumbs
from . import volumes as vol_svc

CANDIDATES = 8          # candidates that get the (possibly image-loading) full score
PHASH_DUPE_DIST = 4     # hamming distance at or under which two files are "the same shot"
NEUTRAL = 0.55          # stand-in for sharpness/lighting scores we haven't measured yet


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


# -- individual signals (each roughly 0..1, floored so no single soft signal
#    can zero a candidate outright) -------------------------------------------

def _confidence_score(det: float | None) -> float:
    return _clamp(((det or 0.0) - 0.5) / 0.4, 0.05, 1.0)


def _size_score(h_frac: float) -> float:
    """Face height as a fraction of the frame. Cropping fixes 'too zoomed out'
    later, so small faces are only mildly penalized (they're usually background
    subjects); extreme close-ups are as well (they tend to be clipped)."""
    if h_frac <= 0.04:
        return 0.25
    if h_frac < 0.12:
        return 0.25 + 0.75 * (h_frac - 0.04) / 0.08
    if h_frac <= 0.55:
        return 1.0
    if h_frac <= 0.90:
        return 1.0 - 0.5 * (h_frac - 0.55) / 0.35
    return 0.5


def _resolution_score(face_px: float | None) -> float:
    """Face height in source pixels; a cover crop upscales anything below
    ~200px, and below ~40px there's no face to show at all."""
    if face_px is None:
        return 0.7
    if face_px < 40:
        return 0.05
    return _clamp(0.2 + 0.8 * (face_px - 40) / 160, 0.05, 1.0)


def _visibility_score(x: float, y: float, w: float, h: float) -> float:
    """Margin between the bbox and the frame edges, in face-size units. A face
    at the very edge is almost certainly missing forehead, chin or an ear."""
    margin = min(x, y, 1.0 - (x + w), 1.0 - (y + h))
    if margin < 0.005:
        return 0.15
    rel = margin / max(w, h, 1e-6)
    return _clamp(0.4 + 0.6 * rel / 0.3, 0.15, 1.0)


def _centering_score(cx: float, cy: float) -> float:
    """Gentle: the crop re-centers anyway, but a well-composed original tends
    to be a deliberate photo of the person. Ideal is slightly above center."""
    d = ((cx - 0.5) ** 2 + (0.7 * (cy - 0.45)) ** 2) ** 0.5
    return 1.0 - 0.6 * _clamp(d / 0.5)


def _frontality_score(lm_px: np.ndarray | None) -> float:
    """Pose from the 5 landmarks (eyes, nose, mouth corners): penalize yaw
    (nose off the eye midline), roll (tilted eye line) and profiles (eyes
    collapse together relative to the eye-mouth distance)."""
    if lm_px is None:
        return 0.7  # unknown (pre-migration face): neutral
    eye_l, eye_r, nose, m_l, m_r = lm_px
    inter = float(np.linalg.norm(eye_r - eye_l))
    eye_mid = (eye_l + eye_r) / 2
    mouth_mid = (m_l + m_r) / 2
    em = float(np.linalg.norm(mouth_mid - eye_mid))
    if inter < 1e-6 or em < 1e-6:
        return 0.3
    roll = float(np.arctan2(eye_r[1] - eye_l[1], eye_r[0] - eye_l[0]))
    # de-rotate so yaw is measured across the actual eye line
    c, s = np.cos(-roll), np.sin(-roll)
    R = np.array([[c, -s], [s, c]])
    nose_r, eye_mid_r = R @ nose, R @ eye_mid
    yaw = abs(float(nose_r[0] - eye_mid_r[0])) / inter
    yaw_score = 1.0 - _clamp((yaw - 0.08) / 0.45)
    roll_deg = abs(np.degrees(roll))
    roll_deg = min(roll_deg, 180 - roll_deg)  # upside-down counts as 0-ish roll direction-wise
    roll_score = 1.0 - _clamp((roll_deg - 10) / 50)
    profile_score = _clamp((inter / em - 0.35) / 0.35)
    return _clamp(yaw_score * roll_score * profile_score, 0.05, 1.0)


def _sharpness_score(sharpness: float | None) -> float:
    if sharpness is None:
        return NEUTRAL
    return _clamp(np.log1p(max(sharpness, 0.0)) / np.log1p(250.0), 0.05, 1.0)


def _lighting_score(brightness: float | None, contrast: float | None) -> float:
    if brightness is None:
        return NEUTRAL
    b = brightness
    if b < 40:
        b_score = 0.15
    elif b < 105:
        b_score = 0.3 + 0.7 * (b - 40) / 65
    elif b <= 170:
        b_score = 1.0
    elif b <= 220:
        b_score = 1.0 - 0.6 * (b - 170) / 50
    else:
        b_score = 0.15
    c_score = _clamp((contrast or 0.0) / 40, 0.2, 1.0)
    return b_score * (0.6 + 0.4 * c_score)


def _dominance_score(area: float, other_areas: list[float]) -> float:
    """Solo portrait is ideal; the clear primary subject of a group shot is
    fine; a background face among bigger ones is a poor cover."""
    if not other_areas:
        return 1.0
    rel = area / max(max(other_areas), 1e-6)
    score = _clamp(0.45 + 0.22 * float(np.log2(max(rel, 1e-6))), 0.12, 0.92)
    if len(other_areas) >= 4:
        score *= 0.85
    return score


def _typicality_score(sim: float | None) -> float:
    if sim is None:
        return 1.0
    return _clamp((sim - 0.1) / 0.5, 0.1, 1.0)


# -- scoring ------------------------------------------------------------------

def _landmarks_px(row: dict) -> np.ndarray | None:
    blob = row.get("landmarks")
    if not blob:
        return None
    lm = np.frombuffer(blob, dtype=np.float32)
    if lm.size != 10 or not np.isfinite(lm).all():
        return None
    W = row.get("img_w") or 1000
    H = row.get("img_h") or 1000
    return lm.reshape(5, 2) * np.array([W, H], dtype=np.float32)


def _score_face(row: dict, other_areas: list[float], sim: float | None) -> float:
    x, y = float(row["x"] or 0), float(row["y"] or 0)
    w, h = float(row["w"] or 0), float(row["h"] or 0)
    face_px = h * row["img_h"] if row.get("img_h") else None
    return (
        _confidence_score(row["det_score"])
        * _size_score(h)
        * _resolution_score(face_px)
        * _visibility_score(x, y, w, h)
        * _centering_score(x + w / 2, y + h / 2)
        * _frontality_score(_landmarks_px(row))
        * _sharpness_score(row.get("sharpness"))
        * _lighting_score(row.get("brightness"), row.get("contrast"))
        * _dominance_score(w * h, other_areas)
        * _typicality_score(sim)
    )


def _phash_dist(a: int | None, b: int | None) -> int | None:
    if a is None or b is None:
        return None
    return bin((a ^ b) & 0xFFFFFFFFFFFFFFFF).count("1")


def _backfill_metrics(row: dict) -> None:
    """Measure sharpness/lighting for a pre-migration face from the preview
    (or original), mirroring the scan-time measurement: a ~112px aligned-ish
    crop of the face region. Persists whatever it finds; silently keeps NULL
    when no pixels are reachable (offline drive, no preview)."""
    from PIL import Image, ImageOps

    from .face_engine import face_quality_metrics

    img = None
    pv = thumbs.preview_path(row["file_id"])
    if pv.exists():
        try:
            img = Image.open(pv)
            img.load()
        except Exception:
            img = None
    if img is None:
        file_row = db.query_one("SELECT * FROM files WHERE id=?", (row["file_id"],))
        abs_path = vol_svc.abs_path_for_file(file_row) if file_row else None
        if abs_path and os.path.exists(abs_path):
            img = thumbs._decode_full(abs_path)
            if img is not None:
                img = ImageOps.exif_transpose(img)
    if img is None:
        return
    if img.mode != "RGB":
        img = img.convert("RGB")
    W, H = img.size
    x, y = float(row["x"] or 0) * W, float(row["y"] or 0) * H
    w, h = float(row["w"] or 0) * W, float(row["h"] or 0) * H
    if w < 4 or h < 4:
        return
    mx, my = w * 0.1, h * 0.1
    box = (max(0, int(x - mx)), max(0, int(y - my)),
           min(W, int(x + w + mx)), min(H, int(y + h + my)))
    crop = img.crop(box).resize((112, 112), Image.BILINEAR)
    m = face_quality_metrics(np.asarray(crop, dtype=np.uint8))
    row.update(m)
    db.execute("UPDATE faces SET sharpness=?, brightness=?, contrast=? WHERE id=?",
               (m["sharpness"], m["brightness"], m["contrast"], row["id"]))


def select_cover(person_id: int) -> int | None:
    """Pick and persist the best cover face for a person. Also refreshes the
    cached per-face `quality` used for ordering face lists."""
    rows = [dict(r) for r in db.query(
        "SELECT fa.id, fa.file_id, fa.x, fa.y, fa.w, fa.h, fa.det_score, fa.landmarks, "
        "fa.sharpness, fa.brightness, fa.contrast, "
        "m.width AS img_w, m.height AS img_h, f.phash "
        "FROM faces fa JOIN files f ON f.id=fa.file_id "
        "LEFT JOIN metadata m ON m.file_id=fa.file_id "
        "WHERE fa.person_id=? AND f.status='active'",
        (person_id,),
    )]
    if not rows:
        db.execute("UPDATE persons SET cover_face_id=NULL WHERE id=?", (person_id,))
        return None

    # every face in the candidate photos, for the dominance signal
    file_ids = {r["file_id"] for r in rows}
    marks = ",".join("?" * len(file_ids))
    areas_by_file: dict[int, list[tuple[int, float]]] = {}
    for r in db.query(f"SELECT id, file_id, w, h FROM faces WHERE file_id IN ({marks})",
                      tuple(file_ids)):
        areas_by_file.setdefault(r["file_id"], []).append(
            (r["id"], float(r["w"] or 0) * float(r["h"] or 0)))

    # typicality: similarity to the person centroid, when one exists
    sims: dict[int, float] = {}
    person = db.query_one("SELECT centroid FROM persons WHERE id=?", (person_id,))
    if person and person["centroid"]:
        centroid = np.frombuffer(person["centroid"], dtype=np.float32)
        emb_rows = db.query("SELECT id, embedding FROM faces WHERE person_id=?", (person_id,))
        for r in emb_rows:
            sims[r["id"]] = float(centroid @ np.frombuffer(r["embedding"], dtype=np.float32))

    def others(r: dict) -> list[float]:
        return [a for fid, a in areas_by_file.get(r["file_id"], []) if fid != r["id"]]

    scored = [(_score_face(r, others(r), sims.get(r["id"])), r) for r in rows]
    scored.sort(key=lambda t: t[0], reverse=True)

    # full scoring for the top candidates, skipping near-identical shots
    candidates: list[dict] = []
    for _, r in scored:
        if len(candidates) >= CANDIDATES:
            break
        if any(r["file_id"] != c["file_id"]
               and (d := _phash_dist(r["phash"], c["phash"])) is not None
               and d <= PHASH_DUPE_DIST for c in candidates):
            continue
        candidates.append(r)
    for r in candidates:
        if r.get("sharpness") is None:
            try:
                _backfill_metrics(r)
            except Exception:
                pass

    quality = {r["id"]: s for s, r in scored}
    best_id, best_q = None, -1.0
    for r in candidates:
        q = _score_face(r, others(r), sims.get(r["id"]))
        quality[r["id"]] = q
        if q > best_q:
            best_id, best_q = r["id"], q

    with db.transaction() as conn:
        conn.executemany("UPDATE faces SET quality=? WHERE id=?",
                         [(q, fid) for fid, q in quality.items()])
        conn.execute("UPDATE persons SET cover_face_id=? WHERE id=?", (best_id, person_id))
    return best_id
