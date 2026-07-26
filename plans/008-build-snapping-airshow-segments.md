# 008 — Build snapping airshow segments

- **Status**: DONE
- **Commit**: 2d7e8651
- **Severity**: HIGH
- **Category**: Interruptibility; Performance; Purpose & frequency
- **Estimated scope**: 11 source/data files, about 700 lines changed

## Problem

The cinematic airshow page models each photograph as a long continuously
interpolated moment. `script.js:5120-5288` measures document geometry and then
writes hero and caption transforms on every scroll frame:

```js
// script.js:5239 — current
syncLiveLayers(current);
writeScene(current, 1 - nextBlend, local, true, false, nextBlend);
writeScene(current + 1, nextBlend, clamp(nextBlend * 0.35), false, true, nextBlend);
writeCopy(current, 1 - nextBlend, (0.5 - local) * 2.4, stageRect, stageHeight);
writeCopy(current + 1, nextBlend, 1.5 - nextBlend, stageRect, stageHeight);
```

This leaves the story between states while a trackpad is decelerating and makes
the image/copy choreography visibly jitter. It also treats every photograph as
an independent narrative unit, even though a chronological airshow is more
usefully authored as a smaller set of segments with one hero and related frames.

The database already supports ordered photos per story item, but the manager
replaces the photo list whenever the hero changes and exposes no way to add the
other photos:

```js
// tools/manager/app.js:3322 — current
moment.photos = [{
  photoId: photo.id,
  focalX: 0.5,
  focalY: 0.5,
  motion: moment.photos?.[0]?.motion || "auto"
}];
```

Overlay placement is currently inferred from the slide number in CSS rather
than stored as authored data:

```css
/* styles.css:1906 — current */
.airshow-story-copy-step:nth-child(even) {
  justify-items: end;
}
```

## Target

### Narrative and catalog contract

- Surface the ordered items as **segments** in the manager and public story
  payload. Keep the existing `event_story_moments` table name internally to
  avoid destructive table migration, and accept legacy `moments` payloads as a
  fallback during the transition.
- Each segment has one or more ordered photos. Position zero is the hero; all
  remaining positions are supporting carousel frames.
- Add `overlay_side TEXT NOT NULL DEFAULT 'left' CHECK (overlay_side IN
  ('left','right'))` to `event_story_moments`, increment `SCHEMA_VERSION` from 4
  to 5, and add a version-4 upgrade that adds the column and sets existing odd
  positions to `right` so the current alternating layout is preserved.
- Public and manager story objects use `segments`; each segment contains `id`,
  `label`, `headline`, `body`, `overlaySide`, and ordered `photos`.
- The save endpoint accepts `segments` first and `moments` as a compatibility
  fallback. Validate `overlaySide` as `left` or `right` and at least one photo.
- When a hero is chosen, default the headline to the hero subject and the body
  to the hero title/caption. Editors can then override both fields.

### Snap deck

- Replace document-length continuous interpolation with one internal vertical
  scroll container exactly one story-stage high:

```css
.airshow-story-track {
  height: var(--airshow-story-stage-height);
  overflow-y: auto;
  overscroll-behavior-y: auto;
  scroll-snap-type: y mandatory;
  scrollbar-width: none;
}

.airshow-story-slide {
  position: relative;
  min-height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
}
```

- Let native CSS mandatory snap own touch motion. For desktop wheel/trackpad
  input, group one uninterrupted vertical wheel gesture into exactly one slide
  step because Chromium may otherwise skip several `scroll-snap-stop: always`
  elements on a high delta. Prevent only the in-range vertical deck gesture;
  never prevent horizontal carousel input or outward gestures at the first/last
  slide. End the gesture lock 180ms after the last wheel event so momentum tails
  cannot trigger a second slide. Leave vertical overscroll chaining enabled so
  a new outward gesture can continue to the surrounding page/Event archive.
- Remove the geometry measurement, requestAnimationFrame scroll writer, scene
  crossfade, and continuously changing transforms from `mountAirshowStory()`.
- Render each intro/segment as a self-contained slide: absolute hero media,
  vignette, copy overlay, and optional supporting-photo carousel.
- Apply `.is-overlay-left` or `.is-overlay-right` from `overlaySide`; do not use
  `nth-child` for copy placement.
