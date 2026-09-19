# Build, verification, and deployment

Repository paths and commands below are relative to the repository root. See [agent instructions](../AGENTS.md) for task routing.

## Build and verification

After catalog changes, rebuild:

```bash
python3 tools/build_spotterdex.py
```

Recommended verification:

```bash
python3 tools/build_spotterdex.py --strict --no-progress
python3 tools/spotterdex_catalog.py validate
python3 -m unittest discover -s tools/tests -v
node --check script.js
node --check map-page.js
node --check airshows-page.js
node --check stats-page.js
node --check service-worker.js
node --check tools/manager/app.js
```

The complete local application suite is `python3 -m unittest discover -s tools/tests -v`. Keep this suite high-coverage across both shipped surfaces:

- **Public web app:** `test_route_behaviors`, `test_script_behaviors`, `test_archive_routes`, `test_map_leaders`, `test_site_contracts`, `test_app_integrity`, `test_airshow_story`, and `test_apple_web_app` cover route rendering, shared runtime behavior, map layout, generated markup/assets, service-worker contracts, accessibility, recovery, and responsive layout rules.
- **Management app and catalog backend:** `test_manager_ui`, `test_manager_drafts`, `test_manager_jobs`, `test_manager_revisions`, `test_manager_workflows`, `test_caption_assistant`, `test_quality_control`, and `test_spotterdex_db` cover authoring workflows, recovery, concurrency, build jobs, captioning, quality actions, persistence, and database invariants.

Every new public or manager behavior must add or update a discoverable test in the appropriate module; do not rely on syntax checks alone. The Node-backed tests use mocked DOM/API behavior and do not call the caption service or mutate the catalog. Node.js is required for meaningful web/manager coverage: skipped Node tests do not count as a passing coverage result. If the system Python lacks Pillow or PyYAML, use the existing `.venv/bin/python` for local verification commands.

For a local coverage report matching CI's Python measurement, install/use `coverage` in the active environment and run:

```bash
coverage run --branch --source=tools --omit='tools/tests/*' \
  -m unittest discover -s tools/tests -v
coverage report --show-missing
```

This reports Python manager/catalog coverage; public and manager browser JavaScript coverage is enforced by the Node behavior and contract tests above, plus the shipped-bundle syntax checks.

For manager-only UI changes, run the focused tests, `node --check tools/manager/app.js`, and `git diff --check`; a public-site image rebuild is not needed unless catalog/build inputs also changed. Mocked tests do not verify actual layout, native focus trapping, or screen-reader announcements. Manually check keyboard Tab/Escape and focus return, filter states, desktop/narrow layouts, and caption edits during generation without sending real caption requests unless intended.

Builds are idempotent: rebuilding an unchanged catalog must leave the worktree clean. `generatedAt` is carried over from the previous manifest whenever the payload is otherwise identical, and generated text files are only rewritten when their content changes. A no-op rebuild that still dirties files is a bug worth investigating.

`.github/workflows/ci.yml` should mirror the complete local suite wherever the environment permits. Its Python job runs the same `unittest discover -s tools/tests` suite with coverage on each supported Python version; its Node job checks every shipped bundle and exercises the public route/runtime and map regression tests; its catalog/site job runs generated-asset, markup, and page-builder contracts. Add new discoverable tests to the full CI suite and add a targeted Node invocation when a test protects browser-runtime behavior. CI cannot run the image pipeline or raw source-path checks because `raw_assets/` is not committed, so it uses `python3 tools/spotterdex_catalog.py validate --skip-raw-assets`; the full strict build remains a local step. A test that is intentionally CI-incompatible (for example, macOS-only Apple Foundation Models) must have its limitation documented and must not silently reduce local coverage.

The builder opens the database read-only, validates relationships and raw paths, verifies the SQL snapshot, processes all photos through one pipeline, derives indexes and statistics, and writes:

- `data/spotterdex-core.js` — shared normalized browser bundle;
- `data/spotterdex.json` — complete normalized manifest;
- `data/spotterdex-exif.js` — Stats-only EXIF data;
- generated photos, thumbnails, and unit logos;
- share pages, sitemap, and robots file.

The published web profile in `tools/build_spotterdex.py` favours fast page loads over archival-grade derivatives: full JPEGs default to 2048 px wide at quality 60, thumbnails to 768 px wide at quality 50, both at 4:2:0 chroma subsampling. Sources at or below 1920 px wide are not upscaled beyond 1920 px. `raw_assets/` sources are never modified. Manager builds pass the current Build & verify form values, initially populated from `.spotterdex-manager-build-settings.json`; Save settings persists them for later sessions. The CLI accepts `--width`, `--thumb-width`, `--jpeg-quality`, and `--thumb-jpeg-quality`.

Informational build notes, such as empty enabled locations, are acceptable. Strict mode must have no warnings or errors.

## Deployment

The production site is served from the `main` branch through GitHub Pages at `https://tlkh.github.io/spotterdex/`. The repository remote is `origin` (`https://github.com/tlkh/spotterdex`).

When asked to deploy or push the latest work:

1. Inspect `git status`, preserve unrelated user changes, and confirm the current branch and remote before staging anything.
2. For catalog or source changes, run the full local build and verification sequence above. If `raw_assets/` is unavailable, use the repo-only CI validation command with `--skip-raw-assets` and say so in the handoff.
3. Review the generated diff. Stage only the requested source changes and their generated outputs; never stage `raw_assets/`, ignored manager settings/caches, Playwright artifacts, or backups.
4. Create a focused commit with a descriptive message.
5. Push the commit to `origin` on the requested branch. For the normal production deployment, push `main` with `git push origin main`.
6. Report the commit SHA, pushed branch, verification results, and any remaining GitHub Actions or Pages deployment status. Do not force-push, rewrite history, or use destructive Git commands unless explicitly requested.

The GitHub Actions CI workflow runs on every push. A successful push to `main` is the deployment handoff; GitHub Pages may take a short time to publish the new commit. Do not claim the live site is updated until the Pages deployment has completed or the user confirms it.

## Commit scope

For catalog work, stage:

- `content/spotterdex.sqlite3`
- `content/spotterdex.sql`
- rebuilt `data/`
- rebuilt `share/`
- `sitemap.xml` and `robots.txt`
- changed `assets/generated/` and `assets/logos/`
- `service-worker.js` when the builder restamps its cache versions

Never stage `raw_assets/`, manager caches, quality acknowledgements/settings, build settings, Playwright artifacts, or database backups.

