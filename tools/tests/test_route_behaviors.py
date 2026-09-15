from __future__ import annotations

import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(shutil.which("node"), "Node.js is required for route behavior tests")
class RouteBehaviorTests(unittest.TestCase):
    def run_node(self, source: str) -> None:
        result = subprocess.run(
            ["node", "-e", textwrap.dedent(source)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_map_circle_sprite_has_opaque_center_and_transparent_corner(self) -> None:
        self.run_node(
            r'''
            const fs = require("node:fs");
            const vm = require("node:vm");
            const assert = require("node:assert/strict");
            const context = vm.createContext({assert});
            vm.runInContext(fs.readFileSync("map-page.js", "utf8"), context);
            const sprite = vm.runInContext("createMapCircleSprite(11)", context);
            assert.equal(sprite.width, 11);
            assert.equal(sprite.height, 11);
            assert.equal(sprite.data.length, 11 * 11 * 4);
            assert.equal(sprite.data[3], 0);
            const center = ((5 * 11) + 5) * 4;
            assert.equal(sprite.data[center], 101);
            assert.equal(sprite.data[center + 1], 101);
            assert.equal(sprite.data[center + 2], 101);
            assert.equal(sprite.data[center + 3], 255);
            '''
        )

    def test_airshow_archive_year_and_story_photo_normalize_inputs(self) -> None:
        self.run_node(
            r'''
            const fs = require("node:fs");
            const vm = require("node:vm");
            const assert = require("node:assert/strict");
            const context = vm.createContext({assert});
            vm.runInContext(fs.readFileSync("airshows-page.js", "utf8"), context);
            vm.runInContext(`
              state = {
                airshowYearFilter: "2025",
                data: { airshows: [
                  {id: "new", latestDate: "2026-01-02", firstDate: "2025-12-31"},
                  {id: "old", latestDate: "", firstDate: "2025-04-01"},
                  {id: "unknown", latestDate: "", firstDate: ""}
                ]}
              };
              assert.equal(airshowArchiveYear(state.data.airshows[0]), "2026");
              assert.equal(airshowArchiveYear(state.data.airshows[2]), "unknown");
              assert.deepEqual(airshowArchiveEntries().map(item => item.id), ["old"]);
              const normalized = airshowStoryPhotoRecord({}, {focalX: 2, focalY: -1, motion: "not-a-motion"});
              assert.equal(normalized.focalX, 1);
              assert.equal(normalized.focalY, 0);
              assert.equal(normalized.motion, "auto");
            `, context);
            '''
        )

    def test_stats_exif_merge_and_numeric_extremes_are_retry_safe_primitives(self) -> None:
        self.run_node(
            r'''
            const fs = require("node:fs");
            const vm = require("node:vm");
            const assert = require("node:assert/strict");
            const context = vm.createContext({assert});
            vm.runInContext(fs.readFileSync("stats-page.js", "utf8"), context);
            vm.runInContext(`
              state = {data: {photos: [{id: "a"}, {id: "b"}]}};
              mergeStatsExif({photos: {a: {Make: "Sony", ISO: 400}}});
              assert.deepEqual(state.data.photos[0].exif, {Make: "Sony", ISO: 400});
              assert.deepEqual(state.data.photos[1].exif, {});
              sortPhotos = (left, right) => left.id.localeCompare(right.id);
              const highest = statsNumericExtreme([
                {id: "low", value: 100}, {id: "high", value: 800}, {id: "missing", value: "n/a"}
              ], photo => photo.value, "max");
              assert.equal(highest.value, 800);
              assert.equal(highest.photo.id, "high");
              assert.equal(formatApertureValue(2.84), "f/2.8");
            `, context);
            '''
        )

    def test_service_worker_catalog_matching_and_cache_trim(self) -> None:
        self.run_node(
            r'''
            const fs = require("node:fs");
            const vm = require("node:vm");
            const assert = require("node:assert/strict");
            const context = vm.createContext({assert, URL,
              self: {
                registration: {scope: "https://example.test/spotterdex/"},
                addEventListener() {}
              }
            });
            vm.runInContext(fs.readFileSync("service-worker.js", "utf8"), context);
            vm.runInContext(`
              assert.equal(isCatalogData(new URL("https://example.test/spotterdex/data/spotterdex-core.js")), true);
              assert.equal(isCatalogData(new URL("https://example.test/spotterdex/data/spotterdex-exif.js")), true);
              assert.equal(isCatalogData(new URL("https://example.test/spotterdex/data/spotterdex.json")), true);
              assert.equal(isCatalogData(new URL("https://example.test/spotterdex/data/other.json")), false);
            `, context);
            const deleted = [];
            const cache = {
              async keys() { return ["old-1", "old-2", "keep"]; },
              async delete(key) { deleted.push(key); return true; }
            };
            const pending = vm.runInContext("trimCache", context)(cache, 1);
            pending.then(() => {
              assert.deepEqual(deleted, ["old-1", "old-2"]);
            }).catch(error => {
              console.error(error);
              process.exitCode = 1;
            });
            '''
        )
