#!/usr/bin/env python3
"""Build the static SpotterDex data bundle and resized web photos."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    import yaml
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing PyYAML. Install with: python3 -m pip install -r requirements.txt") from exc

try:
    from PIL import ExifTags, Image, ImageDraw, ImageOps
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing Pillow. Install with: python3 -m pip install -r requirements.txt") from exc


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
EXIF_TAGS = {value: key for key, value in ExifTags.TAGS.items()}


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


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Build SpotterDex static data and resized JPEG photos.")
    parser.add_argument("--root", type=Path, default=root, help="Project root directory.")
    parser.add_argument("--map-dir", default="map_pins", help="Directory containing country pin folders.")
    parser.add_argument("--aircraft-dir", default="aircraft", help="Directory containing aircraft/type/squadron folders.")
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
    parser.add_argument("--width", type=int, default=2048, help="Processed JPEG width in pixels.")
    parser.add_argument("--thumb-width", type=int, default=640, help="Generated thumbnail width in pixels.")
    parser.add_argument("--logo-max-size", type=int, default=512, help="Maximum squadron logo width or height in pixels.")
    parser.add_argument("--strict", action="store_true", help="Return a non-zero exit code if validation warnings are found.")
    parser.add_argument(
        "--make-demo-images",
        action="store_true",
        help="Create stylized placeholder source photos for missing sample photo paths.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    warnings = BuildWarningLog()

    map_dir = root / args.map_dir
    aircraft_dir = root / args.aircraft_dir
    raw_assets_dir = root / args.raw_assets_dir
    photo_output_dir = root / args.photo_output
    thumb_output_dir = root / args.thumb_output
    logo_output_dir = root / args.logo_output
    json_output = root / args.json_output
    js_output = root / args.js_output

    pins = load_pins(root, map_dir, warnings)
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
        warnings=warnings,
    )

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pins": pins,
        "aircraft": aircraft_entries,
        "photos": photos,
    }

    validate_manifest(manifest, root, warnings)

    json_output.parent.mkdir(parents=True, exist_ok=True)
    js_output.parent.mkdir(parents=True, exist_ok=True)
    json_text = json.dumps(manifest, indent=2, ensure_ascii=True)
    json_output.write_text(json_text + "\n", encoding="utf-8")
    js_output.write_text(f"window.SPOTTERDEX_DATA = {json_text};\n", encoding="utf-8")

    warnings.print()
    print(f"Built {len(aircraft_entries)} aircraft entries, {len(photos)} photos, {len(pins)} pins.")
    print(f"Wrote {relative_posix(json_output, root)}")
    print(f"Wrote {relative_posix(js_output, root)}")
    if args.strict and warnings.has_warnings():
        print("Build completed with validation warnings.", file=sys.stderr)
        return 1
    return 0


def load_pins(root: Path, map_dir: Path, warnings: BuildWarningLog) -> List[Dict[str, Any]]:
    if not map_dir.exists():
        warnings.add(f"map pin directory not found: {relative_posix(map_dir, root)}")
        return []

    pins: List[Dict[str, Any]] = []
    used_ids: set[str] = set()

    for country_dir in sorted(path for path in map_dir.iterdir() if path.is_dir()):
        yaml_files = sorted(list(country_dir.glob("*.yaml")) + list(country_dir.glob("*.yml")))
        if not yaml_files:
            warnings.add(f"no YAML file found in {relative_posix(country_dir, root)}")
            continue

        for yaml_path in yaml_files:
            data = read_yaml_mapping(yaml_path, warnings)
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
                lat, lon = read_coordinates(pin_item)
                if not name or lat is None or lon is None:
                    warnings.add(f"skipping pin #{index} with missing name or coordinates in {relative_posix(yaml_path, root)}")
                    continue
                if not -90 <= lat <= 90 or not -180 <= lon <= 180:
                    warnings.add(f"skipping pin #{index} with invalid coordinates in {relative_posix(yaml_path, root)}")
                    continue

                pin_id = unique_id(str(pin_item.get("id") or f"{country}-{name}"), used_ids)
                pins.append(
                    {
                        "id": pin_id,
                        "name": name,
                        "country": country,
                        "lat": lat,
                        "lon": lon,
                        "enabled": pin_item.get("enabled", True) is not False,
                    }
                )

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
    warnings: BuildWarningLog,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not aircraft_dir.exists():
        warnings.add(f"aircraft directory not found: {relative_posix(aircraft_dir, root)}")
        return [], []

    aircraft_by_id: Dict[str, Dict[str, Any]] = {}
    squadron_by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
    photos: List[Dict[str, Any]] = []
    used_photo_ids: set[str] = set()

    yaml_files = sorted(list(aircraft_dir.glob("*/*/*.yaml")) + list(aircraft_dir.glob("*/*/*.yml")))
    for yaml_path in yaml_files:
        data = read_yaml_mapping(yaml_path, warnings)
        if not data:
            continue

        aircraft_data = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
        squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}

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
            or data.get("squadron")
            or squadron_data.get("name")
            or display_name(yaml_path.parent.name)
        ).strip()
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

        aircraft_entry = aircraft_by_id.setdefault(
            aircraft_id,
            {
                "id": aircraft_id,
                "typeName": type_name,
                "countries": [],
                "squadrons": [],
                "photoIds": [],
                "coverPhoto": None,
            },
        )
        if country and country not in aircraft_entry["countries"]:
            aircraft_entry["countries"].append(country)

        squadron_key = (aircraft_id, squadron_id)
        squadron_entry = squadron_by_key.get(squadron_key)
        if not squadron_entry:
            squadron_entry = {
                "id": squadron_id,
                "name": squadron_name,
                "country": country,
                "logo": logo,
                "photoIds": [],
            }
            squadron_by_key[squadron_key] = squadron_entry
            aircraft_entry["squadrons"].append(squadron_entry)

        photo_items = data.get("photos") or []
        if isinstance(photo_items, dict):
            photo_items = [photo_items]
        if not isinstance(photo_items, list):
            warnings.add(f"photos must be a list in {relative_posix(yaml_path, root)}")
            continue

        for index, photo_item in enumerate(photo_items, start=1):
            if not isinstance(photo_item, dict):
                warnings.add(f"skipping invalid photo #{index} in {relative_posix(yaml_path, root)}")
                continue

            photo_record = process_photo(
                root=root,
                raw_assets_dir=raw_assets_dir,
                yaml_path=yaml_path,
                photo_item=photo_item,
                index=index,
                type_name=type_name,
                aircraft_id=aircraft_id,
                squadron_name=squadron_name,
                squadron_id=squadron_id,
                country=country,
                photo_output_dir=photo_output_dir,
                thumb_output_dir=thumb_output_dir,
                target_width=target_width,
                thumb_width=thumb_width,
                pin_lookup=pin_lookup,
                make_demo_images=make_demo_images,
                used_photo_ids=used_photo_ids,
                warnings=warnings,
            )
            if not photo_record:
                continue

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

        entry["stats"] = {
            "photoCount": len(entry_photos),
            "squadronCount": len(entry.get("squadrons", [])),
            "locationCount": len(locations),
            "locations": locations,
            "firstDate": sort_dates[0] if sort_dates else "",
            "latestDate": sort_dates[-1] if sort_dates else "",
            "countries": sorted(unique_values(entry.get("countries", []))),
        }


def validate_manifest(manifest: Dict[str, Any], root: Path, warnings: BuildWarningLog) -> None:
    pins = manifest.get("pins", [])
    photos = manifest.get("photos", [])
    aircraft_entries = manifest.get("aircraft", [])

    pin_ids: set[str] = set()
    pin_name_keys: set[str] = set()
    enabled_pin_ids: set[str] = set()
    for pin in pins:
        pin_id = str(pin.get("id") or "")
        pin_key = normalize_key(f"{pin.get('country', '')}-{pin.get('name', '')}")
        lat = pin.get("lat")
        lon = pin.get("lon")

        if pin_id in pin_ids:
            warnings.add(f"duplicate pin id in generated manifest: {pin_id}")
        pin_ids.add(pin_id)

        if pin_key in pin_name_keys:
            warnings.add(f"duplicate pin name/country in generated manifest: {pin.get('name')}")
        pin_name_keys.add(pin_key)

        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            warnings.add(f"pin has non-numeric coordinates: {pin.get('name')}")
        elif not -90 <= lat <= 90 or not -180 <= lon <= 180:
            warnings.add(f"pin has out-of-range coordinates: {pin.get('name')}")

        if pin.get("enabled") is not False:
            enabled_pin_ids.add(pin_id)

    photo_ids: set[str] = set()
    source_paths: set[str] = set()
    photo_pin_ids: set[str] = set()
    for photo in photos:
        photo_id = str(photo.get("id") or "")
        if photo_id in photo_ids:
            warnings.add(f"duplicate photo id in generated manifest: {photo_id}")
        photo_ids.add(photo_id)

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

    empty_entries = [entry for entry in aircraft_entries if not entry.get("photoIds")]
    empty_pins = enabled_pin_ids.difference(photo_pin_ids)
    if empty_entries:
        warnings.info(f"{len(empty_entries)} aircraft entries currently have no photos.")
    if empty_pins:
        warnings.info(f"{len(empty_pins)} enabled map pins currently have no matched photos.")


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
            save_kwargs = {"exif": output_exif} if output_exif else {}
            processed.save(output_path, "JPEG", quality=90, optimize=True, progressive=True, **save_kwargs)
            thumbnail.save(thumb_path, "JPEG", quality=82, optimize=True, progressive=True, **save_kwargs)
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
        "country": country,
        "year": year,
        "date": photo_date,
        "sortDate": photo_date or (f"{year}-01-01" if year else ""),
        "locationName": location_name,
        "pinId": pin_id,
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
                image.save(output_path, "PNG", optimize=True)
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
