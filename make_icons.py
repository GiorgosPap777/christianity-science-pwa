#!/usr/bin/env python3
"""Generate the PWA icon set from the app artwork.

    python3 _site/make_icons.py [out_dir]

The source (icon-source.jpg) is a phone home-screen mockup. Only the rounded
square icon panel is used, and only its emblem: the cross, helix and book. The
lettering under it is unreadable at icon size and duplicates the app name, so
it is painted out:

  1. The panel's background is a smooth gradient. It is fitted with a low-order
     polynomial, sampled only where there is no emblem, lettering or rim.
  2. Each icon is a square window centred on the emblem. Original pixels are
     kept above the lettering and fade into the fitted background (plus a
     little grain, to match the JPEG) everywhere else, so the window can extend
     past the panel's edges and over the old lettering.

ffmpeg does the crop and the high-quality downscale (it is already a project
dependency for ffprobe). Everything else, including the PNG encoding, is
plain Python, so no imaging library is needed. Writes icons/ next to this
script by default.

Re-run only if you change the artwork or the layout below. It takes a few
seconds per icon.
"""

import os
import random
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
P = CROP[0]

# In panel pixels, measured from a brightness profile of the rows and columns.
EMBLEM = (179, 54, 528, 516)          # x0, y0, x1, y1: cross top to book glow
TEXT_ROWS = [(538, 600), (606, 661)]  # the two lines of lettering
CX = 353.0                            # emblem's horizontal centre (= panel's)
CY = (EMBLEM[1] + EMBLEM[3]) / 2.0    # and vertical centre

# Original pixels are kept inside this rounded rectangle and fade to the
# fitted background across FEATHER px. Its bottom edge sits in the clean band
# between the book's glow (row 516) and the lettering (row 543).
KEEP = (22.0, 22.0, 684.0, 530.0)
KEEP_R = 160.0
FEATHER = 10.0
# A longer fade along the top, where the glow above the cross would otherwise
# stop at a visible line. Ends well above the cross (row 54).
TOP_FADE = (18.0, 42.0)

GRAIN = 1.6                           # +/- levels of noise on the fitted areas

# Emblem height as a share of the icon. "any" icons get a tight crop; the
# maskable one leaves room for the circle Android cuts it to (80% safe zone).
FILL_ANY = 0.76
FILL_MASKABLE = 0.58

CORNER_N = 5.0   # superellipse exponent: |x/r|^n + |y/r|^n <= 1, iOS-ish
SS = 4           # vertical supersamples per row, for antialiased corners


def ffmpeg(args, data=None):
    try:
        res = subprocess.run(["ffmpeg", "-v", "error", "-y"] + args,
                             input=data, capture_output=True)
    except FileNotFoundError:
        sys.exit("ffmpeg not found; install it first")
    if res.returncode != 0:
        sys.exit("ffmpeg failed: " + res.stderr.decode(errors="replace"))
    return res.stdout


