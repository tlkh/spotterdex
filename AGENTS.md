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

Set `LLM_API_KEY` only in the manager process environment or the local, ignored root `.env` file for AI captions; `.env.example` documents the local setup. The caption assistant uses the internal Nemotron 3 Nano Omni deployment with `/think`, a 16,384-token output limit, and an 8,192-token reasoning budget. Never expose the key or hidden reasoning to browser JavaScript, logs, generated data, or commits.

## Manager UI maintenance

The local application is separate from the generated public pages: `tools/spotterdex_manager.py` serves the API, while `tools/manager/app.html`, `app.css`, and `app.js` are directly maintained UI sources. Do not move manager behavior into the public `script.js` or page templates.

Navigation and authoring contracts:

- **Photos:** New images handles raw-image attachment. Photo library owns existing-record editing through All photos and By source. Raw asset selection and library bulk selection are separate; captions use library selection, not the Assets drawer.
- **Catalog:** Aircraft, Units, and Locations each have local Details / Presentation navigation. Events owns event tagging, heroes, and cinematic segments; Page write-ups remains a separate catalog destination.
- **Review:** Captions, Missing, and Quality. **Output:** Build & verify.
- Keep `viewMeta`, `workspaceGroups`, renderers, and section IDs in sync. Internal routes such as `master`, `source-photos`, `aircraft`, `squadrons`, and `location-heroes` are not public-site URLs. The active manager route is retained in session storage; presentation routes must highlight their parent catalog destination.
- Photo editing still uses explicit save actions. There is no app-wide unsaved-change guard or persistent draft recovery; do not document these as implemented. Save before changing sources, reloading, or closing the app.

Caption review contracts:

- Scope is selected library photos (default), all matching library search results across pages, or all eligible photos. An empty library search matches all photos. Deduplicate canonical photo IDs/source paths; photos without captions are eligible when their raw sources exist.
- Freeze queue membership when generation begins. Stop finishes the current request; Resume processes remaining ready items; Retry failed processes generation failures only. None of these actions saves captions.
- Keep edited proposals across asynchronous rerenders, including focus and caret position. Accept saves once and marks the caption AI-assisted; a failed save retains the editable draft. Reject leaves the stored caption unchanged. Accepted/rejected states remain in the current queue.
- Scope/exclusion changes and Reset queue must confirm before discarding pending proposals and remain blocked during generation or caption saves. Raw asset selection must not reset a caption queue. Queue/proposal/review states are in-memory and are lost on a browser reload.
- `caption_ai_assisted` is provenance used by the default exclusion filter, not an accepted/rejected review status. Editing a caption does not automatically clear that marker. Caption acceptance uses canonical photo identity and refreshes metadata before saving; preserve unrelated fields, including livery. The refresh is not an atomic concurrency guarantee.

Accessibility and maintenance contracts:

