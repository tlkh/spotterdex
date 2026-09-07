from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
MANAGER = ROOT / "tools" / "manager"


class ManagerMarkup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.nodes = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "ancestors": tuple(self.stack)}
        self.nodes.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                break

    def by_id(self, identifier):
        return next(node for node in self.nodes if node["attrs"].get("id") == identifier)

    def within(self, identifier):
        parent = self.by_id(identifier)
        return [node for node in self.nodes if any(item is parent for item in node["ancestors"])]


class ManagerHtmlContractTests(unittest.TestCase):
    def setUp(self):
        self.html = ManagerMarkup()
        self.html.feed((MANAGER / "app.html").read_text("utf-8"))

    def test_utility_drawer_is_labelled_native_dialog(self):
        drawer = self.html.by_id("utilityDrawer")
        self.assertEqual(drawer["tag"], "dialog")
        self.assertEqual(drawer["attrs"]["aria-labelledby"], "utilityDrawerTitle")
        descendants = self.html.within("utilityDrawer")
        for identifier in ("utilityDrawerTitle", "utilityDrawerBody", "closeUtilityDrawerBtn"):
            self.assertIn(self.html.by_id(identifier), descendants)
        self.assertEqual(self.html.by_id("closeUtilityDrawerBtn")["attrs"]["type"], "button")

    def test_filters_expose_pressed_state_not_tab_semantics(self):
        for identifier, attribute in (("assetFilter", "data-filter"), ("qualityFilters", "data-quality-filter")):
            with self.subTest(identifier=identifier):
                self.assertEqual(self.html.by_id(identifier)["attrs"]["role"], "group")
                buttons = [node for node in self.html.within(identifier) if attribute in node["attrs"]]
                self.assertGreaterEqual(len(buttons), 3)
                self.assertEqual(sum(node["attrs"].get("aria-pressed") == "true" for node in buttons), 1)
                for node in buttons:
                    self.assertEqual(node["tag"], "button")
                    self.assertIn(node["attrs"].get("aria-pressed"), ("true", "false"))
                    self.assertNotIn("aria-selected", node["attrs"])

    def test_source_photo_editor_is_separate_from_new_image_attachment(self):
        attach = self.html.within("attachView")
        source = self.html.within("source-photosView")
        for identifier in ("entrySelect", "captionInput", "attachBtn"):
            self.assertIn(self.html.by_id(identifier), attach)
            self.assertNotIn(self.html.by_id(identifier), source)
        for identifier in ("sourcePhotoSelect", "taggedBulkEditor", "editCaption", "editPath"):
            self.assertIn(self.html.by_id(identifier), source)
            self.assertNotIn(self.html.by_id(identifier), attach)

    def test_primary_navigation_is_consolidated(self):
        nav = next(node for node in self.html.nodes if node["attrs"].get("aria-label") == "Manager views")
        tabs = [node["attrs"]["data-tab"] for node in self.html.nodes
                if "data-tab" in node["attrs"] and any(parent is nav for parent in node["ancestors"])]
        self.assertEqual(len(tabs), len(set(tabs)))
        self.assertEqual(set(tabs), {"attach", "master", "aircraft-database", "squadron-database", "locations-database", "airshows", "writeups", "bulk-captions", "missing", "quality", "build"})
        self.assertEqual(self.html.by_id("workspaceNav")["tag"], "nav")

    def test_caption_queue_controls_and_accessible_status(self):
        scope = self.html.by_id("bulkCaptionScope")
        self.assertEqual(scope["tag"], "select")
        self.assertEqual({node["attrs"]["value"] for node in self.html.within("bulkCaptionScope") if node["tag"] == "option"}, {"selected", "filtered", "all"})
        self.html.by_id(scope["attrs"]["aria-describedby"])
        for identifier in ("refreshBulkCaptionsBtn", "retryBulkCaptionsBtn", "stopBulkCaptionsBtn", "runBulkCaptionsBtn"):
            self.assertEqual(self.html.by_id(identifier)["attrs"]["type"], "button")
        self.assertIn("checked", self.html.by_id("bulkExcludeAiCaptions")["attrs"])
        self.assertEqual(self.html.by_id("bulkCaptionSummary")["attrs"]["aria-live"], "polite")
        self.assertEqual(self.html.by_id("bulkCaptionSummary")["attrs"]["role"], "status")


