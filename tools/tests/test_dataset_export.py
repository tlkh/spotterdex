from __future__ import annotations

import csv
import io
import json
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from pathlib import Path

from PIL import Image
from tools.spotterdex_db import create_database, export_snapshot

from tools.spotterdex_dataset_export import (
    ExportJobRegistry,
    preview,
    snapshot,
    write_dataset,
)
import tools.spotterdex_dataset_export as dataset_export


def _payload(*, scope: str = "all", photo_ids: list[str] | None = None) -> dict:
    return {
        "scope": scope,
        "photoIds": photo_ids or [],
        "photos": [
            {
                "id": "p1", "source_path": "one.jpg", "livery": "",
                "subjects": [{"aircraft_id": "a1", "aircraft_name": "F-16",
                              "unit_id": "u1", "unit_name": "VFA-1", "unit_kind": "squadron",
                              "country_id": "us", "country_name": "United States"}],
            },
            {
                "id": "p2", "source_path": "two.jpg", "livery": "Tiger",
                "subjects": [{"aircraft_id": "a2", "aircraft_name": "F-15",
                              "unit_id": "u2", "unit_name": "JASDF", "unit_kind": "organisation",
                              "country_id": "jp", "country_name": "Japan"}],
            },
            {"id": "unit-only", "source_path": "unit.jpg", "livery": "",
             "subjects": [{"unit_id": "u1", "unit_name": "VFA-1", "unit_kind": "squadron",
                           "country_id": "us", "country_name": "United States"}]},
        ],
    }


def _seed(root: Path, payload: dict) -> None:
    """Materialize the compact payload into the canonical SQLite fixture."""
    content = root / "content"; content.mkdir(exist_ok=True)
    db = create_database(content / "spotterdex.sqlite3")
    try:
        countries = {}
        aircraft = {}; units = {}; locations = set()
        for p in payload["photos"]:
            for s in p.get("subjects", []):
                if s.get("country_id"):
                    countries[s["country_id"]] = s["country_name"]
                if s.get("aircraft_id"):
                    aircraft[s["aircraft_id"]] = s["aircraft_name"]
                if s.get("unit_id"):
                    units[s["unit_id"]] = s
            locations.add("loc")
        for cid, name in countries.items(): db.execute("INSERT INTO countries(id,name) VALUES(?,?)", (cid,name))
        for aid, name in aircraft.items(): db.execute("INSERT INTO aircraft(id,name,family) VALUES(?,?,?)", (aid,name,"fighter"))
        for uid, s in units.items(): db.execute("INSERT INTO units(id,name,country_id,kind) VALUES(?,?,?,?)", (uid,s["unit_name"],s["country_id"],s.get("unit_kind","squadron")))
        for aid in aircraft:
            for uid in units:
                db.execute("INSERT INTO aircraft_units(aircraft_id,unit_id) VALUES(?,?)", (aid,uid))
        db.execute("INSERT INTO locations(id,name,country_id,latitude,longitude) VALUES('loc','Location',?,0,0)", (next(iter(countries)),))
        for p in payload["photos"]:
            db.execute("INSERT INTO photos(id,source_path,location_id,livery) VALUES(?,?,?,?)", (p["id"],p["source_path"],"loc",p.get("livery","")))
            for i,s in enumerate(p.get("subjects", [])):
                db.execute("INSERT INTO photo_subjects(photo_id,position,aircraft_id,unit_id,is_primary) VALUES(?,?,?,?,?)", (p["id"],i,s.get("aircraft_id"),s.get("unit_id"),int(i == 0)))
        db.commit(); export_snapshot(db, content / "spotterdex.sql")
    finally: db.close()


