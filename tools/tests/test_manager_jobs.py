from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from tools.spotterdex_manager_jobs import BuildAlreadyRunning, BuildJobRegistry


class FakeManager:
    def __init__(self, *, gate: threading.Event | None = None, lines: list[str] | None = None) -> None:
        self.root = Path(tempfile.gettempdir())
        self.gate = gate
        self.lines = lines or ["building", "finished"]
        self.calls: list[tuple[bool, object]] = []

    def stream_build(self, *, strict: bool, build_settings: object) -> object:
        self.calls.append((strict, build_settings))
        yield ("status", {"message": "Snapshot captured."})
        if self.gate is not None:
            self.gate.wait(timeout=3)
        for line in self.lines:
            yield ("log", {"stream": "stdout", "line": line})
        yield ("summary", {"photos": 2})
        yield ("done", {"ok": True, "returncode": 0, "message": "Build finished."})


def wait_for_done(registry: BuildJobRegistry, job_id: str) -> dict:
    deadline = time.monotonic() + 5
    cursor = 0
    latest: dict = {}
    while time.monotonic() < deadline:
        latest = registry.get(job_id, cursor=cursor, limit=50)
        if latest["events"]:
            cursor = latest["nextCursor"]
        if latest["done"]:
            return latest
        time.sleep(0.01)
    raise AssertionError(f"job did not finish: {latest}")


class BuildJobRegistryTests(unittest.TestCase):
    def test_start_runs_stream_and_reconnects_from_cursor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manager = FakeManager()
            state_path = Path(directory) / "build-jobs.json"
            registry = BuildJobRegistry(manager, state_path)

            started = registry.start({"strict": True, "buildSettings": {"image_width": 1024}})
            self.assertTrue(started["ok"])
            job_id = started["jobId"]
            result = wait_for_done(registry, job_id)

            self.assertEqual(result["job"]["status"], "succeeded")
            names = [event["name"] for event in result["events"]]
            self.assertIn("summary", names)
            self.assertIn("done", names)
            self.assertEqual(manager.calls, [(True, {"image_width": 1024})])

            # The journal survives a new registry instance, which is the
            # browser refresh / dropped-request reconnect path.
            restored = BuildJobRegistry(FakeManager(), state_path)
            replay = restored.get(job_id, cursor=0)
            self.assertEqual(replay["job"]["status"], "succeeded")
            self.assertTrue(replay["events"])
            self.assertEqual(replay["events"][-1]["name"], "done")

    def test_only_one_build_can_run_at_a_time(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            gate = threading.Event()
            registry = BuildJobRegistry(FakeManager(gate=gate), Path(directory) / "jobs.json")
            first = registry.start()
            with self.assertRaises(BuildAlreadyRunning) as raised:
                registry.start()
            self.assertEqual(raised.exception.active_job["id"], first["jobId"])
            gate.set()
            wait_for_done(registry, first["jobId"])
            second = registry.start()
            self.assertNotEqual(second["jobId"], first["jobId"])
            gate.set()
            wait_for_done(registry, second["jobId"])

    def test_log_lines_and_event_journal_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manager = FakeManager(lines=["x" * 100, "y" * 100, "z" * 100])
            registry = BuildJobRegistry(
                manager,
                Path(directory) / "jobs.json",
                max_events=4,
                max_log_line_chars=12,
            )
            job_id = registry.start()["jobId"]
            result = wait_for_done(registry, job_id)
            self.assertLessEqual(len(result["events"]), 4)
            logs = [event for event in result["events"] if event["name"] == "log"]
            self.assertTrue(logs)
            self.assertLessEqual(len(logs[0]["payload"]["line"]), 13)
            self.assertTrue(result["truncated"])

    def test_restart_marks_running_job_as_interrupted_and_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "jobs.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "jobs": [
                            {
                                "id": "stale",
                                "status": "running",
                                "createdAt": "2026-01-01T00:00:00Z",
                                "events": [],
                                "lastSeq": 0,
                            }
                        ],
                    }
                ),
                "utf-8",
            )
            registry = BuildJobRegistry(FakeManager(), state_path)
            result = registry.get("stale")
            self.assertEqual(result["job"]["status"], "interrupted")
            self.assertTrue(result["done"])
            self.assertIn("unknown", result["job"]["error"])
            self.assertEqual(result["events"][-1]["name"], "interrupted")


if __name__ == "__main__":
    unittest.main()
