"""SQLite access. Single connection, single-writer discipline: pool workers never
touch the DB — all writes funnel through this module under one lock."""
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from . import config

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def connect() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _migrate(conn)
    _conn = conn
    return conn


def close() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


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
    with _lock:
        return connect().execute(sql, params).fetchall()


def query_one(sql: str, params=()) -> sqlite3.Row | None:
    with _lock:
        return connect().execute(sql, params).fetchone()


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
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
