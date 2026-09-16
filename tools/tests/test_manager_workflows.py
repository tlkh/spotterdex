import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANAGER = ROOT / "tools" / "manager"


def extract_function(source: str, name: str) -> str:
    """Extract a top-level classic function without evaluating the manager shell."""
    match = re.search(
        rf"^(?:async )?function {re.escape(name)}\([^\n]*\) \{{.*?^}}",
        source,
        re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise AssertionError(f"missing function {name}")
    return match.group(0)


@unittest.skipUnless(shutil.which("node"), "Node.js is required for manager workflow tests")
class ManagerWorkflowBehaviorTests(unittest.TestCase):
    def run_node(self, script: str):
        program = (
            "const vm = require('node:vm');\n"
            "Promise.resolve(vm.runInNewContext(" + json.dumps(script) + ", {console}, {timeout: 5000}))"
            ".then(value => { if (value !== undefined) console.log(JSON.stringify(value)); })"
            ".catch(error => { console.error(error.stack || error); process.exitCode = 1; });"
        )
        result = subprocess.run(
            ["node"], input=program, cwd=ROOT, capture_output=True, text=True, timeout=15
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def test_library_filters_and_source_scope_share_one_canonical_collection(self):
        source = (MANAGER / "library.js").read_text("utf-8")
        functions = "\n".join(
            extract_function(source, name)
            for name in ("libraryPhotoMatches", "filteredLibraryPhotos", "libraryEditorCollection")
        )
        script = f"""
const libraryFilters = {{aircraft: "", unit: "", location: "", event: "", missing: ""}};
let librarySourceKey = "", librarySourceActive = false, libraryEditorEventId = "";
const state = {{activeTab: "master", data: {{masterPhotos: [], entries: []}}}};
const $ = () => ({{value: ""}});
const masterPhotoMatchesSearch = (photo, term) => !term || `${{photo.path}} ${{photo.location || ""}}`.toLowerCase().includes(term);
const entryByTargetKey = key => state.data.entries.find(entry => (entry.entryPath || entry.targetKey) === key);
{functions}
const photo = (id, extra = {{}}) => ({{id, path: `${{id}}.jpg`, locationId: "loc-a", location: "Alpha", exists: true, caption: "Caption", date: "2026-01-01", exifDate: "2026-01-01", subjects: [], ...extra}});
state.data.masterPhotos = [
  photo("air", {{subjects: [{{aircraftId: "a1", unitId: "u1", entryPath: "db:a1:u1"}}]}}),
  photo("unit", {{subjects: [{{unitId: "u1", unitName: "Falcons", country: "SG"}}]}}),
  photo("event", {{eventId: "show-1", airshow: "Open Day"}}),
  photo("empty-caption", {{caption: "   "}}),
  photo("no-date", {{date: "", exifDate: ""}}),
  photo("missing-source", {{exists: false}}),
  photo("other-location", {{locationId: "loc-b", location: "Bravo"}})
];
state.data.entries = [
  {{entryPath: "db:a1:u1", sourceScope: "aircraft", aircraftId: "a1"}},
  {{entryPath: "pin:loc-a", sourceScope: "location", pinId: "loc-a"}},
  {{entryPath: "squadron:f", sourceScope: "squadron-target", squadronName: "Falcons", country: "SG"}}
];
libraryFilters.aircraft = "a1";
if (filteredLibraryPhotos().map(p => p.id).join() !== "air") throw Error("aircraft filter did not match canonical subject");
libraryFilters.aircraft = ""; libraryFilters.location = "loc-b";
if (filteredLibraryPhotos().map(p => p.id).join() !== "other-location") throw Error("location filter leaked records");
libraryFilters.location = ""; libraryFilters.missing = "caption";
if (filteredLibraryPhotos().map(p => p.id).sort().join() !== "empty-caption") throw Error("missing caption filter incorrect");
libraryFilters.missing = "date";
if (filteredLibraryPhotos().map(p => p.id).sort().join() !== "no-date") throw Error("missing date filter incorrect");
libraryFilters.missing = "source";
if (filteredLibraryPhotos().map(p => p.id).sort().join() !== "missing-source") throw Error("missing source filter incorrect");
libraryFilters.missing = "";
librarySourceActive = true; librarySourceKey = "pin:loc-a";
if (filteredLibraryPhotos().map(p => p.id).sort().join() !== "empty-caption,event,missing-source,no-date") throw Error("location source scope incorrect");
state.data.masterPhotos.find(p => p.id === "air").locationId = "loc-a";
librarySourceKey = "squadron:f";
if (filteredLibraryPhotos().map(p => p.id).join() !== "unit") throw Error("squadron source scope incorrect");
librarySourceActive = false; libraryEditorEventId = "show-1";
if (libraryEditorCollection().map(p => p.id).join() !== "event") throw Error("event editor collection incorrect");
console.log(JSON.stringify({{all: state.data.masterPhotos.length, event: libraryEditorCollection()[0].id}}));
"""
        result = self.run_node(script)
        self.assertEqual(result, {"all": 7, "event": "event"})

    def test_prepare_mutation_uses_draft_revision_for_optimistic_save(self):
        source = (MANAGER / "recovery-ui.js").read_text("utf-8")
        functions = "\n".join(extract_function(source, name) for name in ("managerPhotoId", "prepareManagerMutation"))
        script = f"""
const state = {{data: {{revisions: {{"photo:p1": "saved-r1", "location:l1": "loc-r1", "entry:e1": "entry-r1"}}, entries: [], squadronGroups: [], airshowEvents: []}}, masterDrafts: new Map(), __managerDraftForms: {{}}}};
const CSS = {{escape: value => value}};
const document = {{querySelector: () => null}};
const $ = () => ({{dataset: {{}}}});
const entryByTargetKey = () => null;
{functions}
state.masterDrafts.set("p1", {{photo: {{_revision: "draft-r2"}}, changes: {{caption: "new"}}}});
const update = prepareManagerMutation("/api/update-master-photo", {{photoId: "p1", caption: "new"}});
const bulk = prepareManagerMutation("/api/bulk-update-photos", {{photos: [{{photoId: "p1"}}, {{photoId: "p2"}}]}});
const pin = prepareManagerMutation("/api/update-pin", {{locationId: "l1", name: "Alpha"}});
console.log(JSON.stringify({{update: update.expectedRevisions, bulk: bulk.expectedRevisions, pin: pin.expectedRevisions}}));
"""
        result = self.run_node(script)
        self.assertEqual(result["update"], {"photo:p1": "draft-r2"})
        self.assertEqual(result["bulk"], {"photo:p1": "saved-r1", "photo:p2": "missing-editor-revision"})
        self.assertEqual(result["pin"], {"location:l1": "loc-r1"})

    def test_reconnecting_build_observer_only_polls_and_never_posts(self):
        source = (MANAGER / "build-jobs.js").read_text("utf-8")
        functions = "\n".join(
            extract_function(source, name)
            for name in ("setManagerBuildBusy", "pollManagerBuildJob", "connectManagerBuildJob", "reconnectManagerBuild")
        )
        script = f"""
let managerBuildJobId = "", managerBuildCursor = 0, managerBuildTimer = null, managerBuildPolling = false, managerBuildCompletedId = "", managerBuildStarting = false;
const nodes = {{}};
const $ = id => nodes[id] ||= {{disabled: false, textContent: "", dataset: {{}}, value: "", innerHTML: ""}};
const calls = [];
const api = async (path) => {{ calls.push(path); if (path === "/api/build-jobs") return {{activeJobId: "job-7", jobs: [{{id: "job-7", status: "running"}}]}}; throw Error("connection dropped"); }};
const clearTimeout = () => {{}};
const setTimeout = () => 1;
const appendBuildLog = () => {{}};
const renderBuildSummary = () => {{}};
const loadState = async () => {{ throw Error("must not refresh state while disconnected"); }};
{functions}
(async () => {{
await reconnectManagerBuild();
if (calls.some(path => path.startsWith("/api/build-jobs") === false)) throw Error("unexpected API path");
if (calls.some(path => path.startsWith("POST"))) throw Error("observer attempted a POST");
if (calls.length !== 2 || calls[0] !== "/api/build-jobs" || !calls[1].startsWith("/api/build-jobs/job-7?cursor=0")) throw Error(`unexpected calls: ${{calls.join(",")}}`);
if (managerBuildJobId !== "job-7") throw Error("observer lost active job identity");
if ($("buildStatus").dataset.status !== "unknown") throw Error("connection loss was not surfaced as unknown");
console.log(JSON.stringify({{calls, status: $("buildStatus").textContent, busy: $("buildBtn").disabled}}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(len(result["calls"]), 2)
        self.assertIn("connection lost", result["status"].lower())
        self.assertTrue(result["busy"])


if __name__ == "__main__":
    unittest.main()
