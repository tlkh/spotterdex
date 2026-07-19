# 003 — Honor motion and material preferences

- **Status**: DONE
- **Commit**: caefd581
- **Severity**: MEDIUM
- **Category**: Accessibility; Cohesion & tokens
- **Estimated scope**: 1 file, about 100 lines changed

## Problem

Two duplicated reduced-motion blocks globally force every animation and
transition to `0.01ms` (`styles.css:6790-6805`, `styles.css:8504-8516`). This
removes useful opacity/color feedback along with vestibular motion. The app also
uses extensive glass materials without `prefers-reduced-transparency` or
`prefers-contrast` fallbacks.

## Target

Add shared motion tokens:

```css
--motion-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--motion-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--motion-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--motion-duration-press: 120ms;
--motion-duration-fast: 180ms;
--motion-duration-standard: 240ms;
```

Replace the universal shutdown with one targeted reduced-motion block that:

- disables decorative travel, pulses, hero/card entrances, and continuous map traffic;
- removes transform/scale movement from viewer and toast feedback;
- preserves a 160 ms opacity/color/border cross-fade using
  `cubic-bezier(0.23, 1, 0.32, 1)`;
- makes scroll behavior automatic;
- makes keyboard focus-triggered motion immediate while retaining focus rings.

Restrict decorative hover movement to fine, hover-capable pointers, and add a
crisp 120 ms compositor-only press response to principal navigation controls,
cards, and viewer controls without replacing their existing transform geometry.

Add reduced-transparency fallbacks that remove `backdrop-filter` from floating
chrome and make its background opaque. Add more-contrast fallbacks with opaque
backgrounds, stronger borders, and higher-contrast muted text.

## Repo conventions to follow

- Floating materials include `.site-header`, `.mobile-tab-bar`, command bars,
  map panels, viewer info/telemetry/controls/filmstrip, toast, and loading indicator.
- Keep the current dark editorial palette and gold focus/accent color.
- Existing mobile motion tokens stay valid; the new general tokens unify shared surfaces.

## Steps

1. Add the exact general motion tokens to `:root`.
2. Remove both universal `0.01ms` reduced-motion blocks and consolidate with the existing final reduced-motion query.
3. Explicitly disable named decorative animations and use 160 ms opacity/color feedback for reduced motion.
4. Add immediate focus-visible motion overrides for interactive controls and their animated children.
5. Add `prefers-reduced-transparency: reduce` and `prefers-contrast: more` blocks for floating chrome.
6. Add mobile `opacity` states for the results and viewer-info sheets so reduced motion can cross-fade while transform position changes instantly.
7. Gate decorative movement/zoom hover rules behind `@media (hover: hover) and
   (pointer: fine)` or neutralize them for coarse pointers.
8. Add the targeted 120 ms press response and keep it composable with existing
   translations and scale-based layouts.

## Boundaries

- Do NOT change the default visual palette or remove translucency for users who have not requested it.
- Do NOT hide OpenStreetMap attribution.
- Do NOT remove semantic focus outlines.

## Verification

- **Mechanical**: search for `animation-duration: 0.01ms` and
  `transition-duration: 0.01ms`; expected no universal selector match.
- **Feel check**: emulate reduced motion. Map traffic/pulses and large travel must
  stop, while toast and sheet state remain legible via short opacity feedback.
  Emulate reduced transparency and more contrast separately; chrome must remain
  readable without blur and without stacked translucent surfaces.
- **Done when**: all three preferences produce useful, visually coherent states.

## Final review note

The final standards pass scoped the shared press/transition contract to desktop
fine pointers, reduced it to opacity and compositor geometry, made reduced-motion
color/border changes immediate, and changed the map coach cue to opacity-only.
