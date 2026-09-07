"""The numbers every page opens with, kept rather than recomputed.

Opening Photos asks for the list of days; opening People asks how many photos
each person is in; Places wants a count and a cover per city; the sidebar's
totals want a dozen COUNTs. On a 300,000-file library each of those was a
scan of the library on every visit — 260 to 730 ms a page, measured — and a
correlated subquery per row, which SQLite's planner handles badly enough that
adding one index once turned the events query from half a second into one
that did not finish.

So they are stored. `day_buckets`, `persons.photo_count`, `events.item_count`,
`place_summary`, `place_points` and `library_stats` are written here and read
by the endpoints as plain rows. Three things refresh them:

  * `after_job(kind)` — when a job finishes, whatever it could have changed.
    The job runner calls it off the event loop, then republishes the job so
    the UI refetches once the numbers are current.
  * `files_changed(ids)` — a request handler locked, unlocked, reclassified
    or deleted a handful of files. Refreshes only the days, people, events and
    places those files touch, so the request stays quick.
  * `refresh_all()` — everything, for bulk changes and the first start after
    the migration that introduced the tables.

Every refresh reads and writes inside one transaction on the writer, so a job
committing rows meanwhile cannot slip between the count and the store.
`scripts/bench.py verify` exercises the incremental paths against a rebuild
from scratch and reports any drift.
"""
import os
import threading
import time

from .. import config, db

# What the generated views (timeline, people, places, events) consider shown.
# Curated views — albums, a person's page, the Documents page, search — relax
# the doc clause themselves; see services/filters.py.
VISIBLE = "f.status = 'active' AND f.locked = 0 AND f.doc = 0 AND f.livecomp = 0"
_AR = "SUM(CAST(COALESCE(m.width, 3) AS REAL) / COALESCE(NULLIF(m.height, 0), 2))"
SCOPES = ("all", "photo", "video", "live")

_CHUNK = 400   # ids per IN (...) clause; well under SQLite's variable limit


def _chunks(seq, n=_CHUNK):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---- days -------------------------------------------------------------------

def _day_rows(conn, day_filter: str = "", params=()):
    return conn.execute(
        f"SELECT m.day, f.media_type, f.live, COUNT(*) AS n, {_AR} AS ar "
        f"FROM files f JOIN metadata m ON m.file_id = f.id "
        f"WHERE {VISIBLE} AND m.day IS NOT NULL {day_filter} "
        f"GROUP BY m.day, f.media_type, f.live",
        params,
    ).fetchall()


def _scoped(rows) -> list[tuple]:
    """One GROUP BY covers all four scopes: 'all' is everything, 'photo' and
    'video' split it, 'live' is the stills that carry a motion clip."""
    out: dict[tuple[str, str], list] = {}

    def add(scope: str, day: str, n: int, ar: float) -> None:
        cur = out.setdefault((scope, day), [0, 0.0])
        cur[0] += n
        cur[1] += ar or 0.0

    for r in rows:
        add("all", r["day"], r["n"], r["ar"])
        add(r["media_type"], r["day"], r["n"], r["ar"])
        if r["live"]:
            add("live", r["day"], r["n"], r["ar"])
    return [(s, d, n, round(ar, 3)) for (s, d), (n, ar) in out.items()]


_days_version = 0   # bumped on every write to day_buckets; the timeline caches on it


def days_version() -> int:
    return _days_version


def rebuild_days() -> None:
    global _days_version
    with db.transaction() as conn:
        rows = _scoped(_day_rows(conn))
        conn.execute("DELETE FROM day_buckets")
        conn.executemany("INSERT INTO day_buckets (scope, day, n, ar) VALUES (?,?,?,?)", rows)
    _days_version += 1


