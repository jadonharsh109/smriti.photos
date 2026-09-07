#!/usr/bin/env python3
"""Build the demo library the screenshots are taken of.

Public photographs from picsum.photos (which serves Unsplash-licensed images),
each stamped with a plausible date, camera and GPS position, so the timeline,
Places, the globe and Events have something true to group. Seven trips across
the world plus scattered days at home — about 180 photos.

Nobody's personal photos, which is the whole point: a screenshot of a real
library is a screenshot of real faces.

    pip install piexif            # the one thing this needs beyond the app
    python scripts/make_demo_library.py [out-dir]

Then add the folder to Smriti as you would any other, wait for the pipeline,
and point the browser at it.
"""
import io
import json
import os
import random
import sys
import time
import urllib.request
from datetime import datetime, timedelta

import piexif
from PIL import Image

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "demo-library")
random.seed(7)

# trips: (folder, lat, lon, first day, days, photos). The coordinates are the
# ones the bundled offline geocoder names as the city itself — a few hundred
# metres off and Reykjavík becomes Kópavogur, Vancouver becomes West End.
TRIPS = [
    ("2024-04 Kyoto", 35.0116, 135.7681, "2024-04-03", 5, 26),
    ("2024-09 Lisbon", 38.7223, -9.1393, "2024-09-14", 4, 18),
    ("2025-01 Jaipur", 26.9124, 75.7873, "2025-01-18", 3, 22),
    ("2025-05 Reykjavik", 64.1355, -21.8954, "2025-05-22", 5, 20),
    ("2025-10 Cape Town", -33.9249, 18.4241, "2025-10-09", 5, 17),
    ("2026-03 Goa", 15.4909, 73.8278, "2026-03-06", 4, 16),
    ("2026-06 Vancouver", 49.2609, -123.1139, "2026-06-20", 4, 15),
]
# home: scattered single days in one city
HOME = ("Indore", 22.7196, 75.8577)
HOME_DAYS = 22
JITTER = 0.006   # spreads the pins over a city without leaving it

def load_ids():
    """The catalogue, four pages of it: enough landscape frames to draw from."""
    rows = []
    for page in range(1, 5):
        with urllib.request.urlopen(f"https://picsum.photos/v2/list?page={page}&limit=100", timeout=30) as r:
            rows += json.load(r)
    ids = [r["id"] for r in rows if r["width"] >= r["height"] * 1.2]
    random.shuffle(ids)
    return ids

def fetch(pid: str, w=1600, h=1067) -> bytes | None:
    url = f"https://picsum.photos/id/{pid}/{w}/{h}.jpg"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return r.read()
        except Exception as e:  # a 404 for a retired id, a hiccup
            if "404" in str(e):
                return None
            time.sleep(1 + attempt)
    return None

def deg(v: float):
    v = abs(v)
    d = int(v)
    m = int((v - d) * 60)
    s = round(((v - d) * 60 - m) * 60 * 100)
    return ((d, 1), (m, 1), (s, 100))

def stamp(jpeg: bytes, when: datetime, lat: float, lon: float, camera=("Apple", "iPhone 15 Pro")) -> bytes:
    exif = {
        "0th": {piexif.ImageIFD.Make: camera[0], piexif.ImageIFD.Model: camera[1],
                piexif.ImageIFD.DateTime: when.strftime("%Y:%m:%d %H:%M:%S")},
        "Exif": {piexif.ExifIFD.DateTimeOriginal: when.strftime("%Y:%m:%d %H:%M:%S"),
                 piexif.ExifIFD.DateTimeDigitized: when.strftime("%Y:%m:%d %H:%M:%S"),
                 piexif.ExifIFD.ISOSpeedRatings: random.choice([50, 80, 100, 200, 400]),
                 piexif.ExifIFD.FNumber: (random.choice([16, 18, 24, 28]), 10),
                 piexif.ExifIFD.ExposureTime: (1, random.choice([60, 120, 250, 500, 1000])),
                 piexif.ExifIFD.FocalLength: (random.choice([24, 48, 77]), 1)},
        "GPS": {piexif.GPSIFD.GPSLatitudeRef: "N" if lat >= 0 else "S",
                piexif.GPSIFD.GPSLatitude: deg(lat),
                piexif.GPSIFD.GPSLongitudeRef: "E" if lon >= 0 else "W",
                piexif.GPSIFD.GPSLongitude: deg(lon)},
    }
    img = Image.open(io.BytesIO(jpeg))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90, exif=piexif.dump(exif))
    return buf.getvalue()

def main():
    ids = load_ids()
    made = 0
    counter = 1000
    def place(folder, when, lat, lon):
        nonlocal made, counter
        while ids:
            pid = ids.pop()
            raw = fetch(pid)
            if raw:
                break
        else:
            return
        d = os.path.join(OUT, folder)
        os.makedirs(d, exist_ok=True)
        counter += 1
        name = f"IMG_{when.strftime('%Y%m%d_%H%M%S')}_{counter}.jpg"
        jl, jo = random.uniform(-JITTER, JITTER), random.uniform(-JITTER, JITTER)
        with open(os.path.join(d, name), "wb") as f:
            f.write(stamp(raw, when, lat + jl, lon + jo))
        made += 1
        if made % 10 == 0:
            print(made, "photos", flush=True)

    for folder, lat, lon, start, days, n in TRIPS:
        t0 = datetime.strptime(start, "%Y-%m-%d")
        # every day of the trip gets photos, so the event splitter sees one trip
        per_day = [n // days + (1 if i < n % days else 0) for i in range(days)]
        for day, k in enumerate(per_day):
            for _ in range(k):
                when = t0 + timedelta(days=day, hours=random.randint(7, 20), minutes=random.randrange(60))
                place(folder, when, lat, lon)
    for _ in range(HOME_DAYS):
        base = datetime(2024, 2, 1) + timedelta(days=random.randrange(0, 900))
        for _ in range(random.choice([1, 1, 2, 3])):
            when = base + timedelta(hours=random.randint(8, 21), minutes=random.randrange(60))
            place(f"{base.year}/{base.strftime('%m %B')}", when, HOME[1], HOME[2])
    print("done:", made, "photos in", OUT)

if __name__ == "__main__":
    main()
