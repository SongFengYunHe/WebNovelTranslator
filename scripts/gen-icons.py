#!/usr/bin/env python3
"""
Generate placeholder app icons (no external deps):
  resources/icon.png  256x256
  resources/icon.ico  multi-size (16/32/48/64/128/256) PNG-in-ICO
  resources/tray.png  32x32, resources/tray@2x.png 64x64

Design: blue gradient circle + white speech bubble + text lines
("translation" motif). Pure stdlib (struct + zlib).
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'resources')
os.makedirs(OUT_DIR, exist_ok=True)


# ---- vector drawing helpers (all in 256x256 design space) ----

def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 - r <= x <= x1 + r and y0 - r <= y <= y1 + r):
        return False
    in_vert_band = y0 + r <= y <= y1 - r
    in_horiz_band = x0 + r <= x <= x1 - r
    if in_vert_band or in_horiz_band:
        return x0 <= x <= x1 and y0 <= y <= y1
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign((x, y), a, b)
    d2 = sign((x, y), b, c)
    d3 = sign((x, y), c, a)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def pixel_fn(px, py):
    """Return (r, g, b, a) for a point in 256x256 design space."""
    # 1. main circle with blue gradient
    if in_circle(px, py, 128, 128, 118):
        t = math.hypot(px - 128, py - 128) / 118.0
        top = (0x6d, 0x8b, 0xff)
        bot = (0x3b, 0x55, 0xd6)
        r = int(top[0] - (top[0] - bot[0]) * t)
        g = int(top[1] - (top[1] - bot[1]) * t)
        b = int(top[2] - (top[2] - bot[2]) * t)
        color = [r, g, b, 255]
    else:
        return (0, 0, 0, 0)

    # 2. white speech bubble
    if in_round_rect(px, py, 52, 76, 204, 170, 18) or in_triangle(px, py, (60, 160), (110, 172), (78, 212)):
        color = [255, 255, 255, 255]
    # 3. blue text lines inside the bubble
    if (
        in_round_rect(px, py, 64, 96, 192, 110, 7)
        or in_round_rect(px, py, 64, 122, 178, 136, 7)
        or in_round_rect(px, py, 64, 148, 142, 162, 7)
    ):
        color = [0x3b, 0x55, 0xd6, 255]

    return tuple(color)


def render(size, supersample=2):
    """Render the icon at `size`, supersampling for anti-aliasing."""
    big = size * supersample
    scale = big / 256.0
    raw = []
    for y in range(big):
        for x in range(big):
            raw.append(pixel_fn(x / scale, y / scale))
    if supersample == 1:
        return raw
    # box downsample
    out = []
    f = supersample
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(f):
                row = y * f + dy
                for dx in range(f):
                    p = raw[row * big + (x * f + dx)]
                    acc[0] += p[0]
                    acc[1] += p[1]
                    acc[2] += p[2]
                    acc[3] += p[3]
            n = f * f
            out.append((acc[0] // n, acc[1] // n, acc[2] // n, acc[3] // n))
    return out


# ---- PNG encoding ----

def png_chunk(typ, data):
    return (
        struct.pack('>I', len(data))
        + typ
        + data
        + struct.pack('>I', zlib.crc32(typ + data) & 0xFFFFFFFF)
    )


def png_bytes(pixels, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: None
        for x in range(size):
            r, g, b, a = pixels[y * size + x]
            raw += bytes((r, g, b, a))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    return (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', ihdr)
        + png_chunk(b'IDAT', idat)
        + png_chunk(b'IEND', b'')
    )


def write_ico(path, images):
    header = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = []
    datas = []
    for size, data in images:
        wb = 0 if size >= 256 else size
        entries.append(struct.pack('<BBBBHHII', wb, wb, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
        datas.append(data)
    with open(path, 'wb') as f:
        f.write(header)
        for e in entries:
            f.write(e)
        for d in datas:
            f.write(d)


def main():
    # 256x256 PNG (also used as the BrowserWindow icon)
    icon_pixels = render(256)
    icon_path = os.path.join(OUT_DIR, 'icon.png')
    with open(icon_path, 'wb') as f:
        f.write(png_bytes(icon_pixels, 256))

    # Multi-size ICO
    ico_images = []
    for size in (256, 128, 64, 48, 32, 16):
        px = render(size)
        ico_images.append((size, png_bytes(px, size)))
    ico_path = os.path.join(OUT_DIR, 'icon.ico')
    write_ico(ico_path, ico_images)

    # Tray icons
    for size, name in ((64, 'tray@2x.png'), (32, 'tray.png'), (16, 'tray-small.png')):
        px = render(size)
        with open(os.path.join(OUT_DIR, name), 'wb') as f:
            f.write(png_bytes(px, size))

    print('Icons written to', OUT_DIR, ':', os.listdir(OUT_DIR))


if __name__ == '__main__':
    main()
