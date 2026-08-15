"""Face jobs: scan (detect+embed via pool), incremental person assignment, and
explicit re-clustering (HDBSCAN) that preserves names via majority overlap."""
import asyncio
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from .. import config, db
from ..services import cover as cover_svc
from ..services import thumbs
from ..services import volumes as vol_svc
from ..workers import face_worker
from .runner import manager

IN_FLIGHT = 8


def _emb(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


async def run_face_scan(job_id: int) -> None:
    rows = db.query(
        "SELECT f.* FROM files f WHERE f.status='active' AND f.media_type='photo' AND f.face_scanned=0",
    )
    todo = []
    skipped_offline = 0
    for r in rows:
        pv = thumbs.preview_path(r["id"])
        if pv.exists():
            todo.append((r["id"], str(pv)))
            continue
        abs_path = vol_svc.abs_path_for_file(r)
        if abs_path and os.path.exists(abs_path):
            todo.append((r["id"], abs_path))
        else:
            skipped_offline += 1

    manager.update(job_id, total=len(todo),
                   message=f"detecting faces ({skipped_offline} skipped, drive offline)" if skipped_offline
                   else "detecting faces…")
    if not todo:
        manager.finish(job_id, "done", "nothing to scan")
        return

    centroids = _load_centroids()
    touched_persons: set[int] = set()
    pool = ProcessPoolExecutor(
        max_workers=config.FACE_MAX_WORKERS, initializer=face_worker.pool_init,
        initargs=(str(config.FACE_MODEL_DIR), config.FACE_DET_SIZE, config.FACE_DET_SCORE_MIN),
    )
    loop = asyncio.get_running_loop()
    done = errors = found = assigned = 0
    try:
        it = iter(todo)
        pending: set = set()
        exhausted = False
        import time as _t
        last_pub = 0.0
        while True:
            while not exhausted and len(pending) < IN_FLIGHT and not manager.is_cancelled(job_id):
                try:
                    fid, path = next(it)
                    pending.add(loop.run_in_executor(pool, face_worker.process, fid, path))
                except StopIteration:
                    exhausted = True
            if not pending:
                break
            finished, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for fut in finished:
                try:
                    res = fut.result()
                except Exception as e:
                    res = {"ok": False, "error": str(e)}
                done += 1
                if not res.get("ok"):
                    errors += 1
                    continue
                f_found, f_assigned, f_touched = _store_faces(res["file_id"], res["faces"], centroids)
                found += f_found
                assigned += f_assigned
                touched_persons |= f_touched
            if _t.monotonic() - last_pub > 0.5:
                manager.update(job_id, done=done, errors=errors,
                               message=f"{found} faces, {assigned} auto-assigned")
                last_pub = _t.monotonic()
            if manager.is_cancelled(job_id):
                break
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        manager.update(job_id, done=done, errors=errors)

    if manager.is_cancelled(job_id):
        manager.finish(job_id, "cancelled")
    else:
        # newly assigned faces may beat the current covers
        for pid in touched_persons:
            try:
                await asyncio.to_thread(cover_svc.select_cover, pid)
            except Exception:
                pass
        msg = f"{found} faces in {done} photos, {assigned} auto-assigned"
        if not _load_centroids():
            msg += " — run 'Group into people' to cluster"
        manager.finish(job_id, "done", msg)


def _load_centroids():
    rows = db.query("SELECT id, centroid FROM persons WHERE centroid IS NOT NULL")
    if not rows:
        return None
    ids = [r["id"] for r in rows]
    mat = np.stack([_emb(r["centroid"]) for r in rows])
    return ids, mat


def _store_faces(file_id: int, faces: list[dict], centroids) -> tuple[int, int, set[int]]:
    assigned = 0
    touched: set[int] = set()
    with db.transaction() as conn:
        conn.execute("DELETE FROM faces WHERE file_id=?", (file_id,))
        for f in faces:
            person_id, src = None, None
            if centroids is not None:
                ids, mat = centroids
                sims = mat @ _emb(f["embedding"])
                best = int(np.argmax(sims))
                if sims[best] >= config.FACE_MATCH_THRESHOLD:
                    person_id, src = ids[best], "incremental"
                    assigned += 1
                    touched.add(person_id)
            conn.execute(
                "INSERT INTO faces (file_id, x, y, w, h, det_score, embedding, person_id, assign_src, "
                "landmarks, sharpness, brightness, contrast) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (file_id, f["x"], f["y"], f["w"], f["h"], f["score"], f["embedding"], person_id, src,
                 f.get("landmarks"), f.get("sharpness"), f.get("brightness"), f.get("contrast")),
            )
        conn.execute("UPDATE files SET face_scanned=1 WHERE id=?", (file_id,))
    return len(faces), assigned, touched


