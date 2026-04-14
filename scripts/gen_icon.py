#!/usr/bin/env python3
"""Generate PDFXS icon: open book on dark background.
No external dependencies — uses only struct + zlib.
"""
import struct, zlib, math, os

# ── Pixel buffer helpers ──────────────────────────────────────────────────────

def make_buf(size):
    return bytearray(size * size * 4)

def px(buf, size, x, y, r, g, b, a=255):
    """Alpha-composite (r,g,b,a) onto buf at (x,y)."""
    if not (0 <= x < size and 0 <= y < size):
        return
    i = (y * size + x) * 4
    fa = a / 255.0
    pr, pg, pb, pa = buf[i], buf[i+1], buf[i+2], buf[i+3]
    ea = pa / 255.0
    na = fa + ea * (1.0 - fa)
    if na > 0:
        buf[i]   = round((r*fa + pr*ea*(1-fa)) / na)
        buf[i+1] = round((g*fa + pg*ea*(1-fa)) / na)
        buf[i+2] = round((b*fa + pb*ea*(1-fa)) / na)
    buf[i+3] = round(na * 255)

def fill_rect(buf, size, x0, y0, w, h, r, g, b, a=255):
    for y in range(max(0, y0), min(size, y0+h)):
        for x in range(max(0, x0), min(size, x0+w)):
            px(buf, size, x, y, r, g, b, a)

def fill_rrect(buf, size, x0, y0, w, h, rad, r, g, b, a=255):
    """Filled rounded rectangle with anti-aliased corners."""
    x1, y1 = x0+w, y0+h
    for y in range(max(0, y0), min(size, y1)):
        for x in range(max(0, x0), min(size, x1)):
            # Determine corner proximity
            cx = cy = None
            if x < x0+rad and y < y0+rad:     cx, cy = x0+rad, y0+rad
            elif x >= x1-rad and y < y0+rad:  cx, cy = x1-rad, y0+rad
            elif x < x0+rad and y >= y1-rad:  cx, cy = x0+rad, y1-rad
            elif x >= x1-rad and y >= y1-rad: cx, cy = x1-rad, y1-rad

            if cx is not None:
                d   = math.hypot(x-cx, y-cy)
                aa  = max(0.0, min(1.0, rad - d + 0.5))
                px(buf, size, x, y, r, g, b, round(a * aa))
            else:
                px(buf, size, x, y, r, g, b, a)

# ── Render icon at given pixel size ──────────────────────────────────────────

