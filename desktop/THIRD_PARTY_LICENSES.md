# Third-party components bundled in Smriti Desktop

Smriti itself is the work in this repository. The desktop app additionally
*distributes* the unmodified third-party binaries below. This file exists to
satisfy their redistribution terms.

## FFmpeg (ffmpeg, ffprobe)

- **Bundled at**: `Smriti.app/Contents/Resources/bin/{ffmpeg,ffprobe}`
- **Build**: macOS arm64 static, `1785863997_9.0` from <https://ffmpeg.martin-riedl.de/>
- **Version**: 9.0
- **Licence**: **GPL v3** — the build is configured with `--enable-gpl
  --enable-version3`. It is *not* `--enable-nonfree`, so it is redistributable.
- **Source**: <https://github.com/FFmpeg/FFmpeg> at the tag corresponding to
  release 9.0. The build server publishes its exact configure line via
  `ffmpeg -version`; the bundled binary reports it verbatim.
- **Written offer**: for a copy of the corresponding source, open an issue at
  <https://github.com/jadonharsh109/smriti.photos>.

Smriti invokes these binaries as **separate processes** (`subprocess.run` in
`backend/app/workers/video_worker.py`) and never links against FFmpeg's
libraries, so the application itself is not a derivative work. Distributing the
GPL binary alongside it still carries the source-availability obligation above.

> **Planned change.** The app uses FFmpeg for exactly two things: `ffprobe
> -show_format -show_streams`, and extracting one scaled keyframe as JPEG. A
> minimal `--disable-everything` LGPL build covering only the formats in
> `config.PHOTO_EXTS` / `config.VIDEO_EXTS` plus the `scale` filter and `mjpeg`
> encoder lands around 8-15 MB instead of 126 MB, and removes the GPL obligation
> entirely. Tracked as a follow-up.

### Rejected sources

`github.com/eugeneware/ffmpeg-static` (b6.1.1) builds with `--enable-nonfree`,
which makes the binary **undistributable under any licence**. `fetch_ffmpeg.py`
checks every downloaded binary's configure flags and reports this, so it cannot
be shipped by accident.

## CPython

- **Bundled at**: `Smriti.app/Contents/Resources/runtime/`
- **Build**: `cpython-3.12.14+20260814` from
  <https://github.com/astral-sh/python-build-standalone>
- **Licence**: Python Software Foundation License 2.0

Python packages installed into that runtime keep their own licences; each ships
its `*.dist-info/` metadata inside the bundle (the build deliberately does not
prune those).

## Face-recognition models

The InsightFace `buffalo_l` models (`det_10g.onnx`, `w600k_r50.onnx`) are **not
bundled**. They are downloaded on request into the user's data directory and are
licensed for non-commercial research use by their authors.
