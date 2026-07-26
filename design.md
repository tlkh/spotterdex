# SpotterDex design system

This is the locked design system for the SpotterDex static app. The site is an
aircraft-spotting archive and photography field guide. The system keeps the
aviation archive identity on desktop and uses a restrained native iOS-like app
shell on mobile.

## Genre

Atmospheric app UI with a technical, utilitarian voice.

## Macrostructure family

- Map: Workbench — map canvas with a persistent control rail.
- Archive pages: Index-First — compact page lead followed by the working index.
- Airshows: Long Document / timeline — chronology is the primary navigation.
- Stats: Stat-Led dashboard — metrics lead; explanatory data follows.
- Detail and photo viewer: contextual app surface — no marketing hero pattern.

## Theme

The palette is a dark, warm aviation archive. Existing visual values are
preserved, but page CSS consumes semantic tokens from `tokens.css`.

- `--color-paper`: dark charcoal
- `--color-surface`: warm black-brown panel
- `--color-ink`: warm off-white
- `--color-muted`: low-contrast warm grey
- `--color-rule`: quiet warm divider
- `--color-accent`: brass navigation and focus accent
- `--color-focus`: high-contrast brass focus ring

## Typography

- Display and body: system UI stack, prioritising SF Pro on Apple platforms.
- Technical metadata: system monospace stack.
- Headings are roman, compact, and left-aligned; emphasis uses weight or the
  brass accent rather than italic display type.

## Spacing and surfaces

Use the named 4-point scale in `tokens.css`. Desktop archive surfaces are
quietly squared; mobile sheets and controls use 12–16px corners, 44–48px
minimum touch targets, and safe-area-aware padding.

## Motion

- Use `--ease-out`, `--ease-in`, and `--ease-in-out` only.
- Preserve purposeful sheet, viewer, tab, and press transitions.
- Animate transform and opacity; keep focus rings instant.
- Reduced motion collapses spatial motion to an opacity-only transition of no
  more than 150ms.

## Mobile interaction stance

- Five-item fixed bottom tab bar is the primary navigation.
- Compact contextual title bar appears on collection and detail views.
- Map controls and photo information use draggable bottom sheets.
- Viewer opens as a focused full-screen surface and temporarily hides the tab
  bar.
- Success is silent when the visible UI already confirms the action.

## Invariants

Routes, URL hashes, catalog data, generated media, photo IDs, and existing
JavaScript data contracts must remain compatible. No generated catalog or
asset directories are edited by visual redesign work.

## Exports

The drop-in CSS export is `tokens.css`. The static site links it before
`styles.css` on every page. That link is emitted by `tools/build_pages.py` and
asserted by `tools/tests/test_site_contracts.py`; tokens must never be pulled in
with `@import`, which would serialise the two stylesheet requests.

`styles.css` still holds historical raw hex colours and `cubic-bezier()` curves
from before this system was extracted. A ratchet test allows those counts to
fall but never rise, so new rules must consume the tokens above.
