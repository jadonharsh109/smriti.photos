//! `smriti://` — thumbnails, previews, face crops and originals served by the
//! shell straight from disk, so no image ever passes through the Python server
//! and the webview is not limited to six HTTP connections while it scrolls.
//!
//! The URL a page has to use differs per platform, because of how Tauri maps
//! custom schemes onto each webview:
//!
//!   macOS / Linux / iOS   smriti://localhost/thumb/123
//!   Windows / Android     http://smriti.localhost/thumb/123
//!
//! Only the path is routed on, so both forms reach the same code.
//!
//! Spike scope (Phase 0): there is no Locked-section token yet — see the TODO
//! in `original_path` — so an original that sits in `locked_items` is never
//! served at all. Thumbnails and previews of locked files are still reachable
//! by id, exactly as the HTTP routes were before their `lt` guard; the
//! production version must gate all four routes the same way.

use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{OpenFlags, OptionalExtension};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

use crate::paths;

pub const SCHEME: &str = "smriti";

/// Largest slice handed back for an open-ended range ("bytes=0-"). Players ask
/// for the rest as they need it, and a 500 MB original must never be read into
/// memory in one go just because the first request did not name an end.
const MAX_RANGE_CHUNK: u64 = 16 * 1024 * 1024;

/// Cache files are content-addressed by id and version in their name, so the
/// browser may keep them for as long as it likes.
const CACHE_FOREVER: &str = "public, max-age=31536000, immutable";

type Body = Cow<'static, [u8]>;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The scheme handler. Runs on the webview's thread, so all the file I/O is
/// pushed onto the blocking pool and the response is delivered from there.
pub fn handle(
    ctx: UriSchemeContext<'_, Wry>,
    req: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // Resolved once: the first request pays the env lookup and stat calls,
    // every later one clones a path. The data dir cannot change while the app
    // runs — the Python server was started against it.
    let data_dir = DATA_DIR
        .get_or_init(|| paths::resolve_data_dir(ctx.app_handle()))
        .clone();
    let path = req.uri().path().to_string();
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || {
        let response = match route(&data_dir, &path, range.as_deref()) {
            Ok(r) => r,
            Err(status) => empty(status),
        };
        responder.respond(response);
    });
}

