#!/usr/bin/env python3
"""One-shot caption worker for Apple's on-device Foundation Models API.

The manager launches this module in a short-lived subprocess so importing the
optional native SDK is isolated from the dependency-light manager process.  A
single JSON object is read from stdin and one JSON object is written to stdout;
diagnostic details and Python tracebacks are intentionally never returned.

The default ``SystemLanguageModel`` is the macOS 27 on-device model used for
AFM 3 Core access. The Python SDK does not take an arbitrary model-name
argument, so the exact system model and its availability remain controlled by
macOS and Apple Intelligence settings.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Mapping


class WorkerInputError(ValueError):
    """A malformed request that can be reported safely to the caller."""


class WorkerImageError(WorkerInputError):
    """The request names an image that cannot be accessed."""


def _result_ok(caption: str) -> dict[str, Any]:
    return {"ok": True, "caption": caption}


def _result_error(code: str, message: str) -> dict[str, Any]:
    # Keep the wire shape stable and make it impossible for an exception's
    # repr/traceback to leak through a user-facing response.
    return {"ok": False, "error": {"code": code, "message": message}}


def _read_request(raw: str) -> tuple[str, str, Path]:
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise WorkerInputError("The caption request was not valid JSON.") from exc

    if not isinstance(payload, Mapping):
        raise WorkerInputError("The caption request must be a JSON object.")

    prompt = payload.get("prompt")
    system_prompt = payload.get("system_prompt")
    image_path = payload.get("image_path")
    if not isinstance(prompt, str) or not prompt.strip():
        raise WorkerInputError("Caption prompt is required.")
    if not isinstance(system_prompt, str):
        raise WorkerInputError("Caption system prompt is required.")
    if not isinstance(image_path, str) or not image_path.strip():
        raise WorkerInputError("Caption image path is required.")

    path = Path(image_path).expanduser()
    try:
        exists = path.is_file()
    except OSError as exc:
        raise WorkerImageError("The selected image could not be accessed.") from exc
    if not exists:
        raise WorkerImageError("The selected image could not be found.")

    return prompt, system_prompt, path


def _reason_message(reason: Any) -> str:
    """Map SDK availability enum values to stable, actionable copy."""
    name = getattr(reason, "name", "")
    if name == "APPLE_INTELLIGENCE_NOT_ENABLED":
        return "Apple Intelligence is not enabled on this Mac."
    if name == "DEVICE_NOT_ELIGIBLE":
        return "This Mac cannot run Apple Foundation Models."
    if name == "MODEL_NOT_READY":
        return "Apple Foundation Models is still preparing its on-device model."
    return "Apple Foundation Models is not available on this Mac."


def _normalize_caption(value: Any) -> str:
    if not isinstance(value, str):
        value = str(value) if value is not None else ""
    caption = " ".join(value.split()).strip()
    if caption.lower().startswith("caption:"):
        caption = caption.split(":", 1)[1].strip()
    if len(caption) >= 2 and caption[0] == caption[-1] and caption[0] in {"'", '"'}:
        caption = caption[1:-1].strip()
    if not caption:
        raise WorkerInputError("Apple Foundation Models returned no usable caption.")
    return caption


def _sdk_error(exc: BaseException, fm: Any) -> tuple[str, str]:
    """Convert known Foundation Models failures to safe response categories."""
    def is_type(name: str) -> bool:
        cls = getattr(fm, name, None)
        return cls is not None and isinstance(exc, cls)

    if is_type("RefusalError") or is_type("GuardrailViolationError"):
        return "refused", "Apple Foundation Models declined this image request."
    if is_type("ExceededContextWindowSizeError"):
        return "prompt_too_long", "The caption prompt is too long for Apple Foundation Models."
    if is_type("AssetsUnavailableError"):
        return "model_unavailable", "Apple Foundation Models' on-device assets are not ready."
    if is_type("ImagePromptError"):
        return "image_error", "The selected image could not be attached for caption assistance."
    if is_type("PromptError"):
        return "invalid_request", "The caption prompt could not be sent to Apple Foundation Models."
    if is_type("FoundationModelsError"):
        return "generation_failed", "Apple Foundation Models could not generate a caption. Try again."
    return "generation_failed", "Apple Foundation Models could not generate a caption. Try again."


async def _generate(prompt: str, system_prompt: str, image_path: Path) -> dict[str, Any]:
    try:
        import apple_fm_sdk as fm
    except (ImportError, ModuleNotFoundError):
        return _result_error(
            "dependency_missing",
            "Apple Foundation Models support is not installed in this Python environment.",
        )
    except Exception:
        # Native binding load failures vary by Python/OS combination.  Keep the
        # details out of the browser response while retaining a useful action.
        return _result_error(
            "dependency_missing",
            "Apple Foundation Models support could not be loaded on this Mac.",
        )

    try:
        model = fm.SystemLanguageModel()
        available, reason = model.is_available()
    except Exception:
        return _result_error(
            "model_unavailable",
            "Apple Foundation Models could not be initialized on this Mac.",
        )
    if not available:
        return _result_error("model_unavailable", _reason_message(reason))

    try:
        attachment = fm.ImageAttachment(path=image_path)
        session = fm.LanguageModelSession(instructions=system_prompt, model=model)
        options = fm.GenerationOptions(
            temperature=0.25,
            maximum_response_tokens=512,
        )
        response = await session.respond([prompt, attachment], options=options)
        return _result_ok(_normalize_caption(response))
    except WorkerInputError as exc:
        return _result_error("invalid_output", str(exc))
    except Exception as exc:
        code, message = _sdk_error(exc, fm)
        return _result_error(code, message)


async def _main_async() -> dict[str, Any]:
    raw = sys.stdin.read()
    try:
        prompt, system_prompt, image_path = _read_request(raw)
    except WorkerImageError as exc:
        return _result_error("image_error", str(exc))
    except WorkerInputError as exc:
        return _result_error("invalid_request", str(exc))
    return await _generate(prompt, system_prompt, image_path)


def main() -> int:
    try:
        result = asyncio.run(_main_async())
    except KeyboardInterrupt:
        result = _result_error("cancelled", "Caption generation was cancelled.")
    except Exception:
        # Last-resort process guard: callers always receive valid JSON, with no
        # traceback or native error text crossing the worker boundary.
        result = _result_error("worker_failed", "Caption generation failed unexpectedly. Try again.")
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
