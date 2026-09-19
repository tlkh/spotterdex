import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DRAFTS = ROOT / "tools" / "manager" / "drafts.js"


@unittest.skipUnless(shutil.which("node"), "Node.js is required for manager draft tests")
class ManagerDraftRecoveryTests(unittest.TestCase):
    def run_node(self, body):
        script = f"""
const fs = require('fs'), vm = require('vm');
const values = new Map();
const storage = {{
  getItem: (k) => values.has(k) ? values.get(k) : null,
  setItem: (k, v) => values.set(k, String(v)),
  removeItem: (k) => values.delete(k)
}};
const listeners = {{}};
const win = {{localStorage: storage, setTimeout, clearTimeout,
  addEventListener: (name, fn) => listeners[name] = fn,
  document: {{querySelectorAll: () => []}},
  Event: global.Event
}};
const context = {{window: win, globalThis: win, console, setTimeout, clearTimeout, Event: global.Event}};
vm.runInNewContext(fs.readFileSync({json.dumps(str(DRAFTS))}, 'utf8'), context);
const Drafts = win.SpotterDexDrafts;
function state() {{ return {{data: {{project: {{databasePath: '/tmp/catalog.sqlite3'}}}}, masterDrafts: new Map(), bulkCaptions: {{queue: null, results: {{}}, running: false, stopRequested: false}}, airshowStoryEventId: '', airshowStoryDraft: null, airshowStoryDirty: false}}; }}
{body}
"""
        result = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_round_trip_preserves_master_forms_and_story(self):
        result = self.run_node("""
const first = state();
Drafts.configure({state: first, storage});
Drafts.captureMaster(first, 'p-1', {photo: {caption: 'draft'}, changes: {caption: 'draft'}});
Drafts.captureForm('location:create', {name: 'Changi'}, {resource: 'location'}, first);
first.airshowStoryEventId = 'event-1';
first.airshowStoryDraft = {mode: 'cinematic', segments: [{photoIds: ['p-1']}]};
first.airshowStoryDirty = true;
Drafts.captureStory(first);
Drafts.persist(first);
const second = state();
Drafts.configure({state: second, storage});
const restored = Drafts.restore(second);
console.log(JSON.stringify({restored: restored.restored, master: second.masterDrafts.get('p-1'), form: second.__managerDraftForms['location:create'], event: second.airshowStoryEventId, dirty: second.airshowStoryDirty}));
""")
        self.assertTrue(result["restored"])
        self.assertEqual(result["master"]["changes"]["caption"], "draft")
        self.assertEqual(result["form"]["values"]["name"], "Changi")
        self.assertEqual(result["event"], "event-1")
        self.assertTrue(result["dirty"])

    def test_interrupted_caption_requests_are_safe_to_retry(self):
        result = self.run_node("""
const first = state();
Drafts.configure({state: first, storage});
first.bulkCaptions.queue = [{key: 'p-1'}];
first.bulkCaptions.results = { 'p-1': {status: 'generating'}, 'p-2': {status: 'saving', caption: 'maybe saved'} };
Drafts.captureCaptions(first); Drafts.persist(first);
const second = state(); Drafts.configure({state: second, storage});
Drafts.restore(second);
console.log(JSON.stringify(second.bulkCaptions.results));
""")
        self.assertEqual(result["p-1"]["status"], "error")
        self.assertIn("interrupted", result["p-1"]["message"])
        self.assertEqual(result["p-2"]["status"], "proposed")
        self.assertIn("unknown", result["p-2"]["message"])

    def test_caption_review_filter_and_hidden_proposals_survive_recovery(self):
        result = self.run_node("""
const first = state();
Drafts.configure({state: first, storage});
first.bulkCaptions.reviewFilter = 'completed';
first.bulkCaptions.queue = [{key: 'pending'}, {key: 'done'}];
first.bulkCaptions.results = {pending: {status: 'proposed', caption: 'Hidden edited proposal'}, done: {status: 'accepted', caption: 'Saved'}};
Drafts.captureCaptions(first); Drafts.persist(first);
const second = state(); Drafts.configure({state: second, storage});
Drafts.restore(second);
console.log(JSON.stringify(second.bulkCaptions));
""")
        self.assertEqual(result["reviewFilter"], "completed")
        self.assertEqual([item["key"] for item in result["queue"]], ["pending", "done"])
        self.assertEqual(result["results"]["pending"]["caption"], "Hidden edited proposal")
        self.assertEqual(result["results"]["done"]["status"], "accepted")

    def test_corrupt_storage_and_repository_isolation_do_not_break_manager(self):
        result = self.run_node("""
values.set('spotterdex.manager.drafts.v1:%2Ftmp%2Fcatalog.sqlite3', '{bad json');
const broken = state(); Drafts.configure({state: broken, storage});
const isolated = state(); isolated.data.project.databasePath = '/tmp/other.sqlite3';
Drafts.configure({state: isolated, storage});
console.log(JSON.stringify({count: isolated.masterDrafts.size, beforeUnload: Boolean(listeners.beforeunload)}));
""")
        self.assertEqual(result["count"], 0)
        self.assertTrue(result["beforeUnload"])

    def test_configure_does_not_silently_restore(self):
        result = self.run_node("""
const first = state(); Drafts.configure({state: first, storage});
Drafts.captureMaster(first, 'p-1', {changes: {caption: 'draft'}}); Drafts.persist(first);
const second = state(); Drafts.configure({state: second, storage});
console.log(JSON.stringify({before: second.masterDrafts.size, after: Drafts.restore(second).restored, size: second.masterDrafts.size}));
""")
        self.assertEqual(result["before"], 0)
        self.assertTrue(result["after"])
        self.assertEqual(result["size"], 1)

    def test_repository_namespace_includes_project_root(self):
        result = self.run_node("""
const first = state(); first.data.project.root = '/repo/one'; first.data.project.databasePath = 'content/spotterdex.sqlite3';
Drafts.configure({state: first, storage}); Drafts.captureMaster(first, 'p-1', {changes: {caption: 'one'}}); Drafts.persist(first);
const second = state(); second.data.project.root = '/repo/two'; second.data.project.databasePath = 'content/spotterdex.sqlite3';
Drafts.configure({state: second, storage}); console.log(JSON.stringify({size: second.masterDrafts.size}));
""")
        self.assertEqual(result["size"], 0)
