//! `smriti://` — thumbnails, previews, face crops and originals, served by the
//! shell straight from disk.
//!
//! Why: the webview allows six connections to one host, and every image used
//! to be one HTTP request through the Python server at about two milliseconds
//! each. Measured in the Phase 0 spike: 600 warm thumbnails in 158–207 ms this
//! way, against 302–1,589 ms over HTTP while Python was busy indexing.
//!
//! The URL a page uses differs per platform, because of how Tauri maps custom
//! schemes onto each webview:
//!
//!   macOS / Linux / iOS   smriti://localhost/thumb/123
//!   Windows / Android     http://smriti.localhost/thumb/123
//!
//! `image_base()` is the form for this build. main.rs hands it to the page as
//! `data-smriti-images` on `<html>`, and `frontend/src/lib/images.ts` builds
//! every image URL from it.
//!
//! Locked section: the shell never serves anything that belongs to a file with
//! `files.locked = 1` — not its thumbnail, its preview, its face crops or its
//! original — and answers 404, never 401, so the status does not confirm the
//! file exists. Whatever the page shows *inside* the Locked section goes
//! through the Python routes with the unlock token instead: images.ts falls
//! back to `/api/...` whenever a query string is present.
//!
//! Misses are proxied. A preview is generated lazily by Python from the
//! original, and a face crop may predate the scan writing them, so a request
//! for a cache file that is not on disk yet is forwarded to the matching
//! `/api/` route and its answer returned. The second request finds the file.

use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use rusqlite::{OpenFlags, OptionalExtension};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

use crate::paths;

pub const SCHEME: &str = "smriti";

/// The origin the page should build image URLs on, for this platform.
pub fn image_base() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://smriti.localhost"
    } else {
        "smriti://localhost"
    }
}

/// Largest slice handed back for an open-ended range ("bytes=0-"). Players ask
/// for the rest as they need it, and a 500 MB original must never be read into
/// memory in one go just because the first request did not name an end.
const MAX_RANGE_CHUNK: u64 = 16 * 1024 * 1024;

/// Most a proxied answer may be. Cache files are a few hundred KB at most; a
/// preview is 1600 px WebP. Anything larger is not something Python's cache
/// routes produce.
const MAX_PROXY_BODY: u64 = 64 * 1024 * 1024;

/// Cache files are content-addressed by id and version in their name, so the
/// browser may keep them for as long as it likes.
const CACHE_FOREVER: &str = "public, max-age=31536000, immutable";
/// Originals can be edited or trashed under us; a short private cache is
/// enough to make prev/next in the viewer instant.
const CACHE_PRIVATE: &str = "private, max-age=3600";

/// File reads for images. Four threads: enough to keep a disk busy, few enough
/// that a scroll firing 600 requests at once queues them instead of spawning
/// 600 threads — which is what the spike measured as a two-second cold start
/// on Tauri's shared blocking pool.
const WORKERS: usize = 4;

type Body = Cow<'static, [u8]>;
type Job = Box<dyn FnOnce() + Send + 'static>;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static SERVER_URL: OnceLock<String> = OnceLock::new();
static POOL: OnceLock<Pool> = OnceLock::new();
static DB: Mutex<Option<rusqlite::Connection>> = Mutex::new(None);

/// Where the Python server answers, once it does. Set by main.rs the moment
/// the health check passes; until then a cache miss is a 503 rather than a
/// proxy attempt at nothing.
pub fn set_server_url(url: &str) {
    let _ = SERVER_URL.set(url.trim_end_matches('/').to_owned());
}

struct Pool {
    tx: Mutex<mpsc::Sender<Job>>,
}

impl Pool {
    fn new(n: usize) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..n {
            let rx = Arc::clone(&rx);
            thread::Builder::new()
                .name(format!("smriti-images-{i}"))
                .spawn(move || loop {
                    // The guard is a temporary of the `let`, released before
                    // the job runs, so one worker waiting on the channel does
                    // not hold the others off their own work.
                    let job = match rx.lock().unwrap_or_else(|p| p.into_inner()).recv() {
                        Ok(job) => job,
                        Err(_) => return,
                    };
                    job();
                })
                .expect("spawn image worker");
        }
        Pool { tx: Mutex::new(tx) }
    }

    fn run(&self, job: Job) {
        let _ = self.tx.lock().unwrap_or_else(|p| p.into_inner()).send(job);
    }
}

/// The scheme handler. Runs on the webview's thread, so it only parses the
/// request; the file I/O happens on the pool and the response is delivered
/// from there.
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
    let hdr = |name: header::HeaderName| {
        req.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let range = hdr(header::RANGE);
    let origin = hdr(header::ORIGIN);
    let app = ctx.app_handle().clone();
    POOL.get_or_init(|| Pool::new(WORKERS)).run(Box::new(move || {
        let response = with_cors(route(&data_dir, &path, range.as_deref()).unwrap_or_else(empty), origin.as_deref());
        // The read happened here, on the pool; the answer is handed back on the
        // main thread. WebKit stops a scheme task on the main thread — a
        // seeking <video> stops dozens a second — and answering a stopped task
        // raises an Objective-C exception. Answered from this thread, that
        // exception arrives between wry's "is the task still alive" check and
        // its call, and in a panic=abort build it cannot be caught: the app
        // died with "abort() called" on smriti-images-N while a video played.
        // On the main thread the check and the call cannot be interleaved with
        // the stop, so the exception is never raised at all.
        let deliver = move || responder.respond(response);
        if app.run_on_main_thread(deliver).is_err() {
            // the event loop is gone: the window is closing, nothing to answer
        }
    }));
}

