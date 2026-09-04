#!/usr/bin/env python3
"""Generate the PWA icon set. No imaging libraries needed -- shapes are sampled
analytically with supersampling and written out as PNG via zlib.

    python3 _site/make_icons.py

Writes icons/ next to this script. Re-run only if you change the design.
"""

import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")

BG     = (0x1B, 0x1B, 0x20)
CROSS  = (0xF4, 0xEA, 0xE2)
ORBIT  = (0xD9, 0x9A, 0x6C)

SS = 3  # supersampling factor per axis


# ---------------------------------------------------------------- geometry

def rounded_rect(x, y, r):
    """Point-in-rounded-unit-square (corner radius r, in 0..0.5)."""
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def in_rect(x, y, x0, y0, x1, y1):
    return x0 <= x <= x1 and y0 <= y <= y1


def ellipse_ring(x, y, cx, cy, a, b, angle, half_w):
    """Approximate distance to an ellipse outline, rotated by `angle` radians."""
    dx, dy = x - cx, y - cy
    ca, sa = math.cos(-angle), math.sin(-angle)
    u = dx * ca - dy * sa
    v = dx * sa + dy * ca
    g = (u / a) ** 2 + (v / b) ** 2 - 1.0
    gx, gy = 2 * u / (a * a), 2 * v / (b * b)
    grad = math.hypot(gx, gy)
    if grad < 1e-9:
        return False
    return abs(g) / grad <= half_w


def sample(x, y, mark_scale, full_bleed):
    """Return an RGB colour for a point in the unit square, or None for outside."""
    if not full_bleed and not rounded_rect(x, y, 0.22):
        return None

    # mark coordinates, scaled about the centre
    mx = (x - 0.5) / mark_scale + 0.5
    my = (y - 0.5) / mark_scale + 0.5

    # orbit ring, tilted
    if ellipse_ring(mx, my, 0.5, 0.5, 0.46, 0.205, math.radians(-24), 0.019):
        return ORBIT
    # electron bead riding the orbit
    ang = math.radians(-24)
    bx = 0.5 + 0.46 * math.cos(math.radians(150)) * math.cos(ang) \
             - 0.205 * math.sin(math.radians(150)) * math.sin(ang)
    by = 0.5 + 0.46 * math.cos(math.radians(150)) * math.sin(ang) \
             + 0.205 * math.sin(math.radians(150)) * math.cos(ang)
    if (mx - bx) ** 2 + (my - by) ** 2 <= 0.048 ** 2:
        return ORBIT

    # latin cross
    if in_rect(mx, my, 0.452, 0.175, 0.548, 0.825):
        return CROSS
    if in_rect(mx, my, 0.318, 0.345, 0.682, 0.441):
        return CROSS

    return BG


def render(size, mark_scale, full_bleed):
    rows = []
    inv = 1.0 / (size * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                y = (py * SS + sy + 0.5) * inv
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * inv
                    c = sample(x, y, mark_scale, full_bleed)
                    if c is not None:
                        r += c[0]; g += c[1]; b += c[2]; a += 255
            n = SS * SS
            if a == 0:
                row += b"\x00\x00\x00\x00"
            else:
                cov = a // n
                # un-premultiply against covered samples so edges stay clean
                k = a // 255
                row += bytes((r // k, g // k, b // k, cov))
        rows.append(bytes(row))
    return rows


# -------------------------------------------------------------------- png

def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-192.png",          192, 0.70, False),
        ("icon-512.png",          512, 0.70, False),
        ("icon-maskable-512.png", 512, 0.56, True),   # 40% safe zone for Android
        ("apple-touch-icon.png",  180, 0.74, True),   # iOS applies its own mask
    ]
    for name, size, scale, bleed in jobs:
        rows = render(size, scale, bleed)
        n = write_png(os.path.join(OUT, name), size, rows)
        print(f"  {name:24s} {size}x{size}  {n/1024:6.1f} KB")


if __name__ == "__main__":
    print("Writing icons to", OUT)
    main()
