from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tools.spotterdex_manager import RevisionConflictError, SpotterDexManager
from tools.tests.test_spotterdex_db import seed_catalog_photo


class ManagerRevisionTests(unittest.TestCase):
    def test_same_photo_stale_revision_is_rejected_and_fresh_revision_is_returned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed_catalog_photo(root)
            manager = SpotterDexManager(root)
            revision = manager.get_revision({"resource": "photo:test-photo"})["revision"]
            saved = manager.update_master_photo(
                {
                    "photoId": "test-photo",
                    "expectedRevision": revision,
                    "photo": {"caption": "first save"},
                }
            )
            next_revision = saved["revisions"]["photo:test-photo"]
            self.assertNotEqual(revision, next_revision)
            with self.assertRaises(RevisionConflictError) as raised:
                manager.update_master_photo(
                    {
                        "photoId": "test-photo",
                        "expectedRevision": revision,
                        "photo": {"caption": "stale save"},
                    }
                )
            self.assertEqual(raised.exception.resource, "photo:test-photo")
            self.assertEqual(raised.exception.current, next_revision)

    def test_unrelated_photo_can_save_with_its_own_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed_catalog_photo(root)
            manager = SpotterDexManager(root)
            revision = manager.get_revision({"resource": "writeup:aircraft:kawasaki-t-4"})["revision"]
            manager.update_master_photo({"photoId": "test-photo", "photo": {"caption": "photo save"}})
            result = manager.update_write_up(
                {
                    "entityType": "aircraft",
                    "entityId": "kawasaki-t-4",
                    "expectedRevision": revision,
                    "writeUp": "Updated independently",
                }
            )
            self.assertIn("writeup:aircraft:kawasaki-t-4", result["revisions"])

    def test_bulk_update_checks_each_photo_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed_catalog_photo(root)
            manager = SpotterDexManager(root)
            revision = manager.get_revision({"resource": "photo:test-photo"})["revision"]
            manager.update_master_photo({"photoId": "test-photo", "photo": {"caption": "changed"}})
            with self.assertRaises(RevisionConflictError):
                manager.bulk_update_photos(
                    {
                        "photos": [{"photoId": "test-photo"}],
                        "fields": {"caption": "bulk"},
                        "expectedRevisions": {"photo:test-photo": revision},
                    }
                )

    def test_master_photo_subjects_validate_pairs_primary_and_location_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed_catalog_photo(root)
            manager = SpotterDexManager(root)
            valid_subject = {"aircraftId": "kawasaki-t-4", "unitId": "jp-test-unit", "isPrimary": True}
            manager.update_master_photo({"photoId": "test-photo", "photo": {"subjects": [valid_subject]}})
            with self.assertRaisesRegex(ValueError, "exactly one primary"):
                manager.update_master_photo(
                    {
                        "photoId": "test-photo",
                        "photo": {
                            "subjects": [
                                {"aircraftId": "kawasaki-t-4", "unitId": "jp-test-unit", "isPrimary": False}
                            ]
                        },
                    }
                )
            self.assertEqual(len(manager.get_state()["masterPhotos"][0]["subjects"]), 1)
            with self.assertRaisesRegex(ValueError, "not registered"):
                manager.update_master_photo(
                    {
                        "photoId": "test-photo",
                        "photo": {
                            "subjects": [
                                {"aircraftId": "kawasaki-t-4", "unitId": "missing-unit", "isPrimary": True}
                            ]
                        },
                    }
                )
            self.assertEqual(manager.get_state()["masterPhotos"][0]["subjects"][0]["unitId"], "jp-test-unit")
            manager.update_master_photo({"photoId": "test-photo", "photo": {"subjects": []}})
            self.assertEqual(manager.get_state()["masterPhotos"][0]["subjects"], [])


if __name__ == "__main__":
    unittest.main()