def refresh_days(days) -> None:
    """Recompute just these days, in every scope."""
    global _days_version
    days = sorted({d for d in days if d})
    for chunk in _chunks(days):
        marks = ",".join("?" * len(chunk))
        with db.transaction() as conn:
            rows = _scoped(_day_rows(conn, f"AND m.day IN ({marks})", chunk))
            conn.execute(f"DELETE FROM day_buckets WHERE day IN ({marks})", chunk)
            conn.executemany("INSERT INTO day_buckets (scope, day, n, ar) VALUES (?,?,?,?)", rows)
    _days_version += 1


def days_of(file_ids) -> set[str]:
    out: set[str] = set()
    for chunk in _chunks(file_ids):
        marks = ",".join("?" * len(chunk))
        out |= {r["day"] for r in db.query(
            f"SELECT day FROM metadata WHERE file_id IN ({marks}) AND day IS NOT NULL", chunk)}
    return out


# ---- people -----------------------------------------------------------------

def refresh_people(person_ids=None) -> None:
    """Counts and covers. A cover someone chose by hand stands while the face
    is still this person's and can still be shown; otherwise the best visible
    face is picked, scored like jobs/faces.py — big, confident, preferably
    alone in the frame. (Squared to stay in SQL without sqrt(): the order is
    the same.)"""
    with db.transaction() as conn:
        if person_ids is None:
            conn.execute("UPDATE persons SET photo_count = 0")
            scope, params = "", ()
        else:
            ids = list(person_ids)
            if not ids:
                return
            marks = ",".join("?" * len(ids))
            conn.execute(f"UPDATE persons SET photo_count = 0 WHERE id IN ({marks})", ids)
            scope, params = f"AND fa.person_id IN ({marks})", tuple(ids)
        counts = conn.execute(
            "SELECT fa.person_id AS pid, COUNT(DISTINCT fa.file_id) AS n FROM faces fa "
            "JOIN files f ON f.id = fa.file_id "
            f"WHERE fa.person_id IS NOT NULL AND f.status = 'active' AND f.locked = 0 {scope} "
            "GROUP BY fa.person_id", params).fetchall()
        conn.executemany("UPDATE persons SET photo_count = ? WHERE id = ?",
                         [(r["n"], r["pid"]) for r in counts])

        pscope = scope.replace("fa.person_id", "p.id")
        stale = [r["id"] for r in conn.execute(
            "SELECT p.id FROM persons p "
            "LEFT JOIN faces fa ON fa.id = p.cover_face_id "
            "LEFT JOIN files f ON f.id = fa.file_id "
            f"WHERE p.photo_count > 0 {pscope} AND (p.cover_face_id IS NULL OR fa.person_id IS NOT p.id "
            "OR f.status IS NOT 'active' OR f.locked IS NOT 0)", params).fetchall()]
        for chunk in _chunks(stale):
            marks = ",".join("?" * len(chunk))
            best = conn.execute(
                "SELECT person_id, id FROM ("
                " SELECT fa.person_id, fa.id, ROW_NUMBER() OVER (PARTITION BY fa.person_id ORDER BY "
                "  fa.det_score * fa.det_score * MAX(fa.w * fa.h, 0.000001) "
                "  * (CASE WHEN nf.n = 1 THEN 2.25 ELSE 1.0 END) DESC) AS rn "
                " FROM faces fa JOIN files f ON f.id = fa.file_id "
                " JOIN (SELECT file_id, COUNT(*) AS n FROM faces GROUP BY file_id) nf ON nf.file_id = fa.file_id "
                f" WHERE fa.person_id IN ({marks}) AND f.status = 'active' AND f.locked = 0"
                ") WHERE rn = 1", chunk).fetchall()
            conn.executemany("UPDATE persons SET cover_face_id = ?, cover_src = NULL WHERE id = ?",
                             [(r["id"], r["person_id"]) for r in best])
        # nothing showable at all: no cover rather than a stale one
        conn.execute(f"UPDATE persons SET cover_face_id = NULL, cover_src = NULL "
                     f"WHERE photo_count = 0 {pscope.replace('AND p.id', 'AND id')}", params)


