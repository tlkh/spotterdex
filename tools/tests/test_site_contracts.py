from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from tools import build_pages
from tools.build_spotterdex import (
    BuildWarningLog,
    latest_photo_date,
    stable_generated_at,
    stamp_service_worker,
    write_text_if_changed,
)

ROOT = Path(__file__).resolve().parents[2]

# Raw literals still present in styles.css when the design-token contract was
# first enforced. design.md allows only semantic colour tokens and the three
# named eases, so these counts may fall but must never rise.
MAX_RAW_HEX_COLOURS = 202
MAX_RAW_CUBIC_BEZIERS = 17


class GeneratedPageContractTests(unittest.TestCase):
    """The five top-level pages are generated; hand-edits are silently reverted."""

    def test_head_keeps_safe_area_viewport(self) -> None:
        # styles.css positions the mobile tab bar and sheets with
        # env(safe-area-inset-*), which resolves to 0 on iOS without this opt-in.
        for filename in build_pages.PAGE_DEFINITIONS:
            with self.subTest(page=filename):
                document = build_pages.render_page(filename, ROOT)
                self.assertIn(
                    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
                    document,
                )

    def test_head_links_tokens_before_styles(self) -> None:
        for filename in build_pages.PAGE_DEFINITIONS:
            with self.subTest(page=filename):
                document = build_pages.render_page(filename, ROOT)
                self.assertIn('<link rel="stylesheet" href="tokens.css">', document)
                self.assertLess(document.index("tokens.css"), document.index("styles.css"))

    def test_styles_does_not_reimport_tokens(self) -> None:
        # An @import would serialise the two stylesheet requests behind styles.css.
        self.assertNotIn("@import", (ROOT / "styles.css").read_text("utf-8"))

    def test_every_page_header_exposes_universal_search(self) -> None:
        for filename in build_pages.PAGE_DEFINITIONS:
            with self.subTest(page=filename):
                document = build_pages.render_page(filename, ROOT)
                self.assertIn("data-global-search-trigger", document)
                self.assertIn('aria-keyshortcuts="Control+K Meta+K"', document)

    def test_archive_pages_rely_on_universal_search(self) -> None:
        documents = {
            filename: build_pages.render_page(filename, ROOT)
            for filename in ("aircraft-dex.html", "squadrons.html")
        }
        self.assertNotIn("aircraftSearch", documents["aircraft-dex.html"])
        self.assertNotIn("squadronSearch", documents["squadrons.html"])

    def test_committed_pages_match_the_generator(self) -> None:
        for filename in build_pages.PAGE_DEFINITIONS:
            with self.subTest(page=filename):
                self.assertEqual(
                    (ROOT / filename).read_text("utf-8"),
                    build_pages.render_page(filename, ROOT),
                    f"{filename} differs from tools/build_pages.py output; a rebuild would revert it.",
                )


class ArchiveLayoutContractTests(unittest.TestCase):
    """Country sections are a vertical stack, not a card grid."""

    def test_country_list_never_gets_column_tracks(self) -> None:
        # .squadron-country-list holds one section per country, each with its own
        # heading and card grid. Giving the list columns halves every section and
        # leaves the phone card rules stacking one narrow card per row.
        offenders = [
            selector.strip()
            for selector, body in _css_rules()
            if "squadron-country-list" in selector and "grid-template-columns" in body
        ]
        self.assertEqual(offenders, [])


class MobileChromeLayoutContractTests(unittest.TestCase):
    """Transient status UI must not inherit title-dependent header tracks."""

    def test_contextual_offline_status_owns_a_compact_row(self) -> None:
        matching_bodies = [
            body
            for selector, body in _css_rules()
            if ".site-header.is-contextual > .mobile-connectivity" in selector
        ]
        self.assertTrue(matching_bodies, "expected a contextual offline-status layout rule")
        declarations = "\n".join(matching_bodies)
        self.assertRegex(declarations, r"grid-column\s*:\s*1\s*/\s*-1")
        self.assertRegex(declarations, r"justify-self\s*:\s*start")


