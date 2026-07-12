#!/usr/bin/env python3
"""Canonical SQLite catalog helpers for SpotterDex.

The database is the source of truth.  ``content/spotterdex.sql`` is a
deterministic, generated review/recovery artifact and must never be edited by
hand.
"""

from __future__ import annotations

import os
import re
import sqlite3
import tempfile
from datetime import date
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple


SCHEMA_VERSION = 3
AIRCRAFT_FAMILIES = ("fighter", "helicopter", "light", "medium", "heavy")
UNIT_KINDS = ("squadron", "organisation")

TABLE_ORDER = (
    "metadata",
    "countries",
    "aircraft",
    "units",
    "locations",
    "events",
    "aircraft_units",
    "event_locations",
    "photos",
    "photo_subjects",
)

SCHEMA_SQL = """
CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE countries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
) WITHOUT ROWID;

CREATE TABLE aircraft (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    family TEXT NOT NULL CHECK (family IN ('fighter','helicopter','light','medium','heavy')),
    hero_photo_id TEXT REFERENCES photos(id) DEFERRABLE INITIALLY DEFERRED,
    double_width INTEGER CHECK (double_width IN (0,1)),
    write_up TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country_id TEXT NOT NULL REFERENCES countries(id),
    kind TEXT NOT NULL DEFAULT 'squadron' CHECK (kind IN ('squadron','organisation')),
    logo_source TEXT NOT NULL DEFAULT '',
    hero_photo_id TEXT REFERENCES photos(id) DEFERRABLE INITIALLY DEFERRED,
    write_up TEXT NOT NULL DEFAULT '',
    UNIQUE (country_id, name, kind)
) WITHOUT ROWID;

CREATE TABLE locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country_id TEXT NOT NULL REFERENCES countries(id),
    icao TEXT NOT NULL DEFAULT '',
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    hero_photo_id TEXT REFERENCES photos(id) DEFERRABLE INITIALLY DEFERRED,
    write_up TEXT NOT NULL DEFAULT '',
    UNIQUE (country_id, name)
) WITHOUT ROWID;

CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    starts_on TEXT CHECK (starts_on IS NULL OR starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    ends_on TEXT CHECK (ends_on IS NULL OR ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    hero_photo_id TEXT REFERENCES photos(id) DEFERRABLE INITIALLY DEFERRED,
    write_up TEXT NOT NULL DEFAULT '',
    CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)
) WITHOUT ROWID;

CREATE TABLE aircraft_units (
    aircraft_id TEXT NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    PRIMARY KEY (aircraft_id, unit_id)
) WITHOUT ROWID;

CREATE TABLE event_locations (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, location_id)
) WITHOUT ROWID;

CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL UNIQUE,
    location_id TEXT NOT NULL REFERENCES locations(id),
    event_id TEXT REFERENCES events(id),
    date_override TEXT CHECK (date_override IS NULL OR date_override GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    title TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    livery TEXT NOT NULL DEFAULT '',
    caption_ai_assisted INTEGER NOT NULL DEFAULT 0 CHECK (caption_ai_assisted IN (0,1))
) WITHOUT ROWID;

CREATE TABLE photo_subjects (
    photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    aircraft_id TEXT REFERENCES aircraft(id),
    unit_id TEXT REFERENCES units(id),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    PRIMARY KEY (photo_id, position),
    CHECK (aircraft_id IS NOT NULL OR unit_id IS NOT NULL)
) WITHOUT ROWID;

CREATE UNIQUE INDEX one_primary_subject_per_photo
ON photo_subjects(photo_id) WHERE is_primary = 1;

CREATE INDEX photos_by_location ON photos(location_id);
CREATE INDEX photos_by_event ON photos(event_id);
CREATE INDEX subjects_by_aircraft ON photo_subjects(aircraft_id);
CREATE INDEX subjects_by_unit ON photo_subjects(unit_id);
""".strip()


def _upgrade_existing_schema(connection: sqlite3.Connection) -> None:
    """Apply small, safe schema upgrades when opening a writable catalog."""
    metadata = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'"
    ).fetchone()
    if not metadata:
        return
    version_row = connection.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
    if not version_row:
        return
    version = int(version_row[0])
    if version == 2:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(aircraft)")}
        if "double_width" not in columns:
            connection.execute("ALTER TABLE aircraft ADD COLUMN double_width INTEGER CHECK (double_width IN (0,1))")
        connection.execute("UPDATE metadata SET value=? WHERE key='schema_version'", (str(SCHEMA_VERSION),))
        connection.commit()
    elif version != SCHEMA_VERSION:
        raise ValueError(f"Unsupported catalog schema version {version}; expected {SCHEMA_VERSION}.")


