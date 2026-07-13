from __future__ import annotations

import tempfile
import unittest
import random
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

from tools.spotterdex_db import connect_database, create_database, export_snapshot, snapshot_is_current
from tools.spotterdex_manager import (
    SpotterDexManager,
    add_collection_colour_analysis,
    build_quality_flags,
    compute_quality_metrics,
)


def quality_flags_for_colour(colour: tuple[int, int, int]) -> list[dict[str, str]]:
    image = Image.new("RGB", (128, 96), colour)
    metrics = compute_quality_metrics(image, image.width * image.height)
    return build_quality_flags(metrics, None)


def seed_catalog_with_photo(database_path: Path, source_path: str) -> None:
    connection = create_database(database_path)
    try:
        connection.execute("INSERT INTO countries(id,name) VALUES('jp','Japan')")
        connection.execute(
            "INSERT INTO aircraft(id,name,family) VALUES('test-aircraft','Test Aircraft','fighter')"
        )
        connection.execute(
            "INSERT INTO units(id,name,country_id,kind) VALUES('test-unit','Test Unit','jp','squadron')"
        )
        connection.execute(
            "INSERT INTO aircraft_units(aircraft_id,unit_id) VALUES('test-aircraft','test-unit')"
        )
        connection.execute(
            "INSERT INTO locations(id,name,country_id,latitude,longitude) "
            "VALUES('test-location','Test Location','jp',35.0,136.0)"
        )
        connection.execute(
            "INSERT INTO photos(id,source_path,location_id,caption) "
            "VALUES('test-photo',?,'test-location','Test')",
            (source_path,),
        )
        connection.execute(
            "INSERT INTO photo_subjects(photo_id,position,aircraft_id,unit_id,is_primary) "
            "VALUES('test-photo',0,'test-aircraft','test-unit',1)"
        )
        connection.commit()
    finally:
        connection.close()


class ColourQualityTests(unittest.TestCase):
    def test_green_and_magenta_tints_are_named(self) -> None:
        green_flags = quality_flags_for_colour((120, 140, 120))
        magenta_flags = quality_flags_for_colour((140, 115, 140))

        self.assertTrue(any(flag["short"] == "Green tint" for flag in green_flags))
        self.assertTrue(any(flag["short"] == "Pink/magenta tint" for flag in magenta_flags))

    def test_wider_low_chroma_sample_detects_wrong_white_balance(self) -> None:
        flags = quality_flags_for_colour((200, 130, 60))
        self.assertTrue(any(flag["short"] == "White balance" for flag in flags))

    def test_near_clipping_and_flat_region_noise_are_measured(self) -> None:
        clipped = Image.new("RGB", (100, 100), (128, 128, 128))
        pixels = clipped.load()
        for y in range(25):
            for x in range(100):
                pixels[x, y] = (2, 2, 2)
        metrics = compute_quality_metrics(clipped, 10000)
        flags = build_quality_flags(metrics, None)
        self.assertGreaterEqual(metrics["true_shadow_ratio"], 0.24)
        self.assertTrue(any(flag["id"] == "clipped-shadows" for flag in flags))

        random.seed(7)
        noisy = Image.new("L", (128, 128))
        noisy.putdata([random.randrange(256) for _ in range(128 * 128)])
        noisy_metrics = compute_quality_metrics(noisy.convert("RGB"), 128 * 128)
        self.assertGreater(noisy_metrics["noise_residual"], 7.0)

    def test_collection_colour_outlier_is_compared_with_average(self) -> None:
        qualities = {
            f"normal-{index}.jpg": {
                "flags": [],
                "sceneRedBlueBias": float(index % 3 - 1),
                "sceneGreenMagentaBias": float(index % 2),
            }
            for index in range(11)
        }
        qualities["outlier.jpg"] = {
            "flags": [],
            "sceneRedBlueBias": 60.0,
            "sceneGreenMagentaBias": -45.0,
        }

        add_collection_colour_analysis(qualities)

        outlier_flags = qualities["outlier.jpg"]["flags"]
        self.assertTrue(
            any(
                flag["id"] == "collection-colour-outlier" and flag["severity"] == "info"
                for flag in outlier_flags
            )
        )
        self.assertFalse(any(quality["flags"] for path, quality in qualities.items() if path != "outlier.jpg"))

    def test_collection_baseline_uses_camera_cohorts_when_available(self) -> None:
        qualities = {
            **{
                f"camera-a-{index}.jpg": {
                    "flags": [],
                    "cameraModel": "Camera A",
                    "sceneRedBlueBias": 0.0,
                    "sceneGreenMagentaBias": 0.0,
                }
                for index in range(11)
            },
            **{
                f"camera-b-{index}.jpg": {
                    "flags": [],
                    "cameraModel": "Camera B",
                    "sceneRedBlueBias": 100.0,
                    "sceneGreenMagentaBias": 100.0,
                }
                for index in range(12)
            },
        }
        qualities["camera-a-outlier.jpg"] = {
            "flags": [],
            "cameraModel": "Camera A",
            "sceneRedBlueBias": 40.0,
            "sceneGreenMagentaBias": 40.0,
        }

        add_collection_colour_analysis(qualities)

        self.assertTrue(
            any(
                flag["id"] == "collection-colour-outlier"
                for flag in qualities["camera-a-outlier.jpg"]["flags"]
            )
        )
        self.assertEqual(
            qualities["camera-b-0.jpg"]["collectionColourAverage"]["cohort"],
            "Camera B",
        )


