"""Encrypted Locked Folder vault.

Locking a photo physically moves the original into DATA_DIR/locked as an
AES-256-GCM encrypted blob and deletes its `files` row (FK cascade wipes it
from albums, events, faces, places and dupes in one stroke), so nothing else
in the app can see it. All locked-item metadata lives in an encrypted manifest
inside the vault — the database keeps no trace.

Key hierarchy: a random 32-byte vault key is stored only wrapped — once by a
scrypt key derived from the PIN, and optionally once per WebAuthn credential
by an HKDF of the credential's PRF output (Touch ID). A forgotten PIN with no
enrolled credential means the contents are unrecoverable by design.

Blobs are chunked (VAULT_CHUNK) under a per-file HKDF subkey; each chunk's
AAD binds the header, chunk index and last-chunk flag, so truncation or
reordering fails authentication while ranged reads (video seeking) stay O(1).

The manifest doubles as a crash journal: items move through
moving_in -> locked -> restoring, and sweep() (run on unlock) finishes
whatever a crash interrupted without ever destroying an unverified file.
"""
import base64
import io
import json
import math
import os
import secrets
import shutil
import struct
import subprocess
import sys
import threading
import time

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .. import config, db
from . import thumbs
from . import volumes as vol_svc

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**17, 8, 1
FREE_ATTEMPTS = 5
MIN_PIN_LEN = 6
TAG = 16
MAGIC = b"SMRV1"
VERSION = 1
_HDR = struct.Struct(">5sB16sIQ")  # magic, version, file_salt, chunk_size, plaintext_size
KEY_AAD = b"smriti/vault-key/v1"
MANIFEST_AAD = b"smriti/manifest/v1"
THUMB_AAD = b"smriti/thumb/v1"
PREVIEW_AAD = b"smriti/preview/v1"
BLOB_INFO = b"smriti/blob/v1"
WEBAUTHN_INFO = b"smriti/webauthn-kek/v1"


class VaultError(Exception):
    """Message is safe to show in the UI (never contains paths)."""


class NotConfigured(VaultError):
    pass


class AlreadyConfigured(VaultError):
    pass


class BadPin(VaultError):
    pass


class Locked(VaultError):
    pass


class Backoff(VaultError):
    def __init__(self, retry_after: int):
        super().__init__(f"too many attempts — try again in {retry_after}s")
        self.retry_after = retry_after


class VaultDamaged(VaultError):
    pass


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _b64d(s: str) -> bytes:
    return base64.b64decode(s)


# -- vault.json (plaintext: wrapped keys, KDF params, backoff state) ----------

def _meta_path():
    return config.LOCKED_DIR / "vault.json"


def load_meta() -> dict | None:
    p = _meta_path()
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as e:
        raise VaultDamaged("vault metadata unreadable") from e


def _atomic_write(path, data: bytes) -> None:
    tmp = str(path) + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(str(path)), os.O_RDONLY)
        os.fsync(dfd)
        os.close(dfd)
    except OSError:
        pass


def _save_meta(meta: dict) -> None:
    _atomic_write(_meta_path(), json.dumps(meta, indent=1).encode())


def is_configured() -> bool:
    return _meta_path().exists()


# -- key derivation and wrapping ----------------------------------------------

def _kek_from_pin(pin: str, kdf: dict) -> bytes:
    return hashlib_scrypt(pin.encode(), _b64d(kdf["salt"]), kdf["n"], kdf["r"], kdf["p"])


def hashlib_scrypt(pw: bytes, salt: bytes, n: int, r: int, p: int) -> bytes:
    import hashlib

    return hashlib.scrypt(pw, salt=salt, n=n, r=r, p=p, maxmem=256 * 1024 * 1024, dklen=32)


