from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tools.spotterdex_db import (
    SCHEMA_VERSION,
    connect_database,
    create_database,
    deterministic_sql,
    export_snapshot,
    snapshot_is_current,
    validate_database,
)
from tools.spotterdex_manager import SpotterDexManager


def seed_minimal_catalog(database_path: Path) -> None:
    connection = create_database(database_path)
    try:
        connection.execute("INSERT INTO countries(id,name) VALUES('jp','Japan')")
        connection.execute(
            "INSERT INTO aircraft(id,name,family) VALUES('kawasaki-t-4','Kawasaki T-4','fighter')"
        )
        connection.execute(
            "INSERT INTO units(id,name,country_id,kind) VALUES('jp-test-unit','Test Unit','jp','squadron')"
        )
        connection.execute(
            "INSERT INTO aircraft_units(aircraft_id,unit_id) VALUES('kawasaki-t-4','jp-test-unit')"
        )
        connection.execute(
            "INSERT INTO locations(id,name,country_id,icao,latitude,longitude) "
            "VALUES('jp-test-base','Test Base','jp','RJZZ',35.0,136.0)"
        )
        connection.commit()
    finally:
        connection.close()


class DatabaseTests(unittest.TestCase):
    def test_schema_v5_adds_segment_overlay_side_and_upgrades_v4_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "catalog.sqlite3"
            seed_minimal_catalog(database)
            connection = connect_database(database)
            try:
                connection.execute(
                    "INSERT INTO events(id,name,story_mode) VALUES('fresh-airshow','Fresh Airshow','cinematic')"
                )
                connection.execute(
                    "INSERT INTO event_story_moments(id,event_id,position) "
                    "VALUES('fresh-airshow-opening','fresh-airshow',0)"
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT overlay_side FROM event_story_moments WHERE id='fresh-airshow-opening'"
                    ).fetchone()[0],
                    "left",
                )
                connection.executescript(
                    """
                    DROP TABLE event_story_photos;
                    DROP TABLE event_story_moments;
                    CREATE TABLE event_story_moments (
                        id TEXT PRIMARY KEY,
                        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                        position INTEGER NOT NULL CHECK (position >= 0),
                        label TEXT NOT NULL DEFAULT '',
                        headline TEXT NOT NULL DEFAULT '',
                        body TEXT NOT NULL DEFAULT '',
                        scroll_weight REAL NOT NULL DEFAULT 1.0 CHECK (scroll_weight BETWEEN 0.6 AND 2.5),
                        UNIQUE (event_id, position)
                    ) WITHOUT ROWID;
                    CREATE TABLE event_story_photos (
                        moment_id TEXT NOT NULL REFERENCES event_story_moments(id) ON DELETE CASCADE,
                        position INTEGER NOT NULL CHECK (position >= 0),
                        photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                        focal_x REAL NOT NULL DEFAULT 0.5 CHECK (focal_x BETWEEN 0 AND 1),
                        focal_y REAL NOT NULL DEFAULT 0.5 CHECK (focal_y BETWEEN 0 AND 1),
                        motion TEXT NOT NULL DEFAULT 'auto' CHECK (motion IN ('auto','push-left','push-right','pull-in','hold')),
                        PRIMARY KEY (moment_id, position),
                        UNIQUE (moment_id, photo_id)
                    ) WITHOUT ROWID;
                    CREATE INDEX story_moments_by_event ON event_story_moments(event_id, position);
                    CREATE INDEX story_photos_by_photo ON event_story_photos(photo_id);
                    INSERT INTO events(id,name,story_mode) VALUES('test-airshow','Test Airshow','cinematic');
                    INSERT INTO event_story_moments(id,event_id,position) VALUES
                        ('test-airshow-opening','test-airshow',0),
                        ('test-airshow-display','test-airshow',1);
                    UPDATE metadata SET value='4' WHERE key='schema_version';
                    """
                )
                connection.commit()
            finally:
                connection.close()

            upgraded = connect_database(database)
            try:
                columns = {row[1] for row in upgraded.execute("PRAGMA table_info(event_story_moments)")}
                self.assertIn("overlay_side", columns)
                self.assertEqual(
                    [
                        tuple(row)
                        for row in upgraded.execute(
                            "SELECT id,overlay_side FROM event_story_moments ORDER BY position"
                        )
                    ],
                    [
                        ("test-airshow-opening", "left"),
                        ("test-airshow-display", "right"),
                    ],
                )
                self.assertEqual(
                    upgraded.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0],
                    "5",
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    upgraded.execute(
                        "UPDATE event_story_moments SET overlay_side='center' "
                        "WHERE id='test-airshow-opening'"
                    )
            finally:
                upgraded.close()

    def test_story_segment_validation_allows_six_photos_but_not_seven(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "catalog.sqlite3"
            seed_minimal_catalog(database)
            connection = connect_database(database)
            try:
                connection.execute(
                    "INSERT INTO events(id,name,story_mode) VALUES('test-airshow','Test Airshow','cinematic')"
                )
                connection.execute(
                    "INSERT INTO event_story_moments(id,event_id,position,overlay_side) "
                    "VALUES('test-airshow-opening','test-airshow',0,'right')"
                )
                for position in range(7):
                    photo_id = f"test-frame-{position + 1}"
                    connection.execute(
                        "INSERT INTO photos(id,source_path,location_id,event_id) VALUES(?,?,?,?)",
                        (photo_id, f"frame-{position + 1}.jpg", "jp-test-base", "test-airshow"),
                    )
                    if position < 6:
                        connection.execute(
                            "INSERT INTO event_story_photos(moment_id,position,photo_id) VALUES(?,?,?)",
                            ("test-airshow-opening", position, photo_id),
                        )
                self.assertEqual(validate_database(connection), [])
                connection.execute(
                    "INSERT INTO event_story_photos(moment_id,position,photo_id) VALUES(?,?,?)",
                    ("test-airshow-opening", 6, "test-frame-7"),
                )
                self.assertEqual(validate_database(connection), [])
            finally:
                connection.close()

    def test_snapshot_is_deterministic_and_round_trips(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "catalog.sqlite3"
            snapshot = root / "catalog.sql"
            seed_minimal_catalog(database)
            connection = connect_database(database, read_only=True)
            try:
                first = deterministic_sql(connection)
                second = export_snapshot(connection, snapshot)
                self.assertEqual(first, second)
                self.assertTrue(snapshot_is_current(connection, snapshot))
            finally:
                connection.close()

            restored = sqlite3.connect(":memory:")
            restored.executescript(snapshot.read_text("utf-8"))
            self.assertEqual(
                restored.execute("SELECT id,name FROM aircraft").fetchall(),
                [("kawasaki-t-4", "Kawasaki T-4")],
            )
            self.assertEqual(
                restored.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0],
                str(SCHEMA_VERSION),
            )
            restored.close()

    def test_subject_validation_requires_one_primary_and_registered_pair(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw_assets"
            raw.mkdir()
            Image.new("RGB", (16, 16), "white").save(raw / "test.jpg")
            database = root / "catalog.sqlite3"
            seed_minimal_catalog(database)
            connection = connect_database(database)
            try:
                connection.execute(
                    "INSERT INTO photos(id,source_path,location_id,caption) "
                    "VALUES('undated-test','test.jpg','jp-test-base','Test')"
                )
                connection.execute(
                    "INSERT INTO photo_subjects(photo_id,position,aircraft_id,unit_id,is_primary) "
                    "VALUES('undated-test',0,'kawasaki-t-4','jp-test-unit',0)"
                )
                errors = validate_database(connection, raw_assets_dir=raw)
                self.assertTrue(any("primary subjects" in error for error in errors))
                connection.execute(
                    "UPDATE photo_subjects SET is_primary=1 WHERE photo_id='undated-test'"
                )
                self.assertEqual(validate_database(connection, raw_assets_dir=raw), [])
            finally:
                connection.close()

    def test_manager_transaction_refreshes_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "content").mkdir()
            raw = root / "raw_assets"
            raw.mkdir()
            Image.new("RGB", (32, 24), "navy").save(raw / "frame.jpg")
            database = root / "content" / "spotterdex.sqlite3"
            seed_minimal_catalog(database)
            connection = connect_database(database, read_only=True)
            try:
                export_snapshot(connection, root / "content" / "spotterdex.sql")
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            result = manager.append_photos(
                {
                    "scope": "aircraft",
                    "entryPath": "db:aircraft:kawasaki-t-4:jp-test-unit",
                    "assetPaths": ["frame.jpg"],
                    "pinId": "jp-test-base",
                    "caption": "Test frame",
                }
            )
            self.assertEqual(result["appended"], ["frame.jpg"])
            state = manager.get_state()
            self.assertEqual(state["project"]["databaseIntegrity"], "ok")
            self.assertTrue(state["project"]["sqlSnapshotCurrent"])
            self.assertEqual(state["aircraft"][0]["photoCount"], 1)
            self.assertNotIn("squadronLogo", state["aircraft"][0]["entryMissingFields"])
            self.assertIn("squadronLogo", state["squadrons"][0]["entryMissingFields"])
            self.assertGreaterEqual(state["project"]["missingEntryFieldCount"], 1)

            location_result = manager.update_pin(
                {
                    "locationId": "jp-test-base",
                    "name": "Renamed Test Base",
                    "country": "Japan",
                    "icao": "RJZY",
                    "lat": "35.1",
                    "lon": "136.1",
                    "enabled": "1",
                }
            )
            self.assertEqual(location_result["locationId"], "jp-test-base")
            self.assertEqual(location_result["name"], "Renamed Test Base")
            location = next(pin for pin in manager.get_state()["pins"] if pin["id"] == "jp-test-base")
            self.assertEqual(location["name"], "Renamed Test Base")
            self.assertEqual(location["icao"], "RJZY")

            rename_result = manager.update_entry(
                {
                    "entryPath": "db:aircraft:kawasaki-t-4:jp-test-unit",
                    "unitId": "jp-test-unit",
                    "scope": "aircraft",
                    "aircraftType": "Kawasaki T-4",
                    "aircraftFamily": "light",
                    "squadronName": "Renamed Test Unit",
                    "country": "Japan",
                    "unitType": "squadron",
                }
            )
            self.assertEqual(rename_result["unitId"], "jp-test-unit")
            self.assertEqual(rename_result["unitName"], "Renamed Test Unit")
            state = manager.get_state()
            self.assertEqual(
                {entry["squadronName"] for entry in state["entries"] if entry.get("unitId") == "jp-test-unit"},
                {"Renamed Test Unit"},
            )
            self.assertIn("Renamed Test Unit", (root / "content" / "spotterdex.sql").read_text("utf-8"))

            (raw / "logos").mkdir()
            Image.new("RGBA", (24, 24), "gold").save(raw / "logos" / "test-unit.png")
            logo_result = manager.update_unit_logo(
                {"unitId": "jp-test-unit", "logoSource": "logos/test-unit.png"}
            )
            self.assertIn("updated", logo_result["message"])
            state = manager.get_state()
            self.assertEqual(state["aircraft"][0]["squadronLogo"], "logos/test-unit.png")
            self.assertEqual(state["aircraft"][0]["entryMissingFields"], [])
            self.assertEqual(state["squadrons"][0]["squadronLogo"], "logos/test-unit.png")
            self.assertTrue(state["squadrons"][0]["squadronLogoExists"])
            self.assertEqual(state["squadrons"][0]["entryMissingFields"], [])
            self.assertEqual(state["squadronGroups"][0]["logo"], "logos/test-unit.png")
            self.assertTrue(state["squadronGroups"][0]["logoExists"])

            manager.update_unit_logo({"unitId": "jp-test-unit", "logoSource": ""})
            state = manager.get_state()
            self.assertEqual(state["squadrons"][0]["squadronLogo"], "")
            self.assertIn("squadronLogo", state["squadrons"][0]["entryMissingFields"])

            event_result = manager.create_event(
                {
                    "name": "Test Open Day",
                    "locationId": "jp-test-base",
                    "startsOn": "2026-05-02",
                    "endsOn": "2026-05-03",
                }
            )
            self.assertEqual(event_result["name"], "Test Open Day")
            state = manager.get_state()
            self.assertTrue(any(event["name"] == "Test Open Day" for event in state["airshowEvents"]))

            destination = manager.create_entry(
                {
                    "scope": "aircraft",
                    "aircraftType": "Kawasaki T-4",
                    "aircraftFamily": "light",
                    "squadronName": "Destination Unit",
                    "country": "Japan",
                    "unitType": "squadron",
                }
            )
            transfer = manager.delete_entry(
                {
                    "entryPath": "db:aircraft:kawasaki-t-4:jp-test-unit",
                    "mode": "transfer",
                    "destinationEntryPath": destination["entryPath"],
                }
            )
            self.assertEqual(transfer["affectedPhotos"], 1)
            state = manager.get_state()
            self.assertFalse(any(entry["targetKey"] == "db:aircraft:kawasaki-t-4:jp-test-unit" for entry in state["aircraft"]))
            self.assertTrue(any(entry["targetKey"] == destination["entryPath"] and entry["photoCount"] == 1 for entry in state["aircraft"]))

            untag = manager.delete_entry(
                {"entryPath": destination["entryPath"], "mode": "untag"}
            )
            self.assertEqual(untag["affectedPhotos"], 1)
            state = manager.get_state()
            self.assertFalse(any(entry["targetKey"] == destination["entryPath"] for entry in state["aircraft"]))
            self.assertEqual(state["masterPhotos"][0]["subjects"], [])

    def test_manager_creates_country_for_new_database_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "content").mkdir()
            (root / "raw_assets").mkdir()
            database = root / "content" / "spotterdex.sqlite3"
            seed_minimal_catalog(database)
            connection = connect_database(database, read_only=True)
            try:
                export_snapshot(connection, root / "content" / "spotterdex.sql")
            finally:
                connection.close()

    def test_manager_saves_cinematic_event_story(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "content").mkdir()
            raw = root / "raw_assets"
            raw.mkdir()
            Image.new("RGB", (48, 32), "navy").save(raw / "opening.jpg")
            Image.new("RGB", (48, 32), "silver").save(raw / "display.jpg")
            database = root / "content" / "spotterdex.sqlite3"
            seed_minimal_catalog(database)
            connection = connect_database(database, read_only=True)
            try:
                export_snapshot(connection, root / "content" / "spotterdex.sql")
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            event = manager.create_event(
                {
                    "name": "Test Flying Display",
                    "locationId": "jp-test-base",
                    "startsOn": "2026-06-01",
                    "endsOn": "2026-06-01",
                }
            )
            manager.append_photos(
                {
                    "scope": "aircraft",
                    "entryPath": "db:aircraft:kawasaki-t-4:jp-test-unit",
                    "assetPaths": ["opening.jpg", "display.jpg"],
                    "pinId": "jp-test-base",
                    "caption": "Test display frame",
                    "airshow": "Test Flying Display",
                    "date": "2026-06-01",
                }
            )
            state = manager.get_state()
            photo_ids = [
                photo["id"]
                for photo in state["masterPhotos"]
                if photo["eventId"] == event["eventId"]
            ]
            self.assertEqual(len(photo_ids), 2)

            result = manager.save_event_story(
                {
                    "eventId": event["eventId"],
                    "mode": "cinematic",
                    "moments": [
                        {
                            "label": "Opening",
                            "headline": "The flight line wakes",
                            "body": "First frames from the event.",
                            "scrollWeight": 1.5,
                            "photos": [
                                {
                                    "photoId": photo_ids[0],
                                    "focalX": 0.4,
                                    "focalY": 0.6,
                                    "motion": "push-left",
                                }
                            ],
                        },
                        {
                            "label": "Display",
                            "headline": "Kawasaki T-4",
                            "body": "The flying display begins.",
                            "scrollWeight": 1.25,
                            "photos": [
                                {
                                    "photoId": photo_ids[1],
                                    "focalX": 0.7,
                                    "focalY": 0.35,
                                    "motion": "pull-in",
                                }
                            ],
                        },
                    ],
                }
            )
            self.assertEqual(result["momentCount"], 2)
            self.assertEqual(result["segmentCount"], 2)
            story_event = next(
                item for item in manager.get_state()["airshowEvents"] if item["id"] == event["eventId"]
            )
            self.assertEqual(story_event["storyMode"], "cinematic")
            self.assertNotIn("moments", story_event["story"])
            self.assertEqual([segment["position"] for segment in story_event["story"]["segments"]], [0, 1])
            self.assertEqual(
                [segment["overlaySide"] for segment in story_event["story"]["segments"]],
                ["left", "right"],
            )
            self.assertEqual(story_event["story"]["segments"][0]["photos"][0]["focalX"], 0.4)

            with self.assertRaisesRegex(ValueError, "overlay side must be left or right"):
                manager.save_event_story(
                    {
                        "eventId": event["eventId"],
                        "mode": "cinematic",
                        "segments": [
                            {
                                "headline": "Invalid side",
                                "overlaySide": "center",
                                "photos": [{"photoId": photo_ids[0]}],
                            },
                            {
                                "headline": "Display",
                                "overlaySide": "left",
                                "photos": [{"photoId": photo_ids[1]}],
                            },
                        ],
                    }
                )

            result = manager.save_event_story(
                {
                    "eventId": event["eventId"],
                    "mode": "cinematic",
                    "segments": [
                        {
                            "headline": "Opening segment",
                            "overlaySide": "right",
                            "photos": [{"photoId": photo_ids[0]}],
                        },
                        {
                            "headline": "Display segment",
                            "overlaySide": "left",
                            "photos": [{"photoId": photo_ids[1]}],
                        },
                    ],
                }
            )
            self.assertEqual(result["segmentCount"], 2)
            story_event = next(
                item for item in manager.get_state()["airshowEvents"] if item["id"] == event["eventId"]
            )
            self.assertEqual(
                [segment["overlaySide"] for segment in story_event["story"]["segments"]],
                ["right", "left"],
            )

            connection = connect_database(database, read_only=True)
            try:
                self.assertEqual(validate_database(connection, raw_assets_dir=raw), [])
                self.assertTrue(snapshot_is_current(connection, root / "content" / "spotterdex.sql"))
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            result = manager.create_entry(
                {
                    "scope": "aircraft",
                    "aircraftType": "Chengdu J-20",
                    "aircraftFamily": "fighter",
                    "squadronName": "PLAAF Demo Unit",
                    "country": "China",
                    "unitType": "squadron",
                }
            )
            self.assertEqual(result["entryPath"], "db:aircraft:chengdu-j-20:china-plaaf-demo-unit")

            connection = connect_database(database, read_only=True)
            try:
                self.assertEqual(
                    tuple(connection.execute("SELECT id,name FROM countries WHERE name=?", ("China",)).fetchone()),
                    ("china", "China"),
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT country_id FROM units WHERE name=?",
                        ("PLAAF Demo Unit",),
                    ).fetchone()[0],
                    "china",
                )
                self.assertTrue(snapshot_is_current(connection, root / "content" / "spotterdex.sql"))
            finally:
                connection.close()

    def test_manager_accepts_six_photos_per_story_segment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "content").mkdir()
            raw = root / "raw_assets"
            raw.mkdir()
            asset_paths = [f"frame-{index}.jpg" for index in range(1, 8)]
            for asset_path in asset_paths:
                Image.new("RGB", (24, 16), "navy").save(raw / asset_path)
            database = root / "content" / "spotterdex.sqlite3"
            seed_minimal_catalog(database)
            connection = connect_database(database, read_only=True)
            try:
                export_snapshot(connection, root / "content" / "spotterdex.sql")
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            event = manager.create_event(
                {
                    "name": "Six Frame Display",
                    "locationId": "jp-test-base",
                    "startsOn": "2026-06-02",
                    "endsOn": "2026-06-02",
                }
            )
            manager.append_photos(
                {
                    "scope": "aircraft",
                    "entryPath": "db:aircraft:kawasaki-t-4:jp-test-unit",
                    "assetPaths": asset_paths,
                    "pinId": "jp-test-base",
                    "caption": "Display sequence",
                    "airshow": "Six Frame Display",
                    "date": "2026-06-02",
                }
            )
            photo_ids = [
                photo["id"]
                for photo in manager.get_state()["masterPhotos"]
                if photo["eventId"] == event["eventId"]
            ]
            self.assertEqual(len(photo_ids), 7)
            result = manager.save_event_story(
                {
                    "eventId": event["eventId"],
                    "mode": "standard",
                    "segments": [
                        {
                            "headline": "Six-frame segment",
                            "overlaySide": "left",
                            "photos": [{"photoId": photo_id} for photo_id in photo_ids[:6]],
                        }
                    ],
                }
            )
            self.assertEqual(result["segmentCount"], 1)

            result = manager.save_event_story(
                {
                    "eventId": event["eventId"],
                    "mode": "standard",
                    "segments": [
                        {
                            "headline": "Seven-frame segment",
                            "overlaySide": "left",
                            "photos": [{"photoId": photo_id} for photo_id in photo_ids],
                        }
                    ],
                }
            )
            self.assertEqual(result["segmentCount"], 1)


if __name__ == "__main__":
    unittest.main()