def people_of(file_ids) -> set[int]:
    out: set[int] = set()
    for chunk in _chunks(file_ids):
        marks = ",".join("?" * len(chunk))
        out |= {r["person_id"] for r in db.query(
            f"SELECT DISTINCT person_id FROM faces WHERE file_id IN ({marks}) AND person_id IS NOT NULL", chunk)}
    return out


# ---- events -----------------------------------------------------------------

def refresh_events(event_ids=None) -> None:
    with db.transaction() as conn:
        if event_ids is None:
            conn.execute("UPDATE events SET item_count = 0")
            scope, params = "", ()
        else:
            ids = list(event_ids)
            if not ids:
                return
            marks = ",".join("?" * len(ids))
            conn.execute(f"UPDATE events SET item_count = 0 WHERE id IN ({marks})", ids)
            scope, params = f"AND ei.event_id IN ({marks})", tuple(ids)
        counts = conn.execute(
            "SELECT ei.event_id AS e, COUNT(*) AS n FROM event_items ei JOIN files f ON f.id = ei.file_id "
            f"WHERE f.status = 'active' AND f.locked = 0 {scope} GROUP BY ei.event_id", params).fetchall()
        conn.executemany("UPDATE events SET item_count = ? WHERE id = ?", [(r["n"], r["e"]) for r in counts])

        escope = scope.replace("ei.event_id", "e.id")
        stale = [r["id"] for r in conn.execute(
            "SELECT e.id FROM events e "
            "LEFT JOIN event_items ei ON ei.event_id = e.id AND ei.file_id = e.cover_file_id "
            "LEFT JOIN files f ON f.id = e.cover_file_id "
            f"WHERE e.item_count > 0 {escope} AND (ei.file_id IS NULL OR f.status IS NOT 'active' OR f.locked IS NOT 0)",
            params).fetchall()]
        for chunk in _chunks(stale):
            marks = ",".join("?" * len(chunk))
            newest = conn.execute(
                "SELECT event_id, file_id FROM ("
                " SELECT ei.event_id, ei.file_id, ROW_NUMBER() OVER (PARTITION BY ei.event_id ORDER BY m.taken_at DESC) AS rn "
                " FROM event_items ei JOIN files f ON f.id = ei.file_id LEFT JOIN metadata m ON m.file_id = f.id "
                f" WHERE ei.event_id IN ({marks}) AND f.status = 'active' AND f.locked = 0"
                ") WHERE rn = 1", chunk).fetchall()
            conn.executemany("UPDATE events SET cover_file_id = ? WHERE id = ?",
                             [(r["file_id"], r["event_id"]) for r in newest])


def events_of(file_ids) -> set[int]:
    out: set[int] = set()
    for chunk in _chunks(file_ids):
        marks = ",".join("?" * len(chunk))
        out |= {r["event_id"] for r in db.query(
            f"SELECT DISTINCT event_id FROM event_items WHERE file_id IN ({marks})", chunk)}
    return out


# ---- places -----------------------------------------------------------------

