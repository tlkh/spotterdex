from __future__ import annotations

import json
import re
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from tools import build_pages


ROOT = Path(__file__).resolve().parents[2]
PUBLIC_PAGES = tuple(build_pages.PAGE_DEFINITIONS)
CORE_PREFIX = "window.SPOTTERDEX_DATA="
EXIF_PREFIX = "window.SPOTTERDEX_EXIF="


class _ResourceParser(HTMLParser):
    """Collect local resource references from generated public pages."""

    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        for name in ("href", "src"):
            value = attributes.get(name)
            if value:
                self.references.append(value)


def _read_window_payload(path: Path, prefix: str) -> dict:
    source = path.read_text("utf-8")
    match = re.fullmatch(re.escape(prefix) + r"(.*);\n?", source, re.DOTALL)
    if not match:
        raise AssertionError(f"{path} is not a {prefix} window payload")
    value = json.loads(match.group(1))
    if not isinstance(value, dict):
        raise AssertionError(f"{path} payload is not an object")
    return value


class GeneratedCatalogIntegrityTests(unittest.TestCase):
    """The generated graph must be internally consistent before it reaches Pages."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((ROOT / "data" / "spotterdex.json").read_text("utf-8"))
        cls.core = _read_window_payload(ROOT / "data" / "spotterdex-core.js", CORE_PREFIX)
        cls.exif = _read_window_payload(ROOT / "data" / "spotterdex-exif.js", EXIF_PREFIX)
        cls.entities = cls.manifest["entities"]
        cls.indexes = cls.manifest["indexes"]

    def test_core_and_exif_bundles_match_full_manifest_identity(self) -> None:
        self.assertEqual(self.manifest["schemaVersion"], 2)
        self.assertEqual(self.manifest["generatedAt"], self.core["generatedAt"])
        self.assertEqual(self.manifest["generatedAt"], self.exif["generatedAt"])
        self.assertEqual(self.core["payload"], "core")
        self.assertEqual(self.exif["payload"], "exif")
        self.assertEqual(set(self.entities), set(self.core["entities"]))
        for entity_name in self.entities:
            self.assertEqual(
                set(self.entities[entity_name]),
                set(self.core["entities"][entity_name]),
                entity_name,
            )
        self.assertEqual(self.manifest["indexes"], self.core["indexes"])

        full_photos = self.entities["photos"]
        core_photos = self.core["entities"]["photos"]
        self.assertTrue(set(self.exif["photos"]).issubset(full_photos))
        for photo_id, photo in core_photos.items():
            self.assertNotIn("source", photo, photo_id)
            self.assertNotIn("exif", photo, photo_id)
        for photo_id, exif in self.exif["photos"].items():
            self.assertIsInstance(exif, dict, photo_id)

    def test_entity_relationships_and_derived_indexes_are_bidirectional(self) -> None:
        countries = self.entities["countries"]
        aircraft = self.entities["aircraft"]
        units = self.entities["units"]
        locations = self.entities["locations"]
        events = self.entities["events"]
        photos = self.entities["photos"]
        valid_families = {"fighter", "heavy", "helicopter", "light", "medium"}
        valid_unit_kinds = {"squadron", "organisation"}

        self.assertTrue(countries)
        self.assertTrue(aircraft)
        self.assertTrue(locations)
        for country_id, country in countries.items():
            self.assertEqual(country_id, country["id"])
            self.assertTrue(country["name"].strip())
        for aircraft_id, item in aircraft.items():
            self.assertEqual(aircraft_id, item["id"])
            self.assertIn(item["family"], valid_families, aircraft_id)
            if item.get("heroPhotoId"):
                self.assertIn(item["heroPhotoId"], photos, aircraft_id)
        for unit_id, unit in units.items():
            self.assertEqual(unit_id, unit["id"])
            self.assertIn(unit["countryId"], countries, unit_id)
            self.assertIn(unit["kind"], valid_unit_kinds, unit_id)
            if unit.get("heroPhotoId"):
                self.assertIn(unit["heroPhotoId"], photos, unit_id)
        for location_id, location in locations.items():
            self.assertEqual(location_id, location["id"])
            self.assertIn(location["countryId"], countries, location_id)
            self.assertGreaterEqual(location["lat"], -90, location_id)
            self.assertLessEqual(location["lat"], 90, location_id)
            self.assertGreaterEqual(location["lon"], -180, location_id)
            self.assertLessEqual(location["lon"], 180, location_id)
            if location.get("heroPhotoId"):
                self.assertIn(location["heroPhotoId"], photos, location_id)
                self.assertEqual(photos[location["heroPhotoId"]]["locationId"], location_id)
        for event_id, event in events.items():
            self.assertEqual(event_id, event["id"])
            for location_id in event.get("locationIds", []):
                self.assertIn(location_id, locations, event_id)
            if event.get("heroPhotoId"):
                self.assertIn(event["heroPhotoId"], photos, event_id)
                self.assertEqual(photos[event["heroPhotoId"]]["eventId"], event_id)

        photo_ids_by_aircraft = self.indexes["photoIdsByAircraft"]
        photo_ids_by_unit = self.indexes["photoIdsByUnit"]
        photo_ids_by_location = self.indexes["photoIdsByLocation"]
        photo_ids_by_event = self.indexes["photoIdsByEvent"]
        unit_ids_by_aircraft = self.indexes["unitIdsByAircraft"]
        for aircraft_id, unit_ids in unit_ids_by_aircraft.items():
            self.assertIn(aircraft_id, aircraft)
            self.assertEqual(len(unit_ids), len(set(unit_ids)), aircraft_id)
            for unit_id in unit_ids:
                self.assertIn(unit_id, units, aircraft_id)

        expected_aircraft: dict[str, set[str]] = {key: set() for key in aircraft}
        expected_units: dict[str, set[str]] = {key: set() for key in units}
        expected_locations: dict[str, set[str]] = {key: set() for key in locations}
        expected_events: dict[str, set[str]] = {key: set() for key in events}
        for photo_id, photo in photos.items():
            location_id = photo["locationId"]
            self.assertIn(location_id, locations, photo_id)
            expected_locations[location_id].add(photo_id)
            event_id = photo.get("eventId") or ""
            if event_id:
                self.assertIn(event_id, events, photo_id)
                expected_events[event_id].add(photo_id)
            self.assertTrue(photo.get("sortDate"), photo_id)
            self.assertTrue(re.fullmatch(r"\d{4}(?:-\d{2}-\d{2})?", photo["sortDate"]), photo_id)
            self.assertTrue((ROOT / photo["image"]).is_file(), photo_id)
            self.assertTrue((ROOT / photo["thumbnail"]).is_file(), photo_id)
            subjects = photo.get("subjects", [])
            self.assertLessEqual(sum(bool(subject.get("primary")) for subject in subjects), 1, photo_id)
            for subject in subjects:
                aircraft_id = subject.get("aircraftId")
                unit_id = subject.get("unitId")
                self.assertTrue(aircraft_id or unit_id, photo_id)
                if aircraft_id:
                    self.assertIn(aircraft_id, aircraft, photo_id)
                    expected_aircraft[aircraft_id].add(photo_id)
                if unit_id:
                    self.assertIn(unit_id, units, photo_id)
                    expected_units[unit_id].add(photo_id)
                if aircraft_id and unit_id:
                    self.assertIn(unit_id, unit_ids_by_aircraft[aircraft_id], photo_id)

        self.assertEqual(
            {key: set(value) for key, value in photo_ids_by_aircraft.items()},
            expected_aircraft,
        )
        self.assertEqual(
            {key: set(value) for key, value in photo_ids_by_unit.items()},
            expected_units,
        )
        self.assertEqual(
            {key: set(value) for key, value in photo_ids_by_location.items()},
            expected_locations,
        )
        self.assertEqual(
            {key: set(value) for key, value in photo_ids_by_event.items()},
            expected_events,
        )
        for index_name, index in self.indexes.items():
            if not index_name.startswith("photoIdsBy"):
                continue
            for key, photo_ids in index.items():
                self.assertEqual(len(photo_ids), len(set(photo_ids)), f"{index_name}:{key}")
                for photo_id in photo_ids:
                    self.assertIn(photo_id, photos, f"{index_name}:{key}")


class GeneratedPublicAssetTests(unittest.TestCase):
    def test_every_public_page_local_reference_exists(self) -> None:
        for filename in PUBLIC_PAGES:
            parser = _ResourceParser()
            parser.feed((ROOT / filename).read_text("utf-8"))
            for reference in parser.references:
                parsed = urlsplit(reference)
                if parsed.scheme or parsed.netloc or reference.startswith(("#", "data:")):
                    continue
                relative = parsed.path.lstrip("/")
                if relative.startswith("./"):
                    relative = relative[2:]
                self.assertTrue(relative, f"empty resource in {filename}")
                self.assertTrue((ROOT / relative).is_file(), f"{filename} -> {reference}")

    def test_manifest_icons_and_sitemap_targets_exist(self) -> None:
        web_manifest = json.loads((ROOT / "manifest.webmanifest").read_text("utf-8"))
        for icon in web_manifest["icons"]:
            self.assertTrue((ROOT / icon["src"]).is_file(), icon["src"])
        for shortcut in web_manifest.get("shortcuts", []):
            target = shortcut["url"].lstrip("./")
            self.assertTrue((ROOT / target).is_file(), shortcut["url"])
        self.assertTrue((ROOT / web_manifest["start_url"].lstrip("./")).is_file())
        sitemap = ET.parse(ROOT / "sitemap.xml")
        namespace = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        locations = [node.text or "" for node in sitemap.findall("sm:url/sm:loc", namespace)]
        self.assertGreater(len(locations), len(PUBLIC_PAGES))
        site_prefix = "https://tlkh.github.io/spotterdex/"
        for location in locations:
            self.assertTrue(location.startswith(site_prefix), location)
            relative = location[len(site_prefix):]
            target = ROOT / relative
            if not relative or relative.endswith("/"):
                target = target / "index.html"
            self.assertTrue(target.is_file(), location)

        robots = (ROOT / "robots.txt").read_text("utf-8")
        self.assertIn("Sitemap: https://tlkh.github.io/spotterdex/sitemap.xml", robots)

    def test_generated_pages_still_match_the_page_builder(self) -> None:
        for filename in PUBLIC_PAGES:
            self.assertEqual(
                (ROOT / filename).read_text("utf-8"),
                build_pages.render_page(filename, ROOT),
                filename,
            )
