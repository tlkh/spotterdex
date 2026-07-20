# SpotterDex animation improvement plans

Plans were written against commit `caefd581` after a desktop/mobile browser pass.

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Streamline photo viewer motion](001-streamline-photo-viewer-motion.md) | HIGH | DONE |
| 002 | [Reduce routine entry motion](002-reduce-routine-entry-motion.md) | HIGH | DONE |
| 003 | [Honor motion and material preferences](003-honor-motion-material-preferences.md) | MEDIUM | DONE |
| 004 | [Make toast feedback visible and interruptible](004-animate-mobile-toast.md) | LOW | DONE |
| 005 | [Synchronize responsive map controls](005-sync-responsive-map-controls.md) | MEDIUM | DONE |
| 006 | [Virtualize cinematic scroll layers](006-virtualize-cinematic-scroll-layers.md) | HIGH | DONE |
| 007 | [Shorten cinematic scroll pacing](007-shorten-cinematic-scroll-pacing.md) | MEDIUM | DONE |
| 008 | [Build snapping airshow segments](008-build-snapping-airshow-segments.md) | HIGH | DONE |

## Recommended execution order

1. Plan 003 establishes the shared tokens and accessibility contract.
2. Plan 001 removes the most expensive and frequent motion.
3. Plan 002 reduces routine page-entry latency.
4. Plan 005 repairs responsive state synchronization independently.
5. Plan 004 uses the tokens from plan 003 for the one additive motion opportunity.

Plans 001, 002, and 004 depend on the tokens introduced by plan 003. Plan 005 is independent.

Plan 006 should execute before plan 007: it removes the accumulating compositor
load, then plan 007 shortens the amount of scroll work per story. Both plans are
independent of plans 001–005.

Plan 008 supersedes the continuous-scroll controller refined by plans 006 and
007. It retains their media-window and lightweight-layer goals while replacing
the interpolation model with a mandatory native snap deck and grouped segments.
