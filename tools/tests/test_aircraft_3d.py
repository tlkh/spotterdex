import hashlib, importlib.util, json, sqlite3, tempfile, unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("aircraft3d_pipeline", ROOT / "aircraft-3d/pipeline.py")
pipeline = importlib.util.module_from_spec(spec); spec.loader.exec_module(pipeline)

class Aircraft3DIntakeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.raw = self.root / "raw_assets"; self.raw.mkdir(); self.dbpath = self.root / "db.sqlite3"
        db=sqlite3.connect(self.dbpath)
        db.executescript("""create table aircraft(id text primary key,name text); create table units(id text primary key,name text,kind text); create table aircraft_units(aircraft_id text,unit_id text); create table photos(id text primary key,source_path text,title text,caption text); create table photo_subjects(photo_id text,aircraft_id text,unit_id text);""")
        db.execute("insert into aircraft values (?,?)", (pipeline.AIRCRAFT_ID,"Mitsubishi F-2A")); db.execute("insert into units values (?,?,?)",(pipeline.UNIT_ID,"8th Tactical Fighter Squadron","squadron")); db.execute("insert into aircraft_units values (?,?)",(pipeline.AIRCRAFT_ID,pipeline.UNIT_ID))
        db.execute("insert into photos values (?,?,?,?)",("p1","one.jpg","", "")); db.execute("insert into photo_subjects values (?,?,?)",("p1",pipeline.AIRCRAFT_ID,pipeline.UNIT_ID)); db.commit(); db.close(); (self.raw/"one.jpg").write_bytes(b"x")
        self.project = self.root / "fixture-project.json"
        refs = pipeline.catalog_references(self.dbpath, self.raw)
        self.project.write_text(json.dumps(pipeline.default_spec(refs)))
    def tearDown(self): self.tmp.cleanup()
    def test_catalog_is_read_only_and_dedupes(self):
        with closing(sqlite3.connect(self.dbpath)) as db:
            db.execute("insert into photo_subjects values (?,?,?)", ("p1", pipeline.AIRCRAFT_ID, pipeline.UNIT_ID))
            db.commit()
        before = self.dbpath.read_bytes()
        refs=pipeline.catalog_references(self.dbpath,self.raw); self.assertEqual(refs["photoCount"],1); self.assertTrue(refs["photos"][0]["available"])
        self.assertEqual(before, self.dbpath.read_bytes())
    def test_rejects_traversal(self):
        with self.assertRaises(ValueError): pipeline._safe_source(self.raw,"../secret.jpg")
    def test_rejects_symlink_escape_and_output_under_raw_assets(self):
        target = self.root / "outside.jpg"; target.write_bytes(b"outside")
        link = self.raw / "link.jpg"
        try: link.symlink_to(target)
        except OSError: self.skipTest("symlinks unavailable")
        with self.assertRaises(ValueError): pipeline._safe_source(self.raw, "link.jpg")
        if pipeline.Image is not None:
            with self.assertRaises(ValueError): pipeline.prepare(self.dbpath, self.raw, self.raw / "work", self.project)
    def test_prepare_writes_contact_sheet_and_refs(self):
        if pipeline.Image is None: self.skipTest("Pillow unavailable")
        from PIL import Image
        Image.new("RGB", (8, 8), "red").save(self.raw / "one.jpg")
        out=pipeline.prepare(self.dbpath,self.raw,self.root/"work",self.project); self.assertEqual(out["available"],1)
        self.assertTrue((self.root/"work/f-2a-8sq/references.json").exists()); self.assertTrue((self.root/"work/f-2a-8sq/contact-sheet.jpg").exists())
    def test_prepare_reports_corrupt_source(self):
        if pipeline.Image is None: self.skipTest("Pillow unavailable")
        out=pipeline.prepare(self.dbpath,self.raw,self.root/"work",self.project); self.assertEqual(out["unreadable"],["one.jpg"])
    def test_validation_rejects_missing_selection_and_preserves_db(self):
        before=hashlib.sha256(self.dbpath.read_bytes()).digest(); self.raw.joinpath("one.jpg").unlink(); refs=pipeline.catalog_references(self.dbpath,self.raw)
        project=self.root/"project.json"; d=pipeline.default_spec(refs); d["selectedPhotoIds"]=["p1"]; project.write_text(json.dumps(d))
        self.assertRaises(ValueError, pipeline.validate_project, project, refs); self.assertEqual(before,hashlib.sha256(self.dbpath.read_bytes()).digest())
    def test_validation_rejects_bad_budget_type(self):
        refs=pipeline.catalog_references(self.dbpath,self.raw); d=pipeline.default_spec(refs); d["budgets"]["triangles"]="many"; project=self.root/"project.json"; project.write_text(json.dumps(d))
        self.assertRaises(ValueError, pipeline.validate_project, project, refs)
    def test_spec_defaults(self):
        d=pipeline.default_spec({"aircraftId":pipeline.AIRCRAFT_ID,"unitId":pipeline.UNIT_ID,"photos":[]}); self.assertEqual(d["selectedPhotoIds"],[]); self.assertEqual(d["budgets"]["triangles"],200000)
    def test_load_project_rejects_non_object_documents(self):
        for value in ([], [1], "spec", 3, None):
            path = self.root / "bad.json"; path.write_text(json.dumps(value))
            with self.assertRaises(ValueError, msg=repr(value)):
                pipeline.load_project(path)
    def test_validate_rejects_non_object_or_nan_budgets(self):
        refs = pipeline.catalog_references(self.dbpath, self.raw)
        for value in (None, True, "200000", float("nan")):
            d = pipeline.default_spec(refs); d["budgets"]["triangles"] = value
            path = self.root / "bad-budget.json"; path.write_text(json.dumps(d, allow_nan=True))
            with self.assertRaises(ValueError, msg=repr(value)):
                pipeline.validate_project(path, refs)
    def test_missing_database_is_not_created(self):
        missing = self.root / "missing.sqlite3"
        with self.assertRaises((ValueError, sqlite3.Error, OSError)):
            pipeline.catalog_references(missing, self.raw)
        self.assertFalse(missing.exists())
    def test_unknown_selected_photo_is_rejected(self):
        refs = pipeline.catalog_references(self.dbpath, self.raw); d = pipeline.default_spec(refs); d["selectedPhotoIds"] = ["unknown"]
        path = self.root / "unknown.json"; path.write_text(json.dumps(d))
        with self.assertRaises(ValueError): pipeline.validate_project(path, refs)
    def test_custom_project_id_isolated_output(self):
        if pipeline.Image is None: self.skipTest("Pillow unavailable")
        refs = pipeline.catalog_references(self.dbpath, self.raw); d = pipeline.default_spec(refs); d["id"] = "custom-f2"
        path = self.root / "custom.json"; path.write_text(json.dumps(d))
        out = pipeline.prepare(self.dbpath, self.raw, self.root / "work", path)
        self.assertTrue((self.root / "work" / "custom-f2" / "references.json").exists())
        self.assertNotEqual(out.get("project"), str(self.root / "work" / "f-2a-8sq"))

if __name__ == "__main__": unittest.main()
