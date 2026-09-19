# Working on SpotterDex

SpotterDex is a dependency-light static aircraft spotting guide and photography portfolio served from the repository root on GitHub Pages.

## Task-specific context

Read the relevant guide when working on that area; unrelated guides are not prerequisites.

| Task | Reference |
| --- | --- |
| Catalog records, photo metadata, schema, or generated payloads | [Catalog maintenance](docs/catalog-maintenance.md) |
| Local manager UI/API, drafts, captions, quality, or jobs | [Manager maintenance](docs/manager-maintenance.md) |
| Public routes, search, viewer, responsive UI, or offline shell | [Public app maintenance](docs/public-app-maintenance.md) |
| Builds, verification, CI, commits, or deployment | [Build and deployment](docs/build-and-deployment.md) |
| Visual design, typography, tokens, or motion | [Design system](design.md) |
| Authoring commands and user-facing workflows | [Project README](PROJECT_README.md) |

## Repository boundaries

- `content/spotterdex.sqlite3` is canonical. Use `tools/spotterdex_manager.py` for authoring; direct SQL editing is unsupported. `content/spotterdex.sql` is generated and must remain synchronized. Entity IDs are immutable semantic slugs.
- `raw_assets/` holds ignored, flat originals. Never commit or reorganize it. Source renames belong to the manager's confirmed QC actions; orphan cleanup removes generated derivatives only.
- Do not hand-edit generated `data/`, `share/`, `assets/generated/`, published raster logos, `sitemap.xml`, or `robots.txt`.
- The five top-level HTML pages come from `tools/build_pages.py` and `tools/page_templates/`. Service-worker cache versions are builder-stamped. Edit the sources and regenerate.
- Public code is classic JavaScript with no frontend framework, bundler, or runtime database. Manager sources under `tools/manager/` and `tools/spotterdex_manager.py` are separate from the public runtime.
- New styling uses `tokens.css` and the locked `design.md` system. Preserve semantic controls, keyboard access, responsive layouts, and visible OpenStreetMap attribution. Do not download offline map tiles or prefetch them.
- Preserve unrelated worktree changes. Never stage ignored manager state, raw sources, backups, or browser artifacts.

## Completion and verification

Carry the requested change through implementation, relevant verification, and fixes for regressions it causes. Routine local edits and checks within the requested scope do not need another approval. Report what changed, what was verified, and any remaining limitation.

New public or manager behavior needs a discoverable regression test in `tools/tests/`. Node-backed behavior tests use mocked DOM/API responses without caption-service calls or catalog mutation; run and repair affected tests without pausing for approval. Missing Node.js and skipped tests are verification gaps, not passing coverage. Use `.venv/bin/python` when system Python lacks build dependencies.

Choose checks by the changed surface; commands and browser checks are in the linked maintenance guides:

- Documentation only: check links and `git diff --check`; no image rebuild or application suite is needed.
- Manager UI only: affected manager tests, JavaScript syntax, and relevant real-browser interaction checks; no public rebuild unless catalog/build inputs changed.
- Catalog, public runtime, templates, styles, or build inputs: regenerate public output and verify the affected contracts. A second unchanged build must leave generated output unchanged.
- Deployment involving catalog or source changes: use the full local build and verification sequence in the deployment guide. Do not repeatedly rerun passing checks without new changes or unresolved concerns.

Build locally does not publish. When the user requests deployment, follow the linked deployment checklist through the authorized commit and push; normal production uses `origin main`. Do not force-push or rewrite history without explicit instruction. Report Pages status separately from push success.

## Maintaining these instructions

Keep this entry point focused on repository-wide constraints and task routing. Put detailed contracts beside the relevant maintenance guide, user workflows in the README, and executable regressions in tests. Completed `plans/` documents are historical; current source and maintenance contracts take precedence. See [documentation guidance](docs/documentation.md) for the rationale and task-prompt examples.
