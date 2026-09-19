# Catalog maintenance

Repository paths and commands below are relative to the repository root. See [agent instructions](../AGENTS.md) for task routing.

## Source of truth

- `content/spotterdex.sqlite3` is the canonical catalog.
- `content/spotterdex.sql` is a deterministic generated snapshot for Git review and recovery. Never edit it manually.
- `raw_assets/` contains flat original images and logos. It is gitignored and must never be committed or reorganized.
- Use `tools/spotterdex_manager.py` for day-to-day authoring. Direct SQL editing is unsupported.
- Do not hand-edit `data/`, `share/`, `assets/generated/`, published raster logos, `sitemap.xml`, or `robots.txt`.
- Do not hand-edit the five top-level HTML pages or the service-worker cache versions. Both are generated; see Presentation layer.

The catalog schema is implemented in `tools/spotterdex_db.py`. It contains:

- countries;
- aircraft, including optional photo heroes and card-width settings;
- units (`squadron` or `organisation`);
- aircraft/unit relationships;
- locations;
- events and event locations;
- photos;
- ordered photo subjects.

IDs are lowercase semantic slugs and are immutable after creation. Renaming an entity changes its display name, not its ID.

## Authoring workflow

Run the local manager:

```bash
python3 tools/spotterdex_manager.py
```

Open `http://127.0.0.1:8765/manager/` and stop the process with `Ctrl+C` after use.

The manager writes the database transactionally and automatically refreshes `content/spotterdex.sql`. It supports aircraft/unit/location creation, photo tagging and movement, events and cinematic segments, aircraft-type/unit/location/event heroes, optional aircraft card widths, captions, bulk caption review, quality checks, tunable image build settings, local builds, database backups, and orphan cleanup. See `PROJECT_README.md` under Local manager for the authoring walkthrough.

Quality settings are manager-local in the ignored `.spotterdex-manager-quality-settings.json`. The current Quality UI exposes an autosaved empty-space detection toggle, not a general threshold editor. Empty-space detection is advisory for images with more than 80% low-detail sky or background. Build width and JPEG quality can be persisted in `.spotterdex-manager-build-settings.json` with Save settings; Build locally uses the current form values.

Photo rules:

- `source_path` is relative to flat `raw_assets/` and unique.
- Every photo references one location.
- An aircraft photo has an aircraft/unit subject.
- A unit-only photo has a unit subject without an aircraft.
- A location-only photo has no subjects.
- Multiple subjects are supported; subject-bearing photos require exactly one primary subject.
- Aircraft/unit pairs must exist in `aircraft_units`.
- A photo may reference one event.
- Entity heroes reference an existing photo ID, never a source path or list index.
- EXIF capture date takes precedence over `date_override` during generation; the override is the fallback.
- `caption_ai_assisted` is source-only review metadata and is omitted from the public payload.

Caption assistance uses AFM 3 Core locally through Apple Foundation Models on macOS 27. Install the optional pinned dependency from `requirements-caption.txt`; Apple Intelligence must be enabled and its model assets ready. The manager invokes the native SDK in a short-lived subprocess, permits one generation at a time, and never exposes prompts or native errors to browser JavaScript, generated data, or commits.

## Maintenance CLI

```bash
python3 tools/spotterdex_catalog.py validate
python3 tools/spotterdex_catalog.py export-sql
python3 tools/spotterdex_catalog.py backup
python3 tools/spotterdex_catalog.py counts
python3 tools/spotterdex_catalog.py reset-caption-markers
```

`reset-caption-markers` clears only the source-only `caption_ai_assisted` review flags; it preserves caption text and refreshes the SQL snapshot.

`validate` also accepts `--skip-raw-assets`, which checks schema, relationships, IDs, and the SQL snapshot without requiring `raw_assets/`. Use it only where the raw sources are unavailable, such as CI; local validation should include the raw check.

Backups are local and ignored under `content/backups/`. The one-shot legacy migration tool is `tools/migrate_spotterdex_sqlite.py`; it is retained for audit/history and is not a normal editor. `tools/generate_map_aircraft_assets.py` regenerates the light/dark map overlays from the curated badges in `assets/icons/` and is run only when those badges change.

## Generated data contract

The v2 manifest has `schemaVersion: 2`, `generatedAt`, normalized `entities`, and derived `indexes`.

Entity maps are keyed by canonical ID:

- `countries`
- `aircraft`
- `units`
- `locations`
- `events`
- `photos`

Aircraft entities may also contain `heroPhotoId` and nullable `doubleWidth` settings; `doubleWidth: null` preserves the automatic archive layout.

Indexes include photo IDs by aircraft, unit, location, and event plus unit IDs by aircraft. Public photo records hold ID references and media metadata rather than repeated display names. `script.js` resolves the normalized graph into page view models.

Generated full JPEGs default to 2048 px wide at quality 60; thumbnails default to 768 px wide at quality 50. Generated files retain normalized EXIF orientation.