- The utility drawer and raw-image preview use native `<dialog>` behavior. Preserve modal focus containment, Escape dismissal, and opener focus restoration. Drawer status belongs inside the modal so feedback remains visible and announced while the background is inert.
- Asset and quality filters are button groups with synchronized `aria-pressed`, not partial ARIA tablists. Primary/local navigation uses `aria-current="page"`. Inline New/Inspect actions need contextual accessible names.
- Quality review acknowledgements are local state, not image corrections. The confirmed QC_ prefix/approval actions rename raw files and update catalog paths through the manager; do not perform equivalent ad hoc filesystem renames or reorganize `raw_assets/`.
- Events can generate segments from EXIF calendar days or gaps over two hours, then manually reorder them. Only explicitly assigned photos appear in saved cinematic stories. Preview Draft is not Save Segments, and neither deploys the site.
- Build & verify generates local output only. It does not commit, push, or deploy. Keep success, failure, and lost-stream/unknown-completion messaging distinct. Orphan cleanup deletes generated derivatives, not raw originals; build before scanning.

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
node --check map-page.js
node --check airshows-page.js
node --check stats-page.js
node --check service-worker.js
node --check tools/manager/app.js
```

Manager UI regression tests run with `python3 -m unittest discover -s tools/tests -p test_manager_ui.py -v`; they use Node.js with mocked DOM/API behavior and do not call the caption service or mutate the catalog. Coverage includes shell initialization, nested navigation, dialog focus restoration, filter state, caption scopes, stop/resume/retry, and save recovery. Node.js must be available for the behavioral tests; otherwise those tests are skipped. If the system Python lacks Pillow or PyYAML, use the existing `.venv/bin/python` for Python verification commands.

For manager-only UI changes, run the focused tests, `node --check tools/manager/app.js`, and `git diff --check`; a public-site image rebuild is not needed unless catalog/build inputs also changed. Mocked tests do not verify actual layout, native focus trapping, or screen-reader announcements. Manually check keyboard Tab/Escape and focus return, filter states, desktop/narrow layouts, and caption edits during generation without sending real caption requests unless intended.

Builds are idempotent: rebuilding an unchanged catalog must leave the worktree clean. `generatedAt` is carried over from the previous manifest whenever the payload is otherwise identical, and generated text files are only rewritten when their content changes. A no-op rebuild that still dirties files is a bug worth investigating.

`.github/workflows/ci.yml` runs the repo-only subset of these checks on every push. Because `raw_assets/` is not committed, CI cannot run the image pipeline or the raw source-path checks, so it uses `python3 tools/spotterdex_catalog.py validate --skip-raw-assets` and verifies that the committed pages still match `tools/build_pages.py`. The full strict build remains a local step.

The builder opens the database read-only, validates relationships and raw paths, verifies the SQL snapshot, processes all photos through one pipeline, derives indexes and statistics, and writes:

- `data/spotterdex-core.js` — shared normalized browser bundle;
- `data/spotterdex.json` — complete normalized manifest;
- `data/spotterdex-exif.js` — Stats-only EXIF data;
- generated photos, thumbnails, and unit logos;
- share pages, sitemap, and robots file.

The published web profile in `tools/build_spotterdex.py` favours fast page loads over archival-grade derivatives: full JPEGs default to 2048 px wide at quality 60, thumbnails to 768 px wide at quality 50, both at 4:2:0 chroma subsampling. Sources at or below 1920 px wide are not upscaled beyond 1920 px. `raw_assets/` sources are never modified. Manager builds pass the current Build & verify form values, initially populated from `.spotterdex-manager-build-settings.json`; Save settings persists them for later sessions. The CLI accepts `--width`, `--thumb-width`, `--jpeg-quality`, and `--thumb-jpeg-quality`.

Informational build notes, such as empty enabled locations, are acceptable. Strict mode must have no warnings or errors.

## Deployment

The production site is served from the `main` branch through GitHub Pages at `https://tlkh.github.io/spotterdex/`. The repository remote is `origin` (`https://github.com/tlkh/spotterdex`).

When asked to deploy or push the latest work:

1. Inspect `git status`, preserve unrelated user changes, and confirm the current branch and remote before staging anything.
2. For catalog or source changes, run the full local build and verification sequence above. If `raw_assets/` is unavailable, use the repo-only CI validation command with `--skip-raw-assets` and say so in the handoff.
3. Review the generated diff. Stage only the requested source changes and their generated outputs; never stage `raw_assets/`, ignored manager settings/caches, Playwright artifacts, or backups.
4. Create a focused commit with a descriptive message.
5. Push the commit to `origin` on the requested branch. For the normal production deployment, push `main` with `git push origin main`.
6. Report the commit SHA, pushed branch, verification results, and any remaining GitHub Actions or Pages deployment status. Do not force-push, rewrite history, or use destructive Git commands unless explicitly requested.

The GitHub Actions CI workflow runs on every push. A successful push to `main` is the deployment handoff; GitHub Pages may take a short time to publish the new commit. Do not claim the live site is updated until the Pages deployment has completed or the user confirms it.

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

## Presentation layer

The five top-level pages are **generated**, not hand-maintained. `tools/build_pages.py` owns the shared `<head>`, header, and navigation; `tools/page_templates/*.html` holds the per-page body. `build_pages()` runs at the end of every site build, so hand-edits to `index.html`, `aircraft-dex.html`, `squadrons.html`, `airshows.html`, or `stats.html` are silently reverted on the next rebuild. Change the generator or the template instead.

Two head details are load-bearing and are covered by tests in `tools/tests/test_site_contracts.py`:

