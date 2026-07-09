#!/usr/bin/env python3
"""Build the static SpotterDex data bundle and resized web photos."""

from __future__ import annotations

import argparse
import html
import os
import hashlib
import json
import re
import shutil
import sys
import unicodedata
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote, urljoin

try:
    import yaml
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing PyYAML. Install with: python3 -m pip install -r requirements.txt") from exc

try:
    from PIL import ExifTags, Image, ImageDraw, ImageOps
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing Pillow. Install with: python3 -m pip install -r requirements.txt") from exc


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
AIRCRAFT_FAMILIES = {"fighter", "heavy", "helicopter", "light", "medium"}
# The published site favors fast page loads over archival-grade derivatives. Source
# images remain untouched in raw_assets; these settings only affect GitHub Pages output.
FULL_JPEG_QUALITY = 70
FULL_JPEG_SUBSAMPLING = 2  # 4:2:0 provides a substantial reduction for web viewing.
THUMB_JPEG_QUALITY = 55
THUMB_JPEG_SUBSAMPLING = 2
LOGO_PNG_COLORS = 256
FULL_JPEG_PROFILE = f"spotterdex-full-jpeg-v4-q{FULL_JPEG_QUALITY}-s{FULL_JPEG_SUBSAMPLING}"
THUMB_JPEG_PROFILE = f"spotterdex-thumb-jpeg-v4-q{THUMB_JPEG_QUALITY}-s{THUMB_JPEG_SUBSAMPLING}"
EXIF_TAGS = {value: key for key, value in ExifTags.TAGS.items()}
PROGRESS_LINE_MODE = False


class BuildWarningLog:
    def __init__(self) -> None:
        self.messages: List[str] = []
        self.notes: List[str] = []

    def add(self, message: str) -> None:
        self.messages.append(message)

    def info(self, message: str) -> None:
        self.notes.append(message)

    def has_warnings(self) -> bool:
        return bool(self.messages)

    def print(self) -> None:
        for message in self.messages:
            print(f"warning: {message}", file=sys.stderr)
        for message in self.notes:
            print(f"note: {message}", file=sys.stderr)


class ProgressBar:
    def __init__(self, label: str, total: int, enabled: bool = True, width: int = 28) -> None:
        self.label = label
        self.total = max(0, total)
        self.line_mode = bool(enabled and PROGRESS_LINE_MODE)
        self.enabled = bool(enabled and self.total and (sys.stderr.isatty() or self.line_mode))
        self.width = max(10, width)
        self.current = 0
        self.last_line_length = 0
        if self.enabled and not self.line_mode:
            self.render()

    def advance(self, detail: str = "") -> None:
        self.current = min(self.total, self.current + 1)
        self.render(detail)

    def finish(self) -> None:
        if not self.enabled:
            return
        self.current = self.total
        if self.line_mode:
            return
        self.render()
        sys.stderr.write("\n")
        sys.stderr.flush()
        self.last_line_length = 0

    def render(self, detail: str = "") -> None:
        if not self.enabled:
            return
        if self.line_mode:
            detail_text = truncate_progress_detail(detail)
            suffix = f" {detail_text}" if detail_text else ""
            print(f"{self.label}: {self.current}/{self.total}{suffix}", file=sys.stderr, flush=True)
            return
        ratio = self.current / self.total if self.total else 1
        filled = min(self.width, round(self.width * ratio))
        bar = "#" * filled + "-" * (self.width - filled)
        detail_text = truncate_progress_detail(detail)
        suffix = f" {detail_text}" if detail_text else ""
        line = f"\r{self.label} [{bar}] {self.current}/{self.total}{suffix}"
        padding = " " * max(0, self.last_line_length - len(line))
        sys.stderr.write(line + padding)
        sys.stderr.flush()
        self.last_line_length = len(line)


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Build SpotterDex static data and resized JPEG photos.")
    parser.add_argument("--root", type=Path, default=root, help="Project root directory.")
    parser.add_argument("--map-dir", default="map_pins", help="Directory containing country pin folders.")
    parser.add_argument("--aircraft-dir", default="aircraft", help="Directory containing aircraft/type/squadron folders.")
    parser.add_argument(
        "--squadron-dir",
        default="squadrons",
        help="Directory containing squadron-only entry folders.",
    )
    parser.add_argument(
        "--airshow-dir",
        default="airshows",
        help="Directory containing airshow event metadata.",
    )
    parser.add_argument(
        "--raw-assets-dir",
        default="raw_assets",
        help="Centralized source directory for original photos to be processed.",
    )
    parser.add_argument("--photo-output", default="assets/generated/photos", help="Processed photo output directory.")
    parser.add_argument("--thumb-output", default="assets/generated/thumbs", help="Generated thumbnail output directory.")
    parser.add_argument("--logo-output", default="assets/logos", help="Published squadron logo output directory.")
    parser.add_argument("--json-output", default="data/spotterdex.json", help="Generated JSON manifest path.")
    parser.add_argument("--js-output", default="data/spotterdex-data.js", help="Generated JS manifest path.")
    parser.add_argument(
        "--map-js-output",
        default="data/spotterdex-map-data.js",
        help="Minified map-page JS manifest path.",
    )
    parser.add_argument("--share-output", default="share", help="Generated social preview page directory.")
    parser.add_argument(
        "--site-url",
        default="https://tlkh.github.io/spotterdex/",
        help="Public site URL used in generated social preview metadata.",
    )
    parser.add_argument("--width", type=int, default=2560, help="Processed JPEG width in pixels (default: 2560).")
    parser.add_argument("--thumb-width", type=int, default=1024, help="Generated thumbnail width in pixels (default: 1024).")
    parser.add_argument("--logo-max-size", type=int, default=512, help="Maximum squadron logo width or height in pixels.")
    parser.add_argument("--strict", action="store_true", help="Return a non-zero exit code if validation warnings are found.")
    parser.add_argument("--no-progress", action="store_true", help="Disable terminal progress bars during the build.")
    parser.add_argument("--progress-lines", action="store_true", help="Emit one progress line per processed item.")
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Photo processing worker processes. Defaults to CPU cores minus one.",
    )
    parser.add_argument(
        "--make-demo-images",
        action="store_true",
        help="Create stylized placeholder source photos for missing sample photo paths.",
    )
    return parser.parse_args()


def normalize_worker_count(value: Optional[int]) -> int:
    if value is not None:
        return max(1, int(value))
    return max(1, (os.cpu_count() or 1) - 1)


def main() -> int:
    args = parse_args()
    global PROGRESS_LINE_MODE
    PROGRESS_LINE_MODE = args.progress_lines
    root = args.root.resolve()
    warnings = BuildWarningLog()

    map_dir = root / args.map_dir
    aircraft_dir = root / args.aircraft_dir
    squadron_dir = root / args.squadron_dir
    airshow_dir = root / args.airshow_dir
    raw_assets_dir = root / args.raw_assets_dir
    photo_output_dir = root / args.photo_output
    thumb_output_dir = root / args.thumb_output
    logo_output_dir = root / args.logo_output
    json_output = root / args.json_output
    js_output = root / args.js_output
    map_js_output = root / args.map_js_output
    share_output_dir = root / args.share_output
    show_progress = not args.no_progress
    photo_workers = normalize_worker_count(args.workers)

    pins = load_pins(
        root=root,
        map_dir=map_dir,
        raw_assets_dir=raw_assets_dir,
        photo_output_dir=photo_output_dir,
        thumb_output_dir=thumb_output_dir,
        target_width=args.width,
        thumb_width=args.thumb_width,
        warnings=warnings,
        show_progress=show_progress,
    )
    pin_lookup = {normalize_key(pin["name"]): pin["id"] for pin in pins}
    aircraft_entries, photos = load_aircraft(
        root=root,
        aircraft_dir=aircraft_dir,
        raw_assets_dir=raw_assets_dir,
        logo_output_dir=logo_output_dir,
        photo_output_dir=photo_output_dir,
        thumb_output_dir=thumb_output_dir,
        target_width=args.width,
        thumb_width=args.thumb_width,
        logo_max_size=args.logo_max_size,
        pin_lookup=pin_lookup,
        make_demo_images=args.make_demo_images,
        workers=photo_workers,
        warnings=warnings,
        show_progress=show_progress,
    )
    squadron_entries, squadron_photos = load_squadron_photos(
        root=root,
        squadron_dir=squadron_dir,
        raw_assets_dir=raw_assets_dir,
        logo_output_dir=logo_output_dir,
        photo_output_dir=photo_output_dir,
        thumb_output_dir=thumb_output_dir,
        target_width=args.width,
        thumb_width=args.thumb_width,
        logo_max_size=args.logo_max_size,
        pin_lookup=pin_lookup,
        make_demo_images=args.make_demo_images,
        workers=photo_workers,
        warnings=warnings,
        show_progress=show_progress,
    )
    location_photos = load_location_photos(
        root=root,
        map_dir=map_dir,
        pins=pins,
        raw_assets_dir=raw_assets_dir,
        photo_output_dir=photo_output_dir,
        thumb_output_dir=thumb_output_dir,
        target_width=args.width,
        thumb_width=args.thumb_width,
        workers=photo_workers,
        make_demo_images=args.make_demo_images,
        used_photo_ids={photo["id"] for photo in photos + squadron_photos},
        warnings=warnings,
        show_progress=show_progress,
    )
    photos.extend(squadron_photos)
    photos.extend(location_photos)
    photos.sort(
        key=lambda item: (
            item.get("sortDate", ""),
            item.get("aircraftType", ""),
            item.get("locationName", ""),
        ),
        reverse=True,
    )
    apply_squadron_stats(squadron_entries, photos)
    airshows = load_airshows(root=root, airshow_dir=airshow_dir, photos=photos, warnings=warnings)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pins": pins,
        "aircraft": aircraft_entries,
        "squadrons": squadron_entries,
        "airshows": airshows,
        "photos": photos,
    }

    validate_manifest(manifest, root, warnings)

    json_output.parent.mkdir(parents=True, exist_ok=True)
    js_output.parent.mkdir(parents=True, exist_ok=True)
    map_js_output.parent.mkdir(parents=True, exist_ok=True)
    json_text = json.dumps(manifest, indent=2, ensure_ascii=True)
    map_json_text = json.dumps(map_page_manifest(manifest), ensure_ascii=True, separators=(",", ":"))
    json_output.write_text(json_text + "\n", encoding="utf-8")
    js_output.write_text(f"window.SPOTTERDEX_DATA = {json_text};\n", encoding="utf-8")
    map_js_output.write_text(f"window.SPOTTERDEX_DATA={map_json_text};\n", encoding="utf-8")
    share_page_count = write_social_preview_pages(
        manifest=manifest,
        output_dir=share_output_dir,
        site_url=args.site_url,
    )

    warnings.print()
    print(
        f"Built {len(aircraft_entries)} aircraft entries, {len(squadron_entries)} squadron-only entries, "
        f"{len(photos)} photos, {len(pins)} pins."
    )
    print(f"Wrote {relative_posix(json_output, root)}")
    print(f"Wrote {relative_posix(js_output, root)}")
    print(f"Wrote {relative_posix(map_js_output, root)}")
    print(f"Wrote {share_page_count} social preview pages under {relative_posix(share_output_dir, root)}")
    if args.strict and warnings.has_warnings():
        print("Build completed with validation warnings.", file=sys.stderr)
        return 1
    return 0


