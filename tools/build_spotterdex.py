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
import sqlite3
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

try:
    from spotterdex_db import connect_database, rows_as_dicts, snapshot_is_current, validate_database
except ImportError:  # Support importing as tools.build_spotterdex.
    from tools.spotterdex_db import connect_database, rows_as_dicts, snapshot_is_current, validate_database


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
SMALL_SOURCE_MAX_WIDTH = 1920
EXIF_TAGS = {value: key for key, value in ExifTags.TAGS.items()}
PROGRESS_LINE_MODE = False

# Attribution used in structured data (JSON-LD) on generated share pages.
SITE_AUTHOR = "Timothy Liu"
SITE_NAME = "SpotterDex"
# Top-level pages included in the generated sitemap, with a relative importance hint.
SITEMAP_TOP_PAGES = (
    ("", "1.0"),
    ("aircraft-dex.html", "0.9"),
    ("squadrons.html", "0.9"),
    ("airshows.html", "0.8"),
    ("stats.html", "0.7"),
)
SHARE_CTA_LABELS = {
    "photo": "Open in SpotterDex",
    "aircraft": "View all frames",
    "location": "Explore this location",
    "squadron": "View squadron archive",
    "airshow": "View event gallery",
}
SHARE_EYEBROWS = {
    "photo": "Photograph",
    "aircraft": "Aircraft field guide",
    "location": "Spotting location",
    "squadron": "Unit markings",
    "airshow": "Airshow",
}
SHARE_PAGE_CSS = (
    ":root{color-scheme:dark}"
    "*{box-sizing:border-box}"
    "body{margin:0;background:#11100f;color:#f3f0ea;"
    "font:16px/1.55 ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",sans-serif}"
    "a{color:inherit}"
    ".sp-head{display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid #37322d}"
    ".sp-brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;"
    "font-weight:600;letter-spacing:.02em}"
    ".sp-brand img{border-radius:6px}"
    ".sp-main{max-width:1040px;margin:0 auto;padding:24px 20px 64px}"
    ".sp-figure{margin:0 0 24px;background:#1a1816;border:1px solid #37322d;"
    "border-radius:8px;overflow:hidden}"
    ".sp-hero{display:block;width:100%;height:auto}"
    ".sp-eyebrow{margin:0 0 6px;text-transform:uppercase;letter-spacing:.14em;"
    "font-size:12px;color:#aaa39a}"
    ".sp-title{margin:0 0 12px;font-size:clamp(1.5rem,3.5vw,2.25rem);line-height:1.15}"
    ".sp-desc{margin:0 0 20px;color:#cfc9bf;max-width:60ch}"
    ".sp-write-up{margin:0 0 24px;padding:18px 20px;background:#211e1b;border:1px solid #37322d;border-radius:8px;max-width:78ch}"
    ".sp-write-up-label{margin:0 0 8px;text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:#aaa39a}"
    ".sp-write-up p:last-child{margin-bottom:0}"
    ".sp-meta{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;margin:0 0 24px;"
    "font-size:14px}"
    ".sp-meta dt{color:#aaa39a}"
    ".sp-meta dd{margin:0}"
    ".sp-cta{display:inline-block;background:#efe9dd;color:#11100f;text-decoration:none;"
    "font-weight:600;padding:12px 22px;border-radius:8px}"
    ".sp-cta:hover{background:#fff}"
    ".sp-note{margin:20px 0 0;font-size:14px}"
    ".sp-note a{color:#aaa39a}"
)


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
    parser.add_argument("--database", default="content/spotterdex.sqlite3", help="Canonical SQLite catalog path.")
    parser.add_argument("--sql-snapshot", default="content/spotterdex.sql", help="Deterministic SQL snapshot path.")
    parser.add_argument(
        "--raw-assets-dir",
        default="raw_assets",
        help="Centralized source directory for original photos to be processed.",
    )
    parser.add_argument("--photo-output", default="assets/generated/photos", help="Processed photo output directory.")
    parser.add_argument("--thumb-output", default="assets/generated/thumbs", help="Generated thumbnail output directory.")
    parser.add_argument("--logo-output", default="assets/logos", help="Published squadron logo output directory.")
    parser.add_argument("--json-output", default="data/spotterdex.json", help="Generated JSON manifest path.")
    parser.add_argument("--js-output", default="data/spotterdex-core.js", help="Generated shared JS manifest path.")
    parser.add_argument(
        "--exif-js-output",
        default="data/spotterdex-exif.js",
        help="Stats-only generated EXIF JS manifest path.",
    )
    parser.add_argument("--share-output", default="share", help="Generated social preview page directory.")
    parser.add_argument("--sitemap-output", default="sitemap.xml", help="Generated sitemap path (relative to root).")
    parser.add_argument("--robots-output", default="robots.txt", help="Generated robots.txt path (relative to root).")
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

    database_path = root / args.database
    if database_path.exists():
        return build_database_catalog(args, root, warnings)
    print(f"Canonical database not found: {relative_posix(database_path, root)}", file=sys.stderr)
    return 1

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
    exif_js_output = root / args.exif_js_output
    map_js_output = root / args.map_js_output
    share_output_dir = root / args.share_output
    sitemap_output = root / args.sitemap_output
    robots_output = root / args.robots_output
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
    propagate_squadron_logos(aircraft_entries, squadron_entries)
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

    remove_unreferenced_logos(manifest, logo_output_dir, root, warnings)
    deduplicate_generated_images(
        manifest=manifest,
        root=root,
        photo_output_dir=photo_output_dir,
        thumb_output_dir=thumb_output_dir,
        warnings=warnings,
    )
    validate_manifest(manifest, root, warnings)

    json_output.parent.mkdir(parents=True, exist_ok=True)
    js_output.parent.mkdir(parents=True, exist_ok=True)
    exif_js_output.parent.mkdir(parents=True, exist_ok=True)
    map_js_output.parent.mkdir(parents=True, exist_ok=True)
    json_text = json.dumps(manifest, indent=2, ensure_ascii=True)
    directory_json_text = json.dumps(
        directory_page_manifest(manifest),
        ensure_ascii=True,
        separators=(",", ":"),
    )
    exif_json_text = json.dumps(exif_page_manifest(manifest), ensure_ascii=True, separators=(",", ":"))
    map_json_text = json.dumps(map_page_manifest(manifest), ensure_ascii=True, separators=(",", ":"))
    json_output.write_text(json_text + "\n", encoding="utf-8")
    # Dex/Squadrons/Airshows load a compact directory payload. Stats loads the
    # camera-only bundle on demand, while the viewer hydrates heavier metadata lazily.
    js_output.write_text(f"window.SPOTTERDEX_DATA={directory_json_text};\n", encoding="utf-8")
    exif_js_output.write_text(f"window.SPOTTERDEX_EXIF={exif_json_text};\n", encoding="utf-8")
    map_js_output.write_text(f"window.SPOTTERDEX_DATA={map_json_text};\n", encoding="utf-8")
    share_records = social_preview_records(manifest)
    share_page_count = write_social_preview_pages(
        records=share_records,
        output_dir=share_output_dir,
        site_url=args.site_url,
    )
    sitemap_path, robots_path, sitemap_url_count = write_seo_files(
        root=root,
        site_url=args.site_url,
        manifest=manifest,
        share_records=share_records,
        sitemap_output=sitemap_output,
        robots_output=robots_output,
    )

    warnings.print()
    print(
        f"Built {len(aircraft_entries)} aircraft entries, {len(squadron_entries)} squadron-only entries, "
        f"{len(photos)} photos, {len(pins)} pins."
    )
    print(f"Wrote {relative_posix(json_output, root)}")
    print(f"Wrote {relative_posix(js_output, root)}")
    print(f"Wrote {relative_posix(exif_js_output, root)}")
    print(f"Wrote {relative_posix(map_js_output, root)}")
    print(f"Wrote {share_page_count} social preview pages under {relative_posix(share_output_dir, root)}")
    print(f"Wrote {relative_posix(sitemap_path, root)} ({sitemap_url_count} URLs)")
    print(f"Wrote {relative_posix(robots_path, root)}")
    if args.strict and warnings.has_warnings():
        print("Build completed with validation warnings.", file=sys.stderr)
        return 1
    return 0


