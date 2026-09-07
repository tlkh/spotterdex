# SpotterDex

SpotterDex is a dependency-light static aircraft spotting field guide and aviation photography portfolio. It is built for GitHub Pages and served directly from the repository root.

## Using the public web app

The public site is a read-only field guide; catalog editing happens in the separate local manager below.

| View | Browse by | Main interaction |
| --- | --- | --- |
| World Map | Photographed locations | Select a marker or browse Locations, then open photos or the location detail. |
| Aircraft Dex | Aircraft family | Filter the aircraft index, then open a type's operators, locations, and photos. |
| Squadrons | Country | Filter units consistently on desktop and mobile; All restores the full squadron collection. Organisation units are not listed here. |
| Airshows | Year, newest first | Choose a year with an event count, then open an event's field report/story. |
| Stats | Overview / Camera data | Inspect collection coverage or load camera metadata on demand. |

Archive openings are deliberately compact. Mobile keeps family/country/year controls available while scrolling and progressively loads entries in batches of 12; desktop shows all entries matching the filter. The five-item bottom navigation remains the main mobile navigation, except while viewing a photo. Photograph counts use **Photos**; aircraft **Types** are not counts of unique registrations.

### Search

Use the magnifying-glass control or **Cmd/Ctrl+K**. Search covers aircraft, squadrons, enabled locations, events, and public photo metadata from the core catalog. Try an aircraft type, ICAO code, squadron, event, photo title, or date.

- Results are grouped by category, initially showing up to six per category. **Showing N of M** reports the visible subset and full matching total; it is not a count of just the first page.
- Use **Category** to narrow the results, or **Show more** to reveal another six in a group. Category options retain their full matching counts.
- A photo result opens its aircraft, event, squadron, or location context rather than the full-screen viewer. Its destination is shown in the result.
- Up/Down select results, Enter opens the selected/focused result, and Escape closes search. Home/End select the first/last result while the search input is focused. Tab also reaches the category and Show more controls. IME composition is not treated as a navigation command.

Search is local to the published core bundle, not an online query against the authoring database. New catalog edits become public only after building and deploying.

### Filters, history, and recovery

Country and Airshow year filters can be shared using URL hashes listed under Local preview. Explicit filter links restore the selection; browser Back/Forward restores navigation, and per-page session storage retains local browsing state. Session state is not a cross-device saved collection. Changing a filter restarts mobile pagination; **Show all** recovers from a filtered empty state.

The Airshow year is the year of the event's displayed latest date, falling back to its first date. An event spanning two years appears in one year. Undated events use **Date unknown** (`year=unknown`); a link to a year without events offers **Show all years**.

If the catalog cannot load, an inline **Retry loading catalog** action replaces silent failure. **Retry camera data** retries a failed Stats metadata request. A failed full-photo metadata request can retry on a later viewer/detail request; it has no separate retry button. Offline image fallbacks do not imply the entire archive has been downloaded.

### Photo viewer

Open a photo from its collection/detail context. Left/Right move through the current photo set; +/= and - adjust zoom, and 0 resets it. On mobile, photo information is a separate sheet: Escape closes an open information sheet first, then the viewer. The tab bar is hidden while the viewer is open.

Search and viewer dialogs contain keyboard focus and isolate the background. Collapsed mobile photo information is removed from keyboard interaction, and closing it returns contained focus to the information control. Closing an overlay restores its opener when available. These states must remain correct when rotating a device or resizing between mobile and desktop.

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

Open `http://127.0.0.1:8765/` and stop the server with `Ctrl+C` when finished. Use `--open` to open the browser automatically or `--port <port>` to choose another port. Keep the default loopback host for local authoring.

If system Python is missing Pillow or PyYAML and the project virtual environment already exists, launch with `.venv/bin/python tools/spotterdex_manager.py`. Otherwise install the dependencies from `requirements.txt` in your Python environment.

### Finding the right workspace

| Navigation | Purpose |
| --- | --- |
| Photos → New images | Select flat raw assets and attach them with shared metadata. |
| Photos → Photo library | Search and edit existing records in All photos, or use By source for the source-specific editor and bulk actions. |
| Catalog → Aircraft | Details creates/manages aircraft–unit photo sources; Presentation selects aircraft heroes and Automatic, Standard, or Double card widths. |
| Catalog → Units | Details manages squadron/organisation photo sources; Presentation manages squadron heroes and unit logos. |
| Catalog → Locations | Details manages location/map metadata; Presentation selects location heroes. |
| Catalog → Events | Manage event photo tags, event heroes, and cinematic story segments. |
| Catalog → Page write-ups | Edit optional Markdown for aircraft, squadron, and event pages. |
| Review → Captions / Missing / Quality | Review caption suggestions, resolve missing metadata, or assess source images. |
| Output → Build & verify | Build local output, inspect logs/changes, back up the database, and clean orphaned generated files. |

