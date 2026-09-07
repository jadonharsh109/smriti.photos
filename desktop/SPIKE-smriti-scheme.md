# Spike: serving images from the shell over `smriti://`

> **Productionised in Phase 2.** `assets.rs` is now the real thing: every
> route refuses anything belonging to a file with `files.locked = 1` (404, no
> distinction), a cache miss for a thumbnail, preview or face crop is proxied
> to the Python route that generates it and served from disk from then on,
> reads run on a dedicated four-thread pool instead of Tauri's blocking pool,
> CORS echoes only a loopback origin, and the `library.db` connection is
> opened once and reused. The measurement hook (`SMRITI_SPIKE_MEASURE`) is
> gone; debug builds accept `SMRITI_DEBUG_SCRIPT=<file.js>` to run a script in
> the page instead. The shell announces the per-platform base as
> `data-smriti-images` on `<html>`, and `frontend/src/lib/images.ts`
> (`thumbUrl`, `previewUrl`, `faceUrl`, `mediaUrl`) builds every image URL
> from it, falling back to `/api/...` in a browser and whenever a query
> string — the Locked section's `?lt=` token — is present. The rest of this
> note is the spike as it was measured.

Phase 0 of the desktop rebuild. Question asked: can the Tauri shell serve
thumbnails, previews, face crops and originals straight from disk over a custom
URL scheme, so that no image passes through the Python server and scrolling is
not limited to the six HTTP connections the webview allows per host? And the
key unknown underneath it: can the SPA, which the Python server serves from
`http://127.0.0.1:<port>`, load images from that scheme at all?

Measured 2026-09-07 on an Apple M4 (macOS, WKWebKit 605.1.15), `tauri dev`
debug build, against the real dev library's caches (600 thumbnails, mean 21 KB).

## What was built

`desktop/src-tauri/src/assets.rs`, registered from `main.rs` with
`register_asynchronous_uri_scheme_protocol("smriti", …)`.

| Route | Serves | Source |
|---|---|---|
| `/thumb/{id}` | grid thumbnail | `<data>/thumbs/<id % 256 hex>/<id>.webp` |
| `/preview/{id}` | 1600 px preview | `<data>/previews/…/<id>.webp` |
| `/face/{face_id}` | face crop | `<data>/facecrops/…/<face_id>.v2.webp`, falling back to `<face_id>.webp` |
| `/media/{id}` | the original | `library.db` read through `rusqlite`: `files` ⋈ `volumes`, the same rules as `services/volumes.abs_path_for_file` (volume online, POSIX `rel_path` joined onto the mount path) |

- Ids must be plain positive integers; anything else is a 404. A `..` path
  component in `rel_path` (never stored, but cheap to refuse) is a 403.
- Every route honours `Range`: `bytes=a-b`, `bytes=a-`, `bytes=-n`. A ranged
  request gets 206 with `Content-Range`, `Content-Length` and
  `Accept-Ranges: bytes`; an unsatisfiable one gets 416; no header gets the
  whole file as 200. Open-ended ranges are capped at 16 MB so a 500 MB original
  is never read into memory for one request.
- MIME by extension (jpeg, png, webp, heic, heif, tiff, avif, mp4, mov, webm,
  mkv, avi, 3gp, wmv, mts, …).
- Cache files (thumb, preview, face) carry
  `Cache-Control: public, max-age=31536000, immutable`; originals do not.
- File I/O runs on the async runtime's blocking pool; the webview thread only
  parses the request.
- `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers` are set
  so a cross-origin `fetch()` from the SPA can read a response. `<img>` and
  `<video>` never needed them. Production should echo the loopback origin
  rather than `*`.
- **Locked section: not enforced yet.** An original whose file is in
  `locked_items` is refused with 404 (never 401, so the status does not confirm
  the file exists). Thumbnails, previews and face crops of locked files are
  still served by id, which is the state the HTTP routes were in before their
  `lt` guard. The production handler must accept the unlock token on all four
  routes; the place is marked `TODO(locked)` in `original_path`.
- `tauri.conf.json` CSP now allows `smriti:` and `http://smriti.localhost` in
  `img-src`, `media-src` and `connect-src`. This CSP only governs the splash
  page (the app origin); the SPA served by Python has no CSP header.
- `paths::resolve_data_dir` became `pub(crate)`; the handler resolves it once
  and caches it.

The measurement harness is in the same file, gated behind
`SMRITI_SPIKE_MEASURE=1`: an initialization script injected into the webview
loads the same 600 thumbnails through `/api/thumb/{id}` and through
`smriti://localhost/thumb/{id}`, twice each, then runs the Range and `<video>`
checks on `SMRITI_SPIKE_VIDEO_ID`, and reports by fetching
`/api/health?spike=<json>`, which uvicorn writes to `<data>/desktop.log`.

## URL forms per platform

Tauri maps custom schemes differently per webview:

| Platform | URL the page uses |
|---|---|
| macOS, Linux, iOS | `smriti://localhost/thumb/123` |
| Windows, Android | `http://smriti.localhost/thumb/123` |

The handler routes on the path only, so both reach the same code. The frontend
needs one helper that picks the prefix from the platform (Tauri's
`convertFileSrc` does exactly this for the asset protocol and is the model).