def _hkdf(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(ikm)


def _wrap(secret: bytes, kek: bytes) -> dict:
    nonce = os.urandom(12)
    return {"nonce": _b64e(nonce), "ct": _b64e(AESGCM(kek).encrypt(nonce, secret, KEY_AAD))}


def _unwrap(wrapped: dict, kek: bytes) -> bytes:
    return AESGCM(kek).decrypt(_b64d(wrapped["nonce"]), _b64d(wrapped["ct"]), KEY_AAD)


# -- sessions (memory only — server restart relocks by construction) ----------

_state = threading.Lock()
_vault_key: bytes | None = None
_sessions: dict[str, float] = {}          # token -> expires_at
_streams: dict[str, tuple[str, str]] = {}  # stream token -> (vault_id, session token)
_vault_mutex = threading.Lock()            # serializes move_in / restore / delete / sweep


def auto_lock_seconds() -> int:
    row = db.query_one("SELECT value FROM settings WHERE key=?", ("locked_auto_minutes",))
    try:
        minutes = int(row["value"]) if row and row["value"] else 5
    except (TypeError, ValueError):
        minutes = 5
    return max(1, min(60, minutes)) * 60


def _prune_locked() -> None:
    # caller holds _state
    global _vault_key
    now = time.monotonic()
    for tok in [t for t, exp in _sessions.items() if exp <= now]:
        del _sessions[tok]
    live = set(_sessions)
    for st in [s for s, (_, parent) in _streams.items() if parent not in live]:
        del _streams[st]
    if not _sessions:
        _vault_key = None
        _streams.clear()


def _start_session(key: bytes) -> str:
    global _vault_key
    token = secrets.token_urlsafe(32)
    with _state:
        _vault_key = key
        _sessions[token] = time.monotonic() + auto_lock_seconds()
    return token


def touch(token: str | None) -> bytes:
    """Validate a session token, slide its expiry, return the vault key."""
    with _state:
        _prune_locked()
        if not token or token not in _sessions or _vault_key is None:
            raise Locked("locked")
        _sessions[token] = time.monotonic() + auto_lock_seconds()
        return _vault_key


def unlocked() -> bool:
    with _state:
        _prune_locked()
        return _vault_key is not None


def lock_all() -> None:
    global _vault_key
    with _state:
        _sessions.clear()
        _streams.clear()
        _vault_key = None


def mint_stream_token(session_token: str, vault_id: str) -> str:
    touch(session_token)
    st = secrets.token_urlsafe(24)
    with _state:
        _streams[st] = (vault_id, session_token)
    return st


def stream_key(st: str | None, vault_id: str) -> bytes:
    """Key for a query-param stream token; playback counts as activity."""
    with _state:
        _prune_locked()
        entry = _streams.get(st or "")
        if entry is None or entry[0] != vault_id or _vault_key is None:
            raise Locked("locked")
        parent = entry[1]
        if parent not in _sessions:
            raise Locked("locked")
        _sessions[parent] = time.monotonic() + auto_lock_seconds()
        return _vault_key


# -- PIN lifecycle ------------------------------------------------------------

def _check_backoff(meta: dict) -> None:
    until = meta.get("locked_until", 0)
    if until > time.time():
        raise Backoff(int(until - time.time()) + 1)


def _record_fail(meta: dict) -> None:
    meta["fails"] = meta.get("fails", 0) + 1
    if meta["fails"] >= FREE_ATTEMPTS:
        delay = min(30 * 2 ** (meta["fails"] - FREE_ATTEMPTS), 900)
        meta["locked_until"] = int(time.time()) + delay
    _save_meta(meta)


def _reset_fails(meta: dict) -> None:
    if meta.get("fails") or meta.get("locked_until"):
        meta["fails"] = 0
        meta["locked_until"] = 0
        _save_meta(meta)


def setup(pin: str) -> str:
    """Create the vault; returns a session token (setup implies unlock)."""
    if is_configured():
        raise AlreadyConfigured("locked folder is already set up")
    if len(pin) < MIN_PIN_LEN:
        raise VaultError(f"PIN must be at least {MIN_PIN_LEN} characters")
    config.ensure_dirs()
    vault_key = os.urandom(32)
    kdf = {"salt": _b64e(os.urandom(16)), "n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P}
    meta = {"version": 1, "kdf": kdf, "pin": _wrap(vault_key, _kek_from_pin(pin, kdf)),
            "webauthn": [], "fails": 0, "locked_until": 0}
    _save_meta(meta)
    _exclude_from_backups()
    return _start_session(vault_key)


def unlock_pin(pin: str) -> str:
    meta = load_meta()
    if meta is None:
        raise NotConfigured("locked folder is not set up")
    _check_backoff(meta)
    try:
        key = _unwrap(meta["pin"], _kek_from_pin(pin, meta["kdf"]))
    except InvalidTag:
        _record_fail(meta)
        raise BadPin("wrong PIN") from None
    _reset_fails(meta)
    token = _start_session(key)
    try:
        sweep(key)
    except Exception:
        pass  # recovery is best-effort; never block an unlock
    return token


def change_pin(current: str, new: str) -> None:
    meta = load_meta()
    if meta is None:
        raise NotConfigured("locked folder is not set up")
    if len(new) < MIN_PIN_LEN:
        raise VaultError(f"PIN must be at least {MIN_PIN_LEN} characters")
    _check_backoff(meta)
    try:
        key = _unwrap(meta["pin"], _kek_from_pin(current, meta["kdf"]))
    except InvalidTag:
        _record_fail(meta)
        raise BadPin("wrong PIN") from None
    _reset_fails(meta)
    kdf = {"salt": _b64e(os.urandom(16)), "n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P}
    meta["kdf"] = kdf
    meta["pin"] = _wrap(key, _kek_from_pin(new, kdf))  # WebAuthn wrappings untouched
    _save_meta(meta)


# -- WebAuthn (PRF extension) -------------------------------------------------
# The browser evaluates the authenticator's PRF after Touch ID / passcode
# verification and hands us the output; deriving a KEK from it and unwrapping
# the vault key IS the authentication — no assertion-signature verification
# needed, and nothing stored here unlocks anything on its own.

def webauthn_enroll(session_token: str, credential_id: str, prf_salt: str, prf_output: str) -> None:
    key = touch(session_token)
    meta = load_meta()
    if meta is None:
        raise NotConfigured("locked folder is not set up")
    kek = _hkdf(_b64d(prf_output), salt=b"", info=WEBAUTHN_INFO)
    meta["webauthn"] = [c for c in meta.get("webauthn", []) if c["id"] != credential_id]
    meta["webauthn"].append({"id": credential_id, "prf_salt": prf_salt, "wrap": _wrap(key, kek)})
    _save_meta(meta)


def webauthn_credentials() -> list[dict]:
    meta = load_meta()
    if meta is None:
        return []
    return [{"id": c["id"], "prf_salt": c["prf_salt"]} for c in meta.get("webauthn", [])]


def webauthn_unlock(credential_id: str, prf_output: str) -> str:
    meta = load_meta()
    if meta is None:
        raise NotConfigured("locked folder is not set up")
    _check_backoff(meta)
    cred = next((c for c in meta.get("webauthn", []) if c["id"] == credential_id), None)
    if cred is None:
        raise BadPin("unknown credential")
    try:
        key = _unwrap(cred["wrap"], _hkdf(_b64d(prf_output), salt=b"", info=WEBAUTHN_INFO))
    except InvalidTag:
        _record_fail(meta)
        raise BadPin("authentication failed") from None
    _reset_fails(meta)
    token = _start_session(key)
    try:
        sweep(key)
    except Exception:
        pass
    return token


def webauthn_remove(session_token: str, credential_id: str | None = None) -> None:
    touch(session_token)
    meta = load_meta()
    if meta is None:
        return
    creds = meta.get("webauthn", [])
    meta["webauthn"] = [] if credential_id is None else [c for c in creds if c["id"] != credential_id]
    _save_meta(meta)


# -- chunked blob container ---------------------------------------------------

def _subkey(vault_key: bytes, file_salt: bytes) -> bytes:
    return _hkdf(vault_key, salt=file_salt, info=BLOB_INFO)


def _nonce(i: int) -> bytes:
    return b"\x00\x00\x00\x00" + i.to_bytes(8, "big")


def _aad(header: bytes, i: int, is_last: bool) -> bytes:
    return header + struct.pack(">QB", i, 1 if is_last else 0)


def encrypt_file(src_path: str, dest_path, vault_key: bytes) -> int:
    """Encrypt src into the chunked container at dest (atomically). -> size"""
    size = os.path.getsize(src_path)
    file_salt = os.urandom(16)
    header = _HDR.pack(MAGIC, VERSION, file_salt, config.VAULT_CHUNK, size)
    aes = AESGCM(_subkey(vault_key, file_salt))
    nchunks = max(1, math.ceil(size / config.VAULT_CHUNK))
    tmp = str(dest_path) + ".tmp"
    try:
        with open(src_path, "rb") as src, open(tmp, "wb") as out:
            out.write(header)
            for i in range(nchunks):
                chunk = src.read(config.VAULT_CHUNK)
                out.write(aes.encrypt(_nonce(i), chunk, _aad(header, i, i == nchunks - 1)))
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, dest_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(os.path.dirname(str(dest_path)), os.O_RDONLY)
        os.fsync(dfd)
        os.close(dfd)
    except OSError:
        pass
    return size


def blob_size(path) -> int:
    with open(path, "rb") as f:
        magic, version, _, _, size = _HDR.unpack(f.read(_HDR.size))
    if magic != MAGIC or version != VERSION:
        raise VaultDamaged("bad blob header")
    return size


def decrypt_range(path, vault_key: bytes, start: int = 0, end: int | None = None):
    """Yield plaintext bytes for the inclusive range [start, end]."""
    with open(path, "rb") as f:
        raw = f.read(_HDR.size)
        magic, version, file_salt, chunk_size, size = _HDR.unpack(raw)
        if magic != MAGIC or version != VERSION:
            raise VaultDamaged("bad blob header")
        header = raw
        aes = AESGCM(_subkey(vault_key, file_salt))
        if size == 0:
            aes.decrypt(_nonce(0), f.read(), _aad(header, 0, True))  # authenticate even empty
            return
        end = size - 1 if end is None else min(end, size - 1)
        if start > end:
            return
        nchunks = max(1, math.ceil(size / chunk_size))
        for k in range(start // chunk_size, end // chunk_size + 1):
            plain_len = min(chunk_size, size - k * chunk_size)
            f.seek(_HDR.size + k * (chunk_size + TAG))
            ct = f.read(plain_len + TAG)
            pt = aes.decrypt(_nonce(k), ct, _aad(header, k, k == nchunks - 1))
            lo = max(start - k * chunk_size, 0)
            hi = min(end - k * chunk_size + 1, plain_len)
            yield pt[lo:hi]


def decrypt_to_file(path, vault_key: bytes, dest_tmp: str) -> None:
    with open(dest_tmp, "wb") as out:
        for part in decrypt_range(path, vault_key):
            out.write(part)
        out.flush()
        os.fsync(out.fileno())


# -- small sealed blobs (manifest / thumbs / previews) ------------------------

def seal(data: bytes, vault_key: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(vault_key).encrypt(nonce, data, aad)


def unseal(blob: bytes, vault_key: bytes, aad: bytes) -> bytes:
    try:
        return AESGCM(vault_key).decrypt(blob[:12], blob[12:], aad)
    except InvalidTag:
        raise VaultDamaged("decryption failed") from None


def _manifest_path():
    return config.LOCKED_DIR / "manifest.enc"


def load_manifest(vault_key: bytes) -> list[dict]:
    p = _manifest_path()
    if not p.exists():
        return []
    return json.loads(unseal(p.read_bytes(), vault_key, MANIFEST_AAD))


def save_manifest(vault_key: bytes, items: list[dict]) -> None:
    _atomic_write(_manifest_path(), seal(json.dumps(items).encode(), vault_key, MANIFEST_AAD))


def _blob_path(vault_id: str):
    return config.LOCKED_BLOBS_DIR / f"{vault_id}.enc"


def _thumb_path(vault_id: str):
    return config.LOCKED_THUMBS_DIR / f"{vault_id}.enc"


def _preview_path(vault_id: str):
    return config.LOCKED_PREVIEWS_DIR / f"{vault_id}.enc"


# -- move in ------------------------------------------------------------------

def _webp_bytes(abs_path: str, max_dim: int) -> bytes | None:
    from PIL import ImageOps

    img = thumbs._decode_full(abs_path)
    if img is None:
        return None
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((max_dim, max_dim))
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=config.PREVIEW_WEBP_QUALITY, method=4)
    return buf.getvalue()


def _delete_index_entry(file_row) -> set[int]:
    """Remove a files row and every on-disk derived artifact; -> affected person ids."""
    fid = file_row["id"]
    faces = db.query("SELECT id, person_id FROM faces WHERE file_id=?", (fid,))
    db.execute("DELETE FROM files WHERE id=?", (fid,))  # cascades everywhere
    for p in (thumbs.thumb_path(fid), thumbs.preview_path(fid)):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
    for face in faces:
        try:
            config.shard_path(config.FACE_CROPS_DIR, face["id"], suffix=".v2.webp").unlink(missing_ok=True)
        except OSError:
            pass
    return {f["person_id"] for f in faces if f["person_id"]}


def _post_move_cleanup(person_ids: set[int]) -> None:
    from ..jobs import faces as faces_job

    for pid in person_ids:
        try:
            faces_job.recompute_centroid(pid)
        except Exception:
            pass
    db.execute("DELETE FROM persons WHERE name IS NULL AND id NOT IN "
               "(SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL)")
    db.execute("DELETE FROM events WHERE id NOT IN (SELECT DISTINCT event_id FROM event_items)")
    db.execute("UPDATE events SET cover_file_id="
               "(SELECT ei.file_id FROM event_items ei WHERE ei.event_id=events.id LIMIT 1) "
               "WHERE cover_file_id IS NOT NULL AND cover_file_id NOT IN (SELECT id FROM files)")
    db.execute("UPDATE albums SET cover_file_id=NULL "
               "WHERE cover_file_id IS NOT NULL AND cover_file_id NOT IN (SELECT id FROM files)")
    # deleted rows (paths, GPS) linger in WAL/free pages; checkpoint shrinks the window
    try:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:
        pass


def move_in(session_token: str, file_ids: list[int]) -> dict:
    key = touch(session_token)
    locked = skipped_offline = 0
    errors: list[dict] = []
    affected: set[int] = set()
    with _vault_mutex:
        items = load_manifest(key)
        for fid in file_ids:
            row = db.query_one("SELECT * FROM files WHERE id=?", (fid,))
            if not row or row["status"] != "active":
                continue
            abs_path = vol_svc.abs_path_for_file(row)
            if abs_path is None or not os.path.exists(abs_path):
                skipped_offline += 1
                continue
            size = os.path.getsize(abs_path)
            if shutil.disk_usage(config.DATA_DIR).free < size + 512 * 1024 * 1024:
                errors.append({"id": fid, "error": "not enough free space in the data directory"})
                break
            vol = db.query_one("SELECT disk_uuid FROM volumes WHERE id=?", (row["volume_id"],))
            meta_row = db.query_one("SELECT * FROM metadata WHERE file_id=?", (fid,))
            vault_id = secrets.token_hex(16)
            try:
                encrypt_file(abs_path, _blob_path(vault_id), key)
                tp = thumbs.thumb_path(fid)
                thumb_bytes = tp.read_bytes() if tp.exists() else (
                    _webp_bytes(abs_path, config.THUMB_MAX_DIM) if row["media_type"] == "photo" else None)
                if thumb_bytes:
                    _atomic_write(_thumb_path(vault_id), seal(thumb_bytes, key, THUMB_AAD))
                if row["media_type"] == "photo":
                    pv = _webp_bytes(abs_path, config.PREVIEW_MAX_DIM)
                    if pv:
                        _atomic_write(_preview_path(vault_id), seal(pv, key, PREVIEW_AAD))
            except Exception:
                for p in (_blob_path(vault_id), _thumb_path(vault_id), _preview_path(vault_id)):
                    try:
                        p.unlink(missing_ok=True)
                    except OSError:
                        pass
                errors.append({"id": fid, "error": "encryption failed"})
                continue
            item = {
                "vault_id": vault_id, "state": "moving_in",
                "disk_uuid": vol["disk_uuid"] if vol else None,
                "rel_path": row["rel_path"], "filename": row["filename"],
                "media_type": row["media_type"], "size_bytes": size,
                "mtime_ns": row["mtime_ns"],
                "taken_at": meta_row["taken_at"] if meta_row else None,
                "width": meta_row["width"] if meta_row else None,
                "height": meta_row["height"] if meta_row else None,
                "duration_s": meta_row["duration_s"] if meta_row else None,
                "locked_at": int(time.time()),
            }
            items.append(item)
            save_manifest(key, items)  # <- from here on the encrypted copy is the source of truth
            try:
                os.remove(abs_path)  # deliberately not send2trash: Trash would keep plaintext
            except OSError as e:
                # couldn't remove the original: undo — keep library consistent
                items.remove(item)
                save_manifest(key, items)
                for p in (_blob_path(vault_id), _thumb_path(vault_id), _preview_path(vault_id)):
                    try:
                        p.unlink(missing_ok=True)
                    except OSError:
                        pass
                errors.append({"id": fid, "error": f"could not remove original ({e.__class__.__name__})"})
                continue
            affected |= _delete_index_entry(row)
            item["state"] = "locked"
            save_manifest(key, items)
            locked += 1
        if locked:
            _post_move_cleanup(affected)
    return {"locked": locked, "skipped_offline": skipped_offline, "errors": errors}


# -- restore / delete ---------------------------------------------------------

def _mount_for_disk_uuid(disk_uuid: str | None) -> str | None:
    if not disk_uuid:
        return None
    vol = db.query_one("SELECT id FROM volumes WHERE disk_uuid=?", (disk_uuid,))
    if not vol:
        return None
    return vol_svc.mount_path_for_volume(vol["id"])


def _collision_free(dest: str) -> str:
    if not os.path.exists(dest):
        return dest
    stem, ext = os.path.splitext(dest)
    for n in range(1, 1000):
        cand = f"{stem} (restored){ext}" if n == 1 else f"{stem} (restored {n}){ext}"
        if not os.path.exists(cand):
            return cand
    raise VaultError("could not find a free filename to restore to")


def _under_any_root(dest: str) -> bool:
    for r in db.query("SELECT r.rel_path, r.volume_id FROM roots r"):
        mount = vol_svc.mount_path_for_volume(r["volume_id"])
        if mount is None:
            continue
        root_abs = os.path.join(mount, *r["rel_path"].split("/")) if r["rel_path"] else mount
        if os.path.commonpath([os.path.abspath(dest), os.path.abspath(root_abs)]) == os.path.abspath(root_abs):
            return True
    return False


def _remove_vault_files(vault_id: str) -> None:
    for p in (_blob_path(vault_id), _thumb_path(vault_id), _preview_path(vault_id)):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


def restore(session_token: str, vault_ids: list[str]) -> dict:
    key = touch(session_token)
    restored = skipped_offline = outside_library = 0
    errors: list[dict] = []
    with _vault_mutex:
        items = load_manifest(key)
        by_id = {it["vault_id"]: it for it in items}
        for vid in vault_ids:
            item = by_id.get(vid)
            if item is None or item["state"] == "moving_in":
                continue
            mount = _mount_for_disk_uuid(item.get("disk_uuid"))
            if mount is None:
                skipped_offline += 1
                continue
            try:
                dest = _collision_free(os.path.join(mount, *item["rel_path"].split("/")))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                item["state"] = "restoring"
                item["restore_rel"] = os.path.relpath(dest, mount).replace(os.sep, "/")
                save_manifest(key, items)
                tmp = dest + ".smriti.tmp"
                decrypt_to_file(_blob_path(vid), key, tmp)
                os.replace(tmp, dest)
                if item.get("mtime_ns"):
                    os.utime(dest, ns=(item["mtime_ns"], item["mtime_ns"]))
                items.remove(item)
                save_manifest(key, items)
                _remove_vault_files(vid)
                if not _under_any_root(dest):
                    outside_library += 1
                restored += 1
            except VaultDamaged:
                errors.append({"vault_id": vid, "error": "encrypted copy is damaged"})
            except OSError as e:
                errors.append({"vault_id": vid, "error": f"restore failed ({e.__class__.__name__})"})
                item["state"] = "locked"
                item.pop("restore_rel", None)
                save_manifest(key, items)
    if restored:
        _trigger_rescan()
    return {"restored": restored, "skipped_offline": skipped_offline,
            "outside_library": outside_library, "errors": errors}


def delete_permanently(session_token: str, vault_ids: list[str]) -> dict:
    key = touch(session_token)
    deleted = 0
    with _vault_mutex:
        items = load_manifest(key)
        keep = []
        for it in items:
            if it["vault_id"] in vault_ids and it["state"] != "moving_in":
                _remove_vault_files(it["vault_id"])
                deleted += 1
            else:
                keep.append(it)
        if deleted:
            save_manifest(key, keep)
    return {"deleted": deleted}


def list_items(session_token: str) -> list[dict]:
    key = touch(session_token)
    with _vault_mutex:
        items = load_manifest(key)
    fields = ("vault_id", "state", "filename", "media_type", "size_bytes", "taken_at",
              "width", "height", "duration_s", "locked_at", "warning")
    out = [{k: it.get(k) for k in fields} for it in items]
    out.sort(key=lambda it: (it.get("taken_at") or "", it.get("locked_at") or 0), reverse=True)
    return out


def read_thumb(session_token: str, vault_id: str) -> bytes | None:
    key = touch(session_token)
    p = _thumb_path(vault_id)
    return unseal(p.read_bytes(), key, THUMB_AAD) if p.exists() else None


def read_preview(session_token: str, vault_id: str) -> bytes | None:
    key = touch(session_token)
    p = _preview_path(vault_id)
    if p.exists():
        return unseal(p.read_bytes(), key, PREVIEW_AAD)
    return read_thumb(session_token, vault_id)


# -- crash recovery -----------------------------------------------------------

def sweep(vault_key: bytes) -> None:
    """Finish interrupted move-ins/restores. Never deletes a file it cannot
    verify against the manifest (size match), and skips offline drives."""
    with _vault_mutex:
        items = load_manifest(vault_key)
        changed = False
        affected: set[int] = set()
        for item in list(items):
            state = item.get("state")
            if state == "locked":
                continue
            mount = _mount_for_disk_uuid(item.get("disk_uuid"))
            if state == "moving_in":
                if mount is None:
                    continue  # can't verify the original — retry when the drive is back
                src = os.path.join(mount, *item["rel_path"].split("/"))
                if os.path.exists(src):
                    if os.path.getsize(src) == item["size_bytes"]:
                        try:
                            os.remove(src)
                        except OSError:
                            continue
                    else:
                        item["warning"] = "original changed after locking — left in place"
                # the scanner may have (re)indexed it under any id
                vol = db.query_one("SELECT id FROM volumes WHERE disk_uuid=?", (item["disk_uuid"],))
                if vol:
                    row = db.query_one("SELECT * FROM files WHERE volume_id=? AND rel_path=?",
                                       (vol["id"], item["rel_path"]))
                    if row:
                        affected |= _delete_index_entry(row)
                item["state"] = "locked"
                changed = True
            elif state == "restoring":
                if mount is None:
                    continue
                rel = item.get("restore_rel") or item["rel_path"]
                dest = os.path.join(mount, *rel.split("/"))
                if os.path.exists(dest) and os.path.getsize(dest) == item["size_bytes"]:
                    items.remove(item)
                    _remove_vault_files(item["vault_id"])
                else:
                    item["state"] = "locked"  # retry restore later; blob still intact
                    item.pop("restore_rel", None)
                changed = True
        if changed:
            save_manifest(vault_key, items)
            if affected:
                _post_move_cleanup(affected)


# -- misc ---------------------------------------------------------------------

def _trigger_rescan() -> None:
    try:
        import asyncio

        from ..jobs import pipeline
        from ..jobs.runner import manager

        if manager.loop is not None and not manager.any_running():
            asyncio.run_coroutine_threadsafe(pipeline.auto_scan_once(), manager.loop)
    except Exception:
        pass  # the auto-scan loop will pick the change up on its own schedule


def _exclude_from_backups() -> None:
    if sys.platform == "darwin":
        try:
            subprocess.run(["tmutil", "addexclusion", str(config.LOCKED_DIR)],
                           capture_output=True, timeout=10)
        except Exception:
            pass


def status() -> dict:
    meta = None
    damaged = False
    try:
        meta = load_meta()
    except VaultDamaged:
        damaged = True
    lockout = 0
    if meta and meta.get("locked_until", 0) > time.time():
        lockout = int(meta["locked_until"] - time.time()) + 1
    return {
        "configured": meta is not None or damaged,
        "damaged": damaged,
        "unlocked": unlocked(),
        "webauthn_enrolled": bool(meta and meta.get("webauthn")),
        "lockout_seconds": lockout,
        "auto_lock_seconds": auto_lock_seconds(),
    }