async def run_recluster(job_id: int) -> None:
    rows = db.query(
        "SELECT fa.id, fa.embedding, fa.person_id, fa.assign_src, fa.det_score, p.name AS person_name "
        "FROM faces fa LEFT JOIN persons p ON p.id=fa.person_id",
    )
    n = len(rows)
    if n < config.FACE_MIN_CLUSTER_SIZE:
        manager.finish(job_id, "done", f"only {n} faces — nothing to cluster")
        return
    manager.update(job_id, total=n, message=f"clustering {n} faces…")

    X = np.stack([_emb(r["embedding"]) for r in rows])
    labels = await asyncio.to_thread(_cluster, X)

    # HDBSCAN over-splits the same person; repair before mapping to persons
    named_by_idx = {i: r["person_id"] for i, r in enumerate(rows) if r["person_id"] and r["person_name"]}
    labels = _merge_split_clusters(X, labels, named_by_idx)
    labels = _adopt_noise(X, labels)

    manual = {r["id"]: r["person_id"] for r in rows if r["assign_src"] == "manual" and r["person_id"]}

    # Majority-overlap remap: keep an existing NAMED person when a new cluster
    # is mostly made of their faces (largest cluster wins per person).
    clusters: dict[int, list[int]] = {}
    for i, lbl in enumerate(labels):
        if lbl >= 0:
            clusters.setdefault(int(lbl), []).append(i)
    named_claim: dict[int, tuple[int, int]] = {}  # old_person_id -> (cluster, votes)
    for lbl, members in clusters.items():
        votes: dict[int, int] = {}
        for i in members:
            r = rows[i]
            if r["person_id"] and r["person_name"]:
                votes[r["person_id"]] = votes.get(r["person_id"], 0) + 1
        for pid, v in votes.items():
            if v > len(members) / 3 and (pid not in named_claim or v > named_claim[pid][1]):
                named_claim[pid] = (lbl, v)
    cluster_to_person = {lbl: pid for pid, (lbl, _) in named_claim.items()}

    with db.transaction() as conn:
        for lbl, members in clusters.items():
            pid = cluster_to_person.get(lbl)
            if pid is None:
                cur = conn.execute("INSERT INTO persons (name) VALUES (NULL)")
                pid = cur.lastrowid
                cluster_to_person[lbl] = pid
            for i in members:
                fid = rows[i]["id"]
                if fid in manual:
                    continue
                conn.execute("UPDATE faces SET person_id=?, assign_src='cluster' WHERE id=?", (pid, fid))
        # noise faces lose auto assignments (manual ones stay)
        for i, lbl in enumerate(labels):
            if lbl < 0 and rows[i]["id"] not in manual:
                conn.execute("UPDATE faces SET person_id=NULL, assign_src=NULL WHERE id=?", (rows[i]["id"],))
        conn.execute(
            "DELETE FROM persons WHERE name IS NULL AND id NOT IN "
            "(SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL)",
        )
    for p in db.query("SELECT id FROM persons"):
        await asyncio.to_thread(recompute_centroid, p["id"])
    manager.update(job_id, done=n)
    manager.finish(job_id, "done", f"{len(clusters)} people from {n} faces")


