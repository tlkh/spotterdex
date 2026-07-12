from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.prompts import build_caption_prompt
from tools.spotterdex_manager import (
    NVIDIA_CAPTION_MAX_TOKENS,
    NVIDIA_CAPTION_REASONING_BUDGET,
    load_local_env,
    request_nvidia_caption,
)


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


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
        self.assertIn("visible action", prompt)
        self.assertIn("retain as much accurate additional information", prompt)
        self.assertIn("06-5790", prompt)

    def test_local_env_loads_values_without_overriding_process_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            env_path = Path(temporary) / ".env"
            env_path.write_text(
                "# local-only settings\n"
                "LLM_API_KEY='from-file'\n"
                "export NVIDIA_CAPTION_MODEL=example/model\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"LLM_API_KEY": "from-process"}, clear=True):
                load_local_env(env_path)
                self.assertEqual(os.environ["LLM_API_KEY"], "from-process")
                self.assertEqual(os.environ["NVIDIA_CAPTION_MODEL"], "example/model")

    def test_caption_request_enables_thinking_and_bounds_output(self) -> None:
        response_body = json.dumps({"choices": [{"message": {"content": "Japan Kawasaki T-4 landing at Gifu Air Base."}}]}).encode()
        with patch.dict(os.environ, {"LLM_API_KEY": "test-key"}, clear=True):
            with patch("tools.spotterdex_manager.urlopen", return_value=FakeResponse(response_body)) as mocked_urlopen:
                caption = request_nvidia_caption(prompt="caption this", image_url="data:image/jpeg;base64,abc")

        self.assertIn("Kawasaki T-4", caption)
        request = mocked_urlopen.call_args.args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["max_tokens"], NVIDIA_CAPTION_MAX_TOKENS)
        self.assertEqual(body["reasoning_budget"], NVIDIA_CAPTION_REASONING_BUDGET)
        self.assertEqual(body["messages"][0]["content"].splitlines()[0], "/think")
        self.assertNotIn("reasoning_effort", body)
        self.assertEqual(request.headers["Authorization"], "Bearer test-key")


if __name__ == "__main__":
    unittest.main()