class QualityPrefixTests(unittest.TestCase):
    def test_prefixed_image_that_now_passes_is_exposed_separately(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw_assets = root / "raw_assets"
            content = root / "content"
            raw_assets.mkdir()
            content.mkdir()
            source = raw_assets / "QC_frame.jpg"
            # Model the external edit: a previously undersized QC_ image is
            # replaced in place by a wide, well-exposed image.
            Image.new("RGB", (320, 240), (128, 128, 128)).save(source)
            passing = Image.new("RGB", (2600, 200), (90, 90, 90))
            draw = ImageDraw.Draw(passing)
            for x in range(0, 2600, 200):
                value = 180 if (x // 200) % 2 else 90
                draw.rectangle((x, 0, min(x + 100, 2599), 199), fill=(value, value, value))
            passing.save(source)
            database_path = content / "spotterdex.sqlite3"
            snapshot_path = content / "spotterdex.sql"
            seed_catalog_with_photo(database_path, "QC_frame.jpg")
            connection = connect_database(database_path, read_only=True)
            try:
                export_snapshot(connection, snapshot_path)
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            state = manager.get_state()
            asset = next(item for item in state["assets"] if item["path"] == "QC_frame.jpg")

            self.assertTrue(asset["qcPrefixApplied"])
            self.assertTrue(asset["qcPrefixPasses"])
            self.assertFalse(asset["hardQualityFailure"])
            self.assertEqual(asset["qualityFlags"], [])
            self.assertEqual(state["project"]["qcPassedAssetCount"], 1)

            result = manager.approve_passing_qc({"paths": ["QC_frame.jpg"]})

            self.assertEqual(result["approved"], [{"from": "QC_frame.jpg", "to": "frame.jpg"}])
            self.assertFalse((raw_assets / "QC_frame.jpg").exists())
            self.assertTrue((raw_assets / "frame.jpg").is_file())
            connection = connect_database(database_path, read_only=True)
            try:
                source_path = connection.execute(
                    "SELECT source_path FROM photos WHERE id='test-photo'"
                ).fetchone()[0]
                self.assertEqual(source_path, "frame.jpg")
                self.assertTrue(snapshot_is_current(connection, snapshot_path))
            finally:
                connection.close()

    def test_approve_passing_qc_skips_destination_collisions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw_assets = root / "raw_assets"
            content = root / "content"
            raw_assets.mkdir()
            content.mkdir()
            source = raw_assets / "QC_frame.jpg"
            passing = Image.new("RGB", (2600, 200), (90, 90, 90))
            draw = ImageDraw.Draw(passing)
            draw.rectangle((1300, 0, 2599, 199), fill=(180, 180, 180))
            passing.save(source)
            (raw_assets / "frame.jpg").write_bytes(b"existing destination")
            database_path = content / "spotterdex.sqlite3"
            snapshot_path = content / "spotterdex.sql"
            seed_catalog_with_photo(database_path, "QC_frame.jpg")
            connection = connect_database(database_path, read_only=True)
            try:
                export_snapshot(connection, snapshot_path)
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            result = manager.approve_passing_qc({"paths": ["QC_frame.jpg"]})

            self.assertEqual(result["approvedCount"], 0)
            self.assertEqual(result["skipped"][0]["path"], "QC_frame.jpg")
            self.assertTrue((raw_assets / "QC_frame.jpg").is_file())
            self.assertEqual((raw_assets / "frame.jpg").read_bytes(), b"existing destination")

    def test_prefix_action_renames_file_and_updates_catalog_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw_assets = root / "raw_assets"
            content = root / "content"
            raw_assets.mkdir()
            content.mkdir()
            Image.new("RGB", (320, 240), (128, 128, 128)).save(raw_assets / "frame.jpg")
            database_path = content / "spotterdex.sqlite3"
            snapshot_path = content / "spotterdex.sql"
            seed_catalog_with_photo(database_path, "frame.jpg")
            connection = connect_database(database_path, read_only=True)
            try:
                export_snapshot(connection, snapshot_path)
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            result = manager.mark_quality_failures({"paths": ["frame.jpg"]})

            self.assertEqual(result["renamed"], [{"from": "frame.jpg", "to": "QC_frame.jpg"}])
            self.assertFalse((raw_assets / "frame.jpg").exists())
            self.assertTrue((raw_assets / "QC_frame.jpg").is_file())
            connection = connect_database(database_path, read_only=True)
            try:
                source_path = connection.execute(
                    "SELECT source_path FROM photos WHERE id='test-photo'"
                ).fetchone()[0]
                self.assertEqual(source_path, "QC_frame.jpg")
                self.assertTrue(snapshot_is_current(connection, snapshot_path))
            finally:
                connection.close()

    def test_prefix_action_can_optionally_include_advisory_warnings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw_assets = root / "raw_assets"
            content = root / "content"
            raw_assets.mkdir()
            content.mkdir()
            # Wide enough to pass resolution QC, but deliberately flat so it
            # receives only the advisory low-contrast warning.
            Image.new("RGB", (2600, 200), (128, 128, 128)).save(raw_assets / "flat.jpg")
            database_path = content / "spotterdex.sqlite3"
            snapshot_path = content / "spotterdex.sql"
            seed_catalog_with_photo(database_path, "flat.jpg")
            connection = connect_database(database_path, read_only=True)
            try:
                export_snapshot(connection, snapshot_path)
            finally:
                connection.close()

            manager = SpotterDexManager(root)
            state_asset = manager.get_state()["assets"][0]
            self.assertFalse(state_asset["hardQualityFailure"])
            self.assertTrue(state_asset["needsQcWarningPrefix"])

            skipped = manager.mark_quality_failures({"paths": ["flat.jpg"]})
            self.assertEqual(skipped["renamedCount"], 0)
            result = manager.mark_quality_failures(
                {"paths": ["flat.jpg"], "includeWarnings": True}
            )

            self.assertEqual(result["renamed"], [{"from": "flat.jpg", "to": "QC_flat.jpg"}])
            self.assertTrue((raw_assets / "QC_flat.jpg").is_file())

    def test_prefix_action_rolls_back_when_snapshot_export_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw_assets = root / "raw_assets"
            content = root / "content"
            raw_assets.mkdir()
            content.mkdir()
            Image.new("RGB", (320, 240), (128, 128, 128)).save(raw_assets / "frame.jpg")
            database_path = content / "spotterdex.sqlite3"
            snapshot_path = content / "spotterdex.sql"
            seed_catalog_with_photo(database_path, "frame.jpg")
            connection = connect_database(database_path, read_only=True)
            try:
                export_snapshot(connection, snapshot_path)
            finally:
                connection.close()
            original_snapshot = snapshot_path.read_bytes()

            manager = SpotterDexManager(root)
            with patch("tools.spotterdex_manager.export_snapshot", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    manager.mark_quality_failures({"paths": ["frame.jpg"]})

            self.assertTrue((raw_assets / "frame.jpg").is_file())
            self.assertFalse((raw_assets / "QC_frame.jpg").exists())
            self.assertEqual(snapshot_path.read_bytes(), original_snapshot)
            connection = connect_database(database_path, read_only=True)
            try:
                self.assertEqual(
                    connection.execute(
                        "SELECT source_path FROM photos WHERE id='test-photo'"
                    ).fetchone()[0],
                    "frame.jpg",
                )
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
