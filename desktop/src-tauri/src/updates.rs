//! In-app updates: the shell finds them, the app itself says so.
//!
//! This used to run entirely on native message dialogs. A dialog with no parent
//! window is its own window — and on a Mac set to prefer tabs, literally another
//! tab — so the news that an update existed arrived detached from the app it was
//! about, and could sit unnoticed behind the main window. Worse, the *only* time
//! it was ever offered was the ten-second mark after launch; miss it and the
//! next chance was the next launch.
//!
//! So the shell no longer speaks. It answers: a check returns its result to
//! whoever asked, the automatic check emits an event *and* parks its result
//! where a page that loads later can still find it, and an accepted download
//! reports progress as events. The SPA renders all of it in the window the user
//! is already looking at.
//!
//! One exception. If the Python server never came up there is no SPA to render
//! anything — and a shell sitting on its error screen is exactly when a newer
//! build is most likely to be the fix — so that path keeps the old dialog and
//! the injected progress overlay.

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

const MB: u64 = 1_048_576;

/// How long to let the app settle before the first check. Deliberately after
/// the server is up: a slow or unreachable GitHub must never delay the library
/// opening, and by then the SPA is loaded and can show what the check finds.
const FIRST_CHECK: Duration = Duration::from_secs(10);

/// How often to look after that, for as long as the app runs.
const POLL_EVERY: Duration = Duration::from_secs(30 * 60);

/// Ignore a focus-triggered check this soon after the last one, so moving
/// between windows does not turn into a stream of requests to GitHub.
const FOCUS_DEBOUNCE: Duration = Duration::from_secs(5 * 60);

/// What the last check found. Held so that accepting an update does not have to
/// ask GitHub a second time, and so a page loaded *after* the automatic check
/// can still learn what it turned up.
#[derive(Default)]
pub struct Pending {
    update: Mutex<Option<Update>>,
    /// When a check last ran. Wall clock rather than `Instant` on purpose: a
    /// macOS `Instant` does not tick while the machine is asleep, so a laptop
    /// shut overnight would wake believing it had just checked — which is the
    /// one moment the check must not be skipped.
    last_check: Mutex<Option<SystemTime>>,
}

/// Everything the UI needs to describe an available update.
#[derive(Clone, serde::Serialize)]
pub struct UpdateInfo {
    /// The version on offer.
    pub version: String,
    /// The version running right now.
    pub current: String,
    /// Release notes, as the release workflow assembled them from the commits.
    pub notes: String,
}

/// The outcome of a check, in the three shapes the UI has to phrase.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CheckResult {
    Available(UpdateInfo),
    Current { current: String },
    /// Could not ask. Running offline is fully supported, so this is news only
    /// when somebody pressed the button.
    Offline { error: String },
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    /// "downloading" | "installing" | "restarting"
    phase: &'static str,
    downloaded: u64,
    /// 0 when the server sent no content-length.
    total: u64,
    /// 0..=100, and 0 for as long as `total` is unknown.
    pct: u64,
}

fn info(app: &tauri::AppHandle, update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current: app.package_info().version.to_string(),
        notes: update.body.clone().unwrap_or_default().trim().to_string(),
    }
}

/// Ask the endpoint. `Ok(None)` means "already on the newest build".
async fn fetch(app: &tauri::AppHandle) -> Result<Option<Update>, String> {
    app.updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// Run a check and remember what it found.
async fn check(app: &tauri::AppHandle) -> CheckResult {
    let current = app.package_info().version.to_string();
    let result = fetch(app).await;
    // Recorded even when it failed: a flaky network must not turn every window
    // focus into another attempt.
    *app.state::<Pending>().last_check.lock().unwrap() = Some(SystemTime::now());
    match result {
        Ok(Some(update)) => {
            let found = info(app, &update);
            *app.state::<Pending>().update.lock().unwrap() = Some(update);
            println!("smriti: update {} available", found.version);
            CheckResult::Available(found)
        }
        Ok(None) => {
            // Clear it: an update that was pending may have been installed by
            // some other means since, and offering it again would just fail.
            *app.state::<Pending>().update.lock().unwrap() = None;
            println!("smriti: already up to date");
            CheckResult::Current { current }
        }
        Err(error) => {
            eprintln!("smriti: update check failed: {error}");
            CheckResult::Offline { error }
        }
    }
}

/// "Check for updates", from the UI. Reports the up-to-date and offline cases
/// too — the automatic check swallows both on purpose, which is right when
/// nobody asked and wrong the moment somebody does.
#[tauri::command]
pub async fn check_updates_now(app: tauri::AppHandle) -> Result<CheckResult, String> {
    Ok(check(&app).await)
}

/// What the automatic check found, if anything.
///
/// The event it emits is long gone by the time the SPA mounts — ten seconds in,
/// the loaded document is usually still the splash — so the page asks as well
/// as listens. Cheap, and it also survives a reload.
#[tauri::command]
pub fn pending_update(app: tauri::AppHandle) -> Option<UpdateInfo> {
    let pending = app.state::<Pending>();
    let update = pending.update.lock().unwrap();
    update.as_ref().map(|u| info(&app, u))
}

/// Accepted. Downloads in the background and reports through the `update://`
/// events; on success the app restarts, so nothing is ever returned for that.
#[tauri::command]
pub fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app.state::<Pending>().update.lock().unwrap().clone();
    let update = update.ok_or_else(|| "No update is pending — check for one first.".to_string())?;
    tauri::async_runtime::spawn(install(app, update, false));
    Ok(())
}

