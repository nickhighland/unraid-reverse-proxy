#!/usr/bin/env python3
"""Renders branding/icon.png from scratch (no image libraries available).

The mark is a routing fork: one line in from the left, splitting to two
endpoints on the right — the same idea as the in-app brand mark.
"""
import math, struct, zlib

SIZE, SS = 256, 3          # output size, supersampling factor
N = SIZE * SS

def lerp(a, b, t): return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

GRAD_A, GRAD_B = (79, 140, 255), (124, 92, 255)
WHITE = (255, 255, 255)

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

# Glyph geometry in 0..1 units.
STROKE = 0.062
SEGMENTS = [
    (0.20, 0.50, 0.44, 0.50),   # trunk
    (0.44, 0.50, 0.60, 0.31),   # upper branch
    (0.60, 0.31, 0.72, 0.31),
    (0.44, 0.50, 0.60, 0.69),   # lower branch
    (0.60, 0.69, 0.72, 0.69),
]
DOTS = [(0.775, 0.31, 0.052), (0.775, 0.69, 0.052)]

def rounded_rect_sdf(x, y, r):
    """Signed distance to a rounded square inset in the unit box."""
    dx, dy = abs(x - 0.5) - (0.5 - r), abs(y - 0.5) - (0.5 - r)
    outside = math.hypot(max(dx, 0), max(dy, 0))
    return outside + min(max(dx, dy), 0) - r

rows = []
for py in range(N):
    row = bytearray()
    for px in range(N):
        x, y = (px + 0.5) / N, (py + 0.5) / N

        if rounded_rect_sdf(x, y, 0.235) > 0:
            row += bytes((0, 0, 0, 0))            # transparent outside the tile
            continue

        base = lerp(GRAD_A, GRAD_B, min(1.0, max(0.0, (x + y) / 2)))

        d = min([seg_dist(x, y, *s) for s in SEGMENTS]
                + [math.hypot(x - cx, y - cy) - cr + STROKE / 2 for cx, cy, cr in DOTS])
        colour = WHITE if d <= STROKE / 2 else base
        row += bytes((int(colour[0]), int(colour[1]), int(colour[2]), 255))
    rows.append(row)

# Box-downsample the supersampled buffer.
out = bytearray()
for y in range(SIZE):
    out.append(0)                                  # PNG filter byte: none
    for x in range(SIZE):
        r = g = b = a = 0
        for sy in range(SS):
            row = rows[y * SS + sy]
            for sx in range(SS):
                i = ((x * SS) + sx) * 4
                r += row[i]; g += row[i+1]; b += row[i+2]; a += row[i+3]
        n = SS * SS
        out += bytes((r // n, g // n, b // n, a // n))

def chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(bytes(out), 9))
       + chunk(b'IEND', b''))

with open('icon.png', 'wb') as fh:
    fh.write(png)
print(f'wrote icon.png ({SIZE}x{SIZE}, {len(png)} bytes)')