- Use an `IntersectionObserver` rooted at the story track with threshold `0.6`
  to update the active route, progress, media window, and `aria-current` only
  when a slide becomes dominant. Route buttons use instant `scrollTo()` to the
  exact slide offset.
- Keep full-resolution hero media only for active index ±1. All other hero
  elements use thumbnails; Save-Data uses thumbnails everywhere.
- Supporting photos always use thumbnails in the rail and open the existing
  photo viewer through `data-photo-id`.

### Segment carousel

- Show the carousel only when a segment has supporting photos.
- Render a horizontally scrollable rail with `scroll-snap-type: x proximity`,
  96–132px thumbnail buttons, and previous/next controls. Carousel buttons move
  the rail by approximately 75% of its visible width using `behavior: "smooth"`;
  use `instant` under reduced motion.
- Give every thumbnail a useful accessible label containing its position and
  photo subject. The rail label is `More photos from <segment headline>`.
- The slide hero retains a `View hero` button.

### Manager experience

- Rename visible “moment” terminology to “segment”, including headings, button
  labels, summaries, guidance, empty states, and accessible labels. Internal
  function names may remain temporarily if changing them adds risk.
- Each segment card exposes:
  - hero photo select;
  - overlay-side select with Left and Right;
  - label, headline, caption/body, and hero focal/motion controls;
  - an “Add supporting photo” select containing unused event photos;
  - an ordered supporting-photo list with thumbnail, label, move earlier/later,
    and remove controls.
- A photo may appear only once across the whole story. Hero selection and
  supporting-photo options must exclude photos already owned by another segment.
- Deterministic EXIF draft generation groups selected chronological candidates
  by calendar day or a gap greater than 120 minutes, without a per-segment
  photo cap.
  It uses the first photo as hero, the remainder as support, alternates overlay
  sides left/right, and derives default text from the hero. No AI/API is used.

### Komatsu pilot content

Use `SpotterDexManager.save_event_story()`—never direct SQL—to regroup the 11
existing Komatsu photos into these four ordered segments while preserving photo
focal/motion records where applicable:

1. `Opening formation`: opening formation hero + aggressor arrival.
2. `Morning demonstrations`: search-and-rescue hero + 306 TFS display.
3. `Afternoon arrivals`: F-2A hero + P-1 + C-2 + US-2.
4. `Day two launches`: 303 TFS F-15J hero + 306 TFS launch + aggressor departure.

Use overlay sides `left`, `right`, `left`, `right`. The body for each regrouped
segment should succinctly describe the grouped sequence using the existing
captions only; do not invent aircraft facts.

## Repo conventions to follow

- The app is dependency-free static JavaScript/CSS; add no framework, bundler,
  scroll library, or runtime database.
- `content/spotterdex.sqlite3` is canonical and all catalog writes go through
  `SpotterDexManager.save_event_story()`. `content/spotterdex.sql` is generated.
- Browser data stays normalized and keyed by photo IDs. Reuse existing photo
  viewer delegation through `data-photo-id`.
- `destroyAirshowStory()` remains lifecycle owner and must disconnect the
  observer and abort all listeners.
- Preserve the existing static reduced-motion article behavior: no forced snap,
  no movement, all segments readable in document order.

## Steps

1. Update `tools/spotterdex_db.py`: schema version 5, `overlay_side` in fresh
   schema, safe v4→v5 upgrade, validation for one-or-more photos, and
   overlay-side integrity. Extend database tests for fresh and upgraded catalogs.
2. Update story reads/writes in `tools/spotterdex_manager.py`: emit `segments`,
   read `segments` with `moments` fallback, validate and persist `overlaySide`,
   allow any number of ordered photos, and update user-facing errors/messages.
3. Update `tools/build_spotterdex.py` and `tools/tests/test_airshow_story.py` so
   normalized public events carry `story: {mode:"cinematic", segments:[...]}`
   with `overlaySide` and ordered photo records.
4. Rework the manager markup/copy in `tools/manager/app.html`, segment-card
   rendering and events in `tools/manager/app.js`, and layout in
   `tools/manager/app.css`. Implement hero defaults, side selection, and ordered
   supporting-photo add/move/remove controls.
