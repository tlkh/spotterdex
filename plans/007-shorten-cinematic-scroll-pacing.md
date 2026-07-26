# 007 — Shorten cinematic scroll pacing

- **Status**: DONE
- **Commit**: 2d7e8651
- **Severity**: MEDIUM
- **Category**: Purpose & frequency; Easing & duration
- **Estimated scope**: 6 files plus the managed catalog, about 25 lines changed

## Problem

The Komatsu cinematic track is approximately 13,844px tall at a 1440×900
viewport. Its intro uses a 1.55× stage height and most moments use 1.35×, with
two moments at 1.50×. This makes ordinary wheel/trackpad input feel as though it
has excess inertia and increases the time spent continuously compositing.

```js
// script.js:5034, 5057 — current
scrollWeight: Math.min(2.5, Math.max(0.6, Number(moment.scrollWeight) || 1.35)),
// ...
scrollWeight: 1.55,
```

```js
// tools/manager/app.js:841 — current
scrollWeight: index === 0 ? 1.5 : 1.35,
```

Route buttons additionally request a browser-defined long smooth scroll over
many thousands of pixels, which compounds the perceived momentum.

```js
// script.js:5240 — current
window.scrollTo({
  top: Math.max(0, target.start - window.innerHeight * 0.08),
  behavior: reduceMotion ? "auto" : "smooth"
});
```

## Target

- New story moments default to exactly `1.0` stage heights.
- The cinematic intro uses exactly `1.1` stage heights.
- The EXIF draft gives its first moment `1.1` and every later moment `1.0`.
- The Komatsu pilot uses `1.1` for its opening formation and day-two opening,
  and `1.0` for every other moment.
- Keep the author-controlled range `0.6`–`2.5` for deliberate exceptions.
- Route buttons jump with `behavior: "instant"`; normal wheel/touch scrolling stays
  native and is never intercepted.
- The Komatsu track should be roughly 25–30% shorter at the same viewport.

## Repo conventions to follow

- Catalog writes must use `SpotterDexManager.save_event_story()` so the database
  transaction and deterministic SQL snapshot stay synchronized.
- `content/spotterdex.sqlite3` remains canonical; never edit SQL directly.
- Manager field defaults are mirrored between `tools/manager/app.js`,
  `tools/spotterdex_manager.py`, `tools/spotterdex_db.py`, `script.js`, and the
  CSS fallback in `styles.css`.

## Steps

1. Change the browser fallback moment weight in `script.js` from `1.35` to
   `1.0`, and the generated intro from `1.55` to `1.1`.
2. Change the `.airshow-story-copy-step` CSS fallback from `1.35` to `1.0`.
3. In `tools/manager/app.js`, use `1.0` for field fallbacks and manually-added
   moments; use `1.1` for the first EXIF-draft moment and `1.0` thereafter.
4. In `tools/spotterdex_manager.py`, change the missing `scrollWeight` fallback
   from `1.35` to `1.0`.
5. In both current schema declarations in `tools/spotterdex_db.py`, change the
   SQL default from `1.35` to `1.0`. Do not increment the schema version because
   this affects only future rows and all manager saves provide an explicit value.
6. Change story route navigation to `behavior: "instant"` so the global smooth
   scroll rule cannot keep animating after a route click.
7. Load the existing Komatsu story through `SpotterDexManager`, preserve every
   ID, label, headline, body, photo, focal point, and motion value, change only
   the weights specified above, and save with `save_event_story()`. Confirm the
   SQL snapshot refreshes.

## Boundaries

- Do NOT intercept `wheel`, `touchmove`, or momentum events.
- Do NOT change the `0.6`–`2.5` validation range or existing non-Komatsu stories.
- Do NOT edit `content/spotterdex.sql` manually.
- Do NOT rebuild or re-encode generated raster assets.
- Preserve unrelated working-tree changes.

## Verification

- **Mechanical**: `node --check script.js`; `node --check tools/manager/app.js`;
  `python3 tools/spotterdex_catalog.py validate`; relevant unit tests.
- **Data**: query Komatsu moment weights read-only and confirm two values are
  `1.1` and the other nine are `1.0`; confirm the SQL snapshot is current.
- **Feel check**: at 1440×900, normal wheel scrolling should reach scene 10 in
  materially less travel, with no extra animation after input stops. Route
  buttons must settle immediately on the chosen scene.
- **Done when**: the pilot track is 25–30% shorter, native scrolling remains
  fully interruptible, and manager-authored overrides still accept 0.6–2.5.

## Completion evidence

- The 1440×900 story track measured 10,197px, down from 13,844px (26.3%).
- Route jumps reached the requested scene within 20ms and remained stationary
  after 620ms; subsequent wheel input took control immediately.
- The Komatsu story contains two 1.1 weights and nine 1.0 weights, saved through
  the manager API and reflected in the rebuilt public manifests.
