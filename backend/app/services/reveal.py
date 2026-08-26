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
        _reveal_windows(abs_path)
    else:
        _reveal_linux(abs_path)


def _reveal_windows(abs_path: str) -> None:
    r"""Select the file in an Explorer window.

    Asked for twice, and the first way is the one that cannot be misread. The
    shell takes the path as data — no command line, no quoting, nothing to
    parse — which is how Explorer itself, and every native app that offers this
    button, does it.

    The command-line form is only a fallback, because it is fussy in a way that
    is easy to get wrong and impossible to detect: the comma has no space after
    it, and the quotes go around the *path* alone. Handing subprocess a list
    here would produce `explorer "/select,C:\My Photos\a.jpg"` the moment the
    path held a space — the switch swallowed into the quoted string, and an
    Explorer window opening on whatever it opens when it was given no folder it
    understood. So the command line is built here, in one piece, deliberately.
    """
    try:
        _shell_select(abs_path)
        return
    except OSError:
        # Nothing here is worth failing over while a second way remains: the
        # shell call needs COM and a running desktop, and if it could not get
        # them the command line is no worse off.
        pass
    # explorer exits non-zero on success often enough that its return code says
    # nothing, so _run is told to ignore it and we trust the window to open.
    _run(f'explorer.exe /select,"{abs_path}"', check=False)


def _shell_select(abs_path: str) -> None:
    """SHOpenFolderAndSelectItems, which is what the /select switch is a thin
    and lossy wrapper around anyway.

    Raises OSError if the shell will not take it, so the caller can fall back.
    """
    import ctypes
    from ctypes import wintypes

    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32
    # Both return pointers, and a pointer truncated to the default 32-bit int
    # would be a crash rather than an error — so say so explicitly.
    shell32.ILCreateFromPathW.argtypes = [wintypes.LPCWSTR]
    shell32.ILCreateFromPathW.restype = ctypes.c_void_p
    shell32.ILFree.argtypes = [ctypes.c_void_p]
    shell32.ILFree.restype = None
    shell32.SHOpenFolderAndSelectItems.argtypes = [
        ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, wintypes.DWORD,
    ]

    # S_OK and S_FALSE both leave this thread owing a CoUninitialize;
    # RPC_E_CHANGED_MODE means the apartment is someone else's and not ours to
    # tear down. Either way COM is up, which is all the shell call needs.
    hr = ole32.CoInitialize(None)
    owned = hr >= 0
    try:
        pidl = shell32.ILCreateFromPathW(abs_path)
        if not pidl:
            raise OSError(f"the shell does not recognise {abs_path}")
        try:
            # The item's own absolute id list, with no children named after it:
            # that is the documented way to say "open the parent of this and
            # put this one in it selected".
            hr = shell32.SHOpenFolderAndSelectItems(pidl, 0, None, 0)
            if hr < 0:
                raise OSError(f"the shell refused to open the folder "
                              f"(0x{hr & 0xFFFFFFFF:08X})")
        finally:
            shell32.ILFree(pidl)
    finally:
        if owned:
            ole32.CoUninitialize()


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


def _run(cmd: list[str] | str, check: bool = True) -> None:
    # A string is a command line we built ourselves (Windows only, where
    # subprocess hands it to CreateProcess verbatim); a list is the usual
    # argv. Either way the first word is the program, which is all the error
    # messages below need.
    name = cmd.split(" ", 1)[0] if isinstance(cmd, str) else cmd[0]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT, **_NO_WINDOW)
    except FileNotFoundError as e:
        raise RevealError(f"{name} is not available on this system") from e
    except subprocess.TimeoutExpired as e:
        raise RevealError(f"{name} did not respond") from e
    except OSError as e:
        raise RevealError(str(e)) from e
    if check and proc.returncode != 0:
        detail = (proc.stderr or b"").decode(errors="replace").strip()
        raise RevealError(detail or f"{name} exited with {proc.returncode}")