def refresh_places() -> None:
    """The whole table each time: one pass over file_places (100 ms at 300k),
    and a partial refresh would have to reason about groups that emptied."""
    with db.transaction() as conn:
        rows = conn.execute(
            "SELECT pl.country, pl.state, pl.city, COUNT(*) AS n, "
            "MAX(COALESCE(m.taken_at, '') || '|' || printf('%012d', f.id)) AS newest "
            "FROM file_places pl JOIN files f ON f.id = pl.file_id LEFT JOIN metadata m ON m.file_id = f.id "
            "WHERE f.status = 'active' AND f.locked = 0 AND pl.country IS NOT NULL "
            "GROUP BY pl.country, pl.state, pl.city").fetchall()
        conn.execute("DELETE FROM place_summary")
        conn.executemany(
            "INSERT INTO place_summary (country, state, city, n, cover) VALUES (?,?,?,?,?)",
            [(r["country"], r["state"], r["city"], r["n"], int(r["newest"].rsplit("|", 1)[1])) for r in rows])
        pts = conn.execute(
            "SELECT ROUND(m.gps_lat, 1) AS lat, ROUND(m.gps_lon, 1) AS lon, COUNT(*) AS n, "
            "MIN(pl.city) AS city, MIN(pl.country) AS country "
            "FROM metadata m JOIN files f ON f.id = m.file_id LEFT JOIN file_places pl ON pl.file_id = m.file_id "
            "WHERE m.gps_lat IS NOT NULL AND f.status = 'active' AND f.locked = 0 "
            "GROUP BY ROUND(m.gps_lat, 1), ROUND(m.gps_lon, 1)").fetchall()
        conn.execute("DELETE FROM place_points WHERE precision = 1")
        conn.executemany(
            "INSERT INTO place_points (precision, lat, lon, n, city, country) VALUES (1,?,?,?,?,?)",
            [(r["lat"], r["lon"], r["n"], r["city"], r["country"]) for r in pts])


# ---- library totals ---------------------------------------------------------

