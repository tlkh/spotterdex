import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "aircraft-3d" / "mcp_smoke.py"
SPEC = importlib.util.spec_from_file_location("aircraft_3d_mcp_smoke", SCRIPT)
mcp_smoke = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(mcp_smoke)


class BlenderMcpSmokeCliTests(unittest.TestCase):
    def test_help_is_dependency_lazy(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn("--addon", result.stdout)
        self.assertIn("--output", result.stdout)

    def test_missing_addon_rejected_before_dependency_import(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(SystemExit) as raised:
                mcp_smoke.main(["--blender", str(root / "blender"), "--addon", str(root / "missing"), "--output", str(root / "new")])
        self.assertEqual(raised.exception.code, 2)

    def test_existing_output_rejected_to_preserve_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            addon = root / "addon"
            addon.mkdir()
            (addon / "mcp_to_blender_server.py").write_text("# test marker\n")
            output = root / "existing"
            output.mkdir()
            with self.assertRaises(SystemExit) as raised:
                mcp_smoke.main(["--blender", str(root / "blender"), "--addon", str(addon), "--output", str(output)])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
