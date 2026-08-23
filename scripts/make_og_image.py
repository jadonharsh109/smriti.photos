#!/usr/bin/env python3
"""Render website/og.png — the 1200x630 card that Slack, X, WhatsApp and
LinkedIn show when someone shares the site.

Kept as a script rather than a one-off export so the card can be regenerated
when the wording changes, and so the thing that produced it is reviewable.

Deliberately Latin-only. Pillow shapes text with Raqm when it is available and
this machine's build has none, which leaves Devanagari conjuncts —
स् + मृ — rendered as loose glyphs. A wordmark that is subtly wrong in the one
image most people see first is worse than one that is only English, so the
Devanagari lives on the page itself, where the browser shapes it properly.

    python scripts/make_og_image.py
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "website" / "og.png"
W, H = 1200, 630

BG = (7, 10, 20)
FG = (244, 246, 253)
DIM = (167, 174, 198)
SAFFRON = (255, 178, 94)
PINK = (255, 123, 156)
VIOLET = (185, 107, 255)

SANS = "/System/Library/Fonts/Helvetica.ttc"
SERIF = "/System/Library/Fonts/Supplemental/Georgia Italic.ttf"
SERIF_FALLBACK = "/System/Library/Fonts/Supplemental/Georgia.ttf"


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def brand_gradient(size: tuple[int, int]) -> Image.Image:
    """The app's saffron -> pink -> violet ramp, on the 135deg diagonal."""
    w, h = size
    g = Image.new("RGB", (w, h))
    px = g.load()
    for y in range(h):
        for x in range(w):
            t = (x / max(w - 1, 1) + y / max(h - 1, 1)) / 2
            px[x, y] = lerp(SAFFRON, PINK, t / 0.52) if t < 0.52 else lerp(PINK, VIOLET, (t - 0.52) / 0.48)
    return g


def glow(canvas: Image.Image, xy, r, color, alpha):
    """One aurora blob, blurred the way the site blurs its own."""
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse([xy[0] - r, xy[1] - r, xy[0] + r, xy[1] + r], fill=(*color, alpha))
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(r * 0.55)))


# ---------------------------------------------------------------- the lotus
def cubic(p0, c0, c1, p1, steps=36):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((
            u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
            u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1],
        ))
    return out


def logo(size: int) -> Image.Image:
    """The app's icon, traced from the same SVG the favicon uses, at `size`px.
    Drawn at 4x and downsampled — Pillow has no antialiased polygon fill."""
    ss = 4
    s = size * ss / 32.0          # the SVG's own viewBox is 32x32
    img = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))

    tile = brand_gradient((size * ss, size * ss)).convert("RGBA")
    mask = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle([2 * s, 2 * s, 30 * s, 30 * s], radius=10 * s, fill=255)
    img.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(img)
    P = lambda pts: [(x * s, y * s) for x, y in pts]  # noqa: E731

    # centre petal
    d.polygon(P(cubic((16, 6.6), (18.6, 9.9), (18.6, 14.0), (16, 16.8))
                + cubic((16, 16.8), (13.4, 14.0), (13.4, 9.9), (16, 6.6))), fill=(255, 255, 255, 255))
    # the two side petals
    d.polygon(P(cubic((9.2, 10.6), (12.7, 11.1), (15.3, 13.5), (15.9, 16.9))
                + cubic((15.9, 16.9), (12.4, 16.6), (9.7, 14.1), (9.2, 10.6))), fill=(255, 255, 255, 209))
    d.polygon(P(cubic((22.8, 10.6), (19.3, 11.1), (16.7, 13.5), (16.1, 16.9))
                + cubic((16.1, 16.9), (19.6, 16.6), (22.3, 14.1), (22.8, 10.6))), fill=(255, 255, 255, 209))
    # the bowl beneath, a stroke rather than a fill
    bowl = cubic((9, 19.2), (11, 21.2), (13.4, 22.2), (16, 22.2)) + cubic((16, 22.2), (18.6, 22.2), (21, 21.2), (23, 19.2))
    d.line(P(bowl), fill=(255, 255, 255, 255), width=max(1, round(1.9 * s)), joint="curve")

    return img.resize((size, size), Image.Resampling.LANCZOS)


def gradient_text(canvas: Image.Image, xy, text, fnt):
    """Paint text with the brand ramp by using the glyphs as a mask."""
    box = canvas.size
    mask = Image.new("L", box, 0)
    ImageDraw.Draw(mask).text(xy, text, font=fnt, fill=255)
    canvas.alpha_composite(Image.merge("RGBA", (*brand_gradient(box).split(), mask)))


def main() -> None:
    for f in (SANS, SERIF if os.path.exists(SERIF) else SERIF_FALLBACK):
        if not os.path.exists(f):
            raise SystemExit(f"missing font: {f}")

    img = Image.new("RGBA", (W, H), (*BG, 255))
    glow(img, (120, -40), 380, (47, 107, 255), 150)
    glow(img, (1150, 120), 400, (138, 75, 255), 140)
    glow(img, (980, 700), 360, (15, 127, 140), 120)
    glow(img, (300, 690), 320, (198, 91, 30), 90)

    d = ImageDraw.Draw(img)

    mark = logo(104)
    img.alpha_composite(mark, (84, 74))

    f_word = font(SANS, 132, index=1)      # Helvetica Bold
    f_lede = font(SANS, 37)
    f_tag = font(SERIF if os.path.exists(SERIF) else SERIF_FALLBACK, 33)
    f_foot = font(SANS, 27)

    gradient_text(img, (84, 214), "Smriti", f_word)
    d.text((84, 372), "Every memory, lovingly kept.", font=f_tag, fill=FG)
    d.text((84, 436), "A photo library that never leaves your machine.", font=f_lede, fill=DIM)

    d.line([(84, 528), (1116, 528)], fill=(255, 255, 255, 26), width=2)
    d.text((84, 552), "smriti.jadonharsh.in", font=f_foot, fill=SAFFRON)
    right = "Local-first  ·  No cloud  ·  Open source"
    d.text((1116 - d.textlength(right, font=f_foot), 552), right, font=f_foot, fill=DIM)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)}  {OUT.stat().st_size / 1024:.0f} KB  {W}x{H}")


if __name__ == "__main__":
    main()
