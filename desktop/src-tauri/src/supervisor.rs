//! Owns the Python server child: spawn it, learn its port, wait for health,
//! stream its output, and make sure it never outlives the app.
//!
//! Cleanup is the subtle part. The server spawns its own ProcessPoolExecutor
//! grandchildren (up to 8 for scanning, 2 for faces, each holding ~190 MB of
//! ONNX models), so killing just the direct child would orphan them. We put the
//! whole tree in a process group (Unix) / Job Object (Windows) via
//! `command-group`. On Windows the kernel tears the job down even if we are
//! force-killed; on Unix it does not, which is why the Python side also runs a
//! parent-PID watchdog (see cli.py `_start_parent_watchdog`).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use command_group::{CommandGroup, GroupChild};

use crate::paths::Layout;

const READY_TIMEOUT: Duration = Duration::from_secs(60);
const LOG_TAIL_LINES: usize = 200;
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub struct Server {
    child: Mutex<Option<GroupChild>>,
    pub tail: Arc<Mutex<Vec<String>>>,
    pub log_path: PathBuf,
}

pub struct Ready {
    pub url: String,
}

fn push_tail(tail: &Arc<Mutex<Vec<String>>>, line: &str) {
    let mut t = tail.lock().unwrap();
    if t.len() >= LOG_TAIL_LINES {
        t.remove(0);
    }
    t.push(line.to_string());
}

impl Server {
    /// Spawn the server on an ephemeral port and block until `/api/health`
    /// answers. Returns the URL to point the webview at.
    pub fn start(layout: &Layout) -> Result<(Self, Ready), String> {
        std::fs::create_dir_all(&layout.data_dir)
            .map_err(|e| format!("cannot create data dir {}: {e}", layout.data_dir.display()))?;

        let log_path = layout.log_file();
        if std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
            let _ = std::fs::remove_file(&log_path);
        }
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("cannot open log {}: {e}", log_path.display()))?;
        let _ = writeln!(log, "\n--- smriti desktop start · pid {} ---", std::process::id());

        let mut cmd = std::process::Command::new(&layout.python);
        cmd.arg("-c")
            // `-c` on purpose: it sets neither init_main_from_name nor
            // init_main_from_path, so spawned workers never re-import this.
            .arg("import sys; sys.argv=['smriti','--port','0']; from smriti_server.cli import main; main()")
            .current_dir(&layout.data_dir) // macOS launches .apps with cwd=/
            .env("SMRITI_DESKTOP", "1")
            .env("SMRITI_PARENT_PID", std::process::id().to_string())
            .env("SMRITI_DATA_DIR", &layout.data_dir)
            .env("PYTHONDONTWRITEBYTECODE", "1") // install dir is read-only
            .env("PYTHONUTF8", "1")              // non-ASCII filenames on Windows
            .env("PYTHONIOENCODING", "utf-8")
            .env("OMP_NUM_THREADS", "2")         // bound sklearn's libomp + onnxruntime
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(ff) = layout.tool("ffmpeg") {
            cmd.env("SMRITI_FFMPEG", ff);
        }
        if let Some(fp) = layout.tool("ffprobe") {
            cmd.env("SMRITI_FFPROBE", fp);
        }

        // CREATE_NO_WINDOW must be set on command-group's builder, NOT on the
        // Command: group_spawn() calls .creation_flags(self.creation_flags |
        // CREATE_SUSPENDED) internally, which *overwrites* anything set on the
        // Command. Losing it means Windows allocates a console for the child —
        // a stray terminal next to the app, and closing it kills the server.
        #[cfg(windows)]
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // kill_on_drop(true) is what actually sets JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        // on the job — it defaults to false, in which case the server and its
        // worker pool would survive the app being force-killed. That flag is the
        // whole reason Windows needs no equivalent of the POSIX parent watchdog.
        #[cfg(windows)]
        let mut child = cmd
            .group()
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to launch {}: {e}", layout.python.display()))?;

        #[cfg(not(windows))]
        let mut child = cmd
            .group_spawn()
            .map_err(|e| format!("failed to launch {}: {e}", layout.python.display()))?;

        let tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = std::sync::mpsc::channel::<String>();

        // stdout: watch for the SMRITI_READY sentinel, mirror everything to the log
        let stdout = child.inner().stdout.take().ok_or("no stdout pipe")?;
        {
            let tail = tail.clone();
            let mut log = log.try_clone().map_err(|e| e.to_string())?;
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let _ = writeln!(log, "{line}");
                    if line.starts_with("SMRITI_READY") {
                        let _ = tx.send(line.clone());
                    }
                    push_tail(&tail, &line);
                }
            });
        }
        // stderr: uvicorn logs here, so this is where a crash actually shows up
        let stderr = child.inner().stderr.take().ok_or("no stderr pipe")?;
        {
            let tail = tail.clone();
            let mut log = log.try_clone().map_err(|e| e.to_string())?;
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = writeln!(log, "{line}");
                    push_tail(&tail, &line);
                }
            });
        }

        let server = Self {
            child: Mutex::new(Some(child)),
            tail: tail.clone(),
            log_path,
        };

        // wait for the sentinel, but give up early if the child dies
        let deadline = Instant::now() + READY_TIMEOUT;
        let sentinel = loop {
            if let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
                break line;
            }
            if let Some(code) = server.exited() {
                return Err(format!(
                    "the library server exited before it was ready (status {code})\n\n{}",
                    server.tail_text()
                ));
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "the library server did not start within {}s\n\n{}",
                    READY_TIMEOUT.as_secs(),
                    server.tail_text()
                ));
            }
        };

        let port = sentinel
            .split_whitespace()
            .find_map(|kv| kv.strip_prefix("port="))
            .ok_or_else(|| format!("could not parse port from: {sentinel}"))?;
        let url = format!("http://127.0.0.1:{port}");

        // health-gate: uvicorn only accepts connections after lifespan startup,
        // which runs the DB migrations — so a 200 here means genuinely ready
        let health = format!("{url}/api/health");
        loop {
            if ureq::get(&health).timeout(Duration::from_secs(2)).call().is_ok() {
                break;
            }
            if let Some(code) = server.exited() {
                return Err(format!(
                    "the library server exited during startup (status {code})\n\n{}",
                    server.tail_text()
                ));
            }
            if Instant::now() > deadline {
                return Err(format!("the server never answered {health}\n\n{}", server.tail_text()));
            }
            std::thread::sleep(Duration::from_millis(150));
        }

        Ok((server, Ready { url }))
    }

    fn exited(&self) -> Option<String> {
        let mut guard = self.child.lock().unwrap();
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => None,
        }
    }

    pub fn tail_text(&self) -> String {
        self.tail.lock().unwrap().join("\n")
    }

    /// Kill the whole group/job — server plus every worker it spawned.
    pub fn shutdown(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}
