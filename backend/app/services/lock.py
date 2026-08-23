"""Locked-section security: passcode hashing, single-use backup codes, and an
in-memory unlock token. Pure stdlib (PBKDF2) — no new dependencies.

Threat model: keep private photos out of every view and API response unless
the passcode is entered. Originals on disk are untouched (the app's core
promise); this is an access gate, not at-rest encryption."""
import hashlib
import json
import secrets
import time

from .. import db

PBKDF2_ITERS = 240_000
# Two clocks, because one is not enough. TTL is idle time — it slides while you
# are actually looking at locked photos, and only then. MAX_LIFE is the ceiling
# no amount of sliding can push past, so a session that started this morning is
# not still open this evening.
TOKEN_TTL_S = 15 * 60          # idle expiry, renewed by real use
TOKEN_MAX_LIFE_S = 60 * 60     # absolute ceiling from the moment it was issued
BACKUP_CODE_COUNT = 8
MAX_FAILS = 5
COOLDOWN_S = 30

# in-memory state: one local user, resets on server restart (locks the section)
_token: str | None = None
_token_expiry: float = 0.0
_token_deadline: float = 0.0
_fails = 0
_last_fail: float = 0.0

# SQL fragment every listing query uses to hide locked files
def not_locked(col: str = "f.id") -> str:
    return f"{col} NOT IN (SELECT file_id FROM locked_items)"


# ---- settings storage -------------------------------------------------------

def _get(key: str) -> str | None:
    row = db.query_one("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row else None


def _put(key: str, value: str) -> None:
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


# ---- passcode ---------------------------------------------------------------

def is_configured() -> bool:
    return _get("locked_password") is not None


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERS)


def set_password(password: str) -> None:
    salt = secrets.token_bytes(16)
    _put("locked_password", f"{salt.hex()}${_hash_password(password, salt).hex()}")


def check_password(password: str) -> bool:
    stored = _get("locked_password")
    if not stored:
        return False
    salt_hex, hash_hex = stored.split("$", 1)
    return secrets.compare_digest(_hash_password(password, bytes.fromhex(salt_hex)), bytes.fromhex(hash_hex))


# ---- backup codes -----------------------------------------------------------

def generate_backup_codes() -> list[str]:
    """Create fresh codes, store only their hashes, return plaintext ONCE."""
    codes = []
    salt = secrets.token_hex(16)
    hashes = []
    for _ in range(BACKUP_CODE_COUNT):
        raw = secrets.token_hex(4).upper()          # 8 hex chars
        code = f"{raw[:4]}-{raw[4:]}"
        codes.append(code)
        hashes.append(hashlib.sha256((salt + code).encode()).hexdigest())
    _put("locked_backup_salt", salt)
    _put("locked_backup_codes", json.dumps(hashes))
    return codes


def use_backup_code(code: str) -> bool:
    """True if the code matches an unused one; consumes it."""
    salt = _get("locked_backup_salt")
    stored = _get("locked_backup_codes")
    if not salt or not stored:
        return False
    hashes: list[str] = json.loads(stored)
    h = hashlib.sha256((salt + code.strip().upper()).encode()).hexdigest()
    if h not in hashes:
        return False
    hashes.remove(h)
    _put("locked_backup_codes", json.dumps(hashes))
    return True


def codes_remaining() -> int:
    stored = _get("locked_backup_codes")
    return len(json.loads(stored)) if stored else 0


# ---- unlock token -----------------------------------------------------------

def issue_token() -> str:
    global _token, _token_expiry, _token_deadline, _fails
    now = time.monotonic()
    _token = secrets.token_urlsafe(32)
    _token_expiry = now + TOKEN_TTL_S
    _token_deadline = now + TOKEN_MAX_LIFE_S
    _fails = 0
    return _token


def check_token(token: str | None, renew: bool = True) -> bool:
    """Is this token still good — and, unless told otherwise, keep it alive.

    `renew=False` is for callers that run on a timer rather than because
    somebody did something. The status endpoint polls once a minute, and while
    it renewed the token the idle expiry could never be reached: leaving the
    Locked section open on screen kept it unlocked indefinitely, which is the
    one thing an idle timeout exists to prevent.
    """
    global _token_expiry
    now = time.monotonic()
    if not token or _token is None:
        return False
    if now > _token_expiry or now > _token_deadline:
        return False
    if not secrets.compare_digest(token, _token):
        return False
    if renew:
        _token_expiry = min(now + TOKEN_TTL_S, _token_deadline)
    return True


def token_expires_in(token: str | None) -> int:
    """Seconds until this token dies of either clock, 0 if it already has.
    Lets the client re-lock the moment the session ends rather than whenever
    its next poll happens to land."""
    if not check_token(token, renew=False):
        return 0
    return max(0, int(min(_token_expiry, _token_deadline) - time.monotonic()))


def drop_token() -> None:
    global _token
    _token = None


# ---- brute-force damping ----------------------------------------------------

def throttled() -> int:
    """Seconds the caller must still wait, or 0 if attempts are allowed."""
    if _fails >= MAX_FAILS:
        remain = COOLDOWN_S - (time.monotonic() - _last_fail)
        if remain > 0:
            return int(remain) + 1
    return 0


def note_failure() -> None:
    global _fails, _last_fail
    _fails += 1
    _last_fail = time.monotonic()
    time.sleep(0.4)  # constant small cost per wrong guess


# ---- item helpers -----------------------------------------------------------

def is_locked_file(file_id: int) -> bool:
    return db.query_one("SELECT 1 FROM locked_items WHERE file_id=?", (file_id,)) is not None