- `viewport-fit=cover` on the viewport meta. `styles.css` positions the mobile tab bar and sheets with `env(safe-area-inset-*)`, which resolves to `0` on iOS without it.
- `tokens.css` is linked immediately before `styles.css`. Tokens must not be pulled in with `@import`, which would serialise the two stylesheet requests.

Styling is split between `tokens.css` (the semantic palette, spacing scale, and the three permitted eases) and `styles.css` (the page rules). `design.md` is the locked design system and describes the intended genre, palette, typography, motion, and mobile stance. `styles.css` still carries historical raw hex colours and `cubic-bezier()` curves; the ratchet test in `tools/tests/test_site_contracts.py` allows the current counts to fall but never rise, so new work must use tokens.

The public runtime uses classic scripts, not modules or a bundler. `script.js` owns shared state, navigation/history, search, archive filtering/pagination, and the photo viewer. `map-page.js`, `airshows-page.js`, and `stats-page.js` contain route-only renderers and load immediately before `script.js` on their respective pages. Aircraft and squadron renderers remain shared. Guard map-only calls in shared resize/reconnect handlers: those functions do not exist on other pages. Keep the local manager's sources separate.

`plans/` holds completed motion and layout improvement plans, kept for history; current source and this guide take precedence over historical proposals.

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
- Updated workers remain waiting in the iOS standalone app shell until the in-page update card sends `SKIP_WAITING`; normal browser pages activate a waiting worker automatically and reload after `controllerchange`. Do not restore unconditional install-time activation. `GET_VERSION` supports the iOS update prompt, where “Later” is temporary and the prompt may return on the next foreground check.

## Site behavior

- All five pages load `data/spotterdex-core.js`.
- Stats loads `data/spotterdex-exif.js` on demand.
- The viewer lazily fetches `data/spotterdex.json` for full metadata.
- Universal search is injected by `script.js` and uses only the core bundle. It indexes aircraft, squadron-type units, enabled locations, events, and public photo metadata; photo matches open their aircraft, event, squadron, or location context rather than the viewer.
- Squadron pages use canonical unit IDs, not country/name-derived compatibility IDs.
- Organisation units remain in the Dex, map, search, stats, and viewer but are hidden from the Squadrons page.
- Map labels retain visible OpenStreetMap attribution; mobile prefers ICAO labels.

Deep links:

- `index.html#location=<location-id>`
- `index.html#location=<location-id>&detail=1`
- `index.html#photo=<photo-id>`
- `aircraft-dex.html#aircraft=<aircraft-id>`
- `aircraft-dex.html#family=fighter|helicopter|light|medium|heavy`
- `squadrons.html#squadron=<unit-id>`
- `squadrons.html#country=<URL-encoded-country-name>`
- `airshows.html#airshow=<event-id>`
- `airshows.html#year=<YYYY>` (or `year=unknown`)
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

Never stage `raw_assets/`, manager caches, quality acknowledgements/settings, build settings, Playwright artifacts, or database backups.

## Editing principles

- Keep the site static and GitHub Pages compatible.
- Do not add a frontend framework, bundler, runtime database, hidden map attribution, offline tile downloads, or tile prefetching.
- Maintain semantic controls, keyboard operation, useful alternative text, and responsive layouts.
- Preserve unrelated worktree changes.
- Removing a photo from the database does not delete generated derivatives automatically; rebuild and use the manager orphan detector.

## Public-app interaction maintenance

### Archives and navigation

- Aircraft family and squadron country controls are filters, not scroll-jump navigation. Squadron filtering and `aria-pressed` state must agree on desktop and mobile; keep the All option visible at every width.
- Airshows filter by the year of `latestDate`, falling back to `firstDate`, matching the timeline's displayed date. A cross-year event appears in one year, not every year it spans. The selector includes per-year event counts and uses `unknown` for undated events; a requested absent year remains selectable with a zero count and a Show all years recovery action.
- Country URLs use URL-encoded display names (for example, `country=United%20States`), not country IDs. Year and country selections are stored in per-page session snapshots and restored from explicit URL filters. Changing a filter resets its mobile pagination; clearing it clears the filter hash. Preserve browser Back/Forward and detail-return behavior, not just reload behavior. Session snapshots are browser-local, not shareable saved collections.
- At widths up to 1040px, archives initially show 12 entries and progressively append more. Pagination must consume the filtered collection, especially for Airshows. Desktop renders the full filtered collection.
- Archive sticky bars use `--archive-sticky-top`, measured from the visible site header, on desktop; mobile bars stick at the top with safe-area padding and space for the search trigger. Their ancestor surfaces must use `overflow: clip`, not `overflow: hidden`, so viewport scrolling can drive sticky positioning.
- Keep archive openings compact and photographic rather than marketing heroes. Mobile uses a short title and inline collection totals before the working controls. Stats totals belong in the dashboard, not a duplicate masthead. Use Photos for photograph counts; Types means aircraft types, not distinct registrations.