Aircraft, Units, and Locations use local **Details / Presentation** navigation rather than separate database and display-settings sidebar destinations. The manager remembers the active workspace for the browser session.

### Attach new images and edit existing records

1. Keep original images flat in `raw_assets/`; open **New images** and select them in **Assets**. New/All/Used filters refer to whether an asset is already tagged.
2. Choose the photo source and location, then optional event, livery, date, year, and caption. Inline **New** and **Inspect** buttons create or inspect related records without leaving the workflow.
3. Review the selected images and shared metadata before **Attach Selected**. The shared caption applies to every selected image; single-image AI Caption requires one selected image. EXIF capture date takes precedence over the fallback date during generation.
4. For existing photos, use **Photo library → All photos** and save each edited row. **By source** provides the individual photo editor and source-specific bulk editing; opening a source from the catalog also leads here.
5. Use the library's selection checkboxes for bulk metadata edits or **Review selected captions**. Library selection is separate from raw asset selection, including selections made in the Assets drawer.

Successful catalog writes are transactional and refresh `content/spotterdex.sql`; they do not rebuild the public site. Save edits before changing sources, using Reload, or closing the browser: there is no app-wide unsaved-change guard or persistent draft recovery. A checked bulk field with a blank value can clear existing metadata, so review the selected fields and photo count before applying.

Removing/detaching a photo removes its catalog record, not the original raw file, and can clear hero references. Generated derivatives may remain until a rebuild and orphan cleanup. Use **Backup Database** before substantial catalog maintenance.

### Caption review queue

Set `LLM_API_KEY` only in the manager process environment or the local, ignored root `.env` file when using AI captions. Copy `.env.example` to `.env` and fill in the key if preferred. It is never sent to browser JavaScript or written to the catalog.

Caption assistance uses the internal Nemotron 3 Nano Omni deployment with high reasoning (`/think`), a 16,384-token output limit, and an 8,192-token reasoning budget. Optional endpoint/model overrides are documented in `.env.example`.

1. Select photos in **Photo library** and choose **Review selected captions**, or open **Review → Captions** and select a queue scope:
   - **Selected library photos** (default): the library's selected records.
   - **All matching library search results**: every match across all pages, not just the visible page. An empty search matches all photos.
   - **All eligible photos**: all available eligible source photos.
2. Check the eligible count and **Exclude captions already assisted by AI** option. Photos without captions are eligible; missing raw sources are not. Photos with multiple subjects appear only once.
3. Choose **Propose Captions**. Queue membership is fixed at this point; changing library selection/search does not silently replace the queue.
4. Compare the current caption with the editable proposed-caption field. **Accept Caption** saves that proposal as AI-assisted; **Reject** leaves the stored caption unchanged. Accepted/rejected states stay visible in the queue. A failed save preserves the proposal for another acceptance attempt.
5. **Stop after current photo** lets the in-flight request finish. **Resume Queue** generates remaining ready items without replacing proposals; **Retry failed** retries generation errors only. To retry a failed save, use **Accept Caption** again.
6. **Reset queue**, scope changes, and exclusion changes ask before discarding pending proposals. These controls are disabled while generation or caption saves are active.

Generation never saves captions automatically. Edited proposals retain their text and caret during asynchronous list refreshes, but queue membership, unsaved proposals, and review states live only in browser memory and are lost on reload. Raw asset selection does not reset the queue.

AI-assisted is provenance, not a synonym for reviewed or accepted. It remains set when an assisted caption is subsequently edited and is omitted from public payloads. The explicit CLI marker reset below clears those flags without changing caption text.

### Missing metadata and image quality

**Missing** provides a searchable queue and an adjacent editor for incomplete metadata. **Quality** starts scanning in the background so the manager can open before the scan finishes. Review Hard failures, Warnings, or QC_ edits passed; **Show reviewed** includes acknowledged findings. Acknowledging a finding does not fix the source image.

The current Quality UI offers an autosaved empty-space toggle for frames with more than 80% low-detail sky/background. This is advisory, not an automatic rejection. Quality settings and acknowledgements are local ignored state, not public catalog metadata.