class DatasetExportTests(unittest.TestCase):
    def test_snapshot_labels_and_preview(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "raw_assets").mkdir()
            for name in ("one.jpg", "two.jpg", "unit.jpg"):
                Image.new("RGB", (32, 20), "navy").save(root / "raw_assets" / name)
            _seed(root, _payload())
            snap = snapshot(root, _payload())
            self.assertEqual(len(snap["records"]), 2)
            self.assertEqual(snap["records"][0]["labels"], ["aircraft: F-16", "squadron: United States / VFA-1", "nationality: United States", "livery: standard"])
            info = preview(snap)
            self.assertEqual((info["total"], info["eligible"], len(info["excluded"])), (3, 2, 1))
            self.assertEqual(info["defaultLiveryCount"], 1)

    def test_selection_scopes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir()
            for n in ("one.jpg", "two.jpg"): Image.new("RGB", (8, 8)).save(root / "raw_assets" / n)
            _seed(root, _payload())
            self.assertEqual(len(snapshot(root, _payload(scope="selected", photo_ids=["p2"]))["records"]), 1)

    def test_zip_layout_and_csv(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir(); Image.new("RGB", (40, 20), "red").save(root / "raw_assets" / "one.jpg")
            _seed(root, {**_payload(), "photos": [_payload()["photos"][0]]})
            snap = snapshot(root, {**_payload(), "photos": [_payload()["photos"][0]]})
            out = root / "out.zip"; write_dataset(snap, root, out)
            with zipfile.ZipFile(out) as z:
                self.assertEqual({"labels.csv", "metadata.json", "config.yaml", "README.md"}, {p for p in z.namelist() if not p.startswith("images/")})
                rows = list(csv.DictReader(io.StringIO(z.read("labels.csv").decode())))
                self.assertEqual(rows[0]["id"], "p1"); self.assertEqual(json.loads(rows[0]["labels"])[-1], "livery: standard")
                image_name = rows[0]["image"]; self.assertIn("images/" + image_name, z.namelist())
                with Image.open(io.BytesIO(z.read("images/" + image_name))) as im: self.assertLessEqual(max(im.size), 2048)

    def test_missing_source_fails_without_partial_zip(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir()
            _seed(root, {**_payload(), "photos": [_payload()["photos"][0]]})
            snap = snapshot(root, {**_payload(), "photos": [_payload()["photos"][0]]})
            with self.assertRaises(ValueError): write_dataset(snap, root, root / "bad.zip")
            self.assertFalse((root / "bad.zip").exists())

    def test_conflicting_identical_pixels_fail(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir(); Image.new("RGB", (12, 12), "green").save(root / "raw_assets" / "same.jpg")
            base = {"id": "a", "source_path": "same.jpg", "image": "a.jpg", "livery": "", "labels": ["aircraft: A"]}
            other = {**base, "id": "b", "image": "b.jpg", "labels": ["aircraft: B"]}
            with self.assertRaises(ValueError): write_dataset({"records": [base, other], "exclusions": [], "fingerprint": "x"}, root, root / "bad.zip")

    def test_source_path_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir(); outside = root / "outside.jpg"; Image.new("RGB", (4, 4)).save(outside)
            record = {"id": "p", "source_path": "../outside.jpg", "image": "p.jpg", "livery": "", "labels": ["aircraft: A"]}
            with self.assertRaises(ValueError): write_dataset({"records": [record], "exclusions": [], "fingerprint": "x"}, root, root / "bad.zip")

    def test_identical_pixels_with_matching_labels_are_retained(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir(); Image.new("RGB", (6, 6), "blue").save(root / "raw_assets" / "same.jpg")
            one = {"id": "a", "source_path": "same.jpg", "image": "a.jpg", "livery": "", "labels": ["aircraft: A"]}
            two = {**one, "id": "b", "image": "b.jpg"}
            write_dataset({"records": [one, two], "exclusions": [], "fingerprint": "x"}, root, root / "ok.zip")
            with zipfile.ZipFile(root / "ok.zip") as z: self.assertIn("images/a.jpg", z.namelist()); self.assertIn("images/b.jpg", z.namelist())

    def test_orientation_is_applied_and_metadata_removed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir()
            image = Image.new("RGB", (3000, 1000), "white"); image.getexif()[274] = 6; image.save(root / "raw_assets" / "rot.jpg", exif=image.getexif())
            record = {"id": "p", "source_path": "rot.jpg", "image": "p.jpg", "livery": "", "labels": ["aircraft: A"]}
            write_dataset({"records": [record], "exclusions": [], "fingerprint": "x"}, root, root / "o.zip")
            with zipfile.ZipFile(root / "o.zip") as z, Image.open(io.BytesIO(z.read("images/p.jpg"))) as out:
                self.assertEqual(out.size, (683, 2048)); self.assertEqual(len(out.getexif()), 0)

    def test_registry_persists_jobs_and_limits_active(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir(); _seed(root, _payload())
            for n in ("one.jpg", "two.jpg"): Image.new("RGB", (8, 8)).save(root / "raw_assets" / n)
            reg = ExportJobRegistry(root)
            import threading
            finished = threading.Event()
            release = threading.Event()
            def hold(*args, **kwargs):
                release.wait(5)
                finished.set()
            with patch.object(dataset_export, "write_dataset", hold):
                job = reg.start({"scope": "all"})
                job_id = job["jobId"]
                self.assertEqual(reg.get(job_id)["job"]["status"], "running")
                with self.assertRaises(ValueError): reg.start({"scope": "all"})
                release.set()
                self.assertTrue(finished.wait(5))
                import time
                for _ in range(100):
                    if reg.get(job_id)["job"]["status"] != "running": break
                    time.sleep(.01)
                self.assertEqual(reg.get(job_id)["job"]["status"], "succeeded")
            self.assertTrue(reg.state_path.exists())

    def test_snapshot_freezes_saved_values_and_excludes_multiple_subjects(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            payload = _payload()
            payload["photos"].append({"id": "multiple", "source_path": "multi.jpg", "subjects": payload["photos"][0]["subjects"] + payload["photos"][1]["subjects"]})
            _seed(root, payload)
            data = snapshot(root, {"scope": "matching", "photoIds": ["p1", "p1", "multiple", "gone"]})
            self.assertEqual(len(data["records"]), 1)
            self.assertEqual({r["id"] for r in data["exclusions"]}, {"multiple", "gone"})
            with sqlite3.connect(root / "content/spotterdex.sqlite3") as db:
                db.execute("UPDATE photos SET livery='Changed' WHERE id='p1'")
            self.assertEqual(data["records"][0]["labels"][-1], "livery: standard")
            self.assertNotEqual(data["fingerprint"], snapshot(root, {"scope": "all"})["fingerprint"])

    def test_restart_marks_interrupted_and_retention_keeps_three(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            reg = ExportJobRegistry(root)
            reg.jobs = {"active": {"id": "active", "status": "running", "createdAt": 1}}
            reg._persist()
            (reg.directory / "active.partial").write_text("partial")
            restarted = ExportJobRegistry(root)
            self.assertEqual(restarted.get("active")["job"]["status"], "interrupted")
            self.assertFalse((reg.directory / "active.partial").exists())
            for i in range(4):
                ident = str(i)
                restarted.jobs[ident] = {"id": ident, "status": "running", "createdAt": i+2}
                with patch.object(dataset_export, "write_dataset", lambda data, root, dest, progress: dest.write_bytes(b"zip")):
                    restarted._run(ident, {})
            self.assertEqual(sum(j["status"] == "succeeded" for j in restarted.jobs.values()), 3)
            self.assertFalse((reg.directory / "0.zip").exists())
            self.assertTrue(restarted.download_path("3").is_file())

    def test_corrupt_source_and_no_upscale(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root / "raw_assets").mkdir()
            source = root / "raw_assets/one.jpg"
            _seed(root, _payload())
            data = snapshot(root, {"scope": "selected", "photoIds": ["p1"]})
            source.write_bytes(b"corrupt")
            with self.assertRaises(ValueError): write_dataset(data, root, root / "out.zip")
            self.assertFalse((root / "out.partial").exists())
            Image.new("RGB", (40, 20)).save(source)
            write_dataset(data, root, root / "out.zip")
            with zipfile.ZipFile(root / "out.zip") as archive:
                with Image.open(io.BytesIO(archive.read("images/" + data["records"][0]["image"]))) as image:
                    self.assertEqual(image.size, (40, 20))



class DatasetExportRouteTests(unittest.TestCase):
    def test_preview_start_status_and_download_routes(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from tools.spotterdex_manager import SpotterDexHandler
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); _seed(root, _payload())
            registry = Mock()
            handler = object.__new__(SpotterDexHandler)
            handler.context = SimpleNamespace(manager=SimpleNamespace(root=root, export_jobs=registry))
            handler._send_json = Mock()
            handler._send_exception = Mock(side_effect=lambda exc: (_ for _ in ()).throw(exc))
            handler._read_json = lambda: {"scope":"selected", "photoIds":["p1"]}
            handler.path = "/api/dataset-export-preview"
            handler.do_POST()
            self.assertEqual(handler._send_json.call_args.args[0]["eligible"], 1)
            registry.start.assert_not_called()
            handler.path = "/api/dataset-export-jobs"
            handler.do_POST()
            registry.start.assert_called_once_with({"scope":"selected", "photoIds":["p1"]})
            handler.do_GET()
            registry.list_jobs.assert_called_once()
            handler.path = "/api/dataset-export-jobs/example"
            handler.do_GET(); registry.get.assert_called_once_with("example")
            self.assertEqual(registry.start.call_count, 1)
            output = root / "export.zip"; output.write_bytes(b"zip content")
            registry.download_path.return_value = output
            handler.path += "/download"
            handler.send_response = Mock(); handler.send_header = Mock(); handler.end_headers = Mock(); handler.wfile = io.BytesIO()
            handler.do_GET()
            self.assertEqual(handler.wfile.getvalue(), b"zip content")
            handler.send_header.assert_any_call("Content-Type", "application/zip")
            handler.send_header.assert_any_call("Content-Disposition", 'attachment; filename="spotterdex-dataset.zip"')


if __name__ == "__main__":
    unittest.main()
