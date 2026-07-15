#!/usr/bin/env python3
"""Generate a 180×180 teal-circle PNG icon and SVG favicon for the TON Agent."""

import struct, zlib, math, os, sys

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "..", "public")

def make_png(width: int, height: int) -> bytes:
    """Create a valid PNG with a teal gradient circle."""
    raw = bytearray()
    cx, cy = width / 2, height / 2
    outer_r = width / 2 - 2
    inner_r = outer_r * 0.65

    for y in range(height):
        raw.append(0)  # filter byte: None
        for x in range(width):
            dx, dy = x - cx, y - cy
            dist = math.sqrt(dx * dx + dy * dy)
            if dist < outer_r:
                if dist < inner_r:
                    raw.extend([20, 184, 166, 255])  # teal-500
                else:
                    raw.extend([13, 148, 136, 255])  # teal-600
            else:
                raw.extend([0, 0, 0, 0])  # transparent

    compressed = zlib.compress(bytes(raw))

    def chunk(ctype: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + ctype + data
        crc = zlib.crc32(c[4:]) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def make_favicon_svg(size: int = 32) -> str:
    """Return an SVG favicon (teal circle with 'T')."""
    r = size // 2 - 1
    font_size = max(16, size // 2 + 2)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">
  <circle cx="{size//2}" cy="{size//2}" r="{r}" fill="#0d9488"/>
  <circle cx="{size//2}" cy="{size//2}" r="{r-5}" fill="#14b8a6"/>
  <text x="{size//2}" y="{size//2+2}" text-anchor="middle" fill="white"
        font-size="{font_size}" font-weight="bold" font-family="system-ui,sans-serif">T</text>
</svg>'''


def main():
    os.makedirs(PUBLIC_DIR, exist_ok=True)

    # 180×180 PNG
    png180 = make_png(180, 180)
    png_path = os.path.join(PUBLIC_DIR, "icon.png")
    with open(png_path, "wb") as f:
        f.write(png180)
    print(f"✅ {png_path} ({len(png180)} bytes)")

    # 64×64 SVG favicon
    svg = make_favicon_svg(64)
    svg_path = os.path.join(PUBLIC_DIR, "favicon.svg")
    with open(svg_path, "w") as f:
        f.write(svg)
    print(f"✅ {svg_path} ({len(svg)} bytes)")

    # Simple landing-page SVG (full-size)
    big_svg = make_favicon_svg(180)
    big_svg_path = os.path.join(PUBLIC_DIR, "icon.svg")
    with open(big_svg_path, "w") as f:
        f.write(big_svg)
    print(f"✅ {big_svg_path} ({len(big_svg)} bytes)")


if __name__ == "__main__":
    main()
