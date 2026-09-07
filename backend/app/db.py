"""SQLite access: one writer, many readers.

Every write goes through a single connection behind one lock, exactly as
before — SQLite allows one writer at a time and the job runner relies on
that. Reads no longer queue behind it. Each thread that reads gets its own
connection, and in WAL mode readers run alongside the writer and alongside
each other, each on its own core: sqlite3 releases the GIL while a statement
runs.

Measured before this change on a 300,000-file library: six requests for the
timeline's day list took 1.9 s each, because all six and the indexing job's
writes took turns on one connection. With per-thread readers the same six
finish in 0.6 s, and a writer committing underneath them changes nothing.

The subtlety is read-your-writes. Code inside a `transaction()` block must
see its own uncommitted rows, so a query issued while this thread holds the
writer runs on the writer. Everything else runs on the thread's reader, which
sees every transaction committed before its statement began — and `execute`
commits before it returns, so a request that writes and then reads is fine.

Pool workers never touch this module; they return dicts and the job writes.
"""
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from . import config

_lock = threading.RLock()                   # serialises writers, as it always has
_writer: sqlite3.Connection | None = None
_local = threading.local()                  # .reader — this thread's connection
                                            # .depth  — open transaction() blocks

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def _open() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    # Memory-mapped reads, and deliberately nothing else. The SQLite that ships
    # with Python keeps memory statistics behind one process-wide mutex, so
    # every allocation a query makes is a point where concurrent readers
    # collide: measured on a 300,000-file library, six copies of a per-person
    # query ran no faster than one after the other, and `temp_store=MEMORY`
    # made it worse still. Mapping the file lets pages be read without
    # allocating at all, which is what buys back most of the parallelism.
    conn.execute("PRAGMA mmap_size=536870912")
    return conn


def connect() -> sqlite3.Connection:
    """The writer. Opened once; migrations run on it."""
    global _writer
    with _lock:
        if _writer is not None:
            return _writer
        config.ensure_dirs()
        conn = _open()
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _migrate(conn)
        _writer = conn
        return conn


def _reader() -> sqlite3.Connection:
    if getattr(_local, "depth", 0) > 0:
        return connect()                         # inside transaction(): see own writes
    conn = getattr(_local, "reader", None)
    if conn is None:
        connect()                                # migrations first, on the writer
        conn = _local.reader = _open()
    return conn


def close() -> None:
    global _writer
    with _lock:
        if _writer is not None:
            try:
                # Keeps the planner's statistics current for the next start.
                # Cheap: it only analyses what changed enough to matter.
                _writer.execute("PRAGMA optimize")
            except sqlite3.Error:
                pass
            _writer.close()
            _writer = None
    # readers belong to their threads and close with them


def _migrate(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)")
    applied = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in applied:
            continue
        conn.executescript(path.read_text())
        conn.execute("INSERT INTO schema_migrations (name) VALUES (?)", (path.name,))
        conn.commit()


def query(sql: str, params=()) -> list[sqlite3.Row]:
    return _reader().execute(sql, params).fetchall()


def query_one(sql: str, params=()) -> sqlite3.Row | None:
    return _reader().execute(sql, params).fetchone()


def iterate(sql: str, params=(), batch: int = 2000):
    """Stream rows rather than hold them all: for reads whose result would
    not fit comfortably in memory, such as every search embedding at once."""
    cur = _reader().execute(sql, params)
    while rows := cur.fetchmany(batch):
        yield from rows


def query_json(sql: str, params=()) -> str:
    """A query whose single result cell is a JSON document, built by SQLite.

    For the list endpoints — the timeline's days and items, events — the rows
    are handed to the client exactly as fetched, and turning thousands of them
    into Python dicts and back into JSON was most of the request. Worse, the
    sqlite3 module gives up the GIL for every row it steps, so under a few
    concurrent requests each of those steps waited on whichever thread was busy
    encoding: six requests for the day list ran at 21 a second, thirty-two at
    eight. `json_group_array(json_object(...))` produces the same document in
    C, in one step, and the endpoint returns the bytes untouched."""
    row = _reader().execute(sql, params).fetchone()
    return row[0] if row and row[0] else "[]"


def optimize() -> None:
    """After a job that reshaped the library: refresh planner statistics where
    they have drifted. Cheap, and what keeps ANALYZE's picture current."""
    with _lock:
        try:
            connect().execute("PRAGMA optimize")
        except sqlite3.Error:
            pass


def execute(sql: str, params=()) -> sqlite3.Cursor:
    with _lock:
        conn = connect()
        cur = conn.execute(sql, params)
        conn.commit()
        return cur


def executemany(sql: str, seq) -> None:
    with _lock:
        conn = connect()
        conn.executemany(sql, seq)
        conn.commit()


@contextmanager
def transaction():
    with _lock:
        conn = connect()
        _local.depth = getattr(_local, "depth", 0) + 1
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            _local.depth -= 1