### Universal search

- Match and count the complete core-bundle index before limiting presentation. Initially display six matches per category; Show more appends six within that category. Both the overall summary and each group must distinguish shown counts from full matching totals. The category selector reports full counts even when another category is selected.
- Search categories are Aircraft, Squadrons, Locations, Airshows, and Photos. Photo matches open a contextual entity, not the viewer: prefer aircraft, then event, then a listed squadron, then location. Show the actual destination when available.
- Keep category and Show more controls outside the result listboxes. Synchronize `aria-controls`, `aria-expanded`, `aria-activedescendant`, and result `aria-selected` with rendered results. Keyboard focus and active result selection must agree, including after Tab and Show more.
- Cmd/Ctrl+K toggles search. Up/Down select results; Home/End select first/last while the input is focused; Enter opens the selection; Escape closes. Do not intercept native selection keys on the category control. Suppress result updates and navigation shortcuts during IME composition, then refresh on composition end. Do not document fuzzy matching, server-side search, or a debounce as implemented.

### Recovery and viewer accessibility

- Distinguish no matching content from unavailable data. Filtered empty states offer in-place Show all actions. A catalog load failure displays an inline retry action rather than reporting an empty catalog as success.
- Camera-data failures expose Retry camera data. Failed EXIF script and render promises must not block later retries, while in-flight requests remain deduplicated. Failed full-photo metadata requests also release their promise so a later viewer/detail request can retry; there is no separate full-metadata Retry button.
- Search and viewer overlays isolate the background with `inert`, contain focus, and restore opener focus where possible. A collapsed mobile viewer-info panel is both inert and `aria-hidden`; opacity and transforms alone do not remove its controls from keyboard navigation. Restore interactivity when it opens or switches to the always-visible desktop sidebar.
- Viewer Left/Right navigation prevents default scrolling; +/=, -, and 0 adjust/reset zoom. Escape first closes open mobile photo information, then closes the viewer. Recheck these states after viewport resize and orientation changes.
- Offline status and image fallbacks remain usable without suggesting every image is cached. The offline shell does not download the complete photo archive or map tiles. Keep waiting-worker activation and the iOS update prompt behavior described above.

### Public-app verification

Focused checks, in addition to the full build/verification workflow:

```bash
python3 -m unittest tools.tests.test_site_contracts tools.tests.test_script_behaviors tools.tests.test_archive_routes -v
node --check script.js
node --check map-page.js
node --check airshows-page.js
node --check stats-page.js
git diff --check
```

The behavior tests execute JavaScript with Node.js and mocked browser dependencies; they skip when Node.js is unavailable. They cover search counts/pagination, IME guards, filter/history/session behavior, loading retries, viewer inert state, and non-map resize handling. Site contracts check generated markup, token usage, and layout rules. These are not end-to-end browser or screen-reader tests.

For interaction/CSS changes, serve the repository on loopback and check 390px mobile, 768px tablet, and 1440px desktop, plus 320px reflow, 200% zoom, reduced motion, and portrait/landscape resize. Exercise sticky controls after several screens of scrolling, Tab/Enter/Escape and IME search, filter links/reload/Back/Forward, viewer focus while information is collapsed, and blocked catalog/EXIF requests followed by Retry. Test offline/reconnect separately. Physical iOS/Safari checks remain necessary for safe areas, the software keyboard, gestures, and standalone updates.

Keep browser tooling and screenshots outside the repository; no frontend dependency is required for the Node-backed tests. Use the existing `.venv/bin/python` when system Python lacks build dependencies. Public runtime/template/style changes require regeneration so pages and the service-worker shell hash match the sources; documentation-only changes do not. A second unchanged build must leave generated output unchanged.
