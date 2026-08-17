"""Sort screenshots and scans out of the timeline.

Metadata only — this never opens an image, so a whole library is classified in
well under a second. That is the entire reason it runs as its own job rather
than riding along with a scan: it is cheap enough to re-run whenever the rules
change.
"""
from .. import db
from ..services import kinds as kinds_svc
from .runner import manager


async def run_classify(job_id: int, force: bool = False) -> None:
    rows = db.query(
        "SELECT f.id, f.filename, m.width, m.height, m.camera_make "
        "FROM files f LEFT JOIN metadata m ON m.file_id = f.id "
        "WHERE f.status = 'active' AND f.media_type = 'photo'",
    )
    manager.update(job_id, total=len(rows), message="sorting screenshots and scans…")

    # A user's correction is the ground truth; never overwrite it.
    manual = {r["file_id"] for r in db.query(
        "SELECT file_id FROM file_kinds WHERE source = 'manual'")}

    verdicts = []
    for r in rows:
        if r["id"] in manual:
            continue
        got = kinds_svc.classify(r["filename"], r["width"], r["height"], r["camera_make"])
        if got:
            verdicts.append((r["id"], got[0], got[1], "heuristic"))

    with db.transaction() as conn:
        # Rebuild wholesale: the rules, not the files, are what changed.
        conn.execute("DELETE FROM file_kinds WHERE source != 'manual'")
        conn.executemany(
            "INSERT OR REPLACE INTO file_kinds (file_id, kind, confidence, source) VALUES (?,?,?,?)",
            verdicts,
        )

    by_kind: dict[str, int] = {}
    for _, kind, _, _ in verdicts:
        by_kind[kind] = by_kind.get(kind, 0) + 1
    summary = ", ".join(f"{n} {kinds_svc.label(k).lower()}" for k, n in sorted(by_kind.items()))

    manager.update(job_id, done=len(rows))
    manager.finish(job_id, "done",
                   f"{summary} found in {len(rows)} photos" if summary
                   else f"nothing to sort out of {len(rows)} photos")
