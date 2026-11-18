#!/usr/bin/env python3
"""The Chrome Web Store images, from the screenshots and the app's own icon.

    python3 ext/store/assets.py

Reads `.scratch/store-raw/*.png` (written by `ext/store/shoot.ts`) and
`demo/icon.png`, and writes what the store asks for next to this file:

    icon-128.png                 128x128, the store icon
    screenshot-1-reading.png     1280x800, find box over the paper
    screenshot-2-select.png      1280x800, a line selected as text
    screenshot-3-table.png       1280x800, a table page
    promo-440x280.png            the small promotional tile
    promo-1400x560.png           the marquee promotional tile

Every store image is 24-bit PNG with no alpha: the store rejects a transparent
screenshot, so each one is flattened onto the page's own background colour
before it is saved.
"""

from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RAW = ROOT / ".scratch" / "store-raw"
ICON = ROOT / "demo" / "icon.png"

INK = (14, 16, 20)
INK_BOTTOM = (24, 27, 34)
WHITE = (246, 247, 249)
MUTED = (154, 163, 178)
FAINT = (107, 116, 132)
BLUE = (74, 139, 255)
PAGE = (24, 26, 30)  # the viewer's background, behind every screenshot

INTER = "/usr/share/fonts/inter/InterVariable.ttf"


def font(size: int, weight: str = "Regular") -> ImageFont.FreeTypeFont:
    face = ImageFont.truetype(INTER, size)
    face.set_variation_by_name(weight)
    return face


def background(width: int, height: int) -> Image.Image:
    """The dark field both promo tiles stand on."""
    field = Image.new("RGB", (width, height), INK)
    draw = ImageDraw.Draw(field)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line(
            [(0, y), (width, y)],
            fill=(
                round(INK[0] + (INK_BOTTOM[0] - INK[0]) * t),
                round(INK[1] + (INK_BOTTOM[1] - INK[1]) * t),
                round(INK[2] + (INK_BOTTOM[2] - INK[2]) * t),
            ),
        )
    # One cool light from the top left, where the mark sits.
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse(
        (-width * 0.15, -height * 0.55, width * 0.55, height * 0.6),
        fill=BLUE + (46,),
    )
    field = Image.alpha_composite(field.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(width // 10)))
    return field.convert("RGB")


def centered(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont, width: int, y: int, fill):
    left, top, right, bottom = draw.textbbox((0, 0), text, font=face)
    draw.text(((width - (right - left)) / 2 - left, y), text, font=face, fill=fill)
    return bottom - top


def page_card(size: tuple[int, int], radius: int = 10) -> tuple[Image.Image, Image.Image]:
    """A cropped page of the paper, as a card with a soft shadow."""
    shot = Image.open(RAW / "screenshot-reading.png").convert("RGB")
    page = shot.crop((18, 58, 1262, 800))
    page = page.resize(size, Image.LANCZOS)
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    card = Image.new("RGBA", size, (0, 0, 0, 0))
    card.paste(page, (0, 0), mask)
    return card, mask


def promo_small() -> Image.Image:
    width, height = 440, 280
    tile = background(width, height).convert("RGBA")
    draw = ImageDraw.Draw(tile)

    mark = Image.open(ICON).convert("RGB").resize((56, 56), Image.LANCZOS)
    tile.paste(mark, ((width - 56) // 2, 46))

    wordmark = font(40, "Bold")
    centered(draw, "webPDF", wordmark, width, 118, WHITE)

    tagline = font(16, "Regular")
    centered(draw, "PDFs as SVG, with real text.", tagline, width, 180, MUTED)

    return tile.convert("RGB")


def promo_marquee() -> Image.Image:
    width, height = 1400, 560
    tile = background(width, height).convert("RGBA")
    draw = ImageDraw.Draw(tile)

    # The document, on the right: the product is the page.
    card_size = (470, 300)
    card, mask = page_card(card_size)
    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    s = ImageDraw.Draw(shadow)
    sx, sy = 866, 126
    s.rounded_rectangle(
        (sx + 6, sy + 18, sx + card_size[0] + 6, sy + card_size[1] + 18),
        radius=12,
        fill=(0, 0, 0, 130),
    )
    tile = Image.alpha_composite(tile, shadow.filter(ImageFilter.GaussianBlur(24)))
    draw = ImageDraw.Draw(tile)
    tile.paste(card, (sx, sy), mask)
    draw.rounded_rectangle(
        (sx, sy, sx + card_size[0] - 1, sy + card_size[1] - 1),
        radius=10,
        outline=(255, 255, 255, 38),
        width=1,
    )

    # The mark and the name, top left.
    mark = Image.open(ICON).convert("RGB").resize((76, 76), Image.LANCZOS)
    tile.paste(mark, (84, 88))
    draw.text((180, 96), "webPDF", font=font(54, "Bold"), fill=WHITE)

    draw.text((86, 240), "Every page is SVG.", font=font(62, "SemiBold"), fill=WHITE)
    draw.text(
        (88, 330),
        "Real, selectable text \u2014 search it, copy it,",
        font=font(24, "Regular"),
        fill=MUTED,
    )
    draw.text((88, 366), "and keep the document\u2019s own fonts.", font=font(24, "Regular"), fill=MUTED)

    draw.text((88, 468), "A PDF reader for Chrome", font=font(17, "Medium"), fill=FAINT)

    return tile.convert("RGB")


def screenshot(name: str, out: str) -> None:
    image = Image.open(RAW / name).convert("RGBA")
    if image.size != (1280, 800):
        raise SystemExit(f"{name}: expected 1280x800, got {image.size[0]}x{image.size[1]}")
    flat = Image.new("RGB", image.size, PAGE)
    flat.paste(image, (0, 0), image)
    flat.save(HERE / out, optimize=True)
    print(f"{out}: {flat.size[0]}x{flat.size[1]} {flat.mode}")


def save(image: Image.Image, name: str) -> None:
    image.save(HERE / name, optimize=True)
    print(f"{name}: {image.size[0]}x{image.size[1]} {image.mode}")


def main() -> None:
    if not RAW.is_dir():
        raise SystemExit("no raw screenshots — run `node ext/store/shoot.ts` first (writes .scratch/store-raw)")

    icon = Image.open(ICON).convert("RGB").resize((128, 128), Image.LANCZOS)
    save(icon, "icon-128.png")

    screenshot("screenshot-reading.png", "screenshot-1-reading.png")
    screenshot("screenshot-select.png", "screenshot-2-select.png")
    screenshot("screenshot-table.png", "screenshot-3-table.png")

    save(promo_small(), "promo-440x280.png")
    save(promo_marquee(), "promo-1400x560.png")


if __name__ == "__main__":
    sys.exit(main())
