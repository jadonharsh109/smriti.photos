#!/usr/bin/env python3
"""Smriti at the size of a real library: build one, time it, check it.

    python scripts/bench.py synth  DIR [N]        a synthetic library of N files (default 300,000)
    python scripts/bench.py run    DIR            time the endpoint functions in-process, no HTTP
    python scripts/bench.py verify DIR            mutate the library the way requests do and
                                                  check the maintained aggregates against a
                                                  rebuild from scratch (exit code = mismatches)
    python scripts/bench.py http   BASE_URL       latency of the JSON endpoints over HTTP
    python scripts/bench.py thumbs BASE_URL DIR   thumbnail throughput at concurrency 1 / 6 / 32

The synthetic library goes through the app's own migrations and looks like a
real one where it matters: heavy-tailed days, 250 people with Zipf-shaped face
counts, events split on the same six-hour gap the app uses, places in thirty
cities, favourites, screenshots, a locked set and a few missing files. It has
no thumbnails, so `thumbs` wants a real data directory.

Numbers this was written against (Apple M4, 300,000 files) live in the plan;
the short version is that every list endpoint went from 200–730 ms to a few
milliseconds once the aggregates were maintained instead of recomputed.
"""
from __future__ import annotations

import os
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _env(data_dir: str) -> None:
    os.environ["SMRITI_DATA_DIR"] = str(Path(data_dir).expanduser().resolve())
    sys.path.insert(0, str(ROOT / "backend"))


# ---- synth ------------------------------------------------------------------

CITIES = [
    ("IN", "India", "Madhya Pradesh", "Indore", 22.72, 75.86), ("IN", "India", "Madhya Pradesh", "Bhopal", 23.26, 77.41),
    ("IN", "India", "Goa", "Panaji", 15.49, 73.83), ("IN", "India", "Uttarakhand", "Rishikesh", 30.09, 78.27),
    ("IN", "India", "Delhi", "New Delhi", 28.61, 77.21), ("IN", "India", "Maharashtra", "Mumbai", 19.08, 72.88),
    ("IN", "India", "Karnataka", "Bengaluru", 12.97, 77.59), ("IN", "India", "Rajasthan", "Jaipur", 26.91, 75.79),
    ("IN", "India", "Himachal Pradesh", "Manali", 32.24, 77.19), ("IN", "India", "Kerala", "Kochi", 9.93, 76.27),
    ("IN", "India", "Tamil Nadu", "Chennai", 13.08, 80.27), ("IN", "India", "West Bengal", "Kolkata", 22.57, 88.36),
    ("AE", "United Arab Emirates", "Dubai", "Dubai", 25.20, 55.27), ("TH", "Thailand", "Bangkok", "Bangkok", 13.76, 100.50),
    ("TH", "Thailand", "Phuket", "Phuket", 7.88, 98.39), ("SG", "Singapore", None, "Singapore", 1.35, 103.82),
    ("GB", "United Kingdom", "England", "London", 51.51, -0.13), ("FR", "France", "Ile-de-France", "Paris", 48.86, 2.35),
    ("US", "United States", "California", "San Francisco", 37.77, -122.42), ("US", "United States", "New York", "New York", 40.71, -74.01),
    ("JP", "Japan", "Tokyo", "Tokyo", 35.68, 139.69), ("ID", "Indonesia", "Bali", "Ubud", -8.51, 115.26),
    ("NP", "Nepal", "Bagmati", "Kathmandu", 27.72, 85.32), ("LK", "Sri Lanka", "Southern", "Galle", 6.03, 80.22),
    ("IT", "Italy", "Lazio", "Rome", 41.90, 12.50), ("CH", "Switzerland", "Bern", "Interlaken", 46.69, 7.87),
    ("MV", "Maldives", None, "Male", 4.17, 73.51), ("VN", "Vietnam", "Hanoi", "Hanoi", 21.03, 105.85),
    ("AU", "Australia", "New South Wales", "Sydney", -33.87, 151.21), ("DE", "Germany", "Berlin", "Berlin", 52.52, 13.40),
]
DIMS = [(4032, 3024), (3024, 4032), (4032, 3024), (3024, 4032), (1920, 1080), (1080, 1920), (6000, 4000), (1179, 2556), (3840, 2160)]
MAKES = ["Apple"] * 7 + ["Canon", "Samsung", "Google"] + [None] * 3