fn route(data: &Path, path: &str, range: Option<&str>) -> Result<Response<Body>, StatusCode> {
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let kind = parts.next().unwrap_or("");
    let id = parts.next().and_then(parse_id).ok_or(StatusCode::NOT_FOUND)?;
    match kind {
        "thumb" | "preview" => {
            if file_locked(data, id)? {
                return Err(StatusCode::NOT_FOUND);
            }
            let dir = if kind == "thumb" { "thumbs" } else { "previews" };
            let file = shard(&data.join(dir), id, ".webp");
            if file.is_file() {
                serve_file(&file, range, CACHE_FOREVER)
            } else {
                proxy(&format!("/api/{kind}/{id}"), range)
            }
        }
        "face" => {
            if face_locked(data, id)? {
                return Err(StatusCode::NOT_FOUND);
            }
            // Same fallback the Python side keeps: the current crop version
            // first, then whatever an older version left behind.
            let dir = data.join("facecrops");
            let current = shard(&dir, id, ".v2.webp");
            let legacy = shard(&dir, id, ".webp");
            if current.is_file() {
                serve_file(&current, range, CACHE_FOREVER)
            } else if legacy.is_file() {
                serve_file(&legacy, range, CACHE_FOREVER)
            } else {
                proxy(&format!("/api/faces/{id}/thumb"), range)
            }
        }
        "media" => serve_file(&original_path(data, id)?, range, CACHE_PRIVATE),
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

// ---- the database -----------------------------------------------------------

/// Run a read against `library.db` on the one connection this module keeps.
/// Opened on first use and reused; dropped after any error so the next
/// request reopens it — the way out of a checkpoint or a replaced file.
fn with_db<T>(
    data: &Path,
    f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Result<T, StatusCode> {
    let mut guard = DB.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        let conn = open_db(&data.join("library.db")).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        *guard = Some(conn);
    }
    match f(guard.as_ref().expect("opened above")) {
        Ok(v) => Ok(v),
        Err(_) => {
            *guard = None;
            Err(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
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

/// `files.locked` for one file. `Err(NOT_FOUND)` when there is no such file —
/// a thumbnail for a row that no longer exists is not served either.
///
/// `files.locked` arrived with migration 0014; a database an older backend
/// has not migrated yet answers the same question from `locked_items`.
fn file_locked(data: &Path, id: i64) -> Result<bool, StatusCode> {
    with_db(data, |c| {
        let flag = c
            .prepare_cached("SELECT locked FROM files WHERE id = ?1")
            .and_then(|mut s| s.query_row([id], |r| r.get::<_, i64>(0)).optional());
        match flag {
            Ok(v) => Ok(v),
            Err(_) => c
                .prepare_cached(
                    "SELECT EXISTS (SELECT 1 FROM locked_items li WHERE li.file_id = f.id) \
                     FROM files f WHERE f.id = ?1",
                )?
                .query_row([id], |r| r.get::<_, i64>(0))
                .optional(),
        }
    })
    .and_then(|v| v.ok_or(StatusCode::NOT_FOUND))
    .map(|v| v != 0)
}

/// The same, for the file a face was found in.
fn face_locked(data: &Path, face_id: i64) -> Result<bool, StatusCode> {
    with_db(data, |c| {
        let flag = c
            .prepare_cached("SELECT f.locked FROM faces fa JOIN files f ON f.id = fa.file_id WHERE fa.id = ?1")
            .and_then(|mut s| s.query_row([face_id], |r| r.get::<_, i64>(0)).optional());
        match flag {
            Ok(v) => Ok(v),
            Err(_) => c
                .prepare_cached(
                    "SELECT EXISTS (SELECT 1 FROM locked_items li WHERE li.file_id = fa.file_id) \
                     FROM faces fa WHERE fa.id = ?1",
                )?
                .query_row([face_id], |r| r.get::<_, i64>(0))
                .optional(),
        }
    })
    .and_then(|v| v.ok_or(StatusCode::NOT_FOUND))
    .map(|v| v != 0)
}

/// Where the original of file `id` is right now, following the same rules as
/// `services/volumes.abs_path_for_file`: the volume must be online, and the
/// POSIX rel_path is joined onto its current mount path. A locked file has no
/// path, as far as this scheme is concerned.
fn original_path(data: &Path, id: i64) -> Result<PathBuf, StatusCode> {
    let row = with_db(data, |c| {
        let modern = c
            .prepare_cached(
                "SELECT f.rel_path, v.last_mount_path, v.is_online, f.locked \
                 FROM files f JOIN volumes v ON v.id = f.volume_id \
                 WHERE f.id = ?1 AND f.status = 'active'",
            )
            .and_then(|mut s| s.query_row([id], row4).optional());
        match modern {
            Ok(v) => Ok(v),
            Err(_) => c
                .prepare_cached(
                    "SELECT f.rel_path, v.last_mount_path, v.is_online, \
                            EXISTS (SELECT 1 FROM locked_items li WHERE li.file_id = f.id) \
                     FROM files f JOIN volumes v ON v.id = f.volume_id \
                     WHERE f.id = ?1 AND f.status = 'active'",
                )?
                .query_row([id], row4)
                .optional(),
        }
    })?;
    let (rel, mount, online, locked) = row.ok_or(StatusCode::NOT_FOUND)?;
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

type OriginalRow = (String, Option<String>, i64, i64);

fn row4(r: &rusqlite::Row<'_>) -> rusqlite::Result<OriginalRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
}

// ---- serving ----------------------------------------------------------------

/// One file, whole or in part.
///
/// A `Range` header gets a 206 with the slice it asked for (open-ended ranges
/// are capped at `MAX_RANGE_CHUNK`); no header gets the whole file as a 200.
/// Both carry `Accept-Ranges`, so a player learns it may seek.
fn serve_file(path: &Path, range: Option<&str>, cache: &'static str) -> Result<Response<Body>, StatusCode> {
    let mut file = File::open(path).map_err(|_| StatusCode::NOT_FOUND)?;
    let total = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?.len();

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime_for(path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, cache);

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

/// A cache file that is not on disk yet: ask Python's own route for it and
/// hand back whatever it says, status and all. Python writes the file as a
/// side effect, so the next request is served from disk.
fn proxy(path: &str, range: Option<&str>) -> Result<Response<Body>, StatusCode> {
    let base = SERVER_URL.get().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
    let mut req = agent.get(&format!("{base}{path}"));
    if let Some(r) = range {
        req = req.set("Range", r);
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(_) => return Err(StatusCode::BAD_GATEWAY),
    };
    let status = StatusCode::from_u16(resp.status()).map_err(|_| StatusCode::BAD_GATEWAY)?;
    let content_type = resp
        .header("Content-Type")
        .unwrap_or("application/octet-stream")
        .to_string();
    let passthrough: Vec<(header::HeaderName, String)> = [
        (header::CACHE_CONTROL, resp.header("Cache-Control")),
        (header::CONTENT_RANGE, resp.header("Content-Range")),
        (header::ACCEPT_RANGES, resp.header("Accept-Ranges")),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.map(|v| (k, v.to_string())))
    .collect();
    let mut body = Vec::new();
    resp.into_reader()
        .take(MAX_PROXY_BODY)
        .read_to_end(&mut body)
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, body.len().to_string());
    for (k, v) in passthrough {
        builder = builder.header(k, v);
    }
    builder.body(Body::from(body)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
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

/// The SPA is a different origin from this scheme on every platform. `<img>`
/// and `<video>` never need CORS; a `fetch()` from the page does — and only a
/// page served from loopback is the page, so that is the only origin echoed.
fn with_cors(mut response: Response<Body>, origin: Option<&str>) -> Response<Body> {
    if let Some(o) = origin.filter(|o| o.starts_with("http://127.0.0.1:") || o.starts_with("http://localhost:")) {
        let h = response.headers_mut();
        if let Ok(v) = o.parse() {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        }
        // Content-Range and Accept-Ranges are not CORS-safelisted; expose them
        // so the page can read what a ranged fetch got back.
        h.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Accept-Ranges, Content-Length".parse().expect("static header"),
        );
    }
    response
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Body::from(Vec::new()))
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_plain_positive_integers() {
        assert_eq!(parse_id("123"), Some(123));
        assert_eq!(parse_id("0"), None);
        assert_eq!(parse_id("-1"), None);
        assert_eq!(parse_id("1 "), None);
        assert_eq!(parse_id("1/../2"), None);
        assert_eq!(parse_id(""), None);
        assert_eq!(parse_id("9999999999999999999"), None);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-3", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        // open-ended ranges are capped, so a huge file is never read whole
        let (s, e) = parse_range("bytes=0-", 10 * MAX_RANGE_CHUNK).unwrap();
        assert_eq!((s, e), (0, MAX_RANGE_CHUNK - 1));
    }

    #[test]
    fn shards_match_the_python_layout() {
        let p = shard(Path::new("/d/thumbs"), 300_001, ".webp");
        assert_eq!(p, PathBuf::from("/d/thumbs/e1/300001.webp")); // 300001 % 256 = 225 = 0xe1
        assert_eq!(shard(Path::new("/d"), 5, ".v2.webp"), PathBuf::from("/d/05/5.v2.webp"));
    }

    #[test]
    fn platform_base_matches_tauri_mapping() {
        if cfg!(windows) {
            assert_eq!(image_base(), "http://smriti.localhost");
        } else {
            assert_eq!(image_base(), "smriti://localhost");
        }
    }
}
