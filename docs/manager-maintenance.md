# Manager maintenance

Repository paths and commands below are relative to the repository root. See [agent instructions](../AGENTS.md) for task routing.

## Manager UI maintenance

The local application is separate from the generated public pages: `tools/spotterdex_manager.py` serves the API, while `tools/manager/app.html`, `app.css`, and `app.js` are directly maintained UI sources. Do not move manager behavior into the public `script.js` or page templates.

Navigation and authoring contracts:

- **Photos:** New images handles raw-image attachment. Photo library owns existing-record editing through All photos and By source. Raw asset selection and library bulk selection are separate; captions use library selection, not the Assets drawer.
- **Catalog:** Aircraft, Units, and Locations each have local Details / Presentation navigation. Events owns event tagging, heroes, and cinematic segments; Page write-ups remains a separate catalog destination.
- **Review:** Captions, Missing, and Quality. **Output:** Build & verify.
- Keep `viewMeta`, `workspaceGroups`, renderers, and section IDs in sync. Internal routes such as `master`, `source-photos`, `aircraft`, `squadrons`, and `location-heroes` are not public-site URLs. The active manager route is retained in session storage; presentation routes must highlight their parent catalog destination.
- Photo editing still uses explicit save actions. All photos and By source share a filtered photo grid with separate selection controls and a native focused-editor dialog. Drafts are keyed by canonical photo ID and survive filtering, pagination, navigation, and unrelated saves; missing-record drafts remain available for copying/discarding. Browser-local recovery covers photo, catalog form, write-up, story, and caption drafts, keyed by repository root and database path. Require explicit Restore/Discard on a fresh page; never automatically save or restart generation. Preserve unsaved-work navigation, departure guards, and original revision tokens through refreshes. Existing-record saves must supply resource revisions; stale saves return 409 and retain proposals for comparison and explicit resubmission. Distinguish successful saves from a subsequent refresh failure.

Caption review contracts:

- Scope is selected library photos (default), all matching library search results across pages, or all eligible photos. An empty library search matches all photos. Deduplicate canonical photo IDs/source paths; photos without captions are eligible when their raw sources exist.
- Freeze queue membership when generation begins. Stop finishes the current request; Resume processes remaining ready items; Retry failed processes generation failures only. None of these actions saves captions.
- Keep edited proposals across asynchronous rerenders, including focus and caret position. Accept saves once and marks the caption AI-assisted; a failed save retains the editable draft. Reject leaves the stored caption unchanged. Accepted/rejected states remain in the current queue.
- Caption status filters only change the displayed queue: Needs review includes proposals and in-flight saves (including failed-save proposals), Failed includes generation failures, Completed includes accepted/rejected items, and All also includes waiting/generating items. Default to Needs review when proposals arrive unless a filter was explicitly chosen; reset restores that automatic default. After review, focus the next visible proposal, wrapping through queue order, or the review status when none remain. An asynchronous save must not steal focus if the user moved elsewhere.
- Scope/exclusion changes and Reset queue must confirm before discarding pending proposals and remain blocked during generation or caption saves. Raw asset selection must not reset a caption queue. Queue/proposal/review states participate in explicit browser-local recovery; interrupted generation is retryable and interrupted acceptance has an unknown outcome, never an automatic resubmission.
- `caption_ai_assisted` is provenance used by the default exclusion filter, not an accepted/rejected review status. Editing a caption does not automatically clear that marker. Caption acceptance uses canonical photo identity and refreshes metadata before saving; preserve unrelated fields, including livery. The acceptance request includes the refreshed photo revision and the backend checks it within the write transaction.

Accessibility and maintenance contracts:

- The utility drawer, raw-image preview, narrow-screen primary navigation, and raw-assets overlay use native `<dialog>` behavior. Raw assets remain a nonmodal panel on desktop; breakpoint changes move the same DOM nodes and preserve selections. Preserve modal focus containment, Escape dismissal, and opener focus restoration. Drawer status belongs inside the modal so feedback remains visible and announced while the background is inert.
- Asset and quality filters are button groups with synchronized `aria-pressed`, not partial ARIA tablists. Primary/local navigation uses `aria-current="page"`. Inline New/Inspect actions need contextual accessible names.
- Quality review acknowledgements are local state, not image corrections. The confirmed QC_ prefix/approval actions rename raw files and update catalog paths through the manager; do not perform equivalent ad hoc filesystem renames or reorganize `raw_assets/`.
- Events can generate segments from EXIF calendar days or gaps over two hours, then manually reorder them. Only explicitly assigned photos appear in saved cinematic stories. Preview Draft is not Save Segments, and neither deploys the site.
- Build & verify generates local output only. It does not commit, push, or deploy. Builds use a persisted bounded job registry with one active job. POST starts a job; GET observers only reconnect/poll and must never repeat a start after connection loss. Keep success, failure, and restart/unknown-completion messaging distinct. Orphan cleanup deletes generated derivatives, not raw originals; build before scanning.