QC_ prefix actions are real filename changes, not merely badges: after confirmation the manager renames eligible raw sources and updates catalog paths. Approval removes the prefix from qualifying images that pass the checks. Use these managed actions rather than manually renaming or reorganizing raw files.

### Events and presentation

In **Catalog → Events**, tag event photos, select an optional event hero, and author **Cinematic Segments**. EXIF generation splits on a new calendar day or a capture-time gap over two hours; it does not infer an official display schedule. The first photo in each segment is its hero. Assign/move photos, sort by capture time, remove duplicate assignments, and use the segment up/down controls to set the saved order. Coverage highlights photos not assigned to a segment; they are not silently inserted into the story.

**Preview Draft** previews unsaved segments. Use **Save Segments** to persist them; previewing or saving does not publish the live site. For other entity heroes and aircraft card widths, use the entity's **Presentation** section. See Airshow immersive experience below for the public rendering behavior.

### Build locally, then publish separately

**Build & verify → Build locally** validates/builds local generated output and shows progress, a log, and generated-file changes. It does not commit, push, or deploy to GitHub Pages. Success and failure are explicitly distinguished; a lost build stream means completion is unknown, not that the build succeeded.

The current image-width/JPEG-quality form values are used for the next build. **Save settings** keeps them in `.spotterdex-manager-build-settings.json` for future sessions; **Reset defaults** restores the defaults. Use **Backup Database** for an ignored local backup and **Clear Build Cache** when you need to invalidate cached image processing.

Build before **Find Orphans**. Review the listed generated files before deleting them; orphan cleanup is irreversible and does not delete raw originals. Follow Publishing below after reviewing the successful build output.

### Manager development and accessibility checks

The UI source is `tools/manager/app.html`, `app.css`, and `app.js`; the local API is `tools/spotterdex_manager.py`. These are separate from the generated public pages and their templates.

```bash
python3 -m unittest discover -s tools/tests -p test_manager_ui.py -v
node --check tools/manager/app.js
git diff --check
```

Use `.venv/bin/python` in place of `python3` if needed. The behavior tests require Node.js and use mocked DOM/API responses, with no caption-service calls or catalog writes. They cover navigation, drawer focus restoration, filter states, caption scope/deduplication, stop/resume/retry, draft preservation, and save failures. They do not replace real-browser checks.

For UI changes, also check desktop/narrow layouts, Tab/Escape behavior, focus return after closing drawers, announced feedback, and editing a proposal while another suggestion completes. The utility drawer and image preview are native modal dialogs; asset/quality filters are pressed-state button groups. Keep browser audit tooling and screenshots outside the repository. Manager-only UI edits do not require an image rebuild.

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

Run full local verification (the image build requires local raw sources):

```bash
python3 tools/build_spotterdex.py --strict --no-progress
python3 tools/spotterdex_catalog.py validate
python3 -m unittest discover -s tools/tests -v
node --check script.js
node --check map-page.js
node --check airshows-page.js
node --check stats-page.js
node --check service-worker.js
node --check tools/manager/app.js
```

Rebuilding an unchanged catalog is a no-op: `generatedAt` is reused when the payload is identical and generated text files are only rewritten on real changes, so a clean worktree stays clean.

`.github/workflows/ci.yml` runs the repo-only checks on every push. `raw_assets/` is not committed, so CI validates with `--skip-raw-assets`, skips the image pipeline, and asserts the committed pages still match `tools/build_pages.py`.

The builder reads SQLite in read-only mode, validates the catalog and SQL snapshot, processes photos, derives entity indexes and statistics, and generates:

- `data/spotterdex-core.js` — shared normalized payload cached by all pages;
- `data/spotterdex.json` — complete normalized v2 manifest;
- `data/spotterdex-exif.js` — Stats-only EXIF payload;
- processed photos, thumbnails, and unit logos;
- share pages, `sitemap.xml`, and `robots.txt`.

