# 001 — Streamline photo viewer motion

- **Status**: DONE
- **Commit**: caefd581
- **Severity**: HIGH
- **Category**: Purpose & frequency; Interruptibility; Performance
- **Estimated scope**: 2 files, about 90 lines changed

## Problem

Photo stepping is a high-frequency action, but every loaded frame restarts three
decorative keyframes and forces synchronous layout. Mobile pinch zoom also
changes layout dimensions on every update.

```css
/* styles.css:5553 — current */
.viewer-image-frame.is-focusing::before {
  animation: viewer-reticle 720ms ease-out both;
}

.viewer-image-frame.is-focusing::after {
  animation: viewer-scan 760ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.viewer-image-frame > #viewerImage.is-entering {
  animation: viewer-focus-in 540ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
```

```js
// script.js:7303 — current
els.viewerImage.classList.remove("is-entering");
els.viewerImageFrame.classList.remove("is-focusing");
void els.viewerImageFrame.offsetWidth;
els.viewerImage.classList.add("is-entering");
els.viewerImageFrame.classList.add("is-focusing");
```

```js
// script.js:7354 — current
if (isMobileViewerLayout()) {
  const size = `${zoom * 100}%`;
  els.viewerImage.style.width = size;
  els.viewerImage.style.height = size;
  els.viewerImage.style.transform = `translate3d(${state.viewerPanX}px, ${state.viewerPanY}px, 0)`;
}
```

The desktop gallery also installs a pointermove listener that reads layout and
writes gradient-position variables for decoration on every pointer move
(`script.js:834-900`, `styles.css:3719-3745`).

## Target

- Delete the pointer-tracked lens overlay and listeners.
- Remove viewer reticle, scan, forced-layout restart, and ambient drift.
- Reveal each loaded photo with an interruptible 180 ms transition from
  `opacity: 0.18; scale: 0.985` to `opacity: 1; scale: 1` using
  `cubic-bezier(0.23, 1, 0.32, 1)`.
- Keep zoom and pan entirely on the compositor by always using
  `translate3d(...) scale(...)`; never change image width/height for zoom.

```css
.viewer-image-frame > #viewerImage {
  opacity: 0.18;
  scale: 0.985;
  transition:
    opacity 180ms var(--motion-ease-out),
    scale 180ms var(--motion-ease-out),
    transform 180ms var(--motion-ease-out);
  will-change: transform, opacity;
}

.viewer-image-frame > #viewerImage.is-entering {
  opacity: 1;
  scale: 1;
}
```

## Repo conventions to follow

- Motion remains dependency-free in `styles.css` and `script.js`.
- Gesture tracking already writes `transform` directly and disables transition
  with `.is-dragging` (`styles.css:5590`, `script.js:7410-7454`).
- Use `--motion-ease-out: cubic-bezier(0.23, 1, 0.32, 1)` from plan 003.

## Steps

1. In `script.js`, remove the lens event registration and the two lens handler functions.
2. In `styles.css`, remove the lens custom properties and overlay pseudo-element rules.
3. Remove viewer reticle/scan/ambient keyframe use and their unused keyframes.
4. Replace the image entry keyframe with the exact transition above.
5. Simplify `revealViewerPhoto()` to add `is-entering` without a layout read or `is-focusing` class.
6. Make `updateViewerTransform()` clear width/height and always write one `translate3d(...) scale(...)` transform.

## Boundaries

- Do NOT change viewer markup, metadata, focus trapping, swipe thresholds, or sheet gestures.
- Do NOT add a motion library.
- Do NOT change photo asset generation.
- If the cited code has drifted, stop and report instead of improvising.

## Verification

- **Mechanical**: `node --check script.js`; expected exit 0.
- **Feel check**: open a multi-photo viewer and click/arrow rapidly. Frames should
  settle in 180 ms without a reticle or scan, and rapid reversals must retarget
  rather than flash from a restarted keyframe. Pinch and button zoom on a phone
  viewport must update only `transform`, with no width/height mutation.
- **Done when**: DevTools shows no forced layout in `revealViewerPhoto()`, no
  viewer lens pointermove listener, and no layout invalidation during pinch zoom.

## Final review note

The final standards pass also removed the viewer-shell fade. The photo image's
interruptible 180 ms reveal now provides the only opening feedback.
