import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANAGER = ROOT / "tools" / "manager"


@unittest.skipUnless(shutil.which("node"), "Node.js is required for Manager behavior tests")
class DatasetExportUiTests(unittest.TestCase):
    def run_js(self, body):
        source = (MANAGER / "app.js").read_text("utf-8")
        names = ("datasetExportPhotoIds", "datasetExportPayload", "renderDatasetExportPreview", "previewDatasetExport", "renderDatasetExportJob", "reconnectDatasetExport", "pollDatasetExportJob", "startDatasetExport")
        funcs = []
        for name in names:
            match = re.search(r"^    (?:async )?function " + name + r"\([^\n]*\) \{.*?^    \}", source, re.M | re.S)
            self.assertIsNotNone(match, name)
            funcs.append(match.group(0))
        setup = r'''
            const nodes = {};
            const $ = id => nodes[id] ||= {value: "", disabled: false, textContent: "", innerHTML: ""};
            const escapeHtml = value => String(value ?? "");
            const state = {bulkEdit: {master: new Set(["sel-1", "sel-2"])}, datasetExport: {scope: "all", preview: null, job: null, polling: false, timer: null}};
            state.data = {masterPhotos: [{id: "match-1"}, {id: "other"}, {id: "match-2"}]};
            const libraryPhotoMatches = photo => photo.id.startsWith("match-");
            const clearTimeout = () => {};
            let api = async () => ({ok: true});
            const setTimeout = fn => 1;
        '''
        script = setup + "\n" + "\n".join(funcs) + "\n(async () => {" + body + "})()"
        program = "const vm=require('node:vm'); const assert=require('node:assert/strict'); Promise.resolve(vm.runInNewContext(" + json.dumps(script) + ", {assert}, {timeout:5000})).catch(e=>{console.error(e);process.exitCode=1});"
        result = subprocess.run(["node"], input=program, cwd=ROOT, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_scope_payloads_use_selected_and_matching_ids(self):
        self.run_js(r'''
            $("datasetExportScope").value = "selected";
            assert.deepEqual(datasetExportPayload(), {scope:"selected", photoIds:["sel-1","sel-2"]});
            $("datasetExportScope").value = "matching";
            assert.deepEqual(datasetExportPayload(), {scope:"matching", photoIds:["match-1","match-2"]});
            $("datasetExportScope").value = "all";
            assert.deepEqual(datasetExportPayload(), {scope:"all", photoIds:[]});
        ''')

    def test_empty_preview_disables_export_and_success_enables(self):
        self.run_js(r'''
            renderDatasetExportPreview({total:3, eligible:0, excluded:[{reason:"No unit"}]});
            assert.equal($("startDatasetExportBtn").disabled, true);
            renderDatasetExportPreview({total:3, eligible:2, defaultLiveryCount:1, labelCounts:{aircraft:2}});
            assert.equal($("startDatasetExportBtn").disabled, false);
        ''')

    def test_reconnect_reads_get_status_without_posting(self):
        self.run_js(r'''
            const calls=[]; api = async (url, body) => { calls.push([url, body]); return {activeJobId:"j1", jobs:[{id:"j1", status:"succeeded", total:2, completed:2, downloadUrl:"/download"}]}; };
            await reconnectDatasetExport();
            assert.deepEqual(calls, [["/api/dataset-export-jobs", undefined]]);
            assert.equal(state.datasetExport.job.id, "j1");
        ''')

    def test_stale_preview_and_active_job_guard(self):
        self.run_js(r'''
            $("datasetExportScope").value = "all";
            let resolve;
            api = () => new Promise(r => resolve = r);
            const pending = previewDatasetExport();
            $("datasetExportScope").value = "selected";
            resolve({eligible: 2}); await pending;
            assert.equal(state.datasetExport.preview, null);
            assert.equal($("startDatasetExportBtn").disabled, true);
            state.datasetExport.job = {status:"running"};
            renderDatasetExportPreview({eligible:2});
            assert.equal($("startDatasetExportBtn").disabled, true);
        ''')

    def test_running_reconnect_only_polls_and_stale_start_does_not_post(self):
        self.run_js(r'''
            const calls=[];
            api = async (url, payload) => { calls.push([url,payload]); return {job:{id:"j1",status:"running",completed:1,total:3}}; };
            await pollDatasetExportJob("j1");
            assert.deepEqual(calls, [["/api/dataset-export-jobs/j1",undefined]]);
            $("datasetExportScope").value="selected";
            await startDatasetExport();
            assert.equal(calls.length,1);
            assert.match($("datasetExportJobStatus").textContent,/Preview this scope/);
        ''')

    def test_reconnect_error_is_user_visible(self):
        self.run_js(r'''
            api = async () => { throw Error("offline"); };
            await reconnectDatasetExport();
            assert.match($("datasetExportJobStatus").textContent, /Could not reconnect: offline/);
        ''')
