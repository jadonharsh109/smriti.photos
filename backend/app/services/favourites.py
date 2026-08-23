"""The Favourites album — the one album the app owns rather than the user.

Created by a migration rather than on first use, so the heart always has
somewhere to put things, and marked `system` so the ordinary album routes
refuse to rename or delete it.
"""
from .. import db

SYSTEM = "favourites"


def album_id() -> int:
    """Row id of the Favourites album.

    Looked up rather than cached: it is one indexed row, the cost is nothing
    beside the query it decorates, and a cached id would outlive the connection
    in tests and hand back a row from a database that no longer exists.

    The insert is a safety net, not the normal path — a library restored from
    before the migration, or edited by hand, should grow a heart again rather
    than break every grid that asks for one.
    """
    row = db.query_one("SELECT id FROM albums WHERE system=?", (SYSTEM,))
    if row is not None:
        return row["id"]
    cur = db.execute(
        "INSERT INTO albums (name, created_at, system) "
        "VALUES ('Favourites', CAST(strftime('%s','now') AS INTEGER), ?)",
        (SYSTEM,),
    )
    return cur.lastrowid