class GlobalSearchPresentationContractTests(unittest.TestCase):
    """The composite search field owns one intentional focus treatment."""

    def test_search_input_does_not_draw_a_second_square_focus_outline(self) -> None:
        rules = _css_rules()
        wrapper_rules = [
            body for selector, body in rules if ".global-search-control:focus-within" in selector
        ]
        input_rules = [
            body for selector, body in rules if ".global-search-control input:focus-visible" in selector
        ]
        self.assertTrue(wrapper_rules, "expected the rounded search control to own the focus ring")
        self.assertTrue(input_rules, "expected a focused-input outline reset")
        self.assertRegex("\n".join(wrapper_rules), r"box-shadow\s*:\s*var\(--focus-ring\)")
        self.assertRegex("\n".join(input_rules), r"outline\s*:\s*none\s*!important")
        self.assertRegex("\n".join(input_rules), r"box-shadow\s*:\s*none")


class MobileViewerLayoutContractTests(unittest.TestCase):
    def test_lightbox_top_controls_clear_the_ios_status_bar(self) -> None:
        styles = (ROOT / "styles.css").read_text("utf-8")
        controls = re.search(
            r"\.viewer-telemetry,\s*\.viewer-button\.close,\s*\.viewer-button\.info-toggle\s*\{(.*?)\n  \}",
            styles,
            re.DOTALL,
        )
        self.assertIsNotNone(controls)
        self.assertRegex(
            controls.group(1),
            r"top\s*:\s*max\(18px,\s*calc\(env\(safe-area-inset-top\)\s*\+\s*12px\)\)",
        )


class OfflineMediaExperienceContractTests(unittest.TestCase):
    """Offline photos degrade into useful archive records, not broken images."""

    def setUp(self) -> None:
        self.script = (ROOT / "script.js").read_text("utf-8")
        self.styles = (ROOT / "styles.css").read_text("utf-8")

    def test_photo_errors_render_metadata_fallbacks_and_cache_coverage(self) -> None:
        for contract in (
            'data-photo-media="photo"',
            "handlePhotoMediaError",
            "renderPhotoMediaFallback",
            "data-offline-media-coverage",
            "photoIsCachedForOffline",
            "window.caches.match",
        ):
            with self.subTest(contract=contract):
                self.assertIn(contract, self.script)
        self.assertIn(".photo-card.is-media-unavailable", self.styles)
        self.assertIn(".offline-media-coverage", self.styles)

    def test_field_guides_prefer_native_share_with_copy_fallback(self) -> None:
        share_handler = re.search(
            r"async function shareFieldGuide\(button\) \{(.*?)\n  \}",
            self.script,
            re.DOTALL,
        )
        self.assertIsNotNone(share_handler)
        self.assertIn("await navigator.share(payload)", share_handler.group(1))
        self.assertIn("await copyText(payload.url)", share_handler.group(1))
        self.assertIn("data-field-guide-share", self.script)


def _css_rules() -> list[tuple[str, str]]:
    """Return (selector list, declarations) for every rule in styles.css.

    The pattern only matches innermost blocks, so @media preludes are skipped
    rather than returned as selectors.
    """
    styles = (ROOT / "styles.css").read_text("utf-8")
    return re.findall(r"([^{}]+)\{([^{}]*)\}", styles)


class ServiceWorkerContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.worker = (ROOT / "service-worker.js").read_text("utf-8")

    def _shell_paths(self) -> list[str]:
        block = re.search(r"const SHELL_PATHS = \[(.*?)\];", self.worker, re.DOTALL)
        self.assertIsNotNone(block, "service-worker.js must declare SHELL_PATHS")
        return re.findall(r'"([^"]+)"', block.group(1))

    def test_every_generated_catalog_payload_is_network_first(self) -> None:
        # A catalog bundle served from the offline shell shows the previous deploy.
        pattern = re.search(r"return (/.+/)\.test\(url\.pathname\)", self.worker)
        self.assertIsNotNone(pattern, "isCatalogData must test a regex literal")
        catalog_regex = re.compile(pattern.group(1).strip("/"))
        payloads = sorted(path.name for path in (ROOT / "data").glob("spotterdex*"))
        self.assertTrue(payloads, "expected generated catalog payloads under data/")
        for name in payloads:
            with self.subTest(payload=name):
                self.assertRegex(f"/data/{name}", catalog_regex)

    def test_precached_shell_assets_all_exist(self) -> None:
        for relative in self._shell_paths():
            if relative == "./":
                continue
            with self.subTest(asset=relative):
                self.assertTrue((ROOT / relative).is_file(), f"{relative} is precached but missing")

    def test_shell_precaches_the_design_tokens(self) -> None:
        # styles.css is precached, so tokens.css must be too or an offline load
        # renders with every semantic colour undefined.
        self.assertIn("tokens.css", self._shell_paths())

    def test_cache_versions_are_content_stamped(self) -> None:
        for constant in ("SHELL_CACHE_VERSION", "MEDIA_CACHE_VERSION"):
            with self.subTest(constant=constant):
                match = re.search(rf'const {constant} = "([^"]+)"', self.worker)
                self.assertIsNotNone(match)
                self.assertRegex(match.group(1), r"^spotterdex-(shell|media)-[0-9a-f]{16}$")

    def test_updates_wait_for_user_activation(self) -> None:
        install = re.search(
            r'self\.addEventListener\("install".*?(?=self\.addEventListener\("activate")',
            self.worker,
            re.DOTALL,
        )
        self.assertIsNotNone(install)
        self.assertNotIn("skipWaiting", install.group(0))
        self.assertIn('event.data?.type === "SKIP_WAITING"', self.worker)
        self.assertIn("event.waitUntil(self.skipWaiting())", self.worker)

    def test_worker_reports_its_generated_shell_version(self) -> None:
        self.assertIn('event.data?.type === "GET_VERSION"', self.worker)
        self.assertIn("version: SHELL_CACHE_VERSION", self.worker)


class ServiceWorkerClientContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.script = (ROOT / "script.js").read_text("utf-8")

    def test_client_detects_waiting_workers_without_automatic_reload(self) -> None:
        for hook in ("updatefound", "statechange", "controllerchange", "visibilitychange"):
            with self.subTest(hook=hook):
                self.assertIn(f'"{hook}"', self.script)
        controller_handler = re.search(
            r"function handleServiceWorkerControllerChange\(\) \{(.*?)\n  \}",
            self.script,
            re.DOTALL,
        )
        self.assertIsNotNone(controller_handler)
        self.assertRegex(
            controller_handler.group(1),
            r"if \(state\.updateReloadPending\)[\s\S]*?window\.location\.reload\(\)",
        )

    def test_client_has_universal_search_and_actionable_update_ui(self) -> None:
        for contract in (
            "buildGlobalSearchIndex",
            "globalSearchMatches",
            "data-global-search-trigger",
            "appUpdatePrompt",
            "SKIP_WAITING",
            "GET_VERSION",
        ):
            with self.subTest(contract=contract):
                self.assertIn(contract, self.script)


class MapSelectionContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.script = (ROOT / "script.js").read_text("utf-8")

    def test_default_map_selection_prefers_latest_non_singapore_location(self) -> None:
        selection = re.search(
            r"function chooseInitialSelections\(\) \{(.*?)\n  \}",
            self.script,
            re.DOTALL,
        )
        self.assertIsNotNone(selection)
        self.assertIn(
            'recent.find(({ pin }) => normalizeKey(pin.country) !== "singapore") || recent[0]',
            selection.group(1),
        )


class ServiceWorkerStampingTests(unittest.TestCase):
    WORKER_TEMPLATE = (
        'const SHELL_CACHE_VERSION = "spotterdex-shell-0000000000000000";\n'
        'const MEDIA_CACHE_VERSION = "spotterdex-media-0000000000000000";\n'
        'const SHELL_PATHS = [\n  "./",\n  "index.html",\n  "styles.css"\n];\n'
    )

    def _fixture(self, root: Path, styles: str = "body{}") -> Path:
        (root / "index.html").write_text("<!doctype html>", encoding="utf-8")
        (root / "styles.css").write_text(styles, encoding="utf-8")
        worker = root / "service-worker.js"
        worker.write_text(self.WORKER_TEMPLATE, encoding="utf-8")
        return worker

    def test_stamping_is_stable_but_follows_shell_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            worker = self._fixture(root)

            self.assertIsNotNone(stamp_service_worker(root, "profile-a", BuildWarningLog()))
            first = worker.read_text("utf-8")
            self.assertNotIn("0000000000000000", first)

            # Unchanged shell must not rewrite the file, or every build churns.
            self.assertIsNone(stamp_service_worker(root, "profile-a", BuildWarningLog()))
            self.assertEqual(worker.read_text("utf-8"), first)

            (root / "styles.css").write_text("body{color:red}", encoding="utf-8")
            self.assertIsNotNone(stamp_service_worker(root, "profile-a", BuildWarningLog()))
            self.assertNotEqual(worker.read_text("utf-8"), first)

    def test_media_version_follows_the_image_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            worker = self._fixture(root)
            stamp_service_worker(root, "profile-a", BuildWarningLog())
            before = re.search(r'MEDIA_CACHE_VERSION = "([^"]+)"', worker.read_text("utf-8")).group(1)

            stamp_service_worker(root, "profile-b", BuildWarningLog())
            after = re.search(r'MEDIA_CACHE_VERSION = "([^"]+)"', worker.read_text("utf-8")).group(1)
            self.assertNotEqual(before, after)

    def test_missing_precached_asset_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            worker = self._fixture(root)
            (root / "styles.css").unlink()
            warnings = BuildWarningLog()
            stamp_service_worker(root, "profile-a", warnings)
            self.assertTrue(warnings.has_warnings())
            self.assertNotIn("0000000000000000", worker.read_text("utf-8"))


