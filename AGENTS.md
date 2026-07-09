# SpotterDex Maintenance Guide

This repository contains SpotterDex, a dependency-light static aircraft spotting field guide and aviation photography portfolio. It is intended to be hosted from the repository root on GitHub Pages.

## Agent Quick Reference

Read this section first before making changes.

- **Source of truth:** `aircraft/**/entry.yaml`, `squadrons/*/entry.yaml`, `map_pins/**/pins.yaml`, `airshows/events.yaml`, and files in `raw_assets/`. Do not hand-edit `data/`, `assets/generated/`, or published logo PNGs in `assets/logos/` except when debugging the build script.
- **After content changes, rebuild:** run `python3 tools/build_spotterdex.py` from the repo root. If system Python blocks pip, use a local venv: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python3 tools/build_spotterdex.py`.
- **Build progress:** `tools/build_spotterdex.py` shows dependency-free terminal progress bars for map pins, aircraft YAML, and photo processing when stderr is interactive. Use `--no-progress` for clean logs.
- **What gets committed for GitHub Pages:** `data/`, `share/`, `sitemap.xml`, `robots.txt`, `assets/generated/photos/`, `assets/generated/thumbs/`, and `assets/logos/`. `raw_assets/` is gitignored and stays local.
- **Adding an aircraft entry:** create `aircraft/<aircraft-type-slug>/<squadron-slug>/entry.yaml`. Use slug-style folder names (`boeing-ah-64d-apache-longbow`, `120-squadron`, `air-development-and-test-wing`). The same squadron can appear under multiple aircraft types as separate folders.
- **Photo tag levels:** aircraft-level photos live in `aircraft/<type>/<squadron>/entry.yaml`; squadron-only photos live in `squadrons/<squadron>/entry.yaml`; location-only photos live in a map pin's `photos:` list. Use the narrowest scope that accurately describes the frame.
- **Slug conventions:** lowercase ASCII, hyphen-separated. Aircraft folder = manufacturer + model (`kawasaki-up-3c-orion`, `lockheed-c-130r`, `mitsubishi-f-15j-eagle`). Squadron folder = short code when the unit has one (`vx-51`, `vrc-40`, `vr-57`), otherwise a descriptive slug (`air-transport-squadron-61`, `jasdf-electronic-warfare-squadron`, `air-development-and-test-wing`). Copy an existing entry in the same country or operator family when unsure.
- **Photos in YAML:** `photos` must be a list of objects with at least `path`. Never use `photos: ["file.jpg"]`. Put source images in `raw_assets/` and reference by filename (for example `path: 128925.jpg`) or by mirrored path (for example `path: photos/show-line.jpg`). Add optional `airshow: <event name>` to tag a frame with its airshow event.
- **Airshow heroes:** `airshows/events.yaml` optionally assigns one existing tagged source photo as an event hero. The manager writes this reference; do not use a generated photo path or duplicate the image.
- **Photo resolution order:** mirrored `raw_assets/<yaml-parent>/<path>` (for example `raw_assets/aircraft/...`, `raw_assets/squadrons/...`, or `raw_assets/map_pins/...`), then beside the YAML entry, then flat `raw_assets/<path>`. Flat filenames in `raw_assets/` are fine for one-off imports; mirrored folders are better when many photos belong to one entry.
- **`raw_assets/` is gitignored:** workspace search may not list it. Verify source files with shell `ls raw_assets/<filename>` or `find raw_assets -name '<pattern>'` before writing YAML. If photos are missing locally, tell the user to place them there; do not commit `raw_assets/`.
- **Map pin matching:** `location` must match a pin `name` in `map_pins/` exactly. Grep `map_pins/**/pins.yaml` before adding entries. Use the short aerodrome name in both pin and photo (`Atsugi Air Base`), not a longer caption form (`JMSDF Atsugi Air Base`). Add a new pin when the location is missing; use `pin_id` when names are ambiguous.
- **Map pin ICAO codes:** add `icao: XXXX` to airport/air base pins when a code exists. Use an empty value for broad region pins or non-aerodrome locations without their own code. Mobile map labels prefer the ICAO code.
- **Squadron logos and heroes:** optional `squadron_logo: filename.png` resolves from `raw_assets/` the same way as photos. Raster logos are resized to max 512 px and copied to `assets/logos/`. SVG logos can live directly in `assets/logos/` and be referenced with a relative path such as `../../../assets/logos/149-squadron.svg`. Optional `squadron_hero`/`squadron_hero_image` is processed as a web JPEG and displayed on the Squadrons page.
- **Organisation override:** use `unit_type: organisation` for airline/operator entries that should be labelled Organisation instead of Squadron. These records remain in the Dex and viewer but are excluded from the Squadrons page.
- **Dex grouping:** the UI groups by `aircraft_type`, not folder name. Multiple squadrons of the same type appear under one Dex card.
- **Commit scope for content work:** stage new/changed `aircraft/**/entry.yaml`, `squadrons/**/entry.yaml`, `map_pins/**/pins.yaml`, rebuilt `data/`, `share/`, `sitemap.xml`, `robots.txt`, and new/changed files under `assets/generated/` and `assets/logos/`. Never stage `raw_assets/`.
- **Local management app:** run `python3 tools/spotterdex_manager.py` for the local browser editor at `http://127.0.0.1:8765/`. It edits source YAML and can run the existing generator; it is not part of the published GitHub Pages site. Its Airshows tab groups all photos by capture date for mass event tagging, flags events without an explicit hero, and finds untagged photos whose capture date matches a known event day. Its Build Log tab includes an orphaned-file detector: "Find Orphans" lists generated JPEGs under `assets/generated/photos/` and `assets/generated/thumbs/` that the current `data/spotterdex.json` no longer references, and "Delete All" (or the per-row Delete) removes them after re-verifying they are unreferenced. Rebuild before scanning; the scan refuses to run when the manifest is missing or has zero photos so it cannot mass-delete valid output. Stop it with `Ctrl+C` after use or testing; do not leave the management app running.
- **Manager UI is static files, not an inline string:** the manager serves its browser UI from `tools/manager/app.html`, `tools/manager/app.css`, and `tools/manager/app.js`, read from disk on each request (edit them and refresh the browser; no restart needed). These are local-only tooling files and are never published to GitHub Pages. Edit these files rather than embedding markup in `spotterdex_manager.py`.
- **AI captions in the management app:** the AI Caption buttons send a server-resized 768px-wide source image plus aircraft type, squadron/operator, location, optional airshow event, and the current caption to Nemotron 3 Omni. Set `LLM_API_KEY` only in the manager process environment; never expose it to browser JavaScript, logs, generated data, or commits. Saving an AI-assisted suggestion writes the source-only `caption_ai_assisted: true` metadata marker. The Bulk Captions tab processes selected, existing human-written captions one at a time with a 0.5 second pause, filters prior AI-assisted captions by default, and requires a user to edit, accept, or reject every proposal.
- **Do not add** frontend frameworks, bundlers, map tile prefetching, or hidden attribution.