/// One automatic check. Silent by design: a machine that is offline — which
/// this app fully supports — must never be nagged. Returns whether it found
/// something, so the caller knows to stop asking.
async fn auto_check(app: &tauri::AppHandle) -> bool {
    let CheckResult::Available(found) = check(app).await else {
        return false;
    };
    let _ = app.emit("update://available", found.clone());

    // Normally that is the whole job: the SPA has what it needs to say so
    // itself, now or whenever it finishes loading — `pending_update` keeps the
    // answer for it. Note this asks whether startup *failed*, not whether the
    // server is up: ten seconds in, a cold machine may still be starting one,
    // and that is not a reason to fall back to a dialog.
    if !app
        .state::<crate::AppState>()
        .startup_failed
        .load(Ordering::Relaxed)
    {
        return true;
    }

    // Startup failed, so there is no SPA and never will be. Fall back to the
    // shell's own dialog rather than leave a broken install sitting there with
    // its fix one download away and no way to hear about it.
    let detail = if found.notes.is_empty() {
        format!("You have {}.", found.current)
    } else {
        format!("You have {}.\n\n{}", found.current, found.notes)
    };
    let accepted = app
        .dialog()
        .message(detail)
        .title(format!("Smriti {} is available", found.version))
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update and Restart".into(),
            "Later".into(),
        ))
        .blocking_show();

    if !accepted {
        println!("smriti: user postponed the update");
        return true;
    }
    let update = app.state::<Pending>().update.lock().unwrap().clone();
    if let Some(update) = update {
        install(app.clone(), update, true).await;
    }
    true
}

/// Keep looking for as long as the app runs.
///
/// A photo library is something people leave open for days, so a check only at
/// launch means a release published on Tuesday reaches a Thursday session
/// never. Once something is found the polling stops: the notice is already
/// waiting in the rail, and asking again cannot make it any more available.
pub async fn watch(app: tauri::AppHandle) {
    tokio::time::sleep(FIRST_CHECK).await;
    loop {
        if auto_check(&app).await {
            return;
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

/// Coming back to the window is its own reason to look.
///
/// `watch` runs on a timer, and a timer is exactly what a sleeping machine does
/// not advance — a laptop shut for the night wakes with most of its interval
/// still to run. Returning to the app is both the moment a new version matters
/// most and the moment that timer is least likely to have fired.
pub fn check_on_focus(app: &tauri::AppHandle) {
    let state = app.state::<Pending>();
    if state.update.lock().unwrap().is_some() {
        return; // already offering one
    }
    // Nothing recorded yet means the app has only just started, and the first
    // check is already on its way.
    let Some(last) = *state.last_check.lock().unwrap() else {
        return;
    };
    // `elapsed` fails only if the clock went backwards, which is no reason to
    // skip a check.
    if last.elapsed().map(|since| since < FOCUS_DEBOUNCE).unwrap_or(false) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        auto_check(&app).await;
    });
}

/// Report one step of the download. Always as an event; additionally into the
/// injected overlay when there is no SPA to receive the event.
fn report(app: &tauri::AppHandle, overlay: bool, progress: Progress) {
    let _ = app.emit("update://progress", progress.clone());
    if !overlay {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let label = match progress.phase {
        "downloading" if progress.total > 0 => format!(
            "Downloading… {} of {} MB",
            progress.downloaded / MB,
            progress.total / MB
        ),
        "downloading" => format!("Downloading… {} MB", progress.downloaded / MB),
        "installing" => "Installing…".to_string(),
        _ => "Restarting…".to_string(),
    };
    let _ = window.eval(format!(
        "window.__smritiUpdate({},{})",
        progress.pct,
        crate::js_string(&label)
    ));
}

/// Download the new bundle, install it over this one, and restart into it.
async fn install(app: tauri::AppHandle, update: Update, overlay: bool) {
    if overlay {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(OVERLAY_JS);
        }
    }
    report(
        &app,
        overlay,
        Progress { phase: "downloading", downloaded: 0, total: 0, pct: 0 },
    );

    let mut downloaded = 0u64;
    let mut painted = Instant::now();
    let (chunk_app, done_app) = (app.clone(), app.clone());

    let result = update
        .download_and_install(
            move |chunk: usize, total: Option<u64>| {
                downloaded += chunk as u64;
                // ~8 repaints a second. One per chunk floods the webview and
                // makes the download slower than the bar drawing it.
                if painted.elapsed() < Duration::from_millis(120) {
                    return;
                }
                painted = Instant::now();
                let total = total.unwrap_or(0);
                report(
                    &chunk_app,
                    overlay,
                    Progress {
                        phase: "downloading",
                        downloaded,
                        total,
                        pct: if total > 0 { (downloaded * 100 / total).min(100) } else { 0 },
                    },
                );
            },
            move || {
                report(
                    &done_app,
                    overlay,
                    Progress { phase: "installing", downloaded: 0, total: 0, pct: 100 },
                );
            },
        )
        .await;

    if let Err(e) = result {
        let message = e.to_string();
        eprintln!("smriti: update failed: {message}");
        let _ = app.emit("update://failed", message.clone());
        if overlay {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.__smritiUpdate(-1,'')"); // tear it down
            }
            app.dialog()
                .message(format!("The update could not be installed.\n\n{message}"))
                .title("Update failed")
                .blocking_show();
        }
        return;
    }

    report(
        &app,
        overlay,
        Progress { phase: "restarting", downloaded: 0, total: 0, pct: 100 },
    );
    tokio::time::sleep(Duration::from_millis(400)).await; // let that paint

    // The new bundle is on disk but the old one is still running; without this
    // the user sees no change and assumes the update did nothing.
    app.restart();
}

/// Defines `window.__smritiUpdate(pct, label)` — an idempotent progress overlay
/// injected into whatever page is loaded. Self-contained because it lands on
/// the splash, which shares no styles with the SPA. pct < 0 removes it.
///
/// Only used on the no-server path; the SPA draws its own from the events.
const OVERLAY_JS: &str = r#"
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
