"""Writes the "now playing" equaliser GIF used in track lists.

An animated GIF instead of a CSS animation, like Spotify: the GPU then redraws the bars 12 times a
second instead of 60, which matters because they sit inside a rounded-corner clip that is
recomposited every frame. Usage: python3 scripts/equaliser-gif.py src/renderer/src/assets/equaliser.gif
"""
import math, struct, sys

W, H, SCALE = 13, 14, 2           # CSS px; drawn at 2x for retina
BAR, GAP = 3, 2
FRAMES, DELAY_CS = 24, 8          # 24 frames x 80 ms = 1.92 s cycle, 12.5 fps
GREEN = (0x1E, 0xD7, 0x60)

def lzw(pixels, min_size=2):
    clear, eoi = 1 << min_size, (1 << min_size) + 1
    out, bits, nbits = bytearray(), 0, 0
    size = min_size + 1
    def emit(code):
        nonlocal bits, nbits
        bits |= code << nbits; nbits += size
        while nbits >= 8:
            out.append(bits & 0xFF); bits >>= 8; nbits -= 8
    table = {(i,): i for i in range(clear)}
    nxt = eoi + 1
    emit(clear)
    cur = (pixels[0],)
    for p in pixels[1:]:
        key = cur + (p,)
        if key in table:
            cur = key; continue
        emit(table[cur])
        if nxt < 4096:
            table[key] = nxt; nxt += 1
            if nxt > (1 << size) and size < 12: size += 1
        else:
            emit(clear); table = {(i,): i for i in range(clear)}; nxt = eoi + 1; size = min_size + 1
        cur = (p,)
    emit(table[cur]); emit(eoi)
    if nbits: out.append(bits & 0xFF)
    return bytes(out)

def frame(f):
    w, h = W * SCALE, H * SCALE
    px = [0] * (w * h)
    for b in range(3):
        level = 0.5 + 0.5 * math.sin(2 * math.pi * f / FRAMES + b * 2.1)
        bh = round((3 + 11 * level) * SCALE)
        x0 = b * (BAR + GAP) * SCALE
        for y in range(h - bh, h):
            for x in range(x0, x0 + BAR * SCALE):
                px[y * w + x] = 1
    return px

w, h = W * SCALE, H * SCALE
gif = bytearray(b'GIF89a' + struct.pack('<HHBBB', w, h, 0xF1, 0, 0))   # global palette, 4 entries
gif += bytes([0, 0, 0]) + bytes(GREEN) + bytes(6)
gif += b'\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00'                  # loop forever
for f in range(FRAMES):
    gif += b'\x21\xF9\x04' + bytes([0x09]) + struct.pack('<H', DELAY_CS) + b'\x00\x00'  # dispose to bg, transparent idx 0
    gif += b'\x2C' + struct.pack('<HHHHB', 0, 0, w, h, 0)
    data = lzw(frame(f))
    gif += b'\x02'
    for i in range(0, len(data), 255):
        chunk = data[i:i + 255]; gif += bytes([len(chunk)]) + chunk
    gif += b'\x00'
gif += b'\x3B'
open(sys.argv[1], 'wb').write(gif)
print(len(gif), 'bytes')
