from __future__ import annotations

import unittest

from tools.build_spotterdex import normalized_core_manifest, normalized_v2_manifest


class AirshowStoryBuildTests(unittest.TestCase):
    def test_cinematic_story_is_normalized_into_core_manifest(self) -> None:
        manifest = normalized_v2_manifest(
            generated_at="2026-07-19T00:00:00+00:00",
            countries=[{"id": "jp", "name": "Japan"}],
            aircraft_rows=[],
            unit_rows=[],
            location_rows=[
                {
                    "id": "jp-test-base",
                    "name": "Test Base",
                    "country_id": "jp",
                    "icao": "RJZZ",
                    "latitude": 35.0,
                    "longitude": 136.0,
                    "enabled": 1,
                    "hero_photo_id": None,
                    "write_up": "",
                }
            ],
            event_rows=[
                {
                    "id": "jp-test-display",
                    "name": "Test Display",
                    "starts_on": "2026-06-01",
                    "ends_on": "2026-06-01",
                    "hero_photo_id": "test-frame",
                    "story_mode": "cinematic",
                    "write_up": "",
                }
            ],
            aircraft_units=[],
            event_locations=[{"event_id": "jp-test-display", "location_id": "jp-test-base"}],
            story_moment_rows=[
                {
                    "id": "jp-test-display-opening",
                    "event_id": "jp-test-display",
                    "position": 0,
                    "label": "08:30",
                    "headline": "Opening pass",
                    "body": "The display begins.",
                    "overlay_side": "right",
                    "scroll_weight": 1.4,
                }
            ],
            story_photo_rows=[
                {
                    "moment_id": "jp-test-display-opening",
                    "position": 0,
                    "photo_id": "test-frame",
                    "focal_x": 0.7,
                    "focal_y": 0.35,
                    "motion": "push-left",
                },
                {
                    "moment_id": "jp-test-display-opening",
                    "position": 1,
                    "photo_id": "supporting-frame",
                    "focal_x": 0.5,
                    "focal_y": 0.5,
                    "motion": "hold",
                }
            ],
            photos=[
                {
                    "id": "test-frame",
                    "pinId": "jp-test-base",
                    "airshow": "Test Display",
                    "subjects": [],
                    "year": "2026",
                    "date": "2026-06-01",
                    "sortDate": "2026-06-01",
                    "image": "assets/generated/photos/test-frame.jpg",
                    "thumbnail": "assets/generated/thumbnails/test-frame.jpg",
                    "exif": {"DateTimeOriginal": "2026:06:01 08:30:00"},
                },
                {
                    "id": "supporting-frame",
                    "pinId": "jp-test-base",
                    "airshow": "Test Display",
                    "subjects": [],
                    "year": "2026",
                    "date": "2026-06-01",
                    "sortDate": "2026-06-01",
                    "image": "assets/generated/photos/supporting-frame.jpg",
                    "thumbnail": "assets/generated/thumbnails/supporting-frame.jpg",
                    "exif": {"DateTimeOriginal": "2026:06:01 08:35:00"},
                }
            ],
            logo_by_unit={},
            indexes={
                "photoIdsByAircraft": {},
                "photoIdsByUnit": {},
                "photoIdsByLocation": {"jp-test-base": ["test-frame", "supporting-frame"]},
                "photoIdsByEvent": {"jp-test-display": ["test-frame", "supporting-frame"]},
                "unitIdsByAircraft": {},
            },
        )

        event = manifest["entities"]["events"]["jp-test-display"]
        self.assertEqual(event["story"]["mode"], "cinematic")
        self.assertNotIn("moments", event["story"])
        self.assertEqual(event["story"]["segments"][0]["overlaySide"], "right")
        self.assertEqual(
            [photo["photoId"] for photo in event["story"]["segments"][0]["photos"]],
            ["test-frame", "supporting-frame"],
        )
        self.assertEqual(event["story"]["segments"][0]["photos"][0]["focalX"], 0.7)

        core = normalized_core_manifest(manifest)
        self.assertIn("story", core["entities"]["events"]["jp-test-display"])
        self.assertNotIn("exif", core["entities"]["photos"]["test-frame"])


if __name__ == "__main__":
    unittest.main()
