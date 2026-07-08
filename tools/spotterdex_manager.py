#!/usr/bin/env python3
"""Local SpotterDex data manager.

This intentionally stays dependency-light: it uses the Python standard library
for the web server plus the same PyYAML and Pillow dependencies as the existing
SpotterDex build script.
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
    from PIL import Image, ImageOps
except ImportError as exc:  # pragma: no cover - user environment guard
    raise SystemExit("Missing Pillow. Install with: python3 -m pip install -r requirements.txt") from exc


ROOT = Path(__file__).resolve().parents[1]
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
CACHE_DIR = ROOT / ".spotterdex-manager-cache"
THUMB_DIR = CACHE_DIR / "thumbs"
NVIDIA_CAPTION_ENDPOINT = "https://inference-api.nvidia.com/v1/chat/completions"
NVIDIA_CAPTION_MODEL = "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
NVIDIA_CAPTION_IMAGE_WIDTH = 768
NVIDIA_CAPTION_TIMEOUT_SECONDS = 75
MIN_SOURCE_PHOTO_WIDTH = 2560
QUALITY_ANALYSIS_MAX_DIMENSION = 256
UNDEREXPOSED_MEAN_LUMINANCE = 58
OVEREXPOSED_MEAN_LUMINANCE = 202
CLIPPED_SHADOW_RATIO = 0.24
CLIPPED_HIGHLIGHT_RATIO = 0.24
NEUTRAL_PIXEL_CHROMA_MAX = 32
COLOUR_CAST_CHANNEL_SPREAD = 28


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

    def get_state(self) -> Dict[str, Any]:
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
        quality_issue_asset_count = sum(1 for asset in assets if asset.get("qualityFlags"))

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

    def generate_caption(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Generate a non-persistent caption suggestion from a source image."""
        squadron_target = payload.get("squadronTarget")
        target: Optional[Dict[str, Any]] = None
        if squadron_target:
            if not isinstance(squadron_target, dict):
                raise CaptionAssistError("Squadron target is invalid.")
            aircraft_type = ""
            squadron_name = clean_text(squadron_target.get("squadronName"))
            if not squadron_name:
                raise CaptionAssistError("Choose a squadron before generating a caption.")
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
            aircraft_type=aircraft_type,
            squadron_name=squadron_name,
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

    def update_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
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

    def create_entry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        scope = clean_text(payload.get("scope")) or "aircraft"
        aircraft_type = clean_text(payload.get("aircraftType"))
        squadron_name = clean_text(payload.get("squadronName"))
        country = clean_text(payload.get("country"))
        unit_type = clean_text(payload.get("unitType")) or "squadron"
        if scope not in {"aircraft", "squadron"}:
            raise ValueError("Entry scope is invalid.")
        if not squadron_name or not country or (scope == "aircraft" and not aircraft_type):
            raise ValueError("Aircraft entries require an aircraft type, unit name, and country; squadron entries require a unit name and country.")
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
        if unit_type == "organisation":
            data["unit_type"] = "organisation"
        data["photos"] = []
        write_yaml(entry_path, data)
        return {
            "ok": True,
            "message": "Entry created.",
            "entryPath": relative_posix(entry_path, self.root),
            "scope": scope,
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
                    "photoCount": 0,
                    "photos": [],
                    "hero": {},
                },
            )
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

        for item in candidates:
            quality = quality_by_path.get(item["path"], {"flags": []})
            quality_flags = quality.get("flags") if isinstance(quality.get("flags"), list) else []
            assets.append(
                {
                    "path": item["path"],
                    "name": item["name"],
                    "extension": item["extension"],
                    "size": item["size"],
                    "sizeLabel": format_bytes(item["size"]),
                    "modified": item["modified"],
                    "width": item["width"],
                    "height": item["height"],
                    "dimensionsLabel": f"{item['width']} x {item['height']}" if item["width"] and item["height"] else "Unavailable",
                    "isPhotoSource": item["isPhotoSource"],
                    "isUnderResolution": bool(item["isPhotoSource"] and item["width"] and item["width"] < MIN_SOURCE_PHOTO_WIDTH),
                    "qualityFlags": quality_flags,
                    "hasExposureIssue": any(flag.get("category") == "exposure" for flag in quality_flags if isinstance(flag, dict)),
                    "hasColourBalanceIssue": any(flag.get("category") == "colour" for flag in quality_flags if isinstance(flag, dict)),
                    "meanLuminance": quality.get("meanLuminance"),
                    "shadowClipPercent": quality.get("shadowClipPercent"),
                    "highlightClipPercent": quality.get("highlightClipPercent"),
                    "neutralChannelSpread": quality.get("neutralChannelSpread"),
                    "tags": item["tags"],
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
                "/api/bulk-airshow": self.context.manager.bulk_update_airshow,
                "/api/set-airshow-hero": self.context.manager.set_airshow_hero,
                "/api/set-squadron-hero": self.context.manager.set_squadron_hero,
                "/api/generate-caption": self.context.manager.generate_caption,
                "/api/delete-photo": self.context.manager.delete_photo,
                "/api/create-entry": self.context.manager.create_entry,
                "/api/create-pin": self.context.manager.create_pin,
                "/api/set-pin-hero": self.context.manager.set_pin_hero,
                "/api/clear-build-cache": self.context.manager.clear_build_cache,
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


def analyse_image_quality(path: Path, cache: Dict[str, Tuple[int, int, Dict[str, Any]]]) -> Dict[str, Any]:
    """Return conservative exposure and neutral-colour-cast warnings for a source image."""
    try:
        stat = path.stat()
    except OSError:
        return {"flags": []}
    cache_key = str(path.resolve())
    cached = cache.get(cache_key)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2]

    result: Dict[str, Any] = {"flags": []}
    try:
        with Image.open(path) as opened:
            try:
                opened.draft("RGB", (QUALITY_ANALYSIS_MAX_DIMENSION, QUALITY_ANALYSIS_MAX_DIMENSION))
            except Exception:
                pass
            image = ImageOps.exif_transpose(opened).convert("RGB")
            image.thumbnail((QUALITY_ANALYSIS_MAX_DIMENSION, QUALITY_ANALYSIS_MAX_DIMENSION), Image.Resampling.LANCZOS)
            pixels = list(image.getdata())
    except Exception:
        cache[cache_key] = (stat.st_mtime_ns, stat.st_size, result)
        return result

    if not pixels:
        cache[cache_key] = (stat.st_mtime_ns, stat.st_size, result)
        return result

    luminance_total = 0.0
    dark_count = 0
    bright_count = 0
    neutral_count = 0
    neutral_channels = [0, 0, 0]
    for red, green, blue in pixels:
        luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        luminance_total += luminance
        if luminance <= 10:
            dark_count += 1
        if luminance >= 245:
            bright_count += 1
        if 36 <= luminance <= 228 and max(red, green, blue) - min(red, green, blue) <= NEUTRAL_PIXEL_CHROMA_MAX:
            neutral_count += 1
            neutral_channels[0] += red
            neutral_channels[1] += green
            neutral_channels[2] += blue

    pixel_count = len(pixels)
    mean_luminance = luminance_total / pixel_count
    shadow_ratio = dark_count / pixel_count
    highlight_ratio = bright_count / pixel_count
    flags: List[Dict[str, str]] = []
    if mean_luminance <= UNDEREXPOSED_MEAN_LUMINANCE and shadow_ratio >= CLIPPED_SHADOW_RATIO:
        flags.append(
            {
                "id": "underexposed",
                "category": "exposure",
                "label": "Possible underexposure",
                "detail": f"Average luminance {round(mean_luminance)} with {round(shadow_ratio * 100)}% deep shadows.",
            }
        )
    elif mean_luminance >= OVEREXPOSED_MEAN_LUMINANCE and highlight_ratio >= CLIPPED_HIGHLIGHT_RATIO:
        flags.append(
            {
                "id": "overexposed",
                "category": "exposure",
                "label": "Possible overexposure",
                "detail": f"Average luminance {round(mean_luminance)} with {round(highlight_ratio * 100)}% bright highlights.",
            }
        )

    neutral_minimum = max(120, round(pixel_count * 0.025))
    channel_spread = 0.0
    if neutral_count >= neutral_minimum:
        channel_means = [value / neutral_count for value in neutral_channels]
        channel_spread = max(channel_means) - min(channel_means)
        if channel_spread >= COLOUR_CAST_CHANNEL_SPREAD:
            flags.append(
                {
                    "id": "colour-cast",
                    "category": "colour",
                    "label": "Possible colour cast",
                    "detail": f"Neutral-toned pixels differ by {round(channel_spread)} RGB levels on average.",
                }
            )

    result = {
        "flags": flags,
        "meanLuminance": round(mean_luminance),
        "shadowClipPercent": round(shadow_ratio * 100),
        "highlightClipPercent": round(highlight_ratio * 100),
        "neutralChannelSpread": round(channel_spread),
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


def build_caption_prompt(
    *,
    aircraft_type: str,
    squadron_name: str,
    location: str,
    airshow: str,
    livery: str,
    draft_caption: str,
) -> str:
    return "\n".join(
        [
            "Write one concise, polished English caption for this aviation photograph.",
            "Use the image and the supplied metadata. Return only the final caption, without a label, "
            "quotation marks, Markdown, or an explanation.",
            "The caption must be accurate and specific, but do not invent a registration, date, weather, "
            "mission, livery detail, manoeuvre, or other fact that is not visibly supported or supplied.",
            "If an existing caption is supplied, refine it when useful and remove unsupported details.",
            "",
            f"Aircraft type: {aircraft_type or 'Not supplied'}",
            f"Squadron or operator: {squadron_name or 'Not supplied'}",
            f"Location: {location or 'Not supplied'}",
            f"Airshow event: {airshow or 'Not supplied'}",
            f"Livery or paint scheme: {livery or 'Not supplied'}",
            f"Existing caption: {draft_caption or 'None'}",
        ]
    )


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


def resolve_nvidia_caption_key() -> str:
    value = clean_text(os.getenv("LLM_API_KEY"))
    if value:
        return value
    raise CaptionAssistError("Caption assist is not configured. Set LLM_API_KEY in the manager environment and restart it.")


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
    api_key = resolve_nvidia_caption_key()
    model = clean_text(os.getenv("NVIDIA_CAPTION_MODEL")) or NVIDIA_CAPTION_MODEL
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are a precise aviation photography caption editor.",
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
        "max_tokens": 9999,
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
    if re.match(r"^(loading map pins|reading aircraft yaml|reading squadron yaml|reading location photos|processing(?: .+)? photos):", text):
        return "progress"
    return "log"


def recommended_commit_scope(root: Path, changes: Dict[str, Any]) -> Dict[str, Any]:
    changed_files = git_changed_files(root)
    source_yaml = [
        path
        for path in changed_files
        if (path.startswith("aircraft/") or path.startswith("squadrons/") or path.startswith("map_pins/")) and path.endswith((".yaml", ".yml"))
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
            "squadrons/**/entry.yaml",
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
    input[type="checkbox"] {
      width: auto;
      min-height: 0;
      padding: 0;
      accent-color: var(--accent);
    }
    textarea {
      min-height: 84px;
      resize: vertical;
    }
    .caption-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 2px;
    }
    .caption-actions .subtle {
      line-height: 1.35;
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
    .quality-list {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }
    .quality-card {
      display: grid;
      grid-template-columns: minmax(120px, 0.28fr) minmax(0, 1fr);
      gap: 14px;
      width: 100%;
      padding: 12px;
      border: 1px solid color-mix(in srgb, var(--warn) 52%, var(--line));
      border-radius: 8px;
      background: #fffdf8;
      color: var(--ink);
      text-align: left;
    }
    .quality-card:hover {
      border-color: var(--warn);
    }
    .quality-card img {
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      border-radius: 6px;
      background: #d8e1e8;
    }
    .quality-card-copy {
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .quality-card-copy strong,
    .quality-card-copy span {
      overflow-wrap: anywhere;
    }
    .quality-card-copy .tag {
      width: fit-content;
    }
    .bulk-caption-list {
      display: grid;
      gap: 14px;
      margin-top: 14px;
    }
    .bulk-caption-card {
      display: grid;
      grid-template-columns: minmax(150px, 0.4fr) minmax(0, 1fr);
      gap: 14px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .bulk-caption-card img,
    .bulk-caption-card .missing {
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      border-radius: 6px;
      background: #d8e1e8;
    }
    .bulk-caption-content {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .bulk-caption-status {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .bulk-caption-status.error { color: var(--bad); }
    .bulk-caption-status.ready { color: var(--good); }
    .bulk-event-list {
      display: grid;
      gap: 14px;
      margin-top: 14px;
    }
    .bulk-event-date-card {
      display: grid;
      gap: 14px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .bulk-event-date-head {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      justify-content: space-between;
    }
    .bulk-event-date-head h3 {
      margin: 0;
      font-size: 16px;
    }
    .bulk-event-date-head p {
      margin: 3px 0 0;
    }
    .bulk-event-photos {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
      gap: 8px;
    }
    .bulk-event-photo {
      display: grid;
      gap: 5px;
      min-width: 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
    }
    .bulk-event-photo img,
    .bulk-event-photo .missing {
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      border-radius: 6px;
      background: #d8e1e8;
    }
    .bulk-event-photo span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bulk-event-more {
      display: grid;
      min-height: 72px;
      place-items: center;
      border: 1px dashed var(--line);
      border-radius: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .airshow-hero-section {
      display: grid;
      gap: 12px;
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .airshow-management-section {
      display: grid;
      gap: 12px;
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .airshow-management-section:first-of-type {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }
    .airshow-hero-list,
    .group-hero-list {
      display: grid;
      gap: 14px;
    }
    .airshow-hero-card,
    .group-hero-card {
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .airshow-hero-card h3,
    .group-hero-card h3 {
      margin: 0;
      font-size: 15px;
    }
    .airshow-hero-card.needs-hero,
    .group-hero-card.needs-hero {
      border-color: color-mix(in srgb, var(--accent) 52%, var(--line));
      background: color-mix(in srgb, var(--accent) 5%, #fff);
    }
    .airshow-hero-picker,
    .group-hero-picker {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 8px;
    }
    .airshow-hero-photo,
    .group-hero-photo {
      display: grid;
      gap: 5px;
      min-width: 0;
      padding: 5px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--muted);
      cursor: pointer;
      font-size: 11px;
      line-height: 1.25;
      text-align: left;
    }
    .airshow-hero-photo:hover,
    .airshow-hero-photo:focus-visible,
    .group-hero-photo:hover,
    .group-hero-photo:focus-visible,
    .airshow-hero-photo.selected,
    .group-hero-photo.selected {
      border-color: var(--accent);
      color: var(--ink);
    }
    .airshow-hero-photo.selected,
    .group-hero-photo.selected {
      box-shadow: 0 0 0 3px rgba(20,123,143,0.14);
    }
    .airshow-hero-photo img,
    .airshow-hero-photo .missing,
    .group-hero-photo img,
    .group-hero-photo .missing {
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      border-radius: 4px;
      background: #d8e1e8;
    }
    .airshow-hero-photo span,
    .group-hero-photo span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hero-photo-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
      gap: 10px;
      margin-top: 14px;
      max-height: 58vh;
      overflow: auto;
      padding: 2px;
    }
    .hero-photo-button {
      display: grid;
      gap: 6px;
      min-width: 0;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--muted);
      cursor: pointer;
      font-size: 11px;
      line-height: 1.25;
      text-align: left;
    }
    .hero-photo-button:hover,
    .hero-photo-button.selected {
      border-color: var(--accent);
      color: var(--ink);
    }
    .hero-photo-button.selected {
      box-shadow: 0 0 0 3px rgba(20,123,143,0.14);
    }
    .hero-photo-button img,
    .hero-photo-button .missing {
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      border-radius: 5px;
      background: #d8e1e8;
    }
    .hero-photo-button span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      .bulk-caption-card {
        grid-template-columns: 1fr;
      }
      .quality-card {
        grid-template-columns: 1fr;
      }
      .bulk-event-date-head {
        flex-direction: column;
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
        <button class="btn ghost" id="clearBuildCacheBtn" type="button">Clear build cache</button>
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
          <button class="tab" data-tab="bulk-captions" type="button">Bulk Captions</button>
          <button class="tab" data-tab="airshows" type="button">Airshows</button>
          <button class="tab" data-tab="missing" type="button">Missing</button>
          <button class="tab" data-tab="quality" type="button">Quality</button>
          <button class="tab" data-tab="entries" type="button">Entries</button>
          <button class="tab" data-tab="squadrons" type="button">Squadrons</button>
          <button class="tab" data-tab="locations" type="button">Locations</button>
          <button class="tab" data-tab="build" type="button">Build Log</button>
        </nav>

        <section class="view active" id="attachView">
          <div class="form-grid">
            <div class="field wide">
              <label for="entrySearch">Photo Source Search</label>
              <input id="entrySearch" type="search" placeholder="aircraft, unit, location, country">
            </div>
            <div class="field wide">
              <label for="entrySelect">Tag Images To</label>
              <select id="entrySelect"></select>
            </div>
            <div class="field">
              <label for="pinSelect">Location</label>
              <select id="pinSelect"></select>
            </div>
            <div class="field wide">
              <label for="airshowInput">Airshow Event (optional)</label>
              <input id="airshowInput" type="text" placeholder="Singapore Airshow 2026">
            </div>
            <div class="field wide">
              <label for="liveryInput">Livery (optional)</label>
              <input id="liveryInput" type="text" placeholder="Retro livery, Pixel Blue, special anniversary scheme">
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
              <div class="caption-actions">
                <span class="subtle">Uses the one selected image; review before attaching.</span>
                <button class="btn ghost" id="generateAttachCaptionBtn" type="button">AI Caption</button>
              </div>
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
            <h2 class="panel-title">Tagged Photos</h2>
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
              <div class="field wide">
                <label for="editTagTarget">Tag Images To</label>
                <select id="editTagTarget"></select>
                <div class="subtle">Choose an aircraft source or tag directly to a squadron-only source; photo metadata is preserved.</div>
              </div>
              <div class="field">
                <label for="editLocation">Location</label>
                <select id="editLocation"></select>
              </div>
              <div class="field wide">
                <label for="editAirshow">Airshow Event (optional)</label>
                <input id="editAirshow" type="text">
              </div>
              <div class="field wide">
                <label for="editLivery">Livery (optional)</label>
                <input id="editLivery" type="text">
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
                <div class="caption-actions">
                  <span class="subtle">Uses Nemotron 3 Omni; review before saving.</span>
                  <button class="btn ghost" id="generateEditCaptionBtn" type="button">AI Caption</button>
                </div>
              </div>
              <button class="btn secondary" id="savePhotoBtn" type="button">Save Photo</button>
            </div>
            <div>
              <div class="photo-list" id="photoList"></div>
            </div>
          </div>
        </section>

        <section class="view" id="bulk-captionsView">
          <div class="bar">
            <div>
              <h2 class="panel-title">Bulk Update Captions</h2>
              <div class="subtle" id="bulkCaptionSummary">Select existing photo assets to build a review queue.</div>
            </div>
            <div class="card-actions">
              <button class="btn ghost" id="refreshBulkCaptionsBtn" type="button">Refresh Selection</button>
              <button class="btn primary" id="runBulkCaptionsBtn" type="button">Propose Captions</button>
            </div>
          </div>
          <div class="form-grid">
            <div class="field wide">
              <label><input id="bulkExcludeAiCaptions" type="checkbox" checked> Exclude captions already assisted by AI</label>
              <div class="subtle">Only selected source images linked to an existing caption are eligible. Suggestions run one at a time with a 0.5 second pause between images.</div>
            </div>
          </div>
          <div class="bulk-caption-list" id="bulkCaptionList"></div>
        </section>

        <section class="view" id="airshowsView">
          <div class="bar">
            <div>
              <h2 class="panel-title">Airshow Manager</h2>
              <div class="subtle" id="bulkEventSummary">Set event heroes and find photos that need an event tag.</div>
            </div>
          </div>
          <section class="airshow-management-section" aria-labelledby="airshowHeroHeading">
            <div>
              <h3 class="panel-title" id="airshowHeroHeading">Event Hero Photos</h3>
              <div class="subtle" id="airshowHeroSummary">Choose one tagged photo to feature for an event on the Airshows timeline. A hero is optional.</div>
            </div>
            <div class="airshow-hero-list" id="airshowHeroList"></div>
          </section>
          <section class="airshow-management-section" aria-labelledby="airshowMissingImagesHeading">
            <div>
              <h3 class="panel-title" id="airshowMissingImagesHeading">Untagged Photos on Event Days</h3>
              <div class="subtle" id="airshowMissingImageSummary">New images are surfaced here when their capture date matches an existing event day.</div>
            </div>
            <datalist id="airshowEventOptions"></datalist>
            <div class="bulk-event-list" id="airshowMissingImageList"></div>
          </section>
          <section class="airshow-management-section" aria-labelledby="allAirshowDatesHeading">
            <div>
              <h3 class="panel-title" id="allAirshowDatesHeading">All Photo Dates</h3>
              <div class="subtle">For a new event, set or clear the event name across every source photo captured on a date.</div>
            </div>
          <div class="form-grid">
            <div class="field wide">
              <label for="bulkEventSearch">Filter dates or photos</label>
              <input id="bulkEventSearch" type="search" placeholder="date, aircraft, unit, location, event, path">
            </div>
          </div>
          <div class="bulk-event-list" id="bulkEventList"></div>
          </section>
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

        <section class="view" id="qualityView">
          <div class="bar">
            <div>
              <h2 class="panel-title">Source Image Quality</h2>
              <div class="subtle" id="qualitySummary">Checking source image dimensions.</div>
            </div>
          </div>
          <div class="subtle">Photos below 2560px wide are flagged before publishing. Conservative checks also surface possible exposure and colour-balance issues; review the image before deciding whether to replace it.</div>
          <div class="quality-list" id="qualityList"></div>
        </section>

        <section class="view" id="entriesView">
          <div class="split">
            <div class="section">
              <h2>Create Photo Source</h2>
              <div class="field">
                <label for="newEntryScope">Tag Level</label>
                <select id="newEntryScope">
                  <option value="aircraft">Aircraft</option>
                  <option value="squadron">Squadron</option>
                </select>
              </div>
              <div class="field">
                <label for="newAircraftType">Aircraft Type (Aircraft only)</label>
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
          <div class="bar">
            <div>
              <h2 class="panel-title">Location Manager</h2>
              <div class="subtle" id="locationHeroSummary">Choose a hero photo for each location.</div>
            </div>
          </div>
          <section class="airshow-management-section" aria-labelledby="locationHeroHeading">
            <div>
              <h3 class="panel-title" id="locationHeroHeading">Location Hero Photos</h3>
              <div class="subtle">Every location is listed below. Click a tagged image to make it the location hero, or use one selected raw asset.</div>
            </div>
            <div class="group-hero-list" id="locationHeroList"></div>
          </section>
          <section class="airshow-management-section" aria-labelledby="createPinHeading">
            <div>
              <h3 class="panel-title" id="createPinHeading">Create Pin</h3>
              <div class="subtle">Add a location to the map before tagging photos to it.</div>
            </div>
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
          </section>
        </section>

        <section class="view" id="squadronsView">
          <div class="bar">
            <div>
              <h2 class="panel-title">Squadron Hero Photos</h2>
              <div class="subtle" id="squadronHeroSummary">Review every squadron and select its featured image.</div>
            </div>
          </div>
          <section class="airshow-management-section" aria-labelledby="squadronHeroHeading">
            <div>
              <h3 class="panel-title" id="squadronHeroHeading">All Squadrons</h3>
              <div class="subtle">Click a tagged image to feature it on that squadron's page. A squadron may draw images from multiple aircraft entries.</div>
            </div>
            <div class="group-hero-list" id="squadronHeroList"></div>
          </section>
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
      activeTab: "attach",
      captionAssist: {
        attachAssetPath: "",
        editPhotoKey: "",
        missingPhotoKey: ""
      },
      thumbnailCacheNonce: "",
      bulkCaptions: {
        queue: null,
        results: {},
        running: false,
        excludeAi: true
      }
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
      const cache = state.thumbnailCacheNonce ? `&cache=${encodeURIComponent(state.thumbnailCacheNonce)}` : "";
      return `/api/thumb?path=${encodeURIComponent(path)}${cache}`;
    }

    function selectedEntry() {
      const value = $("entrySelect").value;
      return entryByTargetKey(value);
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
      if (entry.sourceScope === "location") {
        return `Location - ${entry.locationName} (${entry.country || "Unknown"})`;
      }
      if (entry.sourceScope === "squadron-target") {
        return `Squadron-only - ${entry.squadronName} (${entry.country || "Unknown"})`;
      }
      const prefix = entry.sourceScope === "squadron" ? "Squadron-only" : entry.aircraftType;
      return `${prefix} - ${entry.squadronName} (${entry.country || "Unknown"})`;
    }

    function entryRequestFields(entry) {
      return {
        scope: entry.sourceScope || "aircraft",
        entryPath: entry.entryPath,
        targetPinId: entry.sourceScope === "location" ? entry.pinId : ""
      };
    }

    function squadronOnlyTargets() {
      const entries = state.data?.entries || [];
      const standaloneKeys = new Set(entries
        .filter((entry) => entry.sourceScope === "squadron")
        .map((entry) => `${String(entry.country || "").trim().toLowerCase()}::${String(entry.squadronName || "").trim().toLowerCase()}`));
      return (state.data?.squadronGroups || [])
        .filter((group) => {
          const key = `${String(group.country || "").trim().toLowerCase()}::${String(group.name || "").trim().toLowerCase()}`;
          return !standaloneKeys.has(key);
        })
        .map((group) => {
          const source = entries.find((entry) => (
            entry.sourceScope !== "location"
            && String(entry.country || "").trim().toLowerCase() === String(group.country || "").trim().toLowerCase()
            && String(entry.squadronName || "").trim().toLowerCase() === String(group.name || "").trim().toLowerCase()
          ));
          return {
            targetKey: `squadron-target::${group.key}`,
            sourceScope: "squadron-target",
            entryPath: "",
            aircraftType: "",
            squadronName: group.name,
            country: group.country,
            unitType: source?.unitType || "squadron",
            squadronLogo: "",
            photoCount: 0,
            missingPhotoCount: 0,
            photos: []
          };
        });
    }

    function squadronTargetPayload(entry) {
      return {
        squadronName: entry.squadronName,
        country: entry.country,
        unitType: entry.unitType || "squadron",
        squadronLogo: entry.squadronLogo || ""
      };
    }

    function attachTargetRequestFields(entry) {
      return entry?.sourceScope === "squadron-target"
        ? {squadronTarget: squadronTargetPayload(entry)}
        : entryRequestFields(entry);
    }

    async function readApiJson(response) {
      const contentType = response.headers.get("content-type") || "";
      const raw = await response.text();
      if (!contentType.includes("application/json")) {
        throw new Error(raw.trim().slice(0, 300) || `Request failed: ${response.status}`);
      }
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`The server returned invalid JSON (${response.status}).`);
      }
    }

    async function api(path, body = null) {
      const options = body ? {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
      } : {};
      const response = await fetch(path, options);
      const payload = await readApiJson(response);
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || `Request failed: ${response.status}`);
      }
      return payload;
    }

    async function loadState(keepSelection = true) {
      const previous = keepSelection ? new Set(state.selectedAssets) : new Set();
      const response = await fetch("/api/state");
      state.data = await readApiJson(response);
      state.selectedAssets = new Set([...previous].filter((path) => state.data.assets.some((asset) => asset.path === path)));
      renderAll();
    }

    function renderAll() {
      renderStats();
      renderAssetGrid();
      renderEntryOptions();
      renderEditTagTargetOptions();
      renderPinOptions();
      renderSelectedStrip();
      renderEntryDetail();
      renderEntryCards();
      renderLocationHeroManager();
      renderSquadronHeroManager();
      renderMissingFields();
      renderQualityControl();
      renderBulkCaptions();
      renderBulkEvents();
    }

    function renderStats() {
      const project = state.data.project;
      $("projectRoot").textContent = project.root;
      $("stats").innerHTML = [
        ["Assets", project.assetCount],
        ["New", project.untaggedAssetCount],
        ["Used", project.taggedAssetCount],
        ["Aircraft", project.aircraftCount],
        ["Squadrons", project.squadronEntryCount || 0],
        ["Locations", project.locationEntryCount || 0],
        ["Pins", project.pinCount],
        ["Missing", project.missingPhotoCount],
        ["Fields", (project.missingFieldPhotoCount || 0) + (project.missingEntryFieldCount || 0)],
        ["<2560px", project.underResolutionAssetCount || 0],
        ["Exposure", project.exposureIssueAssetCount || 0],
        ["Colour", project.colourBalanceIssueAssetCount || 0]
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
        const resolutionTag = asset.isUnderResolution
          ? `<span class="tag warn">${escapeHtml(asset.dimensionsLabel)}</span>`
          : `<span>${escapeHtml(asset.dimensionsLabel)}</span>`;
        const qualityTags = (asset.qualityFlags || []).map((flag) => (
          `<span class="tag warn" title="${escapeHtml(flag.detail || "")}">${escapeHtml(flag.label || "Quality warning")}</span>`
        )).join("");
        return `
          <button class="asset-card${selected}" type="button" data-asset="${escapeHtml(asset.path)}" title="${escapeHtml(title)}">
            <img src="${thumbUrl(asset.path)}" loading="lazy" alt="${escapeHtml(asset.name)}">
            <div class="asset-name">${escapeHtml(asset.name)}</div>
            <div class="asset-meta"><span>${escapeHtml(asset.sizeLabel)}</span>${resolutionTag}${qualityTags}${tag}</div>
          </button>
        `;
      }).join("");
    }

    function renderQualityControl() {
      const assets = (state.data?.assets || []).filter((asset) => (
        asset.isPhotoSource && (asset.isUnderResolution || (asset.qualityFlags || []).length)
      ));
      const allPhotoSources = (state.data?.assets || []).filter((asset) => asset.isPhotoSource);
      const project = state.data?.project || {};
      const minimum = project.minimumSourcePhotoWidth || 2560;
      const belowMinimum = project.underResolutionAssetCount || 0;
      const exposure = project.exposureIssueAssetCount || 0;
      const colour = project.colourBalanceIssueAssetCount || 0;
      $("qualitySummary").textContent = `${assets.length} of ${allPhotoSources.length} source photograph(s) flagged: ${belowMinimum} below ${minimum}px, ${exposure} exposure, ${colour} colour balance.`;
      if (!assets.length) {
        $("qualityList").innerHTML = `<div class="empty">All source photographs meet the ${minimum}px requirement with no exposure or colour-balance warnings.</div>`;
        return;
      }
      $("qualityList").innerHTML = assets
        .sort((a, b) => (b.qualityFlags || []).length - (a.qualityFlags || []).length || a.width - b.width || a.path.localeCompare(b.path))
        .map((asset) => {
          const associations = asset.tags.length
            ? asset.tags.map((tag) => `${tag.kind}: ${tag.label || tag.path || "Source"}`).join(" · ")
            : "New raw asset";
          const warnings = [
            asset.isUnderResolution ? `${asset.dimensionsLabel} source - below ${minimum}px` : "",
            ...(asset.qualityFlags || []).map((flag) => flag.detail || flag.label || "Quality warning")
          ].filter(Boolean);
          return `
            <button class="quality-card" type="button" data-quality-asset="${escapeHtml(asset.path)}">
              <img src="${thumbUrl(asset.path)}" loading="lazy" alt="${escapeHtml(asset.name)}">
              <span class="quality-card-copy">
                <strong>${escapeHtml(asset.path)}</strong>
                ${warnings.map((warning) => `<span class="tag warn">${escapeHtml(warning)}</span>`).join("")}
                <span class="mini-meta">${escapeHtml(associations)}</span>
                <span class="mini-meta">Select to review this source in Attach.</span>
              </span>
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

    function effectiveEventDate(photo) {
      return String(photo.exifDate || photo.date || photo.year || "").trim();
    }

    function airshowEventKey(value) {
      return String(value || "").trim().toLowerCase();
    }

    function taggedAirshowGroups() {
      const byEvent = new Map();
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (photo.invalid || !String(photo.airshow || "").trim()) continue;
          const name = String(photo.airshow).trim();
          const key = airshowEventKey(name);
          if (!byEvent.has(key)) byEvent.set(key, {name, photos: []});
          byEvent.get(key).photos.push({entry, photo});
        }
      }
      return [...byEvent.values()]
        .map((event) => ({
          ...event,
          photos: event.photos.sort((a, b) => effectiveEventDate(b.photo).localeCompare(effectiveEventDate(a.photo)))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    function configuredAirshowHero(eventName) {
      const key = airshowEventKey(eventName);
      return (state.data?.airshowEvents || []).find((event) => airshowEventKey(event.name) === key)?.hero || {};
    }

    function airshowHeroMatches(hero, entry, photo) {
      if (!hero || !Object.keys(hero).length) return false;
      const reference = entryRequestFields(entry);
      return hero.scope === reference.scope
        && hero.entryPath === reference.entryPath
        && (hero.targetPinId || "") === (reference.targetPinId || "")
        && Number(hero.index) === Number(photo.index);
    }

    function renderAirshowHeroManager() {
      const events = taggedAirshowGroups();
      if (!events.length) {
        $("airshowHeroSummary").textContent = "Apply an airshow or event tag to photos before choosing an event hero.";
        $("airshowHeroList").innerHTML = `<div class="empty">Apply an airshow or event tag to photos before choosing an event hero.</div>`;
        return;
      }

      const missingHeroCount = events.filter((event) => !Object.keys(configuredAirshowHero(event.name)).length).length;
      $("airshowHeroSummary").textContent = missingHeroCount
        ? `${missingHeroCount} of ${events.length} event${events.length === 1 ? "" : "s"} need an explicit hero. Choose any tagged image to feature it on the timeline.`
        : `All ${events.length} event${events.length === 1 ? "" : "s"} have a selected hero. Choose another image below to replace one.`;

      $("airshowHeroList").innerHTML = events.map((event) => {
        const hero = configuredAirshowHero(event.name);
        const heroStatus = Object.keys(hero).length ? "Hero selected" : "No hero selected";
        const missingClass = Object.keys(hero).length ? "" : " needs-hero";
        return `
          <article class="airshow-hero-card${missingClass}">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(event.name)}</h3>
                <p class="subtle">${event.photos.length} tagged photo${event.photos.length === 1 ? "" : "s"} · ${heroStatus}</p>
              </div>
              <button class="btn ghost" type="button" data-airshow-hero-clear="${escapeHtml(event.name)}"${Object.keys(hero).length ? "" : " disabled"}>Clear Hero</button>
            </div>
            <div class="airshow-hero-picker">
              ${event.photos.map(({entry, photo}) => {
                const selected = airshowHeroMatches(hero, entry, photo) ? " selected" : "";
                const media = photo.exists && photo.sourceAssetPath
                  ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
                  : `<div class="missing">Missing source</div>`;
                const label = [entry.aircraftType || entry.locationName || "Photo", formatEventDate(effectiveEventDate(photo))].filter(Boolean).join(" - ");
                return `
                  <button class="airshow-hero-photo${selected}" type="button" data-airshow-hero-event="${escapeHtml(event.name)}" data-airshow-hero-photo="${escapeHtml(captionPhotoKey(entry, photo.index))}">
                    ${media}
                    <span>${escapeHtml(label)}</span>
                  </button>
                `;
              }).join("")}
            </div>
          </article>
        `;
      }).join("");
    }

    async function setAirshowHero(eventName, photoKey = "") {
      const event = taggedAirshowGroups().find((item) => airshowEventKey(item.name) === airshowEventKey(eventName));
      if (!event) throw new Error("This event is no longer available. Reload and try again.");
      const candidate = event.photos.find(({entry, photo}) => captionPhotoKey(entry, photo.index) === photoKey);
      if (photoKey && !candidate) throw new Error("This event photo is no longer available. Reload and try again.");
      const result = await api("/api/set-airshow-hero", {
        eventName: event.name,
        hero: candidate ? {...entryRequestFields(candidate.entry), index: candidate.photo.index} : null
      });
      toast(result.message);
      await loadState(true);
    }

    function untaggedAirshowDayGroups() {
      const eventsByDate = new Map();
      taggedAirshowGroups().forEach((event) => {
        event.photos.forEach(({photo}) => {
          const date = effectiveEventDate(photo);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
          if (!eventsByDate.has(date)) eventsByDate.set(date, new Set());
          eventsByDate.get(date).add(event.name);
        });
      });

      const missingByDate = new Map();
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          const date = effectiveEventDate(photo);
          if (photo.invalid || String(photo.airshow || "").trim() || !eventsByDate.has(date)) continue;
          if (!missingByDate.has(date)) missingByDate.set(date, []);
          missingByDate.get(date).push({entry, photo});
        }
      }

      return [...missingByDate.entries()]
        .map(([date, photos]) => ({
          date,
          photos,
          eventNames: [...(eventsByDate.get(date) || [])].sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
    }

    function missingAirshowInputValue(date) {
      const node = [...document.querySelectorAll("[data-airshow-missing-input]")]
        .find((item) => item.dataset.airshowMissingInput === date);
      return node ? node.value.trim() : "";
    }

    function renderAirshowMissingImages() {
      const events = taggedAirshowGroups();
      const groups = untaggedAirshowDayGroups();
      const photoCount = groups.reduce((total, group) => total + group.photos.length, 0);
      $("airshowEventOptions").innerHTML = events
        .map((event) => `<option value="${escapeHtml(event.name)}"></option>`)
        .join("");
      $("airshowMissingImageSummary").textContent = groups.length
        ? `${photoCount} untagged photo${photoCount === 1 ? "" : "s"} found across ${groups.length} event day${groups.length === 1 ? "" : "s"}. Apply the suggested event or choose another.`
        : "No untagged photos currently share a capture date with a tagged event.";

      if (!groups.length) {
        $("airshowMissingImageList").innerHTML = `<div class="empty">No untagged images match a known event day.</div>`;
        return;
      }

      $("airshowMissingImageList").innerHTML = groups.map((group) => {
        const suggestedEvent = group.eventNames.length === 1 ? group.eventNames[0] : "";
        const eventSummary = group.eventNames.length === 1
          ? `Suggested event: ${group.eventNames[0]}`
          : `Events on this day: ${group.eventNames.join(" / ")}`;
        const preview = group.photos.slice(0, 6).map(({entry, photo}) => {
          const media = photo.exists && photo.sourceAssetPath
            ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
            : `<div class="missing">Missing source</div>`;
          const label = [entry.aircraftType || entry.locationName || "Photo", entry.squadronName || photo.location].filter(Boolean).join(" - ");
          return `<div class="bulk-event-photo" title="${escapeHtml(`${photo.path}\n${entry.entryPath}`)}">${media}<span>${escapeHtml(label)}</span></div>`;
        }).join("");
        const remaining = group.photos.length - 6;
        return `
          <article class="bulk-event-date-card">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(formatEventDate(group.date))}</h3>
                <p class="subtle">${group.photos.length} untagged photo${group.photos.length === 1 ? "" : "s"} · ${escapeHtml(eventSummary)}</p>
              </div>
              <span class="pill">${escapeHtml(group.date)}</span>
            </div>
            <div class="form-grid">
              <div class="field wide">
                <label>Assign these images to</label>
                <input data-airshow-missing-input="${escapeHtml(group.date)}" list="airshowEventOptions" type="text" value="${escapeHtml(suggestedEvent)}" placeholder="Select or enter an airshow event">
              </div>
            </div>
            <div class="card-actions">
              <button class="btn primary" type="button" data-airshow-missing-apply="${escapeHtml(group.date)}">Add Event to ${group.photos.length}</button>
            </div>
            <div class="bulk-event-photos">
              ${preview}
              ${remaining > 0 ? `<div class="bulk-event-more">+${remaining} more</div>` : ""}
            </div>
          </article>
        `;
      }).join("");
    }

    async function applyMissingAirshowImages(date) {
      const group = untaggedAirshowDayGroups().find((item) => item.date === date);
      if (!group) throw new Error("These images are no longer available. Reload and try again.");
      const airshow = missingAirshowInputValue(date);
      if (!airshow) throw new Error("Choose or enter an airshow event before adding these images.");
      const result = await api("/api/bulk-airshow", {
        airshow,
        photos: group.photos.map(({entry, photo}) => ({
          ...entryRequestFields(entry),
          index: photo.index
        }))
      });
      toast(result.message);
      await loadState(true);
    }

    function formatEventDate(value) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return new Intl.DateTimeFormat(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric"
        }).format(new Date(`${value}T12:00:00`));
      }
      if (/^\d{4}$/.test(value)) return value;
      return "No capture date";
    }

    function bulkEventGroups() {
      const byDate = new Map();
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (photo.invalid) continue;
          const date = effectiveEventDate(photo) || "undated";
          if (!byDate.has(date)) byDate.set(date, []);
          byDate.get(date).push({entry, photo});
        }
      }
      return [...byDate.entries()]
        .map(([date, photos]) => ({date, photos}))
        .sort((a, b) => {
          if (a.date === "undated") return 1;
          if (b.date === "undated") return -1;
          return b.date.localeCompare(a.date);
        });
    }

    function bulkEventInputValue(date) {
      const node = [...document.querySelectorAll("[data-bulk-event-input]")]
        .find((item) => item.dataset.bulkEventInput === date);
      return node ? node.value.trim() : "";
    }

    function renderBulkEvents() {
      if (!state.data) return;
      renderAirshowHeroManager();
      renderAirshowMissingImages();
      const term = $("bulkEventSearch").value.trim().toLowerCase();
      const allGroups = bulkEventGroups();
      const groups = allGroups.filter((group) => {
        if (!term) return true;
        const haystack = [
          group.date,
          formatEventDate(group.date),
          ...group.photos.flatMap(({entry, photo}) => [
            entry.aircraftType,
            entry.squadronName,
            entry.country,
            entry.locationName,
            photo.path,
            photo.location,
            photo.airshow
          ])
        ].join(" ").toLowerCase();
        return haystack.includes(term);
      });
      const photoCount = allGroups.reduce((total, group) => total + group.photos.length, 0);
      $("bulkEventSummary").textContent = `${groups.length} of ${allGroups.length} date group(s), ${photoCount} photo record(s). Set an event once to update every source photo on that date.`;

      if (!groups.length) {
        $("bulkEventList").innerHTML = `<div class="empty">No photo dates match this filter.</div>`;
        return;
      }

      $("bulkEventList").innerHTML = groups.map((group) => {
        const events = [...new Set(group.photos.map(({photo}) => String(photo.airshow || "").trim()).filter(Boolean))];
        const eventValue = events.length === 1 ? events[0] : "";
        const eventSummary = events.length === 1
          ? `Current event: ${events[0]}`
          : events.length > 1
            ? `Mixed events: ${events.join(" / ")}`
            : "No event set";
        const preview = group.photos.slice(0, 6).map(({entry, photo}) => {
          const media = photo.exists && photo.sourceAssetPath
            ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
            : `<div class="missing">Missing source</div>`;
          const label = [entry.aircraftType || entry.locationName || "Photo", photo.location].filter(Boolean).join(" - ");
          return `<div class="bulk-event-photo" title="${escapeHtml(`${photo.path}\n${entry.entryPath}`)}">${media}<span>${escapeHtml(label)}</span></div>`;
        }).join("");
        const remaining = group.photos.length - 6;
        return `
          <article class="bulk-event-date-card">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(formatEventDate(group.date))}</h3>
                <p class="subtle">${group.photos.length} photo${group.photos.length === 1 ? "" : "s"} · ${escapeHtml(eventSummary)}</p>
              </div>
              <span class="pill">${escapeHtml(group.date === "undated" ? "No date" : group.date)}</span>
            </div>
            <div class="form-grid">
              <div class="field wide">
                <label>Airshow or event for this date</label>
                <input data-bulk-event-input="${escapeHtml(group.date)}" type="text" value="${escapeHtml(eventValue)}" placeholder="Singapore Airshow 2026">
              </div>
            </div>
            <div class="card-actions">
              <button class="btn secondary" type="button" data-bulk-event-apply="${escapeHtml(group.date)}">Set Event on ${group.photos.length}</button>
              <button class="btn ghost" type="button" data-bulk-event-clear="${escapeHtml(group.date)}">Clear Event</button>
            </div>
            <div class="bulk-event-photos">
              ${preview}
              ${remaining > 0 ? `<div class="bulk-event-more">+${remaining} more</div>` : ""}
            </div>
          </article>
        `;
      }).join("");
    }

    async function applyBulkEvent(date, clear = false) {
      const group = bulkEventGroups().find((item) => item.date === date);
      if (!group) throw new Error("This date group is no longer available. Reload and try again.");
      const airshow = clear ? "" : bulkEventInputValue(date);
      if (!clear && !airshow) throw new Error("Enter an airshow or event name, or use Clear Event.");
      const result = await api("/api/bulk-airshow", {
        airshow,
        photos: group.photos.map(({entry, photo}) => ({
          ...entryRequestFields(entry),
          index: photo.index
        }))
      });
      toast(result.message);
      await loadState(true);
    }

    function captionPhotoKey(entry, index) {
      return `${entry.targetKey}::${index}`;
    }

    function selectedBulkCaptionCandidates() {
      const candidates = [];
      let selectedPhotoCount = 0;
      let aiExcludedCount = 0;
      let missingCaptionCount = 0;
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (photo.invalid || !photo.exists || !photo.sourceAssetPath || !state.selectedAssets.has(photo.sourceAssetPath)) continue;
          selectedPhotoCount += 1;
          if (!String(photo.caption || "").trim()) {
            missingCaptionCount += 1;
            continue;
          }
          if (state.bulkCaptions.excludeAi && photo.captionAiAssisted) {
            aiExcludedCount += 1;
            continue;
          }
          candidates.push({
            key: captionPhotoKey(entry, photo.index),
            entry,
            photo
          });
        }
      }
      return {candidates, selectedPhotoCount, aiExcludedCount, missingCaptionCount};
    }

    function currentBulkCaptionQueue() {
      return state.bulkCaptions.queue || selectedBulkCaptionCandidates().candidates;
    }

    function resetBulkCaptionQueue() {
      if (state.bulkCaptions.running) return;
      state.bulkCaptions.queue = null;
      state.bulkCaptions.results = {};
    }

    function bulkProposalValue(key, fallback = "") {
      const node = [...document.querySelectorAll("[data-bulk-caption-key]")]
        .find((item) => item.dataset.bulkCaptionKey === key);
      return node ? node.value : fallback;
    }

    function renderBulkCaptions() {
      if (!state.data) return;
      const selection = selectedBulkCaptionCandidates();
      const queue = currentBulkCaptionQueue();
      const results = state.bulkCaptions.results;
      const usingSavedQueue = state.bulkCaptions.queue !== null;
      const selectedLabel = `${state.selectedAssets.size} selected source image(s), ${selection.candidates.length} eligible human-written caption(s)`;
      const exclusions = [
        selection.aiExcludedCount ? `${selection.aiExcludedCount} AI-assisted excluded` : "",
        selection.missingCaptionCount ? `${selection.missingCaptionCount} without a caption` : ""
      ].filter(Boolean).join("; ");
      $("bulkCaptionSummary").textContent = [
        selectedLabel,
        exclusions,
        usingSavedQueue ? `${queue.length} caption(s) in the current review queue` : ""
      ].filter(Boolean).join(". ");
      $("bulkExcludeAiCaptions").checked = state.bulkCaptions.excludeAi;
      $("refreshBulkCaptionsBtn").disabled = state.bulkCaptions.running;
      $("runBulkCaptionsBtn").disabled = state.bulkCaptions.running || !queue.length;
      $("runBulkCaptionsBtn").textContent = state.bulkCaptions.running ? "Proposing..." : "Propose Captions";

      if (!queue.length) {
        $("bulkCaptionList").innerHTML = `<div class="empty">Select one or more existing raw photo assets with human-written captions, then return here to create a review queue.</div>`;
        return;
      }

      $("bulkCaptionList").innerHTML = queue.map((candidate) => {
        const result = results[candidate.key] || {status: "ready"};
        const photo = candidate.photo;
        const media = `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`;
        const metadata = [candidate.entry.aircraftType, candidate.entry.squadronName, photo.location || photo.pinId || "No location", photo.airshow].filter(Boolean).join(" / ");
        let review = `<div class="bulk-caption-status">Ready to propose</div>`;
        if (result.status === "generating") {
          review = `<div class="bulk-caption-status">Writing a proposed caption...</div>`;
        } else if (result.status === "error") {
          review = `<div class="bulk-caption-status error">Could not propose a caption: ${escapeHtml(result.message || "Unknown error")}</div>`;
        } else if (result.status === "rejected") {
          review = `<div class="bulk-caption-status">Rejected. The original caption remains unchanged.</div>`;
        } else if (result.status === "proposed") {
          review = `
            <div class="field">
              <label>Proposed caption</label>
              <textarea data-bulk-caption-key="${escapeHtml(candidate.key)}">${escapeHtml(result.caption || "")}</textarea>
            </div>
            <div class="card-actions">
              <button class="btn secondary" type="button" data-bulk-accept="${escapeHtml(candidate.key)}">Accept Caption</button>
              <button class="btn ghost" type="button" data-bulk-reject="${escapeHtml(candidate.key)}">Reject</button>
            </div>
          `;
        }
        return `
          <article class="bulk-caption-card">
            <div>${media}</div>
            <div class="bulk-caption-content">
              <div class="mini-title">${escapeHtml(photo.path)}</div>
              <div class="mini-meta">${escapeHtml(metadata)}<br>${escapeHtml(candidate.entry.entryPath)}</div>
              <details>
                <summary class="mini-meta">Current caption</summary>
                <div class="mini-meta" style="margin-top: 6px;">${escapeHtml(photo.caption || "")}</div>
              </details>
              ${review}
            </div>
          </article>
        `;
      }).join("");
    }

    function wait(milliseconds) {
      return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    async function runBulkCaptions() {
      if (state.bulkCaptions.running) return;
      const {candidates} = selectedBulkCaptionCandidates();
      if (!candidates.length) {
        throw new Error("Select existing images with eligible human-written captions first.");
      }
      state.bulkCaptions.queue = candidates;
      state.bulkCaptions.results = {};
      state.bulkCaptions.running = true;
      renderBulkCaptions();
      try {
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          state.bulkCaptions.results[candidate.key] = {status: "generating"};
          renderBulkCaptions();
          try {
            const result = await api("/api/generate-caption", {
              ...entryRequestFields(candidate.entry),
              index: candidate.photo.index,
              draftCaption: candidate.photo.caption
            });
            state.bulkCaptions.results[candidate.key] = {status: "proposed", caption: result.caption || ""};
          } catch (error) {
            state.bulkCaptions.results[candidate.key] = {status: "error", message: error.message || "Request failed"};
          }
          renderBulkCaptions();
          if (index < candidates.length - 1) await wait(500);
        }
      } finally {
        state.bulkCaptions.running = false;
        renderBulkCaptions();
      }
    }

    async function acceptBulkCaption(key) {
      const candidate = currentBulkCaptionQueue().find((item) => item.key === key);
      const result = state.bulkCaptions.results[key];
      if (!candidate || !result || result.status !== "proposed") return;
      const caption = bulkProposalValue(key, result.caption).trim();
      if (!caption) throw new Error("A caption is required before accepting it.");
      const photo = candidate.photo;
      await api("/api/update-photo", {
        ...entryRequestFields(candidate.entry),
        index: photo.index,
        photo: {
          path: photo.path,
          location: photo.location || "",
          pin_id: photo.pinId || "",
          date: photo.date || "",
          year: photo.year || "",
          airshow: photo.airshow || "",
          title: photo.title || "",
          caption,
          captionAiAssisted: true
        }
      });
      state.bulkCaptions.queue = currentBulkCaptionQueue().filter((item) => item.key !== key);
      delete state.bulkCaptions.results[key];
      await loadState(true);
      toast("Caption accepted and marked as AI-assisted.");
    }

    function rejectBulkCaption(key) {
      const result = state.bulkCaptions.results[key];
      if (!result || result.status !== "proposed") return;
      state.bulkCaptions.results[key] = {status: "rejected"};
      renderBulkCaptions();
    }

    function renderEntryOptions() {
      const search = $("entrySearch").value.trim().toLowerCase();
      const current = $("entrySelect").value;
      const entries = [...(state.data.entries || []), ...squadronOnlyTargets()].filter((entry) => {
        if (!search) return true;
        return entryOptionLabel(entry).toLowerCase().includes(search) || String(entry.entryPath || "").toLowerCase().includes(search);
      });
      const option = (entry) => (
        `<option value="${escapeHtml(entry.targetKey)}">${escapeHtml(entryOptionLabel(entry))}</option>`
      );
      const byLabel = (left, right) => entryOptionLabel(left).localeCompare(entryOptionLabel(right));
      const aircraftEntries = entries.filter((entry) => entry.sourceScope === "aircraft").sort(byLabel);
      const squadronEntries = entries
        .filter((entry) => entry.sourceScope === "squadron" || entry.sourceScope === "squadron-target")
        .sort(byLabel);
      const locationEntries = entries.filter((entry) => entry.sourceScope === "location").sort(byLabel);
      $("entrySelect").innerHTML = [
        aircraftEntries.length ? `<optgroup label="Aircraft sources">${aircraftEntries.map(option).join("")}</optgroup>` : "",
        squadronEntries.length ? `<optgroup label="Squadron-only sources">${squadronEntries.map(option).join("")}</optgroup>` : "",
        locationEntries.length ? `<optgroup label="Location sources">${locationEntries.map(option).join("")}</optgroup>` : ""
      ].join("");
      if (entries.some((entry) => entry.targetKey === current)) {
        $("entrySelect").value = current;
      }
      renderEntryDetail();
    }

    function renderEditTagTargetOptions() {
      const current = $("editTagTarget").value;
      const targetEntries = (state.data?.entries || []).filter((entry) => (
        entry.sourceScope === "aircraft" || entry.sourceScope === "squadron"
      ));
      const squadronOnlyEntries = squadronOnlyTargets();
      const option = (entry) => (
        `<option value="${escapeHtml(entry.targetKey)}">${escapeHtml(entryOptionLabel(entry))}</option>`
      );
      const aircraftEntries = targetEntries.filter((entry) => entry.sourceScope === "aircraft");
      const squadronEntries = targetEntries.filter((entry) => entry.sourceScope === "squadron");
      $("editTagTarget").innerHTML = [
        `<option value="">Keep current photo source</option>`,
        aircraftEntries.length ? `<optgroup label="Aircraft">${aircraftEntries.map(option).join("")}</optgroup>` : "",
        squadronEntries.length ? `<optgroup label="Squadron-only sources">${squadronEntries.map(option).join("")}</optgroup>` : "",
        squadronOnlyEntries.length ? `<optgroup label="Tag directly to squadron">${squadronOnlyEntries.map(option).join("")}</optgroup>` : ""
      ].join("");
      if ([...targetEntries, ...squadronOnlyEntries].some((entry) => entry.targetKey === current)) {
        $("editTagTarget").value = current;
      }
    }

    function renderPinOptions() {
      const options = state.data.pins.map((pin) => (
        `<option value="${escapeHtml(pin.key)}">${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
      const selects = ["pinSelect", "editLocation"];
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
        $("pinSelect").disabled = false;
        $("editLocation").disabled = false;
        return;
      }
      if (entry.sourceScope === "squadron-target") {
        $("entrySummary").textContent = `Squadron-only tag: ${entry.squadronName} (${entry.country}). The manager will create or reuse squadrons/${entry.squadronName} without an aircraft type.`;
        $("pinSelect").disabled = false;
        $("editLocation").disabled = false;
        $("photoList").innerHTML = `<div class="empty">Selected raw assets will be attached to this squadron-only source.</div>`;
        return;
      }
      const isLocationSource = entry.sourceScope === "location";
      $("entrySummary").textContent = `${entry.photoCount} photo(s), ${entry.missingPhotoCount} missing source(s), ${entry.entryPath}`;
      $("pinSelect").disabled = isLocationSource;
      $("editLocation").disabled = isLocationSource;
      if (isLocationSource) {
        const sourcePin = state.data.pins.find((pin) => pin.id === entry.pinId);
        if (sourcePin) $("pinSelect").value = sourcePin.key;
      }
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
        const airshow = photo.airshow ? `<br>Airshow: ${escapeHtml(photo.airshow)}` : "";
        const livery = photo.livery ? `<br>Livery: ${escapeHtml(photo.livery)}` : "";
        return `
          <article class="photo-card">
            ${media}
            <div class="mini-title">${escapeHtml(photo.path)}</div>
            <div class="mini-meta">${escapeHtml(location)}${airshow}${livery}<br>${escapeHtml(photo.year || photo.date || "")}</div>
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
      const entries = (state.data.entries || []).filter((entry) => {
        if (!term) return true;
        return [entry.aircraftType, entry.squadronName, entry.country, entry.entryPath].join(" ").toLowerCase().includes(term);
      });
      $("entryCards").innerHTML = entries.map((entry) => `
        <article class="photo-card">
          <div class="mini-title">${escapeHtml(entryOptionLabel(entry))}</div>
          <div class="mini-meta">${escapeHtml(entry.entryPath)}</div>
          <div class="card-actions">
            <button class="btn ghost" type="button" data-open-entry="${escapeHtml(entry.targetKey)}">Open</button>
          </div>
        </article>
      `).join("") || `<div class="empty">No matching entries</div>`;
    }

    function entryByTargetKey(targetKey) {
      return (state.data?.entries || []).find((entry) => entry.targetKey === targetKey)
        || squadronOnlyTargets().find((entry) => entry.targetKey === targetKey)
        || null;
    }

    function photoReferenceByKey(key) {
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (captionPhotoKey(entry, photo.index) === key) return {entry, photo};
        }
      }
      return null;
    }

    function managerKey(value) {
      return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
    }

    function photoMatchesLocation(photo, pin) {
      const photoPinId = managerKey(photo.pinId);
      return photoPinId
        ? photoPinId === managerKey(pin.id)
        : managerKey(photo.location) === managerKey(pin.name);
    }

    function locationHeroPhotos(pin) {
      const photos = [];
      const seen = new Set();
      const addMatchingPhotos = (entry) => {
        for (const photo of entry?.photos || []) {
          if (photo.invalid || !photoMatchesLocation(photo, pin)) continue;
          const key = captionPhotoKey(entry, photo.index);
          if (seen.has(key)) continue;
          seen.add(key);
          photos.push({entry, photo});
        }
      };

      const entries = state.data?.entries || [];
      // Keep location-scoped YAML photos at the front of their own picker. This
      // makes a recently tagged pin photo available even when the location has
      // many aircraft and squadron frames associated with it.
      const locationEntries = entries.filter((entry) => (
        entry.sourceScope === "location"
        && (managerKey(entry.pinId) === managerKey(pin.id)
          || managerKey(entry.locationName) === managerKey(pin.name))
      ));
      locationEntries.forEach(addMatchingPhotos);
      entries.filter((entry) => entry.sourceScope !== "location").forEach(addMatchingPhotos);
      photos.sort((a, b) => {
        const scopeOrder = Number(a.entry.sourceScope !== "location") - Number(b.entry.sourceScope !== "location");
        return scopeOrder
          || effectiveEventDate(b.photo).localeCompare(effectiveEventDate(a.photo))
          || a.photo.path.localeCompare(b.photo.path);
      });
      const hasHeroCandidate = photos.some(({photo}) => photo.sourceAssetPath && photo.sourceAssetPath === pin.heroAssetPath);
      if (pin.heroPhoto && !hasHeroCandidate) {
        photos.unshift({
          entry: null,
          photo: {
            path: pin.heroPhoto,
            sourceAssetPath: pin.heroAssetPath,
            exists: pin.heroExists,
            customHero: true,
          },
        });
      }
      return photos;
    }

    function pinByKey(key) {
      return (state.data?.pins || []).find((pin) => pin.key === key) || null;
    }

    function squadronGroupByKey(key) {
      return (state.data?.squadronGroups || []).find((group) => group.key === key) || null;
    }

    function renderLocationHeroManager() {
      const pins = state.data?.pins || [];
      if (!pins.length) {
        $("locationHeroSummary").textContent = "Create a map pin before assigning location hero images.";
        $("locationHeroList").innerHTML = `<div class="empty">No locations are available yet.</div>`;
        return;
      }

      const missingHeroCount = pins.filter((pin) => !pin.heroPhoto).length;
      $("locationHeroSummary").textContent = missingHeroCount
        ? `${missingHeroCount} of ${pins.length} location${pins.length === 1 ? "" : "s"} need an explicit hero. Click a tagged image to set one.`
        : `All ${pins.length} location${pins.length === 1 ? "" : "s"} have a selected hero. Click another image to replace one.`;

      $("locationHeroList").innerHTML = pins.map((pin) => {
        const photos = locationHeroPhotos(pin);
        const taggedPhotoCount = photos.filter(({photo}) => !photo.customHero).length;
        const hasHero = Boolean(pin.heroPhoto);
        const coord = pin.lat === null || pin.lon === null ? "No coordinates" : `${pin.lat}, ${pin.lon}`;
        const metadata = [pin.country || "Country not set", pin.icao ? `ICAO ${pin.icao}` : "", coord].filter(Boolean).join(" · ");
        const picker = photos.length
          ? `<div class="group-hero-picker">${photos.map(({entry, photo}) => {
              const available = Boolean(photo.exists && photo.sourceAssetPath);
              const selectable = Boolean(entry && available && !photo.customHero);
              const selected = Boolean(photo.customHero || (pin.heroAssetPath && photo.sourceAssetPath === pin.heroAssetPath));
              const media = available
                ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
                : `<div class="missing">Missing source</div>`;
              const label = photo.customHero
                ? "Current custom hero"
                : [entry.aircraftType || entry.squadronName || "Location photo", photo.path, formatEventDate(effectiveEventDate(photo))].filter(Boolean).join(" - ");
              return `
                <button class="group-hero-photo${selected ? " selected" : ""}" type="button"${selectable ? ` data-location-hero-pin="${escapeHtml(pin.key)}" data-location-hero-photo="${escapeHtml(captionPhotoKey(entry, photo.index))}"` : ""} aria-pressed="${selected}"${selectable ? "" : " disabled"}>
                  ${media}
                  <span>${escapeHtml(label)}</span>
                </button>
              `;
            }).join("")}</div>`
          : `<p class="subtle">No photos are currently tagged to this location. Select one raw asset in the left panel to set a custom hero.</p>`;
        return `
          <article class="group-hero-card${hasHero ? "" : " needs-hero"}">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(pin.name)}</h3>
                <p class="subtle">${escapeHtml(metadata)} · ${taggedPhotoCount} tagged photo${taggedPhotoCount === 1 ? "" : "s"} · ${hasHero ? "Hero selected" : "No hero selected"}</p>
              </div>
              <div class="card-actions">
                <button class="btn ghost" type="button" data-location-hero-clear="${escapeHtml(pin.key)}"${hasHero ? "" : " disabled"}>Clear Hero</button>
                <button class="btn secondary" type="button" data-location-hero-asset="${escapeHtml(pin.key)}">Use Selected Raw Asset</button>
              </div>
            </div>
            ${picker}
          </article>
        `;
      }).join("");
    }

    function squadronGroupPhotos(group) {
      const photos = (group.photos || [])
        .map((reference) => {
          const entry = entryByTargetKey(reference.entryTargetKey);
          const photo = entry?.photos?.find((item) => Number(item.index) === Number(reference.index));
          return entry && photo ? {entry, photo} : null;
        })
        .filter(Boolean)
        .sort((a, b) => effectiveEventDate(b.photo).localeCompare(effectiveEventDate(a.photo)) || a.photo.path.localeCompare(b.photo.path));
      const hero = group.hero || {};
      const hasHeroCandidate = photos.some(({photo}) => photo.sourceAssetPath && photo.sourceAssetPath === hero.assetPath);
      const heroEntry = entryByTargetKey(hero.entryTargetKey);
      if (hero.sourcePath && hero.assetPath && heroEntry && !hasHeroCandidate) {
        photos.unshift({
          entry: heroEntry,
          photo: {
            path: hero.sourcePath,
            sourceAssetPath: hero.assetPath,
            exists: true,
            customHero: true,
          },
        });
      }
      return photos;
    }

    function renderSquadronHeroManager() {
      const groups = state.data?.squadronGroups || [];
      if (!groups.length) {
        $("squadronHeroSummary").textContent = "Create a squadron source before assigning a squadron hero image.";
        $("squadronHeroList").innerHTML = `<div class="empty">No squadron groups are available yet.</div>`;
        return;
      }

      const missingHeroCount = groups.filter((group) => !group.hero?.assetPath).length;
      $("squadronHeroSummary").textContent = missingHeroCount
        ? `${missingHeroCount} of ${groups.length} squadron${groups.length === 1 ? "" : "s"} need an explicit hero. Click a tagged image to set one.`
        : `All ${groups.length} squadron${groups.length === 1 ? "" : "s"} have a selected hero. Click another image to replace one.`;

      $("squadronHeroList").innerHTML = groups.map((group) => {
        const hero = group.hero || {};
        const photos = squadronGroupPhotos(group);
        const taggedPhotoCount = photos.filter(({photo}) => !photo.customHero).length;
        const hasHero = Boolean(hero.assetPath);
        const picker = photos.length
          ? `<div class="group-hero-picker">${photos.map(({entry, photo}) => {
              const available = Boolean(photo.exists && photo.sourceAssetPath);
              const selectable = Boolean(available && !photo.customHero);
              const selected = Boolean(photo.customHero || (hero.entryTargetKey === entry.targetKey && hero.assetPath === photo.sourceAssetPath));
              const media = available
                ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
                : `<div class="missing">Missing source</div>`;
              const label = photo.customHero
                ? "Current custom hero"
                : [entry.aircraftType || "Squadron image", formatEventDate(effectiveEventDate(photo))].filter(Boolean).join(" - ");
              return `
                <button class="group-hero-photo${selected ? " selected" : ""}" type="button"${selectable ? ` data-squadron-hero-group="${escapeHtml(group.key)}" data-squadron-hero-photo="${escapeHtml(captionPhotoKey(entry, photo.index))}"` : ""} aria-pressed="${selected}"${selectable ? "" : " disabled"}>
                  ${media}
                  <span>${escapeHtml(label)}</span>
                </button>
              `;
            }).join("")}</div>`
          : `<p class="subtle">No photos are tagged to this squadron yet.</p>`;
        return `
          <article class="group-hero-card${hasHero ? "" : " needs-hero"}">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(group.name)}</h3>
                <p class="subtle">${escapeHtml(group.country || "Country not set")} · ${taggedPhotoCount} tagged image${taggedPhotoCount === 1 ? "" : "s"} · ${hasHero ? "Hero selected" : "No hero selected"}</p>
              </div>
              <button class="btn ghost" type="button" data-squadron-hero-clear="${escapeHtml(group.key)}"${hasHero ? "" : " disabled"}>Clear Hero</button>
            </div>
            ${picker}
          </article>
        `;
      }).join("");
    }

    function allMissingIssues() {
      const issues = [];
      for (const entry of state.data.entries || []) {
        if (entry.entryMissingFields?.length) {
          issues.push({
            key: `entry::${entry.targetKey}`,
            type: "entry",
            entry,
            missingFields: entry.entryMissingFields,
            labels: entry.entryMissingFields.map((field) => missingFieldLabels[field] || field)
          });
        }
        for (const photo of entry.photos || []) {
          if (photo.invalid || !photo.missingFields?.length) continue;
          issues.push({
            key: `photo::${entry.targetKey}::${photo.index}`,
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
          issue.photo?.airshow,
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
              <option value="light"${issue.entry.aircraftFamily === "light" ? " selected" : ""}>Light</option>
              <option value="medium"${issue.entry.aircraftFamily === "medium" ? " selected" : ""}>Medium</option>
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
      state.captionAssist.missingPhotoKey = "";
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
          <div class="field wide">
            <label for="missingPhotoAirshow">Airshow Event (optional)</label>
            <input id="missingPhotoAirshow" type="text" value="${escapeHtml(issue.photo.airshow || "")}">
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
            <div class="caption-actions">
              <span class="subtle">Uses Nemotron 3 Omni; review before saving.</span>
              <button class="btn ghost" id="generateMissingCaptionBtn" type="button">AI Caption</button>
            </div>
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
      state.captionAssist.editPhotoKey = "";
      $("editIndex").value = String(index);
      $("editPath").value = photo.path || "";
      $("editDate").value = photo.date || "";
      $("editYear").value = photo.year || "";
      $("editAirshow").value = photo.airshow || "";
      $("editLivery").value = photo.livery || "";
      $("editCaption").value = photo.caption || "";
      $("editTagTarget").value = ["aircraft", "squadron"].includes(entry.sourceScope) ? entry.targetKey : "";
      const matchingPin = state.data.pins.find((pin) => pin.id === photo.pinId || pin.name === photo.location);
      $("editLocation").value = matchingPin ? matchingPin.key : "";
    }

    function clearEditor() {
      state.captionAssist.editPhotoKey = "";
      $("editIndex").value = "";
      $("editPath").value = "";
      $("editDate").value = "";
      $("editYear").value = "";
      $("editAirshow").value = "";
      $("editLivery").value = "";
      $("editCaption").value = "";
      $("editTagTarget").value = "";
      $("editLocation").value = "";
    }

    async function populateCaption(buttonId, targetId, payload) {
      const button = $(buttonId);
      const originalLabel = button ? button.textContent : "AI Caption";
      if (button) {
        button.disabled = true;
        button.textContent = "Writing...";
      }
      try {
        const result = await api("/api/generate-caption", payload);
        $(targetId).value = result.caption || "";
        toast(result.message || "Caption suggestion ready. Review it before saving.");
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    }

    async function generateAttachCaption() {
      const entry = selectedEntry();
      if (!entry) throw new Error("Choose an entry before generating a caption.");
      if (state.selectedAssets.size !== 1) {
        throw new Error("Select exactly one raw image to generate an attachment caption.");
      }
      const pin = selectedPin("pinSelect");
      const [assetPath] = [...state.selectedAssets];
      await populateCaption("generateAttachCaptionBtn", "captionInput", {
        ...attachTargetRequestFields(entry),
        assetPath,
        locationName: pin ? pin.name : "",
        airshow: $("airshowInput").value,
        livery: $("liveryInput").value,
        draftCaption: $("captionInput").value
      });
      state.captionAssist.attachAssetPath = assetPath;
    }

    async function generateEditedCaption() {
      const entry = selectedEntry();
      const index = $("editIndex").value;
      if (!entry || index === "") throw new Error("Choose a photo to edit before generating a caption.");
      const pin = selectedPin("editLocation");
      await populateCaption("generateEditCaptionBtn", "editCaption", {
        ...entryRequestFields(entry),
        index: Number(index),
        locationName: pin ? pin.name : "",
        airshow: $("editAirshow").value,
        livery: $("editLivery").value,
        draftCaption: $("editCaption").value
      });
      state.captionAssist.editPhotoKey = captionPhotoKey(entry, Number(index));
    }

    async function generateMissingCaption() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "photo") throw new Error("Choose a photo item before generating a caption.");
      const pin = state.data.pins.find((item) => item.key === $("missingPhotoLocation").value);
      await populateCaption("generateMissingCaptionBtn", "missingPhotoCaption", {
        ...entryRequestFields(issue.entry),
        index: issue.photo.index,
        locationName: pin ? pin.name : "",
        airshow: $("missingPhotoAirshow").value,
        draftCaption: $("missingPhotoCaption").value
      });
      state.captionAssist.missingPhotoKey = captionPhotoKey(issue.entry, issue.photo.index);
    }

    async function attachSelected() {
      const entry = selectedEntry();
      if (!entry) throw new Error("Choose an entry.");
      const pin = selectedPin("pinSelect");
      const selectedAssetPaths = [...state.selectedAssets];
      const aiCaptionAssetPath = state.captionAssist.attachAssetPath;
      if (aiCaptionAssetPath && (selectedAssetPaths.length !== 1 || selectedAssetPaths[0] !== aiCaptionAssetPath)) {
        throw new Error("The AI caption belongs to one selected image. Re-select it or generate a new caption before attaching.");
      }
      const payload = {
        ...attachTargetRequestFields(entry),
        assetPaths: selectedAssetPaths,
        locationName: pin ? pin.name : "",
        pinId: pin ? pin.id : "",
        airshow: $("airshowInput").value,
        livery: $("liveryInput").value,
        caption: $("captionInput").value,
        captionAiAssisted: Boolean(aiCaptionAssetPath),
        date: $("photoDate").value,
        year: $("photoYear").value,
        dedupe: $("dedupeSelect").value !== "allow"
      };
      const result = await api("/api/attach", payload);
      state.selectedAssets.clear();
      state.captionAssist.attachAssetPath = "";
      toast(result.message);
      await loadState(false);
    }

    async function saveEditedPhoto() {
      const entry = selectedEntry();
      const index = $("editIndex").value;
      if (!entry || index === "") throw new Error("Choose a photo to edit.");
      const pin = selectedPin("editLocation");
      const tagTarget = entryByTargetKey($("editTagTarget").value);
      const payload = {
        ...entryRequestFields(entry),
        index: Number(index),
        tagTargetEntryPath: tagTarget?.sourceScope === "squadron-target" ? "" : tagTarget?.entryPath || "",
        tagTargetScope: tagTarget?.sourceScope === "squadron-target" ? "" : tagTarget?.sourceScope || "",
        tagTargetSquadron: tagTarget?.sourceScope === "squadron-target" ? squadronTargetPayload(tagTarget) : null,
        photo: {
          path: $("editPath").value,
          location: pin ? pin.name : "",
          pin_id: pin ? pin.id : "",
          date: $("editDate").value,
          year: $("editYear").value,
          airshow: $("editAirshow").value,
          livery: $("editLivery").value,
          caption: $("editCaption").value,
          captionAiAssisted: state.captionAssist.editPhotoKey === captionPhotoKey(entry, Number(index))
        }
      };
      const result = await api("/api/update-photo", payload);
      toast(result.message);
      state.captionAssist.editPhotoKey = "";
      clearEditor();
      await loadState(true);
    }

    async function saveMissingPhoto() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "photo") throw new Error("Choose a photo item.");
      const pin = state.data.pins.find((item) => item.key === $("missingPhotoLocation").value);
      const result = await api("/api/update-photo", {
        ...entryRequestFields(issue.entry),
        index: issue.photo.index,
        photo: {
          path: $("missingPhotoPath").value,
          location: pin ? pin.name : "",
          pin_id: pin ? pin.id : "",
          date: $("missingPhotoDate").value,
          year: $("missingPhotoYear").value,
          airshow: $("missingPhotoAirshow").value,
          title: issue.photo.title || "",
          caption: $("missingPhotoCaption").value,
          captionAiAssisted: state.captionAssist.missingPhotoKey === captionPhotoKey(issue.entry, issue.photo.index)
        }
      });
      toast(result.message);
      state.captionAssist.missingPhotoKey = "";
      state.selectedIssueKey = "";
      await loadState(true);
      renderMissingFields();
    }

    async function saveMissingEntry() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "entry") throw new Error("Choose an entry item.");
      const result = await api("/api/update-entry", {
        entryPath: issue.entry.entryPath,
        scope: issue.entry.sourceScope,
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
      const result = await api("/api/delete-photo", {...entryRequestFields(entry), index});
      toast(result.message);
      clearEditor();
      await loadState(true);
    }

    async function createEntry() {
      const result = await api("/api/create-entry", {
        scope: $("newEntryScope").value,
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

    async function setLocationHero(pinKey) {
      if (state.selectedAssets.size !== 1) {
        throw new Error("Select exactly one raw asset first.");
      }
      const pin = pinByKey(pinKey);
      if (!pin) throw new Error("This location is no longer available. Reload and try again.");
      const [assetPath] = [...state.selectedAssets];
      const result = await api("/api/set-pin-hero", {
        pinPath: pin.pinPath,
        pinId: pin.id,
        assetPath
      });
      toast(result.message);
      await loadState(true);
    }

    async function setLocationHeroFromPhoto(pinKey, photoKey) {
      const pin = pinByKey(pinKey);
      const reference = photoReferenceByKey(photoKey);
      if (!pin || !reference?.photo?.sourceAssetPath) throw new Error("Choose an available location photo.");
      const result = await api("/api/set-pin-hero", {
        pinPath: pin.pinPath,
        pinId: pin.id,
        assetPath: reference.photo.sourceAssetPath
      });
      toast(result.message);
      await loadState(true);
    }

    async function clearLocationHero(pinKey) {
      const pin = pinByKey(pinKey);
      if (!pin) throw new Error("This location is no longer available. Reload and try again.");
      const result = await api("/api/set-pin-hero", {pinPath: pin.pinPath, pinId: pin.id, clear: true});
      toast(result.message);
      await loadState(true);
    }

    async function setSquadronHero(groupKey, photoKey = "") {
      const group = squadronGroupByKey(groupKey);
      if (!group) throw new Error("This squadron is no longer available. Reload and try again.");
      const reference = photoKey ? photoReferenceByKey(photoKey) : null;
      if (photoKey && !reference) throw new Error("The selected squadron photo is no longer available.");
      const result = await api("/api/set-squadron-hero", {
        squadronName: group.name,
        country: group.country,
        hero: reference ? {...entryRequestFields(reference.entry), index: reference.photo.index} : null
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

    async function clearBuildCache() {
      const button = $("clearBuildCacheBtn");
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Clearing...";
      try {
        const result = await api("/api/clear-build-cache", {});
        state.thumbnailCacheNonce = String(Date.now());
        await loadState(true);
        toast(result.message || "Build cache cleared.");
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
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
      $("bulkEventSearch").addEventListener("input", renderBulkEvents);
      $("bulkExcludeAiCaptions").addEventListener("change", (event) => {
        state.bulkCaptions.excludeAi = event.target.checked;
        resetBulkCaptionQueue();
        renderBulkCaptions();
      });
      $("entrySelect").addEventListener("change", () => {
        clearEditor();
        renderEntryDetail();
      });
      $("reloadBtn").addEventListener("click", () => loadState(true).then(() => toast("Reloaded")));
      $("clearBuildCacheBtn").addEventListener("click", () => clearBuildCache().catch((error) => toast(error.message)));
      $("clearSelectionBtn").addEventListener("click", () => {
        state.selectedAssets.clear();
        resetBulkCaptionQueue();
        renderAssetGrid();
        renderSelectedStrip();
        renderBulkCaptions();
      });
      $("clearEditorBtn").addEventListener("click", clearEditor);
      $("attachBtn").addEventListener("click", () => attachSelected().catch((error) => toast(error.message)));
      $("generateAttachCaptionBtn").addEventListener("click", () => generateAttachCaption().catch((error) => toast(error.message)));
      $("savePhotoBtn").addEventListener("click", () => saveEditedPhoto().catch((error) => toast(error.message)));
      $("generateEditCaptionBtn").addEventListener("click", () => generateEditedCaption().catch((error) => toast(error.message)));
      $("createEntryBtn").addEventListener("click", () => createEntry().catch((error) => toast(error.message)));
      $("createPinBtn").addEventListener("click", () => createPin().catch((error) => toast(error.message)));
      $("refreshBulkCaptionsBtn").addEventListener("click", () => {
        resetBulkCaptionQueue();
        renderBulkCaptions();
      });
      $("runBulkCaptionsBtn").addEventListener("click", () => runBulkCaptions().catch((error) => toast(error.message)));
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
        resetBulkCaptionQueue();
        renderAssetGrid();
        renderSelectedStrip();
        renderBulkCaptions();
      });
      $("qualityList").addEventListener("click", (event) => {
        const card = event.target.closest("[data-quality-asset]");
        if (!card) return;
        state.selectedAssets.clear();
        state.selectedAssets.add(card.dataset.qualityAsset);
        resetBulkCaptionQueue();
        setTab("attach");
        renderAssetGrid();
        renderSelectedStrip();
        renderBulkCaptions();
        toast("Selected source image for review");
      });
      $("bulkCaptionList").addEventListener("click", (event) => {
        const accept = event.target.closest("[data-bulk-accept]");
        const reject = event.target.closest("[data-bulk-reject]");
        if (accept) acceptBulkCaption(accept.dataset.bulkAccept).catch((error) => toast(error.message));
        if (reject) rejectBulkCaption(reject.dataset.bulkReject);
      });
      $("bulkEventList").addEventListener("click", (event) => {
        const apply = event.target.closest("[data-bulk-event-apply]");
        const clear = event.target.closest("[data-bulk-event-clear]");
        if (apply) applyBulkEvent(apply.dataset.bulkEventApply).catch((error) => toast(error.message));
        if (clear) applyBulkEvent(clear.dataset.bulkEventClear, true).catch((error) => toast(error.message));
      });
      $("airshowHeroList").addEventListener("click", (event) => {
        const photo = event.target.closest("[data-airshow-hero-photo]");
        const clear = event.target.closest("[data-airshow-hero-clear]");
        if (photo) setAirshowHero(photo.dataset.airshowHeroEvent, photo.dataset.airshowHeroPhoto).catch((error) => toast(error.message));
        if (clear) setAirshowHero(clear.dataset.airshowHeroClear).catch((error) => toast(error.message));
      });
      $("locationHeroList").addEventListener("click", (event) => {
        const photo = event.target.closest("[data-location-hero-photo]");
        const clear = event.target.closest("[data-location-hero-clear]");
        const asset = event.target.closest("[data-location-hero-asset]");
        if (photo) setLocationHeroFromPhoto(photo.dataset.locationHeroPin, photo.dataset.locationHeroPhoto).catch((error) => toast(error.message));
        if (clear) clearLocationHero(clear.dataset.locationHeroClear).catch((error) => toast(error.message));
        if (asset) setLocationHero(asset.dataset.locationHeroAsset).catch((error) => toast(error.message));
      });
      $("squadronHeroList").addEventListener("click", (event) => {
        const photo = event.target.closest("[data-squadron-hero-photo]");
        const clear = event.target.closest("[data-squadron-hero-clear]");
        if (photo) setSquadronHero(photo.dataset.squadronHeroGroup, photo.dataset.squadronHeroPhoto).catch((error) => toast(error.message));
        if (clear) setSquadronHero(clear.dataset.squadronHeroClear).catch((error) => toast(error.message));
      });
      $("airshowMissingImageList").addEventListener("click", (event) => {
        const apply = event.target.closest("[data-airshow-missing-apply]");
        if (apply) applyMissingAirshowImages(apply.dataset.airshowMissingApply).catch((error) => toast(error.message));
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
        if (event.target.closest("#generateMissingCaptionBtn")) {
          generateMissingCaption().catch((error) => toast(error.message));
        }
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
