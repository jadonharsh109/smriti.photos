"""`smriti` — command-line entry point for the installed app."""
import argparse
import os
import shutil
import sys
import threading
import time
import webbrowser


def main() -> None:
    p = argparse.ArgumentParser(
        prog="smriti",
        description="स्मृति Smriti — a fully-offline library for your local photos",
    )
    p.add_argument("--port", type=int, default=8000, help="port to serve on (default 8000)")
    p.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    p.add_argument("--data-dir", help="where the library index lives (default ~/.smriti)")
    p.add_argument("--no-browser", action="store_true", help="don't open the browser on start")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("models", help="download the on-device face-recognition models (~280 MB, one-time)")
    args = p.parse_args()

    if args.data_dir:
        os.environ["SMRITI_DATA_DIR"] = args.data_dir

    from . import config  # reads env at import time — import after env is set

    if args.cmd == "models":
        from . import fetch_models

        fetch_models.download()
        return

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

    url = f"http://{args.host}:{args.port}"
    print(f"स्मृति Smriti — your library at {url}  (data: {config.DATA_DIR})")
    if not args.no_browser:
        threading.Thread(
            target=lambda: (time.sleep(1.2), webbrowser.open(url)), daemon=True
        ).start()
    uvicorn.run(app_main.app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
