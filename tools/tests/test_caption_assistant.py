from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools import spotterdex_afm_caption
from tools.prompts import build_caption_prompt
from tools.spotterdex_manager import (
    APPLE_CAPTION_LOCK,
    APPLE_CAPTION_TIMEOUT_SECONDS,
    CaptionAssistError,
    request_apple_caption,
)


class CaptionAssistantTests(unittest.TestCase):
    def test_prompt_uses_preferred_structure_and_preserves_existing_detail(self) -> None:
        prompt = build_caption_prompt(
            country="Japan",
            aircraft_type="Kawasaki T-4",
            squadron_name="Blue Impulse",
            unit_type="squadron",
            location="Gifu Air Base",
            airshow="Gifu Air Show 2023",
            livery="Special anniversary scheme",
            draft_caption="T-4 06-5790 in the 60th anniversary scheme during the display.",
        )
        self.assertIn("Country: Japan", prompt)
        self.assertIn("Aircraft type: Kawasaki T-4", prompt)
        self.assertIn("Task: refine an existing caption", prompt)
        self.assertIn("what the aircraft is doing", prompt)
        self.assertIn("surroundings and environment", prompt)
        self.assertIn("Include the country, aircraft type, squadron or organisation, location, event, and livery", prompt)
        self.assertIn("06-5790", prompt)

    def test_prompt_selects_new_caption_mode_when_draft_is_empty(self) -> None:
        prompt = build_caption_prompt(
            country="United Kingdom",
            aircraft_type="Hawker Hurricane",
            squadron_name="Historic Flight",
            unit_type="organisation",
            location="Duxford",
            airshow="Flying Legends",
            livery="Battle of Britain scheme",
            draft_caption="",
        )
        self.assertIn("Task: generate a new caption", prompt)
        self.assertIn("For new-caption mode, create the caption", prompt)
        self.assertIn("Existing caption: None", prompt)

    def test_caption_request_uses_isolated_worker_and_normalizes_output(self) -> None:
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"ok": True, "caption": '  Caption: "Japan Kawasaki T-4 landing."  '}),
            stderr="",
        )
        with patch("tools.spotterdex_manager.prepare_caption_image") as prepare:
            with patch("tools.spotterdex_manager.subprocess.run", return_value=completed) as run:
                caption = request_apple_caption(prompt="caption this", source_path=Path("photo.jpg"))

        self.assertEqual(caption, "Japan Kawasaki T-4 landing.")
        prepare.assert_called_once()
        request = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(request["prompt"], "caption this")
        self.assertIn("aviation photography caption editor", request["system_prompt"])
        self.assertTrue(request["image_path"].endswith("caption-input.jpg"))
        self.assertEqual(run.call_args.kwargs["timeout"], APPLE_CAPTION_TIMEOUT_SECONDS)

    def test_caption_request_surfaces_worker_error(self) -> None:
        completed = SimpleNamespace(
            returncode=0,
            stdout=json.dumps({
                "ok": False,
                "error": {"code": "model_unavailable", "message": "Apple Intelligence is not enabled on this Mac."},
            }),
            stderr="",
        )
        with patch("tools.spotterdex_manager.prepare_caption_image"):
            with patch("tools.spotterdex_manager.subprocess.run", return_value=completed):
                with self.assertRaisesRegex(CaptionAssistError, "not enabled"):
                    request_apple_caption(prompt="caption this", source_path=Path("photo.jpg"))

    def test_caption_request_times_out_cleanly(self) -> None:
        timeout = subprocess.TimeoutExpired(cmd=["python"], timeout=APPLE_CAPTION_TIMEOUT_SECONDS)
        with patch("tools.spotterdex_manager.prepare_caption_image"):
            with patch("tools.spotterdex_manager.subprocess.run", side_effect=timeout):
                with self.assertRaisesRegex(CaptionAssistError, "took too long"):
                    request_apple_caption(prompt="caption this", source_path=Path("photo.jpg"))

    def test_caption_request_rejects_concurrent_generation(self) -> None:
        self.assertTrue(APPLE_CAPTION_LOCK.acquire(blocking=False))
        try:
            with self.assertRaisesRegex(CaptionAssistError, "Another caption"):
                request_apple_caption(prompt="caption this", source_path=Path("photo.jpg"))
        finally:
            APPLE_CAPTION_LOCK.release()

    def test_worker_sends_image_prompt_with_bounded_generation_options(self) -> None:
        observed = {}

        class FakeModel:
            def is_available(self):
                return True, None

        class FakeAttachment:
            def __init__(self, *, path):
                observed["image_path"] = path

        class FakeOptions:
            def __init__(self, *, temperature, maximum_response_tokens):
                observed["temperature"] = temperature
                observed["maximum_response_tokens"] = maximum_response_tokens

        class FakeSession:
            def __init__(self, *, instructions, model):
                observed["instructions"] = instructions
                observed["model"] = model

            async def respond(self, prompt, *, options):
                observed["prompt"] = prompt
                observed["options"] = options
                return "A locally generated aircraft caption."

        fake_sdk = SimpleNamespace(
            SystemLanguageModel=FakeModel,
            ImageAttachment=FakeAttachment,
            GenerationOptions=FakeOptions,
            LanguageModelSession=FakeSession,
        )
        with tempfile.TemporaryDirectory() as temporary:
            image_path = Path(temporary) / "photo.jpg"
            image_path.touch()
            with patch.dict(sys.modules, {"apple_fm_sdk": fake_sdk}):
                result = asyncio.run(spotterdex_afm_caption._generate("caption this", "be accurate", image_path))

        self.assertEqual(result, {"ok": True, "caption": "A locally generated aircraft caption."})
        self.assertEqual(observed["prompt"][0], "caption this")
        self.assertIsInstance(observed["prompt"][1], FakeAttachment)
        self.assertEqual(observed["temperature"], 0.25)
        self.assertEqual(observed["maximum_response_tokens"], 512)


if __name__ == "__main__":
    unittest.main()
