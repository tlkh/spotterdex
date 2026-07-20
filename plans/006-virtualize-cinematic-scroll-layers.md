# 006 — Virtualize cinematic scroll layers

- **Status**: DONE
- **Commit**: 2d7e8651
- **Severity**: HIGH
- **Category**: Performance; Interruptibility
- **Estimated scope**: 2 files, about 120 lines changed

## Problem

The cinematic airshow renderer progressively retains every full-size photograph
that the reader passes. By moment 10 of the 12-scene Komatsu story, browser
measurement shows 11 full-size 2560px sources retained instead of the initial
2. All 12 scenes, 12 images, and 12 caption cards are also permanently promoted
with `will-change`, even when their opacity is zero. On a regular Chrome GPU
compositor this eventually produces partial or blank textures.

```js
// script.js:5040 — current
function renderAirshowStoryImage(scene, index) {
  const config = scene.photos[0];
  const photo = config.photo;
  const thumbnail = photo.thumbnail || photo.image || "";
  const full = photo.image || thumbnail;
  const source = index === 0 ? full : thumbnail;
  if (!source) return '<span class="airshow-story-media-fallback"></span>';
  return `<img src="${escapeAttr(source)}"${full && full !== source ? ` data-story-full="${escapeAttr(full)}"` : ""} ...>`;
}
```

```js
// script.js:5151 — current
function upgradeScene(index) {
  if (saveData) return;
  [index, index + 1].forEach((sceneIndex) => {
    const image = scenes[sceneIndex]?.querySelector("img[data-story-full]");
    if (!image || !image.dataset.storyFull) return;
    image.src = image.dataset.storyFull;
    image.removeAttribute("data-story-full");
  });
}
```

```css
/* styles.css:1704 — current */
.airshow-story-scene {
  overflow: hidden;
  opacity: 0;
  will-change: opacity;
}

.airshow-story-scene img {
  object-fit: cover;
  transform: scale(1.035);
  will-change: transform;
}

/* styles.css:1910 — current */
.airshow-story-copy {
  /* ... */
  will-change: opacity, transform;
}
```

The requestAnimationFrame callback also writes opacity/transform to every scene
and every caption on every scroll frame, although only the current and next
scene can be visible. The full-viewport grain layer adds a continuous
`mix-blend-mode: soft-light` composite on top of those layers.

## Target

- Keep at most five full-size image sources: display index ±2. All other scene
  images must use their 1024px thumbnail source.
- Never delete the stored full/thumbnail URLs from `dataset`; the media window
  must be reversible when the user scrolls backward.
- Only the current and next scene/caption receive an `.is-live` class and
  `will-change`. Inactive scenes are `visibility: hidden`, opacity zero, and do
  not retain compositor promotion.
- On each animation frame, write styles only for the current and next scene and
  caption. Reset the previously-live indices only when the current index changes.
- Remove the full-screen grain/mix-blend layer.
- Reduce active-card backdrop blur from 18px to 10px.
- Preserve native scroll, the existing crossfade curve, focal points, viewer
  buttons, route navigation, mobile behavior, and reduced-motion article.

```css
/* target */
.airshow-story-scene {
  visibility: hidden;
  overflow: hidden;
  opacity: 0;
}

.airshow-story-scene.is-live {
  visibility: visible;
  will-change: opacity;
}

.airshow-story-scene.is-live img {
  will-change: transform;
}

.airshow-story-copy.is-live {
  will-change: opacity, transform;
}
```

## Repo conventions to follow

- Motion remains dependency-free in `script.js` and `styles.css`.
- The scroll controller already uses one passive scroll listener and one
  requestAnimationFrame scheduler (`script.js:5230`). Retain that pattern.
- Animate only direct `transform` and `opacity` values; do not introduce CSS
  variables updated on every frame.
- `destroyAirshowStory()` and its AbortController remain the lifecycle owner.

## Steps

1. In `renderAirshowStoryImage()` in `script.js`, render the thumbnail as the
   initial `src` for every scene and retain both `data-story-thumb` and
   `data-story-full` whenever available.
2. Replace `upgradeScene()` with `syncSceneMedia(displayIndex)`. On display
   index changes, use full sources only for indices from `displayIndex - 2`
   through `displayIndex + 2`; restore all other images to their thumbnail.
   Under Save-Data, use thumbnails for every scene.
3. Track the previously-live scene and caption indices. When `current` changes,
   remove `.is-live`, set opacity to zero, and disable pointer events only for
   the previous live elements; then activate `current` and `current + 1`.
4. Replace the two all-element `forEach` loops in `read()` with direct updates
   for `current` and `current + 1`. Keep the existing transform formulas and
   opacity crossfade values.
5. In `styles.css`, remove permanent `will-change` from scenes, images, and
   captions. Add the exact `.is-live` rules shown above and hide inactive scenes
   with `visibility: hidden`.
6. Stop rendering `.airshow-story-grain` in `script.js` and remove its
   full-screen mix-blend CSS. Change caption backdrop blur to exactly 10px.
7. Ensure reduced-motion mode overrides visibility so its static first hero and
   chronological cards remain fully visible without live-layer classes.

## Boundaries

- Do NOT change the database schema, story content, generated image files, or
  archive gallery.
- Do NOT add a framework, motion library, IntersectionObserver per scene, or a
  persistent animation loop.
- Do NOT replace native scrolling or intercept wheel/touch events.
- Preserve all unrelated working-tree edits in `script.js` and `styles.css`.
- If the cited cinematic code has drifted materially, stop and report instead
  of improvising outside this scope.

## Verification

- **Mechanical**: `node --check script.js`; `git diff --check`.
- **Browser metrics**: at moment 10 of Komatsu, confirm no more than five scene
  images use `/assets/generated/photos/`, exactly two or fewer scenes/images/
  captions have computed `will-change` other than `auto`, and all inactive
  scenes have `visibility: hidden`.
- **Feel check**: rapidly wheel from scene 1 to 12, reverse to scene 3, then use
  route buttons to jump 10 → 2 → 12. Every photo must fill the stage without a
  partial texture, black flash, or stale caption. Crossfades must remain
  interruptible and must not lag behind the native scrollbar.
- Test 1440×900 and 390×844, then emulate `prefers-reduced-motion: reduce` and
  confirm the static article is unchanged.
- **Done when**: repeated forward/backward stress passes retain correct images,
  no console errors appear, and the late-story compositor counts meet the caps.

## Completion evidence

- At scenes 10 and 12, browser stress testing retained at most five full-size
  sources, two live scenes, and two live captions; active images remained fully
  decoded at 2560px.
- Rapid forward/backward route jumps passed at 1440×900 and 390×844, including
  a direct `file://` run matching the reported failure mode.
- Reduced-motion mode retained one static hero and all 12 chronological cards.
