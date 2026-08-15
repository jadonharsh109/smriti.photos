"""Auto-events: split the timeline on time gaps. Fully derived and idempotent —
user-renamed titles are preserved across rebuilds via majority-overlap matching."""
from .. import config, db
from .runner import manager


async def run_events_rebuild(job_id: int) -> None:
    rows = db.query(
        "SELECT f.id, m.taken_at_ts FROM files f JOIN metadata m ON m.file_id=f.id "
        "WHERE f.status='active' AND m.taken_at_ts IS NOT NULL ORDER BY m.taken_at_ts",
    )
    gap = int(config.EVENT_GAP_HOURS * 3600)
    groups: list[list] = []
    cur: list = []
    prev_ts = None
    for r in rows:
        if prev_ts is not None and r["taken_at_ts"] - prev_ts > gap and cur:
            groups.append(cur)
            cur = []
        cur.append(r)
        prev_ts = r["taken_at_ts"]
    if cur:
        groups.append(cur)
    groups = [g for g in groups if len(g) >= config.EVENT_MIN_ITEMS]
    manager.update(job_id, total=len(groups), message="rebuilding events…")

    old_titles = {}
    for ev in db.query("SELECT id, title FROM events WHERE is_user_titled=1"):
        ids = {r["file_id"] for r in db.query("SELECT file_id FROM event_items WHERE event_id=?", (ev["id"],))}
        old_titles[ev["id"]] = (ev["title"], ids)

    with db.transaction() as conn:
        conn.execute("DELETE FROM event_items")
        conn.execute("DELETE FROM events")
        for g in groups:
            ids = [r["id"] for r in g]
            start, end = g[0]["taken_at_ts"], g[-1]["taken_at_ts"]
            title, user_titled = _title_for(conn, ids, start, end), 0
            for _, (old_title, old_ids) in old_titles.items():
                inter = len(old_ids & set(ids))
                if inter and inter >= len(old_ids) / 2:
                    title, user_titled = old_title, 1
                    break
            cur2 = conn.execute(
                "INSERT INTO events (title, is_user_titled, start_ts, end_ts, cover_file_id) VALUES (?,?,?,?,?)",
                (title, user_titled, start, end, ids[len(ids) // 2]),
            )
            conn.executemany(
                "INSERT INTO event_items (event_id, file_id) VALUES (?,?)",
                [(cur2.lastrowid, fid) for fid in ids],
            )
    manager.update(job_id, done=len(groups))
    manager.finish(job_id, "done", f"{len(groups)} events")


def _title_for(conn, file_ids, start_ts, end_ts) -> str:
    from datetime import datetime

    d1, d2 = datetime.fromtimestamp(start_ts), datetime.fromtimestamp(end_ts)
    if d1.date() == d2.date():
        dates = d1.strftime("%b %-d, %Y")
    elif d1.year == d2.year and d1.month == d2.month:
        dates = f"{d1.strftime('%b %-d')}–{d2.strftime('%-d, %Y')}"
    else:
        dates = f"{d1.strftime('%b %-d, %Y')} – {d2.strftime('%b %-d, %Y')}"
    sample = file_ids[:400]
    place = conn.execute(
        f"SELECT city, country, COUNT(*) c FROM file_places WHERE file_id IN ({','.join('?' * len(sample))}) "
        "AND city IS NOT NULL GROUP BY city, country ORDER BY c DESC LIMIT 1",
        sample,
    ).fetchone()
    if place and place["c"] >= max(2, len(sample) // 4):
        return f"{place['city']} · {dates}"
    return dates
