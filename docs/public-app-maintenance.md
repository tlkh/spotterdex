# Public app maintenance

Repository paths and commands below are relative to the repository root. See [agent instructions](../AGENTS.md) for task routing.

## Presentation layer

The six top-level pages are **generated**, not hand-maintained. `tools/build_pages.py` owns the shared `<head>`, header, navigation, and homepage portfolio cards; `tools/page_templates/*.html` holds the per-page body. The homepage selection lives in `tools/homepage_selection.json` and its photo metadata comes from `data/spotterdex.json`. `build_pages()` runs at the end of every site build, so hand-edits to `index.html`, `map.html`, `aircraft-dex.html`, `squadrons.html`, `airshows.html`, or `stats.html` are silently reverted on the next rebuild. Change the generator, selection, or template instead.

Two head details are load-bearing and are covered by tests in `tools/tests/test_site_contracts.py`:

- `viewport-fit=cover` on the viewport meta. `styles.css` positions the mobile tab bar and sheets with `env(safe-area-inset-*)`, which resolves to `0` on iOS without it.
- `tokens.css` is linked immediately before `styles.css`. Tokens must not be pulled in with `@import`, which would serialise the two stylesheet requests.

Styling is split between `tokens.css` (the semantic palette, spacing scale, and the three permitted eases) and `styles.css` (the page rules). `design.md` is the locked design system and describes the intended genre, palette, typography, motion, and mobile stance. `styles.css` still carries historical raw hex colours and `cubic-bezier()` curves; the ratchet test in `tools/tests/test_site_contracts.py` allows the current counts to fall but never rise, so new work must use tokens.

The public runtime uses classic scripts, not modules or a bundler. `script.js` owns shared state, navigation/history, search, archive filtering/pagination, and the photo viewer. `map-page.js`, `airshows-page.js`, and `stats-page.js` contain route-only renderers and load immediately before `script.js` on `map.html`, `airshows.html`, and `stats.html` respectively. The homepage portfolio is generated into `index.html` and uses the shared viewer. Aircraft and squadron renderers remain shared. Guard map-only calls in shared resize/reconnect handlers: those functions do not exist on other pages. Keep the local manager's sources separate.

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

- `index.html#work=<photo-id>` opens a selected homepage photograph.
- `map.html#location=<location-id>`
- `map.html#location=<location-id>&detail=1`
- `map.html#photo=<photo-id>`
- `aircraft-dex.html#aircraft=<aircraft-id>`
- `aircraft-dex.html#family=fighter|helicopter|light|medium|heavy`
- `squadrons.html#squadron=<unit-id>`
- `squadrons.html#country=<URL-encoded-country-name>`
- `airshows.html#airshow=<event-id>`
- `airshows.html#year=<YYYY>` (or `year=unknown`)
- `stats.html#stats=summary|exif`

Old `index.html#location=…` and `index.html#photo=…` links forward to the matching `map.html` route. Other legacy URLs are unsupported after the clean-break v2 migration.

## Public-app interaction maintenance

### Archives and navigation

- Aircraft family and squadron country controls are filters, not scroll-jump navigation. Keep the All option visible in the desktop controls and in the mobile country selector. At widths up to 1040px, aircraft family chips wrap so every choice remains discoverable; the desktop squadron country rail is replaced by the native `#squadronCountrySelect` control with per-country counts. Keep the select value, desktop `aria-pressed` state, URL hash, and session snapshot synchronized.
- Airshows filter by the year of `latestDate`, falling back to `firstDate`, matching the timeline's displayed date. A cross-year event appears in one year, not every year it spans. The selector includes per-year event counts and uses `unknown` for undated events; a requested absent year remains selectable with a zero count and a Show all years recovery action.
- Country URLs use URL-encoded display names (for example, `country=United%20States`), not country IDs. Year and country selections are stored in per-page session snapshots and restored from explicit URL filters. Changing a filter resets its mobile pagination; clearing it clears the filter hash. Preserve browser Back/Forward and detail-return behavior, not just reload behavior. Session snapshots are browser-local, not shareable saved collections.
- At widths up to 1040px, archives initially show 12 entries and progressively append more. Pagination must consume the filtered collection, especially for Airshows. Desktop renders the full filtered collection.
- Archive sticky bars use `--archive-sticky-top`, measured from the visible site header, on desktop; mobile bars stick at the top with safe-area padding and space for the search trigger. Their ancestor surfaces must use `overflow: clip`, not `overflow: hidden`, so viewport scrolling can drive sticky positioning.
- Keep archive openings compact and photographic rather than marketing heroes. Mobile uses a short title and inline collection totals before the working controls. Aircraft detail pages use a short field-guide hero and a flat archive browser; keep the first photo archive close to that browser. Stats totals belong in the dashboard, not a duplicate masthead. The Stats summary exposes six compact metrics: Photos, Photographed locations, Aircraft types, Squadrons, Map locations, and Countries photographed. Map locations count enabled pins; photographed locations and countries come from the photo collection. Use Photos for photograph counts; Types means aircraft types, not distinct registrations.

### Universal search

- Match and count the complete core-bundle index before limiting presentation. Initially display six matches per category; Show more appends six within that category. Both the overall summary and each group must distinguish shown counts from full matching totals. The category selector reports full counts even when another category is selected.
- Search categories are Aircraft, Squadrons, Locations, Airshows, and Photos. Photo matches open a contextual entity, not the viewer: prefer aircraft, then event, then a listed squadron, then location. Show the actual destination when available.
- Keep category and Show more controls outside the result listboxes. Synchronize `aria-controls`, `aria-expanded`, `aria-activedescendant`, and result `aria-selected` with rendered results. Keyboard focus and active result selection must agree, including after Tab and Show more.
- Cmd/Ctrl+K toggles search. The opening copy is `Archive search` / `Search SpotterDex`; keep the initial summary to one clear instruction. Up/Down select results; Home/End select first/last while the input is focused; Enter opens the selection; Escape closes. Do not intercept native selection keys on the category control. Suppress result updates and navigation shortcuts during IME composition, then refresh on composition end. Do not document fuzzy matching, server-side search, or a debounce as implemented.

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

The behavior tests execute JavaScript with Node.js and mocked browser dependencies; they skip when Node.js is unavailable, and skipped tests do not constitute complete verification. They cover search counts/pagination, IME guards, filter/history/session behavior, loading retries, viewer inert state, and non-map resize handling. Site contracts check generated markup, token usage, and layout rules. These are not end-to-end browser or screen-reader tests.

For interaction/CSS changes, serve the repository on loopback and check 390px mobile, 768px tablet, and 1440px desktop, plus 320px reflow, 200% zoom, reduced motion, and portrait/landscape resize. Exercise sticky controls after several screens of scrolling, confirm Aircraft family chips wrap, select a Squadron country from the mobile native control and verify the hash/result set, confirm the six Stats totals remain compact, and verify aircraft detail photos stay close to the short hero. Exercise Tab/Enter/Escape and IME search, filter links/reload/Back/Forward, viewer focus while information is collapsed, and blocked catalog/EXIF requests followed by Retry. Test offline/reconnect separately. Physical iOS/Safari checks remain necessary for safe areas, the software keyboard, gestures, and standalone updates.

Keep browser tooling and screenshots outside the repository; no frontend dependency is required for the Node-backed tests. Use the existing `.venv/bin/python` when system Python lacks build dependencies. Public runtime/template/style changes require regeneration so pages and the service-worker shell hash match the sources; documentation-only changes do not. A second unchanged build must leave generated output unchanged.
