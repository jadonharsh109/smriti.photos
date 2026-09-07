"""Ranking a library against a sentence.

Every embedding is unit length, so the whole search is one matrix multiply:
3,000 photos against a query is under a millisecond, and a hundred thousand is
still a few tens. There is no index to build and none to keep in step — the
cost of being exact here is smaller than the cost of approximating it.

The matrix lives in a memory-mapped float16 file beside the database rather
than in RAM. At 300,000 photos a float32 matrix is 614 MB resident, and it was
being rebuilt from the table on every change. The file is written once after
each index run (or lazily on the first search that finds it stale), mapped on
demand, and the OS pages in only what a search touches and gives it back when
memory is short. float16 keeps three significant digits, which is more than
the ranking needs: scores are compared to a cutoff of 0.20 and to each other
at the third decimal.
"""
import json
import os
import threading
import time

import numpy as np

from .. import config, db

_lock = threading.RLock()
_ids: np.ndarray | None = None       # int64, row -> file_id
_mat: np.ndarray | None = None       # float16 (n, CLIP_DIM), memory-mapped
_stamp: tuple | None = None          # what the mapped file was built from
_stamp_cache: tuple[float, tuple] | None = None

_CHUNK = 65536                       # rows per float32 conversion: 128 MB of scratch at most

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
    from . import aggregates

    return aggregates.stats().get("clip_indexed", 0)


# ---- the cache file ---------------------------------------------------------

def _paths():
    d = config.DATA_DIR / "search"
    d.mkdir(parents=True, exist_ok=True)
    base = d / config.CLIP_MODEL
    return base.with_suffix(".f16"), base.with_suffix(".ids.npy"), base.with_suffix(".json")


def _db_stamp() -> tuple:
    """What the table holds, cheaply enough to ask on every search: count,
    highest id and the sum of ids, so a delete-and-insert that keeps the count
    still shows. Cached for two seconds — a search box fires per keystroke."""
    global _stamp_cache
    now = time.monotonic()
    if _stamp_cache and now - _stamp_cache[0] < 2.0:
        return _stamp_cache[1]
    row = db.query_one(
        "SELECT COUNT(*) n, COALESCE(MAX(file_id), 0) hi, COALESCE(SUM(file_id), 0) s "
        "FROM file_clip WHERE model=?", (config.CLIP_MODEL,))
    stamp = (row["n"], row["hi"], row["s"])
    _stamp_cache = (now, stamp)
    return stamp


def _write_cache(stamp: tuple) -> None:
    """Stream the table into the file. Never holds every blob in memory."""
    mat_p, ids_p, meta_p = _paths()
    n = stamp[0]
    tmp = mat_p.with_name(mat_p.name + ".tmp")
    ids = np.empty(n, dtype=np.int64)
    if n:
        mm = np.memmap(tmp, dtype=np.float16, mode="w+", shape=(n, config.CLIP_DIM))
        i = 0
        for r in db.iterate("SELECT file_id, embedding FROM file_clip WHERE model=? ORDER BY file_id",
                            (config.CLIP_MODEL,)):
            if i >= n:
                break            # the table grew under us; the stamp will not match and we rebuild
            mm[i] = np.frombuffer(r["embedding"], dtype=np.float32)
            ids[i] = r["file_id"]
            i += 1
        mm.flush()
        del mm
        if i != n:
            os.unlink(tmp)
            return
        os.replace(tmp, mat_p)
    else:
        mat_p.unlink(missing_ok=True)
    np.save(ids_p, ids)
    meta_p.write_text(json.dumps({"n": n, "dim": config.CLIP_DIM, "stamp": list(stamp)}))


