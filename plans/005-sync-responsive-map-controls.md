# 005 — Synchronize responsive map controls

- **Status**: DONE
- **Commit**: caefd581
- **Severity**: MEDIUM
- **Category**: Responsive interaction; State indication
- **Estimated scope**: 1 file, 2 lines changed

## Problem

The resize handler creates/updates the mobile shell but does not refresh its
selected-location summary (`script.js:809-832`). Reproduced in Chromium by
loading the desktop map, then resizing to 390 px: the map and desktop dossier
show Gifu selected while the newly visible mobile card says `0 Photos · No
location selected` and both history arrows remain disabled. A fresh mobile load
correctly shows `45 Photos · Gifu Air Base`.

## Target

Immediately after `ensureMobileAppShell()` in the debounced resize handler, call:

```js
updateMobileMapHeader();
updateRecentLocationNav();
```

Both functions already guard missing elements and derive their state from the
canonical selection.

## Repo conventions to follow

- `updateMobileMapHeader()` is the existing renderer at `script.js:2133`.
- `updateRecentLocationNav()` is the existing history-control renderer at `script.js:2190`.
- Keep the existing 150 ms resize debounce.

## Steps

1. Add the two calls immediately after `ensureMobileAppShell()` in the resize callback.

## Boundaries

- Do NOT change initial selection, map fitting, breakpoints, or resize debounce timing.

## Verification

- **Mechanical**: `node --check script.js`; expected exit 0.
- **Feel check**: load at 1280 px, confirm Gifu is selected, resize to 390 px
  without reload, and verify `27 spots`, `45 Photos`, `Gifu Air Base`, and the
  older/newer arrow states match the map. Resize back and down again.
- **Done when**: responsive chrome never exposes stale selection state.
