import json
import re
import unittest
from pathlib import Path

from PIL import Image, ImageChops

from tools.build_apple_web_app_assets import (
    IOS_DEVICE_TRIPLES,
    LAUNCH_BACKGROUND,
    LAUNCH_BACKGROUND_RGB,
    STARTUP_ASSET_VERSION,
    check_apple_web_app_assets,
    startup_assets,
)
from tools.build_pages import PAGE_DEFINITIONS


ROOT = Path(__file__).resolve().parents[2]


class AppleWebAppAssetTests(unittest.TestCase):
    def test_device_table_and_generated_outputs_are_complete(self):
        self.assertEqual(22, len(IOS_DEVICE_TRIPLES))
        self.assertEqual(22, len(set(IOS_DEVICE_TRIPLES)))
        self.assertEqual(44, len(startup_assets()))
        current, errors = check_apple_web_app_assets(ROOT)
        self.assertTrue(current, "\n".join(errors))

    def test_every_page_has_exact_startup_matrix(self):
        expected = [
            (
                f"assets/generated/startup/{asset.filename}?{STARTUP_ASSET_VERSION}",
                asset.media_query,
            )
            for asset in startup_assets()
        ]
        pattern = re.compile(
            r'<link rel="apple-touch-startup-image" href="([^"]+)" media="([^"]+)">'
        )
        for filename in PAGE_DEFINITIONS:
            with self.subTest(page=filename):
                actual = pattern.findall((ROOT / filename).read_text(encoding="utf-8"))
                self.assertEqual(expected, actual)
                self.assertEqual(44, len(set(actual)))

    def test_startup_images_match_physical_sizes_and_safe_design_region(self):
        startup_dir = ROOT / "assets" / "generated" / "startup"
        for asset in startup_assets():
            with self.subTest(asset=asset.filename):
                path = startup_dir / asset.filename
                with Image.open(path) as image:
                    self.assertEqual("PNG", image.format)
                    self.assertEqual(asset.pixel_size, image.size)
                    self.assertEqual("RGB", image.mode)
                    corners = (
                        image.getpixel((0, 0)),
                        image.getpixel((image.width - 1, 0)),
                        image.getpixel((0, image.height - 1)),
                        image.getpixel((image.width - 1, image.height - 1)),
                    )
                    self.assertEqual((LAUNCH_BACKGROUND_RGB,) * 4, corners)
                    background = Image.new("RGB", image.size, LAUNCH_BACKGROUND_RGB)
                    artwork_bounds = ImageChops.difference(image, background).getbbox()
                    self.assertIsNotNone(artwork_bounds)
                    safe_inset = round(min(image.size) * 0.25)
                    left, top, right, bottom = artwork_bounds
                    self.assertGreaterEqual(left, safe_inset)
                    self.assertGreaterEqual(top, safe_inset)
                    self.assertLessEqual(right, image.width - safe_inset)
                    self.assertLessEqual(bottom, image.height - safe_inset)

    def test_install_icons_are_opaque_square_canvases(self):
        icon_dir = ROOT / "assets" / "icons"
        expected = {
            "spotterdex-apple-touch-icon-v4.png": (180, 180),
            "spotterdex-app-icon-192.png": (192, 192),
            "spotterdex-app-icon.png": (512, 512),
            "spotterdex-app-icon-maskable-512.png": (512, 512),
            "spotterdex-app-icon-1024.png": (1024, 1024),
        }
        for filename, size in expected.items():
            with self.subTest(icon=filename), Image.open(icon_dir / filename) as image:
                self.assertEqual("PNG", image.format)
                self.assertEqual(size, image.size)
                self.assertEqual("RGB", image.mode)
                self.assertEqual(LAUNCH_BACKGROUND_RGB, image.getpixel((0, 0)))
                self.assertNotEqual(LAUNCH_BACKGROUND_RGB, image.getpixel((image.width // 2, image.height // 2)))

        with Image.open(icon_dir / "spotterdex-app-icon-maskable-512.png") as image:
            background = Image.new("RGB", image.size, LAUNCH_BACKGROUND_RGB)
            artwork_bounds = ImageChops.difference(image, background).getbbox()
            self.assertIsNotNone(artwork_bounds)
            self.assertGreaterEqual(artwork_bounds[0], 80)
            self.assertGreaterEqual(artwork_bounds[1], 80)
            self.assertLessEqual(artwork_bounds[2], 432)
            self.assertLessEqual(artwork_bounds[3], 432)

    def test_manifest_and_theme_share_launch_background(self):
        manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(LAUNCH_BACKGROUND, manifest["background_color"])
        self.assertEqual(LAUNCH_BACKGROUND, manifest["theme_color"])
        icon_contract = {(icon["sizes"], icon["purpose"], icon["src"]) for icon in manifest["icons"]}
        self.assertIn(("1024x1024", "any", "assets/icons/spotterdex-app-icon-1024.png"), icon_contract)
        self.assertIn(("512x512", "maskable", "assets/icons/spotterdex-app-icon-maskable-512.png"), icon_contract)
        self.assertIn(f"--color-paper: {LAUNCH_BACKGROUND};", (ROOT / "tokens.css").read_text(encoding="utf-8"))
        for filename in PAGE_DEFINITIONS:
            page = (ROOT / filename).read_text(encoding="utf-8")
            self.assertIn(f'<meta name="theme-color" content="{LAUNCH_BACKGROUND}">', page)
            self.assertIn("spotterdex-apple-touch-icon-v4.png", page)


class AppleWebAppInteractionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (ROOT / "script.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "styles.css").read_text(encoding="utf-8")

    def test_hint_has_versioned_state_and_ios_safari_gates(self):
        self.assertIn("spotterdex-ios-install-hint-visits-v1", self.script)
        self.assertIn("spotterdex-ios-install-hint-dismissed-v1", self.script)
        self.assertIn('navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1', self.script)
        for excluded in ("CriOS", "FxiOS", "EdgiOS", "GSA", "FBAN", "Instagram"):
            self.assertIn(excluded, self.script)
        self.assertIn("isStandaloneWebApp()", self.script)
        self.assertLess(
            self.script.index("state.iosInstallHintVisitCount = recordIosInstallHintVisit();"),
            self.script.index("maybeShowIosInstallHint();"),
        )

    def test_hint_timing_dismissal_and_suppression_contracts(self):
        normalized_script = " ".join(self.script.split())
        self.assertIn("state.iosInstallHintVisitCount >= 2 || hasMeaningfulInteraction", normalized_script)
        self.assertIn("noteMeaningfulIosInstallInteraction();", self.script)
        self.assertIn('window.localStorage.setItem(IOS_INSTALL_HINT_DISMISSED_STORAGE_KEY, "1")', self.script)
        self.assertIn("private browsing or storage policy", self.script)
        self.assertIn("Add SpotterDex to your Home Screen for a full-screen field guide.", self.script)
        for selector in (
            "body.is-viewer-open .ios-install-hint",
            "body.is-search-open .ios-install-hint",
            "body.has-app-update .ios-install-hint",
        ):
            self.assertIn(selector, self.styles)

    def test_safe_area_values_are_centralized_and_consumed_inline(self):
        for side in ("top", "right", "bottom", "left"):
            declaration = f"--safe-area-inset-{side}: env(safe-area-inset-{side}, 0px);"
            self.assertIn(declaration, self.styles)
        self.assertEqual(4, len(re.findall(r"env\(safe-area-inset-", self.styles)))
        self.assertIn("--safe-inline-left: max(12px, var(--safe-area-inset-left));", self.styles)
        self.assertIn("--safe-inline-right: max(12px, var(--safe-area-inset-right));", self.styles)
        for component in (".site-header", ".mobile-tab-bar", ".global-search-panel", ".viewer-filmstrip"):
            self.assertIn(component, self.styles)

    def test_overlay_coordinator_tracks_keyboard_and_cleans_up(self):
        for token in (
            "--overlay-page-width",
            "--overlay-page-height",
            "--overlay-viewport-height",
            "--overlay-viewport-offset-top",
            "willOpenKeyboard",
            "viewport.scale > 1.01",
            'window.visualViewport?.addEventListener("resize"',
            'window.visualViewport?.removeEventListener("resize"',
            'document.addEventListener("focusout"',
            'document.removeEventListener("focusout"',
        ):
            self.assertIn(token, self.script)
        self.assertIn("position: absolute;", self.styles)
        self.assertIn("position: sticky;", self.styles)
        self.assertIn(".viewer-viewport", self.styles)


if __name__ == "__main__":
    unittest.main()
