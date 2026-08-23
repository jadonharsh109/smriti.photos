#!/usr/bin/env python3
"""Render website/demo-status.mp4 — a 1080x1920 cut for WhatsApp/Instagram Status.

The demo footage is 2:1, because the app is. Cropping that to 9:16 would throw
away the sidebar, which is the part that shows there is a library here and not
just a photo grid. So the frame is composed instead: the footage sits inset in a
branded canvas with the message above and below it, which is how a vertical
social post is normally built anyway.

Latin-only text, for the same reason as the share card — this Pillow has no
Raqm and cannot shape Devanagari conjuncts, and स्मृति rendered as loose glyphs
would be worse than not rendering it.

    python scripts/make_status_video.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "website" / "demo.mp4"
OUT = ROOT / "website" / "demo-status.mp4"
POSTER = ROOT / "website" / "demo-status.jpg"

W, H = 1080, 1920
VID_W, VID_H = 1000, 485          # the footage, scaled to leave a margin
VID_Y = 735                       # where it sits vertically
LOOPS = 2                         # ~19s, comfortably inside Status' 30s

BG = (7, 10, 20)
FG = (244, 246, 253)
DIM = (167, 174, 198)
SAFFRON = (255, 178, 94)
PINK = (255, 123, 156)
VIOLET = (185, 107, 255)

SANS = "/System/Library/Fonts/Helvetica.ttc"
SERIF_I = "/System/Library/Fonts/Supplemental/Georgia Italic.ttf"


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def brand_gradient(size):
    """Built at 64x64 and scaled up — the ramp is smooth, and looping over a
    million pixels in Python to draw it costs minutes for no visible gain."""
    n = 64
    g = Image.new("RGB", (n, n))
    px = g.load()
    for y in range(n):
        for x in range(n):
            t = (x / (n - 1) + y / (n - 1)) / 2
            px[x, y] = lerp(SAFFRON, PINK, t / 0.52) if t < 0.52 else lerp(PINK, VIOLET, (t - 0.52) / 0.48)
    return g.resize(size, Image.Resampling.BILINEAR)


def glow(canvas, xy, r, color, alpha):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse([xy[0] - r, xy[1] - r, xy[0] + r, xy[1] + r], fill=(*color, alpha))
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(r * 0.55)))


def centred(d, y, text, fnt, fill):
    w = d.textlength(text, font=fnt)
    d.text(((W - w) / 2, y), text, font=fnt, fill=fill)


def gradient_text_centred(canvas, y, text, fnt):
    mask = Image.new("L", canvas.size, 0)
    md = ImageDraw.Draw(mask)
    w = md.textlength(text, font=fnt)
    md.text(((W - w) / 2, y), text, font=fnt, fill=255)
    canvas.alpha_composite(Image.merge("RGBA", (*brand_gradient(canvas.size).split(), mask)))


def logo(size):
    """The app icon, traced from the favicon's own paths."""
    ss = 4
    s = size * ss / 32.0
    img = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    tile = brand_gradient((size * ss, size * ss)).convert("RGBA")
    mask = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle([2 * s, 2 * s, 30 * s, 30 * s], radius=10 * s, fill=255)
    img.paste(tile, (0, 0), mask)

    def cubic(p0, c0, c1, p1, steps=36):
        out = []
        for i in range(steps + 1):
            t = i / steps
            u = 1 - t
            out.append((u**3 * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t**3 * p1[0],
                        u**3 * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t**3 * p1[1]))
        return out

    d = ImageDraw.Draw(img)
    P = lambda pts: [(x * s, y * s) for x, y in pts]  # noqa: E731
    d.polygon(P(cubic((16, 6.6), (18.6, 9.9), (18.6, 14.0), (16, 16.8))
                + cubic((16, 16.8), (13.4, 14.0), (13.4, 9.9), (16, 6.6))), fill=(255, 255, 255, 255))
    d.polygon(P(cubic((9.2, 10.6), (12.7, 11.1), (15.3, 13.5), (15.9, 16.9))
                + cubic((15.9, 16.9), (12.4, 16.6), (9.7, 14.1), (9.2, 10.6))), fill=(255, 255, 255, 209))
    d.polygon(P(cubic((22.8, 10.6), (19.3, 11.1), (16.7, 13.5), (16.1, 16.9))
                + cubic((16.1, 16.9), (19.6, 16.6), (22.3, 14.1), (22.8, 10.6))), fill=(255, 255, 255, 209))
    bowl = cubic((9, 19.2), (11, 21.2), (13.4, 22.2), (16, 22.2)) + cubic((16, 22.2), (18.6, 22.2), (21, 21.2), (23, 19.2))
    d.line(P(bowl), fill=(255, 255, 255, 255), width=max(1, round(1.9 * s)), joint="curve")
    return img.resize((size, size), Image.Resampling.LANCZOS)


