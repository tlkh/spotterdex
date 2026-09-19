import importlib.util
import json
import os
import shutil
import subprocess
import struct
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "aircraft-3d" / "blender" / "aircraft_scene.py"


def load_helpers():
    spec = importlib.util.spec_from_file_location("spotterdex_aircraft_scene", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Aircraft3DBlenderHelpersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.helpers = load_helpers()

    def test_contract_constants_and_budgets(self):
        self.assertEqual(self.helpers.ORIENTATION, {"nose": "+X", "left": "+Y", "up": "+Z"})
        self.assertEqual(self.helpers.DEFAULT_BUDGETS["triangles"], 200_000)
        self.assertEqual(self.helpers.DEFAULT_BUDGETS["textureMaxPx"], 2048)
        self.assertEqual(self.helpers.DEFAULT_BUDGETS["glbMaxBytes"], 25_000_000)

    def test_manifest_is_versioned_and_serializable(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "manifest.json"
            self.helpers.write_manifest(p, "f2a-demo", "mitsubishi-f-2a", "8tfs", "clean", {"glb": "model.glb"})
            payload = json.loads(p.read_text())
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(payload["reviewStatus"], "scaffold")
            self.assertIn("budgets", payload)

    def test_manifest_reports_glb_budget_overrun(self):
        with tempfile.TemporaryDirectory() as td:
            payload = self.helpers.write_manifest(Path(td) / "manifest.json", "test", "test", "none", "clean", {},
                                                  validation={"glb_bytes": 25_000_001, "within_budgets": True})
            self.assertFalse(payload["validation"]["within_budgets"])
            self.assertIn("glbMaxBytes", payload["validation"]["exceededBudgets"])

    def test_glb_inspection_rejects_external_images(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "bad.glb"
            document = json.dumps({"images": [{"uri": "missing.png"}]}).encode()
            path.write_bytes(struct.pack("<4sIIII", b"glTF", 2, 20 + len(document), len(document), 0x4E4F534A) + document)
            with self.assertRaisesRegex(ValueError, "not embedded"):
                self.helpers.inspect_glb(path)

    def test_glb_inspection_rejects_bad_header(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "bad.glb"
            path.write_bytes(b"not a glb")
            with self.assertRaisesRegex(ValueError, "header"):
                self.helpers.inspect_glb(path)

    def test_blender_smoke_is_opt_in(self):
        # Blender integration modifies a disposable temp directory and is opt-in for local CI.
        executable = os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")
        if not executable or os.environ.get("SPOTTERDEX_BLENDER_INTEGRATION") != "1":
            self.skipTest("set SPOTTERDEX_BLENDER_INTEGRATION=1 and BLENDER_EXECUTABLE to run")
        with tempfile.TemporaryDirectory() as td:
            result = subprocess.run([executable, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(MODULE_PATH), "--", "--smoke", "--output", td], capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            self.assertTrue((Path(td) / "smoke_fixture.blend").exists())
            self.assertTrue((Path(td) / "smoke_fixture.glb").exists())
            self.assertTrue((Path(td) / "smoke_fixture.png").exists())
            self.assertLessEqual((Path(td) / "smoke_fixture.glb").stat().st_size, self.helpers.DEFAULT_BUDGETS["glbMaxBytes"])
            report = json.loads((Path(td) / "manifest.json").read_text())["validation"]
            self.assertTrue(all(report["checks"].values()))
            self.assertEqual(report["dimensions_m"], [4, 2, 1])
            self.assertEqual(report["embeddedImages"], 1)
            self.assertEqual(report["errors"], [])


if __name__ == "__main__":
    unittest.main()
