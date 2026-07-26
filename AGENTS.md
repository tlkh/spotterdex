# SpotterDex Maintenance Guide

SpotterDex is a dependency-light static aircraft spotting guide and photography portfolio hosted from the repository root on GitHub Pages.

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

Open `http://127.0.0.1:8765/` and stop the process with `Ctrl+C` after use.

The manager writes the database transactionally and automatically refreshes `content/spotterdex.sql`. It supports aircraft/unit/location creation, photo tagging and movement, events, aircraft-type/unit/location/event heroes, optional aircraft card widths, captions, bulk caption review, configurable quality checks, builds, database backups, and orphan cleanup. Quality thresholds are manager-local in the ignored `.spotterdex-manager-quality-settings.json`; the Quality view can save or reset them. Empty-space detection is an advisory composition check for large low-detail sky or background regions.

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

Set `LLM_API_KEY` only in the manager process environment or the local, ignored root `.env` file for AI captions; `.env.example` documents the local setup. The caption assistant uses the internal Nemotron 3 Nano Omni deployment with `/think`, a 16,384-token output limit, and an 8,192-token reasoning budget. Never expose the key or hidden reasoning to browser JavaScript, logs, generated data, or commits.

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

## Build and verification

After catalog changes, rebuild:

```bash
python3 tools/build_spotterdex.py
```

Recommended verification:

```bash
python3 tools/build_spotterdex.py --strict --no-progress
python3 tools/spotterdex_catalog.py validate
python3 -m unittest discover -s tools/tests -v
node --check script.js
node --check service-worker.js
node --check tools/manager/app.js
```

Builds are idempotent: rebuilding an unchanged catalog must leave the worktree clean. `generatedAt` is carried over from the previous manifest whenever the payload is otherwise identical, and generated text files are only rewritten when their content changes. A no-op rebuild that still dirties files is a bug worth investigating.

`.github/workflows/ci.yml` runs the repo-only subset of these checks on every push. Because `raw_assets/` is not committed, CI cannot run the image pipeline or the raw source-path checks, so it uses `python3 tools/spotterdex_catalog.py validate --skip-raw-assets` and verifies that the committed pages still match `tools/build_pages.py`. The full strict build remains a local step.

The builder opens the database read-only, validates relationships and raw paths, verifies the SQL snapshot, processes all photos through one pipeline, derives indexes and statistics, and writes:

- `data/spotterdex-core.js` — shared normalized browser bundle;
- `data/spotterdex.json` — complete normalized manifest;
- `data/spotterdex-exif.js` — Stats-only EXIF data;
- generated photos, thumbnails, and unit logos;
- share pages, sitemap, and robots file.

Informational build notes, such as empty enabled locations, are acceptable. Strict mode must have no warnings or errors.

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

Generated full JPEGs remain 2560 px wide at the configured web profile; thumbnails remain 1024 px wide. Generated files retain normalized EXIF orientation.

## Presentation layer

The five top-level pages are **generated**, not hand-maintained. `tools/build_pages.py` owns the shared `<head>`, header, and navigation; `tools/page_templates/*.html` holds the per-page body. `build_pages()` runs at the end of every site build, so hand-edits to `index.html`, `aircraft-dex.html`, `squadrons.html`, `airshows.html`, or `stats.html` are silently reverted on the next rebuild. Change the generator or the template instead.

Two head details are load-bearing and are covered by tests in `tools/tests/test_site_contracts.py`:

- `viewport-fit=cover` on the viewport meta. `styles.css` positions the mobile tab bar and sheets with `env(safe-area-inset-*)`, which resolves to `0` on iOS without it.
- `tokens.css` is linked immediately before `styles.css`. Tokens must not be pulled in with `@import`, which would serialise the two stylesheet requests.

Styling is split between `tokens.css` (the semantic palette, spacing scale, and the three permitted eases) and `styles.css` (the page rules). `design.md` is the locked design system and describes the intended genre, palette, typography, motion, and mobile stance. `styles.css` still carries historical raw hex colours and `cubic-bezier()` curves; the ratchet test in `tools/tests/test_site_contracts.py` allows the current counts to fall but never rise, so new work must use tokens.

`plans/` holds completed motion and layout improvement plans, kept for history.

## Offline shell

`service-worker.js` backs the installable PWA described by `manifest.webmanifest`. Its strategies are:

- navigations — cache-first with a background refresh;
- generated catalog payloads under `data/` — network-first, so a deploy is visible on the first load;
- generated thumbnails and photos — runtime caches capped at 80 and 12 entries;
- everything in `SHELL_PATHS` — stale-while-revalidate;
- anything under `manager/` — bypassed entirely.

Rules:

- `SHELL_CACHE_VERSION` and `MEDIA_CACHE_VERSION` are rewritten by the builder from a hash of the precached assets and the image profile. Never edit them by hand, and never treat them as meaningful in review.
- `SHELL_PATHS` is the single source of truth for the precache list; the builder parses it to compute the shell hash. Adding a shell asset means adding it there, and a missing entry becomes a build warning.
- Every generated payload name under `data/` must match `isCatalogData`. A catalog bundle that falls through to the shell strategy serves the previous deploy to returning visitors.

## Site behavior

- All five pages load `data/spotterdex-core.js`.
- Stats loads `data/spotterdex-exif.js` on demand.
- The viewer lazily fetches `data/spotterdex.json` for full metadata.
- Squadron pages use canonical unit IDs, not country/name-derived compatibility IDs.
- Organisation units remain in the Dex, map, search, stats, and viewer but are hidden from the Squadrons page.
- Map labels retain visible OpenStreetMap attribution; mobile prefers ICAO labels.

Deep links:

- `index.html#location=<location-id>`
- `index.html#location=<location-id>&detail=1`
- `index.html#photo=<photo-id>`
- `aircraft-dex.html#aircraft=<aircraft-id>`
- `squadrons.html#squadron=<unit-id>`
- `airshows.html#airshow=<event-id>`
- `stats.html#stats=summary|exif`

Legacy URLs are intentionally unsupported after the clean-break v2 migration.

## Commit scope

For catalog work, stage:

- `content/spotterdex.sqlite3`
- `content/spotterdex.sql`
- rebuilt `data/`
- rebuilt `share/`
- `sitemap.xml` and `robots.txt`
- changed `assets/generated/` and `assets/logos/`
- `service-worker.js` when the builder restamps its cache versions

Never stage `raw_assets/`, manager caches, quality acknowledgements/settings, Playwright artifacts, or database backups.

## Editing principles

- Keep the site static and GitHub Pages compatible.
- Do not add a frontend framework, bundler, runtime database, hidden map attribution, offline tile downloads, or tile prefetching.
- Maintain semantic controls, keyboard operation, useful alternative text, and responsive layouts.
- Preserve unrelated worktree changes.
- Removing a photo from the database does not delete generated derivatives automatically; rebuild and use the manager orphan detector.
