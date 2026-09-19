"""Portable VLM datasets generated from a read-only catalog snapshot."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import threading
import time
import uuid
import zipfile
from pathlib import Path

import yaml
from PIL import Image, ImageOps

try:
    from spotterdex_db import connect_database
except ImportError:
    from tools.spotterdex_db import connect_database

PROFILE = {"max_edge": 2048, "jpeg_quality": 90, "subsampling": 0}


def snapshot(root: Path, payload: dict) -> dict:
    scope = payload.get("scope", "all")
    if scope not in {"all", "selected", "matching"}:
        raise ValueError("Unknown dataset scope.")
    ids = payload.get("photoIds", [])
    if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
        raise ValueError("photoIds must be an array of canonical photo IDs.")
    connection = connect_database(root / "content/spotterdex.sqlite3", read_only=True)
    try:
        connection.execute("BEGIN")
        photos = [dict(r) for r in connection.execute("SELECT * FROM photos ORDER BY id")]
        subjects = [dict(r) for r in connection.execute("""SELECT s.*, a.name aircraft_name,
            u.name unit_name, u.kind unit_kind, u.country_id, c.name country_name
            FROM photo_subjects s LEFT JOIN aircraft a ON a.id=s.aircraft_id
            LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN countries c ON c.id=u.country_id
            ORDER BY s.photo_id,s.position""")]
        fingerprint = hashlib.sha256("\n".join(connection.iterdump()).encode()).hexdigest()
    finally:
        connection.close()
    by_photo = {}
    for subject in subjects:
        by_photo.setdefault(subject["photo_id"], []).append(subject)
    wanted = set(ids)
    known = {p["id"] for p in photos}
    exclusions = [{"id": ident, "reason": "Photo no longer exists"} for ident in sorted(wanted - known)] if scope != "all" else []
    records = []
    for photo in photos:
        if scope != "all" and photo["id"] not in wanted:
            continue
        subjects = by_photo.get(photo["id"], [])
        if len(subjects) != 1:
            exclusions.append({"id": photo["id"], "reason": "Requires exactly one subject"})
            continue
        subject = subjects[0]
        if not all(subject.get(key) for key in ("aircraft_id", "aircraft_name", "unit_id", "unit_name", "country_name")):
            exclusions.append({"id": photo["id"], "reason": "Requires aircraft and unit metadata"})
            continue
        livery = photo["livery"].strip() or "standard"
        record = {key: subject[key] for key in ("aircraft_id", "aircraft_name", "unit_id", "unit_name", "unit_kind", "country_id", "country_name")}
        record.update(id=photo["id"], source_path=photo["source_path"], livery=photo["livery"], exported_livery=livery,
                      image=hashlib.sha256(photo["id"].encode()).hexdigest() + ".jpg")
        record["labels"] = [f"aircraft: {subject['aircraft_name']}", f"squadron: {subject['country_name']} / {subject['unit_name']}",
                            f"nationality: {subject['country_name']}", f"livery: {livery}"]
        records.append(record)
    return {"records": records, "exclusions": exclusions, "fingerprint": fingerprint}


def preview(data: dict) -> dict:
    counts = {}
    for record in data["records"]:
        for label in record["labels"]:
            counts[label] = counts.get(label, 0) + 1
    return {"ok": True, "total": len(data["records"]) + len(data["exclusions"]), "eligible": len(data["records"]),
            "excluded": data["exclusions"], "defaultLiveryCount": sum(not r["livery"].strip() for r in data["records"]),
            "labelCounts": dict(sorted(counts.items()))}


README = """# SpotterDex VLM dataset

Extract this folder anywhere and run from VLM Prompt Lab:

    uv run vlmp validate --config /path/to/dataset/config.yaml
    uv run vlmp split --config /path/to/dataset/config.yaml

Select real target and proposer providers in config.yaml before aircraft experiments.
The default mock providers are offline workflow fixtures, not aircraft recognition models.
Cloud inference requires explicit privacy configuration in VLM Prompt Lab.

Each photo has aircraft, squadron/operator, nationality (unit country), and livery
labels. Organisation units occupy the squadron category. Missing livery is standard.
Catalog annotations are ground truth but do not guarantee every marking is visible.
No session groups are supplied: only identical images are grouped by the VLM loader.
Near-identical shots may cross splits. Review label coverage and leakage before use;
rare labels may not occur in all splits. The starter configuration uses 60/20/20 and
seed 42. Predictions use {"labels": [...]} with one label per category; the existing
multi-label parser does not enforce category cardinality. Do not change a dataset
under an existing run: create fresh splits and a new run after changes.

