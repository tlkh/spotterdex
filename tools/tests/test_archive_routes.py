from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(shutil.which("node"), "Node.js is required for route behavior tests")
class ArchiveRouteBehaviorTests(unittest.TestCase):
    def run_script(self, script: str) -> None:
        result = subprocess.run(
            ["node", "-e", script], cwd=ROOT, text=True, capture_output=True
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_airshow_year_filter_counts_and_unknown_dates(self) -> None:
        self.run_script("""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const select = { innerHTML: '', value: '' };
const context = vm.createContext({
  state: { airshowYearFilter: '', data: { airshows: [
    { id: 'a', latestDate: '2025-06-01' },
    { id: 'b', firstDate: '2025-02-01' },
    { id: 'c', latestDate: '2024-01-01' },
    { id: 'd' }
  ] } },
  document: { getElementById: () => select },
  escapeAttr: String, escapeHtml: String
});
vm.runInContext(fs.readFileSync('airshows-page.js', 'utf8'), context);
assert.equal(vm.runInContext('airshowArchiveEntries().length', context), 4);
vm.runInContext('renderAirshowYearFilter(state.data.airshows)', context);
assert.match(select.innerHTML, /2025 \\(2\\)/);
assert.match(select.innerHTML, /Date unknown \\(1\\)/);
context.state.airshowYearFilter = '2025';
assert.equal(vm.runInContext('airshowArchiveEntries().length', context), 2);
context.state.airshowYearFilter = 'unknown';
assert.equal(vm.runInContext('airshowArchiveEntries()[0].id', context), 'd');
context.state.airshowYearFilter = '1999';
assert.equal(vm.runInContext('airshowArchiveEntries().length', context), 0);
vm.runInContext('renderAirshowYearFilter(state.data.airshows)', context);
assert.match(select.innerHTML, /1999 \\(0\\)/);
assert.equal(select.value, '1999');
""")

    def test_camera_data_failure_can_retry_and_recover(self) -> None:
        self.run_script("""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
let attempts = 0;
let rendered = 0;
const dashboard = {
  innerHTML: '', setAttribute() {}, removeAttribute() {},
  querySelector() { return { addEventListener() {} }; }
};
const context = vm.createContext({
  els: { exifDashboard: dashboard },
  state: { statsExifReady: false, data: { photos: [{ id: 'one' }] } },
  loadStatsExifBundle: async () => ++attempts === 1 ? null : { photos: { one: { iso: 100 } } }
});
vm.runInContext(fs.readFileSync('stats-page.js', 'utf8'), context);
context.renderExifDashboard = () => { rendered++; };
context.renderStatsArchiveHero = () => {};
(async () => {
  await context.ensureStatsExifRendered();
  assert.match(dashboard.innerHTML, /data-retry-exif/);
  assert.equal(context.state.statsExifReady, false);
  await context.ensureStatsExifRendered();
  assert.equal(attempts, 2);
  assert.equal(context.state.statsExifReady, true);
  assert.equal(context.state.data.photos[0].exif.iso, 100);
  assert.equal(rendered, 1);
})().catch(error => { console.error(error); process.exitCode = 1; });
""")
