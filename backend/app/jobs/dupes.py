"""Near-duplicate detection: all-pairs Hamming distance over 64-bit pHashes.
Popcount via a 16-bit lookup table so it works on numpy 1.x and 2.x alike."""
import asyncio
import time

import numpy as np

from .. import config, db
from .runner import manager

_LUT = np.array([bin(i).count("1") for i in range(1 << 16)], dtype=np.uint8)


def _popcount64(x: np.ndarray) -> np.ndarray:
    r = _LUT[(x & 0xFFFF).astype(np.uint16)].astype(np.uint16)
    r += _LUT[((x >> 16) & 0xFFFF).astype(np.uint16)]
    r += _LUT[((x >> 32) & 0xFFFF).astype(np.uint16)]
    r += _LUT[((x >> 48) & 0xFFFF).astype(np.uint16)]
    return r


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, a: int) -> int:
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


async def run_near_dupes(job_id: int) -> None:
    rows = db.query(
        "SELECT f.id, f.phash, f.size_bytes, m.width, m.height FROM files f "
        "JOIN metadata m ON m.file_id=f.id "
        "WHERE f.status='active' AND f.phash IS NOT NULL AND f.media_type='photo'",
    )
    n = len(rows)
    manager.update(job_id, total=n, message=f"comparing {n} photos…")
    if n < 2:
        manager.finish(job_id, "done", "not enough photos")
        return

    dismissed = {(r["file_id_a"], r["file_id_b"]) for r in db.query("SELECT * FROM dupe_dismissals")}
    pairs = await asyncio.to_thread(_find_pairs, rows, config.NEAR_DUP_MAX_HAMMING)

    uf = _UnionFind(n)
    ids = [r["id"] for r in rows]
    kept_pairs = 0
    for i, j in pairs:
        a, b = sorted((ids[i], ids[j]))
        if (a, b) in dismissed:
            continue
        uf.union(i, j)
        kept_pairs += 1

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(uf.find(i), []).append(i)
    groups = {k: v for k, v in groups.items() if len(v) > 1}

    with db.transaction() as conn:
        conn.execute("DELETE FROM dupe_group_items")
        conn.execute("DELETE FROM dupe_groups WHERE kind='near'")
        now = int(time.time())
        for members in groups.values():
            cur = conn.execute("INSERT INTO dupe_groups (kind, created_at) VALUES ('near', ?)", (now,))
            gid = cur.lastrowid
            best = max(members, key=lambda i: ((rows[i]["width"] or 0) * (rows[i]["height"] or 0),
                                               rows[i]["size_bytes"]))
            conn.executemany(
                "INSERT INTO dupe_group_items (group_id, file_id, is_suggested_keeper) VALUES (?,?,?)",
                [(gid, ids[i], 1 if i == best else 0) for i in members],
            )
    manager.update(job_id, done=n)
    manager.finish(job_id, "done", f"{len(groups)} near-duplicate groups ({kept_pairs} pairs)")


def _find_pairs(rows, max_hamming: int) -> list[tuple[int, int]]:
    hashes = np.array([r["phash"] & 0xFFFFFFFFFFFFFFFF for r in rows], dtype=np.uint64)
    n = len(hashes)
    pairs: list[tuple[int, int]] = []
    ca, cb = 1024, 8192  # ~67 MB peak per XOR block
    for a0 in range(0, n, ca):
        block = hashes[a0:a0 + ca]
        for b0 in range(a0, n, cb):
            rest = hashes[b0:b0 + cb]
            d = _popcount64(block[:, None] ^ rest[None, :])
            bi, ri = np.nonzero(d <= max_hamming)
            for b, r in zip(bi.tolist(), ri.tolist()):
                i, j = a0 + b, b0 + r
                if i < j:
                    pairs.append((i, j))
    return pairs