Images are oriented RGB JPEGs, maximum edge 2048, quality 90, no upscaling, stripped
metadata. Original relative paths and entity identities are in metadata.json for
local traceability, never in the model prompt. CSV paths are relative to images/.
"""


def write_dataset(data: dict, root: Path, destination: Path, progress=lambda completed, total: None) -> None:
    if not data["records"]:
        raise ValueError("No eligible photos to export.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".partial")
    raw_root = (root / "raw_assets").resolve()
    metadata = []
    pixel_labels = {}
    rows = io.StringIO(newline="")
    writer = csv.writer(rows)
    writer.writerow(["id", "image", "labels"])
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            for index, record in enumerate(data["records"], 1):
                source = (raw_root / record["source_path"]).resolve()
                if not source.is_relative_to(raw_root):
                    raise ValueError(f"Source escapes raw_assets for photo {record['id']}.")
                try:
                    with Image.open(source) as opened:
                        if getattr(opened, "n_frames", 1) != 1:
                            raise ValueError("Multi-frame images are unsupported")
                        image = ImageOps.exif_transpose(opened).convert("RGB")
                        image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                        image.info.clear()
                        buffer = io.BytesIO()
                        image.save(buffer, format="JPEG", quality=90, subsampling=0)
                except (OSError, ValueError) as exc:
                    raise ValueError(f"Missing or corrupt source for photo {record['id']}.") from exc
                content = buffer.getvalue()
                with Image.open(io.BytesIO(content)) as decoded:
                    pixels = hashlib.sha256(f"{decoded.width}x{decoded.height}|".encode() + decoded.convert("RGB").tobytes()).hexdigest()
                labels = tuple(sorted(record["labels"]))
                if pixels in pixel_labels and pixel_labels[pixels] != labels:
                    raise ValueError(f"Identical exported pixels have conflicting labels: {record['id']}.")
                pixel_labels[pixels] = labels
                archive.writestr("images/" + record["image"], content)
                writer.writerow([record["id"], record["image"], json.dumps(record["labels"], ensure_ascii=False)])
                metadata.append({**record, "sha256": hashlib.sha256(content).hexdigest(), "pixel_sha256": pixels})
                progress(index, len(data["records"]))
            labels = sorted({label for r in data["records"] for label in r["labels"]})
            config = {"version": 1, "task": "multi_label", "labels": labels,
                      "definitions": {label: ("Squadron or organisation operator: " + label.split(": ", 1)[1] if label.startswith("squadron:") else label) for label in labels},
                      "dataset": {"csv": "labels.csv", "image_root": "images", "format": "json_array"},
                      "target": {"provider": "mock", "model": "geometric-v1"}, "proposer": {"provider": "mock", "model": "geometric-v1"},
                      "preprocessing": {"max_edge": 2048}, "splits": {"train": 0.6, "validation": 0.2, "test": 0.2, "seed": 42, "output": "splits"},
                      "initial_prompt": 'Identify the aircraft type, squadron or organisation operator, operator nationality, and livery. Return JSON {"labels": [...]} with exactly one label from each category in the supplied taxonomy. Use livery: standard for ordinary liveries.'}
            archive.writestr("labels.csv", rows.getvalue())
            archive.writestr("metadata.json", json.dumps({"formatVersion": 1, "catalogFingerprint": data["fingerprint"], "imageProfile": PROFILE, "records": metadata, "exclusions": data["exclusions"]}, ensure_ascii=False, indent=2))
            archive.writestr("config.yaml", yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
            archive.writestr("README.md", README)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


class ExportAlreadyRunning(ValueError):
    pass


class ExportJobRegistry:
    """One active export, reconnectable status, and three retained downloads."""
    def __init__(self, root: Path):
        self.root = root
        self.directory = root / ".spotterdex-manager-exports"
        self.state_path = self.directory / "jobs.json"
        self.lock = threading.RLock()
        self.jobs = {}
        if self.state_path.exists():
            try:
                self.jobs = json.loads(self.state_path.read_text())
            except (ValueError, OSError):
                self.jobs = {}
            for job in self.jobs.values():
                if job["status"] == "running":
                    job.update(status="interrupted", error="Manager restarted; export interrupted. Start a new export explicitly.")
            for partial in self.directory.glob("*.partial"):
                partial.unlink(missing_ok=True)
            self._persist()

    def _persist(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.jobs), encoding="utf-8")
        temporary.replace(self.state_path)

    def _public(self, job):
        return {**job, "downloadUrl": f"/api/dataset-export-jobs/{job['id']}/download" if job["status"] == "succeeded" else None}

    def list_jobs(self):
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j["createdAt"], reverse=True)
            return {"ok": True, "activeJobId": next((j["id"] for j in jobs if j["status"] == "running"), None), "jobs": [self._public(j) for j in jobs]}

    def get(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise FileNotFoundError("Dataset export job not found.")
            return {"ok": True, "job": self._public(self.jobs[job_id])}

    def download_path(self, job_id):
        with self.lock:
            if self.get(job_id)["job"]["status"] != "succeeded":
                raise ValueError("Dataset export is not complete.")
            path = self.directory / f"{job_id}.zip"
            if not path.is_file():
                raise FileNotFoundError("Dataset download has expired; create a new export.")
            return path

    def start(self, payload):
        with self.lock:
            if any(j["status"] == "running" for j in self.jobs.values()):
                raise ExportAlreadyRunning("A dataset export is already running.")
            data = snapshot(self.root, payload)
            if not data["records"]:
                raise ValueError("No eligible photos to export.")
            ident = uuid.uuid4().hex
            job = {"id": ident, "status": "running", "completed": 0, "total": len(data["records"]), "error": None, "createdAt": time.time()}
            self.jobs[ident] = job
            self._persist()
            threading.Thread(target=self._run, args=(ident, data), daemon=True).start()
            return {"ok": True, "jobId": ident, "job": self._public(job)}

    def _run(self, ident, data):
        def progress(completed, total):
            with self.lock:
                self.jobs[ident].update(completed=completed, total=total)
                self._persist()
        try:
            write_dataset(data, self.root, self.directory / f"{ident}.zip", progress)
            status, error = "succeeded", None
        except Exception as exc:
            status, error = "failed", str(exc)
        with self.lock:
            self.jobs[ident].update(status=status, error=error)
            completed = sorted((j for j in self.jobs.values() if j["status"] == "succeeded"), key=lambda j: j["createdAt"], reverse=True)
            failed = sorted((j for j in self.jobs.values() if j["status"] in {"failed", "interrupted"}), key=lambda j: j["createdAt"], reverse=True)
            for old in completed[3:] + failed[17:]:
                (self.directory / f"{old['id']}.zip").unlink(missing_ok=True)
                del self.jobs[old["id"]]
            self._persist()
