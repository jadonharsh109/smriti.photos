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
from ..services import favourites, filters, query_parse, search as search_svc

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
    """Answer a query with whichever half of the library can answer it.

    A sentence is usually more than one question. "solo photos of yash in goa
    in 2024" names a person the library has clustered, a place it has geocoded
    and a year it has recorded — all exact — and possibly also describes what
    the picture looks like, which only the model can judge. So the query is
    split: the exact parts become a filter, and only what is left goes to CLIP,
    which ranks *within* what the filter returned.

    That ordering matters both ways. Sending a name to CLIP returns strangers,
    because it has never seen one. And filtering after ranking would let the
    200-best-looking photos in the library decide which of this person's photos
    you get to see."""
    q = (q or "").strip()
    limit = max(1, min(limit, 500))
    if not q:
        return {"query": "", "items": [], "chips": [], "indexed": search_svc.indexed_count()}

    parsed = query_parse.parse(q)
    # A query with nothing left over for the model needs no model at all —
    # names, places and dates are answerable on a machine that never downloaded
    # one, and refusing them for want of a 219 MB file would be absurd.
    if parsed.text and not present():
        if not parsed.has_filters:
            raise HTTPException(400, "the search model isn’t downloaded yet")
        raise HTTPException(
            400, f"“{parsed.text}” needs the search model — download it, or search "
                 "by name, place or date alone")

    allowed = None
    if parsed.has_filters:
        joins, where, params = filters.build(**parsed.filter_kwargs())
        allowed = {r["id"] for r in
                   db.query(f"SELECT f.id FROM files f {joins} WHERE {where}", params)}
        if not allowed:
            return {"query": q, "items": [], "chips": parsed.chips,
                    "indexed": search_svc.indexed_count()}

    if parsed.text:
        ranked = search_svc.rank(parsed.text, limit=limit, allowed=allowed)
        order = {fid: i for i, (fid, _) in enumerate(ranked)}
        scores = dict(ranked)
    else:
        # Nothing to rank by. The filter *is* the answer, so give it back the
        # way every other grid does — newest first.
        order, scores = {fid: 0 for fid in allowed}, {}
    if not order:
        return {"query": q, "items": [], "chips": parsed.chips,
                "indexed": search_svc.indexed_count()}

    ids = ",".join(str(fid) for fid in order)   # our own row ids, never client text
    rows = db.query(_ITEM_SQL.format(fav=favourites.album_id(), ids=ids))
    items = [dict(r) | ({"score": round(scores[r["id"]], 4)} if scores else {}) for r in rows]
    if scores:
        # SQLite returned them in whatever order it liked; the ranking is the point.
        items.sort(key=lambda it: order[it["id"]])
    else:
        items.sort(key=lambda it: (it["day"] or "", it["id"]), reverse=True)
    return {"query": q, "items": items[:limit], "chips": parsed.chips,
            "indexed": search_svc.indexed_count()}


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