def map_page_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    unit_fields = {
        "country",
        "id",
        "logo",
        "name",
        "showOnSquadronsPage",
        "unitLabel",
        "unitType",
    }
    photo_fields = {
        "aircraftFamily",
        "aircraftId",
        "aircraftType",
        "airshow",
        "country",
        "date",
        "id",
        "image",
        "livery",
        "locationName",
        "pinId",
        "sortDate",
        "squadronId",
        "squadronName",
        "tagScope",
        "thumbnail",
        "thumbnailSize",
        "unitLabel",
        "unitType",
        "year",
    }

    def compact_unit(unit: Dict[str, Any]) -> Dict[str, Any]:
        return {key: value for key, value in unit.items() if key in unit_fields}

    compact_aircraft = []
    for entry in manifest.get("aircraft", []):
        compact_aircraft.append(
            {
                "id": entry.get("id"),
                "typeName": entry.get("typeName"),
                "aircraftFamily": entry.get("aircraftFamily"),
                "countries": entry.get("countries", []),
                "squadrons": [compact_unit(unit) for unit in entry.get("squadrons", [])],
            }
        )

    return {
        "payload": "map",
        "generatedAt": manifest.get("generatedAt"),
        "pins": manifest.get("pins", []),
        "aircraft": compact_aircraft,
        "squadrons": [compact_unit(unit) for unit in manifest.get("squadrons", [])],
        # Airshow summaries are rebuilt client-side from the retained photo tags.
        "airshows": [],
        "photos": [
            {key: value for key, value in photo.items() if key in photo_fields}
            for photo in manifest.get("photos", [])
        ],
    }


def write_social_preview_pages(
    manifest: Dict[str, Any],
    output_dir: Path,
    site_url: str,
) -> int:
    site_url = str(site_url or "").strip().rstrip("/") + "/"
    output_dir.mkdir(parents=True, exist_ok=True)
    kinds = ("photo", "aircraft", "location", "squadron", "airshow")
    for kind in kinds:
        kind_dir = output_dir / kind
        if kind_dir.exists():
            shutil.rmtree(kind_dir)

    records = social_preview_records(manifest)
    for record in records:
        kind = record["kind"]
        entity_id = slugify(record["id"])
        page_dir = output_dir / kind / entity_id
        page_dir.mkdir(parents=True, exist_ok=True)
        page_dir.joinpath("index.html").write_text(
            social_preview_document(record, site_url, entity_id),
            encoding="utf-8",
        )
    return len(records)


