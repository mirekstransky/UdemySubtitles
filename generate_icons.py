"""
Generate minimal solid-color PNG icons for the extension.
No external dependencies – uses only stdlib struct + zlib.
Color: #7c3aed (Udemy-inspired purple)
"""
import struct, zlib, os

def make_png(size, r, g, b):
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

    signature = b'\x89PNG\r\n\x1a\n'
    # IHDR: width, height, bit_depth=8, color_type=2 (RGB), compression=0, filter=0, interlace=0
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    # Image data: one filter byte (none=0) per row + RGB pixels
    row = b'\x00' + bytes([r, g, b]) * size
    raw = row * size
    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return signature + ihdr + idat + iend

os.makedirs('images', exist_ok=True)

for size in [16, 48, 128]:
    data = make_png(size, 0x7c, 0x3a, 0xed)  # #7c3aed
    path = f'images/icon{size}.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'  Created {path} ({size}x{size}px, {len(data)} bytes)')

print('Done.')
