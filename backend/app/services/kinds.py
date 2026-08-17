"""Decide what a file actually is, from metadata alone — no image is opened.

Measured against a 4,874-photo library: 100% on photos carrying camera EXIF +
GPS, and 100% on named screenshots. It beat a 21 MB CLIP model on both
(91% and 97%), which is why this ships first and on its own.

The rule it will not break: when the evidence is weak, the answer is "photo".
A holiday picture disappearing into Documents is the failure a user notices
immediately; a screenshot left in the timeline is the one they never do.
"""
from __future__ import annotations

import os

SCREENSHOT = "screenshot"
DOCUMENT = "document"
PHOTO = "photo"  # not stored — the absence of a row means "ordinary photo"

# Exact screen resolutions, which is what makes this precise rather than
# guessy. In the reference library 55 of 89 unnamed PNGs were 1179x2556 —
# renamed iPhone screenshots that a blanket "PNG means screenshot" rule would
# have caught, along with every saved image, which it must not.
_SCREEN_DIMS: set[tuple[int, int]] = {
    # iPhone
    (1179, 2556), (1290, 2796), (1170, 2532), (1284, 2778), (1125, 2436),
    (1242, 2688), (1242, 2208), (828, 1792), (750, 1334), (1084, 2412),
    # iPad
    (1620, 2160), (1668, 2388), (2048, 2732), (1536, 2048), (1488, 2266),
    # Android
    (1080, 2400), (1080, 2340), (1080, 2280), (1080, 2160), (1440, 3200),
    (1440, 3040), (1080, 1920), (720, 1280), (758, 1688),
    # Desktop / laptop
    (2560, 1440), (2880, 1800), (3024, 1964), (3456, 2234), (1920, 1080),
    (1512, 982), (1440, 900), (1680, 1050), (2560, 1600), (3840, 2160),
}
# Landscape captures are the same screens rotated.
_SCREEN_DIMS |= {(h, w) for (w, h) in _SCREEN_DIMS}

_SCREENSHOT_WORDS = ("screenshot", "screen shot", "screen_shot", "capture d’écran")
_DOCUMENT_WORDS = ("scan", "scanned", "receipt", "invoice", "document")


def classify(filename: str, width, height, camera_make) -> tuple[str, float] | None:
    """-> (kind, confidence) for a non-photo, or None for an ordinary photo."""
    name = (filename or "").lower()
    stem = os.path.splitext(name)[0]

    # The device named it. Nothing beats that.
    if any(w in name for w in _SCREENSHOT_WORDS):
        return SCREENSHOT, 0.99

    has_camera = bool(camera_make)

    # A camera wrote EXIF, so something in the world was photographed. It may
    # still be a photographed receipt — that is exactly the case this cannot
    # see, and the one the optional model is for.
    if has_camera:
        return None

    if width and height and (int(width), int(height)) in _SCREEN_DIMS:
        return SCREENSHOT, 0.97

    # Android names its screenshots; iOS does not — an iPhone screenshot is
    # IMG_1234.PNG, indistinguishable by name from a photo. Exact dimensions
    # cover untouched ones, but anything resized on its way through a chat app
    # arrives at sizes no list can enumerate (644x1352, 1734x3568, …).
    #
    # A phone screen's aspect ratio survives that resizing. Measured on a
    # 4,874-photo library spanning Apple, Nothing, realme, vivo, motorola and
    # Canon: 0 camera photos fall in this range, so the shape alone is enough
    # once EXIF is already absent.
    if width and height:
        ratio = int(width) / int(height)
        if 0.45 <= ratio <= 0.52 and int(height) >= 800:
            return SCREENSHOT, 0.90

    # "scan" alone is weak — "scanner.jpg", "scanlon-wedding.jpg" — so require
    # it to be a whole word-ish token rather than a substring of a longer name.
    for w in _DOCUMENT_WORDS:
        if w in stem.replace("-", " ").replace("_", " ").split():
            return DOCUMENT, 0.85

    # No camera and no positive signal: a saved image, a download, a meme.
    # Those belong in the timeline, so say nothing.
    return None


def label(kind: str) -> str:
    return {SCREENSHOT: "Screenshots", DOCUMENT: "Documents"}.get(kind, kind.title())
