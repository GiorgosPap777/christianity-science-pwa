#!/usr/bin/env python3
"""Draw the PWA icon set.

    python3 _site/make_icons.py [out_dir]

The icon is a cross with an orbit around it: three electrons, the near half of
the ring passing in front of the cross and the far half behind it. It is drawn
from geometry, not from artwork, so it stays crisp at every size and can be
tweaked by editing the numbers below.

Every shape is a signed distance field (negative inside, in icon units), and a
pixel's coverage is clamp(0.5 - distance / pixel size). That gives exact
antialiasing at any resolution without supersampling. Plain Python only, no
imaging library or ffmpeg. Writes icons/ next to this script by default.
"""

import math
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icons")

# Icon space: (0, 0) is the top-left corner of the full-bleed square, (1, 1)
# the bottom-right.
BG = "#16324d"
CREAM = "#f4ecdc"
GOLD = "#e0a46e"

# Latin cross: centre x, top, bottom, arm height, arm half-length, thickness,
# corner radius.
CROSS = (0.5, 0.16, 0.84, 0.385, 0.215, 0.118, 0.012)

# Orbit ellipse: centre, semi-axes, tilt (degrees, right end up), stroke, and
# the gap cut into the cross where the ring passes in front of it.
ORBIT_C = (0.5, 0.47)
ORBIT_AB = (0.385, 0.135)
ORBIT_TILT = 24.0
ORBIT_W = 0.036
ORBIT_GAP = 0.028

# Electrons, by angle along the ring (0 = right end, counter-clockwise; 180-360
# is the near half). Kept on stretches of the ring that clear the cross.
ELECTRONS = (200.0, 20.0, 290.0)
ELECTRON_R = 0.034

# The rounded-corner icons use the full square. The maskable one shrinks the
# drawing so the orbit stays inside Android's safe zone (a centred circle of
# radius 0.4) whatever mask the launcher applies.
SCALE_MASKABLE = 0.84

CORNER_N = 5.0   # superellipse exponent: |x/r|^n + |y/r|^n <= 1, iOS-ish


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# -------------------------------------------------------------------- shapes

def box(cx, cy, hw, hh, r):
    def d(x, y):
        qx = abs(x - cx) - hw + r
        qy = abs(y - cy) - hh + r
        return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r
    return d


def circle(cx, cy, r):
    return lambda x, y: math.hypot(x - cx, y - cy) - r


def ellipse_dist(xl, yl, a, b):
    """Approximate distance to an axis-aligned ellipse (first-order: the
    implicit function divided by its gradient). Exact on the curve, which is
    all the antialiasing needs."""
    k = math.hypot(xl / a, yl / b)
    if k == 0:
        return -min(a, b)
    return (k - 1.0) * k / math.hypot(xl / (a * a), yl / (b * b))


def design():
    """The layers, back to front: (signed distance, colour)."""
    cx, top, bottom, arm_y, arm_half, t, r = CROSS
    beam = box(cx, (top + bottom) / 2, t / 2, (bottom - top) / 2, r)
    arm = box(cx, arm_y, arm_half, t / 2, r)
    cross = lambda x, y: min(beam(x, y), arm(x, y))

    ox, oy = ORBIT_C
    a, b = ORBIT_AB
    c, s = math.cos(math.radians(ORBIT_TILT)), math.sin(math.radians(ORBIT_TILT))

    def local(x, y):                       # ellipse frame; +y is the near half
        dx, dy = x - ox, y - oy
        return dx * c - dy * s, dx * s + dy * c

    def ring(x, y):
        return abs(ellipse_dist(*local(x, y), a, b)) - ORBIT_W / 2

    def near(x, y):
        xl, yl = local(x, y)
        return max(abs(ellipse_dist(xl, yl, a, b)) - ORBIT_W / 2, -yl)

    def gap(x, y):                         # background-coloured cut, only on the cross
        xl, yl = local(x, y)
        d = max(abs(ellipse_dist(xl, yl, a, b)) - ORBIT_W / 2 - ORBIT_GAP, -yl)
        return max(d, cross(x, y) - ORBIT_GAP - ORBIT_W)

    electrons = []
    for deg in ELECTRONS:
        ex, ey = a * math.cos(math.radians(deg)), -b * math.sin(math.radians(deg))
        electrons.append(circle(ox + ex * c + ey * s, oy - ex * s + ey * c, ELECTRON_R))
    dots = lambda x, y: min(e(x, y) for e in electrons)

    bg, cream, gold = hexrgb(BG), hexrgb(CREAM), hexrgb(GOLD)
    return bg, [(ring, gold), (cross, cream), (gap, bg), (near, gold), (dots, gold)]


