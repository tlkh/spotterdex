#!/usr/bin/env python3
"""Build and verify SpotterDex's deterministic Apple web-app assets."""

from __future__ import annotations

import argparse
import io
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Tuple

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing Pillow. Install with: python3 -m pip install -r requirements.txt") from exc


LAUNCH_BACKGROUND = "#11100f"
LAUNCH_BACKGROUND_RGB = (17, 16, 15)
STARTUP_ASSET_VERSION = "v1"
STARTUP_MARK_FRACTION = 0.22

# Apple web-app startup-image sizes, last reconciled against the skill's device
# table on 2026-09-04. Keep this as the single source for both generated PNGs
# and the media queries emitted into every installable page.
IOS_DEVICE_TRIPLES: Tuple[Tuple[int, int, int], ...] = (
    (320, 568, 2),
    (375, 667, 2),
    (414, 736, 3),
    (375, 812, 3),
    (414, 896, 2),
    (414, 896, 3),
    (390, 844, 3),
    (428, 926, 3),
    (393, 852, 3),
    (430, 932, 3),
    (402, 874, 3),
    (440, 956, 3),
    (420, 912, 3),
    (768, 1024, 2),
    (810, 1080, 2),
    (820, 1180, 2),
    (744, 1133, 2),
    (834, 1112, 2),
    (834, 1194, 2),
    (834, 1210, 2),
    (1024, 1366, 2),
    (1032, 1376, 2),
)


@dataclass(frozen=True)
class StartupAsset:
    width_points: int
    height_points: int
    dpr: int
    orientation: str

    @property
    def filename(self) -> str:
        return (
            f"spotterdex-startup-{self.width_points}x{self.height_points}"
            f"@{self.dpr}x-{self.orientation}.png"
        )

    @property
    def pixel_size(self) -> Tuple[int, int]:
        width, height = self.width_points, self.height_points
        if self.orientation == "landscape":
            width, height = height, width
        return width * self.dpr, height * self.dpr

    @property
    def media_query(self) -> str:
        width, height = self.width_points, self.height_points
        if self.orientation == "landscape":
            width, height = height, width
        return (
            f"(device-width: {width}px) and (device-height: {height}px) "
            f"and (-webkit-device-pixel-ratio: {self.dpr}) "
            f"and (orientation: {self.orientation})"
        )


def startup_assets() -> Tuple[StartupAsset, ...]:
    return tuple(
        StartupAsset(width, height, dpr, orientation)
        for width, height, dpr in IOS_DEVICE_TRIPLES
        for orientation in ("portrait", "landscape")
    )


def render_startup_links(indent: str = "    ") -> str:
    return "\n".join(
        f'{indent}<link rel="apple-touch-startup-image" '
        f'href="assets/generated/startup/{asset.filename}?{STARTUP_ASSET_VERSION}" '
        f'media="{asset.media_query}">'
        for asset in startup_assets()
    )


def _png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True, compress_level=9)
    return output.getvalue()


def _write_if_changed(path: Path, payload: bytes) -> bool:
    if path.exists() and path.read_bytes() == payload:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return True


def _png_pixels_match(actual: bytes, expected: bytes) -> bool:
    """Compare decoded PNG content without depending on zlib's byte stream."""
    if actual == expected:
        return True
    try:
        with Image.open(io.BytesIO(actual)) as actual_image, Image.open(
            io.BytesIO(expected)
        ) as expected_image:
            actual_image.load()
            expected_image.load()
            return (
                actual_image.format == expected_image.format == "PNG"
                and actual_image.mode == expected_image.mode
                and actual_image.size == expected_image.size
                and actual_image.tobytes() == expected_image.tobytes()
            )
    except (OSError, ValueError):
        return False


def _resized(image: Image.Image, size: Tuple[int, int]) -> Image.Image:
    resized = image.resize(size, Image.Resampling.LANCZOS).convert("RGB")
    pixels = resized.load()
    for x in range(resized.width):
        pixels[x, 0] = LAUNCH_BACKGROUND_RGB
        pixels[x, resized.height - 1] = LAUNCH_BACKGROUND_RGB
    for y in range(resized.height):
        pixels[0, y] = LAUNCH_BACKGROUND_RGB
        pixels[resized.width - 1, y] = LAUNCH_BACKGROUND_RGB
    return resized


