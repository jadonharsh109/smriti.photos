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
- **Google Takeout repair** — point it at the `.zip` parts of a Google Photos
  export and it hands back a folder of repaired photos, with the dates and GPS
  that Google moved out into sidecar files put back where they belong. Nothing
  is re-encoded, and nothing joins your library unless you say so. See below.
- **Export** — select anything and save the originals as a `.zip`.
- **Locked** — a passcode-protected section; hidden photos vanish from every other view.
- **Videos** — ffprobe metadata, poster frames, scrubbing via HTTP range requests.
- **Drive-aware** — external drives are tracked by disk identity, so unplugging and replugging
  just works. Nothing is ever marked missing while a drive is offline.

---

## Coming from Google Photos

**Your library → Import Takeout…** takes the `.zip` parts Google gives you and
turns them into a folder of repaired photos.

It stops there, on purpose. Repairing an export and deciding to live with those
photos are two different decisions, so the repair makes only the first one: you
get an ordinary folder you can open in Finder, copy to a drive, or ignore. If
you do want those photos in your library, add the folder the way you would add
any other — and the albums the repair recorded come across with it.

Select every part you downloaded at once — this is not optional politeness.
Google splits an export across numbered zips and routinely files a photo's
metadata in a *different part* from the photo itself, so the parts are paired
against each other before anything is unpacked. Smriti tells you up front what
it found, and says so plainly when the set looks incomplete.

What the import fixes:

- **Dates.** Most photos keep their EXIF, but the ones that do not — Snapchat
  and WhatsApp images, anything renamed — carry no date a filename can rescue.
  Those get their capture time from Google's sidecar, written into the file
  itself, so other apps see it too. A photo that already has its own date is
  never overwritten.
- **Places.** GPS from the sidecar, for the photos that lost it.
- **Albums.** Kept as folders, and turned into Smriti albums if you ever add the
  folder to your library.
- **Duplicates.** Takeout stores an album's photos twice, byte for byte. Both
  paths are recreated, but the second is a hardlink — the mirror is exact and
  the bytes exist once.

Nothing is re-encoded: the capture date is spliced into the JPEG's metadata
segment, leaving every byte of image data untouched. Your `.zip` files are only
ever read, and nothing is indexed, scanned or watched until you ask for it. An
interrupted repair picks up where it left off, and repairing the remaining parts
later fills in the metadata that was missing the first time.

> The import copies photos out of the archives, so it needs roughly as much free
> space as the export itself. Smriti checks before it starts.

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

## Licence

[GNU AGPL v3](LICENSE). Use it, run it, change it, share it — and if you
distribute a modified version, or run one as a service other people can reach,
those people get the source to your version too.

That is the whole intent: Smriti should stay something anyone can use for free,
and stay impossible to fork into a closed product or a paid hosted service that
gives nothing back. Selling it is not forbidden — no free-software licence
forbids that — but whoever sells it still has to hand over the source under the
same terms, which removes most of the reason to try.

Two things this does not cover:

- The bundled **FFmpeg** binary is GPL v3 and is redistributed unmodified.
  Smriti runs it as a separate process and never links against it. See
  [desktop/THIRD_PARTY_LICENSES.md](desktop/THIRD_PARTY_LICENSES.md).
- The **InsightFace models** that power People are not bundled — they are
  downloaded on request, and their authors licence them for **non-commercial
  research use**. That restriction is theirs and it follows the models, not this
  repository.

---

Smriti is in early development and I'd genuinely like your bug reports. If something breaks,
`desktop.log` in the data folder above usually says exactly why — please include it.

Made with ♥ in India · <span>स्मृति</span> — every memory, lovingly kept.
