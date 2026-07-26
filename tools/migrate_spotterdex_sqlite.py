#!/usr/bin/env python3
"""One-shot migration from the legacy SpotterDex YAML layout to SQLite."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import yaml

try:
    from spotterdex_db import create_database, export_snapshot, validate_database
except ImportError:  # pragma: no cover
    from tools.spotterdex_db import create_database, export_snapshot, validate_database


ROOT = Path(__file__).resolve().parents[1]
COUNTRY_CODES = {
    "Australia": "au",
    "Bermuda": "bm",
    "France": "fr",
    "Hong Kong": "hk",
    "India": "in",
    "Italy": "it",
    "Japan": "jp",
    "Korea": "kr",
    "Malaysia": "my",
    "New Zealand": "nz",
    "Singapore": "sg",
    "Thailand": "th",
    "United States": "us",
    "Vietnam": "vn",
}


def slugify(value: Any) -> str:
    normalized = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"-+", "-", re.sub(r"[^a-zA-Z0-9]+", "-", normalized)).strip("-").lower() or "item"


def unique_slug(base: str, used: set[str]) -> str:
    candidate = base
    suffix = 2
    while candidate in used:
        candidate = f"{base}-{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def load_yaml(path: Path) -> Dict[str, Any]:
    value = yaml.safe_load(path.read_text("utf-8")) or {}
    if not isinstance(value, dict):
        raise ValueError(f"Expected a YAML mapping: {path}")
    return value


def source_ref_key(value: Any) -> Tuple[str, str, str, int]:
    if not isinstance(value, dict):
        return ("", "", "", -1)
    return (
        str(value.get("scope") or ""),
        str(value.get("entryPath") or value.get("entry_path") or ""),
        str(value.get("targetPinId") or value.get("target_pin_id") or ""),
        int(value.get("index", -1)),
    )


def write_up(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def unit_name(data: Dict[str, Any], path: Path) -> str:
    nested = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
    scalar = data.get("squadron") if not isinstance(data.get("squadron"), dict) else ""
    return str(
        data.get("squadron_name")
        or data.get("squadron_full_name")
        or nested.get("name")
        or scalar
        or path.parent.name.replace("-", " ").title()
    ).strip()


def unit_kind(data: Dict[str, Any]) -> str:
    nested = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
    value = str(data.get("unit_type") or nested.get("unit_type") or "squadron").strip().lower()
    return value if value in {"squadron", "organisation"} else "squadron"


def aircraft_name(data: Dict[str, Any], path: Path) -> str:
    nested = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
    return str(
        data.get("aircraft_type")
        or data.get("aircraft_type_name")
        or data.get("type_name")
        or nested.get("name")
        or path.parent.parent.name.replace("-", " ").title()
    ).strip()


def aircraft_family(data: Dict[str, Any]) -> str:
    nested = data.get("aircraft") if isinstance(data.get("aircraft"), dict) else {}
    return str(
        data.get("aircraft_family")
        or data.get("aircraft_type_family")
        or nested.get("family")
        or "medium"
    ).strip().lower()


def normalized_logo(root: Path, raw_assets: Path, yaml_path: Path, value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    candidates = (raw_assets / text, raw_assets / yaml_path.parent.relative_to(root) / text, yaml_path.parent / text, root / text)
    for candidate in candidates:
        resolved = candidate.resolve()
        if not resolved.exists():
            continue
        try:
            return resolved.relative_to(raw_assets.resolve()).as_posix()
        except ValueError:
            return resolved.relative_to(root.resolve()).as_posix()
    return text


def photo_source_from_manifest(photo: Dict[str, Any]) -> str:
    source = str(photo.get("source") or "").replace("\\", "/")
    return source[len("raw_assets/") :] if source.startswith("raw_assets/") else source


def migration_inputs(root: Path) -> Dict[str, Any]:
    manifest_path = root / "data" / "spotterdex.json"
    if not manifest_path.exists():
        raise ValueError("Run the legacy builder first; data/spotterdex.json is required for ID/date migration.")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if int(manifest.get("schemaVersion") or 0) == 2 and isinstance(manifest.get("entities"), dict):
        manifest = {
            "photos": [
                {
                    "id": photo_id,
                    "source": photo.get("source", ""),
                    "date": photo.get("date", ""),
                    "sortDate": photo.get("sortDate", ""),
                }
                for photo_id, photo in (manifest["entities"].get("photos") or {}).items()
            ]
        }
    if not isinstance(manifest.get("photos"), list):
        raise ValueError("data/spotterdex.json does not contain usable photo records.")
    return manifest


def migrate(root: Path, database_path: Path, snapshot_path: Path, report_path: Path, *, force: bool = False) -> Dict[str, Any]:
    manifest = migration_inputs(root)
    raw_assets = root / "raw_assets"
    manifest_by_ref = {source_ref_key(photo.get("sourceRef")): photo for photo in manifest["photos"]}
    manifest_by_old_id = {str(photo.get("id")): photo for photo in manifest["photos"]}
    manifest_by_source = {photo_source_from_manifest(photo): photo for photo in manifest["photos"]}

    aircraft_files = [(path, load_yaml(path)) for path in sorted(root.glob("aircraft/*/*/entry.y*ml"))]
    squadron_files = [(path, load_yaml(path)) for path in sorted(root.glob("squadrons/*/entry.y*ml"))]
    pin_files = [(path, load_yaml(path)) for path in sorted(root.glob("map_pins/*/pins.y*ml"))]
    event_path = root / "airshows" / "events.yaml"
    configured_events = load_yaml(event_path).get("events", []) if event_path.exists() else []

    country_names = {
        str(data.get("country") or "").strip()
        for _, data in aircraft_files + squadron_files + pin_files
        if str(data.get("country") or "").strip()
    }
    missing_codes = sorted(country_names - COUNTRY_CODES.keys())
    if missing_codes:
        raise ValueError(f"Add country code mappings for: {', '.join(missing_codes)}")

    aircraft_records: Dict[str, Dict[str, Any]] = {}
    aircraft_id_by_name: Dict[str, str] = {}
    unit_sources: Dict[Tuple[str, str, str], List[Tuple[Path, Dict[str, Any]]]] = defaultdict(list)
    association_keys: set[Tuple[str, Tuple[str, str, str]]] = set()
    for path, data in aircraft_files:
        name = aircraft_name(data, path)
        aid = aircraft_id_by_name.setdefault(name, slugify(name))
        record = aircraft_records.setdefault(
            aid,
            {"name": name, "family": aircraft_family(data), "write_up": "", "legacy_ids": set()},
        )
        record["legacy_ids"].add(slugify(name))
        record["write_up"] = record["write_up"] or write_up(data.get("aircraft_write_up"), data.get("write_up"))
        country = str(data.get("country") or "").strip()
        key = (country, unit_name(data, path), unit_kind(data))
        unit_sources[key].append((path, data))
        association_keys.add((aid, key))
    for path, data in squadron_files:
        country = str(data.get("country") or "").strip()
        unit_sources[(country, unit_name(data, path), unit_kind(data))].append((path, data))

    used_unit_ids: set[str] = set()
    unit_records: Dict[str, Dict[str, Any]] = {}
    unit_id_by_key: Dict[Tuple[str, str, str], str] = {}
    for key, sources in sorted(unit_sources.items()):
        country, name, kind = key
        folder_candidates = sorted({path.parent.name for path, _ in sources}, key=lambda value: (len(value), value))
        short = folder_candidates[0] if folder_candidates else slugify(name)
        uid = unique_slug(f"{COUNTRY_CODES[country]}-{slugify(short)}", used_unit_ids)
        unit_id_by_key[key] = uid
        record = {
            "name": name,
            "country_id": COUNTRY_CODES[country],
            "kind": kind,
            "logo_source": "",
            "write_up": "",
            "hero_source": "",
        }
        for path, data in sources:
            nested = data.get("squadron") if isinstance(data.get("squadron"), dict) else {}
            logo = data.get("squadron_logo") or data.get("squadronLogo") or data.get("logo") or nested.get("logo")
            record["logo_source"] = record["logo_source"] or normalized_logo(root, raw_assets, path, logo)
            standalone = path.parts[-3] == "squadrons" if len(path.parts) >= 3 else False
            record["write_up"] = record["write_up"] or write_up(
                data.get("squadron_write_up"), data.get("write_up") if standalone else "", nested.get("write_up")
            )
            record["hero_source"] = record["hero_source"] or str(
                data.get("squadron_hero") or data.get("squadron_hero_image") or ""
            )
        unit_records[uid] = record

    locations: Dict[str, Dict[str, Any]] = {}
    location_id_by_old: Dict[str, str] = {}
    location_id_by_name: Dict[str, str] = {}
    for path, data in pin_files:
        country = str(data.get("country") or "").strip()
        code = COUNTRY_CODES[country]
        for pin in data.get("pins") or data.get("locations") or []:
            old_id = str(pin.get("id") or slugify(pin.get("name")))
            lid = f"{code}-{slugify(old_id)}"
            if lid in locations:
                lid = unique_slug(lid, set(locations))
            coordinates = pin.get("coordinates") or [pin.get("lat"), pin.get("lon")]
            icao = str(pin.get("icao") or "").strip().upper()
            if not re.fullmatch(r"[A-Z]{4}", icao):
                icao = ""
            locations[lid] = {
                "name": str(pin.get("name") or "").strip(),
                "country_id": code,
                "icao": icao,
                "latitude": float(coordinates[0]),
                "longitude": float(coordinates[1]),
                "enabled": 0 if pin.get("enabled") is False else 1,
                "write_up": write_up(pin.get("write_up"), pin.get("writeUp")),
                "hero_source": str(pin.get("hero_photo") or pin.get("hero_image") or ""),
                "hero_old_id": str(pin.get("hero_photo_id") or ""),
                "legacy_path": path.relative_to(root).as_posix(),
                "legacy_id": old_id,
            }
            location_id_by_old[old_id] = lid
            location_id_by_name[str(pin.get("name") or "").strip()] = lid

    legacy_photo_sources: List[Tuple[str, Path, int, Dict[str, Any], str]] = []
    for path, data in aircraft_files:
        for index, item in enumerate(data.get("photos") or []):
            legacy_photo_sources.append(("aircraft", path, index, item, ""))
    for path, data in squadron_files:
        for index, item in enumerate(data.get("photos") or []):
            legacy_photo_sources.append(("squadron", path, index, item, ""))
    for path, data in pin_files:
        for pin in data.get("pins") or data.get("locations") or []:
            for index, item in enumerate(pin.get("photos") or []):
                legacy_photo_sources.append(("location", path, index, item, str(pin.get("id") or "")))

    used_photo_ids: set[str] = set()
    photos: Dict[str, Dict[str, Any]] = {}
    new_photo_by_ref: Dict[Tuple[str, str, str, int], str] = {}
    new_photo_by_old_id: Dict[str, str] = {}
    new_photo_by_source_name: Dict[str, str] = {}
    pending_event_names: Dict[str, set[str]] = defaultdict(set)
    for scope, path, index, item, target_pin_id in legacy_photo_sources:
        ref = (scope, path.relative_to(root).as_posix(), target_pin_id, index)
        generated = manifest_by_ref.get(ref)
        if not generated:
            source_value = str(item.get("path") or item.get("file") or item.get("filepath") or "")
            candidates = (
                raw_assets / path.parent.relative_to(root) / source_value,
                path.parent / source_value,
                raw_assets / source_value,
            )
            resolved = next((candidate.resolve() for candidate in candidates if candidate.exists()), None)
            if resolved:
                try:
                    generated = manifest_by_source.get(resolved.relative_to(raw_assets.resolve()).as_posix())
                except ValueError:
                    generated = None
        if not generated:
            raise ValueError(f"Generated manifest has no photo for legacy source reference {ref}")
        source_path = photo_source_from_manifest(generated)
        capture_date = str(generated.get("date") or generated.get("sortDate") or "")
        date_prefix = capture_date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", capture_date) else "undated"
        photo_id = unique_slug(f"{date_prefix}-{slugify(Path(source_path).stem)}", used_photo_ids)
        location_id = location_id_by_old.get(str(generated.get("pinId") or target_pin_id or item.get("pin_id") or "")) or location_id_by_name.get(
            str(generated.get("locationName") or item.get("location") or "")
        )
        if not location_id:
            raise ValueError(f"Photo {source_path} has no canonical location")
        event_name = str(item.get("airshow") or generated.get("airshow") or "").strip()
        if event_name:
            pending_event_names[event_name].add(location_id)
        record = {
            "source_path": source_path,
            "location_id": location_id,
            "event_name": event_name,
            "date_override": str(item.get("date") or "") or None,
            "title": str(item.get("title") or ""),
            "caption": str(item.get("caption") or ""),
            "livery": str(item.get("livery") or ""),
            "caption_ai_assisted": 1 if item.get("caption_ai_assisted") else 0,
            "capture_date": capture_date,
            "subjects": [],
            "old_id": str(generated.get("id") or ""),
        }
        if scope == "aircraft":
            data = dict(aircraft_files)[path]
            aid = aircraft_id_by_name[aircraft_name(data, path)]
            key = (str(data.get("country") or "").strip(), unit_name(data, path), unit_kind(data))
            record["subjects"].append((aid, unit_id_by_key[key]))
        elif scope == "squadron":
            data = dict(squadron_files)[path]
            key = (str(data.get("country") or "").strip(), unit_name(data, path), unit_kind(data))
            record["subjects"].append((None, unit_id_by_key[key]))
        photos[photo_id] = record
        new_photo_by_ref[ref] = photo_id
        new_photo_by_old_id[record["old_id"]] = photo_id
        new_photo_by_source_name[Path(source_path).name] = photo_id

    event_config_by_name = {
        str(item.get("name") or item.get("event") or item.get("airshow") or "").strip(): item
        for item in configured_events
        if isinstance(item, dict)
    }
    event_names = sorted(set(pending_event_names) | set(event_config_by_name))
    used_event_ids: set[str] = set()
    events: Dict[str, Dict[str, Any]] = {}
    event_id_by_name: Dict[str, str] = {}
    for name in event_names:
        location_ids = pending_event_names.get(name, set())
        country_ids = {locations[lid]["country_id"] for lid in location_ids}
        prefix = next(iter(country_ids)) if len(country_ids) == 1 else "global"
        event_id = unique_slug(f"{prefix}-{slugify(name)}", used_event_ids)
        event_id_by_name[name] = event_id
        dates = sorted(
            record["capture_date"]
            for record in photos.values()
            if record["event_name"] == name and re.fullmatch(r"\d{4}-\d{2}-\d{2}", record["capture_date"])
        )
        configured = event_config_by_name.get(name, {})
        events[event_id] = {
            "name": name,
            "starts_on": dates[0] if dates else None,
            "ends_on": dates[-1] if dates else None,
            "write_up": write_up(configured.get("write_up"), configured.get("writeUp")),
            "location_ids": sorted(location_ids),
            "hero_ref": configured.get("hero_photo") or configured.get("heroPhoto") or configured.get("hero") or {},
        }
    for record in photos.values():
        record["event_id"] = event_id_by_name.get(record.pop("event_name"))

    connection = create_database(database_path, overwrite=force)
    try:
        connection.execute("BEGIN")
        connection.executemany("INSERT INTO countries(id,name) VALUES(?,?)", sorted((code, name) for name, code in COUNTRY_CODES.items() if name in country_names))
        for aid, record in sorted(aircraft_records.items()):
            connection.execute(
                "INSERT INTO aircraft(id,name,family,write_up) VALUES(?,?,?,?)",
                (aid, record["name"], record["family"], record["write_up"]),
            )
        for uid, record in sorted(unit_records.items()):
            connection.execute(
                "INSERT INTO units(id,name,country_id,kind,logo_source,write_up) VALUES(?,?,?,?,?,?)",
                (uid, record["name"], record["country_id"], record["kind"], record["logo_source"], record["write_up"]),
            )
        for lid, record in sorted(locations.items()):
            connection.execute(
                "INSERT INTO locations(id,name,country_id,icao,latitude,longitude,enabled,write_up) VALUES(?,?,?,?,?,?,?,?)",
                (lid, record["name"], record["country_id"], record["icao"], record["latitude"], record["longitude"], record["enabled"], record["write_up"]),
            )
        for eid, record in sorted(events.items()):
            connection.execute(
                "INSERT INTO events(id,name,starts_on,ends_on,write_up) VALUES(?,?,?,?,?)",
                (eid, record["name"], record["starts_on"], record["ends_on"], record["write_up"]),
            )
        connection.executemany(
            "INSERT INTO aircraft_units(aircraft_id,unit_id) VALUES(?,?)",
            sorted((aid, unit_id_by_key[key]) for aid, key in association_keys),
        )
        connection.executemany(
            "INSERT INTO event_locations(event_id,location_id) VALUES(?,?)",
            sorted((eid, lid) for eid, record in events.items() for lid in record["location_ids"]),
        )
        for pid, record in sorted(photos.items()):
            connection.execute(
                "INSERT INTO photos(id,source_path,location_id,event_id,date_override,title,caption,livery,caption_ai_assisted) VALUES(?,?,?,?,?,?,?,?,?)",
                (pid, record["source_path"], record["location_id"], record["event_id"], record["date_override"], record["title"], record["caption"], record["livery"], record["caption_ai_assisted"]),
            )
            for position, (aid, uid) in enumerate(record["subjects"]):
                connection.execute(
                    "INSERT INTO photo_subjects(photo_id,position,aircraft_id,unit_id,is_primary) VALUES(?,?,?,?,?)",
                    (pid, position, aid, uid, 1 if position == 0 else 0),
                )

        for uid, record in unit_records.items():
            hero = new_photo_by_source_name.get(Path(record["hero_source"]).name) if record["hero_source"] else None
            if hero:
                connection.execute("UPDATE units SET hero_photo_id=? WHERE id=?", (hero, uid))
        for lid, record in locations.items():
            hero = new_photo_by_old_id.get(record["hero_old_id"]) or (
                new_photo_by_source_name.get(Path(record["hero_source"]).name) if record["hero_source"] else None
            )
            if hero:
                connection.execute("UPDATE locations SET hero_photo_id=? WHERE id=?", (hero, lid))
        for eid, record in events.items():
            hero = new_photo_by_ref.get(source_ref_key(record["hero_ref"]))
            if hero:
                connection.execute("UPDATE events SET hero_photo_id=? WHERE id=?", (hero, eid))
        connection.commit()

        errors = validate_database(connection, raw_assets_dir=raw_assets)
        if errors:
            raise ValueError("Migration produced an invalid database:\n- " + "\n- ".join(errors))
        export_snapshot(connection, snapshot_path)
    finally:
        connection.close()

    report = {
        "schemaVersion": 2,
        "counts": {
            "countries": len(country_names),
            "aircraft": len(aircraft_records),
            "units": len(unit_records),
            "aircraftUnits": len(association_keys),
            "locations": len(locations),
            "events": len(events),
            "photos": len(photos),
            "heroes": sum(1 for record in unit_records.values() if record["hero_source"])
            + sum(1 for record in locations.values() if record["hero_source"] or record["hero_old_id"])
            + sum(1 for record in events.values() if record["hero_ref"]),
        },
        "ids": {
            "aircraft": {name: aid for name, aid in sorted(aircraft_id_by_name.items())},
            "units": {f"{key[0]} / {key[1]} / {key[2]}": uid for key, uid in sorted(unit_id_by_key.items())},
            "locations": dict(sorted(location_id_by_old.items())),
            "events": dict(sorted(event_id_by_name.items())),
            "photos": dict(sorted(new_photo_by_old_id.items())),
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", "utf-8")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--refresh-report-from-git",
        action="store_true",
        help="Restore the old-to-new photo ID audit from the pre-migration manifest in Git.",
    )
    return parser.parse_args()


def refresh_report_from_git(root: Path, report_path: Path) -> Dict[str, Any]:
    completed = subprocess.run(
        ["git", "show", "HEAD:data/spotterdex.json"],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError("The pre-migration manifest is not available from Git HEAD.")
    legacy = json.loads(completed.stdout)
    current = json.loads((root / "data" / "spotterdex.json").read_text("utf-8"))
    if not isinstance(legacy.get("photos"), list) or int(current.get("schemaVersion") or 0) != 2:
        raise ValueError("Expected a legacy Git manifest and a current v2 manifest.")
    current_by_source = {
        str(photo.get("source") or "").removeprefix("raw_assets/"): photo_id
        for photo_id, photo in (current.get("entities", {}).get("photos", {}) or {}).items()
    }
    mapping = {
        str(photo.get("id")): current_by_source[photo_source_from_manifest(photo)]
        for photo in legacy["photos"]
        if photo_source_from_manifest(photo) in current_by_source
    }
    if len(mapping) != len(legacy["photos"]):
        raise ValueError(f"Mapped {len(mapping)} of {len(legacy['photos'])} legacy photo IDs.")
    report = json.loads(report_path.read_text("utf-8"))
    report.setdefault("ids", {})["photos"] = dict(sorted(mapping.items()))
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", "utf-8")
    return report


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    database = (args.database or root / "content" / "spotterdex.sqlite3").resolve()
    snapshot = (args.snapshot or root / "content" / "spotterdex.sql").resolve()
    report = (args.report or root / "content" / "migration-report.json").resolve()
    if args.refresh_report_from_git:
        result = refresh_report_from_git(root, report)
        print(f"Restored {len(result['ids']['photos'])} legacy photo ID mappings in {report.relative_to(root)}")
        return 0
    result = migrate(root, database, snapshot, report, force=args.force)
    print(json.dumps(result["counts"], indent=2))
    print(f"Wrote {database.relative_to(root)}")
    print(f"Wrote {snapshot.relative_to(root)}")
    print(f"Wrote {report.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
