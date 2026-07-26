# 002 — Reduce routine entry motion

- **Status**: DONE
- **Commit**: caefd581
- **Severity**: HIGH
- **Category**: Purpose & frequency; Easing & duration; Cohesion
- **Estimated scope**: 2 files, about 170 lines simplified

## Problem

Routine page and detail navigation layers a 420 ms body fade, 280–380 ms view
keyframes, and long directory-specific card entrances. Stats delays functional
data as late as 645 ms and then animates it for another 460 ms.

```css
/* styles.css:57 — current */
animation: page-in 420ms ease-out both;

/* styles.css:6024 — current */
.view.is-active { animation: page-in 280ms ease-out both; }

/* styles.css:6126 — current */
#statsView.view.is-active .stats-country-track span,
#statsView.view.is-active .exif-bar-track span {
  animation: stats-bar-in 720ms 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* styles.css:5109 — current */
#dexView.view.is-active .recent-photo-card,
#dexView.view.is-active .aircraft-card {
  animation: dex-card-enter 680ms cubic-bezier(0.22, 1, 0.36, 1) var(--dex-delay, 0ms) both;
}
```

## Target

- Remove body, generic view, drawer, item, Stats card, and Stats bar entry animation.
- Keep rare editorial hero-image reveals.
- Keep a restrained directory-card entrance only on Aircraft, Squadrons, and
  Airshows: `240ms cubic-bezier(0.23, 1, 0.32, 1)`, from
  `opacity: 0; transform: translateY(10px) scale(0.995)`.
- Stagger only the first six cards by 30 ms, capped at 150 ms.
- Bring frequent aircraft, squadron, and airshow archive-card image/filter
  hover responses under 300 ms so browsing feels direct.
- Remove keyframes made unused by these changes.

## Repo conventions to follow

- Keep the existing `dex-card-enter` name because all three editorial directories share it.
- Preserve `dex-hero-reveal`, map traffic, selected-pin state, and airshow timeline atmosphere.
- Use the easing token from plan 003.

## Steps

1. Remove `body`'s `page-in` animation and the generic `.view.is-active` entry blocks.
2. Remove the Stats-specific entry and bar animation declarations.
3. Delete unused `page-in`, `drawer-in`, `item-in`, `stats-panel-in`, `stats-card-in`, and `stats-bar-in` keyframes.
4. Tighten `dex-card-enter` to the exact target values and set all three directory usages to 240 ms.
5. In `script.js`, change `--dex-delay`, `--squadron-delay`, and `--airshow-delay` generation to `Math.min(index, 5) * 30` milliseconds.
6. Shorten the three archive-card image/filter hover transitions to roughly
   220 ms, using an ease curve appropriate for an already-present response.

## Boundaries

- Do NOT remove rare hero image reveals or continuous map aircraft.
- Do NOT change layout, typography, filtering, pagination, or generated content.
- Do NOT add dependencies.

## Verification

- **Mechanical**: `node --check script.js`; expected exit 0. Search for the six
  removed keyframe names; expected no matches.
- **Feel check**: navigate list → detail → list repeatedly with mouse and keyboard;
  content must be immediately readable. Reload each directory: only a short,
  restrained first-six card entrance remains. Reload Stats: values and bars are
  complete immediately.
- **Done when**: no routine UI animation exceeds 300 ms and Stats has no decorative entrance delay.

## Final review note

The final standards pass removed the animated airshow rail, stopped animating
image filters, and converted Dex hover details to reserved desktop space with
opacity/transform-only disclosure; coarse-pointer sticky hover keeps them closed.
