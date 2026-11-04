"""Build the splash-screen image (assets/splash-icon.png) from the app icon (assets/icon.png).

    python mobile/scripts/make_splash.py

The icon is drawn as a rounded tile, the way launchers show it, on a transparent canvas
and sized to sit inside Android 12's circular splash mask. Re-run this whenever icon.png
changes so the splash always matches the app icon. Requires Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parents[1] / "assets"
CANVAS = 1024
TILE = 0.62  # tile edge as a fraction of the canvas (fits inside the circular mask)
RADIUS = 0.22  # corner radius as a fraction of the tile
SS = 4  # supersampling for smooth corners


def main() -> None:
    icon = Image.open(ASSETS / "icon.png").convert("RGBA")
    tile = round(CANVAS * TILE)
    big = tile * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=big * RADIUS, fill=255)
    mask = mask.resize((tile, tile), Image.LANCZOS)

    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = (CANVAS - tile) // 2
    out.paste(icon.resize((tile, tile), Image.LANCZOS), (offset, offset), mask)
    out.save(ASSETS / "splash-icon.png")
    print("Wrote", ASSETS / "splash-icon.png")


if __name__ == "__main__":
    main()