class ReproducibleOutputTests(unittest.TestCase):
    def test_write_text_if_changed_skips_identical_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "nested" / "output.txt"
            self.assertTrue(write_text_if_changed(target, "first"))
            self.assertFalse(write_text_if_changed(target, "first"))
            self.assertTrue(write_text_if_changed(target, "second"))
            self.assertEqual(target.read_text("utf-8"), "second")

    def test_generated_at_is_reused_when_payload_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            previous = Path(temporary) / "spotterdex.json"
            previous.write_text(
                json.dumps({"generatedAt": "2026-01-01T00:00:00+00:00", "entities": {"photos": {}}}),
                encoding="utf-8",
            )
            manifest = {"generatedAt": "2026-07-26T12:00:00+00:00", "entities": {"photos": {}}}
            self.assertEqual(
                stable_generated_at(manifest["generatedAt"], manifest, previous),
                "2026-01-01T00:00:00+00:00",
            )

    def test_generated_at_advances_when_payload_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            previous = Path(temporary) / "spotterdex.json"
            previous.write_text(
                json.dumps({"generatedAt": "2026-01-01T00:00:00+00:00", "entities": {"photos": {}}}),
                encoding="utf-8",
            )
            manifest = {"generatedAt": "2026-07-26T12:00:00+00:00", "entities": {"photos": {"a": {}}}}
            self.assertEqual(
                stable_generated_at(manifest["generatedAt"], manifest, previous),
                "2026-07-26T12:00:00+00:00",
            )

    def test_generated_at_is_kept_when_no_previous_build_exists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest = {"generatedAt": "2026-07-26T12:00:00+00:00"}
            self.assertEqual(
                stable_generated_at(manifest["generatedAt"], manifest, Path(temporary) / "absent.json"),
                "2026-07-26T12:00:00+00:00",
            )

    def test_latest_photo_date_picks_the_newest_valid_date(self) -> None:
        self.assertEqual(
            latest_photo_date([{"date": "2023-01-05"}, {"date": "2026-04-08"}, {"date": "bad"}, {}]),
            "2026-04-08",
        )
        self.assertEqual(latest_photo_date([]), "")
        self.assertEqual(latest_photo_date([{"date": "2026"}]), "")


class DesignTokenRatchetTests(unittest.TestCase):
    """design.md locks the palette and easing set; drift must not grow."""

    def setUp(self) -> None:
        self.css = (ROOT / "styles.css").read_text("utf-8")

    def test_raw_hex_colours_do_not_grow(self) -> None:
        found = re.findall(r"#[0-9a-fA-F]{3,8}\b", self.css)
        self.assertLessEqual(
            len(found),
            MAX_RAW_HEX_COLOURS,
            "styles.css gained raw hex colours; use a --color-* token from tokens.css "
            f"or lower MAX_RAW_HEX_COLOURS (now {len(found)}).",
        )

    def test_raw_easing_curves_do_not_grow(self) -> None:
        found = re.findall(r"cubic-bezier\(", self.css)
        self.assertLessEqual(
            len(found),
            MAX_RAW_CUBIC_BEZIERS,
            "styles.css gained raw cubic-bezier() curves; use --ease-out, --ease-in or "
            f"--ease-in-out or lower MAX_RAW_CUBIC_BEZIERS (now {len(found)}).",
        )

    def test_documented_tokens_exist(self) -> None:
        tokens = (ROOT / "tokens.css").read_text("utf-8")
        for token in ("--color-paper", "--color-surface", "--color-ink", "--color-muted",
                      "--color-rule", "--color-accent", "--color-focus",
                      "--ease-out", "--ease-in", "--ease-in-out"):
            with self.subTest(token=token):
                self.assertIn(f"{token}:", tokens)


if __name__ == "__main__":
    unittest.main()
