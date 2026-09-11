#!/usr/bin/env python3
"""Generate the PWA icon set from the app artwork.

    python3 _site/make_icons.py

The source (icon-source.jpg) is a phone home-screen mockup; only the rounded
square icon panel is kept, so none of the mockup background survives. ffmpeg
does the crop and the high-quality downscale (it is already a project
dependency for ffprobe); the PNGs are encoded here with zlib, so no imaging
library is needed. Writes icons/ next to this script.

Re-run only if you change the artwork or the crop.
"""

import os
import struct
import subprocess
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "icon-source.jpg")
OUT = os.path.join(HERE, "icons")

# The icon panel inside the 1024x1024 mockup: width, height, x, y.
# Measured from the panel's bright rim, not eyeballed.
CROP = (706, 706, 162, 182)

# Flat colour behind the artwork on full-bleed icons, sampled from the panel.
PANEL_BG = (0x10, 0x42, 0x6E)

CORNER_N = 5.0   # superellipse exponent: |x/r|^n + |y/r|^n <= 1, iOS-ish
SS = 4           # vertical supersamples per row, for antialiased corners


def artwork(size):
    """Crop the panel out of the mockup and scale it to size; raw rgb24."""
    if not os.path.exists(SRC):
        sys.exit(f"missing {SRC}")
    w, h, x, y = CROP
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", SRC,
         "-vf", f"crop={w}:{h}:{x}:{y},scale={size}:{size}:flags=lanczos",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True).stdout
    if len(out) != size * size * 3:
        sys.exit("ffmpeg failed; is it installed?")
    return bytearray(out)


def flatten(size, scale):
    """Artwork at `scale` of the canvas, rounded, composited on the panel colour.

    Used for the icons that must stay opaque. Rounding before compositing keeps
    the mockup's neighbouring app icons from surviving in the corners; the
    inset leaves a safe zone for the circular mask Android applies.
    """
    inner = max(1, int(round(size * scale)))
    art = artwork(inner)
    mask = squircle_alpha(inner)
    off = (size - inner) // 2
    canvas = bytearray(PANEL_BG * (size * size))
    for row in range(inner):
        for col in range(inner):
            a = mask[row * inner + col]
            if a == 0:
                continue
            s = (row * inner + col) * 3
            d = ((row + off) * size + col + off) * 3
            if a == 255:
                canvas[d:d + 3] = art[s:s + 3]
            else:
                for k in range(3):
                    canvas[d + k] = (art[s + k] * a + canvas[d + k] * (255 - a)) // 255
    return canvas


def squircle_alpha(size):
    """Antialiased coverage mask for the rounded-square corners."""
    r = size / 2.0
    a = bytearray(size * size)
    for py in range(size):
        cov = [0.0] * size
        for s in range(SS):
            dy = abs((py + (s + 0.5) / SS) - r)
            tt = 1.0 - (dy / r) ** CORNER_N
            xlim = r * (tt ** (1.0 / CORNER_N)) if tt > 0 else 0.0
            for px in range(size):
                dx = abs((px + 0.5) - r)
                cov[px] += min(1.0, max(0.0, xlim - dx + 0.5))
        base = py * size
        for px in range(size):
            a[base + px] = int(round(255 * cov[px] / SS))
    return a


def write_png(path, size, rgb, alpha=None):
    if alpha is None:
        ctype, bpp, data = 2, 3, bytes(rgb)
    else:
        ctype, bpp = 6, 4
        out = bytearray(size * size * 4)
        for i in range(size * size):
            out[i * 4:i * 4 + 3] = rgb[i * 3:i * 3 + 3]
            out[i * 4 + 3] = alpha[i]
        data = bytes(out)
    row = size * bpp
    raw = b"".join(b"\x00" + data[y * row:(y + 1) * row] for y in range(size))

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload +
                struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n" +
           chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, ctype, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(raw, 9)) +
           chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        # name,                  size, rounded, inset scale
        ("icon-192.png",          192, True,  None),
        ("icon-512.png",          512, True,  None),
        ("icon-maskable-512.png", 512, False, 0.76),  # safe zone for Android
        ("apple-touch-icon.png",  180, False, 1.00),  # iOS applies its own mask
    ]
    for name, size, rounded, scale in jobs:
        rgb = flatten(size, scale) if scale else artwork(size)
        alpha = squircle_alpha(size) if rounded else None
        n = write_png(os.path.join(OUT, name), size, rgb, alpha)
        shape = "rounded" if rounded else ("inset" if scale < 1 else "square")
        print(f"  {name:24s} {size}x{size}  {n/1024:6.1f} KB  ({shape})")


if __name__ == "__main__":
    print("Writing icons to", OUT)
    main()
