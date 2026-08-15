"""Locked Folder HTTP API. Sessions ride the X-Vault-Session header; <img>/
<video>/<a download> use short-lived stream tokens (?st=) minted per item and
killed on relock. A middleware in main.py stamps Cache-Control: no-store on
everything under /api/locked so relocking leaves nothing in the browser cache.
Error messages never contain filesystem paths."""
import os
import re
import secrets

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from ..services import vault
from .media import VIDEO_TYPES

router = APIRouter()

IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
               ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
               ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff",
               ".bmp": "image/bmp", ".avif": "image/avif"}


def _http(e: vault.VaultError) -> HTTPException:
    if isinstance(e, vault.Backoff):
        return HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})
    if isinstance(e, (vault.BadPin, vault.Locked)):
        return HTTPException(401, str(e))
    if isinstance(e, vault.AlreadyConfigured):
        return HTTPException(409, str(e))
    if isinstance(e, vault.NotConfigured):
        return HTTPException(409, str(e))
    if isinstance(e, vault.VaultDamaged):
        return HTTPException(500, str(e))
    return HTTPException(400, str(e))


class PinIn(BaseModel):
    pin: str


class ChangePinIn(BaseModel):
    current_pin: str
    new_pin: str


class LockIn(BaseModel):
    token: str | None = None


class MoveInBody(BaseModel):
    file_ids: list[int]


class RestoreBody(BaseModel):
    vault_ids: list[str]


class StreamTokenIn(BaseModel):
    vault_id: str


class EnrollIn(BaseModel):
    credential_id: str
    prf_salt: str
    prf_output: str


class WebauthnUnlockIn(BaseModel):
    credential_id: str
    prf_output: str


class WebauthnRemoveIn(BaseModel):
    credential_id: str | None = None


@router.get("/locked/status")
def locked_status():
    return vault.status()


@router.post("/locked/setup")
def locked_setup(body: PinIn):
    try:
        return {"token": vault.setup(body.pin)}
    except vault.VaultError as e:
        raise _http(e) from None


@router.post("/locked/unlock")
def locked_unlock(body: PinIn):
    try:
        return {"token": vault.unlock_pin(body.pin)}
    except vault.VaultError as e:
        raise _http(e) from None


@router.post("/locked/lock")
def locked_lock(body: LockIn | None = None):
    # locking is always allowed — it only ever *reduces* exposure
    vault.lock_all()
    return {"ok": True}


@router.post("/locked/change-pin")
def locked_change_pin(body: ChangePinIn):
    try:
        vault.change_pin(body.current_pin, body.new_pin)
    except vault.VaultError as e:
        raise _http(e) from None
    return {"ok": True}


# -- WebAuthn (PRF) -----------------------------------------------------------

@router.get("/locked/webauthn/request")
def webauthn_request():
    """Challenge + enrolled credentials for an unlock ceremony. The challenge
    is ceremony hygiene only — the PRF output unwrapping the key is the proof."""
    return {"challenge": secrets.token_urlsafe(32), "credentials": vault.webauthn_credentials()}


@router.post("/locked/webauthn/enroll")
def webauthn_enroll(body: EnrollIn, x_vault_session: str | None = Header(None)):
    try:
        vault.webauthn_enroll(x_vault_session, body.credential_id, body.prf_salt, body.prf_output)
    except vault.VaultError as e:
        raise _http(e) from None
    return {"ok": True}


@router.post("/locked/webauthn/unlock")
def webauthn_unlock(body: WebauthnUnlockIn):
    try:
        return {"token": vault.webauthn_unlock(body.credential_id, body.prf_output)}
    except vault.VaultError as e:
        raise _http(e) from None


@router.post("/locked/webauthn/remove")
def webauthn_remove(body: WebauthnRemoveIn, x_vault_session: str | None = Header(None)):
    try:
        vault.webauthn_remove(x_vault_session, body.credential_id)
    except vault.VaultError as e:
        raise _http(e) from None
    return {"ok": True}


# -- content ------------------------------------------------------------------

@router.get("/locked/items")
def locked_items(x_vault_session: str | None = Header(None)):
    try:
        return vault.list_items(x_vault_session)
    except vault.VaultError as e:
        raise _http(e) from None


@router.get("/locked/thumb/{vault_id}")
def locked_thumb(vault_id: str, x_vault_session: str | None = Header(None)):
    try:
        data = vault.read_thumb(x_vault_session, vault_id)
    except vault.VaultError as e:
        raise _http(e) from None
    if data is None:
        raise HTTPException(404, "no thumbnail")
    return Response(data, media_type="image/webp")


@router.get("/locked/preview/{vault_id}")
def locked_preview(vault_id: str, x_vault_session: str | None = Header(None)):
    try:
        data = vault.read_preview(x_vault_session, vault_id)
    except vault.VaultError as e:
        raise _http(e) from None
    if data is None:
        raise HTTPException(404, "no preview")
    return Response(data, media_type="image/webp")


@router.post("/locked/stream-token")
def locked_stream_token(body: StreamTokenIn, x_vault_session: str | None = Header(None)):
    try:
        return {"token": vault.mint_stream_token(x_vault_session, body.vault_id)}
    except vault.VaultError as e:
        raise _http(e) from None


@router.get("/locked/media/{vault_id}")
def locked_media(vault_id: str, request: Request, st: str | None = None, download: int = 0):
    try:
        key = vault.stream_key(st, vault_id)
        items = vault.load_manifest(key)
    except vault.VaultError as e:
        raise _http(e) from None
    item = next((it for it in items if it["vault_id"] == vault_id), None)
    blob = vault._blob_path(vault_id)
    if item is None or not blob.exists():
        raise HTTPException(404, "no such item")
    ext = os.path.splitext(item["filename"])[1].lower()
    if item["media_type"] == "video":
        mime = VIDEO_TYPES.get(ext, "application/octet-stream")
    else:
        mime = IMAGE_TYPES.get(ext, "application/octet-stream")
    size = vault.blob_size(blob)
    extra = {}
    if download:
        extra["Content-Disposition"] = f'attachment; filename="{item["filename"]}"'

    range_header = request.headers.get("range")
    if not range_header:
        return StreamingResponse(
            vault.decrypt_range(blob, key), media_type=mime,
            headers={"Accept-Ranges": "bytes", "Content-Length": str(size), **extra},
        )
    m = re.match(r"bytes=(\d*)-(\d*)", range_header)
    if not m:
        raise HTTPException(416, "bad range")
    start = int(m.group(1)) if m.group(1) else 0
    end = int(m.group(2)) if m.group(2) else size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        raise HTTPException(416, "range out of bounds")
    return StreamingResponse(
        vault.decrypt_range(blob, key, start, end), status_code=206, media_type=mime,
        headers={"Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes",
                 "Content-Length": str(end - start + 1), **extra},
    )


# -- moving content -----------------------------------------------------------

@router.post("/locked/move-in")
def locked_move_in(body: MoveInBody, x_vault_session: str | None = Header(None)):
    try:
        return vault.move_in(x_vault_session, body.file_ids)
    except vault.VaultError as e:
        raise _http(e) from None


@router.post("/locked/restore")
def locked_restore(body: RestoreBody, x_vault_session: str | None = Header(None)):
    try:
        return vault.restore(x_vault_session, body.vault_ids)
    except vault.VaultError as e:
        raise _http(e) from None


@router.post("/locked/delete")
def locked_delete(body: RestoreBody, x_vault_session: str | None = Header(None)):
    try:
        return vault.delete_permanently(x_vault_session, body.vault_ids)
    except vault.VaultError as e:
        raise _http(e) from None
