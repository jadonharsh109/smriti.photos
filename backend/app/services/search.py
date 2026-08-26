"""Ranking a library against a sentence.

Every embedding is unit length, so the whole search is one matrix multiply:
3,000 photos against a query is under a millisecond, and a hundred thousand is
still a few. There is no index to build and none to keep in step — the cost of
being exact here is smaller than the cost of approximating it.

The matrix is cached in memory and rebuilt when the table changes underneath
it, because loading it is the only slow part and a search box is typed into
one keystroke at a time.
"""
import threading

import numpy as np

from .. import config, db

_lock = threading.Lock()
_cache: tuple[list[int], np.ndarray] | None = None
_stamp: tuple[int, int] | None = None   # (rows, max file_id) — cheap change detector

# CLIP was trained on captions, not search queries, so a bare word lands
# slightly off the distribution it knows. Asking the same thing a few ways and
# averaging is the standard fix and costs one batched call on a 512-wide model.
_TEMPLATES = ("a photo of {}.", "{}", "a photo of the {}.")

_engine = None


def engine():
    global _engine
    if _engine is None:
        from .clip_engine import ClipEngine

        _engine = ClipEngine(config.CLIP_MODEL_DIR)
    return _engine


def ready() -> bool:
    """Models on disk *and* something indexed — either missing means the search
    box can only disappoint, so the UI asks this before offering one."""
    from ..fetch_clip import present

    return present() and indexed_count() > 0


def indexed_count() -> int:
    return db.query_one("SELECT COUNT(*) n FROM file_clip WHERE model=?",
                        (config.CLIP_MODEL,))["n"]


def _matrix() -> tuple[list[int], np.ndarray]:
    global _cache, _stamp
    row = db.query_one(
        "SELECT COUNT(*) n, COALESCE(MAX(file_id), 0) hi FROM file_clip WHERE model=?",
        (config.CLIP_MODEL,))
    stamp = (row["n"], row["hi"])
    with _lock:
        if _cache is not None and _stamp == stamp:
            return _cache
        rows = db.query("SELECT file_id, embedding FROM file_clip WHERE model=?",
                        (config.CLIP_MODEL,))
        ids = [r["file_id"] for r in rows]
        mat = (np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
               if rows else np.zeros((0, config.CLIP_DIM), dtype=np.float32))
        _cache, _stamp = (ids, mat), stamp
        return _cache


def invalidate() -> None:
    """After a scan or a delete, so the next search reloads rather than ranking
    against photos that are no longer there."""
    global _cache, _stamp
    with _lock:
        _cache, _stamp = None, None


def rank(query: str, limit: int = 300, min_score: float | None = None) -> list[tuple[int, float]]:
    """-> [(file_id, score)] best first, above the floor."""
    ids, mat = _matrix()
    if not ids or not query.strip():
        return []
    floor = config.CLIP_MIN_SCORE if min_score is None else min_score
    vecs = engine().encode_text([t.format(query.strip()) for t in _TEMPLATES])
    q = vecs.mean(axis=0)
    n = np.linalg.norm(q)
    if n > 0:
        q = q / n
    scores = mat @ q
    # argpartition rather than a full sort: only the top slice gets ordered,
    # which is the difference between O(n log n) and O(n) on a large library.
    k = min(limit, len(ids))
    top = np.argpartition(-scores, k - 1)[:k]
    top = top[np.argsort(-scores[top])]
    best = float(scores[top[0]])
    cut = max(floor, best * config.CLIP_REL_CUTOFF)
    return [(ids[i], float(scores[i])) for i in top if scores[i] >= cut]