def panel():
    """The icon panel at full resolution, raw rgb24."""
    if not os.path.exists(SRC):
        sys.exit(f"missing {SRC}")
    w, h, x, y = CROP
    out = ffmpeg(["-i", SRC, "-vf", f"crop={w}:{h}:{x}:{y}",
                  "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    if len(out) != w * h * 3:
        sys.exit("ffmpeg returned an unexpected crop")
    return out


def scale(rgb, src, dst):
    """Lanczos downscale of a square rgb24 image."""
    return bytearray(ffmpeg(
        ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{src}x{src}", "-i", "-",
         "-vf", f"scale={dst}:{dst}:flags=lanczos",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], bytes(rgb)))


# ---------------------------------------------------------------- background

def terms(x, y):
    """Polynomial basis, symmetric about the panel's vertical axis. Clamped so
    the window can reach past the panel without the fit running away."""
    u = max(-1.0, min(1.0, (x - CX) / CX))
    v = max(0.0, min(1.0, y / P))
    u2 = u * u
    v2 = v * v
    return (1.0, v, v2, v2 * v, v2 * v2,
            u2, u2 * v, u2 * v2, u2 * v2 * v,
            u2 * u2, u2 * u2 * v, u2 * u2 * u2)


def in_rounded(x, y, box, r):
    x0, y0, x1, y1 = box
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    dx = max(x0 + r - x, 0.0, x - (x1 - r))
    dy = max(y0 + r - y, 0.0, y - (y1 - r))
    return dx * dx + dy * dy <= r * r


def is_background(x, y):
    if not in_rounded(x, y, (22.0, 22.0, 684.0, 690.0), KEEP_R):
        return False                                   # rim and corners
    if 150 <= x <= 560 and 40 <= y <= 530:
        return False                                   # emblem and its glow
    return not any(a <= y <= b for a, b in TEXT_ROWS)  # lettering


def solve(a, b):
    """Gaussian elimination with partial pivoting; a is n x n, b length n."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(c + 1, n):
            f = m[r][c] / m[c][c]
            for k in range(c, n + 1):
                m[r][k] -= f * m[c][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][k] * x[k] for k in range(r + 1, n))) / m[r][r]
    return x


def fit_background(src):
    """Least-squares fit of the background, one coefficient set per channel."""
    n = len(terms(0, 0))
    ata = [[0.0] * n for _ in range(n)]
    atb = [[0.0] * n for _ in range(3)]
    count = 0
    for y in range(0, P, 3):
        for x in range(0, P, 3):
            if not is_background(x + 0.5, y + 0.5):
                continue
            t = terms(x + 0.5, y + 0.5)
            i = (y * P + x) * 3
            for r in range(n):
                tr = t[r]
                row = ata[r]
                for c in range(n):
                    row[c] += tr * t[c]
                for k in range(3):
                    atb[k][r] += tr * src[i + k]
            count += 1
    coef = [solve(ata, atb[k]) for k in range(3)]
    return coef, count


# ----------------------------------------------------------------- composite

def keep_alpha(x, y):
    """1 inside KEEP, 0 outside, linear across FEATHER px at its edge."""
    x0, y0, x1, y1 = KEEP
    r = KEEP_R
    dx = max(x0 + r - x, 0.0, x - (x1 - r))
    dy = max(y0 + r - y, 0.0, y - (y1 - r))
    if dx > 0 and dy > 0:
        d = (dx * dx + dy * dy) ** 0.5 - r     # distance outside the corner arc
    else:
        d = max(x0 - x, x - x1, y0 - y, y - y1)
    a = max(0.0, min(1.0, 0.5 - d / FEATHER))
    return min(a, max(0.0, min(1.0, (y - TOP_FADE[0]) / (TOP_FADE[1] - TOP_FADE[0]))))


def window(src, coef, fill):
    """A square of panel pixels centred on the emblem, sized so the emblem is
    `fill` of its height; returns (side, rgb24)."""
    side = int(round((EMBLEM[3] - EMBLEM[1]) / fill))
    ox = int(round(CX - side / 2.0))
    oy = int(round(CY - side / 2.0))
    rnd = random.Random(1)                    # same grain on every run
    out = bytearray(side * side * 3)
    for j in range(side):
        y = oy + j
        for i in range(side):
            x = ox + i
            a = keep_alpha(x + 0.5, y + 0.5) if 0 <= x < P and 0 <= y < P else 0.0
            d = (j * side + i) * 3
            if a >= 1.0:
                s = (y * P + x) * 3
                out[d:d + 3] = src[s:s + 3]
                continue
            t = terms(x + 0.5, y + 0.5)
            g = rnd.uniform(-GRAIN, GRAIN)
            s = (y * P + x) * 3
            for k in range(3):
                bg = sum(c * v for c, v in zip(coef[k], t)) + g
                v = src[s + k] * a + bg * (1.0 - a) if a > 0 else bg
                out[d + k] = max(0, min(255, int(round(v))))
    return side, out


# --------------------------------------------------------------------- shape

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
    src = panel()
    coef, n = fit_background(src)
    print(f"  background fitted from {n} samples")

    windows = {}
    jobs = [
        # name,                  size, emblem fill,    rounded corners
        ("icon-192.png",          192, FILL_ANY,       True),
        ("icon-512.png",          512, FILL_ANY,       True),
        ("icon-maskable-512.png", 512, FILL_MASKABLE,  False),  # Android masks it
        ("apple-touch-icon.png",  180, FILL_ANY,       False),  # iOS masks it
    ]
    for name, size, fill, rounded in jobs:
        if fill not in windows:
            windows[fill] = window(src, coef, fill)
        side, art = windows[fill]
        rgb = scale(art, side, size)
        alpha = squircle_alpha(size) if rounded else None
        n = write_png(os.path.join(out_dir, name), size, rgb, alpha)
        shape = "rounded" if rounded else "square"
        print(f"  {name:24s} {size}x{size}  {n/1024:6.1f} KB  ({shape}, emblem {fill:.0%})")


if __name__ == "__main__":
    out = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else OUT
    print("Writing icons to", out)
    main(out)
