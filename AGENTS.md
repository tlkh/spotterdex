# SpotterDex Maintenance Guide

This repository contains SpotterDex, a dependency-light static aircraft spotting field guide and aviation photography portfolio. It is intended to be hosted from the repository root on GitHub Pages.

## Agent Quick Reference

Read this section first before making changes.

- **Source of truth:** `aircraft/**/entry.yaml`, `map_pins/**/pins.yaml`, and files in `raw_assets/`. Do not hand-edit `data/`, `assets/generated/`, or published logo PNGs in `assets/logos/` except when debugging the build script.
- **After content changes, rebuild:** run `python3 tools/build_spotterdex.py` from the repo root. If system Python blocks pip, use a local venv: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python3 tools/build_spotterdex.py`.
- **Build progress:** `tools/build_spotterdex.py` shows dependency-free terminal progress bars for map pins, aircraft YAML, and photo processing when stderr is interactive. Use `--no-progress` for clean logs.
- **What gets committed for GitHub Pages:** `data/`, `assets/generated/photos/`, `assets/generated/thumbs/`, and `assets/logos/`. `raw_assets/` is gitignored and stays local.
- **Adding an aircraft entry:** create `aircraft/<aircraft-type-slug>/<squadron-slug>/entry.yaml`. Use slug-style folder names (`boeing-ah-64d-apache-longbow`, `120-squadron`, `air-development-and-test-wing`). The same squadron can appear under multiple aircraft types as separate folders.
- **Photos in YAML:** `photos` must be a list of objects with at least `path`. Never use `photos: ["file.jpg"]`. Put source images in `raw_assets/` and reference by filename (for example `path: 128925.jpg`) or by mirrored path (for example `path: photos/show-line.jpg`).
- **Photo resolution order:** mirrored `raw_assets/aircraft/<type>/<squadron>/<path>`, then beside the YAML entry, then flat `raw_assets/<path>`.
- **Map pin matching:** `location` must match a pin `name` in `map_pins/` exactly. Check the pin YAML before adding photos. Use `pin_id` when names are ambiguous.
- **Map pin ICAO codes:** add `icao: XXXX` to airport/air base pins when a code exists. Use an empty value for broad region pins or non-aerodrome locations without their own code. Mobile map labels prefer the ICAO code.
- **Squadron logos:** optional `squadron_logo: filename.png` resolves from `raw_assets/` the same way as photos. Raster logos are resized to max 512 px and copied to `assets/logos/`. SVG logos can live directly in `assets/logos/` and be referenced with a relative path such as `../../../assets/logos/149-squadron.svg`.
- **Organisation override:** use `unit_type: organisation` for airline/operator entries that should be labelled Organisation instead of Squadron. These records remain in the Dex and viewer but are excluded from the Squadrons page.
- **Dex grouping:** the UI groups by `aircraft_type`, not folder name. Multiple squadrons of the same type appear under one Dex card.
- **Do not add** frontend frameworks, bundlers, map tile prefetching, or hidden attribution.

## Site Structure

- `index.html` defines the static page shell, main tabs plus mobile dropdown navigation, map surface, Aircraft Dex view, Stats Dashboard view, Squadrons view, and full-screen photo viewer.
- `styles.css` contains responsive layout, light/dark tokens, map styling, cards, and viewer styling.
- `script.js` loads the generated data bundle and implements filtering, tabs, map pins, grouping, and photo-viewer behavior.
- `tools/build_spotterdex.py` reads source YAML and source photos, extracts EXIF, resizes photos, and writes static data files.
- `raw_assets/` is the centralized, gitignored source directory for all original photos to be processed. Mirror each entry folder under `raw_assets/aircraft/<aircraft_type>/<squadron>/`.
- `data/spotterdex.json` is the generated JSON manifest for debugging or external consumers.
- `data/spotterdex-data.js` is the generated browser data bundle loaded by `index.html`.
- `assets/generated/photos/` contains generated 2048px-wide JPEGs. Do not hand-edit these files.
- `assets/generated/thumbs/` contains generated thumbnail JPEGs for card and strip views. Do not hand-edit these files.
- `assets/logos/` contains squadron logo assets served by the site. Logos referenced from entry YAML are resolved from `raw_assets/` when needed, resized to a max width or height of 512 px during build, and published here. Hand-authored SVG logos can also live here directly.
- `assets/icons/aircraft-family-*.svg` contains the small map-label aircraft family icons for heavy, fighter, and helicopter sightings.
- `map_pins/<country_name>/pins.yaml` contains location pins.
- `aircraft/<aircraft_type>/<squadron>/entry.yaml` contains aircraft, squadron, logo, and photo metadata.
- The world map uses Leaflet 1.9.4 from a CDN and OpenStreetMap raster tiles. Keep visible map attribution in place.

## Editing Principles

- Keep the site static and GitHub Pages compatible. Do not add a build system, frontend framework, bundler, or runtime dependency unless the user explicitly asks.
- Keep files ASCII-only where practical.
- Preserve the professional aviation portfolio direction: modern, responsive, neutral surfaces with restrained accents.
- Treat YAML files and `raw_assets/` source photos as source of truth. Regenerate `data/`, `assets/generated/photos/`, and `assets/generated/thumbs/` with the build script after content changes.
- Store original photos in `raw_assets/`, not under `aircraft/` or in generated output folders.
- Do not manually edit generated data or resized photos unless debugging a generator issue; fix the source YAML, `raw_assets/` photos, or script instead.
- Keep full photo output as JPEG at 2048px wide and thumbnail output as JPEG at 1024px wide unless the user asks for different standards.
- Do not add tile prefetching, offline tile downloads, or hidden map attribution.
- Maintain accessibility basics: semantic controls, useful alt text, keyboard-operable viewer controls, and no text overlap on mobile.
- Avoid unrelated edits outside this `spotterdex/` folder.

## Data Contract

Map pin YAML should look like:

```yaml
country: Singapore
pins:
  - id: changi-exhibition-centre
    name: Changi Exhibition Center
    icao: WSSS
    coordinates: [1.3631, 104.0229]
    enabled: true
