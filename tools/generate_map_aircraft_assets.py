#!/usr/bin/env python3
"""Build transparent monochrome aircraft overlays for the Leaflet map."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "assets" / "icons"
VARIANTS = {
    "dark": (27, 35, 46),
    "light": (242, 247, 252),
}
SOURCE_FAMILIES = ("heavy", "fighter")


def silhouette_mask(source: Image.Image) -> Image.Image:
    """Retain the darker aircraft silhouette and discard the pale round field."""
    rgba = source.convert("RGBA")
    alpha = rgba.getchannel("A")
    mask = Image.new("L", rgba.size)
    source_pixels = rgba.load()
    mask_pixels = mask.load()
    alpha_pixels = alpha.load()

    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, _ = source_pixels[x, y]
            luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
            # The source circles are pale (roughly 220+ luminance); silhouettes are dark.
            opacity = max(0.0, min(1.0, (204.0 - luminance) / 58.0))
            mask_pixels[x, y] = round(alpha_pixels[x, y] * opacity)
    return mask


def write_monochrome_variant(family: str, variant: str, color: tuple[int, int, int]) -> None:
    source = Image.open(ICON_DIR / f"aircraft-family-{family}.png")
    mask = silhouette_mask(source)
    result = Image.new("RGBA", source.size, (*color, 0))
    solid = Image.new("RGBA", source.size, (*color, 255))
    result.alpha_composite(Image.composite(solid, result, mask))
    result.save(ICON_DIR / f"aircraft-family-{family}-{variant}.png", optimize=True)


def draw_helicopter_frame(color: tuple[int, int, int], angle: float) -> Image.Image:
    size = 160
    frame = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    body = ImageDraw.Draw(frame)
    rgba = (*color, 255)

    # Top-down fuselage, tail boom, and tail rotor.
    body.ellipse((54, 44, 106, 111), fill=rgba)
    body.polygon(((70, 103), (90, 103), (87, 149), (73, 149)), fill=rgba)
    body.ellipse((65, 51, 95, 81), fill=(*color, 190))
    body.line((80, 139, 80, 156), fill=rgba, width=4)
    body.line((70, 151, 90, 151), fill=rgba, width=3)

    # Rotor animation: a rotating pair of long top-view blades.
    rotor = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rotor_draw = ImageDraw.Draw(rotor)
    rotor_draw.rounded_rectangle((13, 76, 147, 84), radius=4, fill=(*color, 220))
    rotor = rotor.rotate(angle, resample=Image.Resampling.BICUBIC, center=(80, 80))
    frame.alpha_composite(rotor)
    body = ImageDraw.Draw(frame)
    body.ellipse((73, 73, 87, 87), fill=rgba)
    return frame


def transparent_palette(image: Image.Image) -> Image.Image:
    palette = image.convert("P", palette=Image.Palette.ADAPTIVE, colors=255)
    transparent_index = palette.getpixel((0, 0))
    palette.info["transparency"] = transparent_index
    return palette


def write_helicopter_gif(variant: str, color: tuple[int, int, int]) -> None:
    frames = [transparent_palette(draw_helicopter_frame(color, step * 22.5)) for step in range(8)]
    output = ICON_DIR / f"aircraft-family-helicopter-top-{variant}.gif"
    frames[0].save(
        output,
        save_all=True,
        append_images=frames[1:],
        duration=90,
        loop=0,
        disposal=2,
        transparency=frames[0].info["transparency"],
        optimize=False,
    )


def main() -> None:
    for family in SOURCE_FAMILIES:
        for variant, color in VARIANTS.items():
            write_monochrome_variant(family, variant, color)
    for variant, color in VARIANTS.items():
        write_helicopter_gif(variant, color)


if __name__ == "__main__":
    main()
