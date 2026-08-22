// Smriti desktop shell. The window shows a local splash immediately, starts the
// bundled Python server on an ephemeral port, then navigates to it once healthy.
// A failure shows a real error screen with the child's log tail — never a blank
// white window, which is the usual failure mode for this architecture.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paths;
mod supervisor;
mod updates;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use paths::Layout;
use supervisor::Server;

struct AppState {
    server: Mutex<Option<Arc<Server>>>,
    log_path: Mutex<Option<std::path::PathBuf>>,
    /// The server could not be started at all, so the window is showing the
    /// error screen and there is no SPA behind it. Distinct from `server`
    /// being None, which on a cold machine only means "not yet".
    startup_failed: AtomicBool,
}

#[tauri::command]
fn reveal_log(state: tauri::State<'_, AppState>, app: tauri::AppHandle) {
    if let Some(p) = state.log_path.lock().unwrap().clone() {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().reveal_item_in_dir(p);
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// The user's Downloads folder, falling back to home then the temp dir.
fn downloads_dir() -> std::path::PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from);
    match home {
        Some(h) if h.join("Downloads").is_dir() => h.join("Downloads"),
        Some(h) => h,
        None => std::env::temp_dir(),
    }
}

/// Minimal percent-decoding — filenames arrive URL-encoded in the download URL.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "export.zip" -> "export (2).zip" when the name is taken, the way a browser
/// does — silently overwriting a previous export would be data loss.
fn unique_in_dir(dir: &std::path::Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    for n in 2..1000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    name.to_string()
}

/// Escape a string for safe interpolation into a JS single-quoted literal.
pub(crate) fn js_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "");
    format!("'{escaped}'")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // second launch focuses the existing window instead of starting a
        // second server against the same SQLite file
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
        }))
        .manage(AppState {
            server: Mutex::new(None),
            log_path: Mutex::new(None),
            startup_failed: AtomicBool::new(false),
        })
        .manage(updates::Pending::default())
        .invoke_handler(tauri::generate_handler![
            reveal_log,
            quit_app,
            updates::check_updates_now,
            updates::pending_update,
            updates::install_update,
        ])
        .setup(|app| {
            // Empty title: the app brands itself in its own sidebar, so the
            // titlebar only needs to carry the traffic lights.
            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("")
                .inner_size(1280.0, 860.0)
                .min_inner_size(940.0, 600.0)
                .resizable(true)
                .visible(true)
                // Marks the document so the shared stylesheet can make room for
                // the floating traffic lights. Runs at document-start on every
                // navigation, including onto the served origin — which is why
                // this is a webview script rather than a build-time flag: the
                // same CSS file also ships to plain browsers.
                .initialization_script(
                    "try{document.documentElement.setAttribute('data-smriti-desktop','1')}catch(e){}",
                )
                // WKWebView ignores <a download> unless the host handles it, so
                // without this the ZIP export and the lightbox's "download
                // original" button silently do nothing inside the app.
                .on_download(|_webview, event| {
                    if let tauri::webview::DownloadEvent::Requested { url, destination } = event {
                        // Only trust the last segment if it actually looks like
                        // a filename. It used to be an opaque token, which
                        // saved every export as an extension-less blob that
                        // would not open.
                        let name = url
                            .path_segments()
                            .and_then(|s| s.last())
                            .filter(|s| !s.is_empty())
                            .map(|s| percent_decode(s))
                            .filter(|s| s.contains('.') && !s.starts_with('.'))
                            .unwrap_or_else(|| "smriti-download".into());
                        *destination = downloads_dir().join(unique_in_dir(&downloads_dir(), &name));
                        println!("smriti: saving download to {}", destination.display());
                    }
                    true // allow both Requested and Finished
                });

            // Overlay = transparent titlebar + hidden title + full-size content,
            // so the window chrome disappears into the app's own background.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            let window = builder.build()?;

            let handle = app.handle().clone();
            // Blocking work off the UI thread: fetching, spawning and health-polling
            // the server takes seconds, and the splash must stay animating.
            std::thread::spawn(move || {
                let result = Layout::resolve(&handle).and_then(|layout| {
                    handle
                        .state::<AppState>()
                        .log_path
                        .lock()
                        .unwrap()
                        .replace(layout.log_file());
                    Server::start(&layout).map(|(s, ready)| (Arc::new(s), ready))
                });

                match result {
                    Ok((server, ready)) => {
                        handle.state::<AppState>().server.lock().unwrap().replace(server);
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.navigate(ready.url.parse().expect("valid url"));
                            // the served page carries <title>Smriti</title>; make sure
                            // that can't put text back in the titlebar
                            let _ = w.set_title("");
                        }
                    }
                    Err(msg) => {
                        eprintln!("smriti: startup failed: {msg}");
                        handle
                            .state::<AppState>()
                            .startup_failed
                            .store(true, Ordering::Relaxed);
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.eval(&format!(
                                "window.__smriti && window.__smriti.fail({})",
                                js_string(&msg)
                            ));
                        }
                        let _ = handle.emit("startup-failed", msg);
                    }
                }
            });

            // Deliberately after the server is up, not before: a slow or
            // unreachable GitHub must never delay the library opening, and
            // by then the SPA is loaded and can show what it finds.
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    updates::auto_check(h).await;
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Smriti")
        .run(|app, event| {
            // Every exit path must take the server (and its worker pool) down.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(server) = app.state::<AppState>().server.lock().unwrap().take() {
                    server.shutdown();
                }
            }
        });
}