def render(size):
    buf = make_buf(size)
    s = size
    def sc(v): return max(1, round(v * s / 256))

    # ── Background ────────────────────────────────────────────────────────────
    # Subtle radial gradient: slightly lighter center
    cx_f, cy_f = s / 2.0, s / 2.0
    for y in range(s):
        for x in range(s):
            d = math.hypot(x - cx_f, y - cy_f) / (s * 0.7)
            d = min(1.0, d)
            rb = round(22 + d * 8)
            gb = round(23 + d * 8)
            bb = round(44 + d * 14)
            buf[(y*s+x)*4]   = rb
            buf[(y*s+x)*4+1] = gb
            buf[(y*s+x)*4+2] = bb
            buf[(y*s+x)*4+3] = 0   # transparent until rounded rect clips it

    fill_rrect(buf, s, 0, 0, s, s, sc(46), 24, 25, 46, 255)

    # ── Book metrics ─────────────────────────────────────────────────────────
    bx0  = sc(46)          # leftmost edge of left page
    bx1  = s - sc(46)      # rightmost edge of right page
    byw  = bx1 - bx0       # total book width
    bcy  = round(s * 0.50) # book vertical center
    bh   = sc(112)         # book height
    by0  = bcy - bh // 2   # book top
    by1  = by0 + bh        # book bottom
    sw   = sc(16)          # spine width
    spx  = s // 2 - sw // 2  # spine left x
    spx2 = spx + sw          # spine right x

    # ── Drop shadow ───────────────────────────────────────────────────────────
    fill_rrect(buf, s, bx0 + sc(4), by0 + sc(8), bx1-bx0, bh, sc(6), 0, 0, 0, 60)

    # ── Left page ─────────────────────────────────────────────────────────────
    PR, PG, PB = 238, 233, 216   # warm cream
    fill_rrect(buf, s, bx0, by0, spx - bx0, bh, sc(4), PR, PG, PB, 255)

    # inner gradient — slightly darker toward spine (depth)
    for x in range(bx0, spx):
        t = (x - bx0) / max(1, spx - bx0 - 1)
        shade = round(8 * (1 - t))
        for y in range(by0, by1):
            px(buf, s, x, y, 0, 0, 0, shade)

    # text lines on left page
    lx0 = bx0 + sc(10)
    lx1 = spx - sc(8)
    for i in range(6):
        ly = by0 + sc(18) + i * sc(16)
        fill_rect(buf, s, lx0, ly, lx1 - lx0, max(1, sc(4)), 175, 170, 152, 210)

    # ── Right page ────────────────────────────────────────────────────────────
    fill_rrect(buf, s, spx2, by0, bx1 - spx2, bh, sc(4), PR, PG, PB, 255)

    # inner gradient — slightly darker toward spine
    for x in range(spx2, bx1):
        t = (bx1 - 1 - x) / max(1, bx1 - spx2 - 1)
        shade = round(8 * (1 - t))
        for y in range(by0, by1):
            px(buf, s, x, y, 0, 0, 0, shade)

    # text lines on right page
    rx0 = spx2 + sc(8)
    rx1 = bx1 - sc(10)
    for i in range(6):
        ly = by0 + sc(18) + i * sc(16)
        fill_rect(buf, s, rx0, ly, rx1 - rx0, max(1, sc(4)), 175, 170, 152, 210)

    # ── Spine ─────────────────────────────────────────────────────────────────
    for y in range(by0, by1):
        t = (y - by0) / max(1, bh - 1)
        sr = round(52 + t * 20)   # 52 → 72
        sg = round(100 + t * 24)  # 100 → 124
        sb = round(228)
        for x in range(spx, spx2):
            px(buf, s, x, y, sr, sg, sb)

    # spine left highlight
    for y in range(by0, by1):
        px(buf, s, spx, y, 140, 185, 255, 160)

    # top edge of spine (lighter)
    for x in range(spx, spx2):
        px(buf, s, x, by0, 150, 195, 255, 200)

    return bytes(buf)

# ── PNG encoder ───────────────────────────────────────────────────────────────

def to_png(buf, size):
    raw = b''
    for y in range(size):
        raw += b'\x00'  # filter: None
        raw += buf[y*size*4:(y+1)*size*4]
    comp = zlib.compress(raw, 9)

    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', comp)
            + chunk(b'IEND', b''))

# ── ICO encoder (embeds PNGs directly — Vista+ format) ────────────────────────

def to_ico(size_list):
    pngs = []
    for sz in size_list:
        img = render(sz)
        pngs.append((sz, to_png(img, sz)))

    n = len(pngs)
    header_size = 6 + n * 16
    offset = header_size

    ico = struct.pack('<HHH', 0, 1, n)
    for sz, png in pngs:
        w = sz if sz < 256 else 0
        h = sz if sz < 256 else 0
        ico += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
    for _, png in pngs:
        ico += png

    return ico

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'build')
    os.makedirs(out_dir, exist_ok=True)

    # Full-resolution PNG
    png = to_png(render(256), 256)
    with open(os.path.join(out_dir, 'icon.png'), 'wb') as f:
        f.write(png)

    # ICO with four sizes
    ico = to_ico([16, 32, 48, 256])
    with open(os.path.join(out_dir, 'icon.ico'), 'wb') as f:
        f.write(ico)

    print(f"icon.png ({len(png):,} bytes) and icon.ico ({len(ico):,} bytes) written to {out_dir}")
