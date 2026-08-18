"""Cross-platform smoke test (CI runs this on macOS and Windows).

Boots the installed `smriti` server against a temp data dir, registers a temp
folder containing a generated photo, scans it, and asserts the file was
indexed with a thumbnail. Exercises volume identity, path handling, the scan
worker pool and the bundled web UI on the host platform.

Then imports a synthetic Google Takeout export, which is where the subtle rules
live: a photo's metadata routinely arrives in a different zip part than the
photo, an album member is stored a second time byte-for-byte, and the sidecar
can be filed against either copy. All three are easy to break and none of them
fail loudly, so they are asserted here rather than discovered by a user."""
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


def make_takeout(tmp: str) -> list:
    """Two zip parts shaped like a real export, minus the six gigabytes.

    part 1: the photos.  part 2: the metadata — deliberately split, because
    that is what Takeout actually does.
    """
    import io
    import zipfile

    from PIL import Image

    def jpeg(color) -> bytes:
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), color).save(buf, "JPEG", quality=80)
        return buf.getvalue()   # no EXIF at all — the case only a sidecar fixes

    GP = "Takeout/Google Photos"
    lonely = jpeg((200, 90, 60))
    shared = jpeg((60, 120, 200))

    def sidecar(title, ts, lat=None, lon=None) -> bytes:
        doc = {"title": title, "photoTakenTime": {"timestamp": str(ts)}}
        if lat is not None:
            doc["geoData"] = {"latitude": lat, "longitude": lon, "altitude": 0.0}
        return json.dumps(doc).encode()

    part1 = os.path.join(tmp, "takeout-test-1-001.zip")
    with zipfile.ZipFile(part1, "w") as z:
        z.writestr(f"{GP}/Photos from 2021/lonely.jpg", lonely)
        # the same bytes in two places, exactly as an album member is stored
        z.writestr(f"{GP}/Photos from 2021/shared.jpg", shared)
        z.writestr(f"{GP}/Goa Trip/shared.jpg", shared)
        # metadata filed against the ALBUM copy, while the year copy has none:
        # pairing has to notice they are the same photo
        z.writestr(f"{GP}/Goa Trip/shared.jpg.supplemental-metadata.json",
                   sidecar("shared.jpg", 1600000000, 15.2993, 74.1240))

    part2 = os.path.join(tmp, "takeout-test-1-002.zip")
    with zipfile.ZipFile(part2, "w") as z:
        # this photo's metadata is in a different part than the photo
        z.writestr(f"{GP}/Photos from 2021/lonely.jpg.supplemental-metadata.json",
                   sidecar("lonely.jpg", 1300000000))
    return [part1, part2]


def check_takeout(tmp: str) -> None:
    dest = os.path.join(tmp, "imported")
    os.makedirs(dest, exist_ok=True)
    archives = make_takeout(tmp)

    summary = post("/api/takeout/analyze", {"archives": archives})
    assert summary["total"] == 3, f"expected 3 media entries, got {summary}"
    assert summary["duplicate_paths"] == 1, f"album duplicate not detected: {summary}"
    assert [a["name"] for a in summary["albums"]] == ["Goa Trip"], summary["albums"]
    print(f"takeout analyze: {summary['photos']} photos, albums {summary['albums']}")

    # Wait on THIS job, not "some takeout job that is done" — a finished job
    # from an earlier import satisfies that instantly and the assertions then
    # run against half-extracted files.
    job_id = post("/api/takeout/import", {"archives": archives, "destination": dest})["job_id"]
    wait_for(lambda: get(f"/api/jobs/{job_id}")["status"] != "running", 180,
             "takeout import to finish")
    job = get(f"/api/jobs/{job_id}")
    assert job["status"] == "done", f"import did not finish cleanly: {job}"
    assert job["errors"] == 0, f"import reported errors: {job}"
    print(f"takeout import: {job['message']}")

    root = os.path.join(dest, "Google Photos")
    year = os.path.join(root, "Photos from 2021")
    album = os.path.join(root, "Goa Trip")
    for path in (os.path.join(year, "lonely.jpg"), os.path.join(year, "shared.jpg"),
                 os.path.join(album, "shared.jpg")):
        assert os.path.isfile(path), f"missing after import: {path}"
    with open(os.path.join(year, "shared.jpg"), "rb") as a, open(os.path.join(album, "shared.jpg"), "rb") as b:
        assert a.read() == b.read(), "the album copy is not the same photo"

    # the whole point: a photo that arrived with no EXIF now has its date, and
    # the one whose metadata was filed under the album has its date AND place
    from PIL import Image

    def taken(path):
        ex = Image.open(path).getexif()
        return ex.get_ifd(0x8769).get(0x9003), ex.get_ifd(0x8825)

    lonely_date, _ = taken(os.path.join(year, "lonely.jpg"))
    shared_date, shared_gps = taken(os.path.join(year, "shared.jpg"))
    assert lonely_date and lonely_date.startswith("2011:"), f"cross-part metadata lost: {lonely_date}"
    assert shared_date and shared_date.startswith("2020:"), f"cross-folder metadata lost: {shared_date}"
    assert shared_gps, "GPS from the album's sidecar never reached the year copy"
    print(f"repair: lonely={lonely_date} shared={shared_date} gps={bool(shared_gps)}")

    # Healing is the whole job: nothing may have been indexed or watched, and
    # no album may exist yet. Whether these photos join the library is a
    # separate decision, taken later through the ordinary "add a folder" path.
    assert not any(a["name"] == "Goa Trip" for a in get("/api/albums")), \
        "the import created an album without being asked to"
    assert not any(r["abs_path"].startswith(dest) for r in get("/api/roots")), \
        "the import added a library folder without being asked to"
    print("import left the library untouched — PASS")

    # ...and if the folder is added later, like any other folder, the albums
    # the import recorded come across with it.
    added = post("/api/roots", {"path": root})
    post("/api/process", {"root_id": added["id"]})
    wait_for(lambda: any(a["name"] == "Goa Trip" for a in get("/api/albums")), 240,
             "the Takeout album to become a Smriti album")
    goa = next(a for a in get("/api/albums") if a["name"] == "Goa Trip")
    assert goa["count"] == 1, f"album has the wrong contents: {goa}"
    print(f"after adding the folder by hand: album 'Goa Trip' -> {goa['count']} item — PASS")


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

        check_takeout(tmp)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
