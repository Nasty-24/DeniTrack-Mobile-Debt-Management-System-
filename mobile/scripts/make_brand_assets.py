"""Generate the DeniTrack splash-screen image (assets/splash-icon.png).

    python mobile/scripts/make_brand_assets.py

Mark: a bold white "D" over a short mint "ledger line" on a deep-green rounded tile.
It is used only on the splash screen; the app icon is a separate asset and is not touched.
Drawn at 4x and downscaled for smooth edges. Requires Pillow and a bold sans-serif TTF
(Segoe UI Bold on Windows; pass another path as the first argument elsewhere).
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GREEN = (31, 95, 67, 255)  # colors.brand  #1F5F43
MINT = (143, 209, 174, 255)  # ledger-line accent
WHITE = (255, 255, 255, 255)
SS = 4  # supersampling factor

FONT = sys.argv[1] if len(sys.argv) > 1 else "C:/Windows/Fonts/segoeuib.ttf"
OUT = Path(__file__).resolve().parents[1] / "assets"


def mark(size: int, *, tile: float | None, glyph_h: float, fg=WHITE, accent=MINT, bg=(0, 0, 0, 0)) -> Image.Image:
    """Draw the mark on a square canvas.

    tile:    tile edge as a fraction of the canvas (None = no tile, e.g. adaptive foreground)
    glyph_h: height of the "D" as a fraction of the canvas
    """
    S = size * SS
    im = Image.new("RGBA", (S, S), bg)
    d = ImageDraw.Draw(im)
    if tile:
        t = S * tile
        o = (S - t) / 2
        d.rounded_rectangle([o, o, o + t, o + t], radius=t * 0.24, fill=GREEN)

    target_h = S * glyph_h
    font = ImageFont.truetype(FONT, size=int(target_h * 1.38))
    l, top, r, bottom = d.textbbox((0, 0), "D", font=font)
    gw, gh = r - l, bottom - top
    line_h = target_h * 0.11
    gap = target_h * 0.14
    total_h = gh + gap + line_h
    x = (S - gw) / 2 - l
    y = (S - total_h) / 2 - top
    d.text((x, y), "D", font=font, fill=fg)
    ly = y + top + gh + gap
    lw = gw * 0.78
    lx = (S - lw) / 2
    d.rounded_rectangle([lx, ly, lx + lw, ly + line_h], radius=line_h / 2, fill=accent)
    return im.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    # Splash only: the tile on transparency, sized to sit inside Android 12's circular icon mask.
    mark(1024, tile=0.62, glyph_h=0.26).save(OUT / "splash-icon.png")
    print("Wrote", OUT / "splash-icon.png")


if __name__ == "__main__":
    main()