5. Replace `airshowStoryMoments()`, `renderAirshowCinematicStory()`, and
   `mountAirshowStory()` in `script.js` with the segment-compatible snap deck,
   observer active-state controller, reversible ±1 media window, and carousel
   controls. Accept legacy `story.moments` as a browser fallback.
6. Replace the current cinematic CSS block in `styles.css` with the internal
   mandatory snap layout, side-authored overlays, carousel rail, mobile rules,
   contrast/transparency rules, and static reduced-motion article.
7. Regroup the Komatsu pilot through the manager API exactly as specified and
   refresh the deterministic SQL snapshot.
8. Run a strict build to update public data. If the build re-encodes unchanged
   generated JPEGs, restore only `assets/generated/photos/` and
   `assets/generated/thumbs/`; do not restore generated manifests.

## Boundaries

- Do NOT edit `content/spotterdex.sql` directly.
- Do NOT hand-edit generated manifests or raster assets.
- Do NOT use Gen AI, external APIs, or inferred schedule information.
- Do NOT intercept touch gestures or implement custom momentum. The single-step
  wheel gesture guard described above is the only allowed wheel interception.
- Do NOT add autoplay to either axis.
- Do NOT change standard (non-cinematic) airshow pages or the global photo viewer.
- Preserve unrelated working-tree changes in every overlapping file.
- If the cited cinematic code has drifted materially, stop and report instead
  of improvising outside this scope.

## Verification

- **Mechanical**:
  - `python3 tools/build_spotterdex.py --strict --no-progress`
  - `python3 tools/spotterdex_catalog.py validate`
  - `python3 -m unittest discover -s tools/tests -v`
  - `node --check script.js`
  - `node --check tools/manager/app.js`
  - `git diff --check`
- **Data**: verify Komatsu has four ordered segments containing 2, 2, 4, and 3
  photos; overlays alternate left/right; every original story photo appears
  exactly once; public core JSON uses `segments`.
- **Manager**: run the manager, open Komatsu, add/remove/reorder a supporting
  photo and switch overlay side, then reset without saving. Verify generated
  EXIF draft grouping is deterministic and uses no network request.
- **Feel check at 1440×900 and 390×844**:
  - Slow wheel/trackpad input always settles on exactly one full slide.
  - A large wheel gesture cannot leave a slide resting halfway, and
    `scroll-snap-stop: always` prevents skipping multiple segments.
  - Vertical snap and horizontal carousel gestures do not fight one another.
  - Route jumps land exactly on the requested slide with no residual animation.
  - Overlay left/right choices match authored data.
  - Every supporting thumbnail opens the correct frame in the existing viewer.
  - No per-frame inline transforms are written while scrolling.
  - Toggle reduced motion: the story becomes a readable static article with all
    segment heroes/supporting photos and no snapping.
- **Done when**: the story never rests between slides, the manager can fully
  author segment membership/hero/overlay without AI, the Komatsu pilot renders
  four grouped segments with working carousels, and browser console/tests/build
  are clean.

## Completion evidence

- The canonical catalog and public manifest contain four Komatsu segments with
  2, 2, 4, and 3 photos and authored overlay sides left/right/left/right.
- A 4000 px wheel delta moved exactly one 829 px slide; eight 900 px momentum
  events moved exactly one further slide. An outward gesture from the final
  slide chained 700 px into the Event archive.
- At 390×844, a large carousel stress case stayed within the viewport; its
  rail scrolled horizontally without changing the vertical slide position.
- Manager browser QA confirmed four segment cards, supporting-photo counts of
  1, 1, 3, and 2, editable overlay sides, and a clean reset without saving.
- Responsive media refinement keeps desktop hero crops bottom-aligned above the
  lower-third panel. On mobile, the full-width foreground hero is centered and
  unobscured; its blurred duplicate remains behind it, the vignette layer is
  removed, and the panel clears the fixed navigation bar.
- Reduced motion rendered all five story entries as a static article with snap
  disabled. The direct `file://` GitHub Pages workflow also advanced exactly one
  slide for a large wheel gesture.
- Strict build, catalog validation, 25 unit tests, both JavaScript syntax checks,
  `git diff --check`, and the HTTP browser console completed cleanly.
