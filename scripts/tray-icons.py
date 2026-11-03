# Draws the menu bar's play and pause status icons (36px template images, 18pt at 2x) next to
# resources/trayTemplate.png, with the same optical size as its note. Run: python3 scripts/tray-icons.py
from PIL import Image, ImageDraw

S, K = 36, 16  # final size, supersampling factor


def draw(name, shapes):
    big = Image.new('L', (S * K, S * K), 0)
    d = ImageDraw.Draw(big)
    for kind, pts in shapes:
        pts = [(x * K, y * K) for x, y in pts]
        if kind == 'poly':
            d.polygon(pts, fill=255)
        else:
            d.rounded_rectangle([pts[0], pts[1]], radius=1.5 * K, fill=255)
    alpha = big.resize((S, S), Image.LANCZOS)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.putalpha(alpha)
    img.save(f'resources/{name}', optimize=True)


# A play triangle, nudged right of centre so it looks centred.
draw('trayPlayTemplate.png', [('poly', [(10, 6), (10, 30), (29.5, 18)])])
# Two pause bars.
draw('trayPauseTemplate.png', [('rect', [(9, 7), (15.5, 29)]), ('rect', [(20.5, 7), (27, 29)])])
