"""Generate the app icon from build/app-icon-source.png (blue invoice + magnifier)."""
from PIL import Image, ImageFilter
import os, shutil, subprocess

SRC = os.path.join(os.path.dirname(__file__), 'app-icon-source.png')
BUILD = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BUILD, 'icon-1024.png')
ICONSET = os.path.join(BUILD, 'icon.iconset')

from PIL import ImageDraw

img = Image.open(SRC).convert('RGBA')
w, h = img.size

# Treat the flat white backdrop (connected to the canvas edge) as transparent,
# keeping the white paper that sits inside the blue tile.
flat = Image.new('L', (w, h), 0)
src_px = img.load()
flat_px = flat.load()
for y in range(h):
    for x in range(w):
        r, g, b, _ = src_px[x, y]
        flat_px[x, y] = 255 if min(r, g, b) >= 238 else 0
for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
    ImageDraw.floodfill(flat, corner, 128)
alpha = Image.new('L', (w, h), 255)
alpha_px = alpha.load()
for y in range(h):
    for x in range(w):
        if flat_px[x, y] == 128:
            alpha_px[x, y] = 0
img.putalpha(alpha)
img = img.filter(ImageFilter.GaussianBlur(0.6))

bbox = img.getbbox()
img = img.crop(bbox)
side = max(img.size)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
icon = square.resize((824, 824), Image.LANCZOS)

canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
shadow = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
shadow.paste((8, 16, 34, 110), (100, 108, 924, 932), icon.split()[3])
shadow = shadow.filter(ImageFilter.GaussianBlur(18))
canvas = Image.alpha_composite(canvas, shadow)
canvas.paste(icon, (100, 100), icon)
canvas.save(OUT)

if os.path.isdir(ICONSET):
    shutil.rmtree(ICONSET)
os.makedirs(ICONSET)
for size in (16, 32, 64, 128, 256, 512):
    for scale, suffix in ((1, ''), (2, '@2x')):
        target = size * scale
        resized = canvas.resize((target, target), Image.LANCZOS)
        resized.save(os.path.join(ICONSET, f'icon_{size}x{size}{suffix}.png'))
subprocess.run(['iconutil', '-c', 'icns', ICONSET, '-o', os.path.join(BUILD, 'icon.icns')], check=True)
print('wrote', OUT, 'and icon.icns')