The published web profile favours fast page loads over archival-grade derivatives. Full JPEGs default to 2048 px wide at quality 60; thumbnails default to 768 px wide at quality 50, both at 4:2:0 chroma subsampling. Sources at or below 1920 px wide are not upscaled beyond 1920 px. `raw_assets/` originals are never modified. Manager builds pass the current Build & verify form values; saved defaults for future sessions live in `.spotterdex-manager-build-settings.json`. The CLI accepts `--width`, `--thumb-width`, `--jpeg-quality`, and `--thumb-jpeg-quality`.

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
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/`.

Top-level pages are `index.html`, `aircraft-dex.html`, `squadrons.html`, `airshows.html`, and `stats.html`. All load the same shared core bundle; the Stats page loads EXIF separately, and the viewer hydrates the full manifest when needed.

These five pages are generated by `tools/build_pages.py` from `tools/page_templates/`, which the site build runs on every pass. Editing the HTML directly is reverted by the next build; change the generator or template. Styling is split between `tokens.css` (semantic palette, spacing, easing) and `styles.css`, with `design.md` as the locked design system.

Shared behavior lives in `script.js`; map, Airshow, and Stats renderers live in `map-page.js`, `airshows-page.js`, and `stats-page.js`. Those route-only classic scripts load before the shared runtime only on the page that needs them. Aircraft and squadron rendering remains in the shared runtime. Shared resize/reconnect handlers must not call absent route-only functions.

`service-worker.js` provides the installable offline shell declared by `manifest.webmanifest`. Navigations are cache-first with a background refresh; catalog payloads are network-first; other precached shell assets use stale-while-revalidate. Runtime thumbnail and full-photo caches are capped at 80 and 12 entries respectively. This is not an offline download of the entire photo archive, and map tiles are not prefetched. Both cache-version strings are stamped by the builder from precached assets and the image profile, never edited manually.

In normal browser pages, a waiting worker activates automatically and the page reloads after control changes. In the iOS standalone app, the in-page update card activates it; Later is temporary and the prompt may return on the next foreground check. Do not assume all cached HTML/assets switch to the new deployment before worker activation.

Entity detail links use semantic IDs; archive filters use the values shown below:

- `index.html#location=<location-id>`
- `index.html#location=<location-id>&detail=1`
- `index.html#photo=<photo-id>`
- `aircraft-dex.html#aircraft=<aircraft-id>`
- `aircraft-dex.html#family=fighter|helicopter|light|medium|heavy`
- `squadrons.html#squadron=<unit-id>`
- `squadrons.html#country=<URL-encoded-country-name>` (for example, `country=United%20States`)
- `airshows.html#airshow=<event-id>`
- `airshows.html#year=<YYYY>` (or `year=unknown`)
- `stats.html#stats=summary|exif`

The v2 migration is intentionally a clean break; legacy IDs and URLs are not redirected.

## Public-app regression checks

For a focused iteration on the public UI:

```bash
python3 -m unittest tools.tests.test_site_contracts tools.tests.test_script_behaviors tools.tests.test_archive_routes -v
node --check script.js
node --check map-page.js
node --check airshows-page.js
node --check stats-page.js
git diff --check
```

Use `.venv/bin/python` if system Python lacks the build dependencies. Node.js is required for the JavaScript behavioral cases; they are skipped if it is missing. These tests use mocked browser dependencies, not a live browser: they cover search totals and incremental results, country/year state and history handling, IME guards, loading retries, viewer focus/inert state, and non-map resize safety. The site-contract tests also check generated page consistency and token/layout rules.

For CSS or interaction changes, check the running site at 390px, 768px, and 1440px, plus 320px reflow and 200% zoom. Test reduced motion and portrait/landscape resize. Scroll past several archive screens before changing filters; exercise filter links with reload and Back/Forward; use Tab, Enter, Escape, and IME input in search; confirm hidden viewer information cannot receive focus. Simulate blocked catalog and camera-data requests, then unblock and Retry, and test offline/reconnect separately. Browser checks do not replace physical iOS/Safari testing for safe areas, the software keyboard, gestures, or installed-app updates.

Keep browser tooling/screenshots outside the repository. After public runtime, template, or style changes, run the full build so generated pages and service-worker cache stamps stay current, then verify a second build does not change generated output. Documentation-only edits do not require a rebuild. Preserve unrelated manager/catalog changes when reviewing or staging.

## Publishing

A Manager build updates local files only. After validation and review, commit the intended changes and push to `origin main` for the normal GitHub Pages deployment. A successful push is the deployment handoff; confirm the Pages deployment completed before treating the live site as updated. `AGENTS.md` contains the full deployment checklist.

Commit the canonical database and SQL snapshot together with generated `data/`, `share/`, `sitemap.xml`, `robots.txt`, `assets/generated/`, and `assets/logos/`, plus `service-worker.js` whenever the build restamps its cache versions. Never commit `raw_assets/`, `.spotterdex-manager-cache/`, `content/backups/`, or the ignored manager-local state files (`.spotterdex-manager-quality.json`, `.spotterdex-manager-quality-settings.json`, `.spotterdex-manager-build-settings.json`).

Keep the site static and preserve visible OpenStreetMap attribution. Do not add map-tile prefetching, hidden attribution, a frontend framework, or a bundler.
