#!/usr/bin/env python3
"""Local SpotterDex data manager.

This intentionally stays dependency-light: it uses the Python standard library
for the web server and SQLite catalog plus Pillow for image inspection.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import mimetypes
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

try:
    import yaml
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing PyYAML. Install with: python3 -m pip install -r requirements.txt") from exc

try:
    from PIL import Image, ImageChops, ImageFilter, ImageOps
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing Pillow. Install with: python3 -m pip install -r requirements.txt") from exc

try:
    from prompts import CAPTION_SYSTEM_PROMPT, build_caption_prompt
except ImportError:  # Support importing this module as tools.spotterdex_manager.
    from tools.prompts import CAPTION_SYSTEM_PROMPT, build_caption_prompt

try:
    from spotterdex_db import connect_database, export_snapshot, snapshot_is_current, validate_database
except ImportError:  # Support importing as tools.spotterdex_manager.
    from tools.spotterdex_db import connect_database, export_snapshot, snapshot_is_current, validate_database


ROOT = Path(__file__).resolve().parents[1]
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
CACHE_DIR = ROOT / ".spotterdex-manager-cache"
THUMB_DIR = CACHE_DIR / "thumbs"
# The local-only manager UI is served from these static files (see do_GET). They
# live beside this script and are not part of the published GitHub Pages site.
MANAGER_ASSETS_DIR = Path(__file__).resolve().parent / "manager"
MANAGER_STATIC_FILES = {
    "app.html": "text/html; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
}
# Generated JPEG output directories scanned by the orphan detector.
GENERATED_ORPHAN_DIRS = ("assets/generated/photos", "assets/generated/thumbs")
NVIDIA_CAPTION_ENDPOINT = "https://inference-api.nvidia.com/v1/chat/completions"
NVIDIA_CAPTION_MODEL = "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
NVIDIA_CAPTION_IMAGE_WIDTH = 768
NVIDIA_CAPTION_TIMEOUT_SECONDS = 180
NVIDIA_CAPTION_MAX_TOKENS = 16384
NVIDIA_CAPTION_REASONING_BUDGET = 8192
DOTENV_PATH = ROOT / ".env"
MIN_SOURCE_PHOTO_WIDTH = 2560
QUALITY_ANALYSIS_MAX_DIMENSION = 256
UNDEREXPOSED_MEAN_LUMINANCE = 58
OVEREXPOSED_MEAN_LUMINANCE = 202
CLIPPED_SHADOW_RATIO = 0.24
CLIPPED_HIGHLIGHT_RATIO = 0.24
NEUTRAL_PIXEL_CHROMA_MAX = 32
COLOUR_CAST_CHANNEL_SPREAD = 28
# High-confidence "hard" clipping: a meaningful share of pixels pinned to pure
# black or pure white loses all recoverable detail regardless of overall mean.
TRUE_CLIP_SHADOW_RATIO = 0.06
TRUE_CLIP_HIGHLIGHT_RATIO = 0.05
# A very small p2..p98 luminance spread signals a flat or hazy frame. Kept tight
# so tightly-cropped subjects against plain skies are not routinely flagged.
LOW_CONTRAST_TONAL_RANGE = 55
# Mean edge magnitude on the 256px proxy; below this (on a frame that still has
# usable contrast) the source is likely soft/out of focus. Conservative on
# purpose so sharp subjects against plain skies are not falsely flagged.
SOFT_FOCUS_ACUTANCE = 5.0
# EXIF ISO at or above this is surfaced as a noise-risk note, not a hard fault.
HIGH_ISO_NOISE_THRESHOLD = 6400
# Cast-direction descriptors only appear once a channel imbalance is meaningful.
COLOUR_CAST_DIRECTION_DELTA = 12
# Local-only record of source images the user has reviewed and accepted despite a
# quality warning. Keyed by raw-asset path with the file's size/mtime so editing
# or replacing the image re-surfaces it. Kept out of the build cache so "Clear
# build cache" does not wipe manual review decisions.
QUALITY_ACK_PATH = ROOT / ".spotterdex-manager-quality.json"


class FlowList(list):
    """Marker used to preserve compact coordinate arrays in YAML output."""


class SpotterDexDumper(yaml.SafeDumper):
    pass


class CaptionAssistError(ValueError):
    """A safe, user-facing error from the server-side caption assistant."""


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
        self.database_path = self.root / "content" / "spotterdex.sqlite3"
        self.sql_snapshot_path = self.root / "content" / "spotterdex.sql"
        self._database_write_lock = threading.RLock()
        self.aircraft_dir = self.root / "aircraft"
        self.squadron_dir = self.root / "squadrons"
        self.map_dir = self.root / "map_pins"
        self.airshow_dir = self.root / "airshows"
        self.airshow_events_path = self.airshow_dir / "events.yaml"
        self.raw_assets_dir = self.root / "raw_assets"
        self._exif_date_cache: Dict[str, str] = {}
        self._image_dimension_cache: Dict[str, Tuple[int, int]] = {}
        self._image_quality_cache: Dict[str, Tuple[int, int, Dict[str, Any]]] = {}

    def clear_build_cache(self, _payload: Dict[str, Any]) -> Dict[str, Any]:
        """Discard manager thumbnails and in-memory image metadata caches."""
        file_count = 0
        byte_count = 0
        if CACHE_DIR.exists():
            if CACHE_DIR.is_dir():
                for path in CACHE_DIR.rglob("*"):
                    if path.is_file():
                        file_count += 1
                        byte_count += path.stat().st_size
                shutil.rmtree(CACHE_DIR)
            else:
                file_count = 1
                byte_count = CACHE_DIR.stat().st_size
                CACHE_DIR.unlink()

        metadata_count = (
            len(self._exif_date_cache)
            + len(self._image_dimension_cache)
            + len(self._image_quality_cache)
        )
        self._exif_date_cache.clear()
        self._image_dimension_cache.clear()
        self._image_quality_cache.clear()
        return {
            "ok": True,
            "removedFiles": file_count,
            "removedBytes": byte_count,
            "message": f"Cleared {file_count} cached file(s) and reset {metadata_count} image metadata record(s).",
        }

    def backup_database(self, _payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("The canonical database does not exist.")
        backup_dir = self.root / "content" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f"spotterdex-{time.strftime('%Y%m%d-%H%M%S')}.sqlite3"
        source = self._database_connection(read_only=True)
        destination = sqlite3.connect(backup_path)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        connection = self._database_connection(read_only=True)
        try:
            export_snapshot(connection, self.sql_snapshot_path)
            errors = validate_database(connection, raw_assets_dir=self.raw_assets_dir)
        finally:
            connection.close()
        if errors:
            backup_path.unlink(missing_ok=True)
            raise ValueError("Database integrity check failed: " + "; ".join(errors))
        return {
            "ok": True,
            "backupPath": relative_posix(backup_path, self.root),
            "message": f"Database backup created at {relative_posix(backup_path, self.root)}; SQL snapshot refreshed.",
        }

    def _load_quality_ack(self) -> Dict[str, Dict[str, Any]]:
        """Load the persisted map of source images the user accepted despite warnings."""
        if not QUALITY_ACK_PATH.exists():
            return {}
        try:
            data = json.loads(QUALITY_ACK_PATH.read_text("utf-8"))
        except (OSError, ValueError):
            return {}
        entries = data.get("acknowledged") if isinstance(data, dict) else None
        return entries if isinstance(entries, dict) else {}

    @staticmethod
    def _quality_ack_signature(size: Any, modified: Any) -> str:
        return f"{int(size or 0)}:{int(modified or 0)}"

    def set_quality_acknowledgement(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Persist or clear a reviewer decision to accept a flagged source image."""
        rel = clean_text(payload.get("path"))
        if not rel:
            raise ValueError("An asset path is required.")
        asset_path = self._raw_asset_path(rel)
        acknowledged = bool(payload.get("acknowledged", True))
        store = self._load_quality_ack()
        if acknowledged:
            if not asset_path.exists():
                raise ValueError("This source image no longer exists.")
            stat = asset_path.stat()
            store[rel] = {
                "signature": self._quality_ack_signature(stat.st_size, int(stat.st_mtime)),
                "acknowledgedAt": int(time.time()),
            }
            message = "Marked as reviewed; it will drop out of the quality queue."
        else:
            store.pop(rel, None)
            message = "Cleared the reviewed marker; it will reappear in the quality queue if still flagged."
        try:
            QUALITY_ACK_PATH.write_text(
                json.dumps({"acknowledged": store}, ensure_ascii=True, indent=2),
                "utf-8",
            )
        except OSError as exc:
            raise ValueError(f"Could not save the review decision: {exc}") from exc
        return {"ok": True, "acknowledged": acknowledged, "path": rel, "message": message}

    def find_orphans(self, _payload: Dict[str, Any]) -> Dict[str, Any]:
        """Report generated JPEGs on disk that the manifest no longer references."""
        result = scan_orphaned_generated(self.root)
        result["ok"] = True
        return result

    def delete_orphans(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Delete orphaned generated JPEGs after re-verifying they are unreferenced."""
        scan = scan_orphaned_generated(self.root)
        if not scan.get("manifestReady"):
            raise ValueError(scan.get("message") or "Manifest not ready; refusing to delete.")

        orphan_paths = {item["path"] for item in scan["orphans"]}
        requested = payload.get("paths")
        if requested is None:
            targets = sorted(orphan_paths)
        elif isinstance(requested, list):
            targets = [str(value).strip() for value in requested if str(value).strip()]
        else:
            raise ValueError("The paths field must be a list of file paths.")

        allowed_roots = [(self.root / base).resolve() for base in GENERATED_ORPHAN_DIRS]
        deleted: List[str] = []
        skipped: List[Dict[str, str]] = []
        freed = 0
        for rel in targets:
            if rel not in orphan_paths:
                skipped.append({"path": rel, "reason": "no longer an orphan"})
                continue
            abs_path = (self.root / rel).resolve()
            if not any(self._is_within(abs_path, parent) for parent in allowed_roots):
                skipped.append({"path": rel, "reason": "outside generated output"})
                continue
            if not abs_path.is_file():
                skipped.append({"path": rel, "reason": "already removed"})
                continue
            size = abs_path.stat().st_size
            abs_path.unlink()
            freed += size
            deleted.append(rel)

        if deleted:
            message = f"Deleted {len(deleted)} orphaned file(s); freed {format_bytes(freed)}."
        else:
            message = "No orphaned files were deleted."
        return {
            "ok": True,
            "deleted": deleted,
            "deletedCount": len(deleted),
            "skipped": skipped,
            "skippedCount": len(skipped),
            "freedBytes": freed,
            "freedBytesLabel": format_bytes(freed),
            "message": message,
        }

    def get_state(self) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._get_database_state()
        tag_map: Dict[str, List[Dict[str, Any]]] = {}
        pins, pin_by_id, pin_by_name = self._scan_pins(tag_map)
        aircraft = self._scan_aircraft(tag_map, pin_by_id, pin_by_name)
        squadrons = self._scan_squadrons(tag_map, pin_by_id, pin_by_name)
        location_entries = self._location_entries(pins)
        entries = aircraft + squadrons + location_entries
        squadron_groups = self._squadron_groups(entries)
        airshow_events = self._load_airshow_events()
        assets = self._scan_assets(tag_map)
        used_count = sum(1 for asset in assets if asset["tags"])
        missing_photo_count = sum(
            1
            for entry in entries
            for photo in entry.get("photos", [])
            if photo.get("exists") is False
        )
        missing_field_photo_count = sum(
            1
            for entry in entries
            for photo in entry.get("photos", [])
            if photo.get("missingFields")
        )
        missing_entry_field_count = sum(1 for entry in entries if entry.get("entryMissingFields"))
        under_resolution_asset_count = sum(
            1 for asset in assets if asset.get("isPhotoSource") and asset.get("isUnderResolution")
        )
        exposure_issue_asset_count = sum(1 for asset in assets if asset.get("hasExposureIssue"))
        colour_balance_issue_asset_count = sum(1 for asset in assets if asset.get("hasColourBalanceIssue"))

        def asset_is_flagged(asset: Dict[str, Any]) -> bool:
            return bool(
                asset.get("isPhotoSource")
                and (asset.get("isUnderResolution") or asset.get("qualityFlags"))
            )

        quality_issue_asset_count = sum(1 for asset in assets if asset_is_flagged(asset))
        acknowledged_quality_count = sum(
            1 for asset in assets if asset_is_flagged(asset) and asset.get("qualityAcknowledged")
        )

        return {
            "project": {
                "root": self.root.as_posix(),
                "aircraftCount": len(aircraft),
                "squadronEntryCount": len(squadrons),
                "locationEntryCount": len(location_entries),
                "pinCount": len(pins),
                "assetCount": len(assets),
                "taggedAssetCount": used_count,
                "untaggedAssetCount": len(assets) - used_count,
                "missingPhotoCount": missing_photo_count,
                "missingFieldPhotoCount": missing_field_photo_count,
                "missingEntryFieldCount": missing_entry_field_count,
                "underResolutionAssetCount": under_resolution_asset_count,
                "exposureIssueAssetCount": exposure_issue_asset_count,
                "colourBalanceIssueAssetCount": colour_balance_issue_asset_count,
                "qualityIssueAssetCount": quality_issue_asset_count,
                "acknowledgedQualityCount": acknowledged_quality_count,
                "minimumSourcePhotoWidth": MIN_SOURCE_PHOTO_WIDTH,
            },
            "aircraft": aircraft,
            "squadrons": squadrons,
            "squadronGroups": squadron_groups,
            "entries": entries,
            "pins": pins,
            "assets": assets,
            "airshowEvents": airshow_events,
        }

    def _database_connection(self, *, read_only: bool = False) -> sqlite3.Connection:
        return connect_database(self.database_path, read_only=read_only)

    def _database_write(self, operation: Any) -> Any:
        """Serialize a validated database mutation and refresh the SQL snapshot."""
        with self._database_write_lock:
            connection = self._database_connection()
            try:
                connection.execute("BEGIN")
                result = operation(connection)
                errors = validate_database(connection, raw_assets_dir=self.raw_assets_dir)
                if errors:
                    raise ValueError("Database update failed validation: " + "; ".join(errors))
                connection.commit()
                export_snapshot(connection, self.sql_snapshot_path)
                return result
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    def _database_asset_path(self, value: Any) -> Path:
        text = clean_text(value)
        root_candidate = (self.root / text).resolve()
        return root_candidate if root_candidate.exists() else (self.raw_assets_dir / text).resolve()

    @staticmethod
    def _database_entry_parts(entry_path: str) -> Tuple[str, ...]:
        parts = tuple(str(entry_path or "").split(":"))
        if len(parts) < 3 or parts[0] != "db":
            raise ValueError("Database entry reference is invalid.")
        return parts

    def _database_entry_photo_ids(self, connection: sqlite3.Connection, entry_path: str) -> List[str]:
        parts = self._database_entry_parts(entry_path)
        if parts[1] == "aircraft" and len(parts) == 4:
            rows = connection.execute(
                "SELECT DISTINCT photo_id FROM photo_subjects WHERE aircraft_id=? AND unit_id=? ORDER BY photo_id",
                (parts[2], parts[3]),
            )
        elif parts[1] == "unit" and len(parts) == 3:
            rows = connection.execute(
                "SELECT photo_id FROM photo_subjects WHERE aircraft_id IS NULL AND unit_id=? ORDER BY photo_id",
                (parts[2],),
            )
        elif parts[1] == "location" and len(parts) == 3:
            rows = connection.execute(
                "SELECT p.id FROM photos p WHERE p.location_id=? "
                "AND NOT EXISTS(SELECT 1 FROM photo_subjects s WHERE s.photo_id=p.id) ORDER BY p.id",
                (parts[2],),
            )
        else:
            raise ValueError("Database entry reference is invalid.")
        return [str(row[0]) for row in rows]

    def _database_photo_id(self, connection: sqlite3.Connection, payload: Dict[str, Any]) -> str:
        ids = self._database_entry_photo_ids(connection, clean_text(payload.get("entryPath")))
        try:
            index = int(payload.get("index"))
        except (TypeError, ValueError) as exc:
            raise ValueError("Photo index is invalid.") from exc
        if index < 0 or index >= len(ids):
            raise ValueError("Photo index is invalid.")
        return ids[index]

    def _get_database_state(self) -> Dict[str, Any]:
        tag_map: Dict[str, List[Dict[str, Any]]] = {}
        connection = self._database_connection(read_only=True)
        try:
            countries = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM countries")}
            aircraft = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM aircraft")}
            units = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM units")}
            locations = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM locations")}
            events = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM events")}
            photos = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM photos")}
            subjects: Dict[str, List[Dict[str, Any]]] = {}
            for row in connection.execute("SELECT * FROM photo_subjects ORDER BY photo_id,position"):
                subjects.setdefault(str(row["photo_id"]), []).append(dict(row))
            relations = [dict(row) for row in connection.execute("SELECT * FROM aircraft_units ORDER BY aircraft_id,unit_id")]
            integrity_errors = validate_database(connection, raw_assets_dir=self.raw_assets_dir)
            snapshot_current = snapshot_is_current(connection, self.sql_snapshot_path)
        finally:
            connection.close()

        photo_record_cache: Dict[str, Dict[str, Any]] = {}
        for photo_id, photo in photos.items():
            location = locations[photo["location_id"]]
            event = events.get(photo.get("event_id")) or {}
            source_path = self.raw_assets_dir / photo["source_path"]
            exists = source_path.is_file()
            exif_date = read_image_capture_date(source_path, self._exif_date_cache) if exists else ""
            width, height = read_image_dimensions(source_path, self._image_dimension_cache) if exists else (0, 0)
            photo_item = {
                "path": photo["source_path"],
                "location": location["name"],
                "date": photo.get("date_override") or "",
                "caption": photo.get("caption") or "",
            }
            missing_fields = missing_photo_fields(photo_item, exists, location["name"], exif_date)
            photo_record_cache[photo_id] = {
                "photoId": photo_id,
                "path": photo["source_path"],
                "sourceAssetPath": photo["source_path"] if exists else "",
                "exists": exists,
                "sourceWidth": width,
                "sourceHeight": height,
                "sourceUnderMinimumWidth": bool(width and width < MIN_SOURCE_PHOTO_WIDTH),
                "location": location["name"],
                "pinId": location["id"],
                "date": photo.get("date_override") or "",
                "year": (photo.get("date_override") or exif_date or "")[:4],
                "exifDate": exif_date,
                "airshow": event.get("name", ""),
                "livery": photo.get("livery") or "",
                "title": photo.get("title") or "",
                "caption": photo.get("caption") or "",
                "captionAiAssisted": bool(photo.get("caption_ai_assisted")),
                "missingFields": missing_fields,
                "missingFieldLabels": [MISSING_FIELD_LABELS[field] for field in missing_fields],
            }

        def indexed_records(ids: List[str], entry_path: str, kind: str, label: str) -> List[Dict[str, Any]]:
            records: List[Dict[str, Any]] = []
            for index, photo_id in enumerate(ids):
                record = dict(photo_record_cache[photo_id])
                record["index"] = index
                records.append(record)
                source = record.get("sourceAssetPath")
                if source:
                    tag_map.setdefault(source, []).append(
                        {"kind": kind, "label": label, "location": record["location"], "path": entry_path, "index": index}
                    )
            return records

        aircraft_entries: List[Dict[str, Any]] = []
        unit_entries: List[Dict[str, Any]] = []
        location_entries: List[Dict[str, Any]] = []
        aircraft_catalog: List[Dict[str, Any]] = []
        pins: List[Dict[str, Any]] = []
        reference_by_photo: Dict[str, Dict[str, Any]] = {}

        for relation in relations:
            aircraft_row = aircraft[relation["aircraft_id"]]
            unit = units[relation["unit_id"]]
            entry_path = f"db:aircraft:{aircraft_row['id']}:{unit['id']}"
            ids = sorted(
                photo_id
                for photo_id, values in subjects.items()
                if any(value.get("aircraft_id") == aircraft_row["id"] and value.get("unit_id") == unit["id"] for value in values)
            )
            records = indexed_records(ids, entry_path, "photo", f"{aircraft_row['name']} / {unit['name']}")
            for record in records:
                reference_by_photo.setdefault(record["photoId"], {"scope": "aircraft", "entryPath": entry_path, "targetPinId": "", "index": record["index"]})
            logo_path = self._database_asset_path(unit.get("logo_source")) if unit.get("logo_source") else None
            hero_photo = photos.get(unit.get("hero_photo_id")) or {}
            hero_source = clean_text(hero_photo.get("source_path"))
            aircraft_entries.append(
                {
                    "targetKey": entry_path,
                    "sourceScope": "aircraft",
                    "entryPath": entry_path,
                    "entryDir": "content",
                    "aircraftId": aircraft_row["id"],
                    "unitId": unit["id"],
                    "aircraftType": aircraft_row["name"],
                    "aircraftDoubleWidth": (
                        None if aircraft_row.get("double_width") is None else bool(aircraft_row.get("double_width"))
                    ),
                    "squadronName": unit["name"],
                    "country": countries[unit["country_id"]]["name"],
                    "unitType": unit["kind"],
                    "unitLabel": "Organisation" if unit["kind"] == "organisation" else "Squadron",
                    "aircraftFamily": aircraft_row["family"],
                    "squadronLogo": unit.get("logo_source") or "",
                    "squadronLogoExists": bool(logo_path and logo_path.is_file()),
                    "squadronHero": hero_source,
                    "squadronHeroAssetPath": hero_source,
                    "writeUp": clean_text(unit.get("write_up")),
                    # Logos belong to the unit, not to each aircraft/unit
                    # relationship. The unit entry below is the sole editor and
                    # missing-field record for this shared value.
                    "entryMissingFields": [],
                    "photoCount": len(records),
                    "missingPhotoCount": sum(record.get("exists") is False for record in records),
                    "missingFieldPhotoCount": sum(bool(record.get("missingFields")) for record in records),
                    "photos": records,
                }
            )

        for unit in units.values():
            entry_path = f"db:unit:{unit['id']}"
            ids = sorted(
                photo_id
                for photo_id, values in subjects.items()
                if any(value.get("aircraft_id") is None and value.get("unit_id") == unit["id"] for value in values)
            )
            records = indexed_records(ids, entry_path, "squadron photo", unit["name"])
            for record in records:
                reference_by_photo.setdefault(record["photoId"], {"scope": "squadron", "entryPath": entry_path, "targetPinId": "", "index": record["index"]})
            logo_path = self._database_asset_path(unit.get("logo_source")) if unit.get("logo_source") else None
            hero_photo = photos.get(unit.get("hero_photo_id")) or {}
            hero_source = clean_text(hero_photo.get("source_path"))
            unit_entries.append(
                {
                    "targetKey": entry_path,
                    "sourceScope": "squadron",
                    "entryPath": entry_path,
                    "entryDir": "content",
                    "unitId": unit["id"],
                    "aircraftType": "",
                    "squadronName": unit["name"],
                    "country": countries[unit["country_id"]]["name"],
                    "unitType": unit["kind"],
                    "unitLabel": "Organisation" if unit["kind"] == "organisation" else "Squadron",
                    "aircraftFamily": "",
                    "squadronLogo": unit.get("logo_source") or "",
                    "squadronLogoExists": bool(logo_path and logo_path.is_file()),
                    "squadronHero": hero_source,
                    "squadronHeroAssetPath": hero_source,
                    "writeUp": clean_text(unit.get("write_up")),
                    "entryMissingFields": ["squadronLogo"] if not (logo_path and logo_path.is_file()) else [],
                    "photoCount": len(records),
                    "missingPhotoCount": sum(record.get("exists") is False for record in records),
                    "missingFieldPhotoCount": sum(bool(record.get("missingFields")) for record in records),
                    "photos": records,
                }
            )

        for location in locations.values():
            entry_path = f"db:location:{location['id']}"
            ids = sorted(photo_id for photo_id, photo in photos.items() if photo["location_id"] == location["id"] and not subjects.get(photo_id))
            records = indexed_records(ids, entry_path, "location photo", location["name"])
            for record in records:
                reference_by_photo.setdefault(record["photoId"], {"scope": "location", "entryPath": entry_path, "targetPinId": location["id"], "index": record["index"]})
            hero_photo = photos.get(location.get("hero_photo_id")) or {}
            hero_source = clean_text(hero_photo.get("source_path"))
            pin = {
                "key": entry_path,
                "id": location["id"],
                "name": location["name"],
                "country": countries[location["country_id"]]["name"],
                "icao": location.get("icao") or "",
                "lat": location["latitude"],
                "lon": location["longitude"],
                "enabled": bool(location["enabled"]),
                "pinPath": entry_path,
                "pinIndex": 0,
                "heroPhoto": hero_source,
                "heroAssetPath": hero_source,
                "heroExists": bool(hero_source and (self.raw_assets_dir / hero_source).is_file()),
                "photoCount": sum(photo["location_id"] == location["id"] for photo in photos.values()),
                "photos": records,
            }
            pins.append(pin)
            location_entries.append(
                {
                    "targetKey": f"location::{entry_path}",
                    "sourceScope": "location",
                    "entryPath": entry_path,
                    "pinId": location["id"],
                    "entryDir": "content",
                    "aircraftType": "",
                    "squadronName": "",
                    "country": pin["country"],
                    "unitType": "",
                    "unitLabel": "Location",
                    "aircraftFamily": "",
                    "squadronLogo": "",
                    "squadronLogoExists": False,
                    "entryMissingFields": [],
                    "photoCount": len(records),
                    "missingPhotoCount": sum(record.get("exists") is False for record in records),
                    "missingFieldPhotoCount": sum(bool(record.get("missingFields")) for record in records),
                    "photos": records,
                    "locationName": location["name"],
                }
            )

        for aircraft_row in aircraft.values():
            candidate_photos: List[Dict[str, Any]] = []
            seen_photo_ids: set[str] = set()
            for entry in aircraft_entries:
                if entry.get("aircraftId") != aircraft_row["id"]:
                    continue
                for photo in entry.get("photos", []):
                    photo_id = clean_text(photo.get("photoId"))
                    if not photo_id or photo_id in seen_photo_ids:
                        continue
                    candidate = dict(photo)
                    candidate["entryTargetKey"] = entry["targetKey"]
                    candidate_photos.append(candidate)
                    seen_photo_ids.add(photo_id)
            hero_photo = photos.get(aircraft_row.get("hero_photo_id")) or {}
            hero_source = clean_text(hero_photo.get("source_path"))
            aircraft_catalog.append(
                {
                    "id": aircraft_row["id"],
                    "name": aircraft_row["name"],
                    "family": aircraft_row["family"],
                    "doubleWidth": (
                        None if aircraft_row.get("double_width") is None else bool(aircraft_row.get("double_width"))
                    ),
                    "heroPhotoId": clean_text(aircraft_row.get("hero_photo_id")),
                    "heroAssetPath": hero_source,
                    "heroExists": bool(hero_source and (self.raw_assets_dir / hero_source).is_file()),
                    "writeUp": clean_text(aircraft_row.get("write_up")),
                    "photoCount": len(candidate_photos),
                    "photos": candidate_photos,
                }
            )

        for unit in units.values():
            logo = clean_text(unit.get("logo_source"))
            if logo and (self.raw_assets_dir / logo).is_file():
                tag_map.setdefault(logo, []).append({"kind": "logo", "label": unit["name"], "path": f"db:unit:{unit['id']}"})
            hero = photos.get(unit.get("hero_photo_id")) or {}
            if hero.get("source_path"):
                tag_map.setdefault(hero["source_path"], []).append({"kind": "squadron hero", "label": unit["name"], "path": f"db:unit:{unit['id']}"})
        for location in locations.values():
            hero = photos.get(location.get("hero_photo_id")) or {}
            if hero.get("source_path"):
                tag_map.setdefault(hero["source_path"], []).append({"kind": "pin hero", "label": location["name"], "path": f"db:location:{location['id']}"})
        for aircraft_row in aircraft.values():
            hero = photos.get(aircraft_row.get("hero_photo_id")) or {}
            if hero.get("source_path"):
                tag_map.setdefault(hero["source_path"], []).append({"kind": "aircraft hero", "label": aircraft_row["name"], "path": f"db:aircraft:{aircraft_row['id']}"})

        entries = aircraft_entries + unit_entries + location_entries
        assets = self._scan_assets(tag_map)
        master_photos: List[Dict[str, Any]] = []
        for photo_id, photo in photos.items():
            location = locations[photo["location_id"]]
            event = events.get(photo.get("event_id")) or {}
            subject_items: List[Dict[str, Any]] = []
            for subject in subjects.get(photo_id, []):
                aircraft_row = aircraft.get(subject.get("aircraft_id")) if subject.get("aircraft_id") else None
                unit = units.get(subject.get("unit_id")) if subject.get("unit_id") else None
                if not aircraft_row and not unit:
                    continue
                subject_item = {
                    "aircraftId": aircraft_row["id"] if aircraft_row else "",
                    "aircraftType": aircraft_row["name"] if aircraft_row else "",
                    "unitId": unit["id"] if unit else "",
                    "unitName": unit["name"] if unit else "",
                    "country": countries[unit["country_id"]]["name"] if unit else "",
                    "isPrimary": bool(subject.get("is_primary")),
                }
                subject_item["entryPath"] = (
                    f"db:aircraft:{subject_item['aircraftId']}:{subject_item['unitId']}"
                    if subject_item["aircraftId"]
                    else f"db:unit:{subject_item['unitId']}"
                )
                subject_items.append(subject_item)
            record = photo_record_cache[photo_id]
            master_photos.append(
                {
                    "id": photo_id,
                    "path": photo["source_path"],
                    "sourceAssetPath": record["sourceAssetPath"],
                    "exists": record["exists"],
                    "sourceWidth": record["sourceWidth"],
                    "sourceHeight": record["sourceHeight"],
                    "locationId": location["id"],
                    "location": location["name"],
                    "country": countries[location["country_id"]]["name"],
                    "eventId": photo.get("event_id") or "",
                    "airshow": event.get("name", ""),
                    "date": photo.get("date_override") or "",
                    "exifDate": record["exifDate"],
                    "title": photo.get("title") or "",
                    "caption": photo.get("caption") or "",
                    "livery": photo.get("livery") or "",
                    "captionAiAssisted": bool(photo.get("caption_ai_assisted")),
                    "subjects": subject_items,
                }
            )
        master_photos.sort(key=lambda item: (
            not bool(item.get("date") or item.get("exifDate")),
            -(capture_date_sort_value(item.get("date") or item.get("exifDate") or "")),
            item["path"],
        ))
        airshow_events = [
            {"id": event["id"], "name": event["name"], "writeUp": clean_text(event.get("write_up")), "hero": reference_by_photo.get(event.get("hero_photo_id"), {})}
            for event in events.values()
        ]
        squadron_groups = self._squadron_groups(entries)
        return {
            "project": {
                "root": self.root.as_posix(),
                "databasePath": relative_posix(self.database_path, self.root),
                "databaseIntegrity": "ok" if not integrity_errors else "error",
                "databaseErrors": integrity_errors,
                "sqlSnapshotCurrent": snapshot_current,
                "aircraftCount": len(aircraft),
                "squadronEntryCount": len(units),
                "locationEntryCount": len(location_entries),
                "photoCount": len(master_photos),
                "pinCount": len(pins),
                "assetCount": len(assets),
                "taggedAssetCount": sum(1 for asset in assets if asset["tags"]),
                "untaggedAssetCount": sum(1 for asset in assets if not asset["tags"]),
                "missingPhotoCount": sum(not record["exists"] for record in photo_record_cache.values()),
                "missingFieldPhotoCount": sum(bool(record["missingFields"]) for record in photo_record_cache.values()),
                "missingEntryFieldCount": sum(1 for entry in entries if entry.get("entryMissingFields")),
                "underResolutionAssetCount": sum(1 for asset in assets if asset.get("isPhotoSource") and asset.get("isUnderResolution")),
                "exposureIssueAssetCount": sum(1 for asset in assets if asset.get("hasExposureIssue")),
                "colourBalanceIssueAssetCount": sum(1 for asset in assets if asset.get("hasColourBalanceIssue")),
                "qualityIssueAssetCount": sum(1 for asset in assets if asset.get("isPhotoSource") and (asset.get("isUnderResolution") or asset.get("qualityFlags"))),
                "acknowledgedQualityCount": sum(1 for asset in assets if asset.get("qualityAcknowledged")),
                "minimumSourcePhotoWidth": MIN_SOURCE_PHOTO_WIDTH,
            },
            "aircraft": sorted(aircraft_entries, key=lambda item: (item["aircraftType"], item["country"], item["squadronName"])),
            "aircraftCatalog": sorted(aircraft_catalog, key=lambda item: (item["name"], item["id"])),
            "squadrons": sorted(unit_entries, key=lambda item: (item["country"], item["squadronName"])),
            "squadronGroups": squadron_groups,
            "entries": entries,
            "masterPhotos": master_photos,
            "pins": sorted(pins, key=lambda item: (item["country"], item["name"])),
            "assets": assets,
            "airshowEvents": sorted(airshow_events, key=lambda item: item["name"]),
        }

    @staticmethod
    def _unique_database_id(connection: sqlite3.Connection, table: str, base: str) -> str:
        candidate = slugify(base)
        suffix = 2
        while connection.execute(f'SELECT 1 FROM "{table}" WHERE id=?', (candidate,)).fetchone():
            candidate = f"{slugify(base)}-{suffix}"
            suffix += 1
        return candidate

    @staticmethod
    def _database_country_id(connection: sqlite3.Connection, country_name: str) -> str:
        row = connection.execute("SELECT id FROM countries WHERE lower(name)=lower(?)", (country_name,)).fetchone()
        if not row:
            raise ValueError(f"Unknown country '{country_name}'. Add it through a catalog migration first.")
        return str(row[0])

    def _ensure_database_event(
        self,
        connection: sqlite3.Connection,
        name: str,
        location_id: str,
        capture_date: str = "",
    ) -> Optional[str]:
        name = clean_text(name)
        if not name:
            return None
        row = connection.execute("SELECT id FROM events WHERE lower(name)=lower(?)", (name,)).fetchone()
        if row:
            event_id = str(row[0])
        else:
            country = connection.execute("SELECT country_id FROM locations WHERE id=?", (location_id,)).fetchone()
            prefix = str(country[0]) if country else "global"
            event_id = self._unique_database_id(connection, "events", f"{prefix}-{name}")
            connection.execute(
                "INSERT INTO events(id,name,starts_on,ends_on) VALUES(?,?,?,?)",
                (event_id, name, capture_date or None, capture_date or None),
            )
        connection.execute(
            "INSERT OR IGNORE INTO event_locations(event_id,location_id) VALUES(?,?)",
            (event_id, location_id),
        )
        if capture_date:
            connection.execute(
                "UPDATE events SET starts_on=CASE WHEN starts_on IS NULL OR starts_on>? THEN ? ELSE starts_on END, "
                "ends_on=CASE WHEN ends_on IS NULL OR ends_on<? THEN ? ELSE ends_on END WHERE id=?",
                (capture_date, capture_date, capture_date, capture_date, event_id),
            )
        return event_id

    def _database_target_subject(self, entry_path: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        parts = self._database_entry_parts(entry_path)
        if parts[1] == "aircraft" and len(parts) == 4:
            return parts[2], parts[3], None
        if parts[1] == "unit" and len(parts) == 3:
            return None, parts[2], None
        if parts[1] == "location" and len(parts) == 3:
            return None, None, parts[2]
        raise ValueError("Database target is invalid.")

    def _database_append_photos(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        asset_paths = payload.get("assetPaths") or []
        if not isinstance(asset_paths, list) or not asset_paths:
            raise ValueError("Select at least one raw asset.")
        entry_path = clean_text(payload.get("entryPath"))
        squadron_target = payload.get("squadronTarget")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            nonlocal entry_path
            if squadron_target and not entry_path:
                country_id = self._database_country_id(connection, clean_text(squadron_target.get("country")))
                unit = connection.execute(
                    "SELECT id FROM units WHERE country_id=? AND lower(name)=lower(?)",
                    (country_id, clean_text(squadron_target.get("squadronName"))),
                ).fetchone()
                if not unit:
                    raise ValueError("The selected unit no longer exists.")
                entry_path = f"db:unit:{unit[0]}"
            aircraft_id, unit_id, target_location_id = self._database_target_subject(entry_path)
            location_id = target_location_id or clean_text(payload.get("pinId"))
            if not connection.execute("SELECT 1 FROM locations WHERE id=?", (location_id,)).fetchone():
                raise ValueError("Choose a valid location.")
            date_override = normalize_date_value(payload.get("date")) or None
            appended: List[str] = []
            skipped: List[str] = []
            for value in asset_paths:
                source_path = self._raw_asset_path(value)
                if not source_path.is_file() or source_path.suffix.lower() not in IMAGE_EXTENSIONS:
                    skipped.append(f"{value} (missing or unsupported)")
                    continue
                source_rel = relative_posix(source_path, self.raw_assets_dir)
                if connection.execute("SELECT 1 FROM photos WHERE source_path=?", (source_rel,)).fetchone():
                    skipped.append(f"{source_rel} (already cataloged)")
                    continue
                exif_date = read_image_capture_date(source_path, self._exif_date_cache)
                capture_date = date_override or exif_date
                prefix = capture_date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", capture_date or "") else "undated"
                photo_id = self._unique_database_id(connection, "photos", f"{prefix}-{source_path.stem}")
                event_id = self._ensure_database_event(
                    connection,
                    clean_text(payload.get("airshow")),
                    location_id,
                    capture_date or "",
                )
                connection.execute(
                    "INSERT INTO photos(id,source_path,location_id,event_id,date_override,caption,livery,caption_ai_assisted) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (
                        photo_id,
                        source_rel,
                        location_id,
                        event_id,
                        date_override,
                        clean_text(payload.get("caption")),
                        clean_text(payload.get("livery")),
                        1 if payload.get("captionAiAssisted") else 0,
                    ),
                )
                if aircraft_id or unit_id:
                    connection.execute(
                        "INSERT INTO photo_subjects(photo_id,position,aircraft_id,unit_id,is_primary) VALUES(?,?,?,?,1)",
                        (photo_id, 0, aircraft_id, unit_id),
                    )
                appended.append(source_rel)
            return {"ok": True, "message": f"Attached {len(appended)} asset(s).", "appended": appended, "skipped": skipped}

        return self._database_write(operation)

    def _database_update_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        incoming = payload.get("photo") or {}
        if not isinstance(incoming, dict):
            raise ValueError("Photo payload must be an object.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            photo_id = self._database_photo_id(connection, payload)
            current = connection.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
            if not current:
                raise ValueError("Photo no longer exists.")
            source_path = clean_text(incoming.get("path"))
            if not source_path:
                raise ValueError("Photo path is required.")
            location_id = clean_text(incoming.get("pin_id")) or str(current["location_id"])
            if not connection.execute("SELECT 1 FROM locations WHERE id=?", (location_id,)).fetchone():
                raise ValueError("Choose a valid location.")
            date_override = normalize_date_value(incoming.get("date")) or None
            source_abs = self.raw_assets_dir / source_path
            capture_date = date_override or (read_image_capture_date(source_abs, self._exif_date_cache) if source_abs.is_file() else "")
            event_id = self._ensure_database_event(connection, clean_text(incoming.get("airshow")), location_id, capture_date)
            connection.execute(
                "UPDATE photos SET source_path=?,location_id=?,event_id=?,date_override=?,title=?,caption=?,livery=?,caption_ai_assisted=? WHERE id=?",
                (
                    source_path,
                    location_id,
                    event_id,
                    date_override,
                    clean_text(incoming.get("title")),
                    clean_text(incoming.get("caption")),
                    clean_text(incoming.get("livery")),
                    1 if payload_caption_is_ai_assisted(incoming) or current["caption_ai_assisted"] else 0,
                    photo_id,
                ),
            )
            destination = clean_text(payload.get("tagTargetEntryPath"))
            squadron = payload.get("tagTargetSquadron")
            if squadron and not destination:
                country_id = self._database_country_id(connection, clean_text(squadron.get("country")))
                unit = connection.execute(
                    "SELECT id FROM units WHERE country_id=? AND lower(name)=lower(?)",
                    (country_id, clean_text(squadron.get("squadronName"))),
                ).fetchone()
                if not unit:
                    raise ValueError("The selected unit no longer exists.")
                destination = f"db:unit:{unit[0]}"
            if destination and destination != clean_text(payload.get("entryPath")):
                aircraft_id, unit_id, _ = self._database_target_subject(destination)
                connection.execute("DELETE FROM photo_subjects WHERE photo_id=?", (photo_id,))
                if aircraft_id or unit_id:
                    connection.execute(
                        "INSERT INTO photo_subjects(photo_id,position,aircraft_id,unit_id,is_primary) VALUES(?,?,?,?,1)",
                        (photo_id, 0, aircraft_id, unit_id),
                    )
            return {"ok": True, "message": "Photo updated."}

        return self._database_write(operation)

    def _database_update_master_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        incoming = payload.get("photo") or {}
        if not isinstance(incoming, dict):
            raise ValueError("Photo payload must be an object.")
        photo_id = clean_text(payload.get("photoId"))
        if not photo_id:
            raise ValueError("Photo id is required.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            current = connection.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
            if not current:
                raise ValueError("Photo no longer exists.")
            location_id = clean_text(incoming.get("locationId")) or str(current["location_id"])
            if not connection.execute("SELECT 1 FROM locations WHERE id=?", (location_id,)).fetchone():
                raise ValueError("Choose a valid location.")
            date_override = normalize_date_value(incoming.get("date")) or None
            source_abs = self.raw_assets_dir / current["source_path"]
            capture_date = date_override or (
                read_image_capture_date(source_abs, self._exif_date_cache) if source_abs.is_file() else ""
            )
            event_id = self._ensure_database_event(
                connection,
                clean_text(incoming.get("airshow")),
                location_id,
                capture_date,
            )
            connection.execute(
                "UPDATE photos SET location_id=?,event_id=?,date_override=?,title=?,caption=?,livery=? WHERE id=?",
                (
                    location_id,
                    event_id,
                    date_override,
                    clean_text(incoming.get("title")),
                    clean_text(incoming.get("caption")),
                    clean_text(incoming.get("livery")),
                    photo_id,
                ),
            )
            return {"ok": True, "message": "Master photo updated.", "photoId": photo_id}

        return self._database_write(operation)

    def _database_bulk_update_photos(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        references = payload.get("photos") or []
        fields = payload.get("fields") or {}
        if not isinstance(references, list) or not references:
            raise ValueError("Choose at least one photo.")
        if not isinstance(fields, dict) or not fields:
            raise ValueError("Choose at least one field to update.")
        unknown_fields = set(fields) - {"locationId", "date", "airshow", "livery", "caption"}
        if unknown_fields:
            raise ValueError("Bulk update contains unsupported fields: " + ", ".join(sorted(unknown_fields)))

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            photo_ids: List[str] = []
            for reference in references:
                if not isinstance(reference, dict):
                    raise ValueError("Photo references are invalid.")
                photo_id = clean_text(reference.get("photoId"))
                if not photo_id:
                    photo_id = self._database_photo_id(connection, reference)
                if not connection.execute("SELECT 1 FROM photos WHERE id=?", (photo_id,)).fetchone():
                    raise ValueError("A selected photo no longer exists.")
                if photo_id not in photo_ids:
                    photo_ids.append(photo_id)

            location_id = None
            if "locationId" in fields:
                location_id = clean_text(fields.get("locationId"))
                if not location_id or not connection.execute("SELECT 1 FROM locations WHERE id=?", (location_id,)).fetchone():
                    raise ValueError("Choose a valid location.")

            for photo_id in photo_ids:
                current = connection.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
                next_location_id = location_id or str(current["location_id"])
                next_date = current["date_override"]
                if "date" in fields:
                    next_date = normalize_date_value(fields.get("date")) or None

                next_event_id = current["event_id"]
                if "airshow" in fields:
                    event_name = clean_text(fields.get("airshow"))
                    source_abs = self.raw_assets_dir / current["source_path"]
                    capture_date = next_date or (
                        read_image_capture_date(source_abs, self._exif_date_cache) if source_abs.is_file() else ""
                    )
                    next_event_id = self._ensure_database_event(
                        connection,
                        event_name,
                        next_location_id,
                        capture_date,
                    )
                elif location_id is not None and next_event_id:
                    connection.execute(
                        "INSERT OR IGNORE INTO event_locations(event_id,location_id) VALUES(?,?)",
                        (next_event_id, next_location_id),
                    )

                assignments: List[str] = []
                values: List[Any] = []
                if location_id is not None:
                    assignments.append("location_id=?")
                    values.append(next_location_id)
                if "date" in fields:
                    assignments.append("date_override=?")
                    values.append(next_date)
                if "airshow" in fields:
                    assignments.append("event_id=?")
                    values.append(next_event_id)
                if "livery" in fields:
                    assignments.append("livery=?")
                    values.append(clean_text(fields.get("livery")))
                if "caption" in fields:
                    assignments.append("caption=?")
                    values.append(clean_text(fields.get("caption")))
                if assignments:
                    values.append(photo_id)
                    connection.execute(
                        f"UPDATE photos SET {','.join(assignments)} WHERE id=?",
                        values,
                    )

            return {
                "ok": True,
                "updated": len(photo_ids),
                "message": f"Updated {len(photo_ids)} photo(s).",
            }

        return self._database_write(operation)

    @staticmethod
    def _database_clear_photo_hero_references(connection: sqlite3.Connection, photo_id: str) -> None:
        for table in ("aircraft", "units", "locations", "events"):
            connection.execute(f"UPDATE {table} SET hero_photo_id=NULL WHERE hero_photo_id=?", (photo_id,))

    def _database_delete_master_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        photo_id = clean_text(payload.get("photoId"))
        if not photo_id:
            raise ValueError("Photo id is required.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            source = connection.execute("SELECT source_path FROM photos WHERE id=?", (photo_id,)).fetchone()
            if not source:
                raise ValueError("Photo no longer exists.")
            self._database_clear_photo_hero_references(connection, photo_id)
            connection.execute("DELETE FROM photos WHERE id=?", (photo_id,))
            return {
                "ok": True,
                "message": "Raw image detached from the database. The file remains in raw_assets.",
                "removed": {"id": photo_id, "path": source[0]},
            }

        return self._database_write(operation)

    def _database_bulk_update_airshow(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        references = payload.get("photos") or []
        if not isinstance(references, list) or not references:
            raise ValueError("Choose at least one photo to tag.")
        event_name = clean_text(payload.get("airshow"))

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            photo_ids = list(dict.fromkeys(self._database_photo_id(connection, ref) for ref in references if isinstance(ref, dict)))
            updated = 0
            for photo_id in photo_ids:
                photo = connection.execute("SELECT location_id,date_override,event_id,source_path FROM photos WHERE id=?", (photo_id,)).fetchone()
                source = self.raw_assets_dir / photo["source_path"]
                capture_date = photo["date_override"] or (read_image_capture_date(source, self._exif_date_cache) if source.is_file() else "")
                event_id = self._ensure_database_event(connection, event_name, photo["location_id"], capture_date) if event_name else None
                if photo["event_id"] != event_id:
                    connection.execute("UPDATE photos SET event_id=? WHERE id=?", (event_id, photo_id))
                    updated += 1
            action = f"Set event '{event_name}'" if event_name else "Cleared event"
            return {"ok": True, "updated": updated, "unchanged": len(photo_ids) - updated, "message": f"{action} on {updated} photo(s)."}

        return self._database_write(operation)

    def _database_set_airshow_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        event_name = clean_text(payload.get("eventName"))
        if not event_name:
            raise ValueError("An event name is required.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            event = connection.execute("SELECT id FROM events WHERE lower(name)=lower(?)", (event_name,)).fetchone()
            if not event:
                raise ValueError("Event not found.")
            hero = payload.get("hero")
            photo_id = self._database_photo_id(connection, hero) if isinstance(hero, dict) else None
            if photo_id:
                tagged = connection.execute("SELECT 1 FROM photos WHERE id=? AND event_id=?", (photo_id, event[0])).fetchone()
                if not tagged:
                    raise ValueError("Choose a photo tagged with this event.")
            connection.execute("UPDATE events SET hero_photo_id=? WHERE id=?", (photo_id, event[0]))
            return {"ok": True, "message": f"{'Set' if photo_id else 'Cleared'} hero photo for {event_name}."}

        return self._database_write(operation)

    def _database_set_unit_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        hero = payload.get("hero")
        name = clean_text(payload.get("squadronName"))
        country = clean_text(payload.get("country"))

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            photo_id = self._database_photo_id(connection, hero) if isinstance(hero, dict) else None
            if photo_id:
                subject = connection.execute(
                    "SELECT unit_id FROM photo_subjects WHERE photo_id=? AND unit_id IS NOT NULL ORDER BY is_primary DESC,position LIMIT 1",
                    (photo_id,),
                ).fetchone()
                if not subject:
                    raise ValueError("Choose a unit-tagged photo.")
                unit_id = str(subject[0])
                unit_name = connection.execute("SELECT name FROM units WHERE id=?", (unit_id,)).fetchone()[0]
            else:
                country_id = self._database_country_id(connection, country)
                unit = connection.execute("SELECT id,name FROM units WHERE country_id=? AND lower(name)=lower(?)", (country_id, name)).fetchone()
                if not unit:
                    raise ValueError("Unit not found.")
                unit_id, unit_name = str(unit[0]), str(unit[1])
            connection.execute("UPDATE units SET hero_photo_id=? WHERE id=?", (photo_id, unit_id))
            return {"ok": True, "message": f"{'Set' if photo_id else 'Cleared'} hero photo for {unit_name}."}

        return self._database_write(operation)

    def _database_set_aircraft_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        aircraft_id = clean_text(payload.get("aircraftId"))
        photo_id = clean_text(payload.get("photoId")) or None
        if not aircraft_id:
            raise ValueError("Aircraft type is required.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            aircraft = connection.execute("SELECT name FROM aircraft WHERE id=?", (aircraft_id,)).fetchone()
            if not aircraft:
                raise ValueError("Aircraft type not found.")
            if photo_id:
                tagged = connection.execute(
                    "SELECT 1 FROM photo_subjects WHERE photo_id=? AND aircraft_id=? LIMIT 1",
                    (photo_id, aircraft_id),
                ).fetchone()
                if not tagged:
                    raise ValueError("Choose a photo tagged with this aircraft type.")
            connection.execute("UPDATE aircraft SET hero_photo_id=? WHERE id=?", (photo_id, aircraft_id))
            return {
                "ok": True,
                "message": f"{'Set' if photo_id else 'Cleared'} hero photo for {aircraft[0]}.",
            }

        return self._database_write(operation)

    def _database_delete_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            photo_id = self._database_photo_id(connection, payload)
            source = connection.execute("SELECT source_path FROM photos WHERE id=?", (photo_id,)).fetchone()
            self._database_clear_photo_hero_references(connection, photo_id)
            connection.execute("DELETE FROM photos WHERE id=?", (photo_id,))
            return {"ok": True, "message": "Photo removed.", "removed": {"id": photo_id, "path": source[0] if source else ""}}
        return self._database_write(operation)

    def _database_update_aircraft_settings(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        aircraft_id = clean_text(payload.get("aircraftId"))
        if not aircraft_id:
            raise ValueError("Aircraft type is required.")
        if "doubleWidth" not in payload:
            raise ValueError("Choose an aircraft card width.")
        double_width = normalize_optional_boolean(payload.get("doubleWidth"))

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            aircraft = connection.execute("SELECT name FROM aircraft WHERE id=?", (aircraft_id,)).fetchone()
            if not aircraft:
                raise ValueError("Aircraft type not found.")
            connection.execute(
                "UPDATE aircraft SET double_width=? WHERE id=?",
                (None if double_width is None else int(double_width), aircraft_id),
            )
            label = "Automatic" if double_width is None else "Double width" if double_width else "Standard width"
            return {"ok": True, "message": f"{aircraft[0]} set to {label.lower()}."}

        return self._database_write(operation)

    def _database_update_write_up(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        entity_type = clean_text(payload.get("entityType"))
        entity_id = clean_text(payload.get("entityId"))
        write_up = str(payload.get("writeUp") or "").strip()
        tables = {"aircraft": "aircraft", "squadron": "units", "airshow": "events"}
        table = tables.get(entity_type)
        if not table or not entity_id:
            raise ValueError("Choose an aircraft, squadron, or airshow page.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            entity = connection.execute(f'SELECT name FROM "{table}" WHERE id=?', (entity_id,)).fetchone()
            if not entity:
                raise ValueError("The selected page no longer exists.")
            connection.execute(f'UPDATE "{table}" SET write_up=? WHERE id=?', (write_up, entity_id))
            return {"ok": True, "message": f"Write-up saved for {entity[0]}."}

        return self._database_write(operation)

    def _database_update_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        entry_path = clean_text(payload.get("entryPath"))
        parts = self._database_entry_parts(entry_path)

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            if parts[1] == "aircraft":
                aircraft_id, unit_id = parts[2], parts[3]
                name = clean_text(payload.get("aircraftType"))
                family = normalize_aircraft_family(payload.get("aircraftFamily"))
                if name:
                    connection.execute("UPDATE aircraft SET name=? WHERE id=?", (name, aircraft_id))
                if family:
                    connection.execute("UPDATE aircraft SET family=? WHERE id=?", (family, aircraft_id))
                if "aircraftDoubleWidth" in payload:
                    double_width = normalize_optional_boolean(payload.get("aircraftDoubleWidth"))
                    connection.execute(
                        "UPDATE aircraft SET double_width=? WHERE id=?",
                        (None if double_width is None else int(double_width), aircraft_id),
                    )
            elif parts[1] == "unit":
                unit_id = parts[2]
            else:
                raise ValueError("Only aircraft and unit entries can be edited here.")
            unit_name = clean_text(payload.get("squadronName"))
            country = clean_text(payload.get("country"))
            kind = clean_text(payload.get("unitType")) or "squadron"
            country_id = self._database_country_id(connection, country) if country else None
            connection.execute(
                "UPDATE units SET name=COALESCE(NULLIF(?,''),name),kind=?,country_id=COALESCE(?,country_id) WHERE id=?",
                (unit_name, kind, country_id, unit_id),
            )
            if parts[1] == "unit" and "squadronLogo" in payload:
                connection.execute(
                    "UPDATE units SET logo_source=? WHERE id=?",
                    (clean_text(payload.get("squadronLogo")), unit_id),
                )
            return {"ok": True, "message": "Entry metadata updated."}

        return self._database_write(operation)

    def _database_update_unit_logo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        unit_id = clean_text(payload.get("unitId"))
        logo_source = clean_text(payload.get("logoSource"))

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            unit = connection.execute("SELECT name FROM units WHERE id=?", (unit_id,)).fetchone()
            if not unit:
                raise ValueError("Squadron not found.")
            connection.execute("UPDATE units SET logo_source=? WHERE id=?", (logo_source, unit_id))
            action = "cleared" if not logo_source else "updated"
            return {"ok": True, "message": f"{unit[0]} logo {action}."}

        return self._database_write(operation)

    def _database_delete_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        source_path = clean_text(payload.get("entryPath"))
        mode = clean_text(payload.get("mode"))
        destination_path = clean_text(payload.get("destinationEntryPath"))
        if mode not in {"transfer", "untag"}:
            raise ValueError("Choose whether to transfer or untag affected photos.")
        source = self._database_entry_parts(source_path)
        if source[1] not in {"aircraft", "unit"}:
            raise ValueError("Only aircraft and unit sources can be deleted here.")
        destination = self._database_entry_parts(destination_path) if mode == "transfer" else None
        if destination and destination[1] not in {"aircraft", "unit"}:
            raise ValueError("Choose an aircraft or unit destination.")
        if destination_path == source_path:
            raise ValueError("Choose a different destination entry.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            if source[1] == "aircraft":
                source_aircraft_id, source_unit_id = source[2], source[3]
                exists = connection.execute(
                    "SELECT 1 FROM aircraft_units WHERE aircraft_id=? AND unit_id=?",
                    (source_aircraft_id, source_unit_id),
                ).fetchone()
                if not exists:
                    raise ValueError("Source entry not found.")
                affected_rows = connection.execute(
                    "SELECT DISTINCT photo_id FROM photo_subjects WHERE aircraft_id=? AND unit_id=?",
                    (source_aircraft_id, source_unit_id),
                ).fetchall()
                source_label = connection.execute(
                    "SELECT a.name || ' / ' || u.name FROM aircraft a JOIN units u ON u.id=? WHERE a.id=?",
                    (source_unit_id, source_aircraft_id),
                ).fetchone()[0]
            else:
                source_aircraft_id, source_unit_id = None, source[2]
                unit = connection.execute("SELECT name FROM units WHERE id=?", (source_unit_id,)).fetchone()
                if not unit:
                    raise ValueError("Source unit not found.")
                affected_rows = connection.execute(
                    "SELECT DISTINCT photo_id FROM photo_subjects WHERE unit_id=?",
                    (source_unit_id,),
                ).fetchall()
                source_label = unit[0]

            dest_aircraft_id: Optional[str] = None
            dest_unit_id: Optional[str] = None
            if destination:
                if destination[1] == "aircraft":
                    dest_aircraft_id, dest_unit_id = destination[2], destination[3]
                    if not connection.execute(
                        "SELECT 1 FROM aircraft_units WHERE aircraft_id=? AND unit_id=?",
                        (dest_aircraft_id, dest_unit_id),
                    ).fetchone():
                        raise ValueError("Destination entry not found.")
                else:
                    dest_unit_id = destination[2]
                    if not connection.execute("SELECT 1 FROM units WHERE id=?", (dest_unit_id,)).fetchone():
                        raise ValueError("Destination unit not found.")
                if source[1] == "unit" and dest_unit_id == source_unit_id:
                    raise ValueError("Choose a destination outside the unit being deleted.")

            affected_photo_ids = [str(row[0]) for row in affected_rows]
            for photo_id in affected_photo_ids:
                subjects = [dict(row) for row in connection.execute(
                    "SELECT position,aircraft_id,unit_id,is_primary FROM photo_subjects WHERE photo_id=? ORDER BY position",
                    (photo_id,),
                )]
                removed_primary = False
                survivors: List[Dict[str, Any]] = []
                for subject in subjects:
                    matches = (
                        subject.get("unit_id") == source_unit_id
                        and (source[1] == "unit" or subject.get("aircraft_id") == source_aircraft_id)
                    )
                    if matches:
                        removed_primary = removed_primary or bool(subject.get("is_primary"))
                    else:
                        survivors.append(subject)
                if mode == "transfer":
                    destination_index = next((index for index, item in enumerate(survivors) if item.get("aircraft_id") == dest_aircraft_id and item.get("unit_id") == dest_unit_id), None)
                    if destination_index is None:
                        survivors.append({"aircraft_id": dest_aircraft_id, "unit_id": dest_unit_id, "is_primary": 0})
                        destination_index = len(survivors) - 1
                    if removed_primary:
                        for item in survivors:
                            item["is_primary"] = 0
                        survivors[destination_index]["is_primary"] = 1
                if survivors and not any(item.get("is_primary") for item in survivors):
                    survivors[0]["is_primary"] = 1
                connection.execute("DELETE FROM photo_subjects WHERE photo_id=?", (photo_id,))
                for position, subject in enumerate(survivors):
                    connection.execute(
                        "INSERT INTO photo_subjects(photo_id,position,aircraft_id,unit_id,is_primary) VALUES(?,?,?,?,?)",
                        (photo_id, position, subject.get("aircraft_id"), subject.get("unit_id"), int(bool(subject.get("is_primary")))),
                    )

            if source[1] == "aircraft":
                connection.execute(
                    "DELETE FROM aircraft_units WHERE aircraft_id=? AND unit_id=?",
                    (source_aircraft_id, source_unit_id),
                )
            else:
                connection.execute("DELETE FROM units WHERE id=?", (source_unit_id,))
            connection.execute(
                "DELETE FROM aircraft WHERE NOT EXISTS(SELECT 1 FROM aircraft_units au WHERE au.aircraft_id=aircraft.id) "
                "AND NOT EXISTS(SELECT 1 FROM photo_subjects ps WHERE ps.aircraft_id=aircraft.id)"
            )
            action = "transferred" if mode == "transfer" else "untagged"
            return {"ok": True, "message": f"Deleted {source_label}; {action} {len(affected_photo_ids)} photo(s).", "affectedPhotos": len(affected_photo_ids)}

        return self._database_write(operation)

    def _database_create_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        scope = clean_text(payload.get("scope")) or "aircraft"
        aircraft_name = clean_text(payload.get("aircraftType"))
        family = normalize_aircraft_family(payload.get("aircraftFamily"))
        unit_name = clean_text(payload.get("squadronName"))
        country_name = clean_text(payload.get("country"))
        kind = clean_text(payload.get("unitType")) or "squadron"
        logo = clean_text(payload.get("squadronLogo"))
        aircraft_double_width = (
            normalize_optional_boolean(payload.get("aircraftDoubleWidth"))
            if "aircraftDoubleWidth" in payload
            else None
        )
        if not unit_name or not country_name or (scope == "aircraft" and (not aircraft_name or not family)):
            raise ValueError("Complete the required aircraft/unit fields.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            country_id = self._database_country_id(connection, country_name)
            unit = connection.execute(
                "SELECT id FROM units WHERE country_id=? AND lower(name)=lower(?) AND kind=?",
                (country_id, unit_name, kind),
            ).fetchone()
            if unit:
                unit_id = str(unit[0])
            else:
                unit_id = self._unique_database_id(connection, "units", f"{country_id}-{unit_name}")
                connection.execute(
                    "INSERT INTO units(id,name,country_id,kind,logo_source) VALUES(?,?,?,?,?)",
                    (unit_id, unit_name, country_id, kind, logo),
                )
            if scope == "aircraft":
                aircraft = connection.execute("SELECT id FROM aircraft WHERE lower(name)=lower(?)", (aircraft_name,)).fetchone()
                if aircraft:
                    aircraft_id = str(aircraft[0])
                    if "aircraftDoubleWidth" in payload:
                        connection.execute(
                            "UPDATE aircraft SET double_width=? WHERE id=?",
                            (None if aircraft_double_width is None else int(aircraft_double_width), aircraft_id),
                        )
                else:
                    aircraft_id = self._unique_database_id(connection, "aircraft", aircraft_name)
                    connection.execute(
                        "INSERT INTO aircraft(id,name,family,double_width) VALUES(?,?,?,?)",
                        (aircraft_id, aircraft_name, family, None if aircraft_double_width is None else int(aircraft_double_width)),
                    )
                connection.execute("INSERT OR IGNORE INTO aircraft_units(aircraft_id,unit_id) VALUES(?,?)", (aircraft_id, unit_id))
                entry_path = f"db:aircraft:{aircraft_id}:{unit_id}"
            else:
                entry_path = f"db:unit:{unit_id}"
            return {"ok": True, "message": "Entry created.", "entryPath": entry_path, "scope": scope}

        return self._database_write(operation)

    def _database_create_pin(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        country = clean_text(payload.get("country"))
        name = clean_text(payload.get("name"))
        lat = parse_float(payload.get("lat"), "Latitude")
        lon = parse_float(payload.get("lon"), "Longitude")
        if not country or not name or not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ValueError("Valid country, location name, latitude, and longitude are required.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            country_id = self._database_country_id(connection, country)
            requested = clean_text(payload.get("id")) or name
            location_id = self._unique_database_id(connection, "locations", f"{country_id}-{requested}")
            connection.execute(
                "INSERT INTO locations(id,name,country_id,icao,latitude,longitude,enabled) VALUES(?,?,?,?,?,?,?)",
                (location_id, name, country_id, clean_text(payload.get("icao")).upper(), lat, lon, 1),
            )
            return {"ok": True, "message": "Pin created.", "pinId": location_id, "pinPath": f"db:location:{location_id}"}

        return self._database_write(operation)

    def _database_create_event(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        name = clean_text(payload.get("name"))
        location_id = clean_text(payload.get("locationId"))
        starts_on = normalize_date_value(payload.get("startsOn"))
        ends_on = normalize_date_value(payload.get("endsOn")) or starts_on
        if not name or not location_id:
            raise ValueError("Event name and location are required.")
        if starts_on and ends_on and starts_on > ends_on:
            raise ValueError("Event end date cannot be before its start date.")

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            location = connection.execute("SELECT country_id FROM locations WHERE id=?", (location_id,)).fetchone()
            if not location:
                raise ValueError("Event location not found.")
            if connection.execute("SELECT 1 FROM events WHERE lower(name)=lower(?)", (name,)).fetchone():
                raise ValueError("An event with this name already exists.")
            event_id = self._unique_database_id(connection, "events", f"{location[0]}-{name}")
            connection.execute(
                "INSERT INTO events(id,name,starts_on,ends_on) VALUES(?,?,?,?)",
                (event_id, name, starts_on or None, ends_on or None),
            )
            connection.execute(
                "INSERT INTO event_locations(event_id,location_id) VALUES(?,?)",
                (event_id, location_id),
            )
            return {"ok": True, "message": "Event created.", "eventId": event_id, "name": name}

        return self._database_write(operation)

    def _database_set_pin_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        pin_id = clean_text(payload.get("pinId"))
        clear = payload.get("clear") is True
        asset_rel = clean_text(payload.get("assetPath"))

        def operation(connection: sqlite3.Connection) -> Dict[str, Any]:
            if not connection.execute("SELECT 1 FROM locations WHERE id=?", (pin_id,)).fetchone():
                raise ValueError("Location not found.")
            photo_id = None
            if not clear:
                row = connection.execute("SELECT id FROM photos WHERE source_path=?", (asset_rel,)).fetchone()
                if not row:
                    raise ValueError("Location heroes must use an image already stored in the photo catalog.")
                photo_id = str(row[0])
            connection.execute("UPDATE locations SET hero_photo_id=? WHERE id=?", (photo_id, pin_id))
            return {"ok": True, "message": "Location hero cleared." if clear else "Location hero updated."}

        return self._database_write(operation)

    def _database_generate_caption(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._database_connection(read_only=True)
        try:
            entry_path = clean_text(payload.get("entryPath"))
            aircraft_id, unit_id, location_target = self._database_target_subject(entry_path)
            aircraft_name = connection.execute("SELECT name FROM aircraft WHERE id=?", (aircraft_id,)).fetchone()[0] if aircraft_id else ""
            unit_name = ""
            unit_type = ""
            country = ""
            if unit_id:
                unit = connection.execute(
                    "SELECT u.name,u.kind,c.name AS country FROM units u "
                    "JOIN countries c ON c.id=u.country_id WHERE u.id=?",
                    (unit_id,),
                ).fetchone()
                if unit:
                    unit_name = str(unit["name"])
                    unit_type = "organisation" if unit["kind"] == "organisation" else "squadron"
                    country = str(unit["country"])
            if location_target:
                location_row = connection.execute(
                    "SELECT l.name,c.name AS country FROM locations l "
                    "JOIN countries c ON c.id=l.country_id WHERE l.id=?",
                    (location_target,),
                ).fetchone()
                if location_row:
                    country = country or str(location_row["country"])
            asset = clean_text(payload.get("assetPath"))
            location = clean_text(payload.get("locationName"))
            airshow = clean_text(payload.get("airshow"))
            livery = clean_text(payload.get("livery"))
            if asset:
                source_path = self._raw_asset_path(asset)
            else:
                photo_id = self._database_photo_id(connection, payload)
                photo = connection.execute(
                    "SELECT p.source_path,p.livery,l.name AS location,c.name AS country,e.name AS event FROM photos p "
                    "JOIN locations l ON l.id=p.location_id "
                    "JOIN countries c ON c.id=l.country_id "
                    "LEFT JOIN events e ON e.id=p.event_id WHERE p.id=?",
                    (photo_id,),
                ).fetchone()
                source_path = self.raw_assets_dir / photo["source_path"]
                location = location or photo["location"]
                country = country or photo["country"]
                airshow = airshow or (photo["event"] or "")
                livery = livery or (photo["livery"] or "")
        finally:
            connection.close()
        if not source_path.is_file() or source_path.suffix.lower() not in IMAGE_EXTENSIONS:
            raise CaptionAssistError("The selected photo source is unavailable.")
        draft = clean_text(payload.get("draftCaption"))
        caption = request_nvidia_caption(
            prompt=build_caption_prompt(
                country=country,
                aircraft_type=aircraft_name,
                squadron_name=unit_name,
                unit_type=unit_type,
                location=location,
                airshow=airshow,
                livery=livery,
                draft_caption=draft,
            ),
            image_url=caption_image_data_url(source_path),
        )
        return {"ok": True, "caption": caption, "message": "Caption suggestion ready. Review it, then save the photo."}

    def _photo_target(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        scope = clean_text(payload.get("scope")) or "aircraft"
        if scope not in {"aircraft", "squadron", "location"}:
            raise ValueError("Photo scope is invalid.")

        yaml_path = self._project_path(payload.get("entryPath") or "")
        if not yaml_path or not yaml_path.exists():
            raise ValueError("Choose a valid photo source.")
        if scope == "location":
            if not self._is_within(yaml_path, self.map_dir):
                raise ValueError("Location source path is outside map_pins.")
            pin_id = clean_text(payload.get("targetPinId"))
            if not pin_id:
                raise ValueError("Location photo source is missing its pin id.")
            data = read_yaml(yaml_path)
            pins = data.get("pins") or data.get("locations")
            if not isinstance(pins, list):
                raise ValueError(f"pins must be a list in {relative_posix(yaml_path, self.root)}")
            pin = next((item for item in pins if isinstance(item, dict) and clean_text(item.get("id")) == pin_id), None)
            if pin is None:
                raise ValueError("Location pin was not found in its YAML file.")
            photos = pin.get("photos")
            if photos is None:
                photos = []
                pin["photos"] = photos
            if not isinstance(photos, list):
                raise ValueError(f"photos must be a list for map pin {pin_id} in {relative_posix(yaml_path, self.root)}")
            return {
                "scope": scope,
                "yamlPath": yaml_path,
                "data": data,
                "photos": photos,
                "pinId": pin_id,
                "locationName": clean_text(pin.get("name") or pin.get("full_name")),
            }

        allowed_dir = self.squadron_dir if scope == "squadron" else self.aircraft_dir
        if yaml_path.name not in {"entry.yaml", "entry.yml"} or not self._is_within(yaml_path, allowed_dir):
            raise ValueError(f"{scope.title()} source path is invalid.")
        data = read_yaml(yaml_path)
        photos = data.get("photos")
        if photos is None:
            photos = []
            data["photos"] = photos
        if not isinstance(photos, list):
            raise ValueError(f"photos must be a list in {relative_posix(yaml_path, self.root)}")
        return {
            "scope": scope,
            "yamlPath": yaml_path,
            "data": data,
            "photos": photos,
            "pinId": "",
            "locationName": "",
        }

    def _squadron_photo_target(self, payload: Any) -> Dict[str, Any]:
        """Create or reuse the standalone source for a squadron-only photo tag."""
        if not isinstance(payload, dict):
            raise ValueError("Squadron target is invalid.")

        squadron_name = clean_text(payload.get("squadronName"))
        country = clean_text(payload.get("country"))
        unit_type = clean_text(payload.get("unitType")) or "squadron"
        squadron_logo = clean_text(payload.get("squadronLogo"))
        if not squadron_name or not country:
            raise ValueError("Choose a squadron with a country before tagging a squadron-only photo.")
        if unit_type not in {"squadron", "organisation"}:
            unit_type = "squadron"

        entry_path = self.squadron_dir / slugify(squadron_name) / "entry.yaml"
        if entry_path.exists():
            data = read_yaml(entry_path)
            existing_name = read_squadron_name(data, entry_path)
            existing_country = clean_text(data.get("country"))
            if normalize_key(existing_name) != normalize_key(squadron_name) or normalize_key(existing_country) != normalize_key(country):
                raise ValueError(
                    f"Standalone squadron entry already exists at {relative_posix(entry_path, self.root)} with different metadata."
                )
        else:
            data: Dict[str, Any] = {
                "squadron_name": squadron_name,
                "country": country,
                "photos": [],
            }
            if unit_type == "organisation":
                data["unit_type"] = "organisation"
            if squadron_logo:
                data["squadron_logo"] = squadron_logo
            write_yaml(entry_path, data)

        return self._photo_target(
            {
                "scope": "squadron",
                "entryPath": relative_posix(entry_path, self.root),
            }
        )

    def append_photos(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_append_photos(payload)
        asset_paths = payload.get("assetPaths") or []
        if not isinstance(asset_paths, list) or not asset_paths:
            raise ValueError("Select at least one raw asset.")
        has_supported_asset = any(
            self._raw_asset_path(value).exists()
            and self._raw_asset_path(value).suffix.lower() in IMAGE_EXTENSIONS
            for value in asset_paths
        )
        if not has_supported_asset:
            raise ValueError("Select at least one existing supported raw asset.")

        squadron_target = payload.get("squadronTarget")
        target = self._squadron_photo_target(squadron_target) if squadron_target else self._photo_target(payload)
        yaml_path = target["yamlPath"]
        photos = target["photos"]

        location_name = target["locationName"] if target["scope"] == "location" else clean_text(payload.get("locationName"))
        pin_id = target["pinId"] if target["scope"] == "location" else clean_text(payload.get("pinId"))
        airshow = clean_text(payload.get("airshow"))
        livery = clean_text(payload.get("livery"))
        caption = clean_text(payload.get("caption"))
        caption_ai_assisted = payload.get("captionAiAssisted") is True
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
            yaml_photo_path = photo_yaml_path_for_asset(yaml_path, self.root, asset_rel)
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
            if airshow:
                item["airshow"] = airshow
            if livery:
                item["livery"] = livery
            if caption:
                item["caption"] = caption
            if caption_ai_assisted:
                item["caption_ai_assisted"] = True
            photos.append(item)
            existing.add(yaml_photo_path)
            appended.append(asset_rel)

        write_yaml(yaml_path, target["data"])
        return {
            "ok": True,
            "message": f"Attached {len(appended)} asset(s).",
            "appended": appended,
            "skipped": skipped,
        }

    def update_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_update_photo(payload)
        target = self._photo_target(payload)
        index = int(payload.get("index"))
        photos = target["photos"]
        if not isinstance(photos, list) or index < 0 or index >= len(photos):
            raise ValueError("Photo index is invalid.")
        existing_photo = photos[index] if isinstance(photos[index], dict) else {}

        incoming = payload.get("photo") or {}
        if not isinstance(incoming, dict):
            raise ValueError("Photo payload must be an object.")
        path_value = clean_text(incoming.get("path"))
        if not path_value:
            raise ValueError("Photo path is required.")

        updated: Dict[str, Any] = dict(existing_photo)
        legacy_livery = clean_text(existing_photo.get("paint_scheme") or existing_photo.get("paintScheme"))
        for legacy_key in ("file", "filepath", "location_name", "airshow_name", "paint_scheme", "paintScheme"):
            updated.pop(legacy_key, None)
        if legacy_livery and "livery" not in incoming:
            updated["livery"] = legacy_livery
        updated["path"] = path_value
        for key in ("date", "year", "location", "pin_id", "airshow", "livery", "title", "caption"):
            if key not in incoming:
                continue
            value = clean_text(incoming.get(key))
            if not value:
                updated.pop(key, None)
                continue
            if key == "year" and value.isdigit():
                updated[key] = int(value)
            else:
                updated[key] = value
        if target["scope"] == "location":
            updated["location"] = target["locationName"]
            updated["pin_id"] = target["pinId"]
        if payload_caption_is_ai_assisted(incoming) or photo_caption_is_ai_assisted(existing_photo):
            updated["caption_ai_assisted"] = True

        destination_path = clean_text(payload.get("tagTargetEntryPath"))
        squadron_target = payload.get("tagTargetSquadron")
        if not destination_path and not squadron_target:
            photos[index] = updated
            write_yaml(target["yamlPath"], target["data"])
            return {"ok": True, "message": "Photo updated."}

        if squadron_target:
            destination_scope = "squadron"
            destination = self._squadron_photo_target(squadron_target)
        else:
            # Older manager clients only supplied the destination path, so retain the
            # aircraft default while allowing the editor to move a frame to a
            # standalone squadron record as well.
            destination_scope = clean_text(payload.get("tagTargetScope")) or "aircraft"
            if destination_scope not in {"aircraft", "squadron"}:
                raise ValueError("Tag Images To supports aircraft and squadron entries only.")
            destination = self._photo_target({"scope": destination_scope, "entryPath": destination_path})
        same_target = target["scope"] == destination["scope"] and target["yamlPath"] == destination["yamlPath"]
        if same_target:
            photos[index] = updated
            write_yaml(target["yamlPath"], target["data"])
            return {"ok": True, "message": "Photo updated."}

        source_path = resolve_photo_source(self.root, self.raw_assets_dir, target["yamlPath"], path_value)
        if source_path.exists() and self._is_within(source_path, self.raw_assets_dir):
            asset_rel = relative_posix(source_path, self.raw_assets_dir)
            updated["path"] = photo_yaml_path_for_asset(destination["yamlPath"], self.root, asset_rel)

        destination_paths = {
            clean_text(item.get("path") or item.get("file") or item.get("filepath"))
            for item in destination["photos"]
            if isinstance(item, dict)
        }
        if clean_text(updated.get("path")) in destination_paths:
            raise ValueError("This photo is already tagged to the selected entry.")

        photos.pop(index)
        destination["photos"].append(updated)
        write_yaml(target["yamlPath"], target["data"])
        write_yaml(destination["yamlPath"], destination["data"])
        return {"ok": True, "message": f"Photo updated and moved to the selected {destination_scope} entry."}

    def bulk_update_airshow(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Set or clear an event tag across an explicit set of source photo records."""
        if self.database_path.exists():
            return self._database_bulk_update_airshow(payload)
        photo_refs = payload.get("photos") or []
        if not isinstance(photo_refs, list) or not photo_refs:
            raise ValueError("Choose at least one photo to tag.")

        airshow = clean_text(payload.get("airshow"))
        grouped_refs: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        seen_refs: set[Tuple[str, str, str, int]] = set()

        for ref in photo_refs:
            if not isinstance(ref, dict):
                raise ValueError("Photo references are invalid.")
            scope = clean_text(ref.get("scope")) or "aircraft"
            entry_path = clean_text(ref.get("entryPath"))
            pin_id = clean_text(ref.get("targetPinId"))
            try:
                index = int(ref.get("index"))
            except (TypeError, ValueError) as exc:
                raise ValueError("Photo reference index is invalid.") from exc
            if index < 0:
                raise ValueError("Photo reference index is invalid.")

            ref_key = (scope, entry_path, pin_id, index)
            if ref_key in seen_refs:
                continue
            seen_refs.add(ref_key)
            source_key = (scope, entry_path, pin_id)
            if source_key not in grouped_refs:
                grouped_refs[source_key] = {
                    "scope": scope,
                    "entryPath": entry_path,
                    "targetPinId": pin_id,
                    "indices": [],
                }
            grouped_refs[source_key]["indices"].append(index)

        updated = 0
        unchanged = 0
        for source in grouped_refs.values():
            target = self._photo_target(source)
            photos = target["photos"]
            changed_source = False
            for index in source["indices"]:
                if index >= len(photos) or not isinstance(photos[index], dict):
                    raise ValueError("A selected photo no longer exists in its source YAML.")
                photo = photos[index]
                current = clean_text(photo.get("airshow") or photo.get("airshow_name"))
                if airshow:
                    needs_update = current != airshow or "airshow_name" in photo
                    if needs_update:
                        photo["airshow"] = airshow
                        photo.pop("airshow_name", None)
                else:
                    needs_update = "airshow" in photo or "airshow_name" in photo
                    if needs_update:
                        photo.pop("airshow", None)
                        photo.pop("airshow_name", None)

                if needs_update:
                    updated += 1
                    changed_source = True
                else:
                    unchanged += 1
            if changed_source:
                write_yaml(target["yamlPath"], target["data"])

        action = f"Set event '{airshow}'" if airshow else "Cleared event"
        detail = f" {unchanged} already matched." if unchanged else ""
        return {"ok": True, "updated": updated, "unchanged": unchanged, "message": f"{action} on {updated} photo(s).{detail}"}

    def _load_airshow_events(self) -> List[Dict[str, Any]]:
        if self.database_path.exists():
            state = self._get_database_state()
            return state["airshowEvents"]
        if not self.airshow_events_path.exists():
            return []
        data = read_yaml(self.airshow_events_path)
        event_items = data.get("events") or data.get("airshows") or []
        if isinstance(event_items, dict):
            event_items = [event_items]
        if not isinstance(event_items, list):
            return []

        events: List[Dict[str, Any]] = []
        for item in event_items:
            if not isinstance(item, dict):
                continue
            name = clean_text(item.get("name") or item.get("event") or item.get("airshow"))
            if not name:
                continue
            hero = normalize_airshow_hero_ref(item.get("hero_photo") or item.get("heroPhoto") or item.get("hero"))
            events.append({"name": name, "hero": hero})
        return events

    def set_airshow_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_set_airshow_hero(payload)
        event_name = clean_text(payload.get("eventName"))
        if not event_name:
            raise ValueError("An event name is required.")

        data = read_yaml(self.airshow_events_path) if self.airshow_events_path.exists() else {"events": []}
        event_items = data.get("events")
        if event_items is None:
            event_items = data.get("airshows")
        if event_items is None:
            event_items = []
        data["events"] = event_items
        if isinstance(event_items, dict):
            event_items = [event_items]
            data["events"] = event_items
        if not isinstance(event_items, list):
            raise ValueError("airshows/events.yaml must contain an events list.")

        event_key = normalize_key(event_name)
        event = next(
            (
                item
                for item in event_items
                if isinstance(item, dict) and normalize_key(clean_text(item.get("name") or item.get("event") or item.get("airshow"))) == event_key
            ),
            None,
        )
        hero_payload = payload.get("hero")
        if hero_payload is None:
            if event is None:
                return {"ok": True, "message": "This event has no configured hero photo."}
            event.pop("hero_photo", None)
            event.pop("heroPhoto", None)
            event.pop("hero", None)
            self.airshow_dir.mkdir(parents=True, exist_ok=True)
            write_yaml(self.airshow_events_path, data)
            return {"ok": True, "message": f"Cleared hero photo for {event_name}."}

        if not isinstance(hero_payload, dict):
            raise ValueError("Hero photo reference is invalid.")
        try:
            index = int(hero_payload.get("index"))
        except (TypeError, ValueError) as exc:
            raise ValueError("Hero photo index is invalid.") from exc
        if index < 0:
            raise ValueError("Hero photo index is invalid.")

        target_payload = {
            "scope": clean_text(hero_payload.get("scope")) or "aircraft",
            "entryPath": clean_text(hero_payload.get("entryPath")),
            "targetPinId": clean_text(hero_payload.get("targetPinId")),
        }
        target = self._photo_target(target_payload)
        photos = target["photos"]
        if index >= len(photos) or not isinstance(photos[index], dict):
            raise ValueError("The selected hero photo no longer exists in its source YAML.")
        tagged_event = clean_text(photos[index].get("airshow") or photos[index].get("airshow_name"))
        if normalize_key(tagged_event) != event_key:
            raise ValueError("Choose a photo tagged with this event before setting its hero.")

        hero_ref: Dict[str, Any] = {
            "scope": target_payload["scope"],
            "entry_path": target_payload["entryPath"],
            "index": index,
        }
        if target_payload["targetPinId"]:
            hero_ref["target_pin_id"] = target_payload["targetPinId"]
        if event is None:
            event = {"name": event_name}
            event_items.append(event)
        else:
            event["name"] = event_name
        event["hero_photo"] = hero_ref
        event.pop("heroPhoto", None)
        event.pop("hero", None)
        self.airshow_dir.mkdir(parents=True, exist_ok=True)
        write_yaml(self.airshow_events_path, data)
        return {"ok": True, "message": f"Set hero photo for {event_name}."}

    def set_squadron_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Select one tagged squadron image as the aggregate squadron-page hero."""
        if self.database_path.exists():
            return self._database_set_unit_hero(payload)
        hero_payload = payload.get("hero")
        squadron_name = clean_text(payload.get("squadronName"))
        country = clean_text(payload.get("country"))
        selected_path: Optional[Path] = None
        selected_source = ""

        if hero_payload is not None:
            if not isinstance(hero_payload, dict):
                raise ValueError("Squadron hero reference is invalid.")
            try:
                index = int(hero_payload.get("index"))
            except (TypeError, ValueError) as exc:
                raise ValueError("Squadron hero index is invalid.") from exc
            target = self._photo_target(
                {
                    "scope": clean_text(hero_payload.get("scope")) or "aircraft",
                    "entryPath": clean_text(hero_payload.get("entryPath")),
                    "targetPinId": clean_text(hero_payload.get("targetPinId")),
                }
            )
            if target["scope"] not in {"aircraft", "squadron"}:
                raise ValueError("Choose a squadron or aircraft photo for the squadron hero.")
            photos = target["photos"]
            if index < 0 or index >= len(photos) or not isinstance(photos[index], dict):
                raise ValueError("The selected squadron hero photo no longer exists.")
            selected_photo = photos[index]
            selected_source = clean_text(selected_photo.get("path") or selected_photo.get("file") or selected_photo.get("filepath"))
            if not selected_source:
                raise ValueError("The selected squadron hero photo has no path.")
            source_path = resolve_photo_source(self.root, self.raw_assets_dir, target["yamlPath"], selected_source)
            if not source_path.exists():
                raise ValueError("The selected squadron hero source image is missing.")
            selected_path = target["yamlPath"]
            squadron_name = read_squadron_name(target["data"], selected_path)
            country = clean_text(target["data"].get("country"))

        if not squadron_name:
            raise ValueError("Choose a squadron before setting or clearing its hero.")

        entry_paths = sorted(self.aircraft_dir.glob("*/*/entry.y*ml")) + sorted(self.squadron_dir.glob("*/entry.y*ml"))
        updated = 0
        for entry_path in entry_paths:
            data = read_yaml(entry_path)
            if read_squadron_name(data, entry_path) != squadron_name or clean_text(data.get("country")) != country:
                continue
            clear_squadron_hero_fields(data)
            if selected_path and entry_path.resolve() == selected_path.resolve():
                data["squadron_hero"] = selected_source
            write_yaml(entry_path, data)
            updated += 1

        if not updated:
            raise ValueError("No matching squadron source entries were found.")
        if selected_path:
            return {"ok": True, "message": f"Set hero photo for {squadron_name}."}
        return {"ok": True, "message": f"Cleared hero photo for {squadron_name}."}

    def set_aircraft_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("Aircraft hero settings are available for the canonical database only.")
        return self._database_set_aircraft_hero(payload)

    def generate_caption(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Generate a non-persistent caption suggestion from a source image."""
        if self.database_path.exists():
            return self._database_generate_caption(payload)
        squadron_target = payload.get("squadronTarget")
        target: Optional[Dict[str, Any]] = None
        country = clean_text(payload.get("country"))
        unit_type = ""
        if squadron_target:
            if not isinstance(squadron_target, dict):
                raise CaptionAssistError("Squadron target is invalid.")
            aircraft_type = ""
            squadron_name = clean_text(squadron_target.get("squadronName"))
            if not squadron_name:
                raise CaptionAssistError("Choose a squadron before generating a caption.")
            unit_type = clean_text(squadron_target.get("unitType")) or "squadron"
            country = country or clean_text(squadron_target.get("country"))
            location = clean_text(payload.get("locationName"))
        else:
            try:
                target = self._photo_target(payload)
            except ValueError as exc:
                raise CaptionAssistError(str(exc)) from exc
            entry_path = target["yamlPath"]
            entry_data = target["data"]
            aircraft_type = read_aircraft_type(entry_data, entry_path) if target["scope"] == "aircraft" else ""
            squadron_name = read_squadron_name(entry_data, entry_path) if target["scope"] != "location" else ""
            unit_type = clean_text(entry_data.get("unit_type")) or ("squadron" if squadron_name else "")
            country = country or clean_text(entry_data.get("country"))
            location = target["locationName"] if target["scope"] == "location" else clean_text(payload.get("locationName"))
        airshow = clean_text(payload.get("airshow"))
        livery = clean_text(payload.get("livery"))
        source_path: Optional[Path] = None

        asset_value = clean_text(payload.get("assetPath"))
        if asset_value:
            source_path = self._raw_asset_path(asset_value)
        else:
            if target is None:
                raise CaptionAssistError("Choose a source image before generating a caption.")
            try:
                index = int(payload.get("index"))
            except (TypeError, ValueError) as exc:
                raise CaptionAssistError("Choose a photo before generating a caption.") from exc
            photos = target["photos"]
            if not isinstance(photos, list) or index < 0 or index >= len(photos):
                raise CaptionAssistError("The selected photo no longer exists in this entry.")
            photo = photos[index]
            if not isinstance(photo, dict):
                raise CaptionAssistError("The selected photo is not a valid YAML photo record.")
            source_value = photo.get("path") or photo.get("file") or photo.get("filepath") or ""
            source_path = resolve_photo_source(self.root, self.raw_assets_dir, entry_path, source_value)
            location = location or clean_text(photo.get("location") or photo.get("location_name"))
            airshow = airshow or clean_text(photo.get("airshow") or photo.get("airshow_name"))
            livery = livery or clean_text(photo.get("livery") or photo.get("paint_scheme") or photo.get("paintScheme"))

        if (
            source_path is None
            or not source_path.exists()
            or source_path.suffix.lower() not in IMAGE_EXTENSIONS
            or not self._is_within(source_path, self.root)
        ):
            raise CaptionAssistError("The selected photo source is unavailable or is not a supported image.")

        draft_caption = clean_text(payload.get("draftCaption"))
        if len(draft_caption) > 4000:
            raise CaptionAssistError("The existing caption is too long to refine.")

        image_url = caption_image_data_url(source_path)
        prompt = build_caption_prompt(
            country=country,
            aircraft_type=aircraft_type,
            squadron_name=squadron_name,
            unit_type=unit_type,
            location=location,
            airshow=airshow,
            livery=livery,
            draft_caption=draft_caption,
        )
        caption = request_nvidia_caption(prompt=prompt, image_url=image_url)
        return {
            "ok": True,
            "caption": caption,
            "message": "Caption suggestion ready. Review it, then save the photo.",
        }

    def delete_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_delete_photo(payload)
        target = self._photo_target(payload)
        index = int(payload.get("index"))
        photos = target["photos"]
        if not isinstance(photos, list) or index < 0 or index >= len(photos):
            raise ValueError("Photo index is invalid.")

        removed = photos.pop(index)
        write_yaml(target["yamlPath"], target["data"])
        return {
            "ok": True,
            "message": "Photo removed.",
            "removed": removed if isinstance(removed, dict) else str(removed),
        }

    def update_master_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("The master photo view is available for the canonical database only.")
        return self._database_update_master_photo(payload)

    def bulk_update_photos(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("Bulk photo editing is available for the canonical database only.")
        return self._database_bulk_update_photos(payload)

    def delete_master_photo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("The master photo view is available for the canonical database only.")
        return self._database_delete_master_photo(payload)

    def update_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_update_entry(payload)
        entry_path = self._project_path(payload.get("entryPath") or "")
        scope = clean_text(payload.get("scope")) or "aircraft"
        allowed_dir = self.squadron_dir if scope == "squadron" else self.aircraft_dir
        if scope not in {"aircraft", "squadron"} or not entry_path or not entry_path.exists() or not self._is_within(entry_path, allowed_dir):
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
        if scope == "aircraft" and aircraft_type:
            data["aircraft_type"] = aircraft_type
        if scope == "aircraft" and aircraft_family:
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

    def update_unit_logo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("Shared unit logos are available for the canonical database only.")
        return self._database_update_unit_logo(payload)

    def delete_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("Entry deletion is available for the canonical database only.")
        return self._database_delete_entry(payload)

    def update_aircraft_settings(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("Aircraft settings are available for the canonical database only.")
        return self._database_update_aircraft_settings(payload)

    def update_write_up(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("Write-up editing is available for the canonical database only.")
        return self._database_update_write_up(payload)

    def create_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_create_entry(payload)
        scope = clean_text(payload.get("scope")) or "aircraft"
        aircraft_type = clean_text(payload.get("aircraftType"))
        aircraft_family = normalize_aircraft_family(payload.get("aircraftFamily"))
        squadron_name = clean_text(payload.get("squadronName"))
        country = clean_text(payload.get("country"))
        unit_type = clean_text(payload.get("unitType")) or "squadron"
        squadron_logo = clean_text(payload.get("squadronLogo"))
        if scope not in {"aircraft", "squadron"}:
            raise ValueError("Entry scope is invalid.")
        if not squadron_name or not country or (scope == "aircraft" and (not aircraft_type or not aircraft_family)):
            raise ValueError("Aircraft entries require an aircraft type, aircraft family, unit name, and country; squadron entries require a unit name and country.")
        if unit_type not in {"squadron", "organisation"}:
            unit_type = "squadron"

        entry_dir = (
            self.aircraft_dir / slugify(aircraft_type) / slugify(squadron_name)
            if scope == "aircraft"
            else self.squadron_dir / slugify(squadron_name)
        )
        entry_path = entry_dir / "entry.yaml"
        if entry_path.exists():
            raise ValueError(f"Entry already exists: {relative_posix(entry_path, self.root)}")

        entry_dir.mkdir(parents=True, exist_ok=True)
        data: Dict[str, Any] = {"squadron_name": squadron_name, "country": country}
        if scope == "aircraft":
            data["aircraft_type"] = aircraft_type
            data["aircraft_family"] = aircraft_family
        if unit_type == "organisation":
            data["unit_type"] = "organisation"
        if squadron_logo:
            data["squadron_logo"] = squadron_logo
        data["photos"] = []
        write_yaml(entry_path, data)
        return {
            "ok": True,
            "message": "Entry created.",
            "entryPath": relative_posix(entry_path, self.root),
            "scope": scope,
        }

    def create_pin(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_create_pin(payload)
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

    def create_event(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.database_path.exists():
            raise ValueError("Inline event creation is available for the canonical database only.")
        return self._database_create_event(payload)

    def set_pin_hero(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.database_path.exists():
            return self._database_set_pin_hero(payload)
        pin_path = self._project_path(payload.get("pinPath") or "")
        pin_id = clean_text(payload.get("pinId"))
        if not pin_path or not pin_path.exists() or not self._is_within(pin_path, self.map_dir):
            raise ValueError("Choose a map pin first.")
        if not pin_id:
            raise ValueError("Pin id is required.")

        clear_hero = payload.get("clear") is True
        asset_path: Optional[Path] = None
        if not clear_hero:
            asset_path = self._raw_asset_path(payload.get("assetPath") or "")
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

        if clear_hero:
            for key in ("hero_photo", "hero_image", "hero_path", "heroPhoto", "heroImage", "heroPath", "hero"):
                target.pop(key, None)
        else:
            assert asset_path is not None
            asset_rel = relative_posix(asset_path, self.raw_assets_dir)
            target["hero_photo"] = pin_hero_yaml_path_for_asset(pin_path, self.root, asset_rel)
        write_yaml(pin_path, data)
        return {"ok": True, "message": "Location hero cleared." if clear_hero else "Location hero updated."}

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

    def make_full_asset(self, asset_rel: str) -> Tuple[bytes, str]:
        """Return the selected raw asset at its original resolution for preview."""
        asset_path = self._raw_asset_path(asset_rel)
        if not asset_path.is_file() or asset_path.suffix.lower() not in IMAGE_EXTENSIONS:
            raise FileNotFoundError(asset_rel)
        content_type = mimetypes.guess_type(asset_path.name)[0] or "application/octet-stream"
        return asset_path.read_bytes(), content_type

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
                    "photos": [],
                }
                photo_items = item.get("photos") or []
                if isinstance(photo_items, dict):
                    photo_items = [photo_items]
                if isinstance(photo_items, list):
                    for photo_index, photo_item in enumerate(photo_items):
                        if not isinstance(photo_item, dict):
                            pin["photos"].append({"index": photo_index, "invalid": True, "raw": str(photo_item)})
                            continue
                        source_value = photo_item.get("path") or photo_item.get("file") or photo_item.get("filepath") or ""
                        source_path = resolve_photo_source(self.root, self.raw_assets_dir, yaml_path, source_value)
                        source_exists = source_path.exists()
                        source_rel = ""
                        exif_date = read_image_capture_date(source_path, self._exif_date_cache) if source_exists else ""
                        source_width, source_height = (
                            read_image_dimensions(source_path, self._image_dimension_cache) if source_exists else (0, 0)
                        )
                        if source_exists and self._is_within(source_path, self.raw_assets_dir):
                            source_rel = relative_posix(source_path, self.raw_assets_dir)
                            tag_map.setdefault(source_rel, []).append(
                                {
                                    "kind": "location photo",
                                    "label": name,
                                    "location": name,
                                    "path": relative_posix(yaml_path, self.root),
                                    "index": photo_index,
                                }
                            )
                        missing_fields = missing_photo_fields(
                            photo_item=photo_item,
                            source_exists=source_exists,
                            location=name,
                            exif_date=exif_date,
                        )
                        pin["photos"].append(
                            {
                                "index": photo_index,
                                "path": clean_text(source_value),
                                "sourceAssetPath": source_rel,
                                "exists": source_exists,
                                "sourceWidth": source_width,
                                "sourceHeight": source_height,
                                "sourceUnderMinimumWidth": bool(source_width and source_width < MIN_SOURCE_PHOTO_WIDTH),
                                "location": name,
                                "pinId": pin_id,
                                "date": clean_text(photo_item.get("date")),
                                "year": clean_text(photo_item.get("year")),
                                "exifDate": exif_date,
                                "airshow": clean_text(photo_item.get("airshow") or photo_item.get("airshow_name")),
                                "livery": clean_text(photo_item.get("livery") or photo_item.get("paint_scheme") or photo_item.get("paintScheme")),
                                "title": clean_text(photo_item.get("title")),
                                "caption": clean_text(photo_item.get("caption")),
                                "captionAiAssisted": photo_caption_is_ai_assisted(photo_item),
                                "missingFields": missing_fields,
                                "missingFieldLabels": [MISSING_FIELD_LABELS[field] for field in missing_fields],
                            }
                        )
                        pin["photoCount"] += 1
                pins.append(pin)
                pin_by_id.setdefault(pin_id, pin)
                if name:
                    pin_by_name.setdefault(normalize_key(name), pin)

        pins.sort(key=lambda item: (item["country"], item["name"]))
        return pins, pin_by_id, pin_by_name

    def _location_entries(self, pins: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                "targetKey": f"location::{pin['key']}",
                "sourceScope": "location",
                "entryPath": pin["pinPath"],
                "pinId": pin["id"],
                "entryDir": relative_posix(Path(pin["pinPath"]).parent, self.root),
                "aircraftType": "",
                "squadronName": "",
                "country": pin["country"],
                "unitType": "",
                "unitLabel": "Location",
                "aircraftFamily": "",
                "squadronLogo": "",
                "squadronLogoExists": False,
                "entryMissingFields": [],
                "photoCount": len(pin.get("photos", [])),
                "missingPhotoCount": sum(1 for photo in pin.get("photos", []) if photo.get("exists") is False),
                "missingFieldPhotoCount": sum(1 for photo in pin.get("photos", []) if photo.get("missingFields")),
                "photos": pin.get("photos", []),
                "locationName": pin["name"],
            }
            for pin in pins
        ]

    def _squadron_groups(self, entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Aggregate aircraft and standalone records into manager hero-picker groups."""
        groups: Dict[str, Dict[str, Any]] = {}
        for entry in entries:
            if entry.get("sourceScope") == "location" or entry.get("unitType") != "squadron":
                continue
            name = clean_text(entry.get("squadronName"))
            country = clean_text(entry.get("country"))
            if not name:
                continue
            key = normalize_key(f"{country}-{name}")
            group = groups.setdefault(
                key,
                {
                    "key": key,
                    "name": name,
                    "country": country,
                    "unitId": clean_text(entry.get("unitId")),
                    "unitTargetKey": f"db:unit:{clean_text(entry.get('unitId'))}" if entry.get("unitId") else "",
                    "logo": clean_text(entry.get("squadronLogo")),
                    "logoExists": bool(entry.get("squadronLogoExists")),
                    "writeUp": clean_text(entry.get("writeUp")),
                    "photoCount": 0,
                    "photos": [],
                    "hero": {},
                },
            )
            if entry.get("unitId"):
                group["unitId"] = clean_text(entry.get("unitId"))
                group["unitTargetKey"] = f"db:unit:{group['unitId']}"
            if entry.get("sourceScope") == "squadron" or not group.get("logo"):
                group["logo"] = clean_text(entry.get("squadronLogo"))
                group["logoExists"] = bool(entry.get("squadronLogoExists"))
            if entry.get("writeUp"):
                group["writeUp"] = clean_text(entry.get("writeUp"))
            hero_asset_path = clean_text(entry.get("squadronHeroAssetPath"))
            if hero_asset_path:
                group["hero"] = {
                    "entryTargetKey": entry["targetKey"],
                    "assetPath": hero_asset_path,
                    "sourcePath": clean_text(entry.get("squadronHero")),
                }
            for photo in entry.get("photos", []):
                if not isinstance(photo, dict) or photo.get("invalid"):
                    continue
                group["photos"].append(
                    {
                        "entryTargetKey": entry["targetKey"],
                        "index": photo.get("index"),
                    }
                )
                group["photoCount"] += 1

        return sorted(groups.values(), key=lambda item: (item["country"], item["name"]))

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
            hero_value = read_squadron_hero_source(data)
            hero_path = resolve_entry_asset_source(self.root, self.raw_assets_dir, entry_path, hero_value) if hero_value else None
            hero_asset_path = (
                relative_posix(hero_path, self.raw_assets_dir)
                if hero_path and hero_path.exists() and self._is_within(hero_path, self.raw_assets_dir)
                else ""
            )
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
                source_width, source_height = (
                    read_image_dimensions(source_path, self._image_dimension_cache) if source_exists else (0, 0)
                )
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
                        "sourceWidth": source_width,
                        "sourceHeight": source_height,
                        "sourceUnderMinimumWidth": bool(source_width and source_width < MIN_SOURCE_PHOTO_WIDTH),
                        "location": location,
                        "pinId": pin_id,
                        "date": clean_text(item.get("date")),
                        "year": clean_text(item.get("year")),
                        "exifDate": exif_date,
                        "airshow": clean_text(item.get("airshow") or item.get("airshow_name")),
                        "livery": clean_text(item.get("livery") or item.get("paint_scheme") or item.get("paintScheme")),
                        "title": clean_text(item.get("title")),
                        "caption": clean_text(item.get("caption")),
                        "captionAiAssisted": photo_caption_is_ai_assisted(item),
                        "missingFields": missing_fields,
                        "missingFieldLabels": [MISSING_FIELD_LABELS[field] for field in missing_fields],
                    }
                )

            for kind, source_value in (
                ("logo", logo_value),
                ("squadron hero", hero_value),
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
                    "targetKey": relative_posix(entry_path, self.root),
                    "sourceScope": "aircraft",
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
                    "squadronHero": clean_text(hero_value),
                    "squadronHeroAssetPath": hero_asset_path,
                    "entryMissingFields": missing_entry_fields(data, logo_exists=logo_exists),
                    "photoCount": len(photo_records),
                    "missingPhotoCount": sum(1 for photo in photo_records if photo.get("exists") is False),
                    "missingFieldPhotoCount": sum(1 for photo in photo_records if photo.get("missingFields")),
                    "photos": photo_records,
                }
            )

        entries.sort(key=lambda item: (item["aircraftType"], item["country"], item["squadronName"]))
        return entries

    def _scan_squadrons(
        self,
        tag_map: Dict[str, List[Dict[str, Any]]],
        pin_by_id: Dict[str, Dict[str, Any]],
        pin_by_name: Dict[str, Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        if not self.squadron_dir.exists():
            return entries

        for entry_path in sorted(self.squadron_dir.glob("*/entry.y*ml")):
            data = read_yaml(entry_path)
            squadron_name = read_squadron_name(data, entry_path)
            country = clean_text(data.get("country"))
            unit_type = read_unit_type(data)
            logo_value = read_squadron_logo_value(data)
            logo_path = resolve_entry_asset_source(self.root, self.raw_assets_dir, entry_path, logo_value) if logo_value else None
            logo_exists = bool(logo_path and logo_path.exists())
            hero_value = read_squadron_hero_source(data)
            hero_path = resolve_entry_asset_source(self.root, self.raw_assets_dir, entry_path, hero_value) if hero_value else None
            hero_asset_path = (
                relative_posix(hero_path, self.raw_assets_dir)
                if hero_path and hero_path.exists() and self._is_within(hero_path, self.raw_assets_dir)
                else ""
            )
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
                source_width, source_height = (
                    read_image_dimensions(source_path, self._image_dimension_cache) if source_exists else (0, 0)
                )
                if source_exists and self._is_within(source_path, self.raw_assets_dir):
                    source_rel = relative_posix(source_path, self.raw_assets_dir)
                    tag_map.setdefault(source_rel, []).append(
                        {
                            "kind": "squadron photo",
                            "label": squadron_name,
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
                missing_fields = missing_photo_fields(item, source_exists, location, exif_date)
                photo_records.append(
                    {
                        "index": index,
                        "path": clean_text(source_value),
                        "sourceAssetPath": source_rel,
                        "exists": source_exists,
                        "sourceWidth": source_width,
                        "sourceHeight": source_height,
                        "sourceUnderMinimumWidth": bool(source_width and source_width < MIN_SOURCE_PHOTO_WIDTH),
                        "location": location,
                        "pinId": pin_id,
                        "date": clean_text(item.get("date")),
                        "year": clean_text(item.get("year")),
                        "exifDate": exif_date,
                        "airshow": clean_text(item.get("airshow") or item.get("airshow_name")),
                        "livery": clean_text(item.get("livery") or item.get("paint_scheme") or item.get("paintScheme")),
                        "title": clean_text(item.get("title")),
                        "caption": clean_text(item.get("caption")),
                        "captionAiAssisted": photo_caption_is_ai_assisted(item),
                        "missingFields": missing_fields,
                        "missingFieldLabels": [MISSING_FIELD_LABELS[field] for field in missing_fields],
                    }
                )

            for kind, source_value in (("logo", logo_value), ("squadron hero", hero_value)):
                if not source_value:
                    continue
                source_path = resolve_entry_asset_source(self.root, self.raw_assets_dir, entry_path, source_value)
                if source_path.exists() and self._is_within(source_path, self.raw_assets_dir):
                    source_rel = relative_posix(source_path, self.raw_assets_dir)
                    tag_map.setdefault(source_rel, []).append(
                        {
                            "kind": kind,
                            "label": squadron_name,
                            "path": relative_posix(entry_path, self.root),
                        }
                    )

            entries.append(
                {
                    "targetKey": relative_posix(entry_path, self.root),
                    "sourceScope": "squadron",
                    "entryPath": relative_posix(entry_path, self.root),
                    "entryDir": relative_posix(entry_path.parent, self.root),
                    "aircraftType": "",
                    "squadronName": squadron_name,
                    "country": country,
                    "unitType": unit_type,
                    "unitLabel": "Organisation" if unit_type == "organisation" else "Squadron",
                    "aircraftFamily": "",
                    "squadronLogo": clean_text(logo_value),
                    "squadronLogoExists": logo_exists,
                    "squadronHero": clean_text(hero_value),
                    "squadronHeroAssetPath": hero_asset_path,
                    "entryMissingFields": missing_entry_fields(data, logo_exists=logo_exists, source_scope="squadron"),
                    "photoCount": len(photo_records),
                    "missingPhotoCount": sum(1 for photo in photo_records if photo.get("exists") is False),
                    "missingFieldPhotoCount": sum(1 for photo in photo_records if photo.get("missingFields")),
                    "photos": photo_records,
                }
            )

        entries.sort(key=lambda item: (item["country"], item["squadronName"]))
        return entries

    def _scan_assets(self, tag_map: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        assets: List[Dict[str, Any]] = []
        if not self.raw_assets_dir.exists():
            return assets
        candidates: List[Dict[str, Any]] = []
        photo_kinds = {"photo", "squadron photo", "location photo", "pin hero", "squadron hero"}
        for path in sorted(self.raw_assets_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            rel = relative_posix(path, self.raw_assets_dir)
            stat = path.stat()
            width, height = read_image_dimensions(path, self._image_dimension_cache)
            tags = tag_map.get(rel, [])
            is_photo_source = any(tag.get("kind") in photo_kinds for tag in tags) or (
                not tags and path.suffix.lower() in {".jpg", ".jpeg", ".tif", ".tiff", ".webp"}
            )
            candidates.append(
                {
                    "pathObject": path,
                    "path": rel,
                    "name": path.name,
                    "extension": path.suffix.lower(),
                    "size": stat.st_size,
                    "modified": int(stat.st_mtime),
                    "width": width,
                    "height": height,
                    "isPhotoSource": is_photo_source,
                    "tags": tags,
                }
            )

        quality_by_path: Dict[str, Dict[str, Any]] = {}
        photo_candidates = [item for item in candidates if item["isPhotoSource"]]
        if photo_candidates:
            worker_count = min(8, len(photo_candidates), max(1, os.cpu_count() or 1))
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                futures = {
                    executor.submit(analyse_image_quality, item["pathObject"], self._image_quality_cache): item["path"]
                    for item in photo_candidates
                }
                for future, rel in futures.items():
                    try:
                        quality_by_path[rel] = future.result()
                    except Exception:
                        quality_by_path[rel] = {"flags": []}

        # Read the EXIF capture date for every raw asset so the selector grid can
        # be ordered by when the frame was shot rather than by filesystem mtime.
        capture_by_path: Dict[str, str] = {}
        if candidates:
            worker_count = min(8, len(candidates), max(1, os.cpu_count() or 1))
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                futures = {
                    executor.submit(read_image_capture_date, item["pathObject"], self._exif_date_cache): item["path"]
                    for item in candidates
                }
                for future, rel in futures.items():
                    try:
                        capture_by_path[rel] = future.result()
                    except Exception:
                        capture_by_path[rel] = ""

        acknowledged_map = self._load_quality_ack()
        for item in candidates:
            quality = quality_by_path.get(item["path"], {"flags": []})
            quality_flags = quality.get("flags") if isinstance(quality.get("flags"), list) else []
            capture_date = capture_by_path.get(item["path"], "")
            ack_entry = acknowledged_map.get(item["path"])
            acknowledged = bool(
                ack_entry
                and ack_entry.get("signature") == self._quality_ack_signature(item["size"], item["modified"])
            )
            assets.append(
                {
                    "path": item["path"],
                    "name": item["name"],
                    "extension": item["extension"],
                    "size": item["size"],
                    "sizeLabel": format_bytes(item["size"]),
                    "modified": item["modified"],
                    "captureDate": capture_date,
                    "width": item["width"],
                    "height": item["height"],
                    "dimensionsLabel": f"{item['width']} x {item['height']}" if item["width"] and item["height"] else "Unavailable",
                    "isPhotoSource": item["isPhotoSource"],
                    "isUnderResolution": bool(item["isPhotoSource"] and item["width"] and item["width"] < MIN_SOURCE_PHOTO_WIDTH),
                    "qualityFlags": quality_flags,
                    "hasExposureIssue": any(flag.get("category") == "exposure" for flag in quality_flags if isinstance(flag, dict)),
                    "hasColourBalanceIssue": any(flag.get("category") == "colour" for flag in quality_flags if isinstance(flag, dict)),
                    "qualityAcknowledged": acknowledged,
                    "meanLuminance": quality.get("meanLuminance"),
                    "shadowClipPercent": quality.get("shadowClipPercent"),
                    "highlightClipPercent": quality.get("highlightClipPercent"),
                    "pureBlackPercent": quality.get("pureBlackPercent"),
                    "pureWhitePercent": quality.get("pureWhitePercent"),
                    "tonalRange": quality.get("tonalRange"),
                    "neutralChannelSpread": quality.get("neutralChannelSpread"),
                    "colourCastDirection": quality.get("colourCastDirection"),
                    "acutance": quality.get("acutance"),
                    "iso": quality.get("iso"),
                    "tags": item["tags"],
                }
            )
        # New (untagged) assets first, then newest capture date first. Frames with
        # no readable capture date fall back to filesystem mtime and sort last
        # within their group so freshly imported photos still surface at the top.
        assets.sort(
            key=lambda item: (
                bool(item["tags"]),
                not bool(item.get("captureDate")),
                -capture_date_sort_value(item.get("captureDate", "")),
                -item["modified"],
                item["path"],
            )
        )
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
            if parsed.path in {"/", "/index.html", "/app.html"}:
                self._send_manager_asset("app.html")
                return
            if parsed.path in {"/app.css", "/app.js"}:
                self._send_manager_asset(parsed.path.lstrip("/"))
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
            if parsed.path == "/api/raw":
                query = parse_qs(parsed.query)
                asset_rel = query.get("path", [""])[0]
                content, content_type = self.context.manager.make_full_asset(asset_rel)
                self._send_bytes(content, content_type)
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
                "/api/update-unit-logo": self.context.manager.update_unit_logo,
                "/api/delete-entry": self.context.manager.delete_entry,
                "/api/update-aircraft-settings": self.context.manager.update_aircraft_settings,
                "/api/update-write-up": self.context.manager.update_write_up,
                "/api/update-photo": self.context.manager.update_photo,
                "/api/update-master-photo": self.context.manager.update_master_photo,
                "/api/bulk-update-photos": self.context.manager.bulk_update_photos,
                "/api/bulk-airshow": self.context.manager.bulk_update_airshow,
                "/api/set-airshow-hero": self.context.manager.set_airshow_hero,
                "/api/set-squadron-hero": self.context.manager.set_squadron_hero,
                "/api/set-aircraft-hero": self.context.manager.set_aircraft_hero,
                "/api/generate-caption": self.context.manager.generate_caption,
                "/api/delete-photo": self.context.manager.delete_photo,
                "/api/delete-master-photo": self.context.manager.delete_master_photo,
                "/api/create-entry": self.context.manager.create_entry,
                "/api/create-pin": self.context.manager.create_pin,
                "/api/create-event": self.context.manager.create_event,
                "/api/set-pin-hero": self.context.manager.set_pin_hero,
                "/api/clear-build-cache": self.context.manager.clear_build_cache,
                "/api/backup-database": self.context.manager.backup_database,
                "/api/acknowledge-quality": self.context.manager.set_quality_acknowledgement,
                "/api/find-orphans": self.context.manager.find_orphans,
                "/api/delete-orphans": self.context.manager.delete_orphans,
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

    def _send_manager_asset(self, filename: str) -> None:
        content_type = MANAGER_STATIC_FILES.get(filename)
        if content_type is None:
            self._send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        asset_path = MANAGER_ASSETS_DIR / filename
        if not asset_path.is_file():
            self._send_error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                f"Manager asset missing: tools/manager/{filename}",
            )
            return
        # Read from disk on every request so UI edits appear on a browser refresh
        # without restarting the local server.
        self._send_bytes(asset_path.read_bytes(), content_type)

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
    if key in {"fighter", "heavy", "helicopter", "light", "medium"}:
        return key
    return clean_text(value)


def read_squadron_logo_value(data: Dict[str, Any]) -> Any:
    squadron_data = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
    return data.get("squadron_logo") or data.get("squadronLogo") or data.get("logo") or squadron_data.get("logo")


def missing_entry_fields(
    data: Dict[str, Any],
    logo_exists: bool = False,
    source_scope: str = "aircraft",
) -> List[str]:
    missing: List[str] = []
    if source_scope == "aircraft" and not clean_text(data.get("aircraft_type") or data.get("aircraft_type_name") or data.get("type_name")):
        aircraft_data = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
        if not clean_text(aircraft_data.get("name")):
            missing.append("aircraftType")
    if source_scope == "aircraft" and not read_aircraft_family(data):
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


def capture_date_sort_value(date_value: str) -> int:
    """Return a comparable integer for a normalized capture date.

    Dates are stored as ``YYYY-MM-DD`` strings; converting to an integer such as
    ``20240226`` lets the asset grid sort newest-first with a simple negation and
    keeps images without any capture date (value ``0``) grouped together.
    """
    digits = re.sub(r"\D", "", date_value or "")
    if len(digits) >= 8:
        try:
            return int(digits[:8])
        except ValueError:
            return 0
    return 0


def read_image_dimensions(path: Path, cache: Dict[str, Tuple[int, int]]) -> Tuple[int, int]:
    """Read source dimensions once per unchanged raw image for manager QA."""
    try:
        stat = path.stat()
    except OSError:
        return (0, 0)
    cache_key = f"{path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}"
    if cache_key in cache:
        return cache[cache_key]

    result = (0, 0)
    try:
        with Image.open(path) as opened:
            result = (int(opened.width), int(opened.height))
    except Exception:
        result = (0, 0)
    cache[cache_key] = result
    return result


def _histogram_percentile(histogram: List[int], total: int, fraction: float) -> int:
    """Return the bin index at which the cumulative histogram passes ``fraction``."""
    if total <= 0:
        return 0
    threshold = total * fraction
    cumulative = 0
    for index, count in enumerate(histogram):
        cumulative += count
        if cumulative >= threshold:
            return index
    return len(histogram) - 1


def describe_colour_cast(channel_means: List[float]) -> str:
    """Summarise the direction of a neutral-pixel colour cast for the reviewer."""
    if len(channel_means) != 3:
        return ""
    red, green, blue = channel_means
    parts: List[str] = []
    warm_cool = red - blue
    if warm_cool >= COLOUR_CAST_DIRECTION_DELTA:
        parts.append("warm/orange")
    elif warm_cool <= -COLOUR_CAST_DIRECTION_DELTA:
        parts.append("cool/blue")
    green_magenta = green - (red + blue) / 2
    if green_magenta >= COLOUR_CAST_DIRECTION_DELTA:
        parts.append("green")
    elif green_magenta <= -COLOUR_CAST_DIRECTION_DELTA:
        parts.append("magenta")
    return ", ".join(parts)


def coerce_iso_value(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (tuple, list)):
        value = value[0] if value else None
    try:
        iso = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return iso if iso > 0 else None


def read_exif_iso(opened: Image.Image) -> Optional[int]:
    """Read the capture ISO from an open image, if the EXIF records one."""
    try:
        raw = opened.getexif()
        if not raw:
            return None
        exif_ifd = read_exif_sub_ifd(raw)
        for tag_name in ("ISOSpeedRatings", "PhotographicSensitivity", "ISOSpeed"):
            tag_id = exif_tag_id(tag_name)
            if not tag_id:
                continue
            iso = coerce_iso_value(exif_ifd.get(tag_id))
            if iso is None:
                iso = coerce_iso_value(raw.get(tag_id))
            if iso is not None:
                return iso
    except Exception:
        return None
    return None


def compute_quality_metrics(image: Image.Image, pixel_count: int) -> Dict[str, Any]:
    """Derive exposure, contrast, colour-cast and sharpness metrics with C-level ops.

    Everything here runs on Pillow's histogram / channel primitives rather than a
    Python per-pixel loop, so it is both far faster and releases the GIL, letting
    the manager analyse a large ``raw_assets/`` set in parallel.
    """
    # Rec.709 luminance keeps parity with the previous per-pixel weighting.
    luminance = image.convert("L", (0.2126, 0.7152, 0.0722, 0))
    lum_hist = luminance.histogram()
    total = sum(lum_hist) or 1

    mean_luminance = sum(index * count for index, count in enumerate(lum_hist)) / total
    shadow_ratio = sum(lum_hist[0:11]) / total
    highlight_ratio = sum(lum_hist[245:256]) / total
    true_shadow_ratio = lum_hist[0] / total
    true_highlight_ratio = lum_hist[255] / total
    tonal_range = _histogram_percentile(lum_hist, total, 0.98) - _histogram_percentile(lum_hist, total, 0.02)

    red_band, green_band, blue_band = image.split()
    channel_max = ImageChops.lighter(ImageChops.lighter(red_band, green_band), blue_band)
    channel_min = ImageChops.darker(ImageChops.darker(red_band, green_band), blue_band)
    chroma = ImageChops.difference(channel_max, channel_min)
    neutral_by_chroma = chroma.point(lambda value: 255 if value <= NEUTRAL_PIXEL_CHROMA_MAX else 0)
    luminance_in_range = luminance.point(lambda value: 255 if 36 <= value <= 228 else 0)
    neutral_mask = ImageChops.multiply(neutral_by_chroma, luminance_in_range)
    neutral_count = neutral_mask.histogram()[255]

    channel_spread = 0.0
    cast_direction = ""
    neutral_minimum = max(120, round(pixel_count * 0.025))
    if neutral_count >= neutral_minimum:
        channel_means: List[float] = []
        for band in (red_band, green_band, blue_band):
            masked = ImageChops.multiply(band, neutral_mask)
            band_sum = sum(index * count for index, count in enumerate(masked.histogram()))
            channel_means.append(band_sum / neutral_count)
        channel_spread = max(channel_means) - min(channel_means)
        cast_direction = describe_colour_cast(channel_means)

    edge_hist = luminance.filter(ImageFilter.FIND_EDGES).histogram()
    edge_total = sum(edge_hist) or 1
    acutance = sum(index * count for index, count in enumerate(edge_hist)) / edge_total

    return {
        "mean_luminance": mean_luminance,
        "shadow_ratio": shadow_ratio,
        "highlight_ratio": highlight_ratio,
        "true_shadow_ratio": true_shadow_ratio,
        "true_highlight_ratio": true_highlight_ratio,
        "tonal_range": tonal_range,
        "channel_spread": channel_spread,
        "cast_direction": cast_direction,
        "acutance": acutance,
    }


def build_quality_flags(metrics: Dict[str, Any], iso_value: Optional[int]) -> List[Dict[str, str]]:
    """Turn raw metrics into reviewer-facing warnings (severity ``warn`` or ``info``)."""
    flags: List[Dict[str, str]] = []
    mean_luminance = metrics["mean_luminance"]
    shadow_ratio = metrics["shadow_ratio"]
    highlight_ratio = metrics["highlight_ratio"]
    true_shadow_ratio = metrics["true_shadow_ratio"]
    true_highlight_ratio = metrics["true_highlight_ratio"]
    tonal_range = metrics["tonal_range"]

    if true_shadow_ratio >= TRUE_CLIP_SHADOW_RATIO:
        flags.append(
            {
                "id": "clipped-shadows",
                "category": "exposure",
                "severity": "warn",
                "label": "Clipped shadows",
                "short": "Crushed blacks",
                "detail": f"{round(true_shadow_ratio * 100)}% of pixels are pure black with no recoverable detail.",
            }
        )
    if true_highlight_ratio >= TRUE_CLIP_HIGHLIGHT_RATIO:
        flags.append(
            {
                "id": "blown-highlights",
                "category": "exposure",
                "severity": "warn",
                "label": "Blown highlights",
                "short": "Blown highlights",
                "detail": f"{round(true_highlight_ratio * 100)}% of pixels are pure white with no recoverable detail.",
            }
        )

    if mean_luminance <= UNDEREXPOSED_MEAN_LUMINANCE and shadow_ratio >= CLIPPED_SHADOW_RATIO:
        flags.append(
            {
                "id": "underexposed",
                "category": "exposure",
                "severity": "warn",
                "label": "Possible underexposure",
                "short": "Underexposed",
                "detail": f"Average luminance {round(mean_luminance)} with {round(shadow_ratio * 100)}% deep shadows.",
            }
        )
    elif mean_luminance >= OVEREXPOSED_MEAN_LUMINANCE and highlight_ratio >= CLIPPED_HIGHLIGHT_RATIO:
        flags.append(
            {
                "id": "overexposed",
                "category": "exposure",
                "severity": "warn",
                "label": "Possible overexposure",
                "short": "Overexposed",
                "detail": f"Average luminance {round(mean_luminance)} with {round(highlight_ratio * 100)}% bright highlights.",
            }
        )

    if (
        tonal_range <= LOW_CONTRAST_TONAL_RANGE
        and true_shadow_ratio < TRUE_CLIP_SHADOW_RATIO
        and true_highlight_ratio < TRUE_CLIP_HIGHLIGHT_RATIO
    ):
        flags.append(
            {
                "id": "low-contrast",
                "category": "contrast",
                "severity": "info",
                "label": "Low contrast / possible haze",
                "short": "Low contrast",
                "detail": f"Tonal range spans only {round(tonal_range)} of 255 levels; the frame may look flat or hazy.",
            }
        )

    if metrics["channel_spread"] >= COLOUR_CAST_CHANNEL_SPREAD:
        direction = metrics["cast_direction"]
        direction_text = f" ({direction} cast)" if direction else ""
        flags.append(
            {
                "id": "colour-cast",
                "category": "colour",
                "severity": "warn",
                "label": "Possible colour cast",
                "short": "Colour cast",
                "detail": (
                    f"Neutral-toned pixels differ by {round(metrics['channel_spread'])} RGB levels on average"
                    f"{direction_text}."
                ),
            }
        )

    if metrics["acutance"] and metrics["acutance"] <= SOFT_FOCUS_ACUTANCE and tonal_range > LOW_CONTRAST_TONAL_RANGE:
        flags.append(
            {
                "id": "soft-focus",
                "category": "focus",
                "severity": "info",
                "label": "Possible soft focus",
                "short": "Soft focus",
                "detail": (
                    f"Low edge detail (acutance {round(metrics['acutance'], 1)}); "
                    "review at full size for missed focus or motion blur."
                ),
            }
        )

    if iso_value and iso_value >= HIGH_ISO_NOISE_THRESHOLD:
        flags.append(
            {
                "id": "high-iso",
                "category": "noise",
                "severity": "info",
                "label": "High ISO (noise risk)",
                "short": f"ISO {iso_value}",
                "detail": f"Captured at ISO {iso_value}; inspect shadows for noise before publishing.",
            }
        )

    return flags


def analyse_image_quality(path: Path, cache: Dict[str, Tuple[int, int, Dict[str, Any]]]) -> Dict[str, Any]:
    """Return conservative exposure, contrast, colour, focus and noise warnings."""
    try:
        stat = path.stat()
    except OSError:
        return {"flags": []}
    cache_key = str(path.resolve())
    cached = cache.get(cache_key)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2]

    result: Dict[str, Any] = {"flags": []}
    iso_value: Optional[int] = None
    try:
        with Image.open(path) as opened:
            try:
                opened.draft("RGB", (QUALITY_ANALYSIS_MAX_DIMENSION, QUALITY_ANALYSIS_MAX_DIMENSION))
            except Exception:
                pass
            iso_value = read_exif_iso(opened)
            image = ImageOps.exif_transpose(opened).convert("RGB")
            image.thumbnail((QUALITY_ANALYSIS_MAX_DIMENSION, QUALITY_ANALYSIS_MAX_DIMENSION), Image.Resampling.LANCZOS)
    except Exception:
        cache[cache_key] = (stat.st_mtime_ns, stat.st_size, result)
        return result

    pixel_count = image.width * image.height
    if pixel_count <= 0:
        cache[cache_key] = (stat.st_mtime_ns, stat.st_size, result)
        return result

    metrics = compute_quality_metrics(image, pixel_count)
    flags = build_quality_flags(metrics, iso_value)

    result = {
        "flags": flags,
        "meanLuminance": round(metrics["mean_luminance"]),
        "shadowClipPercent": round(metrics["shadow_ratio"] * 100),
        "highlightClipPercent": round(metrics["highlight_ratio"] * 100),
        "pureBlackPercent": round(metrics["true_shadow_ratio"] * 100),
        "pureWhitePercent": round(metrics["true_highlight_ratio"] * 100),
        "tonalRange": round(metrics["tonal_range"]),
        "neutralChannelSpread": round(metrics["channel_spread"]),
        "colourCastDirection": metrics["cast_direction"],
        "acutance": round(metrics["acutance"], 1),
        "iso": iso_value,
    }
    cache[cache_key] = (stat.st_mtime_ns, stat.st_size, result)
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


def clear_squadron_hero_fields(data: Dict[str, Any]) -> None:
    for key in ("squadron_hero", "squadron_hero_image", "squadronHero", "squadronHeroImage"):
        data.pop(key, None)
    squadron_data = data.get("squadron")
    if isinstance(squadron_data, dict):
        for key in ("hero", "hero_image", "heroImage", "hero_photo", "heroPhoto"):
            squadron_data.pop(key, None)


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


def normalize_optional_boolean(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = clean_text(value).lower()
    if text in {"", "auto", "automatic", "default", "null", "none"}:
        return None
    if text in {"1", "true", "yes", "on", "double", "double-width"}:
        return True
    if text in {"0", "false", "no", "off", "standard", "standard-width"}:
        return False
    raise ValueError("Aircraft card width must be Automatic, Standard, or Double.")


def normalize_airshow_hero_ref(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    try:
        index = int(value.get("index"))
    except (TypeError, ValueError):
        return {}
    if index < 0:
        return {}
    scope = clean_text(value.get("scope"))
    entry_path = clean_text(value.get("entry_path") or value.get("entryPath"))
    pin_id = clean_text(value.get("target_pin_id") or value.get("targetPinId"))
    if not scope or not entry_path:
        return {}
    reference: Dict[str, Any] = {"scope": scope, "entryPath": entry_path, "index": index}
    if pin_id:
        reference["targetPinId"] = pin_id
    return reference


def photo_caption_is_ai_assisted(photo_item: Dict[str, Any]) -> bool:
    value = photo_item.get("caption_ai_assisted", photo_item.get("captionAiAssisted"))
    return value is True or clean_text(value).lower() in {"1", "true", "yes"}


def payload_caption_is_ai_assisted(payload: Dict[str, Any]) -> bool:
    return payload.get("captionAiAssisted") is True or payload.get("caption_ai_assisted") is True


def caption_image_data_url(source_path: Path) -> str:
    """Return a server-generated 768 px-wide JPEG data URL for the VLM."""
    try:
        with Image.open(source_path) as opened:
            image = ImageOps.exif_transpose(opened)
            height = max(1, round(image.height * NVIDIA_CAPTION_IMAGE_WIDTH / image.width))
            image = image.resize((NVIDIA_CAPTION_IMAGE_WIDTH, height), Image.Resampling.LANCZOS)
            if image.mode in {"RGBA", "LA"}:
                background = Image.new("RGB", image.size, "white")
                alpha = image.getchannel("A")
                background.paste(image.convert("RGB"), mask=alpha)
                image = background
            elif image.mode != "RGB":
                image = image.convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, "JPEG", quality=88, optimize=True)
    except Exception as exc:  # Pillow uses multiple exception types for malformed source files.
        print(f"Caption image preparation failed for {source_path}: {exc}", file=sys.stderr)
        raise CaptionAssistError("The selected image could not be prepared for caption assistance.") from exc

    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def nvidia_caption_endpoint() -> str:
    configured = clean_text(
        os.getenv("NVIDIA_CAPTION_ENDPOINT")
        or os.getenv("NVIDIA_INFERENCE_BASE_URL")
        or os.getenv("NVIDIA_INFERENCE_URL")
        or NVIDIA_CAPTION_ENDPOINT
    ).rstrip("/")
    if configured.endswith("/chat/completions"):
        return configured
    if configured.endswith("/v1"):
        return f"{configured}/chat/completions"
    raise CaptionAssistError("NVIDIA_CAPTION_ENDPOINT must be a /v1 base URL or /v1/chat/completions endpoint.")


def load_local_env(path: Optional[Path] = None) -> None:
    """Load simple KEY=VALUE settings from the local, ignored manager .env file.

    Explicit process environment variables win over values in .env. Values are
    loaded only into the manager process and are never included in browser state,
    generated data, or error messages.
    """
    env_path = path or DOTENV_PATH
    try:
        lines = env_path.read_text("utf-8").splitlines()
    except OSError:
        return

    key_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key_pattern.fullmatch(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def resolve_nvidia_caption_key() -> str:
    load_local_env()
    value = clean_text(os.getenv("LLM_API_KEY"))
    if value:
        return value
    raise CaptionAssistError("Caption assist is not configured. Set LLM_API_KEY in the manager environment or in the manager .env file.")


def extract_caption_from_response(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise CaptionAssistError("Caption assist returned an invalid response.")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise CaptionAssistError("Caption assist returned no caption.")
    first_choice = choices[0] if isinstance(choices[0], dict) else {}
    message = first_choice.get("message") if isinstance(first_choice, dict) else {}
    content = message.get("content") if isinstance(message, dict) else ""
    if isinstance(content, list):
        content = " ".join(
            clean_text(item.get("text"))
            for item in content
            if isinstance(item, dict) and clean_text(item.get("text"))
        )
    caption = " ".join(clean_text(content).split())
    if caption.lower().startswith("caption:"):
        caption = caption.split(":", 1)[1].strip()
    if len(caption) >= 2 and caption[0] == caption[-1] and caption[0] in {'"', "'"}:
        caption = caption[1:-1].strip()
    if not caption:
        raise CaptionAssistError("Caption assist returned no usable caption.")
    return caption


def request_nvidia_caption(*, prompt: str, image_url: str) -> str:
    load_local_env()
    api_key = resolve_nvidia_caption_key()
    model = clean_text(os.getenv("NVIDIA_CAPTION_MODEL")) or NVIDIA_CAPTION_MODEL
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": f"/think\n{CAPTION_SYSTEM_PROMPT}",
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
        ],
        "temperature": 0.25,
        "max_tokens": NVIDIA_CAPTION_MAX_TOKENS,
        "reasoning_budget": NVIDIA_CAPTION_REASONING_BUDGET,
        "stream": False,
    }
    request = Request(
        nvidia_caption_endpoint(),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=NVIDIA_CAPTION_TIMEOUT_SECONDS) as response:
            response_body = response.read()
    except HTTPError as exc:
        if exc.code in {401, 403}:
            raise CaptionAssistError("Caption assist could not authenticate with NVIDIA. Check the server-side key.") from exc
        raise CaptionAssistError(f"Caption assist is temporarily unavailable (NVIDIA returned {exc.code}).") from exc
    except (URLError, TimeoutError) as exc:
        raise CaptionAssistError("Caption assist could not reach NVIDIA. Please try again.") from exc

    try:
        return extract_caption_from_response(json.loads(response_body.decode("utf-8")))
    except CaptionAssistError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CaptionAssistError("Caption assist returned an invalid response.") from exc


def clean_year(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    match = re.match(r"^(\d{4})", text)
    return match.group(1) if match else text


def normalize_aircraft_family(value: Any) -> str:
    text = clean_text(value)
    key = normalize_key(text)
    if key in {"fighter", "heavy", "helicopter", "light", "medium"}:
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
        root / "data" / "spotterdex-core.js",
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


def collect_referenced_generated(node: Any, referenced: set[str]) -> None:
    """Recursively collect every generated JPEG path referenced by the manifest."""
    if isinstance(node, dict):
        for value in node.values():
            collect_referenced_generated(value, referenced)
    elif isinstance(node, list):
        for value in node:
            collect_referenced_generated(value, referenced)
    elif isinstance(node, str):
        candidate = node.strip().lstrip("./")
        for base in GENERATED_ORPHAN_DIRS:
            if candidate.startswith(base + "/"):
                referenced.add(candidate)
                break


def scan_orphaned_generated(root: Path) -> Dict[str, Any]:
    """Find generated JPEGs on disk that the current manifest no longer references."""
    manifest_path = root / "data" / "spotterdex.json"
    if not manifest_path.exists():
        return {
            "orphans": [],
            "referencedCount": 0,
            "scannedCount": 0,
            "orphanBytes": 0,
            "orphanBytesLabel": format_bytes(0),
            "manifestReady": False,
            "message": "No manifest found. Run a build before scanning for orphans.",
        }
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "orphans": [],
            "referencedCount": 0,
            "scannedCount": 0,
            "orphanBytes": 0,
            "orphanBytesLabel": format_bytes(0),
            "manifestReady": False,
            "message": "The manifest could not be read; skipping orphan scan.",
        }

    photos = manifest.get("photos")
    if int(manifest.get("schemaVersion") or 0) == 2 and isinstance(manifest.get("entities"), dict):
        photos = manifest["entities"].get("photos")
    referenced: set[str] = set()
    collect_referenced_generated(manifest, referenced)
    # Guard against nuking everything when the manifest is empty or malformed: a
    # build that produced zero photos would otherwise flag the entire directory.
    if not isinstance(photos, (list, dict)) or not photos:
        return {
            "orphans": [],
            "referencedCount": len(referenced),
            "scannedCount": 0,
            "orphanBytes": 0,
            "orphanBytesLabel": format_bytes(0),
            "manifestReady": False,
            "message": "Manifest has no photos; skipping orphan scan to stay safe.",
        }

    orphans: List[Dict[str, Any]] = []
    scanned = 0
    total_bytes = 0
    for base in GENERATED_ORPHAN_DIRS:
        directory = root / base
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            rel = relative_posix(path, root)
            scanned += 1
            if rel in referenced:
                continue
            size = path.stat().st_size
            total_bytes += size
            orphans.append(
                {
                    "path": rel,
                    "category": generated_category(rel),
                    "size": size,
                    "sizeLabel": format_bytes(size),
                }
            )

    if orphans:
        message = f"{len(orphans)} orphaned file(s) found ({format_bytes(total_bytes)})."
    else:
        message = "No orphaned files found. Generated output matches the manifest."
    return {
        "orphans": orphans,
        "referencedCount": len(referenced),
        "scannedCount": scanned,
        "orphanBytes": total_bytes,
        "orphanBytesLabel": format_bytes(total_bytes),
        "manifestReady": True,
        "message": message,
    }


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

    if int(data.get("schemaVersion") or 0) == 2 and isinstance(data.get("entities"), dict):
        entities = data["entities"]
        units = list((entities.get("units") or {}).values())
        return {
            "aircraft": len(entities.get("aircraft") or {}),
            "photos": len(entities.get("photos") or {}),
            "pins": len(entities.get("locations") or {}),
            "squadrons": sum(1 for unit in units if unit.get("kind", "squadron") == "squadron"),
            "organisations": sum(1 for unit in units if unit.get("kind") == "organisation"),
            "generatedAt": clean_text(data.get("generatedAt")),
        }
    aircraft = data.get("aircraft") if isinstance(data.get("aircraft"), list) else []
    squadrons = [
        squadron
        for entry in aircraft
        if isinstance(entry, dict)
        for squadron in entry.get("squadrons", [])
        if isinstance(squadron, dict)
    ]
    squadrons.extend(item for item in data.get("squadrons", []) if isinstance(item, dict))
    unit_keys: set[str] = set()
    unique_squadrons: List[Dict[str, Any]] = []
    for squadron in squadrons:
        key = normalize_key(f"{squadron.get('country', '')}-{squadron.get('name', '')}-{squadron.get('unitType', '')}")
        if key in unit_keys:
            continue
        unit_keys.add(key)
        unique_squadrons.append(squadron)
    return {
        "aircraft": len(aircraft),
        "photos": len(data.get("photos") if isinstance(data.get("photos"), list) else []),
        "pins": len(data.get("pins") if isinstance(data.get("pins"), list) else []),
        "squadrons": sum(1 for squadron in unique_squadrons if squadron.get("unitType", "squadron") == "squadron"),
        "organisations": sum(1 for squadron in unique_squadrons if squadron.get("unitType") == "organisation"),
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
        "databaseStatus": read_database_status(root),
    }


def read_database_status(root: Path) -> Dict[str, Any]:
    database_path = root / "content" / "spotterdex.sqlite3"
    snapshot_path = root / "content" / "spotterdex.sql"
    if not database_path.exists():
        return {"integrity": "missing", "snapshotCurrent": False, "errors": ["Canonical database is missing."]}
    connection = connect_database(database_path, read_only=True)
    try:
        errors = validate_database(connection, raw_assets_dir=root / "raw_assets")
        current = snapshot_is_current(connection, snapshot_path)
    finally:
        connection.close()
    return {"integrity": "ok" if not errors else "error", "snapshotCurrent": current, "errors": errors}


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
    if re.match(r"^(loading map pins|reading aircraft yaml|reading squadron yaml|reading location photos|processing(?: .+)? photos|processing catalog photos):", text):
        return "progress"
    return "log"


def recommended_commit_scope(root: Path, changes: Dict[str, Any]) -> Dict[str, Any]:
    changed_files = git_changed_files(root)
    source_catalog = [path for path in changed_files if path in {"content/spotterdex.sqlite3", "content/spotterdex.sql"}]
    generated_data = [path for path in changed_files if path.startswith("data/")]
    generated_photos = [path for path in changed_files if path.startswith("assets/generated/photos/")]
    generated_thumbs = [path for path in changed_files if path.startswith("assets/generated/thumbs/")]
    logos = [path for path in changed_files if path.startswith("assets/logos/")]

    sections = [
        {
            "label": "Canonical catalog",
            "files": source_catalog,
            "include": bool(source_catalog),
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
            "content/spotterdex.sqlite3",
            "content/spotterdex.sql",
            "data/spotterdex.json",
            "data/spotterdex-core.js",
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


# The manager UI is served as static files from tools/manager/
# (app.html, app.css, app.js). SpotterDexHandler.do_GET reads them from disk
# on each request, so edits are picked up on a browser refresh without a
# server restart. Prefer editing those files over a large inline string.


if __name__ == "__main__":
    raise SystemExit(main())
