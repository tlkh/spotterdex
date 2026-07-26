#!/usr/bin/env python3
"""Build transparent monochrome aircraft overlays for the Leaflet map.

The round PNG badges in ``assets/icons/`` are curated raster sources. This
script preserves those badges and derives the light/dark map variants from
their aircraft silhouettes.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "assets" / "icons"
VARIANTS = {
    "dark": (27, 35, 46),
    "light": (242, 247, 252),
}
SOURCE_FAMILIES = ("heavy", "fighter", "light", "medium")


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
    """Draw a compact, proportional helicopter from directly above."""
    size = 192
    center_x, rotor_y = 96, 82
    frame = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Four tapered, semi-translucent rotor blades give motion without turning
    # the aircraft itself into a wide horizontal bar.
    rotor = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rotor_draw = ImageDraw.Draw(rotor)
    for blade in range(4):
        radians = math.radians(angle + blade * 90)
        direction = (math.cos(radians), math.sin(radians))
        perpendicular = (-direction[1], direction[0])
        root, tip = 11, 64
        root_width, tip_width = 3.2, 5.0
        points = []
        for distance, width in ((root, root_width), (tip, tip_width)):
            base_x = center_x + direction[0] * distance
            base_y = rotor_y + direction[1] * distance
            points.append((base_x + perpendicular[0] * width, base_y + perpendicular[1] * width))
        for distance, width in ((tip, tip_width), (root, root_width)):
            base_x = center_x + direction[0] * distance
            base_y = rotor_y + direction[1] * distance
            points.append((base_x - perpendicular[0] * width, base_y - perpendicular[1] * width))
        rotor_draw.polygon(points, fill=(*color, 180))
    frame.alpha_composite(rotor)

    body = ImageDraw.Draw(frame)
    solid = (*color, 255)
    mid = (*color, 220)
    soft = (*color, 170)

    # Nose/cockpit, cabin, and engine shoulders. The silhouette stays narrow
    # beneath the main rotor, closer to a utility helicopter's top view.
    body.polygon(
        ((96, 38), (80, 54), (75, 82), (79, 111), (88, 123), (104, 123), (113, 111), (117, 82), (112, 54)),
        fill=solid,
    )
    body.ellipse((82, 45, 110, 81), fill=mid)
    body.rounded_rectangle((82, 77, 110, 116), radius=11, fill=solid)
    body.line((96, 49, 96, 116), fill=soft, width=2)

    # Slim tail boom, tailplane, and animated tail rotor.
    body.polygon(((89, 113), (103, 113), (100, 166), (92, 166)), fill=solid)
    body.polygon(((92, 161), (100, 161), (104, 175), (96, 181), (88, 175)), fill=mid)
    body.line((80, 153, 112, 153), fill=mid, width=3)
    tail_angle = math.radians(angle * 2.1)
    tail_center = (96, 173)
    tail_dx = math.cos(tail_angle) * 12
    tail_dy = math.sin(tail_angle) * 12
    body.line(
        (tail_center[0] - tail_dx, tail_center[1] - tail_dy, tail_center[0] + tail_dx, tail_center[1] + tail_dy),
        fill=soft,
        width=3,
    )
    body.line(
        (tail_center[0] - tail_dy, tail_center[1] + tail_dx, tail_center[0] + tail_dy, tail_center[1] - tail_dx),
        fill=soft,
        width=3,
    )

    # Rotor mast stays sharp above the animated blade set.
    body.ellipse((89, 75, 103, 89), fill=solid)
    body.ellipse((93, 79, 99, 85), fill=(*color, 120))
    return frame


def transparent_palette(image: Image.Image) -> Image.Image:
    palette = image.convert("P", palette=Image.Palette.ADAPTIVE, colors=255)
    transparent_index = palette.getpixel((0, 0))
    palette.info["transparency"] = transparent_index
    return palette


def write_helicopter_gif(variant: str, color: tuple[int, int, int]) -> None:
    frames = [transparent_palette(draw_helicopter_frame(color, step * 15)) for step in range(12)]
    output = ICON_DIR / f"aircraft-family-helicopter-top-{variant}.gif"
    frames[0].save(
        output,
        save_all=True,
        append_images=frames[1:],
        duration=75,
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
