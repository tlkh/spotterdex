#!/usr/bin/env python3
"""Reconnectable background build jobs for the local SpotterDex manager.

The manager's existing ``SpotterDexManager.stream_build`` generator is tied to
an HTTP response.  This module runs that generator in a daemon thread and
keeps a small, on-disk event journal so the browser can reconnect after a
refresh or a dropped connection.  It deliberately has no HTTP-server or UI
dependencies; the manager can adapt :meth:`BuildJobRegistry.start` and
:meth:`BuildJobRegistry.poll` to its route conventions.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


TERMINAL_STATUSES = frozenset({"succeeded", "failed", "interrupted"})
DEFAULT_MAX_JOBS = 20
DEFAULT_MAX_EVENTS = 1000
DEFAULT_MAX_LOG_LINE_CHARS = 4000


class BuildJobError(RuntimeError):
    """Base class for registry errors that a route can present to a client."""


class BuildJobNotFound(BuildJobError):
    """Raised when a requested job ID is not in the local journal."""


class BuildAlreadyRunning(BuildJobError):
    """Raised when a second tab tries to start a build."""

    def __init__(self, active_job: Dict[str, Any]) -> None:
        self.active_job = active_job
        super().__init__("A SpotterDex build is already running.")


class BuildJobRegistry:
    """Own one process-local build and a bounded persistent event journal.

    ``manager`` must expose ``stream_build(strict=..., build_settings=...)``.
    State is written beneath ``.spotterdex-manager-cache`` by default, an
    already ignored manager-local directory.  A custom ``state_path`` is
    useful for tests and for hosts that keep manager state elsewhere.
    """

    def __init__(
        self,
        manager: Any,
        state_path: Optional[Path] = None,
        *,
        max_jobs: int = DEFAULT_MAX_JOBS,
        max_events: int = DEFAULT_MAX_EVENTS,
        max_log_line_chars: int = DEFAULT_MAX_LOG_LINE_CHARS,
    ) -> None:
        if max_jobs < 1 or max_events < 1 or max_log_line_chars < 1:
            raise ValueError("Build job limits must be positive.")
        self.manager = manager
        root = Path(getattr(manager, "root", Path.cwd()))
        self.state_path = Path(state_path) if state_path else root / ".spotterdex-manager-cache" / "build-jobs.json"
        self.max_jobs = max_jobs
        self.max_events = max_events
        self.max_log_line_chars = max_log_line_chars
        self._lock = threading.RLock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._active_job_id: Optional[str] = None
        self._load()

    # ---- public API -------------------------------------------------

    def start(self, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Start a build and return a reconnectable job ID.

        ``BuildAlreadyRunning`` is raised for a concurrent start.  An HTTP
        adapter can map that exception to 409 while including ``active_job``.
        """
        request = payload if isinstance(payload, dict) else {}
        with self._lock:
            active = self._active_job()
            if active is not None:
                raise BuildAlreadyRunning(self._public_job(active))
            job_id = uuid.uuid4().hex
            now = _timestamp()
            job: Dict[str, Any] = {
                "id": job_id,
                "status": "queued",
                "createdAt": now,
                "startedAt": None,
                "finishedAt": None,
                "strict": request.get("strict") is True,
                "buildSettings": _json_safe(request.get("buildSettings")) if isinstance(request.get("buildSettings"), dict) else None,
                "events": [],
                "result": None,
                "error": None,
                "eventsTruncated": False,
            }
            self._jobs[job_id] = job
            self._active_job_id = job_id
            self._append_event(job, "status", {"message": "Build queued."})
            self._persist_locked()
            worker = threading.Thread(target=self._run_job, args=(job_id,), name=f"spotterdex-build-{job_id[:8]}", daemon=True)
            worker.start()
            return {"ok": True, "jobId": job_id, "job": self._public_job(job)}

    def get(self, job_id: str, *, cursor: int = 0, limit: int = 100) -> Dict[str, Any]:
        """Return job state and events after ``cursor`` (exclusive).

        Sequence numbers are retained when old events are trimmed, so a
        reconnecting client never mistakes a later event for an earlier one.
        ``truncated`` tells a client that its cursor predates the retained
        journal and it should treat the returned events as a fresh baseline.
        """
        if not isinstance(job_id, str) or not job_id:
            raise BuildJobNotFound("Build job ID is required.")
        try:
            cursor_value = max(0, int(cursor))
            limit_value = min(max(1, int(limit)), self.max_events)
        except (TypeError, ValueError) as exc:
            raise BuildJobError("Build event cursor and limit must be integers.") from exc
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise BuildJobNotFound(f"Build job {job_id} was not found.")
            events = [event for event in job["events"] if int(event["seq"]) > cursor_value]
            selected = events[:limit_value]
            next_cursor = cursor_value
            if selected:
                next_cursor = int(selected[-1]["seq"])
            return {
                "ok": True,
                "job": self._public_job(job),
                "events": selected,
                "nextCursor": next_cursor,
                "hasMore": len(events) > len(selected),
                "done": job["status"] in TERMINAL_STATUSES,
                "truncated": bool(job.get("eventsTruncated")) and (
                    not job["events"] or cursor_value < int(job["events"][0]["seq"])
                ),
            }

    # ``status`` reads naturally in route code and is kept as an alias for
    # callers that prefer ``registry.status(job_id, ...)``.
    status = get
    # Explicit name for a GET /events style adapter.
    poll = get

    def list_jobs(self) -> Dict[str, Any]:
        """Return a compact list for a Build page that is opened mid-job."""
        with self._lock:
            return {
                "ok": True,
                "activeJobId": self._active_job_id,
                "jobs": [self._public_job(job) for job in self._sorted_jobs()],
            }

    # ---- worker and event journal ----------------------------------

    def _run_job(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job["status"] = "running"
            job["startedAt"] = _timestamp()
            self._append_event(job, "status", {"message": "Build started."})
            self._persist_locked()
            strict = bool(job.get("strict"))
            settings = job.get("buildSettings")

        completion: Optional[Dict[str, Any]] = None
        try:
            stream: Iterable[Tuple[str, Dict[str, Any]]] = self.manager.stream_build(
                strict=strict,
                build_settings=settings if isinstance(settings, dict) else None,
            )
            for event_name, event_payload in stream:
                payload = event_payload if isinstance(event_payload, dict) else {"value": event_payload}
                with self._lock:
                    current = self._jobs.get(job_id)
                    if current is None:
                        return
                    self._append_event(current, str(event_name), payload)
                    if event_name == "done":
                        completion = payload
                        current["result"] = _bounded_result(payload, self.max_log_line_chars)
                    self._persist_locked()
            with self._lock:
                current = self._jobs.get(job_id)
                if current is None:
                    return
                if completion is None:
                    current["status"] = "failed"
                    current["error"] = "Build stream ended without a completion event."
                    self._append_event(current, "error", {"message": current["error"]})
                else:
                    current["status"] = "succeeded" if completion.get("ok") is True else "failed"
                    current["error"] = None if completion.get("ok") is True else str(completion.get("message") or "Build failed.")
                current["finishedAt"] = _timestamp()
                self._persist_locked()
        except Exception as exc:  # pragma: no cover - exercised by focused tests
            with self._lock:
                current = self._jobs.get(job_id)
                if current is not None:
                    current["status"] = "failed"
                    current["error"] = str(exc) or exc.__class__.__name__
                    self._append_event(current, "error", {"message": current["error"]})
                    current["finishedAt"] = _timestamp()
                    self._persist_locked()
        finally:
            with self._lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None
                self._persist_locked()

    def _append_event(self, job: Dict[str, Any], name: str, payload: Dict[str, Any]) -> None:
        events = job["events"]
        next_seq = int(events[-1]["seq"]) + 1 if events else int(job.get("lastSeq", 0)) + 1
        bounded = dict(payload)
        if name == "log" and "line" in bounded:
            line = str(bounded.get("line") or "")
            if len(line) > self.max_log_line_chars:
                bounded["line"] = line[: self.max_log_line_chars] + "…"
                bounded["truncated"] = True
        event = {"seq": next_seq, "name": name, "at": _timestamp(), "payload": _json_safe(bounded)}
        events.append(event)
        job["lastSeq"] = next_seq
        if len(events) > self.max_events:
            del events[: len(events) - self.max_events]
            job["eventsTruncated"] = True

    # ---- persistence ------------------------------------------------

    def _load(self) -> None:
        try:
            data = json.loads(self.state_path.read_text("utf-8")) if self.state_path.exists() else {}
        except (OSError, ValueError, TypeError):
            data = {}
        rows = data.get("jobs") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return
        changed = False
        with self._lock:
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                    continue
                if not isinstance(row.get("events"), list):
                    row["events"] = []
                # Ignore malformed journal entries rather than preventing the
                # manager from starting.  Sequence numbers are repaired on
                # the next event append.
                row["events"] = [
                    event
                    for event in row["events"]
                    if isinstance(event, dict) and isinstance(event.get("seq"), int)
                ]
                row.setdefault("lastSeq", 0)
                row.setdefault("eventsTruncated", False)
                if row.get("status") in {"queued", "running"}:
                    row["status"] = "interrupted"
                    row["error"] = "Build was interrupted when the manager restarted; completion status is unknown."
                    row["finishedAt"] = _timestamp()
                    self._append_event(row, "interrupted", {"message": row["error"]})
                    changed = True
                self._jobs[row["id"]] = row
            self._prune_locked()
            if changed:
                self._persist_locked()

    def _persist_locked(self) -> None:
        self._prune_locked()
        payload = {"version": 1, "jobs": self._sorted_jobs()}
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), "utf-8")
            temporary.replace(self.state_path)
        except (OSError, TypeError, ValueError):
            # A build remains usable if the optional local journal cannot be
            # written (for example, a read-only checkout).
            return

    def _prune_locked(self) -> None:
        rows = self._sorted_jobs()
        for row in rows[self.max_jobs :]:
            self._jobs.pop(row["id"], None)

    def _sorted_jobs(self) -> List[Dict[str, Any]]:
        return sorted(self._jobs.values(), key=lambda row: str(row.get("createdAt") or ""), reverse=True)

    def _active_job(self) -> Optional[Dict[str, Any]]:
        if self._active_job_id:
            job = self._jobs.get(self._active_job_id)
            if job is not None and job.get("status") in {"queued", "running"}:
                return job
        for job in self._jobs.values():
            if job.get("status") in {"queued", "running"}:
                self._active_job_id = str(job["id"])
                return job
        self._active_job_id = None
        return None

    def _public_job(self, job: Dict[str, Any]) -> Dict[str, Any]:
        return {
            key: job.get(key)
            for key in (
                "id",
                "status",
                "createdAt",
                "startedAt",
                "finishedAt",
                "strict",
                "buildSettings",
                "result",
                "error",
                "eventsTruncated",
            )
        }


def _timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _bounded_result(payload: Dict[str, Any], max_chars: int) -> Dict[str, Any]:
    result = _json_safe(dict(payload))
    for key in ("message", "stdout", "stderr"):
        if key in result and result[key] is not None:
            value = str(result[key])
            result[key] = value if len(value) <= max_chars else value[:max_chars] + "…"
    return result


def _json_safe(value: Any) -> Any:
    """Coerce an unexpected stream value before it can poison the journal."""
    try:
        return json.loads(json.dumps(value, ensure_ascii=True))
    except (TypeError, ValueError, OverflowError):
        if isinstance(value, dict):
            return {str(key): _json_safe(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [_json_safe(item) for item in value]
        return str(value)


__all__ = ["BuildAlreadyRunning", "BuildJobError", "BuildJobNotFound", "BuildJobRegistry"]
