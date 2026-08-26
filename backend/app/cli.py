"""`smriti` — command-line entry point for the installed app.

Commands:
  smriti           serve in the foreground (opens the browser)
  smriti start     serve in the background (pidfile + logfile in the data dir)
  smriti stop      stop the background server
  smriti status    is it running?
  smriti logs      show the log (-f to follow)
  smriti models    one-time model download (faces by default, --search for search)
"""
import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

DEFAULT_PORT = 6969


def _force_utf8_output() -> None:
    """Windows stdout defaults to cp1252, which cannot encode the ⚠/ℹ glyphs
    or the Devanagari in our banner. Printing them raises UnicodeEncodeError
    and kills the process before uvicorn ever binds — so the server appears to
    hang rather than start. errors='replace' keeps output alive even on a
    console whose codepage still cannot render the glyph."""
    if sys.platform != "win32":
        return
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _desktop() -> bool:
    """True when launched by the desktop shell, which owns the window and the
    process lifecycle (so: no browser, no daemon, no pidfile)."""
    return os.environ.get("SMRITI_DESKTOP") == "1"


def _start_parent_watchdog() -> None:
    """Exit if the desktop shell dies. On POSIX the shell's process group does
    not survive its own SIGKILL, so without this the server and its worker
    pools would leak. On Windows the job object already handles it."""
    parent = os.environ.get("SMRITI_PARENT_PID")
    if not parent or sys.platform == "win32":
        return
    try:
        parent_pid = int(parent)
    except ValueError:
        return

    def watch() -> None:
        while True:
            time.sleep(2)
            if os.getppid() != parent_pid:  # reparented to launchd => shell is gone
                os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _health_ok(host: str, port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _read_pid(pidfile: Path) -> int | None:
    try:
        pid = int(pidfile.read_text().strip())
        return pid if _alive(pid) else None
    except (OSError, ValueError):
        return None


def _start_daemon(config, args) -> None:
    if _desktop():
        # the daemon detaches its session/process group on purpose, which is
        # exactly what would escape the shell's cleanup and orphan the server
        print("`smriti start` is not available inside the desktop app — it already runs the server.")
        sys.exit(1)
    pidfile = config.DATA_DIR / "smriti.pid"
    logfile = config.DATA_DIR / "smriti.log"
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    url = f"http://{args.host}:{args.port}"

    pid = _read_pid(pidfile)
    if pid is not None:
        print(f"already running (pid {pid}) — {url}")
        return
    if _health_ok(args.host, args.port):
        print(f"something else is already serving {url} — stop it first or pick another --port")
        return

    pkg = __package__  # "smriti_server" installed, "app" from a checkout
    code = (
        f"import sys; sys.argv=['smriti','--no-browser','--host','{args.host}','--port','{args.port}']; "
        f"from {pkg}.cli import main; main()"
    )
    env = os.environ.copy()
    env.setdefault("PYTHONPATH", str(Path(__file__).resolve().parents[1]))
    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED | NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    with open(logfile, "ab") as lf:
        lf.write(f"\n--- smriti start · {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n".encode())
        proc = subprocess.Popen([sys.executable, "-c", code], stdout=lf, stderr=lf, env=env, **kwargs)
    pidfile.write_text(str(proc.pid))

    for _ in range(30):  # up to ~15s for models/db to come up
        if _health_ok(args.host, args.port):
            print(f"स्मृति Smriti running in the background — {url}  (pid {proc.pid})")
            print(f"  logs: smriti logs -f   ·   stop: smriti stop")
            if not args.no_browser:
                webbrowser.open(url)
            return
        if not _alive(proc.pid):
            break
        time.sleep(0.5)
    print("failed to start — recent log:")
    _print_log_tail(logfile, 15)
    pidfile.unlink(missing_ok=True)
    sys.exit(1)


def _stop(config) -> None:
    pidfile = config.DATA_DIR / "smriti.pid"
    pid = _read_pid(pidfile)
    if pid is None:
        pidfile.unlink(missing_ok=True)
        print("not running")
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(20):
        if not _alive(pid):
            break
        time.sleep(0.5)
    if _alive(pid):
        os.kill(pid, signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
    pidfile.unlink(missing_ok=True)
    print(f"stopped (pid {pid})")


def _status(config, args) -> None:
    pid = _read_pid(config.DATA_DIR / "smriti.pid")
    healthy = _health_ok(args.host, args.port)
    url = f"http://{args.host}:{args.port}"
    if pid is not None and healthy:
        print(f"● running — {url}  (pid {pid}, data: {config.DATA_DIR})")
    elif healthy:
        print(f"● serving {url}, but not started by `smriti start` (foreground or brew services?)")
    elif pid is not None:
        print(f"◐ process alive (pid {pid}) but {url} not answering — check: smriti logs")
    else:
        print(f"○ stopped  (start: smriti start · data: {config.DATA_DIR})")


def _print_log_tail(logfile: Path, n: int) -> None:
    try:
        lines = logfile.read_text(errors="replace").splitlines()[-n:]
        print("\n".join(lines))
    except OSError:
        print(f"no log yet at {logfile}")


def _logs(config, args) -> None:
    logfile = config.DATA_DIR / "smriti.log"
    _print_log_tail(logfile, args.lines)
    if not args.follow:
        return
    try:
        with open(logfile, "r", errors="replace") as f:
            f.seek(0, os.SEEK_END)
            while True:
                chunk = f.readline()
                if chunk:
                    print(chunk, end="")
                else:
                    time.sleep(0.5)
    except KeyboardInterrupt:
        pass


def main() -> None:
    _force_utf8_output()  # must precede every print on Windows
    p = argparse.ArgumentParser(
        prog="smriti",
        description="स्मृति Smriti — a fully-offline library for your local photos",
    )
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to serve on (default {DEFAULT_PORT})")
    p.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    p.add_argument("--data-dir", help="where the library index lives (default ~/.smriti)")
    p.add_argument("--no-browser", action="store_true", help="don't open the browser on start")
    sub = p.add_subparsers(dest="cmd")

    def add_common(sp: argparse.ArgumentParser) -> None:
        # accepted after the subcommand too; SUPPRESS keeps them from
        # clobbering values given before it
        sp.add_argument("--port", type=int, default=argparse.SUPPRESS)
        sp.add_argument("--host", default=argparse.SUPPRESS)
        sp.add_argument("--data-dir", default=argparse.SUPPRESS)
        sp.add_argument("--no-browser", action="store_true", default=argparse.SUPPRESS)

    add_common(sub.add_parser("start", help="run the server in the background"))
    add_common(sub.add_parser("stop", help="stop the background server"))
    add_common(sub.add_parser("status", help="show whether the server is running"))
    lp = sub.add_parser("logs", help="show the server log")
    lp.add_argument("-f", "--follow", action="store_true", help="keep following new log lines")
    lp.add_argument("-n", "--lines", type=int, default=50, help="how many lines to show (default 50)")
    add_common(lp)
    mp = sub.add_parser("models", help="download the on-device models (one-time)")
    # Two separate downloads because they are two separate features, and a
    # library that only ever wants one should not pay 500 MB for both.
    mp.add_argument("--search", action="store_true",
                    help="the semantic-search model (~219 MB) instead of the face models (~280 MB)")
    mp.add_argument("--all", action="store_true", help="both")
    add_common(mp)
    args = p.parse_args()

    if args.data_dir:
        os.environ["SMRITI_DATA_DIR"] = args.data_dir

    from . import config  # reads env at import time — import after env is set

    if args.cmd == "models":
        if args.search or args.all:
            from . import fetch_clip

            fetch_clip.download()
        if not args.search or args.all:
            from . import fetch_models

            fetch_models.download()
        if args.search or args.all:
            print("run `smriti` and open Search to index your photos (once)")
        return
    if args.cmd == "start":
        _start_daemon(config, args)
        return
    if args.cmd == "stop":
        _stop(config)
        return
    if args.cmd == "status":
        _status(config, args)
        return
    if args.cmd == "logs":
        _logs(config, args)
        return

    # foreground serve
    import uvicorn

    from . import main as app_main

    if shutil.which(config.FFMPEG) is None:
        hint = {
            "darwin": "brew install ffmpeg",
            "win32": "winget install ffmpeg",
        }.get(sys.platform, "install ffmpeg via your package manager")
        print(f"⚠ ffmpeg not found — videos won't be indexed ({hint})")
    if not (config.FACE_MODEL_DIR / "det_10g.onnx").exists():
        print("ℹ People is off until the face models are downloaded — run `smriti models` once (~280 MB)")
    from .fetch_clip import present as _clip_present

    if not _clip_present():
        print("ℹ Search by what a photo shows is off until its model is downloaded — "
              "run `smriti models --search` once (~219 MB), or use the Search page")

    if _desktop():
        _start_parent_watchdog()

    # --port 0: bind an ephemeral port ourselves and hand the bound socket to
    # uvicorn, so nothing can steal the port between picking it and listening.
    if args.port == 0:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((args.host, 0))
        port = sock.getsockname()[1]
        # the desktop shell parses this line to learn where to point the webview
        print(f"SMRITI_READY host={args.host} port={port} pid={os.getpid()} data={config.DATA_DIR}",
              flush=True)
        uvicorn.Server(uvicorn.Config(app_main.app, log_level="info")).run(sockets=[sock])
        return

    url = f"http://{args.host}:{args.port}"
    print(f"स्मृति Smriti — your library at {url}  (data: {config.DATA_DIR})")
    if not args.no_browser and not _desktop():
        threading.Thread(
            target=lambda: (time.sleep(1.2), webbrowser.open(url)), daemon=True
        ).start()
    uvicorn.run(app_main.app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
