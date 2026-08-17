// Smriti desktop shell. The window shows a local splash immediately, starts the
// bundled Python server on an ephemeral port, then navigates to it once healthy.
// A failure shows a real error screen with the child's log tail — never a blank
// white window, which is the usual failure mode for this architecture.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paths;
mod supervisor;

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use paths::Layout;
use supervisor::Server;

struct AppState {
    server: Mutex<Option<Arc<Server>>>,
    log_path: Mutex<Option<std::path::PathBuf>>,
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
fn js_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "");
    format!("'{escaped}'")
}

/// Defines `window.__smritiUpdate(pct, label)` — an idempotent progress overlay
/// injected into whatever page is loaded. Self-contained because it lands on
/// the served SPA, which shares no styles with the shell. pct < 0 removes it.
#[cfg(desktop)]
const UPDATE_OVERLAY_JS: &str = r#"
(function(){
  if (window.__smritiUpdate) return;
  var box, bar, txt;
  function build(){
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;'
      + 'align-items:center;justify-content:center;background:rgba(3,4,8,.86);'
      + '-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);'
      + 'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#f4f6fd';
    var card = document.createElement('div');
    card.style.cssText = 'display:grid;gap:14px;justify-items:center;padding:30px 38px;'
      + 'min-width:330px;border-radius:22px;background:rgba(255,255,255,.055);'
      + 'border:1px solid rgba(255,255,255,.14)';
    var h = document.createElement('div');
    h.textContent = 'Updating Smriti';
    h.style.cssText = 'font-size:16px;font-weight:650';
    txt = document.createElement('div');
    txt.style.cssText = 'font-size:12.5px;color:#a7aec6;font-variant-numeric:tabular-nums';
    var track = document.createElement('div');
    track.style.cssText = 'width:100%;height:6px;border-radius:99px;overflow:hidden;'
      + 'background:rgba(255,255,255,.10)';
    bar = document.createElement('i');
    bar.style.cssText = 'display:block;height:100%;width:0%;border-radius:99px;'
      + 'background:linear-gradient(90deg,#7cc4ff,#6e7bff 55%,#b96bff);'
      + 'transition:width .25s ease';
    track.appendChild(bar);
    var foot = document.createElement('div');
    foot.textContent = 'Keep the app open — it will restart itself.';
    foot.style.cssText = 'font-size:11.5px;color:#767d96';
    card.append(h, txt, track, foot);
    box.appendChild(card);
    document.body.appendChild(box);
  }
  window.__smritiUpdate = function(pct, label){
    if (pct < 0) { if (box) box.remove(); box = null; return; }
    if (!box || !box.isConnected) build();
    if (label) txt.textContent = label;
    bar.style.width = Math.max(2, pct) + '%';
  };
})()
"#;

/// Ask GitHub whether a newer release exists and, if the user agrees, install
/// it. Runs well after startup so it never competes with the server launch for
/// bandwidth or attention, and every failure is silent — a machine that is
/// offline (which this app fully supports) must not see an error.
#[cfg(desktop)]
async fn check_for_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("smriti: updater unavailable: {e}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            println!("smriti: already up to date");
            return;
        }
        Err(e) => {
            // Offline is a supported way to run this app — never nag about it.
            eprintln!("smriti: update check failed: {e}");
            return;
        }
    };

    println!("smriti: update {} available", update.version);

    // Ask first. Silently swapping the app under someone mid-session is not a
    // reasonable thing to do to a photo library that may be indexing.
    let current = app.package_info().version.to_string();
    let notes = update.body.clone().unwrap_or_default();
    let detail = if notes.trim().is_empty() {
        format!("You have {current}.")
    } else {
        format!("You have {current}.\n\n{}", notes.trim())
    };

    let answer = app
        .dialog()
        .message(detail)
        .title(format!("Smriti {} is available", update.version))
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update and Restart".into(),
            "Later".into(),
        ))
        .blocking_show();

    if !answer {
        println!("smriti: user postponed the update");
        return;
    }

    // A ~170 MB download with no feedback looks like the app ignored the click.
    // Drive an in-page overlay from the updater's own progress callbacks.
    let win = app.get_webview_window("main");
    if let Some(w) = &win {
        let _ = w.eval(UPDATE_OVERLAY_JS);
        let _ = w.eval("window.__smritiUpdate(0,'Starting download…')");
    }

    let got = std::sync::Arc::new(std::sync::Mutex::new(0u64));
    let last_paint = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

    let (w_chunk, w_done) = (win.clone(), win.clone());
    let (got_c, last_c) = (got.clone(), last_paint.clone());

    let result = update
        .download_and_install(
            move |chunk: usize, total: Option<u64>| {
                let mut done = got_c.lock().unwrap();
                *done += chunk as u64;
                // repaint at most ~8x/sec: one eval per chunk would flood the
                // webview and make the download slower than the progress bar
                let mut last = last_c.lock().unwrap();
                if last.elapsed() < std::time::Duration::from_millis(120) {
                    return;
                }
                *last = std::time::Instant::now();
                let (d, t) = (*done, total.unwrap_or(0));
                let pct = if t > 0 { (d * 100 / t).min(100) } else { 0 };
                let label = if t > 0 {
                    format!("Downloading… {} of {} MB", d / 1_048_576, t / 1_048_576)
                } else {
                    format!("Downloading… {} MB", d / 1_048_576)
                };
                if let Some(w) = &w_chunk {
                    let _ = w.eval(format!("window.__smritiUpdate({pct},{})", js_string(&label)));
                }
            },
            move || {
                if let Some(w) = &w_done {
                    let _ = w.eval("window.__smritiUpdate(100,'Installing…')");
                }
            },
        )
        .await;

    if let Err(e) = result {
        eprintln!("smriti: update failed: {e}");
        if let Some(w) = &win {
            let _ = w.eval("window.__smritiUpdate(-1,'')"); // tear the overlay down
        }
        app.dialog()
            .message(format!("The update could not be installed.\n\n{e}"))
            .title("Update failed")
            .blocking_show();
        return;
    }

    if let Some(w) = &win {
        let _ = w.eval("window.__smritiUpdate(100,'Restarting…')");
    }
    std::thread::sleep(std::time::Duration::from_millis(400)); // let that paint

    // The new bundle is on disk but the old one is still running; without this
    // the user sees no change and assumes the update did nothing.
    app.restart();
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
        })
        .invoke_handler(tauri::generate_handler![reveal_log, quit_app])
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
            // unreachable GitHub must never delay the library opening.
            #[cfg(desktop)]
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    check_for_update(h).await;
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