## Agent Workflows

### Add an aircraft entry from a user brief

Typical user input: aircraft type, squadron name, photo filenames, caption, and sometimes a location.

1. **Find precedents.** Read one or two similar `aircraft/**/entry.yaml` files (same country, operator, or aircraft family) and match their field style.
2. **Verify photos.** Confirm each filename exists under `raw_assets/` (flat or mirrored). Note the exact spelling and extension (`.jpg` vs `.jpeg`).
3. **Resolve the location.** Grep `map_pins/**/pins.yaml` for the aerodrome. If absent, add a pin with `id`, `name`, `icao` (when known), `coordinates: [lat, lon]`, and `enabled: true` in the correct country file (`map_pins/japan/pins.yaml`, `map_pins/singapore/pins.yaml`, etc.).
4. **Create the entry.** Write `aircraft/<aircraft-type-slug>/<squadron-slug>/entry.yaml` with `aircraft_type`, `squadron_name`, `country`, and one photo object per image. Set `location` to the pin `name` exactly. Repeat `caption` per photo unless the user gives per-frame captions.
5. **Rebuild.** Run `python3 tools/build_spotterdex.py` and fix any warnings (`photo source not found`, `photo has no matching map pin`).
6. **Sanity-check output.** Confirm new records appear in `data/spotterdex.json` and generated JPEGs exist under `assets/generated/photos/`.

Minimal entry example (flat `raw_assets/` photos):

```yaml
aircraft_type: Lockheed C-130R
squadron_name: Air Transport Squadron 61
country: Japan
photos:
  - path: jmsdf_c130_1.jpeg
    location: Atsugi Air Base
    airshow: Japan Air Self-Defense Force Air Show
    caption: JMSDF C-130R taking off from Atsugi Air Base
  - path: jmsdf_c130_2.jpeg
    location: Atsugi Air Base
    caption: JMSDF C-130R taking off from Atsugi Air Base
```