def social_preview_records(manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    photos = list(manifest.get("photos", []))
    photos_by_id = {str(photo.get("id") or ""): photo for photo in photos}
    fallback_image = {
        "image": "assets/generated/photos/location-hero-gifu-air-base.jpg",
        "processedSize": "2560 x 1707",
    }
    records: List[Dict[str, Any]] = []

    for photo in photos:
        photo_id = str(photo.get("id") or "").strip()
        if not photo_id:
            continue
        subject = str(photo.get("title") or photo.get("aircraftType") or "Aviation photograph").strip()
        location = str(photo.get("locationName") or "").strip()
        livery = str(photo.get("livery") or "").strip()
        title = f"{subject}{f' at {location}' if location else ''} | SpotterDex"
        description = str(photo.get("caption") or "").strip()
        if not description:
            description = f"{subject}{f' photographed at {location}' if location else ''}."
        if livery and livery.lower() not in description.lower():
            description = f"{description.rstrip('.')} · {livery}."
        records.append(
            social_preview_record("photo", photo_id, title, description, photo, f"photo={quote(photo_id)}")
        )

    for aircraft in manifest.get("aircraft", []):
        aircraft_id = str(aircraft.get("id") or "").strip()
        if not aircraft_id:
            continue
        photo_ids = [str(value) for value in aircraft.get("photoIds", [])]
        cover = photos_by_id.get(str(aircraft.get("coverPhoto") or "")) or first_photo(photo_ids, photos_by_id)
        type_name = str(aircraft.get("typeName") or "Aircraft").strip()
        description = f"Explore {len(photo_ids)} photographed frame{'s' if len(photo_ids) != 1 else ''} of {type_name}, organised by unit and location."
        records.append(
            social_preview_record(
                "aircraft",
                aircraft_id,
                f"{type_name} field guide | SpotterDex",
                description,
                cover or fallback_image,
                f"aircraft={quote(aircraft_id)}",
            )
        )

    for pin in manifest.get("pins", []):
        pin_id = str(pin.get("id") or "").strip()
        if not pin_id:
            continue
        pin_photos = [photo for photo in photos if str(photo.get("pinId") or "") == pin_id]
        hero = photos_by_id.get(str(pin.get("heroPhotoId") or ""))
        if not hero and isinstance(pin.get("heroPhoto"), dict):
            hero = pin["heroPhoto"]
        hero = hero or (pin_photos[0] if pin_photos else fallback_image)
        name = str(pin.get("name") or "Spotting location").strip()
        country = str(pin.get("country") or "").strip()
        description = f"Explore {len(pin_photos)} aviation photograph{'s' if len(pin_photos) != 1 else ''} from {name}{f', {country}' if country else ''}."
        records.append(
            social_preview_record(
                "location",
                pin_id,
                f"{name} field guide | SpotterDex",
                description,
                hero,
                f"location={quote(pin_id)}&detail=1",
            )
        )

    for airshow in manifest.get("airshows", []):
        airshow_id = str(airshow.get("id") or "").strip()
        if not airshow_id:
            continue
        photo_ids = [str(value) for value in airshow.get("photoIds", [])]
        hero = photos_by_id.get(str(airshow.get("heroPhotoId") or "")) or first_photo(photo_ids, photos_by_id)
        name = str(airshow.get("name") or "Airshow").strip()
        description = f"View {len(photo_ids)} photograph{'s' if len(photo_ids) != 1 else ''} from {name}."
        records.append(
            social_preview_record(
                "airshow",
                airshow_id,
                f"{name} | SpotterDex",
                description,
                hero or fallback_image,
                f"airshow={quote(airshow_id)}",
            )
        )

    for squadron in aggregate_social_squadrons(manifest):
        photo_ids = squadron["photoIds"]
        hero = squadron.get("heroPhoto") or first_photo(photo_ids, photos_by_id) or fallback_image
        name = squadron["name"]
        country = squadron["country"]
        description = f"Explore {len(photo_ids)} aviation photograph{'s' if len(photo_ids) != 1 else ''} from {name}{f' in {country}' if country else ''}."
        records.append(
            social_preview_record(
                "squadron",
                squadron["id"],
                f"{name} | SpotterDex",
                description,
                hero,
                f"squadron={quote(squadron['id'])}",
            )
        )

    return records


def aggregate_social_squadrons(manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    by_id: Dict[str, Dict[str, Any]] = {}

    def add_unit(unit: Any) -> None:
        if not isinstance(unit, dict):
            return
        unit_type = normalize_key(str(unit.get("unitType") or unit.get("unit_type") or "squadron"))
        if unit_type == "organisation" or unit.get("showOnSquadronsPage") is False:
            return
        name = str(unit.get("name") or unit.get("squadronName") or "").strip()
        country = str(unit.get("country") or "").strip()
        if not name:
            return
        unit_id = slugify(f"{country}-{name}")
        record = by_id.setdefault(
            unit_id,
            {"id": unit_id, "name": name, "country": country, "photoIds": [], "heroPhoto": None},
        )
        record["photoIds"] = unique_values(
            [*record["photoIds"], *[str(value) for value in unit.get("photoIds", [])]]
        )
        if not record["heroPhoto"] and isinstance(unit.get("heroPhoto"), dict):
            record["heroPhoto"] = unit["heroPhoto"]

    for unit in manifest.get("squadrons", []):
        add_unit(unit)
    for aircraft in manifest.get("aircraft", []):
        for unit in aircraft.get("squadrons", []):
            add_unit(unit)
    return sorted(by_id.values(), key=lambda item: (item["country"], item["name"]))


def first_photo(photo_ids: Iterable[str], photos_by_id: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    return next((photos_by_id[photo_id] for photo_id in photo_ids if photo_id in photos_by_id), None)


def social_preview_record(
    kind: str,
    entity_id: str,
    title: str,
    description: str,
    image: Dict[str, Any],
    fragment: str,
) -> Dict[str, Any]:
    return {
        "kind": kind,
        "id": entity_id,
        "title": title,
        "description": re.sub(r"\s+", " ", description).strip()[:260],
        "image": str(image.get("image") or image.get("thumbnail") or ""),
        "imageSize": str(image.get("processedSize") or image.get("thumbnailSize") or ""),
        "fragment": fragment,
    }


def social_preview_document(record: Dict[str, Any], site_url: str, entity_id: str) -> str:
    title = html.escape(record["title"], quote=True)
    description = html.escape(record["description"], quote=True)
    image_url = html.escape(urljoin(site_url, record["image"]), quote=True)
    share_url = html.escape(urljoin(site_url, f"share/{record['kind']}/{entity_id}/"), quote=True)
    page_path = {
        "aircraft": "aircraft-dex.html",
        "squadron": "squadrons.html",
        "airshow": "airshows.html",
        "location": "index.html",
        "photo": "index.html",
    }.get(record["kind"], "index.html")
    main_url = urljoin(site_url, f"{page_path}#{record['fragment']}")
    canonical_url = html.escape(main_url, quote=True)
    redirect_url = f"../../../{page_path}#{record['fragment']}"
    width, height = parse_generated_size(record.get("imageSize"))
    dimension_meta = ""
    if width and height:
        dimension_meta = (
            f'\n    <meta property="og:image:width" content="{width}">'
            f'\n    <meta property="og:image:height" content="{height}">'
        )
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{title}</title>
    <meta name="description" content="{description}">
    <meta name="robots" content="noindex,follow">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="SpotterDex">
    <meta property="og:locale" content="en_SG">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{description}">
    <meta property="og:image" content="{image_url}">
    <meta property="og:image:secure_url" content="{image_url}">
    <meta property="og:image:alt" content="{title}">{dimension_meta}
    <meta property="og:url" content="{share_url}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{title}">
    <meta name="twitter:description" content="{description}">
    <meta name="twitter:image" content="{image_url}">
    <meta name="twitter:image:alt" content="{title}">
    <link rel="canonical" href="{canonical_url}">
    <script>window.location.replace({json.dumps(redirect_url)});</script>
  </head>
  <body>
    <p><a href="{html.escape(redirect_url, quote=True)}">Open this entry in SpotterDex</a></p>
  </body>
</html>
"""


def parse_generated_size(value: Any) -> Tuple[int, int]:
    match = re.search(r"(\d+)\s*x\s*(\d+)", str(value or ""), re.IGNORECASE)
    return (int(match.group(1)), int(match.group(2))) if match else (0, 0)


def load_pins(
    root: Path,
    map_dir: Path,
    raw_assets_dir: Path,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    warnings: BuildWarningLog,
    show_progress: bool = True,
) -> List[Dict[str, Any]]:
    if not map_dir.exists():
        warnings.add(f"map pin directory not found: {relative_posix(map_dir, root)}")
        return []

    pins: List[Dict[str, Any]] = []
    used_ids: set[str] = set()
    yaml_paths: List[Tuple[Path, Path]] = []

    for country_dir in sorted(path for path in map_dir.iterdir() if path.is_dir()):
        yaml_files = sorted(list(country_dir.glob("*.yaml")) + list(country_dir.glob("*.yml")))
        if not yaml_files:
            warnings.add(f"no YAML file found in {relative_posix(country_dir, root)}")
            continue
        yaml_paths.extend((country_dir, yaml_path) for yaml_path in yaml_files)

    progress = ProgressBar("Loading map pins", len(yaml_paths), enabled=show_progress)
    for country_dir, yaml_path in yaml_paths:
        data = read_yaml_mapping(yaml_path, warnings)
        progress.advance(relative_posix(yaml_path, root))
        if not data:
            continue

        country = str(data.get("country") or display_name(country_dir.name))
        pin_items = data.get("pins") or data.get("locations") or []
        if isinstance(pin_items, dict):
            pin_items = [pin_items]
        if not isinstance(pin_items, list):
            warnings.add(f"pins must be a list in {relative_posix(yaml_path, root)}")
            continue

        for index, pin_item in enumerate(pin_items, start=1):
            if not isinstance(pin_item, dict):
                warnings.add(f"skipping invalid pin #{index} in {relative_posix(yaml_path, root)}")
                continue

            name = str(pin_item.get("name") or pin_item.get("full_name") or "").strip()
            icao = normalize_icao(pin_item.get("icao") or pin_item.get("icao_code") or pin_item.get("icaoCode"))
            lat, lon = read_coordinates(pin_item)
            if not name or lat is None or lon is None:
                warnings.add(f"skipping pin #{index} with missing name or coordinates in {relative_posix(yaml_path, root)}")
                continue
            if not -90 <= lat <= 90 or not -180 <= lon <= 180:
                warnings.add(f"skipping pin #{index} with invalid coordinates in {relative_posix(yaml_path, root)}")
                continue

            pin_id = unique_id(str(pin_item.get("id") or f"{country}-{name}"), used_ids)
            hero_photo_id, hero_source = read_pin_hero_fields(pin_item)
            pin_record: Dict[str, Any] = {
                "id": pin_id,
                "name": name,
                "country": country,
                "icao": icao,
                "lat": lat,
                "lon": lon,
                "enabled": pin_item.get("enabled", True) is not False,
            }

            if hero_photo_id:
                pin_record["heroPhotoId"] = hero_photo_id
            if hero_source:
                hero_photo = process_location_hero(
                    root=root,
                    raw_assets_dir=raw_assets_dir,
                    yaml_path=yaml_path,
                    source_value=hero_source,
                    pin_id=pin_id,
                    location_name=name,
                    photo_output_dir=photo_output_dir,
                    thumb_output_dir=thumb_output_dir,
                    target_width=target_width,
                    thumb_width=thumb_width,
                    warnings=warnings,
                )
                if hero_photo:
                    pin_record["heroPhoto"] = hero_photo

            pins.append(pin_record)

    progress.finish()

    return sorted(pins, key=lambda item: (item["country"], item["name"]))


def load_aircraft(
    root: Path,
    aircraft_dir: Path,
    raw_assets_dir: Path,
    logo_output_dir: Path,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    logo_max_size: int,
    pin_lookup: Dict[str, str],
    make_demo_images: bool,
    workers: int,
    warnings: BuildWarningLog,
    show_progress: bool = True,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not aircraft_dir.exists():
        warnings.add(f"aircraft directory not found: {relative_posix(aircraft_dir, root)}")
        return [], []

    aircraft_by_id: Dict[str, Dict[str, Any]] = {}
    squadron_by_key: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    photos: List[Dict[str, Any]] = []
    used_photo_ids: set[str] = set()
    photo_jobs: List[Dict[str, Any]] = []
    photo_targets: Dict[int, Tuple[Dict[str, Any], Dict[str, Any]]] = {}

    yaml_files = sorted(list(aircraft_dir.glob("*/*/*.yaml")) + list(aircraft_dir.glob("*/*/*.yml")))
    entry_sources: List[Tuple[Path, Dict[str, Any]]] = []
    read_progress = ProgressBar("Reading aircraft YAML", len(yaml_files), enabled=show_progress)
    for yaml_path in yaml_files:
        data = read_yaml_mapping(yaml_path, warnings)
        read_progress.advance(relative_posix(yaml_path, root))
        if not data:
            continue
        entry_sources.append((yaml_path, data))
    read_progress.finish()

    photo_total = sum(count_photo_items(data) for _, data in entry_sources)
    skipped_photo_count = 0
    for yaml_path, data in entry_sources:
        aircraft_data = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
        squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
        squadron_scalar = data.get("squadron") if not isinstance(data.get("squadron"), dict) else None

        type_name = str(
            data.get("aircraft_type")
            or data.get("aircraft_type_name")
            or data.get("type_name")
            or aircraft_data.get("name")
            or display_name(yaml_path.parent.parent.name)
        ).strip()
        squadron_name = str(
            data.get("squadron_name")
            or data.get("squadron_full_name")
            or squadron_data.get("name")
            or squadron_scalar
            or display_name(yaml_path.parent.name)
        ).strip()
        unit_type = read_unit_type(data, squadron_data)
        aircraft_family = read_aircraft_family(data, aircraft_data)
        country = str(data.get("country") or squadron_data.get("country") or "").strip()
        aircraft_id = slugify(type_name)
        squadron_id = slugify(f"{aircraft_id}-{squadron_name}")
        logo_value = data.get("squadron_logo") or data.get("squadronLogo") or data.get("logo") or squadron_data.get("logo")
        logo = resolve_squadron_logo(
            root=root,
            raw_assets_dir=raw_assets_dir,
            logo_output_dir=logo_output_dir,
            yaml_path=yaml_path,
            logo_value=logo_value,
            squadron_id=squadron_id,
            squadron_name=squadron_name,
            logo_max_size=logo_max_size,
            warnings=warnings,
        )
        hero_value = read_squadron_hero_source(data, squadron_data)
        squadron_hero = process_squadron_hero(
            root=root,
            raw_assets_dir=raw_assets_dir,
            yaml_path=yaml_path,
            source_value=hero_value,
            squadron_id=squadron_id,
            squadron_name=squadron_name,
            photo_output_dir=photo_output_dir,
            thumb_output_dir=thumb_output_dir,
            target_width=target_width,
            thumb_width=thumb_width,
            warnings=warnings,
        ) if hero_value else None

        aircraft_entry = aircraft_by_id.setdefault(
            aircraft_id,
            {
                "id": aircraft_id,
                "typeName": type_name,
                "aircraftFamily": aircraft_family,
                "countries": [],
                "squadrons": [],
                "photoIds": [],
                "coverPhoto": None,
            },
        )
        if country and country not in aircraft_entry["countries"]:
            aircraft_entry["countries"].append(country)

        squadron_key = (aircraft_id, squadron_id, unit_type)
        squadron_entry = squadron_by_key.get(squadron_key)
        if not squadron_entry:
            squadron_entry = {
                "id": squadron_id,
                "name": squadron_name,
                "country": country,
                "logo": logo,
                "unitType": unit_type,
                "unitLabel": unit_display_label(unit_type),
                "showOnSquadronsPage": unit_type == "squadron",
                "photoIds": [],
            }
            if squadron_hero:
                squadron_entry["heroPhoto"] = squadron_hero
            squadron_by_key[squadron_key] = squadron_entry
            aircraft_entry["squadrons"].append(squadron_entry)
        elif not squadron_entry.get("heroPhoto") and squadron_hero:
            squadron_entry["heroPhoto"] = squadron_hero

        photo_items = data.get("photos") or []
        if isinstance(photo_items, dict):
            photo_items = [photo_items]
        if not isinstance(photo_items, list):
            warnings.add(f"photos must be a list in {relative_posix(yaml_path, root)}")
            continue

        for index, photo_item in enumerate(photo_items, start=1):
            photo_label = str(
                photo_item.get("path") or photo_item.get("file") or photo_item.get("filepath") or f"photo #{index}"
            ) if isinstance(photo_item, dict) else f"photo #{index}"
            if not isinstance(photo_item, dict):
                warnings.add(f"skipping invalid photo #{index} in {relative_posix(yaml_path, root)}")
                skipped_photo_count += 1
                continue

            photo_job = prepare_photo_job(
                order=len(photo_jobs),
                label=photo_label,
                root=root,
                raw_assets_dir=raw_assets_dir,
                yaml_path=yaml_path,
                photo_item=photo_item,
                index=index,
                type_name=type_name,
                aircraft_id=aircraft_id,
                squadron_name=squadron_name,
                squadron_id=squadron_id,
                unit_type=unit_type,
                country=country,
                photo_output_dir=photo_output_dir,
                thumb_output_dir=thumb_output_dir,
                target_width=target_width,
                thumb_width=thumb_width,
                pin_lookup=pin_lookup,
                make_demo_images=make_demo_images,
                used_photo_ids=used_photo_ids,
                warnings=warnings,
                aircraft_family=aircraft_family,
            )
            if not photo_job:
                skipped_photo_count += 1
                continue
            photo_targets[photo_job["order"]] = (aircraft_entry, squadron_entry)
            photo_jobs.append(photo_job)

    photo_progress = ProgressBar("Processing photos", photo_total, enabled=show_progress)
    for _ in range(skipped_photo_count):
        photo_progress.advance("skipped")
    photo_results = process_photo_jobs(
        jobs=photo_jobs,
        workers=workers,
        progress=photo_progress,
    )
    for order, result in sorted(photo_results.items()):
        for message in result.get("notes", []):
            warnings.info(message)
        for message in result.get("warnings", []):
            warnings.add(message)
        photo_record = result.get("record")
        if not photo_record:
            continue
        aircraft_entry, squadron_entry = photo_targets[order]
        photos.append(photo_record)
        aircraft_entry["photoIds"].append(photo_record["id"])
        squadron_entry["photoIds"].append(photo_record["id"])
        if not aircraft_entry["coverPhoto"]:
            aircraft_entry["coverPhoto"] = photo_record["id"]

    aircraft_entries = sorted(aircraft_by_id.values(), key=lambda item: item["typeName"])
    for entry in aircraft_entries:
        entry["countries"] = sorted(entry["countries"])
        entry["squadrons"] = sorted(entry["squadrons"], key=lambda item: item["name"])
        entry["photoIds"] = unique_values(entry["photoIds"])

    photos.sort(
        key=lambda item: (
            item.get("sortDate", ""),
            item.get("aircraftType", ""),
            item.get("locationName", ""),
        ),
        reverse=True,
    )
    apply_aircraft_stats(aircraft_entries, photos)
    return aircraft_entries, photos


def apply_aircraft_stats(aircraft_entries: List[Dict[str, Any]], photos: List[Dict[str, Any]]) -> None:
    photos_by_id = {photo["id"]: photo for photo in photos}
    for entry in aircraft_entries:
        entry_photos = [photos_by_id[photo_id] for photo_id in entry.get("photoIds", []) if photo_id in photos_by_id]
        locations = sorted(unique_values([photo.get("locationName", "") for photo in entry_photos]))
        sort_dates = sorted(date for date in (photo.get("sortDate", "") for photo in entry_photos) if date)

        for squadron in entry.get("squadrons", []):
            squadron_ids = unique_values(squadron.get("photoIds", []))
            squadron["photoIds"] = squadron_ids
            squadron["photoCount"] = sum(1 for photo_id in squadron_ids if photo_id in photos_by_id)

        unit_count = len(entry.get("squadrons", []))
        squadron_count = sum(1 for squadron in entry.get("squadrons", []) if squadron.get("unitType", "squadron") == "squadron")
        organisation_count = sum(1 for squadron in entry.get("squadrons", []) if squadron.get("unitType") == "organisation")
        entry["stats"] = {
            "photoCount": len(entry_photos),
            "unitCount": unit_count,
            "squadronCount": squadron_count,
            "organisationCount": organisation_count,
            "locationCount": len(locations),
            "locations": locations,
            "firstDate": sort_dates[0] if sort_dates else "",
            "latestDate": sort_dates[-1] if sort_dates else "",
            "countries": sorted(unique_values(entry.get("countries", []))),
        }


def load_squadron_photos(
    root: Path,
    squadron_dir: Path,
    raw_assets_dir: Path,
    logo_output_dir: Path,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    logo_max_size: int,
    pin_lookup: Dict[str, str],
    make_demo_images: bool,
    workers: int,
    warnings: BuildWarningLog,
    show_progress: bool = True,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Load photos owned by a squadron rather than an aircraft type."""
    if not squadron_dir.exists():
        return [], []

    yaml_files = sorted(list(squadron_dir.glob("*/entry.yaml")) + list(squadron_dir.glob("*/entry.yml")))
    entry_sources: List[Tuple[Path, Dict[str, Any]]] = []
    read_progress = ProgressBar("Reading squadron YAML", len(yaml_files), enabled=show_progress)
    for yaml_path in yaml_files:
        data = read_yaml_mapping(yaml_path, warnings)
        read_progress.advance(relative_posix(yaml_path, root))
        if data:
            entry_sources.append((yaml_path, data))
    read_progress.finish()

    squadrons_by_key: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    photo_targets: Dict[int, Dict[str, Any]] = {}
    photo_jobs: List[Dict[str, Any]] = []
    used_photo_ids: set[str] = set()
    skipped_photo_count = 0
    photo_total = sum(count_photo_items(data) for _, data in entry_sources)

    for yaml_path, data in entry_sources:
        squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
        squadron_scalar = data.get("squadron") if not isinstance(data.get("squadron"), dict) else None
        squadron_name = str(
            data.get("squadron_name")
            or data.get("squadron_full_name")
            or squadron_data.get("name")
            or squadron_scalar
            or display_name(yaml_path.parent.name)
        ).strip()
        country = str(data.get("country") or squadron_data.get("country") or "").strip()
        unit_type = read_unit_type(data, squadron_data)
        if not squadron_name:
            warnings.add(f"squadron entry is missing squadron_name: {relative_posix(yaml_path, root)}")
            continue
        if not country:
            warnings.add(f"squadron entry is missing country: {relative_posix(yaml_path, root)}")

        squadron_id = slugify(f"{country}-{squadron_name}")
        squadron_key = (country, squadron_name, unit_type)
        logo_value = data.get("squadron_logo") or data.get("squadronLogo") or data.get("logo") or squadron_data.get("logo")
        logo = resolve_squadron_logo(
            root=root,
            raw_assets_dir=raw_assets_dir,
            logo_output_dir=logo_output_dir,
            yaml_path=yaml_path,
            logo_value=logo_value,
            squadron_id=squadron_id,
            squadron_name=squadron_name,
            logo_max_size=logo_max_size,
            warnings=warnings,
        )
        hero_value = read_squadron_hero_source(data, squadron_data)
        hero = process_squadron_hero(
            root=root,
            raw_assets_dir=raw_assets_dir,
            yaml_path=yaml_path,
            source_value=hero_value,
            squadron_id=squadron_id,
            squadron_name=squadron_name,
            photo_output_dir=photo_output_dir,
            thumb_output_dir=thumb_output_dir,
            target_width=target_width,
            thumb_width=thumb_width,
            warnings=warnings,
        ) if hero_value else None

        squadron_entry = squadrons_by_key.get(squadron_key)
        if not squadron_entry:
            squadron_entry = {
                "id": squadron_id,
                "name": squadron_name,
                "country": country,
                "logo": logo,
                "unitType": unit_type,
                "unitLabel": unit_display_label(unit_type),
                "showOnSquadronsPage": unit_type == "squadron",
                "photoIds": [],
                "aircraftTypes": [],
            }
            if hero:
                squadron_entry["heroPhoto"] = hero
            squadrons_by_key[squadron_key] = squadron_entry
        elif not squadron_entry.get("logo") and logo:
            squadron_entry["logo"] = logo
        if not squadron_entry.get("heroPhoto") and hero:
            squadron_entry["heroPhoto"] = hero

        photo_items = data.get("photos") or []
        if isinstance(photo_items, dict):
            photo_items = [photo_items]
        if not isinstance(photo_items, list):
            warnings.add(f"photos must be a list in {relative_posix(yaml_path, root)}")
            continue
        for index, photo_item in enumerate(photo_items, start=1):
            photo_label = str(
                photo_item.get("path") or photo_item.get("file") or photo_item.get("filepath") or f"photo #{index}"
            ) if isinstance(photo_item, dict) else f"photo #{index}"
            if not isinstance(photo_item, dict):
                warnings.add(f"skipping invalid squadron photo #{index} in {relative_posix(yaml_path, root)}")
                skipped_photo_count += 1
                continue
            photo_job = prepare_photo_job(
                order=len(photo_jobs),
                label=photo_label,
                root=root,
                raw_assets_dir=raw_assets_dir,
                yaml_path=yaml_path,
                photo_item=photo_item,
                index=index,
                type_name="",
                aircraft_id="",
                squadron_name=squadron_name,
                squadron_id=squadron_id,
                unit_type=unit_type,
                country=country,
                photo_output_dir=photo_output_dir,
                thumb_output_dir=thumb_output_dir,
                target_width=target_width,
                thumb_width=thumb_width,
                pin_lookup=pin_lookup,
                make_demo_images=make_demo_images,
                used_photo_ids=used_photo_ids,
                warnings=warnings,
                tag_scope="squadron",
            )
            if not photo_job:
                skipped_photo_count += 1
                continue
            photo_targets[photo_job["order"]] = squadron_entry
            photo_jobs.append(photo_job)

    progress = ProgressBar("Processing squadron photos", photo_total, enabled=show_progress)
    for _ in range(skipped_photo_count):
        progress.advance("skipped")
    photo_results = process_photo_jobs(photo_jobs, workers, progress)
    photos: List[Dict[str, Any]] = []
    for order, result in sorted(photo_results.items()):
        for message in result.get("notes", []):
            warnings.info(message)
        for message in result.get("warnings", []):
            warnings.add(message)
        record = result.get("record")
        if not record or order not in photo_targets:
            continue
        photos.append(record)
        photo_targets[order]["photoIds"].append(record["id"])

    return (
        sorted(squadrons_by_key.values(), key=lambda item: (item["country"], item["name"])),
        sorted(photos, key=lambda item: (item.get("sortDate", ""), item.get("locationName", "")), reverse=True),
    )


def load_location_photos(
    root: Path,
    map_dir: Path,
    pins: List[Dict[str, Any]],
    raw_assets_dir: Path,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    workers: int,
    make_demo_images: bool,
    used_photo_ids: set[str],
    warnings: BuildWarningLog,
    show_progress: bool = True,
) -> List[Dict[str, Any]]:
    """Load photos stored on map pins, with no aircraft or unit assignment."""
    if not map_dir.exists():
        return []

    pins_by_id = {str(pin.get("id") or ""): pin for pin in pins}
    pin_lookup = {normalize_key(str(pin.get("name") or "")): str(pin.get("id") or "") for pin in pins}
    sources: List[Tuple[Path, str, Dict[str, Any], int, Dict[str, Any]]] = []
    yaml_files = sorted(map_dir.glob("*/*.y*ml"))
    read_progress = ProgressBar("Reading location photos", len(yaml_files), enabled=show_progress)
    for yaml_path in yaml_files:
        data = read_yaml_mapping(yaml_path, warnings)
        read_progress.advance(relative_posix(yaml_path, root))
        if not data:
            continue
        country = str(data.get("country") or display_name(yaml_path.parent.name)).strip()
        pin_items = data.get("pins") or data.get("locations") or []
        if isinstance(pin_items, dict):
            pin_items = [pin_items]
        if not isinstance(pin_items, list):
            continue
        for pin_item in pin_items:
            if not isinstance(pin_item, dict):
                continue
            pin_id = str(pin_item.get("id") or "").strip()
            pin = pins_by_id.get(pin_id)
            if not pin:
                continue
            photo_items = pin_item.get("photos") or []
            if isinstance(photo_items, dict):
                photo_items = [photo_items]
            if not isinstance(photo_items, list):
                warnings.add(f"photos must be a list for map pin {pin.get('name')} in {relative_posix(yaml_path, root)}")
                continue
            for photo_index, item in enumerate(photo_items):
                sources.append((yaml_path, country, pin, photo_index, item))
    read_progress.finish()

    photo_jobs: List[Dict[str, Any]] = []
    skipped_photo_count = 0
    for yaml_path, country, pin, photo_index, photo_item in sources:
        index = photo_index + 1
        if not isinstance(photo_item, dict):
            warnings.add(f"skipping invalid location photo in {relative_posix(yaml_path, root)}")
            skipped_photo_count += 1
            continue
        scoped_item = dict(photo_item)
        scoped_item["location"] = pin["name"]
        scoped_item["pin_id"] = pin["id"]
        photo_label = str(scoped_item.get("path") or scoped_item.get("file") or scoped_item.get("filepath") or f"photo #{index}")
        photo_job = prepare_photo_job(
            order=len(photo_jobs),
            label=photo_label,
            root=root,
            raw_assets_dir=raw_assets_dir,
            yaml_path=yaml_path,
            photo_item=scoped_item,
            index=index,
            type_name="",
            aircraft_id="",
            squadron_name="",
            squadron_id="",
            unit_type="",
            country=country,
            photo_output_dir=photo_output_dir,
            thumb_output_dir=thumb_output_dir,
            target_width=target_width,
            thumb_width=thumb_width,
            pin_lookup=pin_lookup,
            make_demo_images=make_demo_images,
            used_photo_ids=used_photo_ids,
            warnings=warnings,
            tag_scope="location",
            source_ref={
                "scope": "location",
                "entryPath": relative_posix(yaml_path, root),
                "targetPinId": pin["id"],
                "index": photo_index,
            },
        )
        if not photo_job:
            skipped_photo_count += 1
            continue
        photo_jobs.append(photo_job)

    progress = ProgressBar("Processing location photos", len(sources), enabled=show_progress)
    for _ in range(skipped_photo_count):
        progress.advance("skipped")
    results = process_photo_jobs(photo_jobs, workers, progress)
    photos: List[Dict[str, Any]] = []
    for _, result in sorted(results.items()):
        for message in result.get("notes", []):
            warnings.info(message)
        for message in result.get("warnings", []):
            warnings.add(message)
        if result.get("record"):
            photos.append(result["record"])
    return sorted(photos, key=lambda item: (item.get("sortDate", ""), item.get("locationName", "")), reverse=True)


def apply_squadron_stats(squadron_entries: List[Dict[str, Any]], photos: List[Dict[str, Any]]) -> None:
    photos_by_id = {photo["id"]: photo for photo in photos}
    for squadron in squadron_entries:
        photo_ids = unique_values(squadron.get("photoIds", []))
        squadron["photoIds"] = photo_ids
        squadron["photoCount"] = sum(1 for photo_id in photo_ids if photo_id in photos_by_id)


def load_airshows(
    root: Path,
    airshow_dir: Path,
    photos: List[Dict[str, Any]],
    warnings: BuildWarningLog,
) -> List[Dict[str, Any]]:
    """Aggregate tagged photos into event timeline records with optional source-photo heroes."""
    configured_heroes: Dict[str, Dict[str, Any]] = {}
    events_path = airshow_dir / "events.yaml"
    if not events_path.exists():
        alternate_path = airshow_dir / "events.yml"
        events_path = alternate_path if alternate_path.exists() else events_path

    if events_path.exists():
        data = read_yaml_mapping(events_path, warnings)
        event_items = data.get("events") or data.get("airshows") or []
        if isinstance(event_items, dict):
            event_items = [event_items]
        if not isinstance(event_items, list):
            warnings.add(f"events must be a list in {relative_posix(events_path, root)}")
        else:
            for item in event_items:
                if not isinstance(item, dict):
                    warnings.add(f"skipping invalid airshow event in {relative_posix(events_path, root)}")
                    continue
                name = str(item.get("name") or item.get("event") or item.get("airshow") or "").strip()
                if not name:
                    warnings.add(f"airshow event is missing name in {relative_posix(events_path, root)}")
                    continue
                event_key = normalize_key(name)
                if event_key in configured_heroes:
                    warnings.add(f"duplicate airshow event metadata: {name}")
                    continue
                configured_heroes[event_key] = read_airshow_hero_ref(item)

    photos_by_event: Dict[str, List[Dict[str, Any]]] = {}
    event_names: Dict[str, str] = {}
    for photo in photos:
        name = str(photo.get("airshow") or "").strip()
        if not name:
            continue
        event_key = normalize_key(name)
        photos_by_event.setdefault(event_key, []).append(photo)
        event_names.setdefault(event_key, name)

    airshows: List[Dict[str, Any]] = []
    for event_key, event_photos in photos_by_event.items():
        ordered_photos = sorted(event_photos, key=lambda photo: (photo.get("sortDate", ""), photo.get("id", "")))
        dated_photos = [photo for photo in ordered_photos if photo.get("sortDate")]
        hero_ref = configured_heroes.get(event_key, {})
        hero_key = source_ref_key(hero_ref) if hero_ref else None
        hero = next((photo for photo in ordered_photos if source_ref_key(photo.get("sourceRef", {})) == hero_key), None)
        if hero_ref and not hero:
            warnings.add(f"airshow hero does not match a tagged photo: {event_names[event_key]}")

        record = {
            "id": slugify(event_names[event_key]),
            "name": event_names[event_key],
            "photoIds": [photo["id"] for photo in ordered_photos],
            "photoCount": len(ordered_photos),
            "firstDate": dated_photos[0].get("sortDate", "") if dated_photos else "",
            "latestDate": dated_photos[-1].get("sortDate", "") if dated_photos else "",
        }
        if hero:
            record["heroPhotoId"] = hero["id"]
        airshows.append(record)

    return sorted(
        airshows,
        key=lambda event: (event.get("latestDate", ""), event.get("name", "")),
        reverse=True,
    )


def read_airshow_hero_ref(event: Dict[str, Any]) -> Dict[str, Any]:
    value = event.get("hero_photo") or event.get("heroPhoto") or event.get("hero") or {}
    if not isinstance(value, dict):
        return {}
    try:
        index = int(value.get("index"))
    except (TypeError, ValueError):
        return {}
    if index < 0:
        return {}
    scope = str(value.get("scope") or "").strip()
    entry_path = str(value.get("entry_path") or value.get("entryPath") or "").strip()
    pin_id = str(value.get("target_pin_id") or value.get("targetPinId") or "").strip()
    if not scope or not entry_path:
        return {}
    reference = {"scope": scope, "entryPath": entry_path, "index": index}
    if pin_id:
        reference["targetPinId"] = pin_id
    return reference


def source_ref_key(reference: Any) -> Tuple[str, str, str, int]:
    if not isinstance(reference, dict):
        return ("", "", "", -1)
    try:
        index = int(reference.get("index"))
    except (TypeError, ValueError):
        index = -1
    return (
        str(reference.get("scope") or "").strip(),
        str(reference.get("entryPath") or reference.get("entry_path") or "").strip(),
        str(reference.get("targetPinId") or reference.get("target_pin_id") or "").strip(),
        index,
    )


def format_pin_label(pin: Dict[str, Any]) -> str:
    name = str(pin.get("name") or pin.get("id") or "Unknown location").strip()
    country = str(pin.get("country") or "").strip()
    icao = str(pin.get("icao") or "").strip()
    suffix_parts = [part for part in (country, icao) if part]
    if suffix_parts:
        return f"{name} ({', '.join(suffix_parts)})"
    return name


def validate_manifest(manifest: Dict[str, Any], root: Path, warnings: BuildWarningLog) -> None:
    pins = manifest.get("pins", [])
    photos = manifest.get("photos", [])
    aircraft_entries = manifest.get("aircraft", [])
    airshows = manifest.get("airshows", [])

    pin_ids: set[str] = set()
    pin_name_keys: set[str] = set()
    enabled_pin_ids: set[str] = set()
    pins_by_id: Dict[str, Dict[str, Any]] = {}
    pin_hero_photo_ids: List[Tuple[str, str]] = []
    for pin in pins:
        pin_id = str(pin.get("id") or "")
        pin_key = normalize_key(f"{pin.get('country', '')}-{pin.get('name', '')}")
        lat = pin.get("lat")
        lon = pin.get("lon")
        icao = str(pin.get("icao") or "")
        hero_photo_id = str(pin.get("heroPhotoId") or "")

        if pin_id in pin_ids:
            warnings.add(f"duplicate pin id in generated manifest: {pin_id}")
        pin_ids.add(pin_id)
        pins_by_id[pin_id] = pin

        if pin_key in pin_name_keys:
            warnings.add(f"duplicate pin name/country in generated manifest: {pin.get('name')}")
        pin_name_keys.add(pin_key)

        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            warnings.add(f"pin has non-numeric coordinates: {pin.get('name')}")
        elif not -90 <= lat <= 90 or not -180 <= lon <= 180:
            warnings.add(f"pin has out-of-range coordinates: {pin.get('name')}")

        if icao and not re.fullmatch(r"[A-Z0-9]{4}", icao):
            warnings.add(f"pin has invalid ICAO code: {pin.get('name')} -> {icao}")

        if pin.get("enabled") is not False:
            enabled_pin_ids.add(pin_id)

        if hero_photo_id:
            pin_hero_photo_ids.append((pin_id, hero_photo_id))

        hero_photo = pin.get("heroPhoto")
        if hero_photo:
            if not isinstance(hero_photo, dict):
                warnings.add(f"pin heroPhoto must be an object: {pin.get('name')}")
            else:
                for field_name in ("image", "thumbnail"):
                    site_path = str(hero_photo.get(field_name) or "")
                    if not site_path:
                        warnings.add(f"pin heroPhoto is missing generated {field_name}: {pin.get('name')}")
                        continue
                    if not (root / site_path).exists():
                        warnings.add(f"generated pin heroPhoto {field_name} is missing on disk: {site_path}")

    photo_ids: set[str] = set()
    photos_by_id: Dict[str, Dict[str, Any]] = {}
    source_paths: set[str] = set()
    photo_pin_ids: set[str] = set()
    for photo in photos:
        photo_id = str(photo.get("id") or "")
        if photo_id in photo_ids:
            warnings.add(f"duplicate photo id in generated manifest: {photo_id}")
        photo_ids.add(photo_id)
        photos_by_id[photo_id] = photo

        source = str(photo.get("source") or "")
        if source:
            if source in source_paths:
                warnings.add(f"source photo is referenced more than once: {source}")
            source_paths.add(source)

        pin_id = str(photo.get("pinId") or "")
        if pin_id:
            if pin_id not in pin_ids:
                warnings.add(f"photo references an unknown pin id: {photo_id} -> {pin_id}")
            else:
                photo_pin_ids.add(pin_id)
        else:
            warnings.add(f"photo has no matching map pin: {photo_id} ({photo.get('locationName', 'Unknown location')})")

        if not photo.get("sortDate"):
            warnings.add(f"photo has no usable date, year, or EXIF capture date: {photo_id}")

        for field_name in ("image", "thumbnail"):
            site_path = str(photo.get(field_name) or "")
            if not site_path:
                warnings.add(f"photo is missing generated {field_name}: {photo_id}")
                continue
            if not (root / site_path).exists():
                warnings.add(f"generated {field_name} is missing on disk: {site_path}")

    for pin_id, hero_photo_id in pin_hero_photo_ids:
        if hero_photo_id not in photo_ids:
            warnings.add(f"pin references an unknown heroPhotoId: {pin_id} -> {hero_photo_id}")
            continue
        hero_photo_pin_id = str(photos_by_id[hero_photo_id].get("pinId") or "")
        if hero_photo_pin_id and hero_photo_pin_id != pin_id:
            warnings.add(f"pin heroPhotoId points to a photo from another location: {pin_id} -> {hero_photo_id}")

    airshow_ids: set[str] = set()
    airshow_names: set[str] = set()
    for airshow in airshows:
        airshow_id = str(airshow.get("id") or "")
        name = str(airshow.get("name") or "")
        name_key = normalize_key(name)
        if not name:
            warnings.add("airshow is missing name")
        if airshow_id in airshow_ids:
            warnings.add(f"duplicate airshow id in generated manifest: {airshow_id}")
        airshow_ids.add(airshow_id)
        if name_key in airshow_names:
            warnings.add(f"duplicate airshow name in generated manifest: {name}")
        airshow_names.add(name_key)

        airshow_photo_ids = [str(photo_id) for photo_id in airshow.get("photoIds", [])]
        if not airshow_photo_ids:
            warnings.add(f"airshow has no tagged photos: {name}")
        for photo_id in airshow_photo_ids:
            photo = photos_by_id.get(photo_id)
            if not photo:
                warnings.add(f"airshow references an unknown photo: {name} -> {photo_id}")
                continue
            if normalize_key(str(photo.get("airshow") or "")) != name_key:
                warnings.add(f"airshow photo has a mismatched event name: {name} -> {photo_id}")

        hero_photo_id = str(airshow.get("heroPhotoId") or "")
        if hero_photo_id:
            if hero_photo_id not in airshow_photo_ids:
                warnings.add(f"airshow hero does not belong to event: {name} -> {hero_photo_id}")
            elif hero_photo_id not in photo_ids:
                warnings.add(f"airshow hero references an unknown photo: {name} -> {hero_photo_id}")

    for entry in aircraft_entries:
        aircraft_family = str(entry.get("aircraftFamily") or "")
        if aircraft_family not in AIRCRAFT_FAMILIES:
            warnings.add(
                f"aircraft entry has an invalid or missing aircraft family: "
                f"{entry.get('typeName', entry.get('id', 'Unknown aircraft'))} -> {aircraft_family or 'missing'}"
            )
        for squadron in entry.get("squadrons", []):
            hero_photo = squadron.get("heroPhoto")
            if not hero_photo:
                continue
            if not isinstance(hero_photo, dict):
                warnings.add(f"squadron heroPhoto must be an object: {squadron.get('name')}")
                continue
            for field_name in ("image", "thumbnail"):
                site_path = str(hero_photo.get(field_name) or "")
                if not site_path:
                    warnings.add(f"squadron heroPhoto is missing generated {field_name}: {squadron.get('name')}")
                    continue
                if not (root / site_path).exists():
                    warnings.add(f"generated squadron heroPhoto {field_name} is missing on disk: {site_path}")

    empty_entries = [entry for entry in aircraft_entries if not entry.get("photoIds")]
    empty_pins = enabled_pin_ids.difference(photo_pin_ids)
    if empty_entries:
        warnings.info(f"{len(empty_entries)} aircraft entries currently have no photos.")
    if empty_pins:
        empty_pin_names = [
            format_pin_label(pins_by_id[pin_id])
            for pin_id in sorted(empty_pins, key=lambda value: format_pin_label(pins_by_id.get(value, {"id": value})))
            if pin_id in pins_by_id
        ]
        if empty_pin_names:
            warnings.info(
                f"{len(empty_pins)} enabled map pins currently have no matched photos: "
                + "; ".join(empty_pin_names)
            )
        else:
            warnings.info(f"{len(empty_pins)} enabled map pins currently have no matched photos.")


def prepare_photo_job(
    order: int,
    label: str,
    root: Path,
    raw_assets_dir: Path,
    yaml_path: Path,
    photo_item: Dict[str, Any],
    index: int,
    type_name: str,
    aircraft_id: str,
    squadron_name: str,
    squadron_id: str,
    unit_type: str,
    country: str,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    pin_lookup: Dict[str, str],
    make_demo_images: bool,
    used_photo_ids: set[str],
    warnings: BuildWarningLog,
    tag_scope: str = "aircraft",
    source_ref: Optional[Dict[str, Any]] = None,
    aircraft_family: str = "",
) -> Optional[Dict[str, Any]]:
    source_value = photo_item.get("path") or photo_item.get("file") or photo_item.get("filepath")
    if not source_value:
        warnings.add(f"photo #{index} in {relative_posix(yaml_path, root)} has no path")
        return None

    source_path = resolve_photo_source(root, raw_assets_dir, yaml_path, source_value)
    if not source_path.exists() and not make_demo_images:
        warnings.add(f"photo source not found: {relative_posix(source_path, root)}")
        return None

    if source_path.suffix.lower() not in IMAGE_EXTENSIONS:
        warnings.add(f"unsupported image type skipped: {relative_posix(source_path, root)}")
        return None

    photo_id = unique_id(
        f"{tag_scope}-{type_name}-{squadron_name}-{source_path.stem}-{short_hash(relative_posix(source_path, root))}",
        used_photo_ids,
    )
    normalized_source_ref = {
        "scope": tag_scope,
        "entryPath": relative_posix(yaml_path, root),
        "index": max(0, index - 1),
    }
    if source_ref:
        normalized_source_ref.update(source_ref)
    return {
        "order": order,
        "label": label,
        "root": str(root),
        "source_path": str(source_path),
        "output_path": str(photo_output_dir / f"{photo_id}.jpg"),
        "thumb_path": str(thumb_output_dir / f"{photo_id}.jpg"),
        "photo_id": photo_id,
        "photo_item": photo_item,
        "type_name": type_name,
        "aircraft_family": aircraft_family,
        "aircraft_id": aircraft_id,
        "squadron_name": squadron_name,
        "squadron_id": squadron_id,
        "unit_type": unit_type,
        "country": country,
        "tag_scope": tag_scope,
        "source_ref": normalized_source_ref,
        "target_width": target_width,
        "thumb_width": thumb_width,
        "pin_lookup": pin_lookup,
        "make_demo_images": make_demo_images,
    }


def process_photo_jobs(
    jobs: List[Dict[str, Any]],
    workers: int,
    progress: ProgressBar,
) -> Dict[int, Dict[str, Any]]:
    results: Dict[int, Dict[str, Any]] = {}
    if not jobs:
        progress.finish()
        return results

    worker_count = min(max(1, workers), len(jobs))
    if worker_count <= 1:
        for job in jobs:
            results[job["order"]] = process_photo_job(job)
            progress.advance(job.get("label", "photo"))
        progress.finish()
        return results

    try:
        with ProcessPoolExecutor(max_workers=worker_count) as executor:
            futures = {executor.submit(process_photo_job, job): job for job in jobs}
            for future in as_completed(futures):
                job = futures[future]
                try:
                    result = future.result()
                except Exception as exc:  # pragma: no cover - process-pool guard
                    result = {
                        "order": job["order"],
                        "record": None,
                        "warnings": [f"could not process {job.get('source_path', job.get('label', 'photo'))}: {exc}"],
                    }
                results[job["order"]] = result
                progress.advance(job.get("label", "photo"))
    except (OSError, PermissionError) as exc:
        results[-1] = {
            "order": -1,
            "record": None,
            "notes": [f"parallel photo processing unavailable ({exc}); falling back to one worker."],
        }
        for job in jobs:
            results[job["order"]] = process_photo_job(job)
            progress.advance(job.get("label", "photo"))
    progress.finish()
    return results


def jpeg_matches_profile(image: Image.Image, profile: str) -> bool:
    """Return whether a generated JPEG was encoded with the current web profile."""
    comment = image.info.get("comment", b"")
    if isinstance(comment, str):
        comment = comment.encode("ascii", "ignore")
    return comment == profile.encode("ascii")


def save_web_jpeg(
    image: Image.Image,
    output_path: Path,
    *,
    quality: int,
    subsampling: int,
    profile: str,
    exif: Optional[bytes],
) -> None:
    """Save a progressive, optimized JPEG and tag it with its encoding profile."""
    save_kwargs: Dict[str, Any] = {
        "quality": quality,
        "subsampling": subsampling,
        "optimize": True,
        "progressive": True,
        "comment": profile.encode("ascii"),
    }
    if exif:
        save_kwargs["exif"] = exif
    image.save(output_path, "JPEG", **save_kwargs)


def process_photo_job(job: Dict[str, Any]) -> Dict[str, Any]:
    warnings: List[str] = []
    root = Path(job["root"])
    source_path = Path(job["source_path"])
    output_path = Path(job["output_path"])
    thumb_path = Path(job["thumb_path"])
    photo_item = job["photo_item"]
    type_name = str(job["type_name"])
    squadron_name = str(job["squadron_name"])

    if not source_path.exists():
        if job.get("make_demo_images"):
            make_demo_image(
                source_path,
                type_name,
                squadron_name,
                str(photo_item.get("location") or photo_item.get("location_name") or ""),
            )
        else:
            warnings.append(f"photo source not found: {relative_posix(source_path, root)}")
            return {"order": job["order"], "record": None, "warnings": warnings}

    if source_path.suffix.lower() not in IMAGE_EXTENSIONS:
        warnings.append(f"unsupported image type skipped: {relative_posix(source_path, root)}")
        return {"order": job["order"], "record": None, "warnings": warnings}

    output_path.parent.mkdir(parents=True, exist_ok=True)
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        reuse_existing = (
            output_path.exists()
            and thumb_path.exists()
            and min(output_path.stat().st_mtime_ns, thumb_path.stat().st_mtime_ns) >= source_path.stat().st_mtime_ns
        )
        with Image.open(source_path) as opened:
            exif = extract_exif(opened)
            original_size = f"{opened.width} x {opened.height}"
            if reuse_existing:
                with Image.open(output_path) as processed_image, Image.open(thumb_path) as thumbnail_image:
                    processed_size = processed_image.size
                    thumbnail_size = thumbnail_image.size
                    full_profile_matches = jpeg_matches_profile(processed_image, FULL_JPEG_PROFILE)
                    thumb_profile_matches = jpeg_matches_profile(thumbnail_image, THUMB_JPEG_PROFILE)
                # A changed build width or thumbnail width requires a fresh output,
                # even when the source image has not changed.
                reuse_existing = (
                    processed_size[0] == int(job["target_width"])
                    and thumbnail_size[0] == int(job["thumb_width"])
                    and full_profile_matches
                    and thumb_profile_matches
                )
            if not reuse_existing:
                output_exif = normalized_output_exif(opened)
                image = ImageOps.exif_transpose(opened)
                image = image.convert("RGB")
                processed = resize_to_width(image, int(job["target_width"]))
                thumbnail = resize_to_width(image, int(job["thumb_width"]))
                # Lanczos is Pillow's highest-quality resampling filter. Full frames
                # retain fine aircraft detail, while compact thumbnails load quickly.
                save_web_jpeg(
                    processed,
                    output_path,
                    quality=FULL_JPEG_QUALITY,
                    subsampling=FULL_JPEG_SUBSAMPLING,
                    profile=FULL_JPEG_PROFILE,
                    exif=output_exif,
                )
                save_web_jpeg(
                    thumbnail,
                    thumb_path,
                    quality=THUMB_JPEG_QUALITY,
                    subsampling=THUMB_JPEG_SUBSAMPLING,
                    profile=THUMB_JPEG_PROFILE,
                    exif=output_exif,
                )
                processed_size = processed.size
                thumbnail_size = thumbnail.size
    except Exception as exc:  # pragma: no cover - depends on source image
        warnings.append(f"could not process {relative_posix(source_path, root)}: {exc}")
        return {"order": job["order"], "record": None, "warnings": warnings}

    location_name = str(photo_item.get("location") or photo_item.get("location_name") or "Unknown location").strip()
    explicit_pin = photo_item.get("pin_id") or photo_item.get("pin")
    pin_id = resolve_pin_id(explicit_pin, location_name, job["pin_lookup"])
    photo_date = read_photo_date(photo_item, exif)
    year = str(photo_item.get("year") or (photo_date[:4] if photo_date else "")).strip()

    record = {
        "id": job["photo_id"],
        "tagScope": job.get("tag_scope", "aircraft"),
        "aircraftId": job["aircraft_id"],
        "aircraftType": type_name,
        "aircraftFamily": job.get("aircraft_family", ""),
        "squadronId": job["squadron_id"],
        "squadronName": squadron_name,
        "unitType": job["unit_type"],
        "unitLabel": unit_display_label(job["unit_type"]),
        "country": job["country"],
        "year": year,
        "date": photo_date,
        "sortDate": photo_date or (f"{year}-01-01" if year else ""),
        "locationName": location_name,
        "pinId": pin_id,
        "sourceRef": job.get("source_ref", {}),
        "airshow": str(photo_item.get("airshow") or photo_item.get("airshow_name") or "").strip(),
        "livery": str(
            photo_item.get("livery")
            or photo_item.get("paint_scheme")
            or photo_item.get("paintScheme")
            or ""
        ).strip(),
        "title": str(photo_item.get("title") or ""),
        "caption": str(photo_item.get("caption") or ""),
        "image": site_path_for(output_path, root),
        "thumbnail": site_path_for(thumb_path, root),
        "source": site_path_for(source_path, root),
        "originalSize": original_size,
        "processedSize": format_size(processed_size),
        "thumbnailSize": format_size(thumbnail_size),
        "exif": exif,
    }
    return {"order": job["order"], "record": record, "warnings": warnings}


def process_photo(
    root: Path,
    raw_assets_dir: Path,
    yaml_path: Path,
    photo_item: Dict[str, Any],
    index: int,
    type_name: str,
    aircraft_id: str,
    squadron_name: str,
    squadron_id: str,
    unit_type: str,
    country: str,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    pin_lookup: Dict[str, str],
    make_demo_images: bool,
    used_photo_ids: set[str],
    warnings: BuildWarningLog,
) -> Optional[Dict[str, Any]]:
    source_value = photo_item.get("path") or photo_item.get("file") or photo_item.get("filepath")
    if not source_value:
        warnings.add(f"photo #{index} in {relative_posix(yaml_path, root)} has no path")
        return None

    source_path = resolve_photo_source(root, raw_assets_dir, yaml_path, source_value)
    if not source_path.exists():
        if make_demo_images:
            make_demo_image(source_path, type_name, squadron_name, str(photo_item.get("location") or photo_item.get("location_name") or ""))
        else:
            warnings.add(f"photo source not found: {relative_posix(source_path, root)}")
            return None

    if source_path.suffix.lower() not in IMAGE_EXTENSIONS:
        warnings.add(f"unsupported image type skipped: {relative_posix(source_path, root)}")
        return None

    photo_id = unique_id(
        f"{type_name}-{squadron_name}-{source_path.stem}-{short_hash(relative_posix(source_path, root))}",
        used_photo_ids,
    )
    output_path = photo_output_dir / f"{photo_id}.jpg"
    thumb_path = thumb_output_dir / f"{photo_id}.jpg"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with Image.open(source_path) as opened:
            exif = extract_exif(opened)
            output_exif = normalized_output_exif(opened)
            original_size = f"{opened.width} x {opened.height}"
            image = ImageOps.exif_transpose(opened)
            image = image.convert("RGB")
            processed = resize_to_width(image, target_width)
            thumbnail = resize_to_width(image, thumb_width)
            save_web_jpeg(
                processed,
                output_path,
                quality=FULL_JPEG_QUALITY,
                subsampling=FULL_JPEG_SUBSAMPLING,
                profile=FULL_JPEG_PROFILE,
                exif=output_exif,
            )
            save_web_jpeg(
                thumbnail,
                thumb_path,
                quality=THUMB_JPEG_QUALITY,
                subsampling=THUMB_JPEG_SUBSAMPLING,
                profile=THUMB_JPEG_PROFILE,
                exif=output_exif,
            )
    except Exception as exc:  # pragma: no cover - depends on source image
        warnings.add(f"could not process {relative_posix(source_path, root)}: {exc}")
        return None

    location_name = str(photo_item.get("location") or photo_item.get("location_name") or "Unknown location").strip()
    explicit_pin = photo_item.get("pin_id") or photo_item.get("pin")
    pin_id = resolve_pin_id(explicit_pin, location_name, pin_lookup)
    photo_date = read_photo_date(photo_item, exif)
    year = str(photo_item.get("year") or (photo_date[:4] if photo_date else "")).strip()

    return {
        "id": photo_id,
        "aircraftId": aircraft_id,
        "aircraftType": type_name,
        "squadronId": squadron_id,
        "squadronName": squadron_name,
        "unitType": unit_type,
        "unitLabel": unit_display_label(unit_type),
        "country": country,
        "year": year,
        "date": photo_date,
        "sortDate": photo_date or (f"{year}-01-01" if year else ""),
        "locationName": location_name,
        "pinId": pin_id,
        "airshow": str(photo_item.get("airshow") or photo_item.get("airshow_name") or "").strip(),
        "livery": str(
            photo_item.get("livery")
            or photo_item.get("paint_scheme")
            or photo_item.get("paintScheme")
            or ""
        ).strip(),
        "title": str(photo_item.get("title") or ""),
        "caption": str(photo_item.get("caption") or ""),
        "image": site_path_for(output_path, root),
        "thumbnail": site_path_for(thumb_path, root),
        "source": site_path_for(source_path, root),
        "originalSize": original_size,
        "processedSize": format_size(processed.size),
        "thumbnailSize": format_size(thumbnail.size),
        "exif": exif,
    }


def read_pin_hero_fields(pin_item: Dict[str, Any]) -> Tuple[str, Any]:
    hero_photo_id = (
        pin_item.get("hero_photo_id")
        or pin_item.get("heroPhotoId")
        or pin_item.get("heroPhotoID")
        or pin_item.get("hero_id")
        or pin_item.get("heroId")
    )
    hero_source: Any = (
        pin_item.get("hero_photo")
        or pin_item.get("hero_image")
        or pin_item.get("hero_path")
        or pin_item.get("heroPhoto")
        or pin_item.get("heroImage")
        or pin_item.get("heroPath")
    )

    hero_block = pin_item.get("hero")
    if isinstance(hero_block, dict):
        hero_photo_id = hero_photo_id or (
            hero_block.get("photo_id")
            or hero_block.get("photoId")
            or hero_block.get("id")
        )
        hero_source = hero_source or (
            hero_block.get("path")
            or hero_block.get("file")
            or hero_block.get("filepath")
            or hero_block.get("image")
            or hero_block.get("source")
        )
    elif hero_source is None and hero_block:
        hero_source = hero_block

    return str(hero_photo_id).strip() if hero_photo_id else "", hero_source_from_value(hero_source)


def read_squadron_hero_source(data: Dict[str, Any], squadron_data: Dict[str, Any]) -> Any:
    for value in (
        data.get("squadron_hero"),
        data.get("squadron_hero_image"),
        data.get("squadronHero"),
        data.get("squadronHeroImage"),
        squadron_data.get("hero_image"),
        squadron_data.get("heroImage"),
        squadron_data.get("hero_photo"),
        squadron_data.get("heroPhoto"),
        squadron_data.get("hero"),
    ):
        source = hero_source_from_value(value)
        if source:
            return source
    return None


def hero_source_from_value(value: Any) -> Any:
    if isinstance(value, dict):
        return (
            value.get("path")
            or value.get("file")
            or value.get("filepath")
            or value.get("image")
            or value.get("source")
        )
    return value


def process_location_hero(
    root: Path,
    raw_assets_dir: Path,
    yaml_path: Path,
    source_value: Any,
    pin_id: str,
    location_name: str,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    warnings: BuildWarningLog,
) -> Optional[Dict[str, Any]]:
    source_path = resolve_pin_asset_source(root, raw_assets_dir, yaml_path, source_value)
    return process_custom_hero(
        root=root,
        source_path=source_path,
        source_value=source_value,
        output_stem=slugify(f"location-hero-{pin_id}"),
        display_label=f"location hero for {location_name}",
        photo_output_dir=photo_output_dir,
        thumb_output_dir=thumb_output_dir,
        target_width=target_width,
        thumb_width=thumb_width,
        warnings=warnings,
    )


def process_squadron_hero(
    root: Path,
    raw_assets_dir: Path,
    yaml_path: Path,
    source_value: Any,
    squadron_id: str,
    squadron_name: str,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    warnings: BuildWarningLog,
) -> Optional[Dict[str, Any]]:
    source_path = resolve_photo_source(root, raw_assets_dir, yaml_path, source_value)
    return process_custom_hero(
        root=root,
        source_path=source_path,
        source_value=source_value,
        output_stem=slugify(f"squadron-hero-{squadron_id}"),
        display_label=f"squadron hero for {squadron_name}",
        photo_output_dir=photo_output_dir,
        thumb_output_dir=thumb_output_dir,
        target_width=target_width,
        thumb_width=thumb_width,
        warnings=warnings,
    )


def process_custom_hero(
    root: Path,
    source_path: Path,
    source_value: Any,
    output_stem: str,
    display_label: str,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    target_width: int,
    thumb_width: int,
    warnings: BuildWarningLog,
) -> Optional[Dict[str, Any]]:
    if not source_path.exists():
        warnings.add(f"{display_label} source not found: {source_value}")
        return None

    if source_path.suffix.lower() not in IMAGE_EXTENSIONS:
        warnings.add(f"unsupported {display_label} image type skipped: {relative_posix(source_path, root)}")
        return None

    output_path = photo_output_dir / f"{output_stem}.jpg"
    thumb_path = thumb_output_dir / f"{output_stem}.jpg"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with Image.open(source_path) as opened:
            output_exif = normalized_output_exif(opened)
            original_size = f"{opened.width} x {opened.height}"
            image = ImageOps.exif_transpose(opened)
            image = image.convert("RGB")
            processed = resize_to_width(image, target_width)
            thumbnail = resize_to_width(image, thumb_width)
            save_web_jpeg(
                processed,
                output_path,
                quality=FULL_JPEG_QUALITY,
                subsampling=FULL_JPEG_SUBSAMPLING,
                profile=FULL_JPEG_PROFILE,
                exif=output_exif,
            )
            save_web_jpeg(
                thumbnail,
                thumb_path,
                quality=THUMB_JPEG_QUALITY,
                subsampling=THUMB_JPEG_SUBSAMPLING,
                profile=THUMB_JPEG_PROFILE,
                exif=output_exif,
            )
    except Exception as exc:  # pragma: no cover - depends on source image
        warnings.add(f"could not process {display_label} {relative_posix(source_path, root)}: {exc}")
        return None

    return {
        "image": site_path_for(output_path, root),
        "thumbnail": site_path_for(thumb_path, root),
        "source": site_path_for(source_path, root),
        "originalSize": original_size,
        "processedSize": format_size(processed.size),
        "thumbnailSize": format_size(thumbnail.size),
    }


def read_yaml_mapping(path: Path, warnings: BuildWarningLog) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    except Exception as exc:
        warnings.add(f"could not read YAML {path}: {exc}")
        return {}

    if not isinstance(data, dict):
        warnings.add(f"YAML root must be a mapping: {path}")
        return {}
    return data


def read_coordinates(item: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    coords = item.get("coordinates") or item.get("coordinate")
    lat_value: Any = None
    lon_value: Any = None

    if isinstance(coords, (list, tuple)) and len(coords) >= 2:
        lat_value, lon_value = coords[0], coords[1]
    elif isinstance(coords, dict):
        lat_value = coords.get("lat") or coords.get("latitude")
        lon_value = coords.get("lon") or coords.get("lng") or coords.get("longitude")
    else:
        lat_value = item.get("lat") or item.get("latitude")
        lon_value = item.get("lon") or item.get("lng") or item.get("longitude")

    try:
        lat = float(lat_value)
        lon = float(lon_value)
    except (TypeError, ValueError):
        return None, None
    return lat, lon


def read_unit_type(data: Dict[str, Any], squadron_data: Dict[str, Any]) -> str:
    values = [
        data.get("unit_type"),
        data.get("unitType"),
        data.get("squadron_type"),
        data.get("squadronType"),
        data.get("operator_type"),
        data.get("operatorType"),
        data.get("entry_type"),
        data.get("entryType"),
        squadron_data.get("unit_type"),
        squadron_data.get("unitType"),
        squadron_data.get("type"),
        squadron_data.get("kind"),
    ]

    if data.get("organisation") is True or data.get("organization") is True:
        return "organisation"
    if squadron_data.get("organisation") is True or squadron_data.get("organization") is True:
        return "organisation"

    for value in values:
        key = normalize_key(str(value or ""))
        if key in {"organisation", "organization", "org"}:
            return "organisation"
    return "squadron"


def read_aircraft_family(data: Dict[str, Any], aircraft_data: Dict[str, Any]) -> str:
    value = (
        data.get("aircraft_family")
        or data.get("aircraftFamily")
        or data.get("family")
        or data.get("aircraft_type_family")
        or data.get("aircraftTypeFamily")
        or aircraft_data.get("family")
    )
    key = normalize_key(str(value or ""))
    return key if key in AIRCRAFT_FAMILIES else str(value or "").strip()


def unit_display_label(unit_type: str) -> str:
    return "Organisation" if unit_type == "organisation" else "Squadron"


def read_photo_date(photo_item: Dict[str, Any], exif: Dict[str, str]) -> str:
    exif_value = exif.get("DateTimeOriginal") or exif.get("DateTimeDigitized")
    normalized = normalize_date_value(exif_value)
    if normalized:
        return normalized

    value = (
        photo_item.get("date")
        or photo_item.get("taken")
        or photo_item.get("taken_at")
        or photo_item.get("captured")
        or photo_item.get("shot_date")
    )
    normalized = normalize_date_value(value)
    if normalized:
        return normalized

    return ""


def normalize_date_value(value: Any) -> str:
    if not value:
        return ""

    if hasattr(value, "isoformat"):
        value = value.isoformat()

    text = str(value).strip()
    match = re.match(r"^(\d{4})[-:/](\d{1,2})[-:/](\d{1,2})", text)
    if match:
        year, month, day = match.groups()
        return f"{year}-{int(month):02d}-{int(day):02d}"

    match = re.match(r"^(\d{4})[-:/](\d{1,2})$", text)
    if match:
        year, month = match.groups()
        return f"{year}-{int(month):02d}-01"

    if re.fullmatch(r"\d{4}", text):
        return f"{text}-01-01"

    return ""


def resize_to_width(image: Image.Image, width: int) -> Image.Image:
    target_width = max(1, int(width))
    new_height = max(1, round(image.height * (target_width / image.width)))
    # LANCZOS is Pillow's highest-quality downsampling/upscaling resampler.
    return image.resize((target_width, new_height), Image.Resampling.LANCZOS)


def publish_squadron_logo(
    source_path: Path,
    dest_path: Path,
    max_size: int,
    warnings: BuildWarningLog,
) -> Optional[Path]:
    suffix = source_path.suffix.lower()
    max_dimension = max(1, int(max_size))

    if suffix == ".svg":
        shutil.copy2(source_path, dest_path)
        return dest_path

    try:
        with Image.open(source_path) as opened:
            image = ImageOps.exif_transpose(opened)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)

            if suffix in (".jpg", ".jpeg"):
                output_path = dest_path.with_suffix(".jpg")
                if image.mode == "RGBA":
                    image = image.convert("RGB")
                image.save(output_path, "JPEG", quality=90, optimize=True)
            elif suffix == ".png" or image.mode == "RGBA":
                output_path = dest_path.with_suffix(".png")
                # Logos have relatively few visually significant colors. An adaptive
                # palette retains transparency and native dimensions while avoiding
                # the much larger true-color RGBA representation on the published site.
                palette_image = image.convert("RGBA").quantize(
                    colors=LOGO_PNG_COLORS,
                    method=Image.Quantize.FASTOCTREE,
                    dither=Image.Dither.FLOYDSTEINBERG,
                )
                palette_image.save(output_path, "PNG", optimize=True, compress_level=9)
            else:
                output_path = dest_path.with_suffix(suffix)
                image.save(output_path, optimize=True)
            return output_path
    except Exception as exc:
        warnings.add(f"could not process squadron logo {source_path.name}: {exc}")
        return None


def format_size(size: Tuple[int, int]) -> str:
    return f"{size[0]} x {size[1]}"


def normalized_output_exif(image: Image.Image) -> bytes:
    try:
        raw = image.getexif()
    except Exception:
        return b""
    if not raw:
        return b""

    orientation_tag = EXIF_TAGS.get("Orientation")
    if orientation_tag:
        raw[orientation_tag] = 1

    try:
        return raw.tobytes()
    except Exception:
        return b""


def read_exif_sub_ifd(raw: Image.Exif) -> Dict[int, Any]:
    """Read the nested EXIF IFD across Pillow versions."""
    ifd_keys: List[Any] = []
    pillow_ifd = getattr(ExifTags, "IFD", None)
    pillow_exif_ifd = getattr(pillow_ifd, "Exif", None)
    if pillow_exif_ifd is not None:
        ifd_keys.append(pillow_exif_ifd)

    exif_offset = EXIF_TAGS.get("ExifOffset")
    if exif_offset:
        ifd_keys.append(exif_offset)
    ifd_keys.append(34665)

    seen: set[Any] = set()
    for ifd_key in ifd_keys:
        if ifd_key in seen:
            continue
        seen.add(ifd_key)
        try:
            exif_ifd = raw.get_ifd(ifd_key)
        except Exception:
            continue
        if exif_ifd:
            return dict(exif_ifd)
    return {}


def extract_exif(image: Image.Image) -> Dict[str, str]:
    try:
        raw = image.getexif()
    except Exception:
        return {}
    if not raw:
        return {}

    exif_ifd = read_exif_sub_ifd(raw)

    def read(tag_name: str) -> Any:
        tag_id = EXIF_TAGS.get(tag_name)
        if not tag_id:
            return None
        if tag_id in exif_ifd:
            return exif_ifd.get(tag_id)
        return raw.get(tag_id)

    make = read("Make")
    model = read("Model")
    lens = read("LensModel") or read("LensMake")
    focal = read("FocalLength")
    aperture = read("FNumber")
    exposure = read("ExposureTime")
    iso = read("ISOSpeedRatings") or read("PhotographicSensitivity") or read("RecommendedExposureIndex")
    captured = read("DateTimeOriginal")
    digitized = read("DateTimeDigitized")
    date_time = read("DateTime")

    exif: Dict[str, str] = {}

    if make:
        exif["Make"] = str(make).strip()
    if model:
        exif["Model"] = str(model).strip()
    if lens:
        exif["LensModel"] = str(lens).strip()
    if focal:
        exif["FocalLength"] = format_focal_length(focal)
    if aperture:
        exif["FNumber"] = format_aperture(aperture)
    if exposure:
        exif["ExposureTime"] = format_exposure(exposure)
    if iso:
        exif["ISO"] = str(iso)
    if captured:
        exif["DateTimeOriginal"] = str(captured)
    if digitized:
        exif["DateTimeDigitized"] = str(digitized)
    if date_time:
        exif["DateTime"] = str(date_time)
    return exif


def format_focal_length(value: Any) -> str:
    numeric = rational_to_float(value)
    if numeric is None:
        return str(value)
    if abs(numeric - round(numeric)) < 0.05:
        return f"{round(numeric)}mm"
    return f"{numeric:.1f}mm"


def format_aperture(value: Any) -> str:
    numeric = rational_to_float(value)
    if numeric is None:
        return str(value)
    return f"f/{numeric:.1f}"


def format_exposure(value: Any) -> str:
    numeric = rational_to_float(value)
    if numeric is None:
        return str(value)
    if numeric > 0 and numeric < 1:
        return f"1/{round(1 / numeric)}s"
    return f"{numeric:g}s"


def rational_to_float(value: Any) -> Optional[float]:
    try:
        if isinstance(value, tuple) and len(value) == 2:
            return float(value[0]) / float(value[1])
        if hasattr(value, "numerator") and hasattr(value, "denominator"):
            return float(value.numerator) / float(value.denominator)
        return float(value)
    except Exception:
        return None


def make_demo_image(path: Path, type_name: str, squadron_name: str, location_name: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(f"{type_name}|{squadron_name}|{location_name}".encode("utf-8")).hexdigest()
    hue = int(digest[:2], 16)
    sky = (82 + hue % 80, 138 + hue % 60, 190 + hue % 45)
    sky_top = tuple(max(0, value - 36) for value in sky)
    runway = (45, 56, 72)
    aircraft = (14, 23, 36)

    width, height = 3072, 2048
    image = Image.new("RGB", (width, height), sky)
    draw = ImageDraw.Draw(image)

    for y in range(height):
        blend = y / height
        color = tuple(round(sky_top[channel] * (1 - blend) + sky[channel] * blend) for channel in range(3))
        draw.line([(0, y), (width, y)], fill=color)

    horizon = int(height * 0.68)
    draw.rectangle([0, horizon, width, height], fill=runway)
    draw.polygon([(0, horizon), (width, horizon - 140), (width, horizon + 90), (0, horizon + 260)], fill=(68, 81, 101))
    draw.line([(0, horizon + 210), (width, horizon - 15)], fill=(215, 225, 238), width=12)

    cx, cy = int(width * 0.52), int(height * 0.44)
    scale = width * 0.26
    body = [
        (cx - int(scale * 0.82), cy + 18),
        (cx + int(scale * 0.74), cy - 18),
        (cx + int(scale * 0.88), cy),
        (cx + int(scale * 0.74), cy + 22),
        (cx - int(scale * 0.82), cy + 54),
    ]
    wing_left = [
        (cx - int(scale * 0.15), cy + 18),
        (cx - int(scale * 0.58), cy + int(scale * 0.42)),
        (cx + int(scale * 0.18), cy + int(scale * 0.16)),
    ]
    wing_right = [
        (cx - int(scale * 0.08), cy + 8),
        (cx - int(scale * 0.48), cy - int(scale * 0.30)),
        (cx + int(scale * 0.18), cy - int(scale * 0.05)),
    ]
    tail = [
        (cx - int(scale * 0.64), cy + 18),
        (cx - int(scale * 0.88), cy - int(scale * 0.20)),
        (cx - int(scale * 0.48), cy),
    ]
    draw.polygon(wing_right, fill=(28, 39, 55))
    draw.polygon(wing_left, fill=(20, 31, 46))
    draw.polygon(body, fill=aircraft)
    draw.polygon(tail, fill=(22, 34, 50))
    draw.ellipse([cx + int(scale * 0.48), cy - 32, cx + int(scale * 0.78), cy + 18], fill=(96, 165, 250))

    label = f"{type_name}\n{squadron_name}\n{location_name}".strip()
    draw.rectangle([92, height - 340, 1220, height - 96], fill=(15, 23, 42))
    draw.multiline_text((128, height - 300), label, fill=(248, 250, 252), spacing=14)
    image.save(path, "JPEG", quality=92, optimize=True)


def resolve_photo_source(root: Path, raw_assets_dir: Path, yaml_path: Path, source_value: Any) -> Path:
    relative_source = Path(str(source_value))
    if relative_source.is_absolute():
        return relative_source.resolve()

    yaml_parent = yaml_path.parent.resolve()
    yaml_parent_relative = relative_posix(yaml_parent, root)
    primary = (raw_assets_dir / yaml_parent_relative / relative_source).resolve()
    legacy = (yaml_parent / relative_source).resolve()
    flat = (raw_assets_dir / relative_source).resolve()

    for candidate in (primary, legacy, flat):
        if candidate.exists():
            return candidate
    return primary


def resolve_pin_asset_source(root: Path, raw_assets_dir: Path, yaml_path: Path, source_value: Any) -> Path:
    relative_source = Path(str(source_value))
    if relative_source.is_absolute():
        return relative_source.resolve()

    yaml_parent = yaml_path.parent.resolve()
    yaml_parent_relative = relative_posix(yaml_parent, root)
    primary = (raw_assets_dir / yaml_parent_relative / relative_source).resolve()
    legacy = (yaml_parent / relative_source).resolve()
    root_relative = (root / relative_source).resolve()
    flat = (raw_assets_dir / relative_source).resolve()

    for candidate in (primary, legacy, root_relative, flat):
        if candidate.exists():
            return candidate
    return primary


def resolve_path(base_dir: Path, value: Any) -> Path:
    path = Path(str(value))
    if path.is_absolute():
        return path
    return (base_dir / path).resolve()


def resolve_squadron_logo(
    root: Path,
    raw_assets_dir: Path,
    logo_output_dir: Path,
    yaml_path: Path,
    logo_value: Any,
    squadron_id: str,
    squadron_name: str,
    logo_max_size: int,
    warnings: BuildWarningLog,
) -> str:
    if not logo_value:
        return ""

    direct_path = resolve_path(yaml_path.parent, logo_value)
    if direct_path.exists():
        source_path = direct_path
    else:
        source_path = resolve_photo_source(root, raw_assets_dir, yaml_path, logo_value)

    if not source_path.exists():
        warnings.add(f"squadron logo not found for {squadron_name}: {logo_value}")
        return ""

    logo_output_dir = logo_output_dir.resolve()
    try:
        source_path.resolve().relative_to(logo_output_dir)
        return site_path_for(source_path, root)
    except ValueError:
        pass

    logo_output_dir.mkdir(parents=True, exist_ok=True)
    dest_path = logo_output_dir / f"{squadron_id}{source_path.suffix.lower()}"
    published_path = publish_squadron_logo(source_path, dest_path, logo_max_size, warnings)
    if not published_path:
        return ""
    return site_path_for(published_path, root)


def site_path_for(path: Path, root: Path) -> str:
    return relative_posix(path.resolve(), root)


def relative_posix(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def resolve_pin_id(explicit_pin: Any, location_name: str, pin_lookup: Dict[str, str]) -> str:
    if explicit_pin:
        explicit = str(explicit_pin)
        if explicit in pin_lookup.values():
            return explicit
        key = normalize_key(explicit)
        if key in pin_lookup:
            return pin_lookup[key]
        return slugify(explicit)
    return pin_lookup.get(normalize_key(location_name), "")


def display_name(value: str) -> str:
    return value.replace("_", " ").replace("-", " ").title()


def normalize_icao(value: Any) -> str:
    code = str(value or "").strip().upper()
    return code


def count_photo_items(data: Dict[str, Any]) -> int:
    photo_items = data.get("photos") or []
    if isinstance(photo_items, dict):
        return 1
    if isinstance(photo_items, list):
        return len(photo_items)
    return 0


def truncate_progress_detail(value: str, max_length: int = 48) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if len(text) <= max_length:
        return text
    if max_length <= 3:
        return "." * max_length
    return text[: max_length - 3] + "..."


def unique_values(values: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def unique_id(value: str, used: set[str]) -> str:
    base = slugify(value)
    candidate = base
    index = 2
    while candidate in used:
        candidate = f"{base}-{index}"
        index += 1
    used.add(candidate)
    return candidate


def short_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:8]


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalized).strip("-").lower()
    return slug or "item"


def normalize_key(value: str) -> str:
    return slugify(value)


if __name__ == "__main__":
    raise SystemExit(main())