def build_background(path: Path) -> None:
    img = Image.new("RGBA", (W, H), (*BG, 255))
    glow(img, (120, 130), 520, (47, 107, 255), 150)
    glow(img, (980, 420), 520, (138, 75, 255), 140)
    glow(img, (540, 1500), 560, (15, 127, 140), 110)
    glow(img, (900, 1850), 420, (198, 91, 30), 95)

    d = ImageDraw.Draw(img)

    mark = logo(112)
    img.alpha_composite(mark, ((W - 112) // 2, 132))

    gradient_text_centred(img, 276, "Smriti", font(SANS, 104, index=1))
    centred(d, 404, "Every memory, lovingly kept.", font(SERIF_I, 40), FG)

    centred(d, 512, "That old hard drive,", font(SANS, 62, index=1), FG)
    centred(d, 588, "finally browsable.", font(SANS, 62, index=1), FG)

    # a soft plate behind the footage, so it reads as inset rather than pasted
    plate = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle(
        [(W - VID_W) // 2 - 10, VID_Y - 10, (W + VID_W) // 2 + 10, VID_Y + VID_H + 10],
        radius=32, fill=(0, 0, 0, 150))
    img.alpha_composite(plate.filter(ImageFilter.GaussianBlur(18)))

    y = VID_Y + VID_H + 92
    centred(d, y, "Timeline · Faces · Places · Trips", font(SANS, 46, index=1), FG)
    centred(d, y + 84, "All computed on your own laptop.", font(SANS, 40), DIM)
    centred(d, y + 142, "No cloud. No account. Nothing uploaded.", font(SANS, 40), DIM)

    d.line([(180, y + 258), (W - 180, y + 258)], fill=(255, 255, 255, 30), width=2)
    centred(d, y + 300, "smriti.jadonharsh.in", font(SANS, 46, index=1), SAFFRON)
    centred(d, y + 372, "Free · macOS & Windows", font(SANS, 36), DIM)

    img.convert("RGB").save(path, "PNG")


def build_mask(path: Path) -> None:
    m = Image.new("L", (VID_W, VID_H), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, VID_W - 1, VID_H - 1], radius=22, fill=255)
    m.save(path, "PNG")


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC} — run the demo recording first", file=sys.stderr)
        return 1
    for f in (SANS, SERIF_I):
        if not os.path.exists(f):
            print(f"missing font: {f}", file=sys.stderr)
            return 1

    with tempfile.TemporaryDirectory() as tmp:
        bg, mask = Path(tmp) / "bg.png", Path(tmp) / "mask.png"
        build_background(bg)
        build_mask(mask)

        graph = (
            f"[1:v]scale={VID_W}:{VID_H},format=rgba[v];"
            f"[2:v]format=gray[m];"
            f"[v][m]alphamerge[va];"
            f"[0:v][va]overlay=(W-w)/2:{VID_Y}[o];"
            f"[o]format=yuv420p[out]"
        )
        src_len = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(SRC)],
            capture_output=True, text=True).stdout.strip())
        total = src_len * LOOPS

        subprocess.run([
            "ffmpeg", "-y", "-v", "error",
            "-loop", "1", "-i", str(bg),
            "-stream_loop", str(LOOPS - 1), "-i", str(SRC),
            "-loop", "1", "-i", str(mask),
            "-filter_complex", graph, "-map", "[out]",
            "-t", f"{total:.3f}", "-r", "30",
            "-c:v", "libx264", "-crf", "24", "-preset", "medium",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(OUT),
        ], check=True)

        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(OUT),
                        "-frames:v", "1", "-q:v", "3", str(POSTER)], check=True)

    size = OUT.stat().st_size / 1024
    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(OUT)],
                         capture_output=True, text=True).stdout.strip()
    print(f"wrote {OUT.relative_to(ROOT)}  {W}x{H}  {float(dur):.1f}s  {size:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