```

Aircraft YAML should look like:

```yaml
aircraft_type: Boeing F-15SG Strike Eagle
squadron_name: 149 Squadron
unit_type: squadron
country: Singapore
squadron_logo: ../../../assets/logos/149-squadron.svg
photos:
  - path: f-15sg-changi.jpg
    date: 2024-02-24
    year: 2024
    location: Changi Exhibition Center
    caption: High-speed pass over the Changi show line.
```

Common aircraft YAML fields:

- `aircraft_type` - display name and Dex card key
- `squadron_name` - operator or unit name
- `unit_type` - optional; defaults to `squadron`. Set to `organisation` for airline/operator entries that should use Organisation labels and stay off the Squadrons page.
- `country` - country shown in the UI
- `squadron_logo` - optional logo filename or relative path
- `photos` - list of photo objects

Each photo object supports at least `path`. Common optional fields: `date` (`YYYY-MM-DD`), `year`, `location`, `pin_id`, `caption`.

`squadron_logo` paths are resolved like photo paths: first beside the entry YAML, then under mirrored `raw_assets/`, then flat under `raw_assets/`. Raster logos are resized during build and written to `assets/logos/`.

Photo paths in entry YAML are relative to the matching entry folder. The build script resolves them from `raw_assets/` first, mirroring the entry path. For example, a photo listed as `photos/f-15sg-changi.jpg` in `aircraft/boeing-f-15sg-strike-eagle/149-squadron/entry.yaml` is read from `raw_assets/aircraft/boeing-f-15sg-strike-eagle/149-squadron/photos/f-15sg-changi.jpg`. A flat source file such as `N742CK.jpg` can also be referenced directly and resolved from `raw_assets/N742CK.jpg`. `location` is matched to a map pin by pin name. Use `pin_id` when names are ambiguous. The generated photo `date` prefers EXIF capture fields (`DateTimeOriginal`, then `DateTimeDigitized`) over YAML dates, then falls back to YAML `date`/`taken` fields. Do not use filesystem creation or modification dates for photo dates. Recent locations are ordered by the generated photo date.

The generated manifest includes per-photo `image`, `thumbnail`, `originalSize`, `processedSize`, `thumbnailSize`, and `exif` fields, plus per-aircraft `stats`. Generated JPEGs should retain source EXIF metadata, with Orientation normalized to `1` after pixel rotation. Keep those fields in sync with `script.js` when changing generator output.

Generated map pins include `icao` when present in `map_pins/**/pins.yaml`. The desktop map marker labels use full location names; the mobile map marker labels use `icao` when available, falling back to the full location name.

The `exif` object may include `Make`, `Model`, `LensModel`, `FocalLength`, `FNumber`, `ExposureTime`, `ISO`, `DateTimeOriginal`, `DateTimeDigitized`, and `DateTime`. The build script reads both the main EXIF IFD and the Exif sub-IFD from source images.

The generated manifest keeps compatibility fields such as `squadronName` and `squadronId`, and also emits `unitType`/`unitLabel` on photos and nested squadron records. `unitType: organisation` records have `showOnSquadronsPage: false`; the browser filters them out of the Squadrons tab while still showing them in Aircraft Dex, map grouping, search, stats, and the photo viewer.

## Build And Verification

Install dependencies only if needed:

```bash
python3 -m pip install -r requirements.txt
```

Regenerate the static bundle:

```bash
python3 tools/build_spotterdex.py
```

Useful build flags:

- `--raw-assets-dir raw_assets` sets the centralized source photo directory.
- `--logo-max-size 512` sets the max squadron logo width or height in pixels.
- `--no-progress` disables terminal progress bars, useful for CI or compact logs.
- `--make-demo-images` writes stylized placeholder source photos into matching `raw_assets/` entry folders.

Use strict validation for CI-like checks:

```bash
python3 tools/build_spotterdex.py --strict
```

Build warnings to understand:

- `photo source not found` - missing file in `raw_assets/` or wrong `path`
- `skipping invalid photo` - `photos` entry is not an object
- `squadron logo not found` - logo file missing from `raw_assets/`
- `photo has no matching map pin` - `location` does not match any pin name
- `note: N aircraft entries currently have no photos` - acceptable for placeholders

For sample/demo data with missing source photos:

```bash
python3 tools/build_spotterdex.py --make-demo-images
```

Demo images are written into the matching `raw_assets/` entry folders.

Recommended checks after edits:

```bash
python3 tools/build_spotterdex.py
node --check script.js
python3 -c "import json; json.load(open('data/spotterdex.json')); print('manifest ok')"
python3 -c "from PIL import Image; import pathlib; [print(p, Image.open(p).size) for p in pathlib.Path('assets/generated/photos').glob('*.jpg')]"
python3 -c "from PIL import Image; import pathlib; [print(p, Image.open(p).size) for p in pathlib.Path('assets/generated/thumbs').glob('*.jpg')]"
```

For local preview:

```bash
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

