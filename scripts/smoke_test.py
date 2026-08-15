"""Cross-platform smoke test (CI runs this on macOS and Windows).

Boots the installed `smriti` server against a temp data dir, registers a temp
folder containing a generated photo, scans it, and asserts the file was
indexed with a thumbnail. Exercises volume identity, path handling, the scan
worker pool and the bundled web UI on the host platform."""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.load(r)


def post(path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def wait_for(pred, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if pred():
                return
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit(f"TIMEOUT waiting for {what}")


def main() -> None:
    tmp = tempfile.mkdtemp(prefix="smriti-smoke-")
    data_dir = os.path.join(tmp, "data")
    photos = os.path.join(tmp, "photos")
    os.makedirs(photos)

    from PIL import Image

    Image.new("RGB", (640, 480), (216, 118, 60)).save(os.path.join(photos, "sunset.jpg"), quality=90)

    env = {**os.environ, "SMRITI_DATA_DIR": data_dir}
    code = f"import sys; sys.argv=['smriti','--no-browser','--port','{PORT}']; from smriti_server.cli import main; main()"
    proc = subprocess.Popen([sys.executable, "-c", code], env=env)
    try:
        wait_for(lambda: get("/api/health")["ok"], 60, "server startup")
        print("server up")

        with urllib.request.urlopen(BASE + "/", timeout=10) as r:
            assert r.status == 200, "web UI not served"
        print("web UI served")

        vols = get("/api/volumes")
        assert vols and all(v["disk_uuid"] for v in vols), f"bad volumes: {vols}"
        print(f"volumes: {[(v['label'], v['mount_path']) for v in vols]}")

        listing = get("/api/fs/list")
        assert "dirs" in listing, f"bad fs listing: {listing}"
        print(f"fs browse root: {listing['path']}")

        root = post("/api/roots", {"path": photos})
        post("/api/scan", {"root_id": root["id"]})
        wait_for(
            lambda: any(j["kind"] == "scan" and j["status"] == "done" for j in get("/api/jobs?limit=5")),
            120,
            "scan to finish",
        )
        jobs = get("/api/jobs?limit=5")
        scan = next(j for j in jobs if j["kind"] == "scan")
        assert scan["errors"] == 0, f"scan had errors: {scan}"

        stats = get("/api/stats")
        assert stats["photos"] == 1, f"expected 1 photo, got {stats['photos']}"
        with urllib.request.urlopen(BASE + "/api/thumb/1", timeout=10) as r:
            assert r.status == 200 and len(r.read()) > 100, "thumbnail missing"
        print("indexed 1 photo with thumbnail — PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
