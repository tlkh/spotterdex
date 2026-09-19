import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
MANAGER = ROOT / "tools" / "manager"


@unittest.skipUnless(shutil.which("node"), "Node.js is required for Manager caption-review tests")
class ManagerCaptionReviewBehaviorTests(unittest.TestCase):
    """Regression contracts for the focused caption-review queue controls."""

    def run_behavior(self, body):
        source = (MANAGER / "app.js").read_text("utf-8")
        names = (
            "currentBulkCaptionQueue",
            "bulkCaptionReviewCategory",
            "bulkCaptionReviewView",
            "setBulkCaptionReviewFilter",
            "focusBulkCaptionReview",
        )
        functions = []
        for name in names:
            match = re.search(
                r"^    (?:async )?function " + name + r"\([^\n]*\) \{.*?^    \}",
                source,
                re.MULTILINE | re.DOTALL,
            )
            self.assertIsNotNone(match, name)
            functions.append(match.group(0))

        setup = r'''
            const nodes = new Map();
            let renderCalls = 0;
            let focusCalls = [];
            const renderBulkCaptions = () => { renderCalls += 1; };
            const state = {
                bulkCaptions: {
                    queue: null,
                    results: {},
                    reviewFilter: null
                }
            };
            const makeProposal = key => {
                const node = {
                    dataset: {bulkCaptionKey: key},
                    value: "Draft " + key,
                    focus() {
                        document.activeElement = this;
                        focusCalls.push(key);
                    }
                };
                nodes.set("caption-proposal-" + key, node);
                return node;
            };
            const reviewStatus = {
                id: "bulkCaptionReviewStatus",
                focus() {
                    document.activeElement = this;
                    focusCalls.push("status");
                }
            };
            nodes.set("bulkCaptionReviewStatus", reviewStatus);
            const document = {
                activeElement: null,
                getElementById: id => nodes.get(id) || null,
                querySelector(selector) {
                    const idMatch = selector.match(/^#([\\w-]+)$/);
                    if (idMatch) return nodes.get(idMatch[1]) || null;
                    const keyMatch = selector.match(/data-bulk-caption-key=["']([^"']+)["']/);
                    return keyMatch ? nodes.get("caption-proposal-" + keyMatch[1]) || null : null;
                },
                querySelectorAll(selector) {
                    if (selector.includes("[data-bulk-caption-key]")) {
                        return [...nodes.values()].filter(node => node.dataset?.bulkCaptionKey);
                    }
                    return [];
                }
            };
            const window = {setTimeout};
            const $ = id => document.getElementById(id);
            const candidate = key => ({key, photo: {id: key}});
        '''
        script = setup + "\n" + "\n".join(functions) + "\n(async () => {\n" + body + "\n})()"
        program = 'const vm = require("node:vm"); const assert = require("node:assert/strict");\n'
        program += (
            "Promise.resolve(vm.runInNewContext("
            + json.dumps(script)
            + ', {assert, setTimeout}, {timeout: 5000})).catch(error => {console.error(error); process.exitCode = 1;});'
        )
        result = subprocess.run(
            ["node"],
            input=program,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def run_accept_behavior(self, body):
        source = (MANAGER / "app.js").read_text("utf-8")
        names = (
            "currentBulkCaptionQueue",
            "bulkProposalValue",
            "bulkCaptionReviewCategory",
            "bulkCaptionReviewView",
            "bulkCaptionFocusedKey",
            "focusBulkCaptionReview",
            "acceptBulkCaption",
        )
        functions = []
        for name in names:
            match = re.search(
                r"^    (?:async )?function " + name + r"\([^\n]*\) \{.*?^    \}",
                source,
                re.MULTILINE | re.DOTALL,
            )
            self.assertIsNotNone(match, name)
            functions.append(match.group(0))

        setup = r'''
            const nodes = new Map();
            let focusCalls = [];
            let renderCalls = 0;
            let refreshCalls = 0;
            let toastCalls = [];
            const state = {
                data: {masterPhotos: []},
                bulkCaptions: {
                    queue: null,
                    results: {},
                    reviewFilter: "review"
                }
            };
            const makeNode = (id, dataset = {}) => {
                const node = {
                    id,
                    dataset,
                    value: "Draft",
                    focus() {
                        document.activeElement = this;
                        focusCalls.push(id);
                    }
                };
                nodes.set(id, node);
                return node;
            };
            const makeProposal = key => makeNode("caption-proposal-" + key, {bulkCaptionKey: key});
            const makeAcceptButton = key => makeNode("caption-accept-" + key, {bulkAccept: key});
            const makeCard = key => makeNode("caption-card-" + key, {bulkCaptionCard: key});
            const document = {
                activeElement: null,
                getElementById: id => nodes.get(id) || null,
                querySelectorAll(selector) {
                    if (selector.includes("[data-bulk-caption-key]")) {
                        return [...nodes.values()].filter(node => node.dataset?.bulkCaptionKey);
                    }
                    return [];
                }
            };
            const $ = id => document.getElementById(id);
            const renderBulkCaptions = () => {
                renderCalls += 1;
                if (state.bulkCaptions.results.a?.status === "saving") {
                    document.activeElement = nodes.get("caption-card-a") || makeCard("a");
                }
            };
            const window = {setTimeout};
            let fetch = async () => {throw Error("Unexpected fetch");};
            let api = async () => {throw Error("Unexpected API request");};
            const readApiJson = async response => response;
            const entryRequestFields = entry => ({entryPath: entry.entryPath});
            const refreshManagerAfterSave = async () => {refreshCalls += 1;};
            const toast = message => {toastCalls.push(message);};
            const candidate = key => ({
                key,
                entry: {entryPath: "db:location:base"},
                photo: {
                    id: key,
                    photoId: key,
                    sourceAssetPath: key + ".jpg",
                    path: key + ".jpg",
                    caption: "",
                    locationId: "base"
                }
            });
        '''
        script = setup + "\n" + "\n".join(functions) + "\n(async () => {\n" + body + "\n})()"
        program = 'const vm = require("node:vm"); const assert = require("node:assert/strict");\n'
        program += (
            "Promise.resolve(vm.runInNewContext("
            + json.dumps(script)
            + ', {assert, setTimeout}, {timeout: 5000})).catch(error => {console.error(error); process.exitCode = 1;});'
        )
        result = subprocess.run(
            ["node"],
            input=program,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_categories_cover_review_failure_completion_and_waiting(self):
        self.run_behavior(r'''
            assert.equal(bulkCaptionReviewCategory({status: "proposed"}), "review");
            assert.equal(bulkCaptionReviewCategory({status: "proposed", message: "Save failed"}), "review");
            assert.equal(bulkCaptionReviewCategory({status: "saving"}), "review");
            assert.equal(bulkCaptionReviewCategory({status: "error"}), "failed");
            assert.equal(bulkCaptionReviewCategory({status: "accepted"}), "completed");
            assert.equal(bulkCaptionReviewCategory({status: "rejected"}), "completed");
            assert.equal(bulkCaptionReviewCategory({status: "ready"}), "waiting");
            assert.equal(bulkCaptionReviewCategory({status: "generating"}), "waiting");
            assert.equal(bulkCaptionReviewCategory(undefined), "waiting");
        ''')

    def test_view_counts_and_filtering_preserve_frozen_queue_and_proposals(self):
        self.run_behavior(r'''
            const queue = ["a", "b", "c", "d", "e", "f", "g", "h"].map(candidate);
            const results = {
                a: {status: "proposed", caption: "Draft A"},
                b: {status: "saving", caption: "Draft B"},
                c: {status: "proposed", message: "Save failed", caption: "Draft C"},
                d: {status: "error", message: "Generation failed"},
                e: {status: "accepted", caption: "Saved E"},
                f: {status: "rejected"},
                g: {status: "ready"},
                h: {status: "generating"}
            };
            const queueBefore = JSON.stringify(queue);
            const resultsBefore = JSON.stringify(results);
            const view = bulkCaptionReviewView(queue, results);
            assert.equal(view.filter, "review");
            assert.deepEqual(view.counts, {review: 3, failed: 1, completed: 2, all: 8});
            assert.deepEqual(view.visible.map(item => item.key), ["a", "b", "c"]);
            assert.equal(state.bulkCaptions.reviewFilter, "review");
            assert.equal(JSON.stringify(queue), queueBefore);
            assert.equal(JSON.stringify(results), resultsBefore);
            assert.strictEqual(view.visible[0], queue[0]);

            state.bulkCaptions.reviewFilter = "failed";
            assert.deepEqual(bulkCaptionReviewView(queue, results).visible.map(item => item.key), ["d"]);
            state.bulkCaptions.reviewFilter = "completed";
            assert.deepEqual(bulkCaptionReviewView(queue, results).visible.map(item => item.key), ["e", "f"]);
            state.bulkCaptions.reviewFilter = "all";
            assert.deepEqual(bulkCaptionReviewView(queue, results).visible.map(item => item.key), ["a", "b", "c", "d", "e", "f", "g", "h"]);
        ''')

    def test_default_view_is_all_until_a_proposal_exists_and_explicit_filter_sticks(self):
        self.run_behavior(r'''
            const queue = [candidate("a"), candidate("b")];
            const results = {a: {status: "ready"}, b: {status: "generating"}};
            state.bulkCaptions.reviewFilter = null;
            let view = bulkCaptionReviewView(queue, results);
            assert.equal(view.filter, "all");
            assert.equal(state.bulkCaptions.reviewFilter, null);
            assert.deepEqual(view.visible.map(item => item.key), ["a", "b"]);

            results.a = {status: "proposed", caption: "Draft A"};
            view = bulkCaptionReviewView(queue, results);
            assert.equal(view.filter, "review");
            assert.equal(state.bulkCaptions.reviewFilter, "review");
            assert.deepEqual(view.visible.map(item => item.key), ["a"]);

            state.bulkCaptions.reviewFilter = "all";
            assert.equal(bulkCaptionReviewView(queue, results).filter, "all");
            assert.deepEqual(bulkCaptionReviewView(queue, results).visible.map(item => item.key), ["a", "b"]);
            state.bulkCaptions.reviewFilter = "failed";
            assert.equal(bulkCaptionReviewView(queue, results).filter, "failed");
            assert.deepEqual(bulkCaptionReviewView(queue, results).visible, []);
        ''')

    def test_filter_setter_validates_values_and_rerenders(self):
        self.run_behavior(r'''
            assert.equal(state.bulkCaptions.reviewFilter, null);
            setBulkCaptionReviewFilter("failed");
            assert.equal(state.bulkCaptions.reviewFilter, "failed");
            assert.equal(renderCalls, 1);
            setBulkCaptionReviewFilter("failed");
            assert.equal(renderCalls, 2);
            setBulkCaptionReviewFilter("not-a-filter");
            assert.equal(state.bulkCaptions.reviewFilter, "failed");
            assert.equal(renderCalls, 2);
        ''')

    def test_focus_keeps_same_proposal_then_advances_visible_proposals_with_wrap(self):
        self.run_behavior(r'''
            const queue = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
            state.bulkCaptions.queue = queue;
            state.bulkCaptions.results = {
                a: {status: "proposed", caption: "Draft A"},
                b: {status: "error"},
                c: {status: "accepted", caption: "Saved C"},
                d: {status: "proposed", caption: "Draft D"}
            };
            state.bulkCaptions.reviewFilter = "review";
            makeProposal("a");
            makeProposal("d");
            focusBulkCaptionReview("a");
            assert.deepEqual(focusCalls, ["a"]);
            focusBulkCaptionReview("a", true);
            assert.deepEqual(focusCalls, ["a", "d"]);
            focusBulkCaptionReview("d", true);
            assert.deepEqual(focusCalls, ["a", "d", "a"]);
        ''')

    def test_focus_ignores_hidden_or_nonproposal_items_and_falls_back_to_status(self):
        self.run_behavior(r'''
            const queue = [candidate("a"), candidate("b"), candidate("c")];
            state.bulkCaptions.queue = queue;
            state.bulkCaptions.results = {
                a: {status: "proposed", caption: "Draft A"},
                b: {status: "error"},
                c: {status: "accepted", caption: "Saved C"}
            };
            makeProposal("a");
            makeProposal("c");
            state.bulkCaptions.reviewFilter = "failed";
            focusBulkCaptionReview("a");
            assert.deepEqual(focusCalls, ["status"]);
            focusCalls = [];
            focusBulkCaptionReview("a", true);
            assert.deepEqual(focusCalls, ["status"]);

            state.bulkCaptions.reviewFilter = "completed";
            focusCalls = [];
            focusBulkCaptionReview("c");
            assert.deepEqual(focusCalls, ["status"]);

            state.bulkCaptions.reviewFilter = "review";
            focusCalls = [];
            focusBulkCaptionReview("missing", true);
            assert.deepEqual(focusCalls, ["a"]);
        ''')

    def test_accept_success_advances_to_next_visible_proposal(self):
        self.run_accept_behavior(r'''
            const a = candidate("a");
            const b = candidate("b");
            const c = candidate("c");
            state.bulkCaptions.queue = [a, b, c];
            state.bulkCaptions.results = {
                a: {status: "proposed", caption: "Draft A"},
                b: {status: "proposed", caption: "Draft B"},
                c: {status: "accepted", caption: "Already saved"}
            };
            const proposalA = makeProposal("a");
            proposalA.value = "Edited A";
            makeProposal("b");
            const acceptA = makeAcceptButton("a");
            makeCard("a");
            document.activeElement = acceptA;
            fetch = async url => {
                assert.equal(url, "/api/state");
                return {masterPhotos: [{id: "a", locationId: "base", date: "", airshow: "", title: "", livery: ""}]};
            };
            let update;
            api = async (url, payload) => {
                assert.equal(url, "/api/update-master-photo");
                update = payload;
            };
            await acceptBulkCaption("a");
            assert.equal(state.bulkCaptions.results.a.status, "accepted");
            assert.equal(update.photo.caption, "Edited A");
            assert.equal(update.photo.captionAiAssisted, true);
            assert.deepEqual(focusCalls, ["caption-proposal-b"]);
            assert.equal(document.activeElement, nodes.get("caption-proposal-b"));
            assert.equal(refreshCalls, 1);
        ''')

    def test_accept_failed_save_restores_the_same_proposal(self):
        self.run_accept_behavior(r'''
            const a = candidate("a");
            state.bulkCaptions.queue = [a];
            state.bulkCaptions.results.a = {status: "proposed", caption: "Original draft"};
            const proposalA = makeProposal("a");
            proposalA.value = "Edited draft";
            const acceptA = makeAcceptButton("a");
            makeCard("a");
            document.activeElement = acceptA;
            fetch = async () => ({masterPhotos: [{id: "a", locationId: "base"}]});
            api = async () => {throw Error("Save unavailable");};
            await assert.rejects(acceptBulkCaption("a"), /Save unavailable/);
            assert.equal(state.bulkCaptions.results.a.status, "proposed");
            assert.equal(state.bulkCaptions.results.a.caption, "Edited draft");
            assert.equal(state.bulkCaptions.results.a.message, "Save unavailable");
            assert.deepEqual(focusCalls, ["caption-proposal-a"]);
            assert.equal(document.activeElement, nodes.get("caption-proposal-a"));
            assert.equal(refreshCalls, 0);
        ''')

    def test_accept_does_not_steal_focus_after_user_moves_during_save(self):
        self.run_accept_behavior(r'''
            const a = candidate("a");
            const b = candidate("b");
            state.bulkCaptions.queue = [a, b];
            state.bulkCaptions.results = {
                a: {status: "proposed", caption: "Draft A"},
                b: {status: "proposed", caption: "Draft B"}
            };
            makeProposal("a");
            makeProposal("b");
            const acceptA = makeAcceptButton("a");
            const acceptB = makeAcceptButton("b");
            makeCard("a");
            document.activeElement = acceptA;
            fetch = async () => ({masterPhotos: [{id: "a", locationId: "base"}]});
            let apiStarted = false;
            let release;
            api = async () => {
                apiStarted = true;
                document.activeElement = acceptB;
                return new Promise(resolve => {release = resolve;});
            };
            const pending = acceptBulkCaption("a");
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.equal(apiStarted, true);
            assert.equal(document.activeElement, acceptB);
            release();
            await pending;
            assert.equal(state.bulkCaptions.results.a.status, "accepted");
            assert.equal(document.activeElement, acceptB);
            assert.deepEqual(focusCalls, []);
        ''')