def build_database_catalog(args: argparse.Namespace, root: Path, warnings: BuildWarningLog) -> int:
    """Build the static site from the canonical normalized SQLite catalog."""
    database_path = (root / args.database).resolve()
    snapshot_path = (root / args.sql_snapshot).resolve()
    raw_assets_dir = (root / args.raw_assets_dir).resolve()
    photo_output_dir = (root / args.photo_output).resolve()
    thumb_output_dir = (root / args.thumb_output).resolve()
    logo_output_dir = (root / args.logo_output).resolve()
    json_output = (root / args.json_output).resolve()
    js_output = (root / args.js_output).resolve()
    exif_js_output = (root / args.exif_js_output).resolve()
    share_output_dir = (root / args.share_output).resolve()
    sitemap_output = (root / args.sitemap_output).resolve()
    robots_output = (root / args.robots_output).resolve()

    connection = connect_database(database_path, read_only=True)
    try:
        for error in validate_database(connection, raw_assets_dir=raw_assets_dir):
            warnings.add(error)
        if not snapshot_is_current(connection, snapshot_path):
            warnings.add("content/spotterdex.sql is stale; export the deterministic database snapshot")

        countries = rows_as_dicts(connection, "SELECT id,name FROM countries ORDER BY id")
        aircraft_rows = rows_as_dicts(connection, "SELECT * FROM aircraft ORDER BY name")
        unit_rows = rows_as_dicts(connection, "SELECT * FROM units ORDER BY country_id,name")
        location_rows = rows_as_dicts(connection, "SELECT * FROM locations ORDER BY country_id,name")
        event_rows = rows_as_dicts(connection, "SELECT * FROM events ORDER BY COALESCE(ends_on,''),name DESC")
        aircraft_units = rows_as_dicts(connection, "SELECT aircraft_id,unit_id FROM aircraft_units ORDER BY aircraft_id,unit_id")
        event_locations = rows_as_dicts(connection, "SELECT event_id,location_id FROM event_locations ORDER BY event_id,location_id")
        photo_rows = rows_as_dicts(connection, "SELECT * FROM photos ORDER BY id")
        subject_rows = rows_as_dicts(
            connection,
            "SELECT photo_id,position,aircraft_id,unit_id,is_primary FROM photo_subjects ORDER BY photo_id,position",
        )
    finally:
        connection.close()

    country_by_id = {row["id"]: row for row in countries}
    aircraft_by_id = {row["id"]: row for row in aircraft_rows}
    unit_by_id = {row["id"]: row for row in unit_rows}
    location_by_id = {row["id"]: row for row in location_rows}
    event_by_id = {row["id"]: row for row in event_rows}
    subjects_by_photo: Dict[str, List[Dict[str, Any]]] = {}
    for subject in subject_rows:
        subjects_by_photo.setdefault(str(subject["photo_id"]), []).append(subject)

    logo_by_unit: Dict[str, str] = {}
    for unit in unit_rows:
        logo_by_unit[unit["id"]] = publish_database_logo(
            root=root,
            raw_assets_dir=raw_assets_dir,
            logo_output_dir=logo_output_dir,
            unit=unit,
            max_size=args.logo_max_size,
            warnings=warnings,
        )

    pin_lookup = {normalize_key(row["name"]): row["id"] for row in location_rows}
    photo_jobs: List[Dict[str, Any]] = []
    photo_context: Dict[int, Dict[str, Any]] = {}
    for photo in photo_rows:
        subjects = subjects_by_photo.get(str(photo["id"]), [])
        primary = next((subject for subject in subjects if subject.get("is_primary")), subjects[0] if subjects else {})
        aircraft = aircraft_by_id.get(primary.get("aircraft_id")) or {}
        unit = unit_by_id.get(primary.get("unit_id")) or {}
        location = location_by_id[str(photo["location_id"])]
        event = event_by_id.get(photo.get("event_id")) or {}
        country_id = str(unit.get("country_id") or location["country_id"])
        country = country_by_id[country_id]["name"]
        tag_scope = "aircraft" if aircraft else ("squadron" if unit else "location")
        photo_item = {
            "path": photo["source_path"],
            "location": location["name"],
            "pin_id": location["id"],
            "airshow": event.get("name", ""),
            "date": photo.get("date_override") or "",
            "title": photo.get("title") or "",
            "caption": photo.get("caption") or "",
            "livery": photo.get("livery") or "",
        }
        order = len(photo_jobs)
        photo_jobs.append(
            {
                "order": order,
                "label": photo["source_path"],
                "root": str(root),
                "source_path": str((raw_assets_dir / str(photo["source_path"])).resolve()),
                "output_path": str(photo_output_dir / f"{photo['id']}.jpg"),
                "thumb_path": str(thumb_output_dir / f"{photo['id']}.jpg"),
                "photo_id": photo["id"],
                "photo_item": photo_item,
                "type_name": aircraft.get("name", ""),
                "aircraft_family": aircraft.get("family", ""),
                "aircraft_id": aircraft.get("id", ""),
                "squadron_name": unit.get("name", ""),
                "squadron_id": unit.get("id", ""),
                "unit_type": unit.get("kind", ""),
                "country": country,
                "tag_scope": tag_scope,
                "source_ref": {"photoId": photo["id"]},
                "target_width": args.width,
                "thumb_width": args.thumb_width,
                "pin_lookup": pin_lookup,
                "make_demo_images": args.make_demo_images,
            }
        )
        photo_context[order] = {"database": photo, "subjects": subjects}

    progress = ProgressBar("Processing catalog photos", len(photo_jobs), enabled=not args.no_progress)
    results = process_photo_jobs(photo_jobs, normalize_worker_count(args.workers), progress)
    photos: List[Dict[str, Any]] = []
    normalized_subjects: Dict[str, List[Dict[str, Any]]] = {}
    for order, result in sorted(results.items()):
        for message in result.get("notes", []):
            warnings.info(message)
        for message in result.get("warnings", []):
            warnings.add(message)
        record = result.get("record")
        if not record:
            continue
        context = photo_context[order]
        record["subjects"] = [
            {
                **({"aircraftId": subject["aircraft_id"]} if subject.get("aircraft_id") else {}),
                **({"unitId": subject["unit_id"]} if subject.get("unit_id") else {}),
                "primary": bool(subject.get("is_primary")),
            }
            for subject in context["subjects"]
        ]
        normalized_subjects[record["id"]] = record["subjects"]
        photos.append(record)

    photos.sort(key=lambda item: (item.get("sortDate", ""), item["id"]), reverse=True)
    photos_by_id = {photo["id"]: photo for photo in photos}

    photo_ids_by_aircraft: Dict[str, List[str]] = {row["id"]: [] for row in aircraft_rows}
    photo_ids_by_unit: Dict[str, List[str]] = {row["id"]: [] for row in unit_rows}
    photo_ids_by_location: Dict[str, List[str]] = {row["id"]: [] for row in location_rows}
    photo_ids_by_event: Dict[str, List[str]] = {row["id"]: [] for row in event_rows}
    for photo in photos:
        photo_ids_by_location[photo["pinId"]].append(photo["id"])
        database_photo = next(row for row in photo_rows if row["id"] == photo["id"])
        if database_photo.get("event_id"):
            photo_ids_by_event[str(database_photo["event_id"])].append(photo["id"])
        for subject in normalized_subjects[photo["id"]]:
            if subject.get("aircraftId") and photo["id"] not in photo_ids_by_aircraft[subject["aircraftId"]]:
                photo_ids_by_aircraft[subject["aircraftId"]].append(photo["id"])
            if subject.get("unitId") and photo["id"] not in photo_ids_by_unit[subject["unitId"]]:
                photo_ids_by_unit[subject["unitId"]].append(photo["id"])

    unit_ids_by_aircraft: Dict[str, List[str]] = {row["id"]: [] for row in aircraft_rows}
    for relation in aircraft_units:
        unit_ids_by_aircraft[relation["aircraft_id"]].append(relation["unit_id"])

    legacy_units: Dict[str, Dict[str, Any]] = {}
    for unit in unit_rows:
        record: Dict[str, Any] = {
            "id": unit["id"],
            "name": unit["name"],
            "country": country_by_id[unit["country_id"]]["name"],
            "logo": logo_by_unit[unit["id"]],
            "unitType": unit["kind"],
            "unitLabel": unit_display_label(unit["kind"]),
            "showOnSquadronsPage": unit["kind"] == "squadron",
            "photoIds": photo_ids_by_unit[unit["id"]],
            "aircraftTypes": [
                aircraft_by_id[aid]["name"]
                for aid, unit_ids in unit_ids_by_aircraft.items()
                if unit["id"] in unit_ids
            ],
            "writeUp": unit.get("write_up") or "",
        }
        hero = photos_by_id.get(unit.get("hero_photo_id"))
        if hero:
            record["heroPhoto"] = hero_asset_record(hero)
        legacy_units[unit["id"]] = record

    legacy_aircraft: List[Dict[str, Any]] = []
    for aircraft in aircraft_rows:
        photo_ids = photo_ids_by_aircraft[aircraft["id"]]
        entry = {
            "id": aircraft["id"],
            "typeName": aircraft["name"],
            "aircraftFamily": aircraft["family"],
            "countries": sorted(
                {
                    legacy_units[unit_id]["country"]
                    for unit_id in unit_ids_by_aircraft[aircraft["id"]]
                }
            ),
            "squadrons": [dict(legacy_units[unit_id]) for unit_id in unit_ids_by_aircraft[aircraft["id"]]],
            "photoIds": photo_ids,
            "coverPhoto": aircraft.get("hero_photo_id") or (photo_ids[0] if photo_ids else None),
            "doubleWidth": None if aircraft.get("double_width") is None else bool(aircraft.get("double_width")),
            "writeUp": aircraft.get("write_up") or "",
        }
        legacy_aircraft.append(entry)
    apply_aircraft_stats(legacy_aircraft, photos)

    pins = [
        {
            "id": row["id"],
            "name": row["name"],
            "country": country_by_id[row["country_id"]]["name"],
            "icao": row["icao"],
            "lat": row["latitude"],
            "lon": row["longitude"],
            "enabled": bool(row["enabled"]),
            "writeUp": row.get("write_up") or "",
            **({"heroPhotoId": row["hero_photo_id"]} if row.get("hero_photo_id") else {}),
        }
        for row in location_rows
    ]
    airshows = [
        {
            "id": row["id"],
            "name": row["name"],
            "photoIds": photo_ids_by_event[row["id"]],
            "photoCount": len(photo_ids_by_event[row["id"]]),
            "firstDate": row.get("starts_on") or "",
            "latestDate": row.get("ends_on") or "",
            "writeUp": row.get("write_up") or "",
            **({"heroPhotoId": row["hero_photo_id"]} if row.get("hero_photo_id") else {}),
        }
        for row in event_rows
    ]
    legacy_manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pins": pins,
        "aircraft": legacy_aircraft,
        "squadrons": list(legacy_units.values()),
        "airshows": airshows,
        "photos": photos,
    }
    apply_squadron_stats(legacy_manifest["squadrons"], photos)
    remove_unreferenced_logos(legacy_manifest, logo_output_dir, root, warnings)
    deduplicate_generated_images(legacy_manifest, root, photo_output_dir, thumb_output_dir, warnings)
    validate_manifest(legacy_manifest, root, warnings)

    full_manifest = normalized_v2_manifest(
        generated_at=legacy_manifest["generatedAt"],
        countries=countries,
        aircraft_rows=aircraft_rows,
        unit_rows=unit_rows,
        location_rows=location_rows,
        event_rows=event_rows,
        aircraft_units=aircraft_units,
        event_locations=event_locations,
        photos=photos,
        logo_by_unit=logo_by_unit,
        indexes={
            "photoIdsByAircraft": photo_ids_by_aircraft,
            "photoIdsByUnit": photo_ids_by_unit,
            "photoIdsByLocation": photo_ids_by_location,
            "photoIdsByEvent": photo_ids_by_event,
            "unitIdsByAircraft": unit_ids_by_aircraft,
        },
    )
    core_manifest = normalized_core_manifest(full_manifest)
    exif_manifest = {
        "payload": "exif",
        "schemaVersion": 2,
        "generatedAt": full_manifest["generatedAt"],
        "photos": {
            photo_id: photo.get("exif", {})
            for photo_id, photo in full_manifest["entities"]["photos"].items()
            if photo.get("exif")
        },
    }

    json_output.parent.mkdir(parents=True, exist_ok=True)
    js_output.parent.mkdir(parents=True, exist_ok=True)
    exif_js_output.parent.mkdir(parents=True, exist_ok=True)
    json_output.write_text(json.dumps(full_manifest, indent=2, ensure_ascii=True) + "\n", "utf-8")
    js_output.write_text(
        "window.SPOTTERDEX_DATA=" + json.dumps(core_manifest, ensure_ascii=True, separators=(",", ":")) + ";\n",
        "utf-8",
    )
    exif_js_output.write_text(
        "window.SPOTTERDEX_EXIF=" + json.dumps(exif_manifest, ensure_ascii=True, separators=(",", ":")) + ";\n",
        "utf-8",
    )

    share_records = social_preview_records(legacy_manifest)
    share_count = write_social_preview_pages(share_records, share_output_dir, args.site_url)
    sitemap_path, robots_path, sitemap_count = write_seo_files(
        root=root,
        site_url=args.site_url,
        manifest=legacy_manifest,
        share_records=share_records,
        sitemap_output=sitemap_output,
        robots_output=robots_output,
    )
    warnings.print()
    print(
        f"Built SQLite catalog: {len(aircraft_rows)} aircraft, {len(unit_rows)} units, "
        f"{len(photos)} photos, {len(location_rows)} locations, {len(event_rows)} events."
    )
    print(f"Wrote {relative_posix(json_output, root)}")
    print(f"Wrote {relative_posix(js_output, root)}")
    print(f"Wrote {relative_posix(exif_js_output, root)}")
    print(f"Wrote {share_count} social preview pages under {relative_posix(share_output_dir, root)}")
    print(f"Wrote {relative_posix(sitemap_path, root)} ({sitemap_count} URLs)")
    print(f"Wrote {relative_posix(robots_path, root)}")
    if args.strict and warnings.has_warnings():
        print("Build completed with validation warnings.", file=sys.stderr)
        return 1
    return 0


