# SpotterDex animation improvement plans

Plans were written against commit `caefd581` after a desktop/mobile browser pass.

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Streamline photo viewer motion](001-streamline-photo-viewer-motion.md) | HIGH | DONE |
| 002 | [Reduce routine entry motion](002-reduce-routine-entry-motion.md) | HIGH | DONE |
| 003 | [Honor motion and material preferences](003-honor-motion-material-preferences.md) | MEDIUM | DONE |
| 004 | [Make toast feedback visible and interruptible](004-animate-mobile-toast.md) | LOW | DONE |
| 005 | [Synchronize responsive map controls](005-sync-responsive-map-controls.md) | MEDIUM | DONE |

## Recommended execution order

1. Plan 003 establishes the shared tokens and accessibility contract.
2. Plan 001 removes the most expensive and frequent motion.
3. Plan 002 reduces routine page-entry latency.
4. Plan 005 repairs responsive state synchronization independently.
5. Plan 004 uses the tokens from plan 003 for the one additive motion opportunity.

Plans 001, 002, and 004 depend on the tokens introduced by plan 003. Plan 005 is independent.
