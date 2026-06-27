#!/usr/bin/env python3
"""Local SpotterDex data manager.

This intentionally stays dependency-light: it uses the Python standard library
for the web server plus the same PyYAML and Pillow dependencies as the existing
SpotterDex build script.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

try:
    import yaml
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing PyYAML. Install with: python3 -m pip install -r requirements.txt") from exc

try:
    from PIL import Image, ImageOps
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing Pillow. Install with: python3 -m pip install -r requirements.txt") from exc


ROOT = Path(__file__).resolve().parents[1]
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
CACHE_DIR = ROOT / ".spotterdex-manager-cache"
THUMB_DIR = CACHE_DIR / "thumbs"


class FlowList(list):
    """Marker used to preserve compact coordinate arrays in YAML output."""


class SpotterDexDumper(yaml.SafeDumper):
    pass


MISSING_FIELD_LABELS = {
    "source": "Source image",
    "location": "Location",
    "caption": "Caption",
    "captureDate": "Date or EXIF",
    "aircraftType": "Aircraft type",
    "aircraftFamily": "Aircraft family",
    "squadronName": "Unit name",
    "squadronLogo": "Squadron logo",
    "country": "Country",
}


def _represent_flow_list(dumper: yaml.Dumper, value: FlowList) -> yaml.Node:
    return dumper.represent_sequence("tag:yaml.org,2002:seq", list(value), flow_style=True)


SpotterDexDumper.add_representer(FlowList, _represent_flow_list)


@dataclass
class RequestContext:
    manager: "SpotterDexManager"


class SpotterDexManager:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.aircraft_dir = self.root / "aircraft"
        self.map_dir = self.root / "map_pins"
        self.raw_assets_dir = self.root / "raw_assets"
        self._exif_date_cache: Dict[str, str] = {}

    def get_state(self) -> Dict[str, Any]:
        tag_map: Dict[str, List[Dict[str, Any]]] = {}
        pins, pin_by_id, pin_by_name = self._scan_pins(tag_map)
        aircraft = self._scan_aircraft(tag_map, pin_by_id, pin_by_name)
        assets = self._scan_assets(tag_map)
        used_count = sum(1 for asset in assets if asset["tags"])
        missing_photo_count = sum(
            1
            for entry in aircraft
            for photo in entry.get("photos", [])
            if photo.get("exists") is False
        )
        missing_field_photo_count = sum(
            1
            for entry in aircraft
            for photo in entry.get("photos", [])
            if photo.get("missingFields")
        )
        missing_entry_field_count = sum(1 for entry in aircraft if entry.get("entryMissingFields"))

        return {
            "project": {
                "root": self.root.as_posix(),
                "aircraftCount": len(aircraft),
                "pinCount": len(pins),
                "assetCount": len(assets),
                "taggedAssetCount": used_count,
                "untaggedAssetCount": len(assets) - used_count,
                "missingPhotoCount": missing_photo_count,
                "missingFieldPhotoCount": missing_field_photo_count,
                "missingEntryFieldCount": missing_entry_field_count,
            },
            "aircraft": aircraft,
            "pins": pins,
            "assets": assets,
        }

    def append_photos(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        entry_path = self._project_path(payload.get("entryPath") or "")
        if not entry_path or not entry_path.exists() or entry_path.name not in {"entry.yaml", "entry.yml"}:
            raise ValueError("Choose an aircraft entry before attaching assets.")
        if not self._is_within(entry_path, self.aircraft_dir):
            raise ValueError("Entry path is outside the aircraft directory.")

        asset_paths = payload.get("assetPaths") or []
        if not isinstance(asset_paths, list) or not asset_paths:
            raise ValueError("Select at least one raw asset.")

        data = read_yaml(entry_path)
        photos = data.get("photos")
        if photos is None:
            photos = []
            data["photos"] = photos
        if not isinstance(photos, list):
            raise ValueError(f"photos must be a list in {relative_posix(entry_path, self.root)}")

        location_name = clean_text(payload.get("locationName"))
        pin_id = clean_text(payload.get("pinId"))
        caption = clean_text(payload.get("caption"))
        date = clean_text(payload.get("date"))
        year = clean_year(payload.get("year") or (date[:4] if date else ""))
        dedupe = payload.get("dedupe", True) is not False

        existing = {
            str(item.get("path") or item.get("file") or item.get("filepath") or "")
            for item in photos
            if isinstance(item, dict)
        }
        appended: List[str] = []
        skipped: List[str] = []

        for value in asset_paths:
            asset_path = self._raw_asset_path(value)
            if not asset_path.exists():
                skipped.append(f"{value} (missing)")
                continue
            if asset_path.suffix.lower() not in IMAGE_EXTENSIONS:
                skipped.append(f"{value} (unsupported type)")
                continue

            asset_rel = relative_posix(asset_path, self.raw_assets_dir)
            yaml_photo_path = photo_yaml_path_for_asset(entry_path, self.root, asset_rel)
            if dedupe and yaml_photo_path in existing:
                skipped.append(f"{asset_rel} (already in entry)")
                continue

            item: Dict[str, Any] = {"path": yaml_photo_path}
            if date:
                item["date"] = date
            if year:
                item["year"] = int(year) if year.isdigit() else year
            if location_name:
                item["location"] = location_name
            if pin_id:
                item["pin_id"] = pin_id
            if caption:
                item["caption"] = caption
            photos.append(item)
            existing.add(yaml_photo_path)
            appended.append(asset_rel)

        write_yaml(entry_path, data)
        return {
            "ok": True,
            "message": f"Attached {len(appended)} asset(s).",
            "appended": appended,
            "skipped": skipped,
        }

    def update_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        entry_path = self._project_path(payload.get("entryPath") or "")
        index = int(payload.get("index"))
        if not entry_path or not entry_path.exists() or not self._is_within(entry_path, self.aircraft_dir):
            raise ValueError("Entry path is invalid.")

        data = read_yaml(entry_path)
        photos = data.get("photos")
        if not isinstance(photos, list) or index < 0 or index >= len(photos):
            raise ValueError("Photo index is invalid.")
        if not isinstance(photos[index], dict):
            photos[index] = {}

        incoming = payload.get("photo") or {}
        if not isinstance(incoming, dict):
            raise ValueError("Photo payload must be an object.")
        path_value = clean_text(incoming.get("path"))
        if not path_value:
            raise ValueError("Photo path is required.")

        updated: Dict[str, Any] = {"path": path_value}
        for key in ("date", "year", "location", "pin_id", "title", "caption"):
            value = clean_text(incoming.get(key))
            if not value:
                continue
            if key == "year" and value.isdigit():
                updated[key] = int(value)
            else:
                updated[key] = value
        photos[index] = updated
        write_yaml(entry_path, data)
        return {"ok": True, "message": "Photo updated."}

    def delete_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        entry_path = self._project_path(payload.get("entryPath") or "")
        index = int(payload.get("index"))
        if not entry_path or not entry_path.exists() or not self._is_within(entry_path, self.aircraft_dir):
            raise ValueError("Entry path is invalid.")

        data = read_yaml(entry_path)
        photos = data.get("photos")
        if not isinstance(photos, list) or index < 0 or index >= len(photos):
            raise ValueError("Photo index is invalid.")

        removed = photos.pop(index)
        write_yaml(entry_path, data)
        return {
            "ok": True,
            "message": "Photo removed.",
            "removed": removed if isinstance(removed, dict) else str(removed),
        }

    def update_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        entry_path = self._project_path(payload.get("entryPath") or "")
        if not entry_path or not entry_path.exists() or not self._is_within(entry_path, self.aircraft_dir):
            raise ValueError("Entry path is invalid.")

        data = read_yaml(entry_path)
        aircraft_type = clean_text(payload.get("aircraftType"))
        aircraft_family = normalize_aircraft_family(payload.get("aircraftFamily"))
        squadron_name = clean_text(payload.get("squadronName"))
        squadron_logo = clean_text(payload.get("squadronLogo"))
        country = clean_text(payload.get("country"))
        unit_type = clean_text(payload.get("unitType")) or "squadron"
        if unit_type not in {"squadron", "organisation"}:
            unit_type = "squadron"
        if aircraft_type:
            data["aircraft_type"] = aircraft_type
        if aircraft_family:
            data["aircraft_family"] = aircraft_family
        if squadron_name:
            data["squadron_name"] = squadron_name
        if squadron_logo:
            data["squadron_logo"] = squadron_logo
        if country:
            data["country"] = country
        if unit_type == "organisation":
            data["unit_type"] = "organisation"
        elif data.get("unit_type") == "organisation":
            data.pop("unit_type", None)

        write_yaml(entry_path, data)
        return {"ok": True, "message": "Entry metadata updated."}

    def create_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        aircraft_type = clean_text(payload.get("aircraftType"))
        squadron_name = clean_text(payload.get("squadronName"))
        country = clean_text(payload.get("country"))
        unit_type = clean_text(payload.get("unitType")) or "squadron"
        if not aircraft_type or not squadron_name or not country:
            raise ValueError("Aircraft type, unit name, and country are required.")
        if unit_type not in {"squadron", "organisation"}:
            unit_type = "squadron"

        entry_dir = self.aircraft_dir / slugify(aircraft_type) / slugify(squadron_name)
        entry_path = entry_dir / "entry.yaml"
        if entry_path.exists():
            raise ValueError(f"Entry already exists: {relative_posix(entry_path, self.root)}")

        entry_dir.mkdir(parents=True, exist_ok=True)
        data: Dict[str, Any] = {
            "aircraft_type": aircraft_type,
            "squadron_name": squadron_name,
            "country": country,
        }
        if unit_type == "organisation":
            data["unit_type"] = "organisation"
        data["photos"] = []
        write_yaml(entry_path, data)
        return {
            "ok": True,
            "message": "Entry created.",
            "entryPath": relative_posix(entry_path, self.root),
        }

    def create_pin(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        country = clean_text(payload.get("country"))
        name = clean_text(payload.get("name"))
        icao = clean_text(payload.get("icao")).upper()
        lat = parse_float(payload.get("lat"), "Latitude")
        lon = parse_float(payload.get("lon"), "Longitude")
        if not country or not name:
            raise ValueError("Country and location name are required.")
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ValueError("Coordinates are outside valid latitude/longitude ranges.")

        country_dir = self.map_dir / slugify(country).replace("-", "_")
        yaml_path = country_dir / "pins.yaml"
        if yaml_path.exists():
            data = read_yaml(yaml_path)
            if not isinstance(data.get("pins"), list):
                data["pins"] = []
            data["country"] = clean_text(data.get("country")) or country
        else:
            country_dir.mkdir(parents=True, exist_ok=True)
            data = {"country": country, "pins": []}

        existing_ids = {
            str(item.get("id") or "")
            for item in data.get("pins", [])
            if isinstance(item, dict)
        }
        pin_id = clean_text(payload.get("id")) or slugify(name)
        pin_id = unique_slug(slugify(pin_id), existing_ids)

        item: Dict[str, Any] = {
            "id": pin_id,
            "name": name,
            "icao": icao,
            "coordinates": FlowList([lat, lon]),
            "enabled": payload.get("enabled", True) is not False,
        }
        data["pins"].append(item)
        write_yaml(yaml_path, data)
        return {
            "ok": True,
            "message": "Pin created.",
            "pinId": pin_id,
            "pinPath": relative_posix(yaml_path, self.root),
        }

    def set_pin_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        pin_path = self._project_path(payload.get("pinPath") or "")
        pin_id = clean_text(payload.get("pinId"))
        asset_path = self._raw_asset_path(payload.get("assetPath") or "")
        if not pin_path or not pin_path.exists() or not self._is_within(pin_path, self.map_dir):
            raise ValueError("Choose a map pin first.")
        if not pin_id:
            raise ValueError("Pin id is required.")
        if not asset_path.exists() or asset_path.suffix.lower() not in IMAGE_EXTENSIONS:
            raise ValueError("Choose one image asset to use as the location hero.")

        data = read_yaml(pin_path)
        pins = data.get("pins")
        if not isinstance(pins, list):
            raise ValueError(f"pins must be a list in {relative_posix(pin_path, self.root)}")

        target: Optional[Dict[str, Any]] = None
        for item in pins:
            if isinstance(item, dict) and str(item.get("id") or "") == pin_id:
                target = item
                break
        if target is None:
            raise ValueError("Pin was not found in its YAML file.")

        asset_rel = relative_posix(asset_path, self.raw_assets_dir)
        target["hero_photo"] = pin_hero_yaml_path_for_asset(pin_path, self.root, asset_rel)
        write_yaml(pin_path, data)
        return {"ok": True, "message": "Location hero updated."}

    def run_build(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        stdout: List[str] = []
        stderr: List[str] = []
        summary: Dict[str, Any] = {}
        done: Dict[str, Any] = {}
        for event_name, event_payload in self.stream_build(strict=payload.get("strict") is True):
            if event_name == "log":
                target = stderr if event_payload.get("stream") == "stderr" else stdout
                target.append(str(event_payload.get("line") or ""))
            elif event_name == "summary":
                summary = event_payload
            elif event_name == "done":
                done = event_payload
        return {
            "ok": done.get("ok", False),
            "returncode": done.get("returncode", 1),
            "durationSeconds": done.get("durationSeconds", 0),
            "stdout": "\n".join(stdout),
            "stderr": "\n".join(stderr),
            "summary": summary,
            "message": done.get("message", "Build failed."),
        }

    def stream_build(self, strict: bool = False) -> Iterable[Tuple[str, Dict[str, Any]]]:
        before_snapshot = snapshot_generated_outputs(self.root)
        before_counts = read_manifest_counts(self.root)
        command = [sys.executable, "-u", "tools/build_spotterdex.py", "--progress-lines"]
        if strict:
            command.append("--strict")

        yield (
            "status",
            {
                "message": "Snapshot captured. Starting generator.",
                "command": " ".join(command),
            },
        )

        started = time.time()
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        process = subprocess.Popen(
            command,
            cwd=self.root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        output_queue: "queue.Queue[Tuple[str, Optional[str]]]" = queue.Queue()

        def read_pipe(stream_name: str, pipe: Any) -> None:
            try:
                for line in pipe:
                    output_queue.put((stream_name, line.rstrip("\n")))
            finally:
                output_queue.put((stream_name, None))

        threads = [
            threading.Thread(target=read_pipe, args=("stdout", process.stdout), daemon=True),
            threading.Thread(target=read_pipe, args=("stderr", process.stderr), daemon=True),
        ]
        for thread in threads:
            thread.start()

        try:
            warnings: List[str] = []
            notes: List[str] = []
            open_streams = len(threads)
            while open_streams:
                stream_name, line = output_queue.get()
                if line is None:
                    open_streams -= 1
                    continue
                classification = classify_build_line(line)
                if classification == "warning":
                    warnings.append(line)
                elif classification == "note":
                    notes.append(line)
                yield (
                    "log",
                    {
                        "stream": stream_name,
                        "line": line,
                        "kind": classification,
                        "elapsedSeconds": round(time.time() - started, 2),
                    },
                )

            returncode = process.wait()
            for thread in threads:
                thread.join(timeout=1)

            after_snapshot = snapshot_generated_outputs(self.root)
            after_counts = read_manifest_counts(self.root)
            summary = build_generated_summary(
                root=self.root,
                before_snapshot=before_snapshot,
                after_snapshot=after_snapshot,
                before_counts=before_counts,
                after_counts=after_counts,
                warnings=warnings,
                notes=notes,
                returncode=returncode,
            )
            duration = round(time.time() - started, 2)
            yield ("summary", summary)
            yield (
                "done",
                {
                    "ok": returncode == 0,
                    "returncode": returncode,
                    "durationSeconds": duration,
                    "message": "Build finished." if returncode == 0 else "Build failed.",
                },
            )
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()

    def make_thumbnail(self, asset_rel: str) -> Tuple[bytes, str]:
        asset_path = self._raw_asset_path(asset_rel)
        if not asset_path.exists() or asset_path.suffix.lower() not in IMAGE_EXTENSIONS:
            raise FileNotFoundError(asset_rel)
        stat = asset_path.stat()
        cache_key = hashlib.sha1(
            f"{relative_posix(asset_path, self.raw_assets_dir)}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8")
        ).hexdigest()
        thumb_path = THUMB_DIR / f"{cache_key}.jpg"
        if not thumb_path.exists():
            THUMB_DIR.mkdir(parents=True, exist_ok=True)
            with Image.open(asset_path) as opened:
                image = ImageOps.exif_transpose(opened)
                image.thumbnail((640, 420), Image.Resampling.LANCZOS)
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                elif image.mode == "L":
                    image = image.convert("RGB")
                image.save(thumb_path, "JPEG", quality=82, optimize=True)
        return thumb_path.read_bytes(), "image/jpeg"

    def _scan_pins(
        self,
        tag_map: Dict[str, List[Dict[str, Any]]],
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
        pins: List[Dict[str, Any]] = []
        pin_by_id: Dict[str, Dict[str, Any]] = {}
        pin_by_name: Dict[str, Dict[str, Any]] = {}
        if not self.map_dir.exists():
            return pins, pin_by_id, pin_by_name

        for yaml_path in sorted(self.map_dir.glob("*/*.y*ml")):
            data = read_yaml(yaml_path)
            country = clean_text(data.get("country")) or display_name(yaml_path.parent.name)
            pin_items = data.get("pins") or data.get("locations") or []
            if isinstance(pin_items, dict):
                pin_items = [pin_items]
            if not isinstance(pin_items, list):
                continue

            for index, item in enumerate(pin_items):
                if not isinstance(item, dict):
                    continue
                lat, lon = read_coordinates(item)
                pin_id = clean_text(item.get("id")) or slugify(f"{country}-{item.get('name') or index}")
                name = clean_text(item.get("name") or item.get("full_name"))
                hero_source = read_pin_hero_source(item)
                source_rel = ""
                source_exists = False
                if hero_source:
                    hero_path = resolve_pin_asset_source(self.root, self.raw_assets_dir, yaml_path, hero_source)
                    source_exists = hero_path.exists()
                    if source_exists and self._is_within(hero_path, self.raw_assets_dir):
                        source_rel = relative_posix(hero_path, self.raw_assets_dir)
                        tag_map.setdefault(source_rel, []).append(
                            {
                                "kind": "pin hero",
                                "label": name,
                                "path": relative_posix(yaml_path, self.root),
                            }
                        )

                pin = {
                    "key": f"{relative_posix(yaml_path, self.root)}::{pin_id}",
                    "id": pin_id,
                    "name": name,
                    "country": country,
                    "icao": clean_text(item.get("icao") or item.get("icao_code") or item.get("icaoCode")).upper(),
                    "lat": lat,
                    "lon": lon,
                    "enabled": item.get("enabled", True) is not False,
                    "pinPath": relative_posix(yaml_path, self.root),
                    "pinIndex": index,
                    "heroPhoto": clean_text(hero_source),
                    "heroAssetPath": source_rel,
                    "heroExists": source_exists,
                    "photoCount": 0,
                }
                pins.append(pin)
                pin_by_id.setdefault(pin_id, pin)
                if name:
                    pin_by_name.setdefault(normalize_key(name), pin)

        pins.sort(key=lambda item: (item["country"], item["name"]))
        return pins, pin_by_id, pin_by_name

    def _scan_aircraft(
        self,
        tag_map: Dict[str, List[Dict[str, Any]]],
        pin_by_id: Dict[str, Dict[str, Any]],
        pin_by_name: Dict[str, Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        if not self.aircraft_dir.exists():
            return entries

        for entry_path in sorted(self.aircraft_dir.glob("*/*/entry.y*ml")):
            data = read_yaml(entry_path)
            aircraft_type = read_aircraft_type(data, entry_path)
            squadron_name = read_squadron_name(data, entry_path)
            country = clean_text(data.get("country"))
            unit_type = read_unit_type(data)
            aircraft_family = read_aircraft_family(data)
            logo_value = read_squadron_logo_value(data)
            logo_path = resolve_entry_asset_source(self.root, self.raw_assets_dir, entry_path, logo_value) if logo_value else None
            logo_exists = bool(logo_path and logo_path.exists())
            photos = data.get("photos") or []
            if isinstance(photos, dict):
                photos = [photos]
            if not isinstance(photos, list):
                photos = []

            photo_records: List[Dict[str, Any]] = []
            for index, item in enumerate(photos):
                if not isinstance(item, dict):
                    photo_records.append({"index": index, "invalid": True, "raw": str(item)})
                    continue
                source_value = item.get("path") or item.get("file") or item.get("filepath") or ""
                source_path = resolve_photo_source(self.root, self.raw_assets_dir, entry_path, source_value)
                source_exists = source_path.exists()
                source_rel = ""
                exif_date = read_image_capture_date(source_path, self._exif_date_cache) if source_exists else ""
                if source_exists and self._is_within(source_path, self.raw_assets_dir):
                    source_rel = relative_posix(source_path, self.raw_assets_dir)
                    tag_map.setdefault(source_rel, []).append(
                        {
                            "kind": "photo",
                            "label": f"{aircraft_type} / {squadron_name}",
                            "location": clean_text(item.get("location") or item.get("location_name")),
                            "path": relative_posix(entry_path, self.root),
                            "index": index,
                        }
                    )

                pin = None
                pin_id = clean_text(item.get("pin_id") or item.get("pin"))
                location = clean_text(item.get("location") or item.get("location_name"))
                if pin_id and pin_id in pin_by_id:
                    pin = pin_by_id[pin_id]
                elif location:
                    pin = pin_by_name.get(normalize_key(location))
                if pin:
                    pin["photoCount"] += 1
                missing_fields = missing_photo_fields(
                    photo_item=item,
                    source_exists=source_exists,
                    location=location,
                    exif_date=exif_date,
                )

                photo_records.append(
                    {
                        "index": index,
                        "path": clean_text(source_value),
                        "sourceAssetPath": source_rel,
                        "exists": source_exists,
                        "location": location,
                        "pinId": pin_id,
                        "date": clean_text(item.get("date")),
                        "year": clean_text(item.get("year")),
                        "exifDate": exif_date,
                        "title": clean_text(item.get("title")),
                        "caption": clean_text(item.get("caption")),
                        "missingFields": missing_fields,
                        "missingFieldLabels": [MISSING_FIELD_LABELS[field] for field in missing_fields],
                    }
                )

            for kind, source_value in (
                ("logo", logo_value),
                ("squadron hero", read_squadron_hero_source(data)),
            ):
                if not source_value:
                    continue
                source_path = resolve_entry_asset_source(self.root, self.raw_assets_dir, entry_path, source_value)
                if source_path.exists() and self._is_within(source_path, self.raw_assets_dir):
                    source_rel = relative_posix(source_path, self.raw_assets_dir)
                    tag_map.setdefault(source_rel, []).append(
                        {
                            "kind": kind,
                            "label": f"{aircraft_type} / {squadron_name}",
                            "path": relative_posix(entry_path, self.root),
                        }
                    )

            entries.append(
                {
                    "entryPath": relative_posix(entry_path, self.root),
                    "entryDir": relative_posix(entry_path.parent, self.root),
                    "aircraftType": aircraft_type,
                    "squadronName": squadron_name,
                    "country": country,
                    "unitType": unit_type,
                    "unitLabel": "Organisation" if unit_type == "organisation" else "Squadron",
                    "aircraftFamily": aircraft_family,
                    "squadronLogo": clean_text(logo_value),
                    "squadronLogoExists": logo_exists,
                    "entryMissingFields": missing_entry_fields(data, logo_exists=logo_exists),
                    "photoCount": len(photo_records),
                    "missingPhotoCount": sum(1 for photo in photo_records if photo.get("exists") is False),
                    "missingFieldPhotoCount": sum(1 for photo in photo_records if photo.get("missingFields")),
                    "photos": photo_records,
                }
            )

        entries.sort(key=lambda item: (item["aircraftType"], item["country"], item["squadronName"]))
        return entries

    def _scan_assets(self, tag_map: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        assets: List[Dict[str, Any]] = []
        if not self.raw_assets_dir.exists():
            return assets
        for path in sorted(self.raw_assets_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            rel = relative_posix(path, self.raw_assets_dir)
            stat = path.stat()
            assets.append(
                {
                    "path": rel,
                    "name": path.name,
                    "extension": path.suffix.lower(),
                    "size": stat.st_size,
                    "sizeLabel": format_bytes(stat.st_size),
                    "modified": int(stat.st_mtime),
                    "tags": tag_map.get(rel, []),
                }
            )
        assets.sort(key=lambda item: (bool(item["tags"]), -item["modified"], item["path"]))
        return assets

    def _project_path(self, value: str) -> Optional[Path]:
        if not value:
            return None
        candidate = Path(value)
        if candidate.is_absolute():
            resolved = candidate.resolve()
        else:
            resolved = (self.root / candidate).resolve()
        if not self._is_within(resolved, self.root):
            raise ValueError("Path is outside the project.")
        return resolved

    def _raw_asset_path(self, value: str) -> Path:
        if not value:
            raise ValueError("Asset path is required.")
        candidate = Path(value)
        if candidate.is_absolute():
            resolved = candidate.resolve()
        else:
            resolved = (self.raw_assets_dir / candidate).resolve()
        if not self._is_within(resolved, self.raw_assets_dir):
            raise ValueError("Asset path is outside raw_assets.")
        return resolved

    @staticmethod
    def _is_within(path: Path, parent: Path) -> bool:
        try:
            path.resolve().relative_to(parent.resolve())
            return True
        except ValueError:
            return False


class SpotterDexHandler(BaseHTTPRequestHandler):
    context: RequestContext

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        try:
            parsed = urlparse(self.path)
            if parsed.path in {"/", "/index.html"}:
                self._send_bytes(INDEX_HTML.encode("utf-8"), "text/html; charset=utf-8")
                return
            if parsed.path == "/api/state":
                self._send_json(self.context.manager.get_state())
                return
            if parsed.path == "/api/thumb":
                query = parse_qs(parsed.query)
                asset_rel = query.get("path", [""])[0]
                content, content_type = self.context.manager.make_thumbnail(asset_rel)
                self._send_bytes(content, content_type, cache_seconds=86400)
                return
            if parsed.path == "/api/build-stream":
                query = parse_qs(parsed.query)
                strict = query.get("strict", ["0"])[0] in {"1", "true", "yes"}
                self._send_build_stream(strict=strict)
                return
            if parsed.path == "/favicon.ico":
                icon_path = self.context.manager.root / "assets/icons/spotterdex-app-icon.png"
                if icon_path.exists():
                    self._send_bytes(icon_path.read_bytes(), "image/png", cache_seconds=86400)
                    return
            self._send_error(HTTPStatus.NOT_FOUND, "Not found")
        except Exception as exc:  # pragma: no cover - defensive request guard
            self._send_exception(exc)

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        try:
            parsed = urlparse(self.path)
            payload = self._read_json()
            routes = {
                "/api/attach": self.context.manager.append_photos,
                "/api/update-entry": self.context.manager.update_entry,
                "/api/update-photo": self.context.manager.update_photo,
                "/api/delete-photo": self.context.manager.delete_photo,
                "/api/create-entry": self.context.manager.create_entry,
                "/api/create-pin": self.context.manager.create_pin,
                "/api/set-pin-hero": self.context.manager.set_pin_hero,
                "/api/build": self.context.manager.run_build,
            }
            handler = routes.get(parsed.path)
            if not handler:
                self._send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            self._send_json(handler(payload))
        except Exception as exc:  # pragma: no cover - defensive request guard
            self._send_exception(exc)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"{self.address_string()} - {format % args}\n")

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _send_json(self, payload: Dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json.dumps(payload, ensure_ascii=True, indent=2).encode("utf-8")
        self._send_bytes(content, "application/json; charset=utf-8", status=status)

    def _send_error(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"ok": False, "message": message}, status=status)

    def _send_exception(self, exc: Exception) -> None:
        status = HTTPStatus.BAD_REQUEST if isinstance(exc, (ValueError, FileNotFoundError)) else HTTPStatus.INTERNAL_SERVER_ERROR
        payload = {
            "ok": False,
            "message": str(exc) or exc.__class__.__name__,
        }
        if status == HTTPStatus.INTERNAL_SERVER_ERROR:
            payload["traceback"] = traceback.format_exc()
        self._send_json(payload, status=status)

    def _send_build_stream(self, strict: bool = False) -> None:
        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        def send_event(event_name: str, payload: Dict[str, Any]) -> None:
            content = json.dumps(payload, ensure_ascii=True)
            self.wfile.write(f"event: {event_name}\n".encode("utf-8"))
            for line in content.splitlines() or ["{}"]:
                self.wfile.write(f"data: {line}\n".encode("utf-8"))
            self.wfile.write(b"\n")
            self.wfile.flush()

        try:
            for event_name, payload in self.context.manager.stream_build(strict=strict):
                send_event(event_name, payload)
            self.close_connection = True
        except BrokenPipeError:
            self.close_connection = True
            return
        except Exception as exc:  # pragma: no cover - defensive stream guard
            try:
                send_event(
                    "error",
                    {
                        "message": str(exc) or exc.__class__.__name__,
                        "traceback": traceback.format_exc(),
                    },
                )
            except BrokenPipeError:
                return
            finally:
                self.close_connection = True

    def _send_bytes(
        self,
        content: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
        cache_seconds: int = 0,
    ) -> None:
        self.send_response(status.value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        if cache_seconds:
            self.send_header("Cache-Control", f"public, max-age={cache_seconds}")
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)


def read_yaml(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        return {}
    return data


def write_yaml(path: Path, data: Dict[str, Any]) -> None:
    prepared = prepare_for_dump(data)
    content = yaml.dump(
        prepared,
        Dumper=SpotterDexDumper,
        sort_keys=False,
        allow_unicode=False,
        default_flow_style=False,
        width=1000,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(path)


def prepare_for_dump(value: Any, parent_key: str = "") -> Any:
    if isinstance(value, dict):
        return {key: prepare_for_dump(item, str(key)) for key, item in value.items()}
    if isinstance(value, list):
        if parent_key == "coordinates" and len(value) == 2:
            return FlowList(value)
        return [prepare_for_dump(item) for item in value]
    return value


def read_aircraft_type(data: Dict[str, Any], entry_path: Path) -> str:
    aircraft_data = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
    return clean_text(
        data.get("aircraft_type")
        or data.get("aircraft_type_name")
        or data.get("type_name")
        or aircraft_data.get("name")
        or display_name(entry_path.parent.parent.name)
    )


def read_squadron_name(data: Dict[str, Any], entry_path: Path) -> str:
    squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
    squadron_scalar = data.get("squadron") if not isinstance(data.get("squadron"), dict) else None
    return clean_text(
        data.get("squadron_name")
        or data.get("squadron_full_name")
        or squadron_data.get("name")
        or squadron_scalar
        or display_name(entry_path.parent.name)
    )


def read_unit_type(data: Dict[str, Any]) -> str:
    squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
    values = [
        data.get("unit_type"),
        data.get("unitType"),
        data.get("operator_type"),
        data.get("operatorType"),
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
        if normalize_key(str(value or "")) in {"organisation", "organization", "org"}:
            return "organisation"
    return "squadron"


def read_aircraft_family(data: Dict[str, Any]) -> str:
    aircraft_data = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
    value = (
        data.get("aircraft_family")
        or data.get("aircraftFamily")
        or data.get("family")
        or data.get("aircraft_type_family")
        or data.get("aircraftTypeFamily")
        or aircraft_data.get("family")
    )
    key = normalize_key(str(value or ""))
    if key in {"fighter", "heavy", "helicopter"}:
        return key
    return clean_text(value)


def read_squadron_logo_value(data: Dict[str, Any]) -> Any:
    squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
    return data.get("squadron_logo") or data.get("squadronLogo") or data.get("logo") or squadron_data.get("logo")


def missing_entry_fields(data: Dict[str, Any], logo_exists: bool = False) -> List[str]:
    missing: List[str] = []
    if not clean_text(data.get("aircraft_type") or data.get("aircraft_type_name") or data.get("type_name")):
        aircraft_data = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
        if not clean_text(aircraft_data.get("name")):
            missing.append("aircraftType")
    if not read_aircraft_family(data):
        missing.append("aircraftFamily")
    if not clean_text(data.get("squadron_name") or data.get("squadron_full_name")):
        squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
        squadron_scalar = data.get("squadron") if not isinstance(data.get("squadron"), dict) else None
        if not clean_text(squadron_data.get("name") or squadron_scalar):
            missing.append("squadronName")
    if not read_squadron_logo_value(data) or not logo_exists:
        missing.append("squadronLogo")
    if not clean_text(data.get("country")):
        squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
        if not clean_text(squadron_data.get("country")):
            missing.append("country")
    return missing


def missing_photo_fields(
    photo_item: Dict[str, Any],
    source_exists: bool,
    location: str,
    exif_date: str,
) -> List[str]:
    missing: List[str] = []
    if not source_exists:
        missing.append("source")
    if not location and not clean_text(photo_item.get("pin_id") or photo_item.get("pin")):
        missing.append("location")
    if not clean_text(photo_item.get("caption")):
        missing.append("caption")

    yaml_date = normalize_date_value(
        photo_item.get("date")
        or photo_item.get("taken")
        or photo_item.get("taken_at")
        or photo_item.get("captured")
        or photo_item.get("shot_date")
    )
    yaml_year = clean_year(photo_item.get("year"))
    if not yaml_date and not yaml_year and not exif_date:
        missing.append("captureDate")
    return missing


def read_image_capture_date(path: Path, cache: Dict[str, str]) -> str:
    try:
        stat = path.stat()
    except OSError:
        return ""
    cache_key = f"{path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}"
    if cache_key in cache:
        return cache[cache_key]

    result = ""
    try:
        with Image.open(path) as opened:
            raw = opened.getexif()
            values: List[Any] = []
            if raw:
                exif_ifd = read_exif_sub_ifd(raw)
                for tag_name in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
                    tag_id = exif_tag_id(tag_name)
                    if not tag_id:
                        continue
                    values.append(exif_ifd.get(tag_id))
                    values.append(raw.get(tag_id))
            for value in values:
                result = normalize_date_value(value)
                if result:
                    break
    except Exception:
        result = ""
    cache[cache_key] = result
    return result


def exif_tag_id(tag_name: str) -> Optional[int]:
    try:
        from PIL import ExifTags
    except Exception:
        return None
    tags = getattr(ExifTags, "TAGS", {})
    for tag_id, name in tags.items():
        if name == tag_name:
            return int(tag_id)
    return None


def read_exif_sub_ifd(raw: Image.Exif) -> Dict[int, Any]:
    try:
        from PIL import ExifTags
    except Exception:
        return {}

    ifd_keys: List[Any] = []
    pillow_ifd = getattr(ExifTags, "IFD", None)
    pillow_exif_ifd = getattr(pillow_ifd, "Exif", None)
    if pillow_exif_ifd is not None:
        ifd_keys.append(pillow_exif_ifd)
    exif_offset = exif_tag_id("ExifOffset")
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


def read_pin_hero_source(item: Dict[str, Any]) -> Any:
    for key in ("hero_photo", "hero_image", "hero_path", "heroPhoto", "heroImage", "heroPath"):
        if item.get(key):
            return item.get(key)
    hero = item.get("hero")
    if isinstance(hero, dict):
        for key in ("path", "file", "filepath", "image", "source"):
            if hero.get(key):
                return hero.get(key)
    elif hero:
        return hero
    return None


def read_squadron_hero_source(data: Dict[str, Any]) -> Any:
    squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
    candidates = (
        data.get("squadron_hero"),
        data.get("squadron_hero_image"),
        data.get("squadronHero"),
        data.get("squadronHeroImage"),
        squadron_data.get("hero_image"),
        squadron_data.get("heroImage"),
        squadron_data.get("hero_photo"),
        squadron_data.get("heroPhoto"),
        squadron_data.get("hero"),
    )
    for value in candidates:
        if isinstance(value, dict):
            for key in ("path", "file", "filepath", "image", "source"):
                if value.get(key):
                    return value.get(key)
        elif value:
            return value
    return None


def resolve_photo_source(root: Path, raw_assets_dir: Path, yaml_path: Path, source_value: Any) -> Path:
    relative_source = Path(str(source_value or ""))
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


def resolve_entry_asset_source(root: Path, raw_assets_dir: Path, yaml_path: Path, source_value: Any) -> Path:
    relative_source = Path(str(source_value or ""))
    if relative_source.is_absolute():
        return relative_source.resolve()

    direct = (yaml_path.parent / relative_source).resolve()
    if direct.exists():
        return direct
    return resolve_photo_source(root, raw_assets_dir, yaml_path, source_value)


def resolve_pin_asset_source(root: Path, raw_assets_dir: Path, yaml_path: Path, source_value: Any) -> Path:
    relative_source = Path(str(source_value or ""))
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


def photo_yaml_path_for_asset(entry_path: Path, root: Path, asset_rel: str) -> str:
    entry_dir_rel = relative_posix(entry_path.parent, root)
    prefix = f"{entry_dir_rel}/"
    if asset_rel.startswith(prefix):
        return asset_rel[len(prefix) :]
    return asset_rel


def pin_hero_yaml_path_for_asset(pin_path: Path, root: Path, asset_rel: str) -> str:
    pin_dir_rel = relative_posix(pin_path.parent, root)
    prefix = f"{pin_dir_rel}/"
    if asset_rel.startswith(prefix):
        return asset_rel[len(prefix) :]
    return asset_rel


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
        return float(lat_value), float(lon_value)
    except (TypeError, ValueError):
        return None, None


def parse_float(value: Any, label: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number.") from exc


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def clean_year(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    match = re.match(r"^(\d{4})", text)
    return match.group(1) if match else text


def normalize_aircraft_family(value: Any) -> str:
    text = clean_text(value)
    key = normalize_key(text)
    if key in {"fighter", "heavy", "helicopter"}:
        return key
    return text


def relative_posix(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def display_name(value: str) -> str:
    return value.replace("_", " ").replace("-", " ").title()


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalized).strip("-").lower()
    return slug or "item"


def normalize_key(value: str) -> str:
    return slugify(value)


def unique_slug(base: str, existing: Iterable[str]) -> str:
    used = set(existing)
    candidate = base or "item"
    index = 2
    while candidate in used:
        candidate = f"{base}-{index}"
        index += 1
    return candidate


def format_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{size} B"


def make_handler(manager: SpotterDexManager) -> type[SpotterDexHandler]:
    class Handler(SpotterDexHandler):
        context = RequestContext(manager=manager)

    return Handler


def snapshot_generated_outputs(root: Path) -> Dict[str, Dict[str, Any]]:
    targets = [
        root / "data" / "spotterdex.json",
        root / "data" / "spotterdex-data.js",
        root / "assets" / "generated" / "photos",
        root / "assets" / "generated" / "thumbs",
        root / "assets" / "logos",
    ]
    snapshot: Dict[str, Dict[str, Any]] = {}
    for target in targets:
        if target.is_file():
            paths = [target]
        elif target.is_dir():
            paths = [path for path in sorted(target.rglob("*")) if path.is_file()]
        else:
            paths = []
        for path in paths:
            rel = relative_posix(path, root)
            stat = path.stat()
            snapshot[rel] = {
                "path": rel,
                "category": generated_category(rel),
                "size": stat.st_size,
                "sizeLabel": format_bytes(stat.st_size),
                "sha1": sha1_file(path),
            }
    return snapshot


def generated_category(path: str) -> str:
    if path.startswith("assets/generated/photos/"):
        return "photos"
    if path.startswith("assets/generated/thumbs/"):
        return "thumbs"
    if path.startswith("assets/logos/"):
        return "logos"
    if path.startswith("data/"):
        return "data"
    return "other"


def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_manifest_counts(root: Path) -> Dict[str, Any]:
    manifest_path = root / "data" / "spotterdex.json"
    if not manifest_path.exists():
        return {
            "aircraft": 0,
            "photos": 0,
            "pins": 0,
            "squadrons": 0,
            "organisations": 0,
            "generatedAt": "",
        }
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "aircraft": 0,
            "photos": 0,
            "pins": 0,
            "squadrons": 0,
            "organisations": 0,
            "generatedAt": "",
            "readError": True,
        }

    aircraft = data.get("aircraft") if isinstance(data.get("aircraft"), list) else []
    squadrons = [
        squadron
        for entry in aircraft
        if isinstance(entry, dict)
        for squadron in entry.get("squadrons", [])
        if isinstance(squadron, dict)
    ]
    return {
        "aircraft": len(aircraft),
        "photos": len(data.get("photos") if isinstance(data.get("photos"), list) else []),
        "pins": len(data.get("pins") if isinstance(data.get("pins"), list) else []),
        "squadrons": sum(1 for squadron in squadrons if squadron.get("unitType", "squadron") == "squadron"),
        "organisations": sum(1 for squadron in squadrons if squadron.get("unitType") == "organisation"),
        "generatedAt": clean_text(data.get("generatedAt")),
    }


def build_generated_summary(
    root: Path,
    before_snapshot: Dict[str, Dict[str, Any]],
    after_snapshot: Dict[str, Dict[str, Any]],
    before_counts: Dict[str, Any],
    after_counts: Dict[str, Any],
    warnings: List[str],
    notes: List[str],
    returncode: int,
) -> Dict[str, Any]:
    changes = diff_generated_snapshots(before_snapshot, after_snapshot)
    return {
        "ok": returncode == 0,
        "returncode": returncode,
        "generatedChanges": changes,
        "manifestCounts": diff_manifest_counts(before_counts, after_counts),
        "warnings": warnings,
        "notes": notes,
        "commitScope": recommended_commit_scope(root, changes),
    }


def diff_generated_snapshots(
    before: Dict[str, Dict[str, Any]],
    after: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    categories = ["photos", "thumbs", "logos", "data", "other"]
    changes: Dict[str, Dict[str, List[Dict[str, Any]]]] = {
        kind: {category: [] for category in categories}
        for kind in ("added", "modified", "deleted")
    }

    before_keys = set(before)
    after_keys = set(after)
    for path in sorted(after_keys - before_keys):
        item = after[path]
        changes["added"][item["category"]].append(file_change_item(path, after_item=item))
    for path in sorted(before_keys - after_keys):
        item = before[path]
        changes["deleted"][item["category"]].append(file_change_item(path, before_item=item))
    for path in sorted(before_keys & after_keys):
        before_item = before[path]
        after_item = after[path]
        if before_item.get("sha1") == after_item.get("sha1"):
            continue
        changes["modified"][after_item["category"]].append(
            file_change_item(path, before_item=before_item, after_item=after_item)
        )

    totals = {
        kind: sum(len(items) for items in by_category.values())
        for kind, by_category in changes.items()
    }
    category_totals = {
        category: sum(len(changes[kind][category]) for kind in changes)
        for category in categories
    }
    return {
        "changes": changes,
        "totals": totals,
        "categoryTotals": category_totals,
    }


def file_change_item(
    path: str,
    before_item: Optional[Dict[str, Any]] = None,
    after_item: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    item = {"path": path}
    if before_item:
        item["beforeSize"] = before_item.get("size", 0)
        item["beforeSizeLabel"] = before_item.get("sizeLabel", "")
    if after_item:
        item["afterSize"] = after_item.get("size", 0)
        item["afterSizeLabel"] = after_item.get("sizeLabel", "")
    return item


def diff_manifest_counts(before: Dict[str, Any], after: Dict[str, Any]) -> List[Dict[str, Any]]:
    labels = {
        "aircraft": "Aircraft",
        "photos": "Photos",
        "pins": "Pins",
        "squadrons": "Squadrons",
        "organisations": "Organisations",
    }
    rows: List[Dict[str, Any]] = []
    for key, label in labels.items():
        before_value = int(before.get(key) or 0)
        after_value = int(after.get(key) or 0)
        rows.append(
            {
                "key": key,
                "label": label,
                "before": before_value,
                "after": after_value,
                "delta": after_value - before_value,
            }
        )
    rows.append(
        {
            "key": "generatedAt",
            "label": "Generated at",
            "before": before.get("generatedAt", ""),
            "after": after.get("generatedAt", ""),
            "delta": "",
        }
    )
    return rows


def classify_build_line(line: str) -> str:
    text = line.strip().lower()
    if text.startswith("warning:"):
        return "warning"
    if text.startswith("note:"):
        return "note"
    if re.match(r"^(loading map pins|reading aircraft yaml|processing photos):", text):
        return "progress"
    return "log"


def recommended_commit_scope(root: Path, changes: Dict[str, Any]) -> Dict[str, Any]:
    changed_files = git_changed_files(root)
    source_yaml = [
        path
        for path in changed_files
        if (path.startswith("aircraft/") or path.startswith("map_pins/")) and path.endswith((".yaml", ".yml"))
    ]
    generated_data = [path for path in changed_files if path.startswith("data/")]
    generated_photos = [path for path in changed_files if path.startswith("assets/generated/photos/")]
    generated_thumbs = [path for path in changed_files if path.startswith("assets/generated/thumbs/")]
    logos = [path for path in changed_files if path.startswith("assets/logos/")]

    sections = [
        {
            "label": "Source YAML",
            "files": source_yaml,
            "include": bool(source_yaml),
        },
        {
            "label": "Generated data",
            "files": generated_data,
            "include": bool(generated_data or changes["categoryTotals"].get("data")),
        },
        {
            "label": "Generated photos",
            "files": generated_photos,
            "include": bool(generated_photos or changes["categoryTotals"].get("photos")),
        },
        {
            "label": "Generated thumbs",
            "files": generated_thumbs,
            "include": bool(generated_thumbs or changes["categoryTotals"].get("thumbs")),
        },
        {
            "label": "Published logos",
            "files": logos,
            "include": bool(logos or changes["categoryTotals"].get("logos")),
        },
    ]
    return {
        "sections": sections,
        "recommendedGlobs": [
            "aircraft/**/entry.yaml",
            "map_pins/**/pins.yaml",
            "data/spotterdex.json",
            "data/spotterdex-data.js",
            "assets/generated/photos/",
            "assets/generated/thumbs/",
            "assets/logos/",
        ],
        "excluded": ["raw_assets/", ".spotterdex-manager-cache/"],
    }


def git_changed_files(root: Path) -> List[str]:
    try:
        completed = subprocess.run(
            ["git", "status", "--short", "--untracked-files=all"],
            cwd=root,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
    except Exception:
        return []
    if completed.returncode != 0:
        return []
    files: List[str] = []
    for line in completed.stdout.splitlines():
        if len(line) < 4:
            continue
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip()
        if path:
            files.append(path)
    return sorted(files)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local SpotterDex data manager.")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind.")
    parser.add_argument("--port", type=int, default=8765, help="Port to bind.")
    parser.add_argument("--open", action="store_true", help="Open the app in the default browser.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manager = SpotterDexManager(ROOT)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(manager))
    url = f"http://{args.host}:{args.port}/"
    print(f"SpotterDex Manager running at {url}")
    print("Press Ctrl+C to stop.")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping SpotterDex Manager.")
    finally:
        server.server_close()
    return 0


INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SpotterDex Manager</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --panel-2: #eef3f6;
      --ink: #17202a;
      --muted: #667587;
      --line: #d7e0e7;
      --accent: #147b8f;
      --accent-2: #3757a6;
      --good: #12805c;
      --warn: #b46b00;
      --bad: #b42318;
      --shadow: 0 18px 48px rgba(30, 42, 56, 0.13);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.82), rgba(244,246,248,0.94)),
        radial-gradient(circle at top left, rgba(20,123,143,0.11), transparent 34rem),
        var(--bg);
    }
    button, input, select, textarea {
      font: inherit;
    }
    button {
      border: 0;
      cursor: pointer;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 14px 22px;
      background: rgba(255, 255, 255, 0.92);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(18px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 220px;
    }
    .brand-mark {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      object-fit: cover;
      box-shadow: 0 10px 24px rgba(20, 123, 143, 0.2);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.1;
      letter-spacing: 0;
    }
    .subtle {
      color: var(--muted);
      font-size: 12px;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill strong {
      color: var(--ink);
      font-weight: 700;
    }
    .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      min-width: 220px;
    }
    .btn {
      min-height: 36px;
      padding: 8px 12px;
      border-radius: 8px;
      background: #e8eef3;
      color: var(--ink);
      font-weight: 700;
      transition: transform 140ms ease, background 140ms ease, box-shadow 140ms ease;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn.primary {
      background: var(--accent);
      color: #fff;
      box-shadow: 0 12px 26px rgba(20, 123, 143, 0.24);
    }
    .btn.secondary {
      background: var(--accent-2);
      color: #fff;
    }
    .btn.danger {
      background: #fff0ee;
      color: var(--bad);
    }
    .btn.ghost {
      background: transparent;
      border: 1px solid var(--line);
    }
    .btn:disabled {
      cursor: wait;
      opacity: 0.65;
      transform: none;
    }
    main {
      display: grid;
      grid-template-columns: minmax(300px, 37vw) minmax(520px, 1fr);
      gap: 16px;
      padding: 16px;
      min-height: 0;
    }
    .panel {
      min-height: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.92);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .panel-title {
      margin: 0;
      font-size: 15px;
      line-height: 1.2;
    }
    .asset-tools {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-2);
    }
    .field {
      display: grid;
      gap: 6px;
      align-content: start;
    }
    label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    input, select, textarea {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      padding: 8px 10px;
      outline: none;
    }
    textarea {
      min-height: 84px;
      resize: vertical;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(20,123,143,0.13);
    }
    .segmented {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .segmented button {
      min-height: 30px;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .segmented button.active {
      background: var(--ink);
      color: #fff;
    }
    .asset-grid {
      height: calc(100vh - 210px);
      min-height: 420px;
      overflow: auto;
      padding: 14px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(154px, 1fr));
      gap: 12px;
      align-content: start;
    }
    .asset-card {
      display: grid;
      gap: 8px;
      text-align: left;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      min-width: 0;
      transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
    }
    .asset-card:hover {
      transform: translateY(-1px);
      border-color: rgba(20,123,143,0.45);
    }
    .asset-card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(20,123,143,0.14);
    }
    .asset-card img {
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      border-radius: 6px;
      background: #d8e1e8;
    }
    .asset-name {
      min-height: 34px;
      font-size: 12px;
      font-weight: 750;
      overflow-wrap: anywhere;
      line-height: 1.25;
    }
    .asset-meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #edf7f5;
      color: var(--good);
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .tag.warn {
      background: #fff7e8;
      color: var(--warn);
    }
    .workspace {
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 0;
    }
    .tabs {
      display: flex;
      gap: 6px;
      padding: 10px;
      border-bottom: 1px solid var(--line);
      background: #fff;
      overflow-x: auto;
    }
    .tab {
      min-height: 34px;
      padding: 8px 12px;
      border-radius: 8px;
      background: transparent;
      color: var(--muted);
      font-weight: 850;
      white-space: nowrap;
    }
    .tab.active {
      background: var(--ink);
      color: #fff;
    }
    .view {
      display: none;
      height: calc(100vh - 142px);
      min-height: 488px;
      overflow: auto;
      padding: 16px;
    }
    .view.active {
      display: block;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .form-grid .wide {
      grid-column: 1 / -1;
    }
    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      margin: 14px 0;
    }
    .selected-strip {
      display: flex;
      gap: 8px;
      min-height: 72px;
      overflow-x: auto;
      padding: 8px 0;
    }
    .selected-strip img {
      width: 92px;
      height: 64px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #d8e1e8;
      flex: 0 0 auto;
    }
    .photo-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .photo-card {
      display: grid;
      gap: 9px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .photo-card img {
      width: 100%;
      aspect-ratio: 16 / 10;
      object-fit: cover;
      border-radius: 6px;
      background: #d8e1e8;
    }
    .photo-card .missing {
      display: grid;
      place-items: center;
      width: 100%;
      aspect-ratio: 16 / 10;
      border-radius: 6px;
      background: #fff2ee;
      color: var(--bad);
      font-weight: 800;
      font-size: 12px;
    }
    .mini-title {
      font-size: 13px;
      font-weight: 850;
      overflow-wrap: anywhere;
      line-height: 1.25;
    }
    .mini-meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .card-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(280px, 0.72fr) minmax(320px, 1fr);
      gap: 14px;
      align-items: start;
    }
    .section {
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .section h2 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }
    .console {
      min-height: 260px;
      max-height: 56vh;
      overflow: auto;
      padding: 12px;
      border-radius: 8px;
      background: #111827;
      color: #d1fae5;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .build-summary {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
    }
    .summary-card {
      display: grid;
      gap: 8px;
      min-width: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .summary-card h3 {
      margin: 0;
      font-size: 13px;
      letter-spacing: 0;
    }
    .count-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .count-table th,
    .count-table td {
      padding: 7px 6px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    .count-table th {
      color: var(--muted);
      font-size: 11px;
    }
    .count-table td:last-child {
      font-weight: 850;
    }
    .delta-pos { color: var(--good); }
    .delta-neg { color: var(--bad); }
    details.change-group {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }
    details.change-group summary {
      cursor: pointer;
      padding: 10px 12px;
      font-weight: 850;
      list-style-position: inside;
    }
    .change-list {
      display: grid;
      gap: 6px;
      max-height: 260px;
      overflow: auto;
      padding: 0 12px 12px;
      margin: 0;
      list-style: none;
    }
    .change-list li {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
      padding: 6px 0;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .change-list code {
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .warning-list {
      display: grid;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
      color: var(--warn);
      font-size: 12px;
      line-height: 1.4;
    }
    .issue-list {
      display: grid;
      gap: 10px;
      max-height: 66vh;
      overflow: auto;
      padding-right: 2px;
    }
    .issue-card {
      display: grid;
      gap: 8px;
      width: 100%;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      text-align: left;
    }
    .issue-card.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(20,123,143,0.14);
    }
    .issue-card img {
      width: 100%;
      aspect-ratio: 16 / 9;
      object-fit: cover;
      border-radius: 6px;
      background: #d8e1e8;
    }
    .issue-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .issue-chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #fff7e8;
      color: var(--warn);
      font-size: 11px;
      font-weight: 850;
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 40;
      max-width: min(420px, calc(100vw - 36px));
      padding: 12px 14px;
      border-radius: 8px;
      background: #17202a;
      color: #fff;
      box-shadow: var(--shadow);
      transform: translateY(18px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    .empty {
      display: grid;
      place-items: center;
      min-height: 160px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--muted);
      text-align: center;
      padding: 20px;
      background: rgba(255,255,255,0.6);
    }
    @media (max-width: 1040px) {
      header {
        align-items: flex-start;
        flex-direction: column;
      }
      .actions, .brand {
        min-width: 0;
      }
      main {
        grid-template-columns: 1fr;
      }
      .asset-grid, .view {
        height: auto;
        max-height: none;
      }
      .split {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 640px) {
      main {
        padding: 10px;
      }
      .form-grid {
        grid-template-columns: 1fr;
      }
      .asset-tools {
        grid-template-columns: 1fr;
      }
      .stats {
        justify-content: flex-start;
      }
      .actions {
        width: 100%;
      }
      .actions .btn {
        flex: 1;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">
        <img class="brand-mark" src="/favicon.ico" alt="">
        <div>
          <h1>SpotterDex Manager</h1>
          <div class="subtle" id="projectRoot"></div>
        </div>
      </div>
      <div class="stats" id="stats"></div>
      <div class="actions">
        <button class="btn ghost" id="reloadBtn" type="button">Reload</button>
        <button class="btn primary" id="buildBtn" type="button">Build</button>
      </div>
    </header>

    <main>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Raw Assets</h2>
            <div class="subtle" id="selectedCount">0 selected</div>
          </div>
          <button class="btn ghost" id="clearSelectionBtn" type="button">Clear</button>
        </div>
        <div class="asset-tools">
          <div class="field">
            <label for="assetSearch">Search</label>
            <input id="assetSearch" type="search" placeholder="filename, folder, tag">
          </div>
          <div class="field">
            <label>Filter</label>
            <div class="segmented" id="assetFilter">
              <button type="button" data-filter="untagged" class="active">New</button>
              <button type="button" data-filter="all">All</button>
              <button type="button" data-filter="tagged">Used</button>
            </div>
          </div>
        </div>
        <div class="asset-grid" id="assetGrid"></div>
      </section>

      <section class="panel workspace">
        <nav class="tabs" aria-label="Manager views">
          <button class="tab active" data-tab="attach" type="button">Attach</button>
          <button class="tab" data-tab="missing" type="button">Missing</button>
          <button class="tab" data-tab="entries" type="button">Entries</button>
          <button class="tab" data-tab="locations" type="button">Locations</button>
          <button class="tab" data-tab="build" type="button">Build Log</button>
        </nav>

        <section class="view active" id="attachView">
          <div class="form-grid">
            <div class="field wide">
              <label for="entrySearch">Entry Search</label>
              <input id="entrySearch" type="search" placeholder="aircraft, unit, country">
            </div>
            <div class="field wide">
              <label for="entrySelect">Aircraft Entry</label>
              <select id="entrySelect"></select>
            </div>
            <div class="field">
              <label for="pinSelect">Location</label>
              <select id="pinSelect"></select>
            </div>
            <div class="field">
              <label for="photoYear">Year</label>
              <input id="photoYear" type="text" inputmode="numeric" placeholder="2026">
            </div>
            <div class="field">
              <label for="photoDate">Date</label>
              <input id="photoDate" type="date">
            </div>
            <div class="field">
              <label for="dedupeSelect">Duplicate Paths</label>
              <select id="dedupeSelect">
                <option value="skip">Skip existing</option>
                <option value="allow">Allow duplicates</option>
              </select>
            </div>
            <div class="field wide">
              <label for="captionInput">Caption</label>
              <textarea id="captionInput" placeholder="Caption for attached photos"></textarea>
            </div>
          </div>
          <div class="bar">
            <div>
              <strong id="attachSummary">No assets selected</strong>
              <div class="subtle" id="entrySummary"></div>
            </div>
            <button class="btn primary" id="attachBtn" type="button">Attach Selected</button>
          </div>
          <div class="selected-strip" id="selectedStrip"></div>
          <div class="bar">
            <h2 class="panel-title">Entry Photos</h2>
            <button class="btn ghost" id="clearEditorBtn" type="button">Clear Editor</button>
          </div>
          <div class="split">
            <div class="section">
              <h2>Edit Photo</h2>
              <input id="editIndex" type="hidden">
              <div class="field">
                <label for="editPath">Path</label>
                <input id="editPath" type="text">
              </div>
              <div class="field">
                <label for="editLocation">Location</label>
                <select id="editLocation"></select>
              </div>
              <div class="field">
                <label for="editDate">Date</label>
                <input id="editDate" type="date">
              </div>
              <div class="field">
                <label for="editYear">Year</label>
                <input id="editYear" type="text" inputmode="numeric">
              </div>
              <div class="field">
                <label for="editCaption">Caption</label>
                <textarea id="editCaption"></textarea>
              </div>
              <button class="btn secondary" id="savePhotoBtn" type="button">Save Photo</button>
            </div>
            <div>
              <div class="photo-list" id="photoList"></div>
            </div>
          </div>
        </section>

        <section class="view" id="missingView">
          <div class="bar">
            <div>
              <h2 class="panel-title">Missing Fields</h2>
              <div class="subtle" id="missingSummary">0 items</div>
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="missingSearch">Search</label>
              <input id="missingSearch" type="search" placeholder="aircraft, unit, path, field">
            </div>
            <div class="field">
              <label for="missingFilter">Field</label>
              <select id="missingFilter">
                <option value="">All</option>
                <option value="entry">Entry metadata</option>
                <option value="aircraftFamily">Aircraft family</option>
                <option value="squadronLogo">Squadron logo</option>
                <option value="source">Source image</option>
                <option value="location">Location</option>
                <option value="caption">Caption</option>
                <option value="captureDate">Date or EXIF</option>
              </select>
            </div>
          </div>
          <div class="split" style="margin-top: 14px;">
            <div class="section">
              <h2>Queue</h2>
              <div class="issue-list" id="missingList"></div>
            </div>
            <div class="section">
              <h2>Fix</h2>
              <div id="missingEditor"></div>
            </div>
          </div>
        </section>

        <section class="view" id="entriesView">
          <div class="split">
            <div class="section">
              <h2>Create Entry</h2>
              <div class="field">
                <label for="newAircraftType">Aircraft Type</label>
                <input id="newAircraftType" type="text" placeholder="Lockheed C-130R">
              </div>
              <div class="field">
                <label for="newSquadronName">Unit Name</label>
                <input id="newSquadronName" type="text" placeholder="Air Transport Squadron 61">
              </div>
              <div class="field">
                <label for="newCountry">Country</label>
                <input id="newCountry" type="text" placeholder="Japan">
              </div>
              <div class="field">
                <label for="newUnitType">Unit Type</label>
                <select id="newUnitType">
                  <option value="squadron">Squadron</option>
                  <option value="organisation">Organisation</option>
                </select>
              </div>
              <button class="btn primary" id="createEntryBtn" type="button">+ Entry</button>
            </div>
            <div class="section">
              <h2>Entries</h2>
              <div class="field">
                <label for="entryListSearch">Search</label>
                <input id="entryListSearch" type="search" placeholder="aircraft, unit, country">
              </div>
              <div class="photo-list" id="entryCards"></div>
            </div>
          </div>
        </section>

        <section class="view" id="locationsView">
          <div class="split">
            <div class="section">
              <h2>Location Hero</h2>
              <div class="field">
                <label for="locationSelect">Location</label>
                <select id="locationSelect"></select>
              </div>
              <div id="locationDetails" class="mini-meta"></div>
              <button class="btn secondary" id="setHeroBtn" type="button">Set Hero From Selected</button>
            </div>
            <div class="section">
              <h2>Create Pin</h2>
              <div class="form-grid">
                <div class="field">
                  <label for="pinCountry">Country</label>
                  <input id="pinCountry" type="text" placeholder="Japan">
                </div>
                <div class="field">
                  <label for="pinName">Name</label>
                  <input id="pinName" type="text" placeholder="Atsugi Air Base">
                </div>
                <div class="field">
                  <label for="pinIcao">ICAO</label>
                  <input id="pinIcao" type="text" maxlength="4" placeholder="RJTA">
                </div>
                <div class="field">
                  <label for="pinId">ID</label>
                  <input id="pinId" type="text" placeholder="atsugi-air-base">
                </div>
                <div class="field">
                  <label for="pinLat">Latitude</label>
                  <input id="pinLat" type="text" inputmode="decimal" placeholder="35.4547">
                </div>
                <div class="field">
                  <label for="pinLon">Longitude</label>
                  <input id="pinLon" type="text" inputmode="decimal" placeholder="139.4500">
                </div>
              </div>
              <button class="btn primary" id="createPinBtn" type="button">+ Pin</button>
            </div>
          </div>
        </section>

        <section class="view" id="buildView">
          <div class="bar">
            <div>
              <h2 class="panel-title">Build Output</h2>
              <div class="subtle" id="buildStatus">Ready</div>
            </div>
            <button class="btn primary" id="buildBtn2" type="button">Build</button>
          </div>
          <pre class="console" id="buildLog"></pre>
          <div class="build-summary" id="buildSummary"></div>
        </section>
      </section>
    </main>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    const $ = (id) => document.getElementById(id);
    const state = {
      data: null,
      selectedAssets: new Set(),
      selectedIssueKey: "",
      assetFilter: "untagged",
      activeTab: "attach"
    };
    const missingFieldLabels = {
      source: "Source image",
      location: "Location",
      caption: "Caption",
      captureDate: "Date or EXIF",
      aircraftType: "Aircraft type",
      aircraftFamily: "Aircraft family",
      squadronName: "Unit name",
      squadronLogo: "Squadron logo",
      country: "Country"
    };

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function thumbUrl(path) {
      return `/api/thumb?path=${encodeURIComponent(path)}`;
    }

    function selectedEntry() {
      const value = $("entrySelect").value;
      return state.data?.aircraft.find((entry) => entry.entryPath === value) || null;
    }

    function selectedPin(selectId = "pinSelect") {
      const value = $(selectId).value;
      return state.data?.pins.find((pin) => pin.key === value) || null;
    }

    function pinOptionLabel(pin) {
      const code = pin.icao ? `${pin.icao} - ` : "";
      return `${code}${pin.name} (${pin.country})`;
    }

    function entryOptionLabel(entry) {
      return `${entry.aircraftType} - ${entry.squadronName} (${entry.country || "Unknown"})`;
    }

    async function api(path, body = null) {
      const options = body ? {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
      } : {};
      const response = await fetch(path, options);
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || `Request failed: ${response.status}`);
      }
      return payload;
    }

    async function loadState(keepSelection = true) {
      const previous = keepSelection ? new Set(state.selectedAssets) : new Set();
      const response = await fetch("/api/state");
      state.data = await response.json();
      state.selectedAssets = new Set([...previous].filter((path) => state.data.assets.some((asset) => asset.path === path)));
      renderAll();
    }

    function renderAll() {
      renderStats();
      renderAssetGrid();
      renderEntryOptions();
      renderPinOptions();
      renderSelectedStrip();
      renderEntryDetail();
      renderEntryCards();
      renderLocationDetails();
      renderMissingFields();
    }

    function renderStats() {
      const project = state.data.project;
      $("projectRoot").textContent = project.root;
      $("stats").innerHTML = [
        ["Assets", project.assetCount],
        ["New", project.untaggedAssetCount],
        ["Used", project.taggedAssetCount],
        ["Entries", project.aircraftCount],
        ["Pins", project.pinCount],
        ["Missing", project.missingPhotoCount],
        ["Fields", (project.missingFieldPhotoCount || 0) + (project.missingEntryFieldCount || 0)]
      ].map(([label, value]) => `<span class="pill">${label} <strong>${value}</strong></span>`).join("");
    }

    function assetMatchesSearch(asset, term) {
      if (!term) return true;
      const haystack = [
        asset.path,
        asset.name,
        asset.extension,
        ...asset.tags.flatMap((tag) => [tag.kind, tag.label, tag.location, tag.path])
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    }

    function filteredAssets() {
      const term = $("assetSearch").value.trim().toLowerCase();
      return state.data.assets.filter((asset) => {
        if (state.assetFilter === "untagged" && asset.tags.length) return false;
        if (state.assetFilter === "tagged" && !asset.tags.length) return false;
        return assetMatchesSearch(asset, term);
      });
    }

    function renderAssetGrid() {
      const assets = filteredAssets();
      $("selectedCount").textContent = `${state.selectedAssets.size} selected`;
      $("attachSummary").textContent = state.selectedAssets.size
        ? `${state.selectedAssets.size} asset(s) selected`
        : "No assets selected";

      if (!assets.length) {
        $("assetGrid").innerHTML = `<div class="empty">No matching assets</div>`;
        return;
      }

      $("assetGrid").innerHTML = assets.map((asset) => {
        const selected = state.selectedAssets.has(asset.path) ? " selected" : "";
        const tag = asset.tags.length
          ? `<span class="tag">${asset.tags[0].kind}</span>`
          : `<span class="tag warn">new</span>`;
        const title = asset.tags.map((item) => `${item.kind}: ${item.label || item.path || ""}`).join("\n");
        return `
          <button class="asset-card${selected}" type="button" data-asset="${escapeHtml(asset.path)}" title="${escapeHtml(title)}">
            <img src="${thumbUrl(asset.path)}" loading="lazy" alt="${escapeHtml(asset.name)}">
            <div class="asset-name">${escapeHtml(asset.name)}</div>
            <div class="asset-meta"><span>${escapeHtml(asset.sizeLabel)}</span>${tag}</div>
          </button>
        `;
      }).join("");
    }

    function renderSelectedStrip() {
      const selected = [...state.selectedAssets];
      $("selectedStrip").innerHTML = selected.length
        ? selected.map((path) => `<img src="${thumbUrl(path)}" alt="${escapeHtml(path)}" title="${escapeHtml(path)}">`).join("")
        : `<div class="empty">No selected assets</div>`;
    }

    function renderEntryOptions() {
      const search = $("entrySearch").value.trim().toLowerCase();
      const current = $("entrySelect").value;
      const entries = state.data.aircraft.filter((entry) => {
        if (!search) return true;
        return entryOptionLabel(entry).toLowerCase().includes(search) || entry.entryPath.toLowerCase().includes(search);
      });
      $("entrySelect").innerHTML = entries.map((entry) => (
        `<option value="${escapeHtml(entry.entryPath)}">${escapeHtml(entryOptionLabel(entry))}</option>`
      )).join("");
      if (entries.some((entry) => entry.entryPath === current)) {
        $("entrySelect").value = current;
      }
      renderEntryDetail();
    }

    function renderPinOptions() {
      const options = state.data.pins.map((pin) => (
        `<option value="${escapeHtml(pin.key)}">${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
      const selects = ["pinSelect", "editLocation", "locationSelect"];
      for (const id of selects) {
        const current = $(id).value;
        $(id).innerHTML = `<option value="">No location</option>${options}`;
        if (state.data.pins.some((pin) => pin.key === current)) {
          $(id).value = current;
        }
      }
    }

    function renderEntryDetail() {
      const entry = selectedEntry();
      if (!entry) {
        $("entrySummary").textContent = "";
        $("photoList").innerHTML = `<div class="empty">No entry selected</div>`;
        return;
      }
      $("entrySummary").textContent = `${entry.photoCount} photo(s), ${entry.missingPhotoCount} missing source(s), ${entry.entryPath}`;
      if (!entry.photos.length) {
        $("photoList").innerHTML = `<div class="empty">Entry has no photos</div>`;
        return;
      }
      $("photoList").innerHTML = entry.photos.map((photo) => {
        if (photo.invalid) {
          return `<article class="photo-card"><div class="missing">Invalid YAML item</div><div class="mini-meta">${escapeHtml(photo.raw)}</div></article>`;
        }
        const media = photo.exists && photo.sourceAssetPath
          ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
          : `<div class="missing">Missing source</div>`;
        const location = photo.location || photo.pinId || "No location";
        return `
          <article class="photo-card">
            ${media}
            <div class="mini-title">${escapeHtml(photo.path)}</div>
            <div class="mini-meta">${escapeHtml(location)}<br>${escapeHtml(photo.year || photo.date || "")}</div>
            <div class="card-actions">
              <button class="btn ghost" type="button" data-edit-photo="${photo.index}">Edit</button>
              <button class="btn danger" type="button" data-delete-photo="${photo.index}">Delete</button>
            </div>
          </article>
        `;
      }).join("");
    }

    function renderEntryCards() {
      const term = $("entryListSearch").value.trim().toLowerCase();
      const entries = state.data.aircraft.filter((entry) => {
        if (!term) return true;
        return [entry.aircraftType, entry.squadronName, entry.country, entry.entryPath].join(" ").toLowerCase().includes(term);
      });
      $("entryCards").innerHTML = entries.map((entry) => `
        <article class="photo-card">
          <div class="mini-title">${escapeHtml(entry.aircraftType)}</div>
          <div class="mini-meta">${escapeHtml(entry.squadronName)}<br>${escapeHtml(entry.country || "Unknown country")}<br>${escapeHtml(entry.entryPath)}</div>
          <div class="card-actions">
            <button class="btn ghost" type="button" data-open-entry="${escapeHtml(entry.entryPath)}">Open</button>
          </div>
        </article>
      `).join("") || `<div class="empty">No matching entries</div>`;
    }

    function renderLocationDetails() {
      const pin = selectedPin("locationSelect");
      if (!pin) {
        $("locationDetails").textContent = "No location selected";
        return;
      }
      const coord = pin.lat === null || pin.lon === null ? "No coordinates" : `${pin.lat}, ${pin.lon}`;
      const hero = pin.heroPhoto ? `Hero: ${pin.heroPhoto}` : "No custom hero";
      $("locationDetails").innerHTML = `
        <strong>${escapeHtml(pin.name)}</strong><br>
        ${escapeHtml(pin.country)} ${pin.icao ? `- ${escapeHtml(pin.icao)}` : ""}<br>
        ${escapeHtml(coord)}<br>
        ${escapeHtml(hero)}<br>
        ${pin.photoCount} tagged photo(s)
      `;
    }

    function allMissingIssues() {
      const issues = [];
      for (const entry of state.data.aircraft) {
        if (entry.entryMissingFields?.length) {
          issues.push({
            key: `entry::${entry.entryPath}`,
            type: "entry",
            entry,
            missingFields: entry.entryMissingFields,
            labels: entry.entryMissingFields.map((field) => missingFieldLabels[field] || field)
          });
        }
        for (const photo of entry.photos || []) {
          if (photo.invalid || !photo.missingFields?.length) continue;
          issues.push({
            key: `photo::${entry.entryPath}::${photo.index}`,
            type: "photo",
            entry,
            photo,
            missingFields: photo.missingFields,
            labels: photo.missingFields.map((field) => missingFieldLabels[field] || field)
          });
        }
      }
      return issues;
    }

    function filteredMissingIssues() {
      const all = allMissingIssues();
      const term = $("missingSearch").value.trim().toLowerCase();
      const field = $("missingFilter").value;
      return all.filter((issue) => {
        if (field === "entry" && issue.type !== "entry") return false;
        if (field && field !== "entry" && !issue.missingFields.includes(field)) return false;
        if (!term) return true;
        const haystack = [
          issue.type,
          issue.entry.aircraftType,
          issue.entry.squadronName,
          issue.entry.country,
          issue.entry.entryPath,
          issue.photo?.path,
          issue.photo?.location,
          issue.photo?.caption,
          ...issue.labels
        ].join(" ").toLowerCase();
        return haystack.includes(term);
      });
    }

    function getSelectedIssue() {
      return allMissingIssues().find((issue) => issue.key === state.selectedIssueKey) || null;
    }

    function renderMissingFields() {
      const all = allMissingIssues();
      const issues = filteredMissingIssues();
      if (!issues.some((issue) => issue.key === state.selectedIssueKey)) {
        state.selectedIssueKey = issues[0]?.key || "";
      }
      $("missingSummary").textContent = `${issues.length} of ${all.length} item(s)`;
      if (!issues.length) {
        $("missingList").innerHTML = `<div class="empty">No missing fields</div>`;
        $("missingEditor").innerHTML = `<div class="empty">No item selected</div>`;
        return;
      }
      $("missingList").innerHTML = issues.map((issue) => {
        const active = issue.key === state.selectedIssueKey ? " active" : "";
        const media = issue.type === "photo" && issue.photo.exists && issue.photo.sourceAssetPath
          ? `<img src="${thumbUrl(issue.photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(issue.photo.path)}">`
          : "";
        const title = issue.type === "entry"
          ? `${issue.entry.aircraftType} / ${issue.entry.squadronName}`
          : issue.photo.path;
        const meta = issue.type === "entry"
          ? issue.entry.entryPath
          : `${issue.entry.aircraftType} / ${issue.entry.squadronName}`;
        return `
          <button class="issue-card${active}" type="button" data-issue="${escapeHtml(issue.key)}">
            ${media}
            <div class="mini-title">${escapeHtml(title)}</div>
            <div class="mini-meta">${escapeHtml(meta)}</div>
            <div class="issue-tags">${issue.labels.map((label) => `<span class="issue-chip">${escapeHtml(label)}</span>`).join("")}</div>
          </button>
        `;
      }).join("");
      renderMissingEditor();
    }

    function renderMissingEditor() {
      const issue = getSelectedIssue();
      if (!issue) {
        $("missingEditor").innerHTML = `<div class="empty">No item selected</div>`;
        return;
      }
      if (issue.type === "entry") {
        renderMissingEntryEditor(issue);
      } else {
        renderMissingPhotoEditor(issue);
      }
    }

    function renderMissingEntryEditor(issue) {
      $("missingEditor").innerHTML = `
        <div class="form-grid">
          <div class="field wide">
            <label for="missingEntryAircraftType">Aircraft Type</label>
            <input id="missingEntryAircraftType" type="text" value="${escapeHtml(issue.entry.aircraftType || "")}">
          </div>
          <div class="field">
            <label for="missingEntryAircraftFamily">Aircraft Family</label>
            <select id="missingEntryAircraftFamily">
              <option value="">No family</option>
              <option value="fighter"${issue.entry.aircraftFamily === "fighter" ? " selected" : ""}>Fighter</option>
              <option value="heavy"${issue.entry.aircraftFamily === "heavy" ? " selected" : ""}>Heavy</option>
              <option value="helicopter"${issue.entry.aircraftFamily === "helicopter" ? " selected" : ""}>Helicopter</option>
            </select>
          </div>
          <div class="field wide">
            <label for="missingEntrySquadronName">Unit Name</label>
            <input id="missingEntrySquadronName" type="text" value="${escapeHtml(issue.entry.squadronName || "")}">
          </div>
          <div class="field wide">
            <label for="missingEntrySquadronLogo">Squadron Logo</label>
            <input id="missingEntrySquadronLogo" type="text" value="${escapeHtml(issue.entry.squadronLogo || "")}" placeholder="logo.png or ../../../assets/logos/unit.svg">
          </div>
          <div class="field">
            <label for="missingEntryCountry">Country</label>
            <input id="missingEntryCountry" type="text" value="${escapeHtml(issue.entry.country || "")}">
          </div>
          <div class="field">
            <label for="missingEntryUnitType">Unit Type</label>
            <select id="missingEntryUnitType">
              <option value="squadron"${issue.entry.unitType === "squadron" ? " selected" : ""}>Squadron</option>
              <option value="organisation"${issue.entry.unitType === "organisation" ? " selected" : ""}>Organisation</option>
            </select>
          </div>
        </div>
        <div class="mini-meta" style="margin-top: 10px;">${escapeHtml(issue.entry.entryPath)}</div>
        <div class="bar"><button class="btn secondary" id="saveMissingEntryBtn" type="button">Save Entry</button></div>
      `;
    }

    function renderMissingPhotoEditor(issue) {
      const selectedPin = state.data.pins.find((pin) => pin.id === issue.photo.pinId || pin.name === issue.photo.location);
      const pinOptions = state.data.pins.map((pin) => (
        `<option value="${escapeHtml(pin.key)}"${selectedPin?.key === pin.key ? " selected" : ""}>${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
      $("missingEditor").innerHTML = `
        <div class="form-grid">
          <div class="field wide">
            <label for="missingPhotoPath">Path</label>
            <input id="missingPhotoPath" type="text" value="${escapeHtml(issue.photo.path || "")}">
          </div>
          <div class="field wide">
            <label for="missingPhotoLocation">Location</label>
            <select id="missingPhotoLocation"><option value="">No location</option>${pinOptions}</select>
          </div>
          <div class="field">
            <label for="missingPhotoDate">Date</label>
            <input id="missingPhotoDate" type="date" value="${escapeHtml(issue.photo.date || "")}">
          </div>
          <div class="field">
            <label for="missingPhotoYear">Year</label>
            <input id="missingPhotoYear" type="text" inputmode="numeric" value="${escapeHtml(issue.photo.year || "")}">
          </div>
          <div class="field wide">
            <label for="missingPhotoCaption">Caption</label>
            <textarea id="missingPhotoCaption">${escapeHtml(issue.photo.caption || "")}</textarea>
          </div>
        </div>
        <div class="mini-meta" style="margin-top: 10px;">
          ${escapeHtml(issue.entry.aircraftType)} / ${escapeHtml(issue.entry.squadronName)}<br>
          ${escapeHtml(issue.entry.entryPath)}<br>
          EXIF: ${escapeHtml(issue.photo.exifDate || "None")}
        </div>
        <div class="bar"><button class="btn secondary" id="saveMissingPhotoBtn" type="button">Save Photo</button></div>
      `;
    }

    function fillEditor(index) {
      const entry = selectedEntry();
      if (!entry) return;
      const photo = entry.photos.find((item) => item.index === index);
      if (!photo || photo.invalid) return;
      $("editIndex").value = String(index);
      $("editPath").value = photo.path || "";
      $("editDate").value = photo.date || "";
      $("editYear").value = photo.year || "";
      $("editCaption").value = photo.caption || "";
      const matchingPin = state.data.pins.find((pin) => pin.id === photo.pinId || pin.name === photo.location);
      $("editLocation").value = matchingPin ? matchingPin.key : "";
    }

    function clearEditor() {
      $("editIndex").value = "";
      $("editPath").value = "";
      $("editDate").value = "";
      $("editYear").value = "";
      $("editCaption").value = "";
      $("editLocation").value = "";
    }

    async function attachSelected() {
      const entry = selectedEntry();
      if (!entry) throw new Error("Choose an entry.");
      const pin = selectedPin("pinSelect");
      const payload = {
        entryPath: entry.entryPath,
        assetPaths: [...state.selectedAssets],
        locationName: pin ? pin.name : "",
        pinId: pin ? pin.id : "",
        caption: $("captionInput").value,
        date: $("photoDate").value,
        year: $("photoYear").value,
        dedupe: $("dedupeSelect").value !== "allow"
      };
      const result = await api("/api/attach", payload);
      state.selectedAssets.clear();
      toast(result.message);
      await loadState(false);
    }

    async function saveEditedPhoto() {
      const entry = selectedEntry();
      const index = $("editIndex").value;
      if (!entry || index === "") throw new Error("Choose a photo to edit.");
      const pin = selectedPin("editLocation");
      const payload = {
        entryPath: entry.entryPath,
        index: Number(index),
        photo: {
          path: $("editPath").value,
          location: pin ? pin.name : "",
          pin_id: pin ? pin.id : "",
          date: $("editDate").value,
          year: $("editYear").value,
          caption: $("editCaption").value
        }
      };
      const result = await api("/api/update-photo", payload);
      toast(result.message);
      clearEditor();
      await loadState(true);
    }

    async function saveMissingPhoto() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "photo") throw new Error("Choose a photo item.");
      const pin = state.data.pins.find((item) => item.key === $("missingPhotoLocation").value);
      const result = await api("/api/update-photo", {
        entryPath: issue.entry.entryPath,
        index: issue.photo.index,
        photo: {
          path: $("missingPhotoPath").value,
          location: pin ? pin.name : "",
          pin_id: pin ? pin.id : "",
          date: $("missingPhotoDate").value,
          year: $("missingPhotoYear").value,
          title: issue.photo.title || "",
          caption: $("missingPhotoCaption").value
        }
      });
      toast(result.message);
      state.selectedIssueKey = "";
      await loadState(true);
      renderMissingFields();
    }

    async function saveMissingEntry() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "entry") throw new Error("Choose an entry item.");
      const result = await api("/api/update-entry", {
        entryPath: issue.entry.entryPath,
        aircraftType: $("missingEntryAircraftType").value,
        aircraftFamily: $("missingEntryAircraftFamily").value,
        squadronName: $("missingEntrySquadronName").value,
        squadronLogo: $("missingEntrySquadronLogo").value,
        country: $("missingEntryCountry").value,
        unitType: $("missingEntryUnitType").value
      });
      toast(result.message);
      state.selectedIssueKey = "";
      await loadState(true);
      renderMissingFields();
    }

    async function deletePhoto(index) {
      const entry = selectedEntry();
      if (!entry) return;
      const result = await api("/api/delete-photo", {entryPath: entry.entryPath, index});
      toast(result.message);
      clearEditor();
      await loadState(true);
    }

    async function createEntry() {
      const result = await api("/api/create-entry", {
        aircraftType: $("newAircraftType").value,
        squadronName: $("newSquadronName").value,
        country: $("newCountry").value,
        unitType: $("newUnitType").value
      });
      toast(result.message);
      $("newAircraftType").value = "";
      $("newSquadronName").value = "";
      await loadState(false);
      $("entrySelect").value = result.entryPath;
      setTab("attach");
      renderEntryDetail();
    }

    async function createPin() {
      const result = await api("/api/create-pin", {
        country: $("pinCountry").value,
        name: $("pinName").value,
        icao: $("pinIcao").value,
        id: $("pinId").value,
        lat: $("pinLat").value,
        lon: $("pinLon").value
      });
      toast(result.message);
      await loadState(true);
    }

    async function setLocationHero() {
      if (state.selectedAssets.size !== 1) {
        throw new Error("Select exactly one asset.");
      }
      const pin = selectedPin("locationSelect");
      if (!pin) throw new Error("Choose a location.");
      const [assetPath] = [...state.selectedAssets];
      const result = await api("/api/set-pin-hero", {
        pinPath: pin.pinPath,
        pinId: pin.id,
        assetPath
      });
      toast(result.message);
      await loadState(true);
    }

    function appendBuildLog(line, stream = "stdout") {
      const prefix = stream === "stderr" ? "stderr" : "stdout";
      $("buildLog").textContent += `${prefix}: ${line}\n`;
      $("buildLog").scrollTop = $("buildLog").scrollHeight;
    }

    function renderBuildSummary(summary) {
      const counts = summary.manifestCounts || [];
      const changes = summary.generatedChanges || {changes: {}, totals: {}, categoryTotals: {}};
      const warnings = summary.warnings || [];
      const notes = summary.notes || [];
      const scope = summary.commitScope || {sections: [], recommendedGlobs: [], excluded: []};
      const totalChanges = Object.values(changes.totals || {}).reduce((sum, value) => sum + Number(value || 0), 0);

      $("buildSummary").innerHTML = `
        <div class="summary-grid">
          <div class="summary-card">
            <h3>Manifest Counts</h3>
            ${renderCountTable(counts)}
          </div>
          <div class="summary-card">
            <h3>Generated Changes</h3>
            <div class="mini-meta">
              ${totalChanges} file change(s)<br>
              ${Number(changes.categoryTotals?.photos || 0)} photos,
              ${Number(changes.categoryTotals?.thumbs || 0)} thumbs,
              ${Number(changes.categoryTotals?.logos || 0)} logos,
              ${Number(changes.categoryTotals?.data || 0)} data files
            </div>
          </div>
          <div class="summary-card">
            <h3>Warnings</h3>
            ${renderWarningList(warnings, notes)}
          </div>
          <div class="summary-card">
            <h3>Commit Scope</h3>
            ${renderCommitScope(scope)}
          </div>
        </div>
        ${renderChangeGroups(changes)}
      `;
    }

    function renderCountTable(rows) {
      return `
        <table class="count-table">
          <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Delta</th></tr></thead>
          <tbody>
            ${rows.map((row) => {
              const delta = row.delta === "" ? "" : Number(row.delta || 0);
              const deltaClass = delta > 0 ? "delta-pos" : delta < 0 ? "delta-neg" : "";
              const deltaText = row.delta === "" ? "" : `${delta > 0 ? "+" : ""}${delta}`;
              return `
                <tr>
                  <td>${escapeHtml(row.label)}</td>
                  <td>${escapeHtml(row.before)}</td>
                  <td>${escapeHtml(row.after)}</td>
                  <td class="${deltaClass}">${escapeHtml(deltaText)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `;
    }

    function renderWarningList(warnings, notes) {
      const items = [
        ...warnings.map((line) => ({className: "", line})),
        ...notes.map((line) => ({className: "mini-meta", line}))
      ];
      if (!items.length) return `<div class="mini-meta">No warnings or notes</div>`;
      return `<ul class="warning-list">${items.map((item) => `<li class="${item.className}">${escapeHtml(item.line)}</li>`).join("")}</ul>`;
    }

    function renderCommitScope(scope) {
      const included = (scope.sections || []).filter((section) => section.include);
      const sectionHtml = included.length
        ? included.map((section) => {
          const files = section.files?.length
            ? `<ul class="change-list">${section.files.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>`
            : `<div class="mini-meta">Include matching generated output if present.</div>`;
          return `<details class="change-group"><summary>${escapeHtml(section.label)} (${section.files?.length || 0})</summary>${files}</details>`;
        }).join("")
        : `<div class="mini-meta">No tracked commit-scope files changed.</div>`;
      return `
        <div class="mini-meta">Recommended globs: ${(scope.recommendedGlobs || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(", ")}</div>
        <div class="mini-meta">Exclude: ${(scope.excluded || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(", ")}</div>
        ${sectionHtml}
      `;
    }

    function renderChangeGroups(changes) {
      const labels = {
        added: "Added",
        modified: "Modified",
        deleted: "Deleted"
      };
      const categories = [
        ["photos", "Generated photos"],
        ["thumbs", "Generated thumbs"],
        ["logos", "Published logos"],
        ["data", "Generated data"],
        ["other", "Other generated output"]
      ];
      return Object.entries(labels).map(([kind, label]) => {
        const groups = categories.map(([category, categoryLabel]) => {
          const files = changes.changes?.[kind]?.[category] || [];
          if (!files.length) return "";
          return `
            <details class="change-group" open>
              <summary>${escapeHtml(label)} ${escapeHtml(categoryLabel)} (${files.length})</summary>
              <ul class="change-list">
                ${files.map((file) => `
                  <li>
                    <code>${escapeHtml(file.path)}</code>
                    <span>${escapeHtml(file.afterSizeLabel || file.beforeSizeLabel || "")}</span>
                  </li>
                `).join("")}
              </ul>
            </details>
          `;
        }).join("");
        return groups;
      }).join("") || `<div class="empty">No generated file changes</div>`;
    }

    async function runBuild() {
      $("buildBtn").disabled = true;
      $("buildBtn2").disabled = true;
      $("buildStatus").textContent = "Running";
      $("buildLog").textContent = "";
      $("buildSummary").innerHTML = "";
      setTab("build");
      await new Promise((resolve, reject) => {
        let finished = false;
        const source = new EventSource(`/api/build-stream?nonce=${Date.now()}`);

        source.addEventListener("status", (event) => {
          const payload = JSON.parse(event.data);
          $("buildStatus").textContent = payload.message || "Running";
          appendBuildLog(payload.command || payload.message || "Build started", "stdout");
        });
        source.addEventListener("log", (event) => {
          const payload = JSON.parse(event.data);
          appendBuildLog(payload.line || "", payload.stream || "stdout");
          if (payload.kind === "warning") $("buildStatus").textContent = "Running with warnings";
        });
        source.addEventListener("summary", (event) => {
          renderBuildSummary(JSON.parse(event.data));
        });
        source.addEventListener("done", async (event) => {
          const payload = JSON.parse(event.data);
          finished = true;
          source.close();
          $("buildStatus").textContent = `${payload.message} (${payload.durationSeconds}s)`;
          appendBuildLog(`returncode: ${payload.returncode}`, "stdout");
          toast(payload.message);
          await loadState(true);
          resolve();
        });
        source.addEventListener("error", (event) => {
          if (finished) return;
          source.close();
          try {
            const payload = event.data ? JSON.parse(event.data) : {};
            reject(new Error(payload.message || "Build stream failed"));
          } catch (error) {
            reject(new Error("Build stream failed"));
          }
        });
      }).finally(() => {
        $("buildBtn").disabled = false;
        $("buildBtn2").disabled = false;
      });
    }

    function setTab(name) {
      state.activeTab = name;
      document.querySelectorAll(".tab").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === name);
      });
      document.querySelectorAll(".view").forEach((view) => {
        view.classList.toggle("active", view.id === `${name}View`);
      });
    }

    function toast(message) {
      const node = $("toast");
      node.textContent = message;
      node.classList.add("show");
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(() => node.classList.remove("show"), 2800);
    }

    function bindEvents() {
      $("assetSearch").addEventListener("input", renderAssetGrid);
      $("entrySearch").addEventListener("input", renderEntryOptions);
      $("entryListSearch").addEventListener("input", renderEntryCards);
      $("missingSearch").addEventListener("input", renderMissingFields);
      $("missingFilter").addEventListener("change", renderMissingFields);
      $("entrySelect").addEventListener("change", () => {
        clearEditor();
        renderEntryDetail();
      });
      $("locationSelect").addEventListener("change", renderLocationDetails);
      $("reloadBtn").addEventListener("click", () => loadState(true).then(() => toast("Reloaded")));
      $("clearSelectionBtn").addEventListener("click", () => {
        state.selectedAssets.clear();
        renderAssetGrid();
        renderSelectedStrip();
      });
      $("clearEditorBtn").addEventListener("click", clearEditor);
      $("attachBtn").addEventListener("click", () => attachSelected().catch((error) => toast(error.message)));
      $("savePhotoBtn").addEventListener("click", () => saveEditedPhoto().catch((error) => toast(error.message)));
      $("createEntryBtn").addEventListener("click", () => createEntry().catch((error) => toast(error.message)));
      $("createPinBtn").addEventListener("click", () => createPin().catch((error) => toast(error.message)));
      $("setHeroBtn").addEventListener("click", () => setLocationHero().catch((error) => toast(error.message)));
      $("buildBtn").addEventListener("click", () => runBuild().catch((error) => toast(error.message)));
      $("buildBtn2").addEventListener("click", () => runBuild().catch((error) => toast(error.message)));
      $("assetFilter").addEventListener("click", (event) => {
        const button = event.target.closest("button[data-filter]");
        if (!button) return;
        state.assetFilter = button.dataset.filter;
        document.querySelectorAll("#assetFilter button").forEach((node) => node.classList.toggle("active", node === button));
        renderAssetGrid();
      });
      $("assetGrid").addEventListener("click", (event) => {
        const card = event.target.closest("[data-asset]");
        if (!card) return;
        const path = card.dataset.asset;
        if (state.selectedAssets.has(path)) state.selectedAssets.delete(path);
        else state.selectedAssets.add(path);
        renderAssetGrid();
        renderSelectedStrip();
      });
      $("photoList").addEventListener("click", (event) => {
        const edit = event.target.closest("[data-edit-photo]");
        const del = event.target.closest("[data-delete-photo]");
        if (edit) fillEditor(Number(edit.dataset.editPhoto));
        if (del) deletePhoto(Number(del.dataset.deletePhoto)).catch((error) => toast(error.message));
      });
      $("entryCards").addEventListener("click", (event) => {
        const button = event.target.closest("[data-open-entry]");
        if (!button) return;
        $("entrySelect").value = button.dataset.openEntry;
        setTab("attach");
        renderEntryDetail();
      });
      $("missingList").addEventListener("click", (event) => {
        const button = event.target.closest("[data-issue]");
        if (!button) return;
        state.selectedIssueKey = button.dataset.issue;
        renderMissingFields();
      });
      $("missingEditor").addEventListener("click", (event) => {
        if (event.target.closest("#saveMissingPhotoBtn")) {
          saveMissingPhoto().catch((error) => toast(error.message));
        }
        if (event.target.closest("#saveMissingEntryBtn")) {
          saveMissingEntry().catch((error) => toast(error.message));
        }
      });
      document.querySelectorAll(".tab").forEach((button) => {
        button.addEventListener("click", () => setTab(button.dataset.tab));
      });
    }

    bindEvents();
    loadState(false).catch((error) => toast(error.message));
  </script>
</body>
</html>
"""


if __name__ == "__main__":
    raise SystemExit(main())