def publish_database_logo(
    root: Path,
    raw_assets_dir: Path,
    logo_output_dir: Path,
    unit: Dict[str, Any],
    max_size: int,
    warnings: BuildWarningLog,
) -> str:
    value = str(unit.get("logo_source") or "").strip()
    if not value:
        return ""
    root_candidate = (root / value).resolve()
    raw_candidate = (raw_assets_dir / value).resolve()
    source_path = root_candidate if root_candidate.exists() else raw_candidate
    if not source_path.exists():
        warnings.add(f"unit logo not found for {unit['name']}: {value}")
        return ""
    try:
        source_path.relative_to(logo_output_dir)
        return site_path_for(source_path, root)
    except ValueError:
        pass
    logo_output_dir.mkdir(parents=True, exist_ok=True)
    destination = logo_output_dir / f"{unit['id']}{source_path.suffix.lower()}"
    published = publish_squadron_logo(source_path, destination, max_size, warnings)
    return site_path_for(published, root) if published else ""


def hero_asset_record(photo: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: photo[key]
        for key in ("image", "thumbnail", "source", "originalSize", "processedSize", "thumbnailSize")
        if photo.get(key)
    }


def normalized_v2_manifest(
    *,
    generated_at: str,
    countries: List[Dict[str, Any]],
    aircraft_rows: List[Dict[str, Any]],
    unit_rows: List[Dict[str, Any]],
    location_rows: List[Dict[str, Any]],
    event_rows: List[Dict[str, Any]],
    aircraft_units: List[Dict[str, Any]],
    event_locations: List[Dict[str, Any]],
    photos: List[Dict[str, Any]],
    logo_by_unit: Dict[str, str],
    indexes: Dict[str, Dict[str, List[str]]],
) -> Dict[str, Any]:
    event_location_ids: Dict[str, List[str]] = {}
    for relation in event_locations:
        event_location_ids.setdefault(relation["event_id"], []).append(relation["location_id"])
    photo_entities: Dict[str, Dict[str, Any]] = {}
    event_by_name = {row["name"]: row["id"] for row in event_rows}
    for photo in photos:
        photo_entities[photo["id"]] = {
            "id": photo["id"],
            "locationId": photo["pinId"],
            "eventId": event_by_name.get(photo.get("airshow", ""), ""),
            "subjects": photo.get("subjects", []),
            "year": photo.get("year", ""),
            "date": photo.get("date", ""),
            "sortDate": photo.get("sortDate", ""),
            "livery": photo.get("livery", ""),
            "title": photo.get("title", ""),
            "caption": photo.get("caption", ""),
            "image": photo.get("image", ""),
            "thumbnail": photo.get("thumbnail", ""),
            "source": photo.get("source", ""),
            "originalSize": photo.get("originalSize", ""),
            "processedSize": photo.get("processedSize", ""),
            "thumbnailSize": photo.get("thumbnailSize", ""),
            "exif": photo.get("exif", {}),
        }
    return {
        "schemaVersion": 2,
        "generatedAt": generated_at,
        "entities": {
            "countries": {row["id"]: {"id": row["id"], "name": row["name"]} for row in countries},
            "aircraft": {
                row["id"]: {
                    "id": row["id"],
                    "name": row["name"],
                    "family": row["family"],
                    "heroPhotoId": row.get("hero_photo_id") or "",
                    "doubleWidth": None if row.get("double_width") is None else bool(row.get("double_width")),
                    "writeUp": row.get("write_up") or "",
                }
                for row in aircraft_rows
            },
            "units": {
                row["id"]: {
                    "id": row["id"],
                    "name": row["name"],
                    "countryId": row["country_id"],
                    "kind": row["kind"],
                    "logo": logo_by_unit.get(row["id"], ""),
                    "heroPhotoId": row.get("hero_photo_id") or "",
                    "writeUp": row.get("write_up") or "",
                }
                for row in unit_rows
            },
            "locations": {
                row["id"]: {
                    "id": row["id"],
                    "name": row["name"],
                    "countryId": row["country_id"],
                    "icao": row["icao"],
                    "lat": row["latitude"],
                    "lon": row["longitude"],
                    "enabled": bool(row["enabled"]),
                    "heroPhotoId": row.get("hero_photo_id") or "",
                    "writeUp": row.get("write_up") or "",
                }
                for row in location_rows
            },
            "events": {
                row["id"]: {
                    "id": row["id"],
                    "name": row["name"],
                    "startsOn": row.get("starts_on") or "",
                    "endsOn": row.get("ends_on") or "",
                    "locationIds": event_location_ids.get(row["id"], []),
                    "heroPhotoId": row.get("hero_photo_id") or "",
                    "writeUp": row.get("write_up") or "",
                }
                for row in event_rows
            },
            "photos": photo_entities,
        },
        "indexes": indexes,
    }


