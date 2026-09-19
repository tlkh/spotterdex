import json
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_DOCTOR_PATH = Path(__file__).resolve().parents[2] / "aircraft-3d" / "doctor.py"
_SPEC = importlib.util.spec_from_file_location("spotterdex_aircraft_3d_doctor", _DOCTOR_PATH)
doctor = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(doctor)


class DoctorTests(unittest.TestCase):
    def test_blender_check_reports_version_without_exposing_args(self):
        with tempfile.TemporaryDirectory() as td:
            exe = Path(td) / "blender"
            exe.touch()
            completed = mock.Mock(returncode=0, stdout="Blender 5.2.1\n", stderr="")
            with mock.patch.object(doctor.subprocess, "run", return_value=completed) as run:
                report = doctor.blender_check(exe)
        self.assertTrue(report["available"])
        self.assertEqual(report["version"], "Blender 5.2.1")
        run.assert_called_once_with([str(exe), "--version"], capture_output=True, text=True, timeout=8, check=False)

    def test_config_allowlist_hides_sensitive_fields(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.toml"
            path.write_text('[mcp_servers.blender]\ncommand = "/Users/me/.local/bin/blender-mcp"\nenabled = false\nprovider = "local"\nargs = ["--token", "secret"]\nenv = {TOKEN = "secret"}\n')
            report = doctor.codex_config_check(path)
        self.assertEqual(report["blender"], {"enabled": False, "provider": "local", "command": "blender-mcp", "configured": True})
        self.assertNotIn("secret", json.dumps(report))

    def test_addon_manifest_version(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "blender_manifest.toml").write_text('version = "1.0.0"\nblender_version_min = "5.1.0"\n')
            report = doctor.addon_check(root)
        self.assertTrue(report["present"])
        self.assertEqual(report["version"], "1.0.0")

    def test_diagnose_distinguishes_disabled_config_and_session(self):
        with mock.patch.object(doctor, "blender_check", return_value={"available": True}), mock.patch.object(doctor, "uvx_check", return_value={"available": True}), mock.patch.object(doctor, "addon_check", return_value={"present": True, "version": "1.0.0"}), mock.patch.object(doctor, "codex_config_check", return_value={"blender": {"enabled": False, "provider": "local", "command": "blender-mcp", "configured": True}}):
            report = doctor.diagnose()
        self.assertIsNone(report["mcpSession"]["connected"])
        self.assertTrue(any("disabled" in warning for warning in report["warnings"]))

    @mock.patch.object(doctor.shutil, "which", return_value=None)
    def test_uvx_missing_is_actionable(self, _which):
        report = doctor.uvx_check()
        self.assertFalse(report["available"])
        self.assertIn("uvx", report["warning"])


if __name__ == "__main__":
    unittest.main()