### Add squadron-only or location-only photos

- For a squadron/organisation image without a specific aircraft type, create `squadrons/<squadron-slug>/entry.yaml` with `squadron_name`, `country`, optional unit metadata, and `photos:`. Do not set `aircraft_type`. Mirror sources under `raw_assets/squadrons/<squadron-slug>/`.
- For a location image without a specific aircraft or squadron, add it to the target pin's `photos:` list. Each item needs `path`; the pin supplies `location` and `pin_id` automatically. Mirror sources under `raw_assets/map_pins/<country-slug>/`.
- The common optional fields remain `date`, `year`, `title`, `caption`, and `airshow`. Squadron-only photos also use `location`/`pin_id` as usual. `airshow` is a free-text event name and applies at all three tag scopes.

### Add a map pin

1. Pick the country YAML under `map_pins/<country_slug>/pins.yaml` (folder uses underscores: `hong_kong`, `japan`, `singapore`).
2. Append a pin with a unique `id` slug, human-readable `name`, `coordinates`, and `icao` for airfields.
3. Rebuild. The pin appears on the World Map even before photos reference it.

### Japan / JMSDF content patterns

- `country: Japan` on entries.
- Pin names follow `<Place> Air Base` or `<Place> Airport` (for example `Gifu Air Base`, `Atsugi Air Base`, `Naha Air Base`).
- JASDF wing/squadron logos often live in `raw_assets/` as `jasdf_*.png` (for example `jasdf_adtw.png`, `jasdf_ew_sqn.png`). Reference with `squadron_logo: jasdf_adtw.png` when applicable.
- ADTW-related squadrons commonly use folder `air-development-and-test-wing` and `squadron_name: Air Development and Test Wing`.
- US Navy-style JMSDF unit names with parenthetical codes map to short folder slugs: `Air Development Squadron 51 (VX-51)` -> `vx-51`.

### When the user asks to populate the project

Expect batches of aircraft entries, not one-off code changes. Work entry-by-entry: YAML + pin (if needed) + rebuild once at the end for a batch. Do not hand-edit `data/spotterdex-data.js` or generated JPEGs. If rebuild is skipped in the environment, still create correct source YAML and tell the user to run the build locally.

## Site Structure

