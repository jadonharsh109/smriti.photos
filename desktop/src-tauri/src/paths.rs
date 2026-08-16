//! Where the bundled runtime, tools and data directory live.
//!
//! Resource layout inside the bundle:
//!   macOS    <app>/Contents/Resources/runtime/bin/python3.12   .../bin/ffmpeg
//!   Windows  <exe dir>/runtime/python.exe                      .../bin/ffmpeg.exe
//! In `tauri dev` the resource dir is `src-tauri/`, so we also probe `payload/`.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub struct Layout {
    pub python: PathBuf,
    pub bin_dir: PathBuf,
    pub data_dir: PathBuf,
}

fn python_rel() -> &'static str {
    if cfg!(windows) {
        "runtime/python.exe"
    } else {
        "runtime/bin/python3.12"
    }
}

/// `~/Library/Application Support/Smriti` (macOS) or `%LOCALAPPDATA%\Smriti`,
/// but an existing `~/.smriti` from a CLI/Homebrew install wins — adopting it
/// in place means an upgrading user keeps their index, thumbnail cache and the
/// 182 MB of face models, with no copy and no risk of a half-finished move.
fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(explicit) = std::env::var("SMRITI_DATA_DIR") {
        if !explicit.is_empty() {
            return PathBuf::from(explicit);
        }
    }
    if let Some(home) = dirs_home() {
        let legacy = home.join(".smriti");
        if legacy.join("library.db").is_file() {
            return legacy;
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| dirs_home().unwrap_or_default().join(".smriti"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

impl Layout {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let res = app
            .path()
            .resource_dir()
            .map_err(|e| format!("cannot locate resource dir: {e}"))?;

        // bundled layout first, then the `tauri dev` staging directory
        let candidates = [res.clone(), res.join("payload")];
        let base = candidates
            .iter()
            .find(|b| b.join(python_rel()).is_file())
            .ok_or_else(|| {
                format!(
                    "bundled Python runtime not found — looked for {} under {}",
                    python_rel(),
                    candidates
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(" and ")
                )
            })?;

        Ok(Self {
            python: base.join(python_rel()),
            bin_dir: base.join("bin"),
            data_dir: resolve_data_dir(app),
        })
    }

    pub fn tool(&self, name: &str) -> Option<PathBuf> {
        let exe = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        let p = self.bin_dir.join(exe);
        p.is_file().then_some(p)
    }

    pub fn log_file(&self) -> PathBuf {
        self.data_dir.join("desktop.log")
    }
}

pub fn exists(p: &Path) -> bool {
    p.exists()
}