def connect_database(path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    """Open a configured catalog connection."""
    path = path.resolve()
    if read_only:
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    if not read_only:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        _upgrade_existing_schema(connection)
    return connection


def create_database(path: Path, *, overwrite: bool = False) -> sqlite3.Connection:
    if path.exists():
        if not overwrite:
            raise FileExistsError(path)
        path.unlink()
    connection = connect_database(path)
    connection.executescript(SCHEMA_SQL)
    connection.execute("INSERT INTO metadata(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
    connection.commit()
    return connection


def _sql_literal(connection: sqlite3.Connection, value: Any) -> str:
    return str(connection.execute("SELECT quote(?)", (value,)).fetchone()[0])


def deterministic_sql(connection: sqlite3.Connection) -> str:
    """Return a stable SQL representation sorted by table and primary key."""
    lines = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"]
    for table in TABLE_ORDER:
        schema_row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not schema_row:
            raise ValueError(f"Catalog is missing table: {table}")
        lines.extend((str(schema_row[0]).rstrip(";") + ";", ""))
    index_rows = connection.execute(
        "SELECT name, sql FROM sqlite_master "
        "WHERE type='index' AND sql IS NOT NULL ORDER BY name"
    ).fetchall()
    for row in index_rows:
        lines.extend((str(row[1]).rstrip(";") + ";", ""))

    for table in TABLE_ORDER:
        columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
        pk_columns = [
            row[1]
            for row in sorted(
                (row for row in connection.execute(f'PRAGMA table_info("{table}")') if row[5]),
                key=lambda row: row[5],
            )
        ]
        order = ", ".join(f'"{column}"' for column in (pk_columns or columns))
        rows = connection.execute(f'SELECT * FROM "{table}" ORDER BY {order}').fetchall()
        column_sql = ", ".join(f'"{column}"' for column in columns)
        for row in rows:
            values = ", ".join(_sql_literal(connection, row[column]) for column in columns)
            lines.append(f'INSERT INTO "{table}" ({column_sql}) VALUES ({values});')
        if rows:
            lines.append("")
    lines.extend(("COMMIT;", ""))
    return "\n".join(lines)


def export_snapshot(connection: sqlite3.Connection, output_path: Path) -> str:
    text = deterministic_sql(connection)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=output_path.name + ".", dir=output_path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary_name, output_path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    return text


def snapshot_is_current(connection: sqlite3.Connection, snapshot_path: Path) -> bool:
    return snapshot_path.exists() and snapshot_path.read_text("utf-8") == deterministic_sql(connection)


def validate_database(connection: sqlite3.Connection, *, raw_assets_dir: Path | None = None) -> List[str]:
    errors: List[str] = []
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        errors.append(f"SQLite integrity check failed: {integrity}")
    for row in connection.execute("PRAGMA foreign_key_check"):
        errors.append(f"Foreign-key violation in {row[0]} row {row[1]} -> {row[2]}")

    version = connection.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
    if not version or str(version[0]) != str(SCHEMA_VERSION):
        errors.append(f"Expected schema version {SCHEMA_VERSION}.")

    slug_pattern = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    for table in ("countries", "aircraft", "units", "locations", "events", "photos"):
        for row in connection.execute(f'SELECT id FROM "{table}"'):
            if not slug_pattern.fullmatch(str(row[0])):
                errors.append(f"Invalid semantic id in {table}: {row[0]}")

    for row in connection.execute("SELECT id,icao FROM locations WHERE icao<>''"):
        if not re.fullmatch(r"[A-Z]{4}", str(row[1])):
            errors.append(f"Location {row[0]} has invalid ICAO code: {row[1]}")

    for table, columns in (("events", ("starts_on", "ends_on")), ("photos", ("date_override",))):
        for row in connection.execute(f'SELECT id,{",".join(columns)} FROM "{table}"'):
            for offset, column in enumerate(columns, start=1):
                value = row[offset]
                if value:
                    try:
                        date.fromisoformat(str(value))
                    except ValueError:
                        errors.append(f"Invalid {column} on {table} {row[0]}: {value}")

    for row in connection.execute(
        "SELECT p.id, COUNT(s.photo_id), COALESCE(SUM(s.is_primary), 0) "
        "FROM photos p LEFT JOIN photo_subjects s ON s.photo_id=p.id GROUP BY p.id"
    ):
        count, primary_count = int(row[1]), int(row[2])
        if count and primary_count != 1:
            errors.append(f"Photo {row[0]} has {primary_count} primary subjects; expected one.")

    invalid_pairs = connection.execute(
        "SELECT s.photo_id, s.aircraft_id, s.unit_id FROM photo_subjects s "
        "LEFT JOIN aircraft_units au ON au.aircraft_id=s.aircraft_id AND au.unit_id=s.unit_id "
        "WHERE s.aircraft_id IS NOT NULL AND s.unit_id IS NOT NULL AND au.aircraft_id IS NULL"
    ).fetchall()
    for row in invalid_pairs:
        errors.append(f"Photo {row[0]} uses unregistered aircraft/unit pair {row[1]} + {row[2]}.")

    if raw_assets_dir is not None:
        root = raw_assets_dir.resolve()
        for row in connection.execute("SELECT id, source_path FROM photos"):
            relative = Path(str(row[1]))
            resolved = (root / relative).resolve()
            if relative.parent != Path("."):
                errors.append(f"Photo {row[0]} source must stay flat in raw_assets: {row[1]}")
            elif relative.is_absolute() or root not in resolved.parents:
                errors.append(f"Photo {row[0]} has unsafe source path: {row[1]}")
            elif not resolved.is_file():
                errors.append(f"Photo {row[0]} source is missing: {row[1]}")
    return errors


def rows_as_dicts(connection: sqlite3.Connection, query: str, params: Sequence[Any] = ()) -> List[Dict[str, Any]]:
    return [dict(row) for row in connection.execute(query, params)]
