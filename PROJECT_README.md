# SpotterDex

SpotterDex is a dependency-light static aircraft spotting field guide and aviation photography portfolio. It is built for GitHub Pages and served directly from the repository root.

## Catalog architecture

The canonical source of truth is the normalized SQLite catalog:

```text
content/
  spotterdex.sqlite3    canonical catalog
  spotterdex.sql        deterministic generated review/recovery snapshot
  migration-report.json legacy-to-v2 migration audit

raw_assets/             local original images; flat and gitignored
```

Do not edit `content/spotterdex.sql` manually. The manager refreshes it after every successful transaction. The builder rejects stale snapshots in strict mode.

The database stores countries, aircraft, units, aircraft/unit relationships, locations, events, photos, event locations, and ordered photo subjects. Aircraft types may also store an optional hero photo and card-width preference. Entity relationships use immutable semantic IDs. Display-name changes do not change IDs.

Photos contain a source path relative to flat `raw_assets/`, a location, an optional event, and zero or more subjects. Aircraft/unit photos have one primary subject; unit-only photos omit the aircraft; location-only photos have no subjects. Multiple subjects are supported.

Entity heroes reference an existing photo ID. Raw or generated image paths are not stored as hero references.

## Local manager

The manager is the supported day-to-day authoring interface:

```bash
python3 tools/spotterdex_manager.py
```

Open `http://127.0.0.1:8765/`.

The manager supports:

- creating aircraft/unit relationships and locations;
- tagging flat raw assets as aircraft, unit, or location photos;
- moving photos by changing subject relationships;
- captions, AI-assisted caption review, liveries, dates, and events;
- aircraft-type, event, unit, and location hero selection by photo ID;
- optional Standard, Double, or Automatic card width for each aircraft type;
- airshow story segment generation, manual ordering, draft preview, coverage
  checks, and bulk photo actions;
- image-quality review and EXIF-aware sorting; the initial manager state loads
  before the quality scan, which runs in the background and refreshes the
  quality queue when complete;
- transactional database writes with automatic SQL snapshot export;
- database integrity/snapshot status and local ignored backups;
- builds and generated-file orphan detection.

Set `LLM_API_KEY` only in the manager process environment or the local, ignored root `.env` file when using AI captions. Copy `.env.example` to `.env` and fill in the key if preferred. It is never sent to browser JavaScript or written to the catalog.

Caption assistance uses the internal Nemotron 3 Nano Omni deployment with high reasoning (`/think`), a 16,384-token output limit, and an 8,192-token reasoning budget. Optional endpoint/model overrides are documented in `.env.example`.

## Catalog maintenance CLI

General metadata editing through direct SQL is unsupported. Maintenance commands are available for validation, snapshots, backups, counts, and resetting caption review markers:

```bash
python3 tools/spotterdex_catalog.py validate
python3 tools/spotterdex_catalog.py export-sql
python3 tools/spotterdex_catalog.py backup
python3 tools/spotterdex_catalog.py counts
python3 tools/spotterdex_catalog.py reset-caption-markers
```

The marker reset clears only `caption_ai_assisted` review metadata; it does not change stored captions.

Local backups are written under ignored `content/backups/`.

The historical one-shot importer remains at `tools/migrate_spotterdex_sqlite.py`; it exists for migration audit and is not the normal authoring path.

## Build

Install dependencies if needed:

```bash
python3 -m pip install -r requirements.txt
```

Build the site:

```bash
python3 tools/build_spotterdex.py
```

Run CI-style validation:

```bash
python3 tools/build_spotterdex.py --strict --no-progress
python3 tools/spotterdex_catalog.py validate
python3 -m unittest discover -s tools/tests -v
node --check script.js
node --check tools/manager/app.js
```

The builder reads SQLite in read-only mode, validates the catalog and SQL snapshot, processes photos, derives entity indexes and statistics, and generates:

- `data/spotterdex-core.js` — shared normalized payload cached by all pages;
- `data/spotterdex.json` — complete normalized v2 manifest;
- `data/spotterdex-exif.js` — Stats-only EXIF payload;
- processed photos, thumbnails, and unit logos;
- share pages, `sitemap.xml`, and `robots.txt`.

The normalized manifest contains `entities` maps for countries, aircraft, units, locations, events, and photos plus derived indexes such as `photoIdsByAircraft`, `photoIdsByUnit`, and `photoIdsByLocation`. Aircraft entities include `heroPhotoId` and nullable `doubleWidth`; `null` means the existing automatic archive layout remains active.

## Airshow immersive experience

Open an event with `airshows.html#airshow=<event-id>` to view its chronological
immersive story. Event photos are ordered by capture time, then grouped into
story segments. EXIF generation creates the initial chronological order;
after a user manually reorders segments, the saved segment order is
authoritative. The browser renders only photos explicitly assigned to saved
segments, so unused event photos remain visible in the archive and in manager
coverage warnings without being silently added to the story. There is no
per-segment photo limit.

Each segment uses its first photo as the hero and displays the remaining photos
in a supporting-photo carousel. The `View hero` control and supporting
thumbnails open the existing photo viewer and return to the originating story
segment. The manager can preview unsaved story drafts, assign or move selected
photos, sort a segment by capture time, and remove duplicate assignments.
Story data accepts `segments` (with a legacy `moments` read fallback); segment
overlay sides are authored as `left` or `right`.

The responsive layout follows the image composition:

- Desktop heroes use a bottom-aligned cover crop so the lower subject remains
  visible above the lower-third overlay. Segment copy and its carousel share a
  compact panel positioned on the authored side.
- Mobile heroes remain full-width and centered without a foreground tint. A
  blurred copy of the same photo fills the surrounding stage behind the hero.
  The bottom panel is sized above the fixed mobile navigation and does not
  obscure the hero.
- Reduced-motion users receive a static, readable story with all segment
  content in chronological order and no forced snapping.

## Local preview

```bash
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

Top-level pages are `index.html`, `aircraft-dex.html`, `squadrons.html`, `airshows.html`, and `stats.html`. All load the same shared core bundle; the Stats page loads EXIF separately, and the viewer hydrates the full manifest when needed.

Deep links use the new semantic IDs:

- `index.html#location=<location-id>`
- `index.html#location=<location-id>&detail=1`
- `index.html#photo=<photo-id>`
- `aircraft-dex.html#aircraft=<aircraft-id>`
- `squadrons.html#squadron=<unit-id>`
- `airshows.html#airshow=<event-id>`
- `stats.html#stats=summary|exif`

The v2 migration is intentionally a clean break; legacy IDs and URLs are not redirected.

## Publishing

Commit the canonical database and SQL snapshot together with generated `data/`, `share/`, `sitemap.xml`, `robots.txt`, `assets/generated/`, and `assets/logos/`. Never commit `raw_assets/`, `.spotterdex-manager-cache/`, `.spotterdex-manager-quality.json`, or `content/backups/`.

Keep the site static and preserve visible OpenStreetMap attribution. Do not add map-tile prefetching, hidden attribution, a frontend framework, or a bundler.
