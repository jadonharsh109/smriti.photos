# Smriti · स्मृति — smriti.photos

**Smriti** (Sanskrit: *that which is remembered*) is a Google-Photos-style library for the
photos/videos on your Mac or external SSD — **fully local, zero external APIs at runtime**.
FastAPI backend + React frontend with a macOS-style liquid-glass UI, served at
`http://localhost:8000`. Bilingual (English/हिन्दी) landing page at `/welcome`.

- **Private by architecture**: everything is computed on your machine. The app builds a SQLite
  index + thumbnail cache in `data/`; albums, people and places are virtual views.
- **Timeline** — date-grouped justified grid with a time-proportional year scrubber, All/Photos/
  Videos filter, multi-select (per-day and select-all), and a lightbox with double-click zoom.
- **People** — on-device face detection + recognition (SCRFD + ArcFace via onnxruntime),
  clustered into people you can name, merge and hide, with a solo-photos filter per person.
- **Places** — GPS from EXIF / QuickTime metadata, reverse-geocoded **offline** (GeoNames
  dataset), plus a tile-server-free interactive globe (bundled TopoJSON).
- **Events** — trips auto-detected from gaps in your timeline, titled with city + dates.
- **Albums** — virtual albums via multi-select or one-click "add all" from any person/place/event.
- **Duplicates** — exact (BLAKE2) and near-duplicate (perceptual hash) finder with suggested
  keepers; cleanup moves files to the **recoverable macOS Trash**, never a permanent delete.
- **Videos** — ffprobe metadata, poster frames, in-browser playback via HTTP range requests.
- **Drive-aware** — volumes tracked by disk UUID; unplugging mid-scan interrupts safely and
  nothing is ever marked missing while a drive is offline.

## Requirements

- macOS with `ffmpeg` installed (`brew install ffmpeg`)
- [`uv`](https://docs.astral.sh/uv/) and Node 20+

## Setup (one-time)

```bash
uv sync                                  # backend deps
(cd frontend && npm install)             # frontend deps
uv run python scripts/fetch_models.py    # face models, ~280 MB — the only download the app needs
```

## Run

```bash
./scripts/start.sh        # builds the frontend once, serves everything at http://localhost:8000
# or, for development with hot reload:
./scripts/dev.sh          # backend :8000 + Vite dev server :5173
```

Then open the app → **Library setup** → **+ Add folder** → pick your photos folder → **Scan**.
After the scan finishes, run the processing steps on the same page (Locate photos, Rebuild events,
Find near-duplicates, Scan faces → Group into people).

## Where things live

| Path | What |
|---|---|
| `data/library.db` | SQLite index (WAL) |
| `data/thumbs/` | grid thumbnails (WebP, precomputed) |
| `data/previews/` | 1600px lightbox previews (lazy, LRU-capped ~10 GB) |
| `data/models/` | face-recognition ONNX models |
| `data/exports/` | duplicate discard lists |

Delete the `data/` folder to fully reset the app; your photos are untouched. Set `PHOTOS_DATA_DIR`
to relocate it.

## Test library

`test-library/` contains generated sample media (gradient photos with EXIF GPS/dates, duplicates,
videos, a HEIC, and a public-domain group photo) used during development — safe to delete, or keep
for experimenting.

---

Made with ♥ in India · <span>स्मृति</span> — every memory, lovingly kept.