def _matrix() -> tuple[np.ndarray, np.ndarray]:
    """(ids, matrix) for the current table, rebuilding the file if stale."""
    global _ids, _mat, _stamp
    stamp = _db_stamp()
    with _lock:
        if _mat is not None and _stamp == stamp:
            return _ids, _mat
        mat_p, ids_p, meta_p = _paths()
        meta = None
        if meta_p.exists():
            try:
                meta = json.loads(meta_p.read_text())
            except ValueError:
                meta = None
        if (not meta or tuple(meta["stamp"]) != stamp or meta.get("dim") != config.CLIP_DIM
                or (meta["n"] and not mat_p.exists()) or not ids_p.exists()):
            _write_cache(stamp)
            meta = json.loads(meta_p.read_text()) if meta_p.exists() else {"n": 0, "stamp": list(stamp)}
        n = meta["n"]
        if n:
            _mat = np.memmap(mat_p, dtype=np.float16, mode="r", shape=(n, config.CLIP_DIM))
            _ids = np.load(ids_p)
        else:
            _mat = np.zeros((0, config.CLIP_DIM), dtype=np.float16)
            _ids = np.empty(0, dtype=np.int64)
        _stamp = tuple(meta["stamp"])
        return _ids, _mat


def rebuild_cache() -> None:
    """After an index run — in the job's thread, so the first search after
    indexing finds the file ready rather than paying to write it."""
    global _stamp_cache
    _stamp_cache = None
    _matrix()


def invalidate() -> None:
    """After a lock, a delete, or an index run: forget the mapped matrix and
    rebuild the file in the background so the next search does not pay."""
    global _stamp_cache, _stamp
    with _lock:
        _stamp_cache = None
        _stamp = None
    threading.Thread(target=_rebuild_quietly, name="search-cache", daemon=True).start()


def _rebuild_quietly() -> None:
    try:
        _matrix()
    except Exception:  # noqa: BLE001 - a failed background rebuild retries on the next search
        pass


# ---- ranking ----------------------------------------------------------------

def _scores(mat: np.ndarray, q: np.ndarray) -> np.ndarray:
    """mat @ q in float32, a chunk at a time, so a 300,000-row float16 map is
    never expanded to float32 all at once."""
    n = mat.shape[0]
    out = np.empty(n, dtype=np.float32)
    for i in range(0, n, _CHUNK):
        out[i:i + _CHUNK] = np.asarray(mat[i:i + _CHUNK], dtype=np.float32) @ q
    return out


def rank_vector(q: np.ndarray, limit: int = 300, min_score: float | None = None,
                allowed=None, cutoff: bool = False) -> list[tuple[int, float]]:
    """-> [(file_id, score)] best first for a unit query vector.

    `allowed` narrows the ranking to a set decided elsewhere — the photos of one
    person, in one place, in one year. Applied to the matrix before scoring, not
    to the results after: the cutoff is relative to the best hit, and a best hit
    that is about to be filtered out would drag the threshold to the wrong
    place and take the real answers with it.

    `cutoff` applies the floor and the proportional cutoff (see config): on for
    a sentence, where "nothing looks like that" is a real answer; off for
    "more like this one", which always has neighbours."""
    ids, mat = _matrix()
    if ids.size == 0:
        return []
    q = np.asarray(q, dtype=np.float32).reshape(-1)
    n = np.linalg.norm(q)
    if n > 0:
        q = q / n
    if allowed is not None:
        keep = np.flatnonzero(np.isin(ids, np.fromiter(allowed, dtype=np.int64, count=len(allowed))))
        if keep.size == 0:
            return []
        ids = ids[keep]
        scores = np.asarray(mat[keep], dtype=np.float32) @ q
    else:
        scores = _scores(mat, q)
    # argpartition rather than a full sort: only the top slice gets ordered,
    # which is the difference between O(n log n) and O(n) on a large library.
    k = min(limit, ids.size)
    top = np.argpartition(-scores, k - 1)[:k]
    top = top[np.argsort(-scores[top])]
    if cutoff:
        floor = config.CLIP_MIN_SCORE if min_score is None else min_score
        cut = max(floor, float(scores[top[0]]) * config.CLIP_REL_CUTOFF)
        return [(int(ids[i]), float(scores[i])) for i in top if scores[i] >= cut]
    return [(int(ids[i]), float(scores[i])) for i in top]


def rank(query: str, limit: int = 300, min_score: float | None = None,
         allowed: set[int] | None = None) -> list[tuple[int, float]]:
    """-> [(file_id, score)] best first, above the floor, for a sentence."""
    if not query.strip():
        return []
    vecs = engine().encode_text([t.format(query.strip()) for t in _TEMPLATES])
    return rank_vector(vecs.mean(axis=0), limit, min_score, allowed, cutoff=True)