# ------------------------------------------------------------------- render

def render(size, scale, rounded):
    """RGB bytes, plus alpha bytes for the rounded-corner variant."""
    bg, layers = design()
    px = 1.0 / (size * scale)              # one pixel, in icon units
    half = size / 2.0
    rgb = bytearray(size * size * 3)
    alpha = bytearray(size * size) if rounded else None
    for py in range(size):
        y = 0.5 + ((py + 0.5) / size - 0.5) / scale
        for qx in range(size):
            x = 0.5 + ((qx + 0.5) / size - 0.5) / scale
            r, g, b = bg
            for f, col in layers:
                cov = 0.5 - f(x, y) / px
                if cov <= 0.0:
                    continue
                cov = min(1.0, cov)
                r += (col[0] - r) * cov
                g += (col[1] - g) * cov
                b += (col[2] - b) * cov
            i = (py * size + qx) * 3
            rgb[i], rgb[i + 1], rgb[i + 2] = int(r + 0.5), int(g + 0.5), int(b + 0.5)
            if rounded:
                # superellipse corners; the implicit function over its gradient
                # is the distance to the edge, in pixels
                u = abs(qx + 0.5 - half) / half
                v = abs(py + 0.5 - half) / half
                m = max(u, v, 1e-6)
                edge = (1.0 - u ** CORNER_N - v ** CORNER_N) * half / (CORNER_N * m ** (CORNER_N - 1))
                alpha[py * size + qx] = int(255 * max(0.0, min(1.0, edge + 0.5)) + 0.5)
    return rgb, alpha


# ----------------------------------------------------------------------- png

def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def filter_rows(data, row, bpp):
    """Per-row PNG filtering (Sub, Up or Paeth, whichever looks smallest by the
    usual sum-of-absolute-differences test). Roughly halves the file size of
    unfiltered artwork."""
    out = []
    prev = bytes(row)
    for y in range(len(data) // row):
        cur = data[y * row:(y + 1) * row]
        cands = []
        sub = bytearray(row)
        up = bytearray(row)
        pa = bytearray(row)
        for i in range(row):
            left = cur[i - bpp] if i >= bpp else 0
            ul = prev[i - bpp] if i >= bpp else 0
            sub[i] = (cur[i] - left) & 0xFF
            up[i] = (cur[i] - prev[i]) & 0xFF
            pa[i] = (cur[i] - paeth(left, prev[i], ul)) & 0xFF
        for ftype, buf in ((1, sub), (2, up), (4, pa)):
            cands.append((sum(v if v < 128 else 256 - v for v in buf), ftype, buf))
        _, ftype, buf = min(cands, key=lambda c: c[0])
        out.append(bytes([ftype]) + bytes(buf))
        prev = cur
    return b"".join(out)


def write_png(path, size, rgb, alpha=None):
    if alpha is None:
        ctype, bpp, data = 2, 3, bytes(rgb)
    else:
        ctype, bpp = 6, 4
        out = bytearray(size * size * 4)
        out[0::4] = rgb[0::3]
        out[1::4] = rgb[1::3]
        out[2::4] = rgb[2::3]
        out[3::4] = alpha
        data = bytes(out)
    raw = filter_rows(data, size * bpp, bpp)

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


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    jobs = [
        # name,                  size, scale,          rounded corners
        ("icon-192.png",          192, 1.0,            True),
        ("icon-512.png",          512, 1.0,            True),
        ("icon-maskable-512.png", 512, SCALE_MASKABLE, False),  # Android masks it
        ("apple-touch-icon.png",  180, 1.0,            False),  # iOS masks it
    ]
    for name, size, scale, rounded in jobs:
        rgb, alpha = render(size, scale, rounded)
        n = write_png(os.path.join(out_dir, name), size, rgb, alpha)
        shape = "rounded" if rounded else "square"
        print(f"  {name:24s} {size}x{size}  {n/1024:6.1f} KB  ({shape}, scale {scale:.0%})")


if __name__ == "__main__":
    out = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else OUT
    print("Writing icons to", out)
    main(out)
