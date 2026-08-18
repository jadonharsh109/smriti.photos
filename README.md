# Smriti · स्मृति — smriti.photos

**Smriti** (Sanskrit: *smṛti*, "that which is remembered") turns the photo folders already
sitting on your Mac or PC into a proper library — timeline, people, places, trips, duplicates —
with **everything computed on your own machine**.

No cloud. No account. Nothing uploaded, ever — and your original files are never moved or
modified. Setting up a library downloads the face-recognition models once (~280 MB); after that
Smriti works with the network unplugged.

---

## Download

| | |
|---|---|
| **macOS** · Apple Silicon, macOS 14+ | [**Smriti.dmg**](https://github.com/jadonharsh109/smriti.photos/releases/latest) — drag to Applications |
| **Windows** · 10/11, 64-bit | [**Smriti-setup.exe**](https://github.com/jadonharsh109/smriti.photos/releases/latest) — installs per-user, no admin |

Nothing else to install. Python, ffmpeg and every dependency are bundled inside the app.

> **First launch shows a security warning** — the app isn't code-signed yet (that needs a paid
> developer certificate).
>
> - **macOS**: launch, get blocked, then **System Settings → Privacy & Security → scroll down →
>   "Open Anyway"**, and launch again.
> - **Windows**: **"More info" → "Run anyway"**.
>
> Only needed once. Updates after that are handled in-app.

Point it at a folder and it does the rest. The first folder you add downloads the
face-recognition models (~280 MB, once) — the only download Smriti ever makes. Everything
after that runs on your machine.

---

## What it does

- **Timeline** — date-grouped justified grid, virtualized for six-figure libraries, with a
  time-proportional year scrubber and a lightbox with double-click zoom.
- **People** — face detection and recognition running on your CPU (SCRFD + ArcFace via
  onnxruntime), clustered into people you can name, merge and hide.
- **Places** — GPS from EXIF / QuickTime, reverse-geocoded **offline** from a bundled GeoNames
  dataset, on a tile-server-free interactive globe.
- **Events** — trips detected automatically from gaps in your timeline, titled by city and date.
- **Albums** — virtual collections over your existing folders, so your directory structure
  stays exactly as you arranged it.
- **Duplicates** — exact (BLAKE2) and near-duplicate (perceptual hash) detection with a
  suggested keeper. Cleanup moves files to the **system Trash** — always recoverable.
- **Export** — select anything and save the originals as a `.zip`.
- **Locked** — a passcode-protected section; hidden photos vanish from every other view.
- **Videos** — ffprobe metadata, poster frames, scrubbing via HTTP range requests.
- **Drive-aware** — external drives are tracked by disk identity, so unplugging and replugging
  just works. Nothing is ever marked missing while a drive is offline.

---

## Command line / headless

For a always-on machine, or to reach your library from other devices on the LAN:

```bash
# macOS
brew install jadonharsh109/tap/smriti

# any platform, Python 3.12+ — grab the .whl from the latest release
pip install ./smriti_photos-*-py3-none-any.whl
```

```bash
smriti                      # serve in the foreground — opens http://localhost:6969
smriti start                # …or run in the background (auto-scan keeps working)
smriti status               # is it running?
smriti logs -f              # follow the server log
smriti stop                 # stop the background server
smriti models               # one-time face-model download (~280 MB) — enables People
brew services start smriti  # alternative: launchd keeps it running at login
```

`ffmpeg` is optional here and enables video indexing (`brew install ffmpeg` /
`winget install ffmpeg`). The desktop app bundles its own.

> Don't run the desktop app and a headless server at the same time — both would write the same
> database.

---

## Where your data lives

| Path | What |
|---|---|
| `library.db` | SQLite index (WAL) |
| `thumbs/` | grid thumbnails (WebP, precomputed) |
| `previews/` | 1600px lightbox previews (lazy, LRU-capped ~10 GB) |
| `models/` | face-recognition ONNX models |
| `desktop.log` | server log — the first place to look if something misbehaves |

That folder is `~/.smriti` (or `~/Library/Application Support/Smriti` for a fresh macOS app
install, and `%LOCALAPPDATA%\Smriti` on Windows). Override with `SMRITI_DATA_DIR`.

Deleting it fully resets Smriti. **Your photos are untouched** — they are only ever read.

---

## Building from source

Requires [`uv`](https://docs.astral.sh/uv/), Node 20+, and `ffmpeg` on PATH.

```bash
uv sync                                  # backend deps
(cd frontend && npm install)             # frontend deps
uv run python scripts/fetch_models.py    # face models, ~280 MB

./scripts/start.sh        # build the frontend once, serve at http://localhost:6969
./scripts/dev.sh          # or: backend :6969 + Vite dev server :5173, hot reload
```

### The desktop app

A Tauri shell wrapping an **embedded, relocatable CPython** — not a frozen binary, so the
backend runs exactly as it does from source. Needs Rust 1.85+.

```bash
uv build --wheel -o dist
python desktop/scripts/build_runtime.py --triple aarch64-apple-darwin --wheel dist/*.whl
python desktop/scripts/fetch_ffmpeg.py  --triple aarch64-apple-darwin

# prove the bundled runtime works before packaging it
desktop/src-tauri/payload/runtime/bin/python3.12 desktop/scripts/verify_runtime.py

(cd desktop/src-tauri && npx @tauri-apps/cli@2 build --bundles app --target aarch64-apple-darwin)
./desktop/scripts/macos_sign.sh --adhoc   # sign + package .zip/.dmg
```

Swap `--triple x86_64-pc-windows-msvc` and `--bundles nsis` for Windows. Every build input is
pinned by sha256 in `desktop/sources.json`. Tagging `vX.Y.Z` builds and publishes both platforms
via GitHub Actions.

---

## Test library

`test-library/` holds generated sample media — gradient photos with EXIF GPS and dates,
duplicates, videos, a HEIC, and a public-domain group photo — used during development. Safe to
delete, or keep for experimenting.

---

Smriti is in early development and I'd genuinely like your bug reports. If something breaks,
`desktop.log` in the data folder above usually says exactly why — please include it.

Made with ♥ in India · <span>स्मृति</span> — every memory, lovingly kept.