def synth(data_dir: str, n: int) -> None:
    out = Path(data_dir).expanduser().resolve()
    if (out / "library.db").exists():
        raise SystemExit(f"{out} already holds a library; pick an empty directory")
    out.mkdir(parents=True, exist_ok=True)
    _env(str(out))
    from app import db

    random.seed(7)
    t0 = time.perf_counter()
    conn = db.connect()
    conn.execute("INSERT INTO volumes (disk_uuid, label, last_mount_path, is_online) VALUES ('path:/synth','Synthetic','/',1)")
    vol = conn.execute("SELECT id FROM volumes").fetchone()[0]
    conn.execute("INSERT INTO roots (volume_id, rel_path) VALUES (?, 'synthetic')", (vol,))
    conn.commit()

    start = int(time.mktime((2010, 1, 1, 0, 0, 0, 0, 0, -1)))
    day_offsets = sorted(random.sample(range(0, 16 * 365), min(5000, n)))
    weights = [1.0 / (i + 1) ** 0.65 for i in range(len(day_offsets))]
    random.shuffle(weights)
    day_choices = random.choices(range(len(day_offsets)), weights=weights, k=n)
    day_city = [random.choice(CITIES) if random.random() < 0.6 else None for _ in day_offsets]

    files, meta, places, kinds = [], [], [], []
    now = int(time.time())
    ts_by_id = {}
    for i in range(1, n + 1):
        d = day_choices[i - 1]
        ts = start + day_offsets[d] * 86400 + random.randint(6 * 3600, 22 * 3600)
        ts_by_id[i] = ts
        is_video = random.random() < 0.05
        ext = ".mov" if is_video else (".heic" if random.random() < 0.5 else ".jpg")
        y = time.localtime(ts).tm_year
        rel = f"synthetic/{y}/IMG_{i:07d}{ext}"
        size = random.randint(800_000, 6_000_000) if not is_video else random.randint(20_000_000, 400_000_000)
        h = f"{random.getrandbits(256):064x}" if random.random() > 0.02 else f"{random.getrandbits(64):064x}"
        files.append((i, vol, rel, os.path.basename(rel), "video" if is_video else "photo", size, ts * 10 ** 9, h,
                      random.getrandbits(63), "active", 1, now))
        w, hgt = random.choice(DIMS)
        make = random.choice(MAKES)
        city = day_city[d]
        lat = lon = None
        if city and make:
            lat = city[4] + random.uniform(-0.05, 0.05)
            lon = city[5] + random.uniform(-0.05, 0.05)
        taken = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
        meta.append((i, taken, ts, "exif" if make else "mtime", w, hgt, 1, make,
                     "iPhone 15 Pro" if make == "Apple" else None, 100, 1.8, "1/120", 24.0,
                     12.5 if is_video else None, "hevc" if is_video else None, lat, lon, None, taken[:10]))
        if lat is not None:
            places.append((i, city[0], city[1], city[2], city[3]))
        if make is None and random.random() < 0.6:
            kinds.append((i, "screenshot", 0.97, "heuristic"))

    def chunks(seq, k=20000):
        for s in range(0, len(seq), k):
            yield seq[s:s + k]

    for ch in chunks(files):
        db.executemany("INSERT INTO files (id,volume_id,rel_path,filename,media_type,size_bytes,mtime_ns,content_hash,phash,status,face_scanned,indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ch)
    for ch in chunks(meta):
        db.executemany("INSERT INTO metadata (file_id,taken_at,taken_at_ts,taken_at_src,width,height,orientation,camera_make,camera_model,iso,f_number,exposure,focal_length,duration_s,video_codec,gps_lat,gps_lon,content_id,day) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ch)
    for ch in chunks(places):
        db.executemany("INSERT INTO file_places (file_id,country_code,country,state,city) VALUES (?,?,?,?,?)", ch)
    for ch in chunks(kinds):
        db.executemany("INSERT INTO file_kinds (file_id,kind,confidence,source) VALUES (?,?,?,?)", ch)
    db.execute("UPDATE files SET doc = 1 WHERE id IN (SELECT file_id FROM file_kinds WHERE kind != 'photo')")
    print(f"  files/metadata/places/kinds   {time.perf_counter() - t0:6.1f}s", flush=True)

    db.executemany("INSERT INTO persons (id,name,is_hidden) VALUES (?,?,0)",
                   [(pid, f"Person {pid}" if pid <= 5 else None) for pid in range(1, 251)])
    pw = [1.0 / (p ** 0.9) for p in range(1, 251)]
    faces, fid = [], 0
    for i in range(1, n + 1):
        if files[i - 1][4] != "photo" or random.random() > 0.55:
            continue
        for _ in range(random.choice([1, 1, 1, 2, 2, 3, 4])):
            fid += 1
            pid = random.choices(range(1, 251), weights=pw)[0] if random.random() < 0.7 else None
            faces.append((fid, i, random.random() * 0.7, random.random() * 0.7, random.uniform(0.05, 0.3),
                          random.uniform(0.05, 0.3), random.uniform(0.6, 0.99), b"\x00" * 8, pid,
                          "cluster" if pid else None))
    for ch in chunks(faces):
        db.executemany("INSERT INTO faces (id,file_id,x,y,w,h,det_score,embedding,person_id,assign_src) VALUES (?,?,?,?,?,?,?,?,?,?)", ch)
    print(f"  {len(faces):,} faces                 {time.perf_counter() - t0:6.1f}s", flush=True)

    order = sorted(ts_by_id.items(), key=lambda kv: kv[1])
    groups, cur, prev = [], [], None
    for i, ts in order:
        if prev is not None and ts - prev > 6 * 3600 and cur:
            groups.append(cur)
            cur = []
        cur.append(i)
        prev = ts
    if cur:
        groups.append(cur)
    groups = [g for g in groups if len(g) >= 3]
    db.executemany("INSERT INTO events (id,title,is_user_titled,start_ts,end_ts,cover_file_id) VALUES (?,?,?,?,?,?)",
                   [(k, f"Trip {k}", 0, ts_by_id[g[0]], ts_by_id[g[-1]], g[len(g) // 2]) for k, g in enumerate(groups, 1)])
    for ch in chunks([(k, i) for k, g in enumerate(groups, 1) for i in g]):
        db.executemany("INSERT INTO event_items (event_id,file_id) VALUES (?,?)", ch)
    print(f"  {len(groups):,} events                 {time.perf_counter() - t0:6.1f}s", flush=True)

    fav = db.query_one("SELECT id FROM albums WHERE system='favourites'")["id"]
    db.executemany("INSERT INTO album_items (album_id,file_id,position) VALUES (?,?,?)",
                   [(fav, f, k) for k, f in enumerate(random.sample(range(1, n + 1), min(5000, n)))])
    for a in range(1, 21):
        db.execute("INSERT INTO albums (name, created_at) VALUES (?, ?)", (f"Album {a}", now))
        aid = db.query_one("SELECT MAX(id) m FROM albums")["m"]
        db.executemany("INSERT INTO album_items (album_id,file_id,position) VALUES (?,?,?)",
                       [(aid, f, k) for k, f in enumerate(random.sample(range(1, n + 1), min(300, n)))])
    locked = random.sample(range(1, n + 1), min(50, n))
    db.executemany("INSERT INTO locked_items (file_id, locked_at) VALUES (?,?)", [(f, now) for f in locked])
    db.executemany("UPDATE files SET locked = 1 WHERE id = ?", [(f,) for f in locked])
    db.execute("UPDATE files SET status='missing' WHERE id % 97 = 0")

    from app.services import aggregates

    t = time.perf_counter()
    aggregates.refresh_all()
    print(f"  aggregates from scratch       {time.perf_counter() - t:6.1f}s")
    print(f"  done in {time.perf_counter() - t0:.1f}s · {os.path.getsize(out / 'library.db') / 1e6:.0f} MB · {out}")


# ---- run --------------------------------------------------------------------

def run(data_dir: str) -> None:
    _env(data_dir)
    from app import db
    from app.api import albums, cleanup, dupes, events, kinds, media, people, places, system, timeline
    from app.api import search as search_api
    from app.services import aggregates

    t = time.perf_counter()
    db.connect()
    aggregates.ensure()
    print(f"  startup (migrations + aggregates if first run)   {(time.perf_counter() - t) * 1000:8.1f} ms")

    def bench(name, fn, n=5):
        ts, size = [], None
        for _ in range(n):
            a = time.perf_counter()
            r = fn()
            ts.append(time.perf_counter() - a)
            size = len(r) if hasattr(r, "__len__") else "-"
        print(f"  {name:46s} min {min(ts) * 1000:8.1f} ms   med {statistics.median(ts) * 1000:8.1f} ms   rows={size}", flush=True)

    n_files = db.query_one("SELECT COUNT(*) n FROM files")["n"]
    busiest = db.query_one("SELECT day d, n FROM day_buckets WHERE scope='all' ORDER BY n DESC LIMIT 1")
    typical = db.query_one("SELECT day d FROM day_buckets WHERE scope='all' AND n BETWEEN 20 AND 60 LIMIT 1")
    big_person = db.query_one("SELECT id p, photo_count n FROM persons ORDER BY photo_count DESC LIMIT 1")
    top_country = db.query_one("SELECT country c, SUM(n) n FROM place_summary GROUP BY country ORDER BY n DESC LIMIT 1")
    print(f"  library: {n_files:,} files · busiest day {busiest['d'] if busiest else '-'} "
          f"({busiest['n'] if busiest else 0:,}) · biggest person {big_person['p'] if big_person else None} "
          f"({big_person['n'] if big_person else 0:,} photos) · top country {top_country['c'] if top_country else None}")

    bench("GET /timeline/buckets (all)", lambda: timeline.buckets())
    bench("GET /timeline/buckets media_type=video", lambda: timeline.buckets(media_type="video"))
    bench("GET /timeline/buckets kind=any (Documents)", lambda: timeline.buckets(kind="any"))
    if busiest:
        bench("GET /timeline/items day=busiest", lambda: timeline.items(day=busiest["d"], limit=2000))
    if typical:
        bench("GET /timeline/items day=typical", lambda: timeline.items(day=typical["d"], limit=2000))
    if big_person:
        bench("GET /timeline/buckets person_id=big", lambda: timeline.buckets(person_id=big_person["p"]))
        bench("GET /timeline/buckets person_id solo=1", lambda: timeline.buckets(person_id=big_person["p"], solo=1))
    if top_country:
        bench("GET /timeline/buckets country=top", lambda: timeline.buckets(country=top_country["c"]))
    bench("GET /stats", lambda: system.stats())
    bench("GET /people", lambda: people.list_people())
    bench("GET /places/summary", lambda: places.summary())
    bench("GET /places/points", lambda: places.points())
    bench("GET /events", lambda: events.list_events())
    bench("GET /events?limit=200", lambda: events.list_events(limit=200))
    bench("GET /albums", lambda: albums.list_albums())
    bench("GET /kinds/summary", lambda: kinds.summary())
    bench("GET /dupes/exact", lambda: dupes.exact())
    bench("GET /cleanup/missing", lambda: cleanup.missing())
    bench("GET /files/{id}", lambda: media.file_detail(1))
    bench("GET /search/status", lambda: search_api.status())
    print("  -- refresh costs (what a job pays when it finishes) --")
    bench("aggregates.rebuild_days", aggregates.rebuild_days, n=3)
    bench("aggregates.refresh_people", aggregates.refresh_people, n=3)
    bench("aggregates.refresh_events", aggregates.refresh_events, n=3)
    bench("aggregates.refresh_places", aggregates.refresh_places, n=3)
    bench("aggregates.refresh_counts", aggregates.refresh_counts, n=3)


# ---- verify -----------------------------------------------------------------

def verify(data_dir: str) -> int:
    """Do what the request handlers do — lock, unlock, reclassify, delete —
    through the incremental refreshes, then rebuild everything from scratch
    and diff. Any difference is a maintenance bug."""
    _env(data_dir)
    from app import db
    from app.services import aggregates

    db.connect()
    aggregates.ensure()
    random.seed(11)

    def snapshot() -> dict:
        return {
            "days": {(r["scope"], r["day"]): (r["n"], round(r["ar"], 2)) for r in db.query("SELECT * FROM day_buckets")},
            "people": {r["id"]: (r["photo_count"], r["cover_face_id"]) for r in db.query("SELECT id, photo_count, cover_face_id FROM persons")},
            "events": {r["id"]: (r["item_count"], r["cover_file_id"]) for r in db.query("SELECT id, item_count, cover_file_id FROM events")},
            "places": {(r["country"], r["state"], r["city"]): (r["n"], r["cover"]) for r in db.query("SELECT * FROM place_summary")},
            "points": {(r["lat"], r["lon"]): r["n"] for r in db.query("SELECT lat, lon, n FROM place_points WHERE precision=1")},
            "stats": {k: v for k, v in aggregates.stats().items() if not k.endswith("_bytes") and k != "sizes_at"},
        }

    def diff(incremental: dict, full: dict, what: str) -> int:
        bad = 0
        for table in incremental:
            a, b = incremental[table], full[table]
            keys = set(a) | set(b)
            wrong = [k for k in keys if a.get(k) != b.get(k)]
            if wrong:
                bad += len(wrong)
                sample = ", ".join(f"{k}: {a.get(k)} vs {b.get(k)}" for k in wrong[:3])
                print(f"  ✗ {what}: {table} differs in {len(wrong)} rows — {sample}")
        if not bad:
            print(f"  ✓ {what}")
        return bad

    problems = 0
    visible = [r["id"] for r in db.query(
        "SELECT id FROM files WHERE status='active' AND locked=0 AND doc=0 AND livecomp=0 ORDER BY RANDOM() LIMIT 80")]
    # a person's covers are only in play if they have faces; pick files that do
    with_faces = [r["file_id"] for r in db.query(
        "SELECT DISTINCT file_id FROM faces WHERE person_id IS NOT NULL ORDER BY RANDOM() LIMIT 40")]
    now = int(time.time())

    # 1. lock — what api/locked.add_items does
    ids = visible[:40] + with_faces[:20]
    with db.transaction() as conn:
        for fid in ids:
            conn.execute("INSERT OR IGNORE INTO locked_items (file_id, locked_at) VALUES (?,?)", (fid, now))
            conn.execute("UPDATE files SET locked=1 WHERE id=?", (fid,))
    aggregates.files_changed(ids)
    inc = snapshot()
    aggregates.refresh_all()
    problems += diff(inc, snapshot(), "lock 60 files")

    # 2. unlock — api/locked.remove_items
    with db.transaction() as conn:
        for fid in ids:
            conn.execute("DELETE FROM locked_items WHERE file_id=?", (fid,))
            conn.execute("UPDATE files SET locked=0 WHERE id=?", (fid,))
    aggregates.files_changed(ids)
    inc = snapshot()
    aggregates.refresh_all()
    problems += diff(inc, snapshot(), "unlock them again")

    # 3. reclassify — api/kinds.not_document, and the reverse
    docs = [r["id"] for r in db.query("SELECT id FROM files WHERE doc=1 AND status='active' ORDER BY RANDOM() LIMIT 30")]
    with db.transaction() as conn:
        for fid in docs:
            conn.execute("INSERT INTO file_kinds (file_id, kind, confidence, source) VALUES (?, 'photo', 1.0, 'manual') "
                         "ON CONFLICT(file_id) DO UPDATE SET kind='photo', confidence=1.0, source='manual'", (fid,))
            conn.execute("UPDATE files SET doc=0 WHERE id=?", (fid,))
        for fid in visible[40:70]:
            conn.execute("INSERT INTO file_kinds (file_id, kind, confidence, source) VALUES (?, 'screenshot', 0.9, 'heuristic') "
                         "ON CONFLICT(file_id) DO UPDATE SET kind='screenshot'", (fid,))
            conn.execute("UPDATE files SET doc=1 WHERE id=?", (fid,))
    aggregates.files_changed(docs + visible[40:70])
    inc = snapshot()
    aggregates.refresh_all()
    problems += diff(inc, snapshot(), "reclassify 60 files")

    # 4. delete — api/media.delete_files
    gone = visible[70:80] + with_faces[20:40]
    days = aggregates.days_of(gone)
    people = aggregates.people_of(gone)
    events = aggregates.events_of(gone)
    with db.transaction() as conn:
        for fid in gone:
            conn.execute("DELETE FROM files WHERE id=?", (fid,))
    aggregates.refresh_days(days)
    aggregates.refresh_people(people)
    aggregates.refresh_events(events)
    aggregates.refresh_places()
    aggregates.refresh_counts()
    inc = snapshot()
    aggregates.refresh_all()
    problems += diff(inc, snapshot(), "delete 30 files")

    # 5. the stored day column agrees with taken_at everywhere
    off = db.query_one("SELECT COUNT(*) n FROM metadata WHERE day IS NOT substr(taken_at, 1, 10)")["n"]
    if off:
        problems += 1
        print(f"  ✗ metadata.day disagrees with taken_at on {off} rows")
    else:
        print("  ✓ metadata.day matches taken_at")

    # 6. the flags agree with the tables they mirror
    for name, sql in (
        ("locked", "SELECT COUNT(*) n FROM files f WHERE f.locked != (f.id IN (SELECT file_id FROM locked_items))"),
        ("doc", "SELECT COUNT(*) n FROM files f WHERE f.doc != (f.id IN (SELECT file_id FROM file_kinds WHERE kind != 'photo'))"),
        ("live", "SELECT COUNT(*) n FROM files f WHERE f.live != (f.id IN (SELECT file_id FROM file_motion))"),
        ("livecomp", "SELECT COUNT(*) n FROM files f WHERE f.livecomp != (f.id IN (SELECT video_file_id FROM file_motion WHERE video_file_id IS NOT NULL))"),
    ):
        off = db.query_one(sql)["n"]
        if off:
            problems += 1
            print(f"  ✗ files.{name} disagrees with its table on {off} rows")
        else:
            print(f"  ✓ files.{name} matches its table")

    print(f"\n  {problems} problem(s)")
    return problems


# ---- http -------------------------------------------------------------------

def http(base: str) -> None:
    import json
    import urllib.request

    def get(path):
        with urllib.request.urlopen(base + path, timeout=120) as r:
            return r.read()

    def lat(name, path, n=15):
        ts, size = [], 0
        for _ in range(n):
            t = time.perf_counter()
            b = get(path)
            ts.append(time.perf_counter() - t)
            size = len(b)
        ts.sort()
        print(f"  {name:46s} min {ts[0] * 1000:8.1f} ms   med {statistics.median(ts) * 1000:8.1f} ms   "
              f"p95 {ts[int(len(ts) * 0.95) - 1] * 1000:8.1f} ms   {size / 1024:8.1f} KB", flush=True)

    lat("GET /health (framework floor)", "/api/health", 40)
    lat("GET /stats", "/api/stats")
    buckets = json.loads(get("/api/timeline/buckets"))
    lat("GET /timeline/buckets", "/api/timeline/buckets")
    if buckets:
        big = max(buckets, key=lambda b: b["count"])["day"]
        lat("GET /timeline/items day=busiest", f"/api/timeline/items?day={big}&limit=2000")
    lat("GET /people", "/api/people")
    lat("GET /places/summary", "/api/places/summary")
    lat("GET /events", "/api/events")
    lat("GET /albums", "/api/albums")
    lat("GET /search/status", "/api/search/status")
    lat("GET /files/1", "/api/files/1")


def thumbs(base: str, data_dir: str) -> None:
    import glob
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor

    paths = sorted(glob.glob(os.path.join(data_dir, "thumbs", "*", "*.webp")))[:600]
    ids = [int(os.path.basename(p).split(".")[0]) for p in paths]
    total = sum(os.path.getsize(p) for p in paths)
    print(f"  {len(ids)} thumbs, {total / 1e6:.1f} MB, mean {total / max(1, len(ids)) / 1024:.0f} KB")

    def get(path):
        with urllib.request.urlopen(base + path, timeout=120) as r:
            return r.read()

    t = time.perf_counter()
    for p in paths:
        with open(p, "rb") as f:
            f.read()
    dt = time.perf_counter() - t
    print(f"  {'raw disk read, sequential':46s} {len(ids) / dt:8.0f} files/s   {total / dt / 1e6:7.1f} MB/s")
    for c in (1, 6, 32):
        t = time.perf_counter()
        with ThreadPoolExecutor(max_workers=c) as ex:
            got = sum(len(b) for b in ex.map(lambda i: get(f"/api/thumb/{i}"), ids))
        dt = time.perf_counter() - t
        print(f"  {'HTTP /api/thumb, concurrency %d' % c:46s} {len(ids) / dt:8.0f} files/s   {got / dt / 1e6:7.1f} MB/s")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, arg = sys.argv[1], sys.argv[2]
    if cmd == "synth":
        synth(arg, int(sys.argv[3]) if len(sys.argv) > 3 else 300_000)
    elif cmd == "run":
        run(arg)
    elif cmd == "verify":
        return verify(arg)
    elif cmd == "http":
        http(arg)
    elif cmd == "thumbs":
        thumbs(arg, sys.argv[3])
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