## Can an `http://127.0.0.1:<port>` page load `smriti://` images on macOS?

**Yes.** With the SPA loaded from `http://127.0.0.1:57363` (the Python origin),
all 600 of 600 `<img>` loads through `smriti://localhost/thumb/{id}` succeeded,
`fetch()` with a `Range` header returned a readable 206, and a `<video>` element
sourced from `smriti://localhost/media/5935` loaded metadata and seeked to
2.0 s of a 39.9 s file. WKWebView hands every request for the scheme to the
handler regardless of the page's origin.

## Numbers

Two runs; each loads 600 thumbnails with all requests in flight at once
(`Promise.all`), then 60 more one after another for a per-image median. Every
URL carries a fresh query string, so nothing is served from the browser cache.

| Run | Path | 600 in parallel, wall | Per image (wall/600) | Sequential median |
|---|---|---|---|---|
| 1 | HTTP `/api/thumb` | 328 ms | 0.55 ms | 3 ms |
| 1 | `smriti://` first use | 2,177 ms | 3.63 ms | 0 ms |
| 1 | HTTP again | 438 ms | 0.73 ms | 3 ms |
| 1 | `smriti://` again | 207 ms | 0.34 ms | 1 ms |
| 2 | HTTP `/api/thumb` | 302 ms | 0.50 ms | 1 ms |
| 2 | `smriti://` first use | 725 ms | 1.21 ms | 1 ms |
| 2 | HTTP again | 1,589 ms | 2.65 ms | 2 ms |
| 2 | `smriti://` again | 158 ms | 0.26 ms | 1 ms |

Range and seek checks (run 2):

| Check | Result |
|---|---|
| `fetch('smriti://localhost/media/5935', Range: bytes=100-199)` | 206, `Content-Range: bytes 100-199/8017501`, `Content-Length: 100`, `Accept-Ranges: bytes`, `video/mp4`, 100 bytes received |
| `fetch('smriti://localhost/thumb/<id>', Range: bytes=0-9)` | 206, `Content-Range: bytes 0-9/642`, 10 bytes |
| `<video src="smriti://localhost/media/5935">` seek to 2 s | `seeked` fired at 2.00 s, duration 39.9 s |

Reading the numbers:

- Warm, `smriti://` serves 600 thumbnails in 158–207 ms (0.26–0.34 ms each)
  against 302–438 ms over HTTP on a quiet server, and 1,589 ms on the run where
  the Python server was also busy. The HTTP path is not slow in isolation; it
  is shared with everything else Python does, and capped at six in flight.
- The first use of the scheme is expensive: 2.2 s in run 1, 0.7 s in run 2
  after the data-dir lookup was cached. What remains is the blocking pool
  spawning threads for 600 simultaneous tasks. Production should either
  pre-warm the pool or use a small dedicated thread pool (four to eight
  threads is plenty for disk reads).
- The HTTP numbers here are better than the parent's ApacheBench figure
  (2 ms per thumbnail) because WKWebView keeps six keep-alive connections busy
  and uvicorn is otherwise idle. Under an indexing job that advantage goes away,
  which run 2 happened to show.
- These are `tauri dev` debug builds. A release build will be faster on the
  Rust side; the HTTP side is unaffected.

## Not verified

- **Windows / WebView2.** The `http://smriti.localhost` form is Tauri's
  documented mapping, and `register_asynchronous_uri_scheme_protocol` is the
  same API on every platform, but whether a page on `http://127.0.0.1` may load
  `http://smriti.localhost` images there was not run. It is plain HTTP-to-HTTP
  from the browser's point of view, so no mixed-content rule applies, and the
  same CORS headers cover `fetch()`. Needs one run on a Windows machine before
  Phase 2 starts.
- Release-build timings, and behaviour with the Locked token once it exists.
- Memory under a burst of large `/media` requests: each 16 MB chunk is read
  into a `Vec` before responding, because the responder takes an owned body.
  Fine for a video player's chunked reads; a hundred parallel full-size
  downloads would need a semaphore.
- The dev library's own database marks the internal disk offline (its volume
  row carries a stale UUID from before an OS reinstall; a second row with the
  current UUID has no files). The spike ran against a scratch copy of the
  database with that row corrected. Nothing in the real data directory was
  modified. This is a real bug in `services/volumes.refresh_volumes` worth its
  own fix: a volume whose UUID changes should be re-identified by mount path,
  not orphaned.

## Recommendation: (a) keep the SPA on the Python origin, add `smriti://` for images

Serving the SPA from the app's own origin (option b) would mean CORS on every
JSON call, a different origin for the desktop and headless builds to reason
about, a second delivery path for the same bundle, and no gain that the
measurements point at: JSON requests cost under a millisecond each.

Option (a) changes one thing: the image URL prefix. The frontend gets a
`imageUrl(kind, id)` helper that returns `smriti://localhost/...` (or the
`smriti.localhost` form on Windows) inside the desktop app and `/api/...`
everywhere else; the Python routes stay for headless and LAN use. Everything
else about the shell, the capabilities and the update flow stays as it is.

Before Phase 2 builds on this: run the same script on Windows, add the Locked
token to all four routes, replace the per-request thread spawn with a small
pool, and echo the loopback origin instead of `*`.
