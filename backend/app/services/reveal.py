"""Show a file where it actually lives, in the OS's own file manager.

Smriti organises a library without moving anything, so at some point every user
wants the other half of that promise made visible: *where is this file?* Reading
the path out of the info panel and hunting for it by hand is the answer this
replaces.

It runs on the machine hosting the library rather than the one holding the
browser. For the desktop app and a plain `smriti` on your own laptop those are
the same machine, which is the case this is for; a server deliberately bound to
a LAN address would pop the window open on the server, so the UI only offers the
button when the two are the same host.

No path ever arrives from the client: callers pass a row from `files`, so the
only thing this can point at is something already in the library.
"""
import os
import subprocess
import sys

# Windows spawns a console window per child process by default — see video_worker.
_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}

_TIMEOUT = 15


class RevealError(RuntimeError):
    """No file manager would take the request."""


def manager_name() -> str:
    """What to call the thing this opens, in the user's own words."""
    return {"darwin": "Finder", "win32": "File Explorer"}.get(sys.platform, "file manager")


def reveal(abs_path: str) -> None:
    """Open the containing folder with this file selected."""
    abs_path = os.path.abspath(abs_path)
    if sys.platform == "darwin":
        _run(["open", "-R", abs_path])
    elif sys.platform == "win32":
        # No space after the comma, and the path unquoted in the argument: this
        # is explorer's own syntax, not a shell one. It also exits non-zero on
        # success often enough that its return code says nothing, so _run is
        # told to ignore it and we trust the window to have opened.
        _run(["explorer", f"/select,{abs_path}"], check=False)
    else:
        _reveal_linux(abs_path)


def _reveal_linux(abs_path: str) -> None:
    """Ask the desktop's file manager to select the file; failing that, just
    open the folder it is in.

    The D-Bus interface is the only portable way to say *select this one* —
    xdg-open has no such verb and would open the file in an image viewer
    instead, which is not what a "show me where this is" button promises."""
    uri = "file://" + _quote_uri(abs_path)
    try:
        _run([
            "dbus-send", "--session", "--print-reply", "--reply-timeout=8000",
            "--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            f"array:string:{uri}", "string:",
        ])
        return
    except (RevealError, FileNotFoundError, OSError):
        pass
    _run(["xdg-open", os.path.dirname(abs_path)])


def _quote_uri(path: str) -> str:
    from urllib.parse import quote

    return quote(path)


def _run(cmd: list[str], check: bool = True) -> None:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT, **_NO_WINDOW)
    except FileNotFoundError as e:
        raise RevealError(f"{cmd[0]} is not available on this system") from e
    except subprocess.TimeoutExpired as e:
        raise RevealError(f"{cmd[0]} did not respond") from e
    except OSError as e:
        raise RevealError(str(e)) from e
    if check and proc.returncode != 0:
        detail = (proc.stderr or b"").decode(errors="replace").strip()
        raise RevealError(detail or f"{cmd[0]} exited with {proc.returncode}")