def _render_maskable(master: Image.Image) -> Image.Image:
    canvas = Image.new("RGB", (512, 512), LAUNCH_BACKGROUND_RGB)
    # The artwork occupies 66% of the canvas, comfortably inside the central
    # maskable-icon safe zone even for aggressive circular platform masks.
    mark = _resized(master, (338, 338))
    canvas.paste(mark, ((512 - mark.width) // 2, (512 - mark.height) // 2))
    return canvas


def _render_startup(master: Image.Image, asset: StartupAsset) -> Image.Image:
    canvas = Image.new("RGB", asset.pixel_size, LAUNCH_BACKGROUND_RGB)
    shortest_edge = min(asset.pixel_size)
    mark_edge = max(1, round(shortest_edge * STARTUP_MARK_FRACTION))
    mark = _resized(master, (mark_edge, mark_edge))
    canvas.paste(mark, ((canvas.width - mark_edge) // 2, (canvas.height - mark_edge) // 2))
    return canvas


def _expected_outputs(root: Path, master: Image.Image) -> Iterable[Tuple[Path, bytes]]:
    icon_dir = root / "assets" / "icons"
    yield icon_dir / "spotterdex-app-icon.png", _png_bytes(_resized(master, (512, 512)))
    yield icon_dir / "spotterdex-app-icon-192.png", _png_bytes(_resized(master, (192, 192)))
    yield icon_dir / "spotterdex-apple-touch-icon-v4.png", _png_bytes(_resized(master, (180, 180)))
    yield icon_dir / "spotterdex-app-icon-maskable-512.png", _png_bytes(_render_maskable(master))

    startup_dir = root / "assets" / "generated" / "startup"
    for asset in startup_assets():
        yield startup_dir / asset.filename, _png_bytes(_render_startup(master, asset))


def _load_master(root: Path) -> Image.Image:
    master_path = root / "assets" / "icons" / "spotterdex-app-icon-1024.png"
    if not master_path.is_file():
        raise FileNotFoundError(f"Missing Apple icon master: {master_path}")
    with Image.open(master_path) as image:
        master = image.convert("RGB")
    if master.size != (1024, 1024):
        raise ValueError(f"Apple icon master must be 1024x1024, found {master.size[0]}x{master.size[1]}")
    corners = (
        master.getpixel((0, 0)),
        master.getpixel((master.width - 1, 0)),
        master.getpixel((0, master.height - 1)),
        master.getpixel((master.width - 1, master.height - 1)),
    )
    if any(pixel != LAUNCH_BACKGROUND_RGB for pixel in corners):
        raise ValueError(f"Apple icon master corners must equal {LAUNCH_BACKGROUND}")
    return master


def build_apple_web_app_assets(root: Path) -> Tuple[int, int]:
    master = _load_master(root)
    changed = 0
    total = 0
    for path, payload in _expected_outputs(root, master):
        total += 1
        changed += int(_write_if_changed(path, payload))
    return changed, total


def check_apple_web_app_assets(root: Path) -> Tuple[bool, Tuple[str, ...]]:
    errors = []
    if len(IOS_DEVICE_TRIPLES) != 22 or len(set(IOS_DEVICE_TRIPLES)) != 22:
        errors.append("Apple device table must contain exactly 22 unique triples")
    if len(startup_assets()) != 44:
        errors.append("Apple startup matrix must contain exactly 44 assets")

    try:
        master = _load_master(root)
    except (FileNotFoundError, ValueError) as exc:
        return False, (str(exc),)

    for path, expected in _expected_outputs(root, master):
        if not path.is_file():
            errors.append(f"Missing generated Apple asset: {path.relative_to(root)}")
            continue
        actual = path.read_bytes()
        if not _png_pixels_match(actual, expected):
            errors.append(f"Stale generated Apple asset: {path.relative_to(root)}")

    return not errors, tuple(errors)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify assets without writing files")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    if args.check:
        current, errors = check_apple_web_app_assets(root)
        if not current:
            for error in errors:
                print(error, file=sys.stderr)
            return 1
        print("Apple web-app assets are current (4 install icons, 44 startup images).")
        return 0

    changed, total = build_apple_web_app_assets(root)
    print(f"Built {total} Apple web-app assets ({changed} changed).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