def refresh_counts() -> None:
    with db.transaction() as conn:
        one = lambda sql, p=(): conn.execute(sql, p).fetchone()[0]  # noqa: E731
        vals: dict[str, int] = {"photos": 0, "videos": 0}
        for r in conn.execute("SELECT media_type, COUNT(*) AS n FROM files f "
                              "WHERE f.status = 'active' AND f.locked = 0 AND f.livecomp = 0 GROUP BY media_type"):
            vals[r["media_type"] + "s"] = r["n"]
        vals["total_active"] = one("SELECT COUNT(*) FROM files WHERE status = 'active'")
        vals["missing"] = one("SELECT COUNT(*) FROM files WHERE status = 'missing'")
        vals["with_gps"] = one("SELECT COUNT(*) FROM metadata WHERE gps_lat IS NOT NULL")
        vals["geocoded"] = one("SELECT COUNT(*) FROM file_places")
        vals["faces"] = one("SELECT COUNT(*) FROM faces")
        vals["live"] = one("SELECT COUNT(*) FROM files WHERE status = 'active' AND locked = 0 AND live = 1")
        vals["persons"] = one("SELECT COUNT(*) FROM persons WHERE name IS NOT NULL")
        vals["people_visible"] = one("SELECT COUNT(*) FROM persons WHERE is_hidden = 0 AND photo_count > 0")
        vals["face_pending"] = one("SELECT COUNT(*) FROM files WHERE status = 'active' AND media_type = 'photo' AND face_scanned = 0")
        vals["clip_indexed"] = one("SELECT COUNT(*) FROM file_clip WHERE model = ?", (config.CLIP_MODEL,))
        vals["clip_pending"] = one(
            "SELECT COUNT(*) FROM files f WHERE f.status = 'active' AND f.locked = 0 "
            "AND f.id NOT IN (SELECT file_id FROM file_clip WHERE model = ?)", (config.CLIP_MODEL,))
        vals["kind:screenshot"] = vals["kind:document"] = 0
        for r in conn.execute("SELECT k.kind, COUNT(*) AS n FROM file_kinds k JOIN files f ON f.id = k.file_id "
                              "WHERE f.status = 'active' AND f.locked = 0 AND k.kind != 'photo' GROUP BY k.kind"):
            vals["kind:" + r["kind"]] = r["n"]
        vals["locked"] = one("SELECT COUNT(*) FROM locked_items")
        try:
            vals["db_bytes"] = os.path.getsize(config.DB_PATH)
        except OSError:
            pass
        conn.executemany(
            "INSERT INTO library_stats (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            list(vals.items()))


def _dir_size(path) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for f in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


SIZES_TTL_S = 6 * 3600


def refresh_sizes() -> None:
    """The cache directories, walked. Two seconds per 300,000 files, which is
    why this runs in a thread at start and after a scan, never on a request."""
    vals = [
        ("thumbs_bytes", _dir_size(config.THUMBS_DIR)),
        ("previews_bytes", _dir_size(config.PREVIEWS_DIR)),
        ("facecrops_bytes", _dir_size(config.FACE_CROPS_DIR)),
        ("sizes_at", int(time.time())),
    ]
    db.executemany(
        "INSERT INTO library_stats (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        vals)


def refresh_sizes_soon() -> None:
    """Off the request path, and at most once per TTL."""
    if time.time() - stats().get("sizes_at", 0) < SIZES_TTL_S:
        return
    threading.Thread(target=refresh_sizes, name="cache-sizes", daemon=True).start()


def stats() -> dict[str, int]:
    return {r["key"]: r["value"] for r in db.query("SELECT key, value FROM library_stats")}


# ---- orchestration ----------------------------------------------------------

def refresh_all(sizes: bool = False) -> None:
    rebuild_days()
    refresh_people()
    refresh_events()
    refresh_places()
    refresh_counts()
    if sizes:
        refresh_sizes()


def ensure() -> None:
    """At start. The first launch after the migration fills the tables before
    serving anything — a few seconds once, rather than every page reading
    zeros — and later launches only bring the cache sizes up to date, in the
    background."""
    if not db.query_one("SELECT 1 FROM library_stats LIMIT 1"):
        refresh_all(sizes=True)
    else:
        refresh_sizes_soon()


# What each job can have changed. `sizes` is only worth a walk after a scan.
_AFTER_JOB: dict[str, tuple[str, ...]] = {
    "scan": ("days", "people", "events", "places", "counts", "sizes"),
    "classify": ("days", "counts"),
    "motion": ("days", "counts"),
    "geocode": ("places", "counts"),
    "events": ("events",),
    "faces": ("people", "counts"),
    "recluster": ("people", "counts"),
    "search_index": ("counts", "clip"),
    "remove": ("days", "people", "events", "places", "counts"),
    "takeout": (),
    "neardup": (), "blur": (), "moment": (), "models": (), "search_models": (),
}


def after_job(kind: str) -> None:
    steps = _AFTER_JOB.get(kind, ("days", "people", "events", "places", "counts"))
    if kind in ("scan", "remove"):
        db.optimize()   # the library's shape changed; keep the planner's statistics with it
    if "days" in steps:
        rebuild_days()
    if "people" in steps:
        refresh_people()
    if "events" in steps:
        refresh_events()
    if "places" in steps:
        refresh_places()
    if "counts" in steps:
        refresh_counts()
    if "clip" in steps:
        from . import search as search_svc

        search_svc.rebuild_cache()
    if "sizes" in steps:
        refresh_sizes_soon()


def files_changed(file_ids, days=None) -> None:
    """A request handler changed these files' visibility or removed them.
    `days` is passed by callers that delete rows, since the days are gone
    from metadata by the time this runs."""
    ids = list(file_ids)
    if not ids:
        return
    refresh_days(days if days is not None else days_of(ids))
    refresh_people(people_of(ids))
    refresh_events(events_of(ids))
    # Places is the one refresh that is always whole-table (330 ms at 300k),
    # so skip it when none of these files is anywhere — or, for a delete,
    # when the caller could not tell us (rows already gone): refresh.
    if days is not None or _any_placed(ids):
        refresh_places()
    refresh_counts()


def _any_placed(file_ids) -> bool:
    for chunk in _chunks(file_ids):
        marks = ",".join("?" * len(chunk))
        if db.query_one(
                f"SELECT 1 FROM metadata WHERE file_id IN ({marks}) AND gps_lat IS NOT NULL LIMIT 1", chunk):
            return True
    return False
