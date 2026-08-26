"""Search the library by what is in the picture.

Everything here runs on this machine: the query is encoded by a model in the
data dir and compared against embeddings in the local index. Nothing about
what someone searches for, or what came back, leaves the machine — which is
the only reason a photo library gets to have this at all without also handing
someone else a log of what its owner looks for.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db
from ..fetch_clip import NEEDED, TOTAL_MB, present
from ..jobs.runner import manager
from ..services import favourites, search as search_svc

router = APIRouter()

# The same row shape every grid renders, so results drop straight into it.
_ITEM_SQL = (
    "SELECT f.id, f.media_type, m.width, m.height, m.duration_s, "
    "substr(m.taken_at, 1, 10) AS day, "
    "EXISTS (SELECT 1 FROM file_motion mo WHERE mo.file_id = f.id) AS live, "
    "EXISTS (SELECT 1 FROM album_items af "
    "        WHERE af.file_id = f.id AND af.album_id = {fav}) AS fav "
    "FROM files f LEFT JOIN metadata m ON m.file_id = f.id "
    "WHERE f.id IN ({ids}) AND f.status='active' "
    "AND f.id NOT IN (SELECT file_id FROM locked_items)"
)


@router.get("/search")
def search(q: str, limit: int = 200):
    """Rank every indexed photo against `q` and return the best.

    Locked photos are filtered after ranking rather than before: the ranking
    is a matrix multiply over everything, and taking them out here is one
    cheap clause instead of rebuilding the matrix per request. They never
    reach the response either way."""
    q = (q or "").strip()
    if not q:
        return {"query": "", "items": [], "indexed": search_svc.indexed_count()}
    if not present():
        raise HTTPException(400, "the search model isn’t downloaded yet")
    ranked = search_svc.rank(q, limit=max(1, min(limit, 500)))
    if not ranked:
        return {"query": q, "items": [], "indexed": search_svc.indexed_count()}

    order = {fid: i for i, (fid, _) in enumerate(ranked)}
    scores = dict(ranked)
    ids = ",".join(str(fid) for fid in order)   # our own row ids, never client text
    rows = db.query(_ITEM_SQL.format(fav=favourites.album_id(), ids=ids))
    items = [dict(r) | {"score": round(scores[r["id"]], 4)} for r in rows]
    # SQLite returned them in whatever order it liked; the ranking is the point.
    items.sort(key=lambda it: order[it["id"]])
    return {"query": q, "items": items, "indexed": search_svc.indexed_count()}


@router.get("/search/status")
def status():
    """What the search box should say about itself before anyone types."""
    total = db.query_one("SELECT COUNT(*) n FROM files WHERE status='active'")["n"]
    from ..jobs import clip as clip_job

    return {
        "model_ready": present(),
        "model_mb": TOTAL_MB,
        "indexed": search_svc.indexed_count(),
        "pending": clip_job.pending_count(),
        "total": total,
        "ready": search_svc.ready(),
    }


@router.post("/search/models/download")
def download_models():
    """Fetch the CLIP models (~218 MB). The desktop app has no CLI, so this
    endpoint is the only way to enable search there."""
    from ..jobs import search_models

    if manager.any_running("search_models"):
        raise HTTPException(409, "the download is already running")
    if present():
        return {"ok": True, "already_present": True}
    job_id = manager.create("search_models")
    manager.start(job_id, search_models.run_download(job_id))
    return {"job_id": job_id}


@router.post("/search/index")
def build_index():
    """Embed everything not yet embedded."""
    from ..jobs import clip as clip_job

    if manager.any_running("search_index"):
        raise HTTPException(409, "indexing is already running")
    if not present():
        raise HTTPException(400, f"download the search model first (~{TOTAL_MB} MB)")
    missing = [n for n in NEEDED if not (config.CLIP_MODEL_DIR / n).exists()]
    if missing:
        raise HTTPException(400, f"the search model is incomplete — missing {', '.join(missing)}")
    job_id = manager.create("search_index")
    manager.start(job_id, _index_then_invalidate(job_id, clip_job))
    return {"job_id": job_id}


async def _index_then_invalidate(job_id: int, clip_job):
    try:
        await clip_job.run_clip_scan(job_id)
    finally:
        # the cached matrix is now missing everything the job just added
        search_svc.invalidate()


class SimilarIn(BaseModel):
    file_id: int


@router.post("/search/similar")
def similar(body: SimilarIn, limit: int = 60):
    """More like this one — the same ranking with a photo as the query.

    Free, given the index: an image embedding and a text embedding live in the
    same space, so the thing being matched against can be either."""
    import numpy as np

    row = db.query_one("SELECT embedding FROM file_clip WHERE file_id=? AND model=?",
                       (body.file_id, config.CLIP_MODEL))
    if not row:
        raise HTTPException(404, "that photo hasn’t been indexed for search yet")
    ids, mat = search_svc._matrix()
    if not ids:
        return {"items": []}
    scores = mat @ np.frombuffer(row["embedding"], dtype=np.float32)
    k = min(limit + 1, len(ids))
    top = np.argpartition(-scores, k - 1)[:k]
    top = sorted(top, key=lambda i: -scores[i])
    ranked = [(ids[i], float(scores[i])) for i in top if ids[i] != body.file_id][:limit]
    if not ranked:
        return {"items": []}
    order = {fid: i for i, (fid, _) in enumerate(ranked)}
    scored = dict(ranked)
    rows = db.query(_ITEM_SQL.format(fav=favourites.album_id(),
                                     ids=",".join(str(f) for f in order)))
    items = [dict(r) | {"score": round(scored[r["id"]], 4)} for r in rows]
    items.sort(key=lambda it: order[it["id"]])
    return {"items": items}