fn route(data: &Path, path: &str, range: Option<&str>) -> Result<Response<Body>, StatusCode> {
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let kind = parts.next().unwrap_or("");
    let id = parts.next().and_then(parse_id).ok_or(StatusCode::NOT_FOUND)?;
    match kind {
        "thumb" => serve_file(&shard(&data.join("thumbs"), id, ".webp"), range, true),
        "preview" => serve_file(&shard(&data.join("previews"), id, ".webp"), range, true),
        "face" => {
            // Same fallback the Python side keeps: the current crop version
            // first, then whatever an older version left behind.
            let dir = data.join("facecrops");
            let current = shard(&dir, id, ".v2.webp");
            let file = if current.is_file() { current } else { shard(&dir, id, ".webp") };
            serve_file(&file, range, true)
        }
        "media" => serve_file(&original_path(data, id)?, range, false),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

/// A plain positive integer and nothing else — no signs, no whitespace, no
/// path tricks. Anything that is not exactly an id is a 404.
fn parse_id(s: &str) -> Option<i64> {
    if s.is_empty() || s.len() > 18 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok().filter(|&n| n > 0)
}

/// `config.shard_path` on the Python side: `<base>/<id % 256 as hex>/<id><suffix>`.
fn shard(base: &Path, id: i64, suffix: &str) -> PathBuf {
    base.join(format!("{:02x}", id % 256)).join(format!("{id}{suffix}"))
}

/// Where the original of file `id` is right now, following the same rules as
/// `services/volumes.abs_path_for_file`: the volume must be online, and the
/// POSIX rel_path is joined onto its current mount path.
fn original_path(data: &Path, id: i64) -> Result<PathBuf, StatusCode> {
    let conn = open_db(&data.join("library.db")).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let row = conn
        .query_row(
            "SELECT f.rel_path, v.last_mount_path, v.is_online, \
                    EXISTS (SELECT 1 FROM locked_items li WHERE li.file_id = f.id) \
             FROM files f JOIN volumes v ON v.id = f.volume_id \
             WHERE f.id = ?1 AND f.status = 'active'",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let (rel, mount, online, locked) = row.ok_or(StatusCode::NOT_FOUND)?;

    // TODO(locked): accept the Locked-section unlock token here — the shell can
    // attach it as a header on its own requests, or the page can pass `?lt=` as
    // the HTTP routes do — and let a valid token through. Until then a locked
    // original is simply not served. 404 rather than 401 on purpose: the
    // status must not confirm that a locked file exists.
    if locked != 0 || online == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    let mut path = PathBuf::from(mount.ok_or(StatusCode::NOT_FOUND)?);
    for component in rel.split('/').filter(|c| !c.is_empty()) {
        if component == ".." {
            return Err(StatusCode::FORBIDDEN); // never stored, never honoured
        }
        path.push(component);
    }
    if !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(path)
}

/// Read-only where SQLite lets us: a WAL database opened read-only needs its
/// -shm file to exist or be creatable, which is true whenever the Python server
/// has the database open. If that fails, fall back to a normal open — this
/// module only ever runs SELECTs, so the difference is a flag, not a risk.
fn open_db(db: &Path) -> rusqlite::Result<rusqlite::Connection> {
    let ro = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match rusqlite::Connection::open_with_flags(db, ro) {
        Ok(c) => c,
        Err(_) => rusqlite::Connection::open(db)?,
    };
    conn.busy_timeout(Duration::from_millis(500))?;
    conn.execute_batch("PRAGMA query_only = 1")?;
    Ok(conn)
}

/// One file, whole or in part.
///
/// A `Range` header gets a 206 with the slice it asked for (open-ended ranges
/// are capped at `MAX_RANGE_CHUNK`); no header gets the whole file as a 200.
/// Both carry `Accept-Ranges`, so a player learns it may seek.
fn serve_file(path: &Path, range: Option<&str>, immutable: bool) -> Result<Response<Body>, StatusCode> {
    let mut file = File::open(path).map_err(|_| StatusCode::NOT_FOUND)?;
    let total = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?.len();

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime_for(path))
        .header(header::ACCEPT_RANGES, "bytes")
        // The SPA is a different origin from this scheme on every platform, so
        // fetch()/XHR need CORS to read a response; <img> and <video> do not.
        // Production should echo the loopback origin instead of "*".
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // Content-Range and Accept-Ranges are not CORS-safelisted, so a
        // cross-origin fetch() cannot read them unless they are exposed. <video>
        // does not need this; the range test in the spike script does.
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Accept-Ranges, Content-Length");
    if immutable {
        builder = builder.header(header::CACHE_CONTROL, CACHE_FOREVER);
    }

    let (start, end, partial) = match range {
        None => (0, total.saturating_sub(1), false),
        Some(spec) => match parse_range(spec, total) {
            Some((s, e)) => (s, e, true),
            None => {
                return builder
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .body(Body::from(Vec::new()))
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
            }
        },
    };

    let len = if total == 0 { 0 } else { end - start + 1 };
    let mut buf = vec![0u8; len as usize];
    if len > 0 {
        file.seek(SeekFrom::Start(start)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        file.read_exact(&mut buf).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    builder = builder.header(header::CONTENT_LENGTH, len.to_string());
    if partial {
        builder = builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }
    builder.body(Body::from(buf)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` → inclusive (start, end), or None when
/// the range cannot be satisfied. Only the first range of a list is honoured,
/// which is what every browser and player sends.
fn parse_range(spec: &str, total: u64) -> Option<(u64, u64)> {
    let spec = spec.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    if total == 0 {
        return None;
    }
    let last = total - 1;
    if a.is_empty() {
        // suffix: the final n bytes
        let n: u64 = b.trim().parse().ok().filter(|&n| n > 0)?;
        return Some((total.saturating_sub(n), last));
    }
    let start: u64 = a.trim().parse().ok()?;
    if start > last {
        return None;
    }
    let end = if b.trim().is_empty() {
        last.min(start + MAX_RANGE_CHUNK - 1)
    } else {
        let e: u64 = b.trim().parse().ok()?;
        if e < start {
            return None;
        }
        e.min(last)
    };
    Some((start, end))
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "3gp" => "video/3gpp",
        "wmv" => "video/x-ms-wmv",
        "mts" | "m2ts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(Vec::new()))
        .expect("static response")
}

// ---------------------------------------------------------------------------
// Spike measurement. Only when SMRITI_SPIKE_MEASURE=1: a script injected into
// the webview loads the same 600 thumbnails through the Python HTTP route and
// through smriti://, twice each, checks a Range request and a <video> seek on
// SMRITI_SPIKE_VIDEO_ID, and reports the numbers by fetching /api/health with
// the JSON as a query string — uvicorn writes that line to desktop.log, which
// is the one place a headless run can read them back from.
// ---------------------------------------------------------------------------

pub fn spike_measurement_script() -> Option<String> {
    if std::env::var("SMRITI_SPIKE_MEASURE").ok().as_deref() != Some("1") {
        return None;
    }
    let data = PathBuf::from(std::env::var("SMRITI_DATA_DIR").ok()?);
    let mut ids: Vec<i64> = Vec::new();
    for shard in std::fs::read_dir(data.join("thumbs")).ok()?.flatten() {
        let Ok(files) = std::fs::read_dir(shard.path()) else { continue };
        for f in files.flatten() {
            let name = f.file_name();
            let name = name.to_string_lossy();
            if let Some(stem) = name.strip_suffix(".webp") {
                if let Ok(id) = stem.parse::<i64>() {
                    ids.push(id);
                }
            }
        }
    }
    ids.sort_unstable();
    ids.truncate(600);
    let ids_json = format!(
        "[{}]",
        ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
    );
    let video = std::env::var("SMRITI_SPIKE_VIDEO_ID").unwrap_or_else(|_| "0".into());
    let video = if video.bytes().all(|b| b.is_ascii_digit()) { video } else { "0".into() };
    Some(SPIKE_JS.replace("__IDS__", &ids_json).replace("__VIDEO__", &video))
}

const SPIKE_JS: &str = r#"
(function () {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(location.origin)) return;
  var IDS = __IDS__;
  var VIDEO = __VIDEO__;
  function load(src) {
    return new Promise(function (res) {
      var i = new Image();
      i.onload = function () { res(true); };
      i.onerror = function () { res(false); };
      i.src = src;
    });
  }
  async function run(label, mk) {
    var t0 = performance.now();
    var oks = await Promise.all(IDS.map(function (id) { return load(mk(id) + '?b=' + t0); }));
    var wall = performance.now() - t0;
    var seq = [];
    for (var k = 0; k < 60 && k < IDS.length; k++) {
      var s = performance.now();
      await load(mk(IDS[k]) + '?s=' + s);
      seq.push(performance.now() - s);
    }
    seq.sort(function (a, b) { return a - b; });
    return { label: label, n: IDS.length, ok: oks.filter(Boolean).length,
             wall_ms: Math.round(wall), per_img_ms: +(wall / IDS.length).toFixed(2),
             seq_median_ms: +(seq[Math.floor(seq.length / 2)] || 0).toFixed(2) };
  }
  async function main() {
    var results = [];
    results.push(await run('http', function (id) { return '/api/thumb/' + id; }));
    results.push(await run('smriti', function (id) { return 'smriti://localhost/thumb/' + id; }));
    results.push(await run('http-2', function (id) { return '/api/thumb/' + id; }));
    results.push(await run('smriti-2', function (id) { return 'smriti://localhost/thumb/' + id; }));
    var range = null;
    try {
      var r = await fetch('smriti://localhost/media/' + VIDEO, { headers: { Range: 'bytes=100-199' } });
      range = { status: r.status, cr: r.headers.get('content-range'), cl: r.headers.get('content-length'),
                ar: r.headers.get('accept-ranges'), ct: r.headers.get('content-type'),
                len: (await r.arrayBuffer()).byteLength };
    } catch (e) { range = { error: String(e) }; }
    var thumbRange = null;
    try {
      var tr = await fetch('smriti://localhost/thumb/' + IDS[0], { headers: { Range: 'bytes=0-9' } });
      thumbRange = { status: tr.status, cr: tr.headers.get('content-range'), len: (await tr.arrayBuffer()).byteLength };
    } catch (e) { thumbRange = { error: String(e) }; }
    var vid = await new Promise(function (res) {
      var v = document.createElement('video');
      v.muted = true; v.preload = 'auto';
      var to = setTimeout(function () { res({ timeout: true, code: v.error && v.error.code, rs: v.readyState }); }, 20000);
      v.addEventListener('loadedmetadata', function () { v.currentTime = Math.min(2, v.duration / 2); });
      v.addEventListener('seeked', function () { clearTimeout(to); res({ seeked: true, t: +v.currentTime.toFixed(2), dur: +v.duration.toFixed(1) }); });
      v.addEventListener('error', function () { clearTimeout(to); res({ error: v.error && v.error.code }); });
      v.src = 'smriti://localhost/media/' + VIDEO;
      document.body.appendChild(v);
    });
    var report = { origin: location.origin, ua: navigator.userAgent.slice(-40), results: results, range: range, thumbRange: thumbRange, vid: vid };
    await fetch('/api/health?spike=' + encodeURIComponent(JSON.stringify(report)));
  }
  window.addEventListener('load', function () { setTimeout(function () { main().catch(function (e) {
    fetch('/api/health?spike=' + encodeURIComponent(JSON.stringify({ fatal: String(e) })));
  }); }, 3000); });
})();
"#;