- `index.html` defines the World Map page. `aircraft-dex.html`, `squadrons.html`, `airshows.html`, and `stats.html` define the other top-level pages. Each page keeps the shared desktop/mobile navigation; `script.js` injects the common full-screen photo viewer.
- `styles.css` contains responsive layout, light/dark tokens, map styling, cards, and viewer styling.
- `script.js` loads the generated data bundle and implements filtering, tabs, map pins, grouping, and photo-viewer behavior.
- `tools/build_spotterdex.py` reads source YAML and source photos, extracts EXIF, resizes photos, and writes static data files.
- `raw_assets/` is the centralized, gitignored source directory for all original photos to be processed. Mirror each source YAML parent under `raw_assets/`.
- `data/spotterdex.json` is the generated JSON manifest for debugging or external consumers.
- `data/spotterdex-data.js` is the generated full browser data bundle loaded by Aircraft Dex, Squadrons, Airshows, and Stats. `data/spotterdex-map-data.js` is the minified, metadata-light bundle loaded by the World Map; the viewer lazily fetches `data/spotterdex.json` when full EXIF metadata is needed.
- `share/` contains generated share/landing pages for photo, aircraft, location, squadron, and airshow links. Each is a self-canonical, indexable page with Open Graph/Twitter metadata, JSON-LD structured data (`ImageObject` for photos, `CollectionPage` for the other kinds), a static hero preview, and a call-to-action deep link into the app. They no longer auto-redirect. Do not hand-edit these pages; change `social_preview_document` in `tools/build_spotterdex.py` instead.
- `sitemap.xml` and `robots.txt` are generated at the repo root by `tools/build_spotterdex.py`. The sitemap lists the five top-level pages plus every share page that has content (placeholder collection pages with zero frames are skipped); `robots.txt` allows all crawlers and points to the sitemap. Because this is a GitHub Pages project site served under a subpath, submit the sitemap URL in Search Console (the host-level `robots.txt` lives in the user's root pages repo). Override paths with `--sitemap-output` / `--robots-output` if needed.
- `assets/generated/photos/` contains generated 2560px-wide JPEGs. Do not hand-edit these files.
- `assets/generated/thumbs/` contains generated thumbnail JPEGs for card and strip views. Do not hand-edit these files.
- `assets/logos/` contains squadron logo assets served by the site. Logos referenced from entry YAML are resolved from `raw_assets/` when needed, resized to a max width or height of 512 px during build, and published here. Hand-authored SVG logos can also live here directly.
- `assets/icons/aircraft-family-*.png` contains the small map-label aircraft family icons for fighter, helicopter, light, medium, and heavy sightings. `assets/icons/spotterdex-app-icon.png` is used for the navbar mark and favicon.
- `map_pins/<country_name>/pins.yaml` contains location pins.
- `airshows/events.yaml` stores optional event-hero references for the Airshows timeline.
- `aircraft/<aircraft_type>/<squadron>/entry.yaml` contains aircraft, squadron, logo, and photo metadata.
- `squadrons/<squadron>/entry.yaml` contains unit metadata and photos not assigned to one aircraft type.
- The world map loads pinned Leaflet 1.9.4 assets from the unpkg CDN without blocking the initial page shell, and uses remote OpenStreetMap raster tiles. Keep visible map attribution in place.

## Editing Principles

- Keep the site static and GitHub Pages compatible. Do not add a build system, frontend framework, bundler, or runtime dependency unless the user explicitly asks.
- Keep files ASCII-only where practical.
- Preserve the professional aviation portfolio direction: modern, responsive, neutral surfaces with restrained accents.
- Treat YAML files and `raw_assets/` source photos as source of truth. Regenerate `data/`, `assets/generated/photos/`, and `assets/generated/thumbs/` with the build script after content changes.
- Store original photos in `raw_assets/`, not under `aircraft/` or in generated output folders.
- Do not manually edit generated data or resized photos unless debugging a generator issue; fix the source YAML, `raw_assets/` photos, or script instead.
- Keep full photo output as JPEG at 2560px wide (quality 90, 4:4:4 chroma) and thumbnail output as JPEG at 1024px wide (quality 86, 4:2:0 chroma) unless the user asks for different standards.
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
    hero_photo: photos/changi-showline-hero.jpg
    photos:
      - path: photos/ramp-overview.jpg
        caption: Activity on the ramp.
    enabled: true
```

Aircraft YAML should look like:

```yaml
aircraft_type: Boeing F-15SG Strike Eagle
squadron_name: 149 Squadron
unit_type: squadron
country: Singapore
squadron_logo: ../../../assets/logos/149-squadron.svg
squadron_hero: photos/149-squadron-hero.jpg
photos:
  - path: f-15sg-changi.jpg
    date: 2024-02-24
    year: 2024
    location: Changi Exhibition Center
    airshow: Singapore Airshow 2024
    caption: High-speed pass over the Changi show line.
```

Common aircraft YAML fields:

- `aircraft_type` - display name and Dex card key
- `aircraft_family` - required map family: `fighter`, `helicopter`, `light` (single-engine propeller), `medium` (twin-engine narrow-body airliners, business jets, and regional or commuter turboprops), or `heavy` (any large aircraft in the four-engine size class and up: three- and four-engine aircraft, wide-body jets, and large transports, tankers, and maritime-patrol aircraft, including large twin-engine types such as the Kawasaki C-2, Boeing KC-46/KC-767, Airbus A330 MRTT, and Airbus A300-600ST). Size, not engine count, decides `heavy`: a big twin-engine transport or wide-body is `heavy`, while a narrow-body airliner such as the Boeing 737 or Airbus A320 stays `medium`.
- `squadron_name` - operator or unit name
- `unit_type` - optional; defaults to `squadron`. Set to `organisation` for airline/operator entries that should use Organisation labels and stay off the Squadrons page.
- `country` - country shown in the UI
- `squadron_logo` - optional logo filename or relative path
- `squadron_hero` - optional squadron-specific hero photograph shown on the Squadrons page
- `photos` - list of photo objects

Squadron-only YAML uses the same unit metadata and `photos` list, but omits `aircraft_type`. It belongs at `squadrons/<squadron-slug>/entry.yaml` and emits photos with `tagScope: squadron`. Map pin `photos` entries emit `tagScope: location`; the builder assigns their containing pin's name and ID, so do not supply a conflicting `location` or `pin_id`.

Map pins can optionally define a custom location hero. Use `hero_photo`/`hero_image`/`hero.path` for a source image path, resolved first from mirrored `raw_assets/map_pins/<country>/`, then beside the pin YAML, then from the repo root and flat `raw_assets/`. The build script publishes it through the same JPEG/thumbnail pipeline as normal photos. Use `hero_photo_id` when the hero should be an existing generated photo record and remain clickable in the viewer.

Each photo object supports at least `path`. Common optional fields: `date` (`YYYY-MM-DD`), `year`, `location`, `pin_id`, `airshow` (event name), `livery` (paint scheme), `caption`.

Airshow event metadata is optional. `airshows/events.yaml` uses the manager-written source reference format below; the selected photo must already be tagged with the same `airshow` name:

```yaml
events:
  - name: Singapore Airshow 2026
    hero_photo:
      scope: aircraft
      entry_path: aircraft/boeing-f-15sg-strike-eagle/149-squadron/entry.yaml
      index: 0
```

`squadron_logo` paths are resolved like photo paths: first beside the entry YAML, then under mirrored `raw_assets/`, then flat under `raw_assets/`. Raster logos are resized during build and written to `assets/logos/`.

`squadron_hero`/`squadron_hero_image` paths are resolved like photo paths and published to `assets/generated/photos/` plus `assets/generated/thumbs/` with a `squadron-hero-*` filename. Nested YAML can also use `squadron.hero.path`, `squadron.hero_image`, or `squadron.hero_photo`.

Photo paths are relative to the matching source YAML parent. The build script resolves them from `raw_assets/` first, mirroring that parent. For example, a photo listed as `photos/f-15sg-changi.jpg` in `aircraft/boeing-f-15sg-strike-eagle/149-squadron/entry.yaml` is read from `raw_assets/aircraft/boeing-f-15sg-strike-eagle/149-squadron/photos/f-15sg-changi.jpg`; a squadron-only image mirrors under `raw_assets/squadrons/<squadron>/`; and a pin image mirrors under `raw_assets/map_pins/<country>/`. A flat source file such as `N742CK.jpg` can also be referenced directly and resolved from `raw_assets/N742CK.jpg`. `location` is matched to a map pin by pin name. Use `pin_id` when names are ambiguous. The generated photo `date` prefers EXIF capture fields (`DateTimeOriginal`, then `DateTimeDigitized`) over YAML dates, then falls back to YAML `date`/`taken` fields. Do not use filesystem creation or modification dates for photo dates. Recent locations are ordered by the generated photo date.

The generated manifest includes per-photo `image`, `thumbnail`, `originalSize`, `processedSize`, `thumbnailSize`, and `exif` fields, plus per-aircraft `stats`. Generated JPEGs should retain source EXIF metadata, with Orientation normalized to `1` after pixel rotation. Keep those fields in sync with `script.js` when changing generator output.

Generated map pins include `icao` when present in `map_pins/**/pins.yaml`. They may also include `heroPhotoId` or `heroPhoto` when a custom location hero is configured. The desktop map marker labels use full location names; the mobile map marker labels use `icao` when available, falling back to the full location name.

The `exif` object may include `Make`, `Model`, `LensModel`, `FocalLength`, `FNumber`, `ExposureTime`, `ISO`, `DateTimeOriginal`, `DateTimeDigitized`, and `DateTime`. The build script reads both the main EXIF IFD and the Exif sub-IFD from source images.

The generated manifest keeps compatibility fields such as `squadronName` and `squadronId`, and also emits `tagScope` (`aircraft`, `squadron`, or `location`), optional `airshow`, `sourceRef`, and `unitType`/`unitLabel` on photos. Top-level `squadrons` records describe standalone squadron-only sources; the browser merges them with aircraft-attached unit records by country and name. Top-level `airshows` aggregate tagged photos and may contain `heroPhotoId` resolved from `airshows/events.yaml`. Squadron records may include `heroPhoto` when a squadron hero is configured. `unitType: organisation` records have `showOnSquadronsPage: false`; the browser filters them out of the Squadrons tab while still showing them in Aircraft Dex, map grouping, search, stats, and the photo viewer.

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

- The browser app first reads page-specific `window.SPOTTERDEX_DATA`: `index.html` loads `data/spotterdex-map-data.js`, while the other top-level pages load `data/spotterdex-data.js`. It falls back to fetching `data/spotterdex.json`; the map page also fetches that full manifest lazily when the photo viewer opens.
- Deep links are page-specific: `index.html#location=<pin-id>`, `index.html#location=<pin-id>&detail=1`, `aircraft-dex.html#aircraft=<aircraft-id>`, `squadrons.html#squadron=<squadron-id>`, `airshows.html#airshow=<airshow-id>`, and `stats.html#stats=summary|exif`. Photo deep links use `index.html#photo=<photo-id>`. Cross-page legacy hashes such as `index.html#aircraft=...` are unsupported and must not redirect.
- The World Map selected-location panel is a compact launch surface: its hero shows `ICAO - country`, aircraft-family and squadron marks, a link to the dedicated location page, and expandable latest-photo rows grouped by aircraft type and unit.
- The dedicated location page uses `#location=<pin-id>&detail=1`, follows the aircraft/squadron detail-page design, and shows location-scoped images before aircraft- and squadron-scoped frames. Location heroes are custom when `hero_photo`, `hero_image`, `hero.path`, or `hero_photo_id` exists on the pin; otherwise the UI prefers the newest location-scoped photo and then the newest photo at that pin.
- The World Map page is a full-bleed map-first presentation on desktop and mobile: the Leaflet map fills the viewport below the header, with the Timothy Liu overview, recent locations, and selected-location photo results floating over it as glass panels. Mobile uses side-collapsible floating panels and compact ICAO marker labels when available. Keep marker labels visible and preserve map attribution.
- The Aircraft Dex page uses a two-column workspace: filters and the Latest frames sidebar live in the left panel, while entry cards and the selected-entry results panel live in the right column. Expanded aircraft entries show stats, squadron logos, and large image-first photo grids.
- The Squadrons page aggregates records with `unitType: squadron` by country and name, then displays prominent logo/hero cards grouped into one subsection per country. Organisation records are intentionally hidden from this page. Clicking a squadron logo selects it and renders all viewable photos for that squadron in the detail grid below the logo gallery.
- The Airshows page presents the chronological event archive and keeps each event detail view on `airshows.html` with an `#airshow=<id>` hash.
- Squadron logo links in the viewer, World Map location detail, and Aircraft Dex should deep link to the aggregate Squadrons-page ID, `normalizeKey(country + "-" + squadron name)`, not the aircraft-specific generated squadron ID.
- The Stats page shows collection summary pairs plus the EXIF dashboard. Squadron totals should use the same country/name aggregation as the Squadrons page, not per-aircraft folder IDs.
- Desktop navigation uses links between the five top-level HTML pages. Mobile navigation uses the `#viewSelect` dropdown with matching page URLs; keep the selected option synchronized with the current page and its detail view.
- The stats and EXIF dashboards are computed client-side from generated `pins`, `aircraft`, `squadrons`, `photos`, and `photos[].exif` in `script.js`; the Python build script only needs changes if generated field names or normalization rules change.
- Map pins use custom Leaflet `divIcon` markers over OpenStreetMap tiles, with a small custom in-app clustering layer in `script.js`. Marker labels are horizontal in-marker labels, not Leaflet tooltips, and may include one-em squadron/organisation logos plus aircraft-family PNG icons. Desktop labels use the pin name; mobile labels use `pin.icao` when present. Dedupe logos by unit identity, not generated logo filename, because the same logo may be published under multiple aircraft-specific names. If changing providers, preserve attribution and keep the site static/GitHub Pages compatible.
- The photo viewer reads grouped EXIF and frame metadata from the generated manifest. The Camera section shows lens model, focal length, aperture, shutter speed, and ISO only when those values are present in the manifest. Keep detailed capture timestamps hidden. The Frame Date row should prefer `DateTimeOriginal`, then fall back to YAML `year` when capture EXIF is absent. If EXIF is absent, the UI should still render a clear fallback.
- The build script validates duplicate IDs/names, coordinate ranges, missing generated files, unmatched photo pins, and missing dates. Notes for empty placeholder entries or pins without photos are acceptable during collection growth.
- The build script should continue to accept both `coordinates: [lat, lon]` and explicit `lat`/`lon` fields for map pins.
- If changing generated manifest shape, update `script.js`, sample YAML, and `README.md` together.
- Empty `photos: []` entries and enabled pins without photos are acceptable while the collection grows.
- Removing photos from YAML does not delete old generated JPEGs automatically; rebuild the manifest and delete orphaned files under `assets/generated/` if needed.
- The current photo model supports three primary tag scopes: aircraft, squadron, and location. For mixed-aircraft frames, choose the best primary aircraft when one is clearly applicable; otherwise use squadron or location scope and describe the subjects in `caption` until a future `subjects` array is added to the generator and UI.
