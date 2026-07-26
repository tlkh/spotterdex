# 004 — Make toast feedback visible and interruptible

- **Status**: DONE
- **Commit**: caefd581
- **Severity**: LOW
- **Category**: Missed opportunity; Spatial consistency; Feedback
- **Estimated scope**: 2 files, about 35 lines changed

## Problem

The occasional status toast appears and disappears instantly because
`showToast()` toggles `hidden` (`script.js:1582-1591`) and `.app-toast` has no
state transition (`styles.css:9675-9695`). It is also created only by
`ensureMobileAppShell()` after the mobile breakpoint passes (`script.js:274-313`),
so desktop copy/share feedback has no toast element at all. The state change
teleports on mobile and is invisible on desktop.

## Target

- Create one global toast before the mobile-shell breakpoint guard so feedback
  is available at every viewport; remove the duplicate from mobile-shell markup.
- Keep the toast mounted during its exit and toggle `.is-visible`.
- Enter from and exit toward the bottom with
  `opacity: 0; transform: translate3d(-50%, 8px, 0) scale(0.97)` →
  `opacity: 1; transform: translate3d(-50%, 0, 0) scale(1)`.
- Use `180ms cubic-bezier(0.23, 1, 0.32, 1)` for opacity and transform.
- A new toast during exit must retarget from the current presentation state.
- Under reduced motion, use opacity only for 160 ms.

## Repo conventions to follow

- Continue using `state.toastTimer` and the existing 2400 ms display time.
- Use the tokens from plan 003.
- Keep `role="status"` and `aria-live="polite"` unchanged.

## Steps

1. Add an `ensureAppToast()` helper, call it before `ensureMobileAppShell()` in
   `init()`, and assign `els.appToast`; remove the toast from mobile-only markup.
2. Move the full toast surface styling outside the mobile media query, keeping
   only mobile-specific bottom positioning inside it.
3. Add base and `.is-visible` transition states in `styles.css`.
4. In `showToast()`, clear the timer, unhide, schedule `.is-visible`, and after 2400 ms remove the class.
5. Hide the element only after the 180 ms exit settles; a new call must cancel that timer and re-add `.is-visible`.
6. Add the exact reduced-motion opacity-only state.

## Boundaries

- Do NOT change toast wording, duration, ARIA behavior, or install/connectivity logic.
- Do NOT use keyframes; rapid messages must remain interruptible.

## Verification

- **Mechanical**: `node --check script.js`; expected exit 0.
- **Feel check**: trigger copy/share feedback twice rapidly. The second message
  must not flash or restart from an offscreen origin. Enter and exit must use the same edge.
- **Done when**: the toast is hidden after exit and rapid retriggers remain continuous.