## Implementation Notes

- The browser app first reads `window.SPOTTERDEX_DATA` from `data/spotterdex-data.js`, then falls back to fetching `data/spotterdex.json`.
- Location and aircraft deep links use hash params: `#location=<pin-id>` and `#aircraft=<aircraft-id>`.
- The World Map view is a full-bleed map-first presentation on desktop and mobile: the Leaflet map fills the viewport below the header, with the Timothy Liu overview, recent locations, and selected-location photo results floating over it as glass panels. Mobile uses side-collapsible floating panels and compact ICAO marker labels when available. Keep marker labels visible and preserve map attribution.
- The Aircraft Dex view uses a two-column workspace: filters and the Latest frames sidebar live in the left panel, while entry cards and the selected-entry results panel live in the right column. Expanded aircraft entries show stats, squadron logos, and large image-first photo grids.
- The Squadrons view is a separate top-level tab that aggregates records with `unitType: squadron` by country and name, then displays prominent logo cards. Organisation records are intentionally hidden from this page. Clicking a squadron logo selects it and renders all viewable photos for that squadron in the detail grid below the logo gallery.
- The Stats Dashboard is the final top-level tab. It shows collection summary pairs plus the EXIF dashboard. Squadron totals should use the same country/name aggregation as the Squadrons view, not per-aircraft folder IDs.
- Desktop navigation uses tab buttons. Mobile navigation uses the `#viewSelect` dropdown; keep it synchronized with `data-tab-target` buttons in `setActiveTab`.
- The stats and EXIF dashboards are computed client-side from generated `pins`, `aircraft`, `squadrons`, `photos`, and `photos[].exif` in `script.js`; the Python build script only needs changes if generated field names or normalization rules change.
- Map pins use custom Leaflet `divIcon` markers over OpenStreetMap tiles, with a small custom in-app clustering layer in `script.js`. Marker labels are horizontal in-marker labels, not Leaflet tooltips, and may include one-em squadron/organisation logos plus aircraft-family SVG icons. Desktop labels use the pin name; mobile labels use `pin.icao` when present. Dedupe logos by unit identity, not generated logo filename, because the same logo may be published under multiple aircraft-specific names. If changing providers, preserve attribution and keep the site static/GitHub Pages compatible.
- The photo viewer reads grouped EXIF and frame metadata from the generated manifest. The Camera section shows lens model, focal length, aperture, shutter speed, and ISO only when those values are present in the manifest. Keep detailed capture timestamps hidden. The Frame Date row should prefer `DateTimeOriginal`, then fall back to YAML `year` when capture EXIF is absent. If EXIF is absent, the UI should still render a clear fallback.
- The build script validates duplicate IDs/names, coordinate ranges, missing generated files, unmatched photo pins, and missing dates. Notes for empty placeholder entries or pins without photos are acceptable during collection growth.
- The build script should continue to accept both `coordinates: [lat, lon]` and explicit `lat`/`lon` fields for map pins.
- If changing generated manifest shape, update `script.js`, sample YAML, and `README.md` together.
- Empty `photos: []` entries and enabled pins without photos are acceptable while the collection grows.
- Removing photos from YAML does not delete old generated JPEGs automatically; rebuild the manifest and delete orphaned files under `assets/generated/` if needed.