def normalized_core_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    entities = {key: dict(value) for key, value in manifest["entities"].items()}
    entities["photos"] = {
        photo_id: {
            key: value
            for key, value in photo.items()
            if key not in {"source", "originalSize", "processedSize", "exif"}
        }
        for photo_id, photo in manifest["entities"]["photos"].items()
    }
    return {
        "schemaVersion": 2,
        "payload": "core",
        "generatedAt": manifest["generatedAt"],
        "entities": entities,
        "indexes": manifest["indexes"],
    }


DIRECTORY_PHOTO_OMIT_FIELDS = {
    "exif",
    "originalSize",
    "processedSize",
    "source",
    "sourceRef",
}


def directory_page_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Lean browser bundle for Dex/Squadrons/Airshows/Stats.

    Keeps captions, display fields, and EXIF needed for browsing and photography
    stats, but omits processing metadata. The client hydrates that heavier metadata
    from spotterdex.json when the photo viewer needs it.
    """
    directory_manifest = {
        "payload": "directory",
        "generatedAt": manifest.get("generatedAt"),
        "pins": manifest.get("pins", []),
        "aircraft": manifest.get("aircraft", []),
        "squadrons": manifest.get("squadrons", []),
        "airshows": manifest.get("airshows", []),
        "photos": [
            {key: value for key, value in photo.items() if key not in DIRECTORY_PHOTO_OMIT_FIELDS}
            for photo in manifest.get("photos", [])
        ],
    }
    return directory_manifest


def exif_page_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Return the camera-only payload loaded by the Stats page."""
    return {
        "payload": "exif",
        "generatedAt": manifest.get("generatedAt"),
        "photos": {
            str(photo.get("id")): photo.get("exif", {})
            for photo in manifest.get("photos", [])
            if photo.get("id") and photo.get("exif")
        },
    }


