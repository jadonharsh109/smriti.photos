"""Locked section API: setup (with backup codes), unlock, and hidden items."""
import time

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from .. import db
from ..services import lock

router = APIRouter()

MIN_LEN = 4


class PasswordIn(BaseModel):
    password: str


class BackupIn(BaseModel):
    code: str


class ChangeIn(BaseModel):
    new_password: str


class ItemsIn(BaseModel):
    file_ids: list[int]


def _require(token: str | None) -> None:
    if not lock.check_token(token):
        raise HTTPException(401, "locked — unlock first")


def _check_throttle() -> None:
    wait = lock.throttled()
    if wait:
        raise HTTPException(429, f"too many attempts — try again in {wait}s")


@router.get("/locked/status")
def status(x_locked_token: str | None = Header(default=None)):
    # renew=False: this endpoint is polled on a timer, and a poll is not
    # somebody using the section. Renewing here meant the idle clock could
    # never run out while the page was open — see lock.check_token.
    unlocked = lock.check_token(x_locked_token, renew=False)
    out = {"configured": lock.is_configured(), "unlocked": unlocked}
    if unlocked:
        out["count"] = db.query_one("SELECT COUNT(*) n FROM locked_items")["n"]
        out["codes_remaining"] = lock.codes_remaining()
        out["expires_in"] = lock.token_expires_in(x_locked_token)
    return out


@router.post("/locked/setup")
def setup(body: PasswordIn):
    if lock.is_configured():
        raise HTTPException(409, "already set up")
    if len(body.password) < MIN_LEN:
        raise HTTPException(400, f"passcode must be at least {MIN_LEN} characters")
    lock.set_password(body.password)
    codes = lock.generate_backup_codes()
    return {"token": lock.issue_token(), "backup_codes": codes}


@router.post("/locked/unlock")
def unlock(body: PasswordIn):
    _check_throttle()
    if not lock.check_password(body.password):
        lock.note_failure()
        raise HTTPException(401, "wrong passcode")
    return {"token": lock.issue_token()}


@router.post("/locked/unlock-backup")
def unlock_backup(body: BackupIn):
    _check_throttle()
    if not lock.use_backup_code(body.code):
        lock.note_failure()
        raise HTTPException(401, "invalid or already-used backup code")
    return {"token": lock.issue_token(), "codes_remaining": lock.codes_remaining()}


@router.post("/locked/change-password")
def change_password(body: ChangeIn, x_locked_token: str | None = Header(default=None)):
    _require(x_locked_token)
    if len(body.new_password) < MIN_LEN:
        raise HTTPException(400, f"passcode must be at least {MIN_LEN} characters")
    lock.set_password(body.new_password)
    # old codes die with the old passcode; hand out a fresh set
    return {"backup_codes": lock.generate_backup_codes()}


@router.post("/locked/lock")
def relock():
    lock.drop_token()
    return {"ok": True}


@router.get("/locked/items")
def items(x_locked_token: str | None = Header(default=None)):
    _require(x_locked_token)
    rows = db.query(
        "SELECT f.id, f.media_type, m.width, m.height, m.duration_s, "
        "substr(m.taken_at, 1, 10) AS day "
        "FROM locked_items li JOIN files f ON f.id=li.file_id "
        "LEFT JOIN metadata m ON m.file_id=f.id "
        "WHERE f.status='active' ORDER BY m.taken_at DESC, f.id DESC",
    )
    return [dict(r) for r in rows]


@router.post("/locked/items")
def add_items(body: ItemsIn, x_locked_token: str | None = Header(default=None)):
    _require(x_locked_token)
    now = int(time.time())
    with db.transaction() as conn:
        for fid in body.file_ids:
            conn.execute(
                "INSERT OR IGNORE INTO locked_items (file_id, locked_at) VALUES (?,?)",
                (fid, now),
            )
    return {"ok": True, "count": db.query_one("SELECT COUNT(*) n FROM locked_items")["n"]}


@router.post("/locked/items/remove")
def remove_items(body: ItemsIn, x_locked_token: str | None = Header(default=None)):
    _require(x_locked_token)
    with db.transaction() as conn:
        for fid in body.file_ids:
            conn.execute("DELETE FROM locked_items WHERE file_id=?", (fid,))
    return {"ok": True}
