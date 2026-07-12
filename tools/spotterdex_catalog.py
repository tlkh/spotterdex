#!/usr/bin/env python3
"""Maintenance CLI for the canonical SpotterDex catalog."""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path

try:
    from spotterdex_db import connect_database, export_snapshot, snapshot_is_current, validate_database
except ImportError:  # pragma: no cover
    from tools.spotterdex_db import connect_database, export_snapshot, snapshot_is_current, validate_database


ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("validate", "export-sql", "backup", "counts", "reset-caption-markers"),
    )
    parser.add_argument("--root", type=Path, default=ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    database = root / "content" / "spotterdex.sqlite3"
    snapshot = root / "content" / "spotterdex.sql"
    if not database.exists():
        raise SystemExit(f"Canonical database not found: {database}")

    if args.command == "backup":
        backup_dir = root / "content" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        destination_path = backup_dir / f"spotterdex-{time.strftime('%Y%m%d-%H%M%S')}.sqlite3"
        source = connect_database(database, read_only=True)
        destination = sqlite3.connect(destination_path)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        print(destination_path.relative_to(root))
        return 0

    writable = args.command in {"export-sql", "reset-caption-markers"}
    connection = connect_database(database, read_only=not writable)
    try:
        if args.command == "export-sql":
            export_snapshot(connection, snapshot)
            print(snapshot.relative_to(root))
            return 0
        if args.command == "reset-caption-markers":
            connection.execute("BEGIN")
            result = connection.execute(
                "UPDATE photos SET caption_ai_assisted=0 WHERE caption_ai_assisted<>0"
            )
            errors = validate_database(connection, raw_assets_dir=root / "raw_assets")
            if errors:
                connection.rollback()
                for error in errors:
                    print(f"error: {error}")
                return 1
            connection.commit()
            export_snapshot(connection, snapshot)
            print(f"Reset caption markers on {result.rowcount} photo(s).")
            print("SQL snapshot: current")
            return 0
        if args.command == "counts":
            tables = ("countries", "aircraft", "units", "aircraft_units", "locations", "events", "photos")
            print(json.dumps({table: connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] for table in tables}, indent=2))
            return 0
        errors = validate_database(connection, raw_assets_dir=root / "raw_assets")
        if not snapshot_is_current(connection, snapshot):
            errors.append("Deterministic SQL snapshot is stale.")
        if errors:
            for error in errors:
                print(f"error: {error}")
            return 1
        print("Catalog integrity: ok")
        print("SQL snapshot: current")
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