def map_page_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    unit_fields = {
        "country",
        "id",
        "logo",
        "name",
        "showOnSquadronsPage",
        "unitLabel",
        "unitType",
        "writeUp",
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
                "writeUp": entry.get("writeUp", ""),
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
    records: List[Dict[str, Any]],
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
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir.joinpath("share.css").write_text(SHARE_PAGE_CSS + "\n", encoding="utf-8")

    for record in records:
        kind = record["kind"]
        entity_id = record["slug"]
        page_dir = output_dir / kind / entity_id
        page_dir.mkdir(parents=True, exist_ok=True)
        page_dir.joinpath("index.html").write_text(
            social_preview_document(record, site_url, entity_id),
            encoding="utf-8",
        )
    return len(records)


def write_seo_files(
    root: Path,
    site_url: str,
    manifest: Dict[str, Any],
    share_records: List[Dict[str, Any]],
    sitemap_output: Path,
    robots_output: Path,
) -> Tuple[Path, Path, int]:
    site_url = str(site_url or "").strip().rstrip("/") + "/"
    generated_at = str(manifest.get("generatedAt") or "")
    default_lastmod = (
        generated_at[:10]
        if re.match(r"^\d{4}-\d{2}-\d{2}", generated_at)
        else datetime.now(timezone.utc).strftime("%Y-%m-%d")
    )

    entries: List[Tuple[str, str, str]] = []
    for page, priority in SITEMAP_TOP_PAGES:
        entries.append((urljoin(site_url, page), default_lastmod, priority))
    for record in share_records:
        # Skip empty placeholder collection pages so the sitemap only advertises
        # URLs with real content. Photo pages always carry a single image.
        if record["kind"] != "photo" and not _count_label(record.get("count")):
            continue
        loc = urljoin(site_url, f"share/{record['kind']}/{record['slug']}/")
        record_date = str(record.get("date") or "")
        lastmod = (
            record_date
            if record["kind"] == "photo" and re.match(r"^\d{4}-\d{2}-\d{2}$", record_date)
            else default_lastmod
        )
        priority = "0.6" if record["kind"] == "photo" else "0.7"
        entries.append((loc, lastmod, priority))

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for loc, lastmod, priority in entries:
        lines.append("  <url>")
        lines.append(f"    <loc>{html.escape(loc, quote=True)}</loc>")
        lines.append(f"    <lastmod>{lastmod}</lastmod>")
        lines.append(f"    <priority>{priority}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>")
    sitemap_output.parent.mkdir(parents=True, exist_ok=True)
    sitemap_output.write_text("\n".join(lines) + "\n", encoding="utf-8")

    sitemap_url = urljoin(site_url, relative_posix(sitemap_output, root))
    robots_lines = [
        "User-agent: *",
        "Allow: /",
        "",
        f"Sitemap: {sitemap_url}",
        "",
    ]
    robots_output.parent.mkdir(parents=True, exist_ok=True)
    robots_output.write_text("\n".join(robots_lines), encoding="utf-8")
    return sitemap_output, robots_output, len(entries)


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
        heading = f"{subject}{f' at {location}' if location else ''}"
        records.append(
            social_preview_record(
                "photo",
                photo_id,
                title,
                description,
                photo,
                f"photo={quote(photo_id)}",
                extra={
                    "heading": heading,
                    "date": str(photo.get("date") or ""),
                    "year": str(photo.get("year") or ""),
                    "locationName": location,
                    "country": str(photo.get("country") or ""),
                    "aircraftType": str(photo.get("aircraftType") or ""),
                    "unit": str(photo.get("squadronName") or ""),
                    "unitLabel": str(photo.get("unitLabel") or ""),
                    "airshow": str(photo.get("airshow") or ""),
                },
            )
        )

    for aircraft in manifest.get("aircraft", []):
        aircraft_id = str(aircraft.get("id") or "").strip()
        if not aircraft_id:
            continue
        photo_ids = [str(value) for value in aircraft.get("photoIds", [])]
        cover = photos_by_id.get(str(aircraft.get("coverPhoto") or "")) or first_photo(photo_ids, photos_by_id)
        type_name = str(aircraft.get("typeName") or "Aircraft").strip()
        countries = [str(value).strip() for value in aircraft.get("countries", []) if str(value).strip()]
        description = f"Explore {len(photo_ids)} photographed frame{'s' if len(photo_ids) != 1 else ''} of {type_name}, organised by unit and location."
        records.append(
            social_preview_record(
                "aircraft",
                aircraft_id,
                f"{type_name} field guide | SpotterDex",
                description,
                cover or fallback_image,
                f"aircraft={quote(aircraft_id)}",
                extra={
                    "heading": type_name,
                    "count": len(photo_ids),
                    "countries": countries,
                    "writeUp": str(aircraft.get("writeUp") or aircraft.get("write_up") or "").strip(),
                },
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
                extra={
                    "heading": name,
                    "country": country,
                    "icao": str(pin.get("icao") or "").strip(),
                    "count": len(pin_photos),
                    "writeUp": str(pin.get("writeUp") or pin.get("write_up") or "").strip(),
                },
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
                extra={
                    "heading": name,
                    "count": len(photo_ids),
                    "writeUp": str(airshow.get("writeUp") or airshow.get("write_up") or "").strip(),
                },
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
                extra={
                    "heading": name,
                    "country": country,
                    "count": len(photo_ids),
                    "writeUp": str(squadron.get("writeUp") or squadron.get("write_up") or "").strip(),
                },
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
        unit_id = str(unit.get("id") or slugify(f"{country}-{name}"))
        record = by_id.setdefault(
            unit_id,
            {"id": unit_id, "name": name, "country": country, "photoIds": [], "heroPhoto": None, "writeUp": ""},
        )
        record["photoIds"] = unique_values(
            [*record["photoIds"], *[str(value) for value in unit.get("photoIds", [])]]
        )
        if not record["heroPhoto"] and isinstance(unit.get("heroPhoto"), dict):
            record["heroPhoto"] = unit["heroPhoto"]
        if not record["writeUp"]:
            record["writeUp"] = str(unit.get("writeUp") or unit.get("write_up") or "").strip()

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
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    record = {
        "kind": kind,
        "id": entity_id,
        "slug": slugify(entity_id),
        "title": title,
        "description": re.sub(r"\s+", " ", description).strip()[:260],
        "image": str(image.get("image") or image.get("thumbnail") or ""),
        "imageSize": str(image.get("processedSize") or image.get("thumbnailSize") or ""),
        "thumbnail": str(image.get("thumbnail") or ""),
        "fragment": fragment,
    }
    if extra:
        record.update({key: value for key, value in extra.items() if value not in (None, "")})
    return record


def social_preview_document(record: Dict[str, Any], site_url: str, entity_id: str) -> str:
    kind = record["kind"]
    title = html.escape(record["title"], quote=True)
    description = html.escape(record["description"], quote=True)
    heading_text = record.get("heading") or record.get("title") or SITE_NAME
    heading = html.escape(heading_text, quote=True)
    eyebrow = html.escape(SHARE_EYEBROWS.get(kind, "Field guide"), quote=True)
    image_abs = urljoin(site_url, record["image"])
    image_url = html.escape(image_abs, quote=True)
    share_abs = urljoin(site_url, f"share/{kind}/{entity_id}/")
    share_url = html.escape(share_abs, quote=True)
    page_path = {
        "aircraft": "aircraft-dex.html",
        "squadron": "squadrons.html",
        "airshow": "airshows.html",
        "location": "index.html",
        "photo": "index.html",
    }.get(kind, "index.html")
    app_link = f"../../../{page_path}#{record['fragment']}"
    app_link_attr = html.escape(app_link, quote=True)
    cta_label = html.escape(SHARE_CTA_LABELS.get(kind, "Open in SpotterDex"), quote=True)
    width, height = parse_generated_size(record.get("imageSize"))
    dimension_meta = ""
    hero_dimensions = ""
    if width and height:
        dimension_meta = (
            f'\n    <meta property="og:image:width" content="{width}">'
            f'\n    <meta property="og:image:height" content="{height}">'
        )
        hero_dimensions = f' width="{width}" height="{height}"'
    json_ld = render_share_json_ld(record, site_url, image_abs, share_abs, width, height)
    json_ld_block = ""
    if json_ld:
        json_ld_block = f'\n    <script type="application/ld+json">{json_ld}</script>'
    meta_block = render_share_meta(record)
    write_up_block = render_social_write_up(record.get("writeUp"), kind)
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>{title}</title>
    <meta name="description" content="{description}">
    <meta name="robots" content="index,follow,max-image-preview:large">
    <meta name="author" content="{html.escape(SITE_AUTHOR, quote=True)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="SpotterDex">
    <meta property="og:locale" content="en_SG">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{description}">
    <meta property="og:image" content="{image_url}">
    <meta property="og:image:secure_url" content="{image_url}">
    <meta property="og:image:alt" content="{heading}">{dimension_meta}
    <meta property="og:url" content="{share_url}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{title}">
    <meta name="twitter:description" content="{description}">
    <meta name="twitter:image" content="{image_url}">
    <meta name="twitter:image:alt" content="{heading}">
    <link rel="canonical" href="{share_url}">
    <link rel="icon" type="image/png" href="../../../assets/icons/spotterdex-app-icon.png">
    <link rel="stylesheet" href="../../share.css">{json_ld_block}
  </head>
  <body>
    <header class="sp-head">
      <a class="sp-brand" href="../../../index.html">
        <img src="../../../assets/icons/spotterdex-app-icon.png" alt="" width="28" height="28">
        <span>SpotterDex</span>
      </a>
    </header>
    <main class="sp-main">
      <figure class="sp-figure">
        <img class="sp-hero" src="{image_url}" alt="{heading}"{hero_dimensions} loading="eager" decoding="async">
      </figure>
      <p class="sp-eyebrow">{eyebrow}</p>
      <h1 class="sp-title">{heading}</h1>
      <p class="sp-desc">{description}</p>{write_up_block}{meta_block}
      <a class="sp-cta" href="{app_link_attr}">{cta_label}</a>
      <p class="sp-note"><a href="../../../index.html">Back to SpotterDex</a></p>
    </main>
  </body>
</html>
"""


def render_share_meta(record: Dict[str, Any]) -> str:
    kind = record["kind"]
    pairs: List[Tuple[str, str]] = []
    if kind == "photo":
        pairs = [
            ("Aircraft", str(record.get("aircraftType") or "")),
            ("Unit", str(record.get("unit") or "")),
            ("Location", str(record.get("locationName") or "")),
            ("Country", str(record.get("country") or "")),
            ("Event", str(record.get("airshow") or "")),
            ("Date", str(record.get("date") or record.get("year") or "")),
        ]
    elif kind == "aircraft":
        pairs = [
            ("Frames", _count_label(record.get("count"))),
            ("Countries", ", ".join(record.get("countries") or [])),
        ]
    elif kind == "location":
        pairs = [
            ("ICAO", str(record.get("icao") or "")),
            ("Country", str(record.get("country") or "")),
            ("Frames", _count_label(record.get("count"))),
        ]
    elif kind == "squadron":
        pairs = [
            ("Country", str(record.get("country") or "")),
            ("Frames", _count_label(record.get("count"))),
        ]
    elif kind == "airshow":
        pairs = [("Frames", _count_label(record.get("count")))]
    rows = [
        f"        <dt>{html.escape(label, quote=True)}</dt>"
        f"<dd>{html.escape(value, quote=True)}</dd>"
        for label, value in pairs
        if value
    ]
    if not rows:
        return ""
    return "\n      <dl class=\"sp-meta\">\n" + "\n".join(rows) + "\n      </dl>"


def render_social_write_up(value: Any, kind: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    label = f"About this {SHARE_EYEBROWS.get(kind, 'field guide').lower()}"
    paragraphs = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        paragraphs.append(f"        <p>{html.escape(paragraph, quote=True).replace(chr(10), '<br>')}</p>")
    if not paragraphs:
        return ""
    return (
        '\n      <section class="sp-write-up">'
        f'<p class="sp-write-up-label">{html.escape(label, quote=True)}</p>'
        + "".join(paragraphs)
        + "</section>"
    )


def _count_label(value: Any) -> str:
    try:
        count = int(value)
    except (TypeError, ValueError):
        return ""
    if count <= 0:
        return ""
    return f"{count} frame{'s' if count != 1 else ''}"


def render_share_json_ld(
    record: Dict[str, Any],
    site_url: str,
    image_url: str,
    share_url: str,
    width: int,
    height: int,
) -> str:
    author = {"@type": "Person", "name": SITE_AUTHOR}
    website = {"@type": "WebSite", "name": SITE_NAME, "url": site_url}
    credit = f"{SITE_AUTHOR} / {SITE_NAME}"
    if record["kind"] == "photo":
        image_object: Dict[str, Any] = {
            "@context": "https://schema.org",
            "@type": "ImageObject",
            "@id": f"{share_url}#primaryimage",
            "url": image_url,
            "contentUrl": image_url,
            "name": record.get("heading") or record.get("title"),
            "description": record.get("description"),
            "caption": record.get("description"),
            "representativeOfPage": True,
            "creator": author,
            "copyrightHolder": author,
            "creditText": credit,
            "isPartOf": website,
            "mainEntityOfPage": share_url,
        }
        thumbnail = record.get("thumbnail")
        if thumbnail:
            image_object["thumbnailUrl"] = urljoin(site_url, thumbnail)
        if width and height:
            image_object["width"] = width
            image_object["height"] = height
        date_value = record.get("date")
        if date_value:
            image_object["dateCreated"] = date_value
            image_object["datePublished"] = date_value
        location_name = record.get("locationName")
        if location_name:
            place: Dict[str, Any] = {"@type": "Place", "name": location_name}
            country = record.get("country")
            if country:
                place["address"] = {"@type": "PostalAddress", "addressCountry": country}
            image_object["contentLocation"] = place
        keywords = [
            value
            for value in (record.get("aircraftType"), record.get("unit"), record.get("airshow"))
            if value
        ]
        if keywords:
            image_object["keywords"] = ", ".join(keywords)
        return _json_ld_dump(image_object)

    primary_image: Dict[str, Any] = {
        "@type": "ImageObject",
        "url": image_url,
        "contentUrl": image_url,
        "creator": author,
        "creditText": credit,
    }
    if width and height:
        primary_image["width"] = width
        primary_image["height"] = height
    collection = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": share_url,
        "url": share_url,
        "name": record.get("heading") or record.get("title"),
        "description": record.get("description"),
        "isPartOf": website,
        "primaryImageOfPage": primary_image,
        "author": author,
    }
    return _json_ld_dump(collection)


def _json_ld_dump(payload: Dict[str, Any]) -> str:
    cleaned = {key: value for key, value in payload.items() if value not in (None, "")}
    # ensure_ascii keeps the file ASCII-only; escape "<" so a caption can never break out
    # of the surrounding <script type="application/ld+json"> element.
    return json.dumps(cleaned, ensure_ascii=True, separators=(",", ":")).replace("<", "\\u003c")


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
                "writeUp": read_write_up_value(pin_item.get("write_up"), pin_item.get("writeUp")),
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
        aircraft_write_up = read_aircraft_write_up(data, aircraft_data)
        squadron_write_up = read_squadron_write_up(data, squadron_data)
        aircraft_id = slugify(type_name)
        squadron_id = slugify(f"{aircraft_id}-{squadron_name}")
        logo_id = slugify(f"{country}-{squadron_name}")
        logo_value = data.get("squadron_logo") or data.get("squadronLogo") or data.get("logo") or squadron_data.get("logo")
        logo = resolve_squadron_logo(
            root=root,
            raw_assets_dir=raw_assets_dir,
            logo_output_dir=logo_output_dir,
            yaml_path=yaml_path,
            logo_value=logo_value,
            squadron_id=logo_id,
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
                "writeUp": "",
            },
        )
        merge_entity_write_up(
            aircraft_entry,
            aircraft_write_up,
            entity_label=f"aircraft {type_name}",
            source_path=yaml_path,
            root=root,
            warnings=warnings,
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
                "writeUp": "",
            }
            merge_entity_write_up(
                squadron_entry,
                squadron_write_up,
                entity_label=f"squadron {squadron_name}",
                source_path=yaml_path,
                root=root,
                warnings=warnings,
            )
            if squadron_hero:
                squadron_entry["heroPhoto"] = squadron_hero
            squadron_by_key[squadron_key] = squadron_entry
            aircraft_entry["squadrons"].append(squadron_entry)
        elif not squadron_entry.get("heroPhoto") and squadron_hero:
            squadron_entry["heroPhoto"] = squadron_hero
        merge_entity_write_up(
            squadron_entry,
            squadron_write_up,
            entity_label=f"squadron {squadron_name}",
            source_path=yaml_path,
            root=root,
            warnings=warnings,
        )

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


def propagate_squadron_logos(
    aircraft_entries: List[Dict[str, Any]],
    squadron_entries: List[Dict[str, Any]],
) -> None:
    """Share each unit's resolved logo across all manifest records."""
    units = list(squadron_entries)
    for aircraft_entry in aircraft_entries:
        units.extend(aircraft_entry.get("squadrons", []))

    logos_by_identity: Dict[Tuple[str, str], str] = {}
    for unit in units:
        identity = (
            normalize_key(f"{unit.get('country', '')}-{unit.get('name', '')}"),
            str(unit.get("unitType", "squadron")),
        )
        logo = str(unit.get("logo") or "").strip()
        if logo and identity not in logos_by_identity:
            logos_by_identity[identity] = logo

    for unit in units:
        identity = (
            normalize_key(f"{unit.get('country', '')}-{unit.get('name', '')}"),
            str(unit.get("unitType", "squadron")),
        )
        logo = logos_by_identity.get(identity)
        if logo:
            unit["logo"] = logo


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
                "writeUp": "",
            }
            merge_entity_write_up(
                squadron_entry,
                read_squadron_write_up(data, squadron_data, standalone=True),
                entity_label=f"squadron {squadron_name}",
                source_path=yaml_path,
                root=root,
                warnings=warnings,
            )
            if hero:
                squadron_entry["heroPhoto"] = hero
            squadrons_by_key[squadron_key] = squadron_entry
        elif not squadron_entry.get("logo") and logo:
            squadron_entry["logo"] = logo
        merge_entity_write_up(
            squadron_entry,
            read_squadron_write_up(data, squadron_data, standalone=True),
            entity_label=f"squadron {squadron_name}",
            source_path=yaml_path,
            root=root,
            warnings=warnings,
        )
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
    configured_write_ups: Dict[str, str] = {}
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
                configured_write_ups[event_key] = read_write_up_value(item.get("write_up"), item.get("writeUp"))

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
            "writeUp": configured_write_ups.get(event_key, ""),
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

        if icao and not re.fullmatch(r"[A-Z0-9]{2,4}", icao):
            warnings.add(f"pin has invalid map code: {pin.get('name')} -> {icao}")

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


def full_output_width(source_width: int, configured_width: int) -> int:
    """Choose the full-size derivative width for a source image.

    Sources at or below 1920px are intentionally upscaled to no more than
    1920px. Larger sources retain the existing configured 2560px target.
    """
    requested_width = max(1, int(configured_width))
    if int(source_width) <= SMALL_SOURCE_MAX_WIDTH:
        return min(requested_width, SMALL_SOURCE_MAX_WIDTH)
    return requested_width


def _manifest_generated_asset_references(manifest: Dict[str, Any]) -> set[str]:
    references: set[str] = set()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {"image", "thumbnail"} and isinstance(item, str):
                    references.add(item)
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(manifest)
    return references


def remove_unreferenced_logos(
    manifest: Dict[str, Any],
    logo_output_dir: Path,
    root: Path,
    warnings: BuildWarningLog,
) -> None:
    """Remove stale generated logos after canonical unit names are rebuilt."""
    referenced: set[str] = set()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "logo" and isinstance(item, str) and item.startswith("assets/logos/"):
                    referenced.add(item)
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(manifest)
    if not logo_output_dir.exists():
        return

    removed = 0
    for path in logo_output_dir.iterdir():
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS | {".svg"}:
            continue
        if site_path_for(path, root) in referenced:
            continue
        try:
            path.unlink()
            removed += 1
        except OSError as exc:
            warnings.add(f"could not remove stale logo {relative_posix(path, root)}: {exc}")
    if removed:
        warnings.info(f"removed {removed} stale squadron logo file(s) after canonicalization")


def _rewrite_manifest_generated_assets(value: Any, replacements: Dict[str, str]) -> None:
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if key in {"image", "thumbnail"} and isinstance(item, str):
                value[key] = replacements.get(item, item)
            else:
                _rewrite_manifest_generated_assets(item, replacements)
    elif isinstance(value, list):
        for item in value:
            _rewrite_manifest_generated_assets(item, replacements)


def deduplicate_generated_images(
    manifest: Dict[str, Any],
    root: Path,
    photo_output_dir: Path,
    thumb_output_dir: Path,
    warnings: BuildWarningLog,
) -> None:
    """Reuse one generated file for byte-identical photo derivatives.

    Heroes often point at the same source frame as a normal photo. Their
    semantic filenames are useful while processing, but the published bundle
    should contain one copy of identical full-size and thumbnail bytes.
    """
    referenced_paths = _manifest_generated_asset_references(manifest)
    replacements: Dict[str, str] = {}
    removed_files = 0
    saved_bytes = 0

    for output_dir in (photo_output_dir, thumb_output_dir):
        if not output_dir.exists():
            continue

        by_digest: Dict[str, List[Path]] = {}
        for path in sorted(output_dir.glob("*.jpg")):
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError as exc:
                warnings.add(f"could not hash generated image {relative_posix(path, root)}: {exc}")
                continue
            by_digest.setdefault(digest, []).append(path)

        for paths in by_digest.values():
            if len(paths) < 2:
                continue
            canonical = min(
                paths,
                key=lambda path: (
                    site_path_for(path, root) not in referenced_paths,
                    site_path_for(path, root),
                ),
            )
            for duplicate in paths:
                if duplicate == canonical:
                    continue
                duplicate_site_path = site_path_for(duplicate, root)
                try:
                    duplicate_size = duplicate.stat().st_size
                    duplicate.unlink()
                except OSError as exc:
                    warnings.add(f"could not remove duplicate generated image {duplicate_site_path}: {exc}")
                    continue
                replacements[duplicate_site_path] = site_path_for(canonical, root)
                removed_files += 1
                saved_bytes += duplicate_size

    if replacements:
        _rewrite_manifest_generated_assets(manifest, replacements)
        warnings.info(
            f"deduplicated {removed_files} generated image files "
            f"({saved_bytes / (1024 * 1024):.2f} MiB saved)."
        )


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
            output_exif = normalized_output_exif(opened)
            image = ImageOps.exif_transpose(opened).convert("RGB")
            processed_width = full_output_width(image.width, int(job["target_width"]))
            if reuse_existing:
                with Image.open(output_path) as processed_image, Image.open(thumb_path) as thumbnail_image:
                    processed_size = processed_image.size
                    thumbnail_size = thumbnail_image.size
                    full_profile_matches = jpeg_matches_profile(processed_image, FULL_JPEG_PROFILE)
                    thumb_profile_matches = jpeg_matches_profile(thumbnail_image, THUMB_JPEG_PROFILE)
                # A changed build width or thumbnail width requires a fresh output,
                # even when the source image has not changed.
                reuse_existing = (
                    processed_size[0] == processed_width
                    and thumbnail_size[0] == int(job["thumb_width"])
                    and full_profile_matches
                    and thumb_profile_matches
                )
            if not reuse_existing:
                processed = resize_to_width(image, processed_width)
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
            image = ImageOps.exif_transpose(opened).convert("RGB")
            processed = resize_to_width(image, full_output_width(image.width, target_width))
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


def read_write_up_value(*values: Any) -> str:
    """Read an optional page write-up while keeping intentional line breaks."""
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def read_aircraft_write_up(data: Dict[str, Any], aircraft_data: Dict[str, Any]) -> str:
    return read_write_up_value(
        data.get("aircraft_write_up"),
        data.get("aircraftWriteUp"),
        aircraft_data.get("write_up"),
        aircraft_data.get("writeUp"),
        data.get("write_up"),
        data.get("writeUp"),
    )


def read_squadron_write_up(
    data: Dict[str, Any],
    squadron_data: Dict[str, Any],
    standalone: bool = False,
) -> str:
    values = [
        data.get("squadron_write_up"),
        data.get("squadronWriteUp"),
        squadron_data.get("write_up"),
        squadron_data.get("writeUp"),
    ]
    if standalone:
        values.extend((data.get("write_up"), data.get("writeUp")))
    return read_write_up_value(*values)


def merge_entity_write_up(
    record: Dict[str, Any],
    write_up: str,
    entity_label: str,
    source_path: Path,
    root: Path,
    warnings: BuildWarningLog,
) -> None:
    """Keep one write-up for an aggregate entity and report conflicting sources."""
    value = read_write_up_value(write_up)
    if not value:
        return
    existing = read_write_up_value(record.get("writeUp"), record.get("write_up"))
    if existing and existing != value:
        warnings.add(
            f"conflicting write-ups for {entity_label}; keeping the first value "
            f"and ignoring {relative_posix(source_path, root)}"
        )
        return
    record["writeUp"] = existing or value


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
            image = ImageOps.exif_transpose(opened).convert("RGB")
            processed = resize_to_width(image, full_output_width(image.width, target_width))
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
    focal_35mm = read("FocalLengthIn35mmFilm")
    aperture = read("FNumber")
    exposure = read("ExposureTime")
    exposure_bias = read("ExposureBiasValue")
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
    if focal_35mm:
        exif["FocalLengthIn35mmFilm"] = format_focal_length(focal_35mm)
    if aperture:
        exif["FNumber"] = format_aperture(aperture)
    if exposure:
        exif["ExposureTime"] = format_exposure(exposure)
    if exposure_bias is not None:
        exif["ExposureBiasValue"] = format_exposure_bias(exposure_bias)
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


def format_exposure_bias(value: Any) -> str:
    numeric = rational_to_float(value)
    if numeric is None:
        return str(value)
    if abs(numeric) < 0.05:
        numeric = 0.0
    return f"{numeric:.1f}"


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
    existing_outputs = sorted(
        path for path in logo_output_dir.glob(f"{squadron_id}.*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS | {".svg"}
    )
    if existing_outputs and max(path.stat().st_mtime_ns for path in existing_outputs) >= source_path.stat().st_mtime_ns:
        return site_path_for(existing_outputs[0], root)

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