def _merge_split_clusters(X: np.ndarray, labels: np.ndarray, named_by_idx: dict[int, int]) -> np.ndarray:
    """Union clusters whose centroids are more similar than FACE_MERGE_SIM —
    the same human fragmented by HDBSCAN. Two clusters dominated by
    *different* named people are never auto-merged."""
    uniq = sorted({int(lbl) for lbl in labels if lbl >= 0})
    if len(uniq) < 2:
        return labels
    cents: dict[int, np.ndarray] = {}
    dominant: dict[int, int] = {}  # cluster -> named person id
    for lbl in uniq:
        idx = np.where(labels == lbl)[0]
        c = X[idx].mean(axis=0)
        n = np.linalg.norm(c)
        cents[lbl] = c / n if n else c
        votes: dict[int, int] = {}
        for i in idx:
            pid = named_by_idx.get(int(i))
            if pid:
                votes[pid] = votes.get(pid, 0) + 1
        if votes:
            pid, v = max(votes.items(), key=lambda kv: kv[1])
            if v > len(idx) / 3:
                dominant[lbl] = pid

    parent = {lbl: lbl for lbl in uniq}

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    root_named: dict[int, set[int]] = {lbl: ({dominant[lbl]} if lbl in dominant else set()) for lbl in uniq}
    pairs = []
    for i, a in enumerate(uniq):
        for b in uniq[i + 1:]:
            sim = float(cents[a] @ cents[b])
            if sim >= config.FACE_MERGE_SIM:
                pairs.append((sim, a, b))
    merged = 0
    for _, a, b in sorted(pairs, reverse=True):
        ra, rb = find(a), find(b)
        if ra == rb:
            continue
        na, nb = root_named[ra], root_named[rb]
        if na and nb and na != nb:
            continue  # different named people — leave for a manual merge
        parent[rb] = ra
        root_named[ra] = na | nb
        merged += 1
    if not merged:
        return labels
    out = labels.copy()
    for i, lbl in enumerate(labels):
        if lbl >= 0:
            out[i] = find(int(lbl))
    return out


def _adopt_noise(X: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """Faces HDBSCAN marked as noise still join a person when clearly similar
    to its centroid — the same bar as incremental assignment."""
    uniq = sorted({int(lbl) for lbl in labels if lbl >= 0})
    noise = np.where(labels < 0)[0]
    if not uniq or len(noise) == 0:
        return labels
    cents = []
    for lbl in uniq:
        c = X[np.where(labels == lbl)[0]].mean(axis=0)
        n = np.linalg.norm(c)
        cents.append(c / n if n else c)
    sims = X[noise] @ np.stack(cents).T
    best = sims.argmax(axis=1)
    out = labels.copy()
    for k, i in enumerate(noise):
        if sims[k, best[k]] >= config.FACE_MATCH_THRESHOLD:
            out[i] = uniq[int(best[k])]
    return out


def _cluster(X: np.ndarray) -> np.ndarray:
    from sklearn.cluster import HDBSCAN

    if X.shape[0] > 20000:  # high-dim HDBSCAN degrades; PCA keeps it tractable
        from sklearn.decomposition import PCA

        X = PCA(n_components=128, random_state=0).fit_transform(X)
    return HDBSCAN(min_cluster_size=config.FACE_MIN_CLUSTER_SIZE, metric="euclidean").fit_predict(X)


def recompute_centroid(person_id: int) -> None:
    rows = db.query("SELECT fa.embedding FROM faces fa WHERE fa.person_id=?", (person_id,))
    if not rows:
        db.execute("UPDATE persons SET centroid=NULL, cover_face_id=NULL WHERE id=?", (person_id,))
        return
    mat = np.stack([_emb(r["embedding"]) for r in rows])
    c = mat.mean(axis=0)
    norm = np.linalg.norm(c)
    if norm > 0:
        c = c / norm
    db.execute("UPDATE persons SET centroid=? WHERE id=?",
               (c.astype(np.float32).tobytes(), person_id))
    # cover selection reads the fresh centroid for its typicality signal
    cover_svc.select_cover(person_id)


async def run_recompute_covers(job_id: int) -> None:
    """Re-pick every person's cover with the quality scorer — useful after an
    upgrade or when previews became available for a previously offline drive."""
    ids = [r["id"] for r in db.query("SELECT id FROM persons")]
    manager.update(job_id, total=len(ids), message="choosing cover photos…")
    done = errors = 0
    for pid in ids:
        if manager.is_cancelled(job_id):
            manager.finish(job_id, "cancelled")
            return
        try:
            await asyncio.to_thread(cover_svc.select_cover, pid)
        except Exception:
            errors += 1
        done += 1
        manager.update(job_id, done=done, errors=errors)
    manager.finish(job_id, "done", f"covers refreshed for {done} people")
