"""End-to-end test for the Locked Folder: boots the server in-process against
a temp data dir + generated photo library, then exercises setup, PIN backoff,
move-in (row/artifacts gone, no scanner resurrection), streaming, relock,
restore (byte-identical, collisions), permanent delete and crash-recovery
sweep. Run: uv run python scripts/locked_test.py"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

WORK = tempfile.mkdtemp(prefix="smriti-locked-test-")
DATA = os.path.join(WORK, "data")
PHOTOS = os.path.join(WORK, "photos")
os.makedirs(PHOTOS)
os.environ["SMRITI_DATA_DIR"] = DATA
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

PORT = 6972
BASE = f"http://127.0.0.1:{PORT}"
FAILS: list[str] = []


def check(name, ok, extra=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name} {extra}")
    if not ok:
        FAILS.append(name)


def req(method, path, body=None, headers=None, raw=False):
    r = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            data = resp.read()
            return resp.status, (data if raw else json.loads(data)), resp.headers
    except urllib.error.HTTPError as e:
        data = e.read()
        try:
            data = json.loads(data)
        except Exception:
            pass
        return e.code, data, e.headers


def wait_idle(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        _, jobs, _ = req("GET", "/api/jobs?limit=10")
        if not any(j["status"] == "running" for j in jobs):
            return
        time.sleep(0.4)
    raise SystemExit("jobs never went idle")


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main():
    # ---- library: three distinct JPEGs ------------------------------------------
    from PIL import Image  # noqa: E402

    for i, color in enumerate([(200, 40, 40), (40, 200, 40), (40, 40, 200)]):
        img = Image.new("RGB", (800 + i * 100, 600), color)
        for x in range(0, 700, 15):  # texture so JPEGs aren't trivially tiny
            for y in range(0, 500, 15):
                img.putpixel((x, y), (x % 255, y % 255, (x + y) % 255))
        img.save(os.path.join(PHOTOS, f"photo{i}.jpg"), quality=90)

    # ---- boot -------------------------------------------------------------------
    import uvicorn  # noqa: E402

    from app.main import app  # noqa: E402

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(100):
        time.sleep(0.2)
        try:
            req("GET", "/api/health")
            break
        except Exception:
            pass
    else:
        raise SystemExit("server did not start")

    s, root, _ = req("POST", "/api/roots", {"path": PHOTOS})
    check("root registered", s == 200, root)
    req("POST", "/api/process", {"root_id": root["id"]})
    wait_idle()
    _, stats, _ = req("GET", "/api/stats")
    check("library indexed", stats["photos"] == 3, stats["photos"])

    # ---- setup + PIN backoff ----------------------------------------------------
    s, r, _ = req("POST", "/api/locked/setup", {"pin": "orange-battery-7"})
    check("setup ok", s == 200)
    tok = r["token"]
    req("POST", "/api/locked/lock", {})
    codes = [req("POST", "/api/locked/unlock", {"pin": f"nope-{i}-nope"})[0] for i in range(5)]
    s2, _, hdrs = req("POST", "/api/locked/unlock", {"pin": "orange-battery-7"})
    check("backoff after failed attempts", all(c in (401, 429) for c in codes) and s2 == 429,
          f"({codes} then {s2}, retry-after {hdrs.get('Retry-After')})")
    meta_path = os.path.join(DATA, "locked", "vault.json")
    meta = json.load(open(meta_path))
    meta["fails"] = 0
    meta["locked_until"] = 0
    json.dump(meta, open(meta_path, "w"))
    s, r, _ = req("POST", "/api/locked/unlock", {"pin": "orange-battery-7"})
    check("unlock after backoff reset", s == 200)
    tok = r["token"]
    H = {"X-Vault-Session": tok}

    # ---- move in ----------------------------------------------------------------
    _, buckets, _ = req("GET", "/api/timeline/buckets")
    _, items0, _ = req("GET", f"/api/timeline/items?day={buckets[0]['day']}")
    target = items0[0]["id"]
    orig_path = os.path.join(PHOTOS, "photo0.jpg")
    by_name = {}
    for it in items0:
        _, fi, _ = req("GET", f"/api/files/{it['id']}")
        by_name[fi["filename"]] = it["id"]
    target = by_name["photo0.jpg"]
    orig_bytes = open(orig_path, "rb").read()
    orig_mtime = os.stat(orig_path).st_mtime_ns

    s, r, _ = req("POST", "/api/locked/move-in", {"file_ids": [target]}, headers=H)
    check("move-in ok", s == 200 and r["locked"] == 1, r)
    check("original removed from folder", not os.path.exists(orig_path))
    check("files row gone", req("GET", f"/api/files/{target}")[0] == 404)
    check("thumb gone", req("GET", f"/api/thumb/{target}")[0] == 404)
    _, stats, _ = req("GET", "/api/stats")
    check("stats exclude locked", stats["photos"] == 2, stats["photos"])
    blobs = os.listdir(os.path.join(DATA, "locked", "blobs"))
    check("encrypted blob exists", len(blobs) == 1, blobs)
    check("no plaintext in blob", orig_bytes[:16] not in open(os.path.join(DATA, "locked", "blobs", blobs[0]), "rb").read())

    s, litems, _ = req("GET", "/api/locked/items", headers=H)
    check("locked items lists 1", s == 200 and len(litems) == 1 and litems[0]["filename"] == "photo0.jpg", litems)
    vid = litems[0]["vault_id"]
    check("thumb 401 without session", req("GET", f"/api/locked/thumb/{vid}")[0] == 401)
    s, tb, h = req("GET", f"/api/locked/thumb/{vid}", headers=H, raw=True)
    check("thumb decrypts with session", s == 200 and len(tb) > 100 and h.get("Cache-Control") == "no-store")

    s, st, _ = req("POST", "/api/locked/stream-token", {"vault_id": vid}, headers=H)
    s, media, _ = req("GET", f"/api/locked/media/{vid}?st={st['token']}", raw=True)
    check("streamed media byte-identical", s == 200 and sha(media) == sha(orig_bytes))
    s, part, h = req("GET", f"/api/locked/media/{vid}?st={st['token']}", headers={"Range": "bytes=100-199"}, raw=True)
    check("range request works", s == 206 and part == orig_bytes[100:200] and "100-199" in h.get("Content-Range", ""))

    # ---- scanner must not resurrect ---------------------------------------------
    req("POST", "/api/autoscan/run")
    wait_idle()
    _, stats, _ = req("GET", "/api/stats")
    check("auto-scan does not resurrect", stats["photos"] == 2, stats["photos"])

    # ---- relock kills everything ------------------------------------------------
    req("POST", "/api/locked/lock", {})
    check("items 401 after lock", req("GET", "/api/locked/items", headers=H)[0] == 401)
    check("stream token dead after lock", req("GET", f"/api/locked/media/{vid}?st={st['token']}")[0] == 401)

    # ---- restore ----------------------------------------------------------------
    _, r, _ = req("POST", "/api/locked/unlock", {"pin": "orange-battery-7"})
    tok = r["token"]
    H = {"X-Vault-Session": tok}
    s, r, _ = req("POST", "/api/locked/restore", {"vault_ids": [vid]}, headers=H)
    check("restore ok", s == 200 and r["restored"] == 1, r)
    check("file back on disk, byte-identical", os.path.exists(orig_path) and sha(open(orig_path, "rb").read()) == sha(orig_bytes))
    check("mtime preserved", os.stat(orig_path).st_mtime_ns == orig_mtime)
    check("vault empty", req("GET", "/api/locked/items", headers=H)[1] == [])
    check("blob removed", os.listdir(os.path.join(DATA, "locked", "blobs")) == [])
    wait_idle()
    time.sleep(1)
    wait_idle()
    _, stats, _ = req("GET", "/api/stats")
    check("rescan re-indexed", stats["photos"] == 3, stats["photos"])

    # ---- restore collision ------------------------------------------------------
    _, items0, _ = req("GET", f"/api/timeline/items?day={buckets[0]['day']}")
    by_name = {}
    for it in items0:
        _, fi, _ = req("GET", f"/api/files/{it['id']}")
        by_name[fi["filename"]] = it["id"]
    target = by_name["photo0.jpg"]
    req("POST", "/api/locked/move-in", {"file_ids": [target]}, headers=H)
    _, litems, _ = req("GET", "/api/locked/items", headers=H)
    vid = litems[0]["vault_id"]
    with open(orig_path, "wb") as f:  # decoy at the original path
        f.write(b"decoy")
    s, r, _ = req("POST", "/api/locked/restore", {"vault_ids": [vid]}, headers=H)
    restored_name = os.path.join(PHOTOS, "photo0 (restored).jpg")
    check("collision restores under new name", r["restored"] == 1 and os.path.exists(restored_name)
          and sha(open(restored_name, "rb").read()) == sha(orig_bytes) and open(orig_path, "rb").read() == b"decoy")
    os.remove(orig_path)  # drop decoy; keep the restored copy
    wait_idle()
    time.sleep(1)
    wait_idle()

    # ---- permanent delete -------------------------------------------------------
    _, items0, _ = req("GET", f"/api/timeline/items?day={buckets[0]['day']}")
    some_id = items0[0]["id"]
    req("POST", "/api/locked/move-in", {"file_ids": [some_id]}, headers=H)
    _, litems, _ = req("GET", "/api/locked/items", headers=H)
    vid = litems[0]["vault_id"]
    s, r, _ = req("POST", "/api/locked/delete", {"vault_ids": [vid]}, headers=H)
    check("permanent delete", s == 200 and r["deleted"] == 1
          and os.listdir(os.path.join(DATA, "locked", "blobs")) == []
          and req("GET", "/api/locked/items", headers=H)[1] == [])

    # ---- crash-recovery sweep (in-process manipulation) -------------------------
    from app.services import vault  # noqa: E402

    _, items0, _ = req("GET", f"/api/timeline/items?day={buckets[0]['day']}")
    some_id = items0[0]["id"]
    _, fi, _ = req("GET", f"/api/files/{some_id}")
    victim_path = None
    for name in os.listdir(PHOTOS):
        if name == fi["filename"]:
            victim_path = os.path.join(PHOTOS, name)
    victim_bytes = open(victim_path, "rb").read()
    req("POST", "/api/locked/move-in", {"file_ids": [some_id]}, headers=H)

    key = vault.touch(tok)
    items = vault.load_manifest(key)
    item = items[-1]
    # simulate a crash between encryption and deletion: original back on disk,
    # manifest still says moving_in, and the scanner has re-indexed the file
    with open(victim_path, "wb") as f:
        f.write(victim_bytes)
    item["state"] = "moving_in"
    vault.save_manifest(key, items)
    req("POST", "/api/autoscan/run")
    wait_idle()
    _, stats_mid, _ = req("GET", "/api/stats")
    vault.sweep(key)
    check("sweep removes leftover original", not os.path.exists(victim_path))
    _, stats, _ = req("GET", "/api/stats")
    check("sweep deletes resurrected row", stats["photos"] == stats_mid["photos"] - 1,
          f"({stats_mid['photos']} -> {stats['photos']})")
    items = vault.load_manifest(key)
    check("sweep marks item locked", items[-1]["state"] == "locked")

    # restoring-state sweep: pretend the decrypt finished but cleanup didn't
    item = items[-1]
    dest = os.path.join(PHOTOS, item["filename"] + ".sweeptest.jpg")
    with open(dest, "wb") as f:
        f.write(victim_bytes)
    item["state"] = "restoring"
    item["restore_rel"] = os.path.relpath(dest, "/").replace(os.sep, "/")
    # restore_rel is relative to the volume mount — compute properly:
    mount = vault._mount_for_disk_uuid(item["disk_uuid"])
    item["restore_rel"] = os.path.relpath(dest, mount).replace(os.sep, "/")
    vault.save_manifest(key, items)
    vault.sweep(key)
    items_after = vault.load_manifest(key)
    check("restoring sweep finishes cleanup", all(it["vault_id"] != item["vault_id"] for it in items_after)
          and os.path.exists(dest))
    os.remove(dest)

    # ---- webauthn HTTP roundtrip (simulated PRF) --------------------------------
    import base64  # noqa: E402
    import secrets as pysecrets  # noqa: E402

    prf = base64.b64encode(pysecrets.token_bytes(32)).decode()
    salt = base64.b64encode(pysecrets.token_bytes(32)).decode()
    s, _, _ = req("POST", "/api/locked/webauthn/enroll",
                  {"credential_id": "testcred", "prf_salt": salt, "prf_output": prf}, headers=H)
    check("webauthn enroll", s == 200)
    req("POST", "/api/locked/lock", {})
    s, creds, _ = req("GET", "/api/locked/webauthn/request")
    check("webauthn request lists cred", s == 200 and creds["credentials"][0]["id"] == "testcred")
    s, r, _ = req("POST", "/api/locked/webauthn/unlock", {"credential_id": "testcred", "prf_output": prf})
    check("webauthn unlock", s == 200 and "token" in r)
    req("POST", "/api/locked/lock", {})

    server.should_exit = True
    t.join(timeout=5)
    shutil.rmtree(WORK, ignore_errors=True)
    print()
    print("ALL PASS" if not FAILS else f"{len(FAILS)} FAILURES: {FAILS}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