@unittest.skipUnless(shutil.which("node"), "Node.js is required for Manager behavior tests")
class ManagerCaptionBehaviorTests(unittest.TestCase):
    def run_behavior(self, body):
        source = (MANAGER / "app.js").read_text("utf-8")
        names = ("selectedBulkCaptionCandidates", "currentBulkCaptionQueue", "resetBulkCaptionQueue", "bulkProposalValue", "renderBulkCaptions", "runBulkCaptions", "acceptBulkCaption", "rejectBulkCaption", "masterPhotoMatchesSearch", "escapeHtml", "thumbUrl")
        functions = []
        for name in names:
            match = re.search(r"^    (?:async )?function " + name + r"\([^\n]*\) \{.*?^    \}", source, re.MULTILINE | re.DOTALL)
            self.assertIsNotNone(match, name)
            functions.append(match.group(0))
        setup = r'''
            const nodes = {};
            const $ = id => nodes[id] ||= {value: "", disabled: false, dataset: {}};
            let drafts = [];
            const document = {querySelectorAll: () => drafts};
            const window = {confirm: () => true};
            const state = {
                data: {entries: [], masterPhotos: []},
                bulkEdit: {master: new Set()},
                selectedAssets: new Set(),
                bulkCaptions: {queue: null, results: {}, running: false, stopRequested: false, scope: "selected", excludeAi: true}
            };
            let api = async () => {throw Error("Unexpected API request");};
            let fetch = async () => {throw Error("Unexpected fetch");};
            const readApiJson = async response => response;
            const entryRequestFields = entry => ({entryPath: entry.entryPath});
            const wait = async () => {};
            let reloads = 0;
            const loadState = async () => {reloads++;};
            const toast = () => {};
            const photo = (id, extra = {}) => ({id, photoId: id, path: `${id}.jpg`, sourceAssetPath: `${id}.jpg`, exists: true, caption: "", locationId: "base", ...extra});
            const candidate = id => ({key: id, entry: {entryPath: "db:location:base"}, photo: photo(id)});
        '''
        script = setup + "\n" + "\n".join(functions) + "\n(async () => {\n" + body + "\n})()"
        program = 'const vm = require("node:vm"); const assert = require("node:assert/strict");\n'
        program += "Promise.resolve(vm.runInNewContext(" + json.dumps(script) + ', {assert}, {timeout: 5000})).catch(error => {console.error(error); process.exitCode = 1;});'
        result = subprocess.run(["node", "-e", program], cwd=ROOT, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_scopes_use_canonical_deduplicated_photos_and_include_missing_captions(self):
        self.run_behavior(r'''
            const a = photo("a", {caption: "   ", subjects: [{unitName: "Falcons"}]});
            const b = photo("b", {caption: "Existing", captionAiAssisted: true});
            const c = photo("c", {caption: "Manual"});
            state.data.masterPhotos = [a, b, c, photo("missing", {exists: false}), photo("invalid", {invalid: true}), photo("no-source", {sourceAssetPath: ""})];
            state.data.entries = [{entryPath: "first", photos: [photo("a", {caption: "Stale"}), {path: "a.jpg"}, b]}, {entryPath: "second", photos: [a, photo("legacy")]}];
            state.bulkEdit.master = new Set(["a", "b"]);
            state.selectedAssets.add("c.jpg");
            let selection = selectedBulkCaptionCandidates();
            assert.equal(selection.candidates.map(item => item.key).join(), "a");
            assert.equal(selection.candidates[0].photo.caption, "   ");
            assert.equal(selection.existingPhotoCount, 2);
            assert.equal(selection.aiExcludedCount, 1);
            assert.equal(selection.missingCaptionCount, 1);
            state.bulkCaptions.scope = "filtered";
            $("masterSearch").value = " FALCONS ";
            assert.equal(selectedBulkCaptionCandidates().candidates.map(item => item.key).join(), "a");
            $("masterSearch").value = "";
            assert.equal(selectedBulkCaptionCandidates().candidates.map(item => item.key).sort().join(), "a,c");
            state.bulkCaptions.scope = "all";
            $("masterSearch").value = "no match";
            selection = selectedBulkCaptionCandidates();
            assert.equal(selection.candidates.map(item => item.key).sort().join(), "a,c,legacy");
            assert.equal(selection.missingCaptionCount, 2);
            state.bulkCaptions.excludeAi = false;
            assert.equal(selectedBulkCaptionCandidates().candidates.length, 4);
        ''')

    def test_queue_freezes_stops_after_current_request_resumes_and_retries_only_errors(self):
        self.run_behavior(r'''
            state.data.masterPhotos = [photo("a"), photo("b"), photo("c")];
            state.bulkEdit.master = new Set(["a", "b", "c"]);
            const calls = [];
            let release;
            api = async (url, payload) => {
                assert.equal(url, "/api/generate-caption");
                calls.push(payload.photoId);
                if (payload.photoId === "a") return new Promise(resolve => {release = resolve;});
                if (payload.photoId === "b") throw Error("Temporary failure");
                return {caption: "Draft C"};
            };
            const firstRun = runBulkCaptions();
            assert.equal(state.bulkCaptions.running, true);
            assert.equal($("bulkCaptionScope").disabled, true);
            await runBulkCaptions();
            assert.equal(calls.join(), "a");
            state.bulkCaptions.stopRequested = true;
            state.bulkEdit.master = new Set(["c"]);
            $("masterSearch").value = "changed";
            release({caption: "Draft A"});
            await firstRun;
            assert.equal(state.bulkCaptions.running, false);
            assert.equal(calls.join(), "a");
            assert.equal(currentBulkCaptionQueue().map(item => item.key).join(), "a,b,c");
            assert.equal(state.bulkCaptions.results.a.status, "proposed");
            assert.equal(state.bulkCaptions.results.b, undefined);
            await runBulkCaptions();
            assert.equal(calls.join(), "a,b,c");
            assert.equal(state.bulkCaptions.results.b.status, "error");
            assert.equal(state.bulkCaptions.results.c.status, "proposed");
            api = async (url, payload) => {calls.push(payload.photoId); return {caption: "Recovered"};};
            await runBulkCaptions(true);
            assert.equal(calls.join(), "a,b,c,b");
            assert.equal(state.bulkCaptions.results.b.caption, "Recovered");
            assert.equal(state.bulkCaptions.results.a.caption, "Draft A");
            assert.equal(reloads, 0);
        ''')

    def test_reset_confirms_pending_drafts_and_blocks_running_or_saving(self):
        self.run_behavior(r'''
            const queue = [candidate("a")];
            state.bulkCaptions.queue = queue;
            state.bulkCaptions.results.a = {status: "proposed", caption: "Keep me"};
            let confirmations = 0;
            window.confirm = () => {confirmations++; return false;};
            assert.equal(resetBulkCaptionQueue(), false);
            assert.equal(state.bulkCaptions.queue, queue);
            assert.equal(state.bulkCaptions.results.a.caption, "Keep me");
            state.bulkCaptions.running = true;
            assert.equal(resetBulkCaptionQueue(), false);
            state.bulkCaptions.running = false;
            state.bulkCaptions.results.a.status = "saving";
            assert.equal(resetBulkCaptionQueue(), false);
            assert.equal(confirmations, 1);
            state.bulkCaptions.results.a.status = "proposed";
            state.bulkCaptions.stopRequested = true;
            window.confirm = () => true;
            assert.equal(resetBulkCaptionQueue(), true);
            assert.equal(state.bulkCaptions.queue, null);
            assert.equal(Object.keys(state.bulkCaptions.results).length, 0);
            assert.equal(state.bulkCaptions.stopRequested, false);
        ''')

    def test_double_accept_saves_once_using_latest_metadata(self):
        self.run_behavior(r'''
            state.bulkCaptions.queue = [candidate("a")];
            state.bulkCaptions.results.a = {status: "proposed", caption: "Original draft"};
            drafts = [{dataset: {bulkCaptionKey: "a"}, value: "  Edited draft  "}];
            let release;
            let fetches = 0;
            fetch = async url => {assert.equal(url, "/api/state"); fetches++; return new Promise(resolve => {release = resolve;});};
            const updates = [];
            api = async (url, payload) => {assert.equal(url, "/api/update-photo"); updates.push(payload);};
            const pending = acceptBulkCaption("a");
            assert.equal(state.bulkCaptions.results.a.status, "saving");
            await acceptBulkCaption("a");
            rejectBulkCaption("a");
            assert.equal(state.bulkCaptions.results.a.status, "saving");
            assert.equal(fetches, 1);
            release({masterPhotos: [photo("a", {title: "Latest title", livery: "Latest livery", locationId: "new-base"})]});
            await pending;
            await acceptBulkCaption("a");
            assert.equal(updates.length, 1);
            assert.equal(updates[0].photo.caption, "Edited draft");
            assert.equal(updates[0].photo.captionAiAssisted, true);
            assert.equal(updates[0].photo.title, "Latest title");
            assert.equal(updates[0].photo.livery, "Latest livery");
            assert.equal(updates[0].photo.pin_id, "new-base");
            assert.equal(state.bulkCaptions.results.a.status, "accepted");
            assert.equal(reloads, 1);
        ''')

    def test_failed_save_preserves_edited_draft_for_retry(self):
        self.run_behavior(r'''
            state.bulkCaptions.queue = [candidate("a")];
            state.bulkCaptions.results.a = {status: "proposed", caption: "Original"};
            drafts = [{dataset: {bulkCaptionKey: "a"}, value: "Edited"}];
            fetch = async () => ({masterPhotos: [photo("a")]});
            api = async () => {throw Error("Save unavailable");};
            await assert.rejects(acceptBulkCaption("a"), /Save unavailable/);
            assert.equal(state.bulkCaptions.results.a.status, "proposed");
            assert.equal(state.bulkCaptions.results.a.caption, "Edited");
            assert.equal(state.bulkCaptions.results.a.message, "Save unavailable");
            assert.equal(state.bulkCaptions.queue[0].photo.caption, "");
            assert.equal(reloads, 0);
            assert.match($("bulkCaptionList").innerHTML, /Your draft is preserved/);
            drafts = [];
            api = async (url, payload) => {assert.equal(payload.photo.caption, "Edited");};
            await acceptBulkCaption("a");
            assert.equal(state.bulkCaptions.results.a.status, "accepted");
        ''')

    def test_caption_rerender_restores_focused_draft_and_caret(self):
        self.run_behavior(r'''
            state.bulkCaptions.queue = [candidate("a"), candidate("b")];
            state.bulkCaptions.results.a = {status: "proposed", caption: "Edited draft"};
            state.bulkCaptions.results.b = {status: "generating"};
            const original = {dataset: {bulkCaptionKey: "a"}, value: "Edited draft", selectionStart: 2, selectionEnd: 7};
            document.activeElement = original;
            drafts = [original];
            let replacement;
            Object.defineProperty($("bulkCaptionList"), "innerHTML", {set(html) {
                assert.match(html, /data-bulk-caption-key="a">Edited draft<\/textarea>/);
                replacement = {
                    dataset: {bulkCaptionKey: "a"}, value: "Edited draft",
                    focus() {document.activeElement = this;},
                    setSelectionRange(start, end) {this.selectionStart = start; this.selectionEnd = end;}
                };
                nodes["caption-proposal-a"] = replacement;
                drafts = [replacement];
            }});
            renderBulkCaptions();
            assert.notEqual(document.activeElement, original);
            assert.equal(document.activeElement, replacement);
            assert.equal(replacement.selectionStart, 2);
            assert.equal(replacement.selectionEnd, 7);
            assert.equal(state.bulkCaptions.results.a.caption, "Edited draft");
            state.bulkCaptions.results.b = {status: "proposed", caption: "Other draft"};
            renderBulkCaptions();
            assert.equal(document.activeElement, replacement);
            assert.equal(replacement.selectionStart, 2);
            assert.equal(replacement.selectionEnd, 7);
        ''')

    def test_missing_photo_or_empty_caption_cannot_save(self):
        self.run_behavior(r'''
            state.bulkCaptions.queue = [candidate("a")];
            state.bulkCaptions.results.a = {status: "proposed", caption: "   "};
            await assert.rejects(acceptBulkCaption("a"), /caption is required/);
            assert.equal(state.bulkCaptions.results.a.status, "proposed");
            state.bulkCaptions.results.a.caption = "Preserved";
            fetch = async () => ({masterPhotos: []});
            await assert.rejects(acceptBulkCaption("a"), /Photo no longer exists/);
            assert.equal(state.bulkCaptions.results.a.status, "proposed");
            assert.equal(state.bulkCaptions.results.a.caption, "Preserved");
            rejectBulkCaption("a");
            assert.equal(state.bulkCaptions.results.a.status, "rejected");
            assert.equal(state.bulkCaptions.queue[0].photo.caption, "");
        ''')


@unittest.skipUnless(shutil.which("node"), "Node.js is required for Manager behavior tests")
class ManagerShellBehaviorTests(unittest.TestCase):
    def run_shell(self, body, saved_tab="attach"):
        markup = ManagerMarkup()
        markup.feed((MANAGER / "app.html").read_text("utf-8"))
        records = [{"tag": node["tag"], "attrs": node["attrs"],
                    "parents": [next(index for index, item in enumerate(markup.nodes) if item is parent)
                                for parent in node["ancestors"]]} for node in markup.nodes]
        source = (MANAGER / "app.js").read_text("utf-8")
        source, count = re.subn(r'^    loadState\(false\)\.catch\([^\n]+\);\s*$', "", source, flags=re.MULTILINE)
        self.assertEqual(count, 1, "Remove only the final network startup, preserving bindEvents and setTab")
        setup = r'''
            const records = RECORDS;
            const storage = new Map([["spotterdex-manager.activeTab", SAVED_TAB]]);
            const sessionStorage = {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)};
            const window = {matchMedia: () => ({matches: false}), addEventListener() {}};
            const document = {activeElement: null, addEventListener() {}};
            const nodes = records.map(record => {
                const attrs = {...record.attrs};
                const classes = new Set((attrs.class || "").split(/\s+/));
                const listeners = {};
                return {
                    record, attrs, id: attrs.id || "", value: attrs.value || "", dataset: Object.fromEntries(
                        Object.entries(attrs).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [
                            key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])),
                    isConnected: true, open: false, hidden: "hidden" in attrs, innerHTML: "",
                    classList: {contains: name => classes.has(name), add: name => classes.add(name),
                        remove: name => classes.delete(name), toggle(name, enabled) {enabled ? classes.add(name) : classes.delete(name);}},
                    setAttribute: (key, value) => {attrs[key] = String(value);},
                    getAttribute: key => attrs[key] ?? null,
                    removeAttribute: key => {delete attrs[key];},
                    addEventListener(type, handler) {(listeners[type] ||= []).push(handler);},
                    dispatch(type, event = {}) {for (const handler of listeners[type] || []) handler({target: this, ...event});},
                    focus() {document.activeElement = this;},
                    showModal() {this.open = true; this.modalCalls = (this.modalCalls || 0) + 1;},
                    close() {this.open = false; this.dispatch("close");},
                    querySelectorAll(selector) {return nodes.filter(node => node.record.parents.includes(nodes.indexOf(this)) && matches(node, selector));},
                    querySelector(selector) {return this.querySelectorAll(selector)[0] || null;},
                    closest(selector) {return [this, ...this.record.parents.slice().reverse().map(index => nodes[index])].find(node => matches(node, selector)) || null;}
                };
            });
            function matches(node, selector) {
                const parts = selector.trim().split(/\s+/);
                const last = parts.pop();
                const tag = last.match(/^[a-z]+/);
                if (tag && node.record.tag !== tag[0]) return false;
                for (const match of last.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(match[1])) return false;
                const id = last.match(/#([\w-]+)/);
                if (id && node.id !== id[1]) return false;
                for (const match of last.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g)) {
                    if (!(match[1] in node.attrs) || (match[2] !== undefined && node.attrs[match[1]] !== match[2])) return false;
                }
                return !parts.length || node.record.parents.some(index => matches(nodes[index], parts.join(" ")));
            }
            document.getElementById = id => nodes.find(node => node.id === id) || null;
            document.querySelectorAll = selector => nodes.filter(node => matches(node, selector));
            document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
            document.body = nodes.find(node => node.record.tag === "body");
            document.activeElement = document.body;
        '''.replace("RECORDS", json.dumps(records)).replace("SAVED_TAB", json.dumps(saved_tab))
        script = setup + "\n" + source + "\n" + body
        program = 'const vm = require("node:vm"); const assert = require("node:assert/strict");\n'
        program += "vm.runInNewContext(" + json.dumps(script) + ", {assert}, {timeout: 5000});"
        result = subprocess.run(["node", "-e", program], cwd=ROOT, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_initialization_and_nested_navigation_preserve_legacy_routes(self):
        for saved, destination in (("entries", "aircraft-database"), ("aircraft-sources", "aircraft-database"),
                                   ("squadron-sources", "squadron-database"), ("locations", "location-heroes")):
            with self.subTest(saved=saved):
                self.run_shell(r'''
                    assert.equal(state.activeTab, EXPECTED);
                    assert($(EXPECTED + "View").classList.contains("active"));
                    setTab("aircraft");
                    assert.equal(document.querySelector(".tab.active").dataset.tab, "aircraft-database");
                    assert.equal(document.querySelector(".tab.active").getAttribute("aria-current"), "page");
                    assert.equal($("workspaceNav").hidden, false);
                    assert.match($("workspaceNav").innerHTML, /data-workspace-view="aircraft" aria-current="page">Presentation/);
                    assert($("aircraftView").classList.contains("active"));
                    setTab("source-photos");
                    assert.equal(document.querySelector(".tab.active").dataset.tab, "master");
                    assert.match($("workspaceNav").innerHTML, /data-workspace-view="source-photos" aria-current="page">By source/);
                    assert($("source-photosView").classList.contains("active"));
                    assert.equal($("attachView").classList.contains("active"), false);
                    assert.equal(storage.get("spotterdex-manager.activeTab"), "source-photos");
                '''.replace("EXPECTED", json.dumps(destination)), saved_tab=saved)

    def test_utility_dialog_restores_original_opener_and_detached_fallback(self):
        self.run_shell(r'''
            const opener = $("inspectSourceBtn");
            opener.focus();
            openUtilityDrawer("Details", "Source", "");
            assert.equal($("utilityDrawer").open, true);
            assert.equal($("utilityDrawer").modalCalls, 1);
            assert.equal(document.activeElement, $("closeUtilityDrawerBtn"));
            toast("Save failed; review the fields.");
            assert.equal($("utilityDrawerStatus").textContent, "Save failed; review the fields.");
            openUtilityDrawer("Updated details", "Source", "");
            assert.equal($("utilityDrawerStatus").textContent, "");
            assert.equal($("utilityDrawer").modalCalls, 1);
            $("closeUtilityDrawerBtn").dispatch("click");
            assert.equal($("utilityDrawer").open, false);
            assert.equal(document.activeElement, opener);
            opener.focus();
            openUtilityDrawer("Details", "Source", "");
            opener.isConnected = false;
            setTab("aircraft");
            $("utilityDrawer").close();
            assert.equal(document.activeElement, document.querySelector(".manager-nav .tab.active"));
            assert.equal(document.activeElement.dataset.tab, "aircraft-database");
        ''')

    def test_bound_filter_clicks_update_pressed_state(self):
        self.run_shell(r'''
            state.data = {assets: [], project: {}};
            for (const value of ["all", "tagged", "untagged"]) {
                const button = document.querySelector(`[data-filter='${value}']`);
                $("assetFilter").dispatch("click", {target: button});
                assert.equal(state.assetFilter, value);
                for (const node of document.querySelectorAll("#assetFilter button")) {
                    assert.equal(node.getAttribute("aria-pressed"), String(node === button));
                    assert.equal(node.classList.contains("active"), node === button);
                }
            }
            for (const value of ["warnings", "passed", "hard"]) {
                const button = document.querySelector(`[data-quality-filter='${value}']`);
                $("qualityFilters").dispatch("click", {target: button});
                assert.equal(state.qualityFilter, value);
                for (const node of document.querySelectorAll("[data-quality-filter]")) {
                    assert.equal(node.getAttribute("aria-pressed"), String(node === button));
                    assert.equal(node.classList.contains("active"), node === button);
                }
            }
        ''')


if __name__ == "__main__":
    unittest.main()
