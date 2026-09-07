from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(shutil.which("node"), "Node.js is required for browser behavior tests")
class ScriptBehaviorTests(unittest.TestCase):
    def run_behavior(self, names, body):
        source = (ROOT / "script.js").read_text("utf-8")
        functions = []
        for name in names:
            match = re.search(r"  (?:async )?function " + name + r"\([^\n]*\) \{.*?\n  \}", source, re.DOTALL)
            self.assertIsNotNone(match, name)
            functions.append(match.group(0))
        program = 'const assert = require("node:assert/strict");\n' + "\n".join(functions)
        program += '\n(async () => {\n' + body + '\n})().catch(error => { console.error(error); process.exitCode = 1; });'
        result = subprocess.run(["node", "-e", program], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_search_keeps_full_totals_and_incremental_category_results(self):
        self.run_behavior(["globalSearchMatches", "renderGlobalSearchResults"], r'''
            global.SEARCH_KIND_ORDER = ["aircraft", "photo"];
            global.SEARCH_KIND_LABELS = {aircraft: "Aircraft", photo: "Photos"};
            global.SEARCH_RESULT_LIMIT_PER_KIND = 6;
            global.normalizeText = value => value.toLowerCase().trim();
            global.globalSearchScore = () => 1;
            global.escapeHtml = global.escapeAttr = value => String(value);
            global.updateGlobalSearchActiveResult = () => {};
            global.state = {searchReady: true, searchCategory: "", searchVisibleCounts: {}, searchIndex: []};
            for (const kind of SEARCH_KIND_ORDER) {
                for (let i = 0; i < 15; i++) state.searchIndex.push({kind, label: `${kind} ${i}`, targetKind: "aircraft"});
            }
            global.els = {globalSearchInput: {value: "plane", removeAttribute() {}, setAttribute() {}}, globalSearchResults: {}, globalSearchSummary: {}, globalSearchCategory: {}};
            assert.equal(globalSearchMatches("plane").length, 30);
            renderGlobalSearchResults();
            assert.equal(state.searchResults.length, 12);
            assert.match(els.globalSearchSummary.textContent, /Showing 12 of 30/);
            assert.match(els.globalSearchResults.innerHTML, /6 of 15/);
            assert.match(els.globalSearchResults.innerHTML, /Open Aircraft/);
            assert.match(els.globalSearchResults.innerHTML, /data-search-show-more="photo"/);
            state.searchVisibleCounts.photo = 12;
            renderGlobalSearchResults();
            assert.equal(state.searchResults.length, 18);
            state.searchCategory = "photo";
            renderGlobalSearchResults();
            assert.equal(state.searchResults.length, 12);
            assert(state.searchResults.every(record => record.kind === "photo"));
            assert.match(els.globalSearchSummary.textContent, /12 of 15.*30 total/);
            state.searchVisibleCounts.photo = 18;
            renderGlobalSearchResults();
            assert.equal(state.searchResults.length, 15);
            assert.doesNotMatch(els.globalSearchResults.innerHTML, /data-search-show-more/);
        ''')

    def test_ime_key_events_do_not_navigate_or_close(self):
        self.run_behavior(["handleKeydown"], r'''
            global.state = {searchComposing: false};
            for (const key of ["Enter", "Escape", "ArrowDown", "k"]) {
                handleKeydown({key, isComposing: true, preventDefault() {throw Error("intercepted composition");}});
                handleKeydown({key, keyCode: 229, preventDefault() {throw Error("intercepted composition");}});
            }
            state.searchComposing = true;
            handleKeydown({key: "Enter"});
        ''')

    def test_viewer_arrows_prevent_scrolling(self):
        self.run_behavior(["handleKeydown"], r'''
            global.state = {};
            global.isGlobalSearchOpen = () => false;
            global.isViewerOpen = () => true;
            const steps = [];
            global.stepPhoto = value => steps.push(value);
            let prevented = 0;
            for (const key of ["ArrowLeft", "ArrowRight"]) handleKeydown({key, preventDefault() {prevented++;}});
            assert.deepEqual(steps, [-1, 1]);
            assert.equal(prevented, 2);
        ''')

    def test_country_filter_matches_on_desktop_and_mobile(self):
        self.run_behavior(["squadronArchiveEntries", "renderSquadronCountryRail"], r'''
            global.state = {squadronCountryFilter: "Singapore"};
            global.collectSquadrons = () => [{country: "Singapore"}, {country: "Japan"}, {country: ""}];
            global.groupSquadronsByCountry = records => records.map(record => ({country: record.country || "Country not set", squadrons: [record]}));
            global.escapeAttr = value => value;
            global.squadronCountryId = value => value;
            global.renderCountryLabel = value => value;
            global.els = {squadronCountryRail: {}};
            for (const mobile of [false, true]) {
                global.isFocusedMobileLayout = () => mobile;
                assert.equal(squadronArchiveEntries().filteredSquadrons.length, 1);
                renderSquadronCountryRail(collectSquadrons());
                assert.match(els.squadronCountryRail.innerHTML, /data-squadron-country-filter="Singapore" aria-pressed="true"/);
                assert.doesNotMatch(els.squadronCountryRail.innerHTML, /aria-current/);
            }
            state.squadronCountryFilter = "Country not set";
            assert.equal(squadronArchiveEntries().filteredSquadrons.length, 1);
            state.squadronCountryFilter = "";
            assert.equal(squadronArchiveEntries().filteredSquadrons.length, 3);
        ''')

    def test_catalog_failure_is_not_empty_success(self):
        self.run_behavior(["loadData"], r'''
            global.window = {};
            global.fetch = async () => {throw Error("offline");};
            await assert.rejects(loadData(), /offline/);
            global.fetch = async () => ({ok: true, json: async () => ({})});
            await assert.rejects(loadData(), /Invalid SpotterDex/);
            const catalog = {schemaVersion: 2, entities: {}, indexes: {}};
            global.fetch = async () => ({ok: true, json: async () => catalog});
            assert.equal(await loadData(), catalog);
        ''')

    def test_exif_failure_can_retry_and_deduplicates_inflight_requests(self):
        self.run_behavior(["loadStatsExifBundle"], r'''
            global.window = {};
            global.statsExifLoadPromise = null;
            const scripts = [];
            global.document = {
                createElement() {return {listeners: {}, addEventListener(type, callback) {this.listeners[type] = callback;}, remove() {this.removed = true;}};},
                head: {append(script) {scripts.push(script);}}
            };
            const first = loadStatsExifBundle();
            assert.equal(loadStatsExifBundle(), first);
            scripts[0].listeners.error();
            assert.equal(await first, null);
            assert.equal(statsExifLoadPromise, null);
            assert.equal(scripts[0].removed, true);
            const second = loadStatsExifBundle();
            scripts[1].listeners.load();
            assert.equal(await second, null);
            const third = loadStatsExifBundle();
            window.SPOTTERDEX_EXIF = {photos: {}};
            scripts[2].listeners.load();
            assert.equal(await third, window.SPOTTERDEX_EXIF);
            assert.equal(scripts.length, 3);
        ''')

    def test_hidden_viewer_info_is_inert_and_returns_focus(self):
        self.run_behavior(["updateViewerInfoState"], r'''
            global.state = {viewerInfoOpen: false};
            global.document = {activeElement: {}};
            let focusCount = 0;
            const element = () => ({classList: {toggle() {}}, setAttribute(key, value) {this[key] = value;}});
            global.els = {photoViewer: element(), viewerInfoButton: {...element(), focus() {focusCount++;}}, viewerInfo: {...element(), contains() {return true;}, querySelector() {return null;}}};
            global.isMobileViewerLayout = () => true;
            updateViewerInfoState();
            assert.equal(els.viewerInfo.inert, true);
            assert.equal(els.viewerInfo["aria-hidden"], "true");
            assert.equal(focusCount, 1);
            state.viewerInfoOpen = true;
            updateViewerInfoState();
            assert.equal(els.viewerInfo.inert, false);
            state.viewerInfoOpen = false;
            global.isMobileViewerLayout = () => false;
            updateViewerInfoState();
            assert.equal(els.viewerInfo.inert, false);
        ''')

    def test_airshow_pagination_uses_filtered_entries(self):
        self.run_behavior(["appendAirshowArchivePage"], r'''
            global.state = {airshowVisibleCount: 2, data: {airshows: [{id: "wrong"}]}};
            global.MOBILE_ARCHIVE_PAGE_SIZE = 2;
            global.airshowArchiveEntries = () => [{id: "a"}, {id: "b"}, {id: "c"}];
            global.renderAirshowTimelineItem = item => item.id;
            global.els = {airshowTimeline: {insertAdjacentHTML(position, markup) {assert.equal(markup, "c");}}};
            global.renderArchivePagination = (element, visible, total) => {assert.equal(visible, 3); assert.equal(total, 3);};
            appendAirshowArchivePage();
            assert.equal(state.airshowVisibleCount, 3);
        ''')

    def test_session_preserves_year_and_country(self):
        self.run_behavior(["saveCurrentSessionState", "restoreSessionFilters"], r'''
            global.state = {airshowYearFilter: "2024", squadronCountryFilter: "Japan", airshowVisibleCount: 24, squadronVisibleCount: 36};
            global.MOBILE_ARCHIVE_PAGE_SIZE = 12;
            global.currentPageViewId = () => "airshowsView";
            global.sessionKeyForView = value => value;
            global.normalizeAircraftFamily = value => value;
            global.normalizeStatsSection = value => value;
            let snapshot;
            global.window = {scrollY: 0, location: {href: "https://example.com"}, sessionStorage: {setItem(key, value) {snapshot = JSON.parse(value);}}};
            saveCurrentSessionState();
            global.state = {};
            restoreSessionFilters(snapshot);
            assert.equal(state.airshowYearFilter, "2024");
            assert.equal(state.squadronCountryFilter, "Japan");
            assert.equal(state.airshowVisibleCount, 24);
            assert.equal(state.squadronVisibleCount, 36);
        ''')

    def test_hash_filters_override_session_and_reset_pagination(self):
        self.run_behavior(["applyDeepLinkFromHash"], r'''
            global.state = {squadronCountryFilter: "Japan", squadronVisibleCount: 48, airshowYearFilter: "2023", airshowVisibleCount: 48};
            global.MOBILE_ARCHIVE_PAGE_SIZE = 12;
            global.window = {location: {hash: "#country=Singapore"}};
            global.currentPageViewId = () => "squadronsView";
            global.normalizeAircraftFamily = global.normalizeAircraftDetailGroup = value => value;
            global.isViewerOpen = () => false;
            global.renderSquadronsPage = global.renderAirshowsPage = global.openDirectoryView = global.saveCurrentSessionState = () => {};
            assert.equal(applyDeepLinkFromHash({initial: true}), true);
            assert.equal(state.squadronCountryFilter, "Singapore");
            assert.equal(state.squadronVisibleCount, 12);
            window.location.hash = "";
            applyDeepLinkFromHash();
            assert.equal(state.squadronCountryFilter, "");
            global.currentPageViewId = () => "airshowsView";
            window.location.hash = "#year=2024";
            assert.equal(applyDeepLinkFromHash({initial: true}), true);
            assert.equal(state.airshowYearFilter, "2024");
            assert.equal(state.airshowVisibleCount, 12);
            window.location.hash = "";
            applyDeepLinkFromHash({initial: true});
            assert.equal(state.airshowYearFilter, "2024");
            applyDeepLinkFromHash();
            assert.equal(state.airshowYearFilter, "");
            assert.equal(state.isApplyingHash, false);
        ''')

    def test_empty_state_buttons_reset_filters_and_save(self):
        self.run_behavior(["handleDocumentClick"], r'''
            global.state = {dexFamilyFilter: "fighter", squadronCountryFilter: "Japan", airshowYearFilter: "2024"};
            global.MOBILE_ARCHIVE_PAGE_SIZE = 12;
            global.els = {};
            global.isViewerOpen = () => false;
            global.document = {querySelector() {return null;}};
            global.renderSquadronsPage = global.renderDex = global.renderAirshowsPage = global.clearDeepLink = () => {};
            const links = [];
            global.updateDeepLink = (...args) => links.push(args);
            let saves = 0;
            global.saveCurrentSessionState = () => saves++;
            const click = (selector, dataset = {}) => handleDocumentClick({target: {closest(value) {return value === selector ? {dataset} : null;}}});
            click("[data-clear-dex-family-filter]");
            assert.equal(state.dexFamilyFilter, "");
            click("[data-squadron-country-jump]", {squadronCountryFilter: ""});
            assert.equal(state.squadronCountryFilter, "");
            click("[data-airshow-year]", {airshowYear: ""});
            assert.equal(state.airshowYearFilter, "");
            assert.deepEqual(links, [["country", ""], ["year", ""]]);
            assert.equal(saves, 3);
        ''')

    def test_resize_without_map_module_updates_viewer_accessibility(self):
        source = (ROOT / "script.js").read_text("utf-8")
        callback = re.search(
            r'window\.addEventListener\("resize", debounce\(\(\) => \{(.*?)\n    \}, 150\)\);',
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(callback)
        self.run_behavior([], r'''
            global.els = {};
            global.state = {renderedViews: new Set()};
            global.document = {querySelector() {return null;}};
            global.ensureMobileAppShell = global.updateMobileAppChrome = global.cancelGesturesForGeometryChange = global.syncMotionSurfaceGeometry = global.scheduleScrollEdgeUpdate = () => {};
            global.isViewerOpen = () => false;
            let viewerUpdates = 0;
            global.updateViewerInfoState = () => viewerUpdates++;
        ''' + callback.group(1) + r'''
            assert.equal(viewerUpdates, 1);
        ''')

    def test_full_photo_metadata_failure_does_not_poison_later_loads(self):
        self.run_behavior(["hydrateFullPhotoData"], r'''
            global.state = {data: {payload: "core", photos: [{id: "one"}]}, fullDataPromise: null};
            let attempts = 0;
            global.fetch = async () => {
                if (++attempts === 1) throw Error("offline");
                return {ok: true, json: async () => ({})};
            };
            global.normalizedPhotoViewModels = () => [{id: "one", caption: "Loaded"}];
            assert.equal(await hydrateFullPhotoData(), false);
            assert.equal(state.fullDataPromise, null);
            assert.equal(await hydrateFullPhotoData(), true);
            assert.equal(state.data.photos[0].caption, "Loaded");
        ''')

    def test_clearing_archive_filters_clears_hash(self):
        self.run_behavior(["updateDeepLink"], r'''
            global.state = {};
            let cleared = 0;
            global.clearDeepLink = () => {cleared++; return true;};
            global.navigateToHash = hash => {assert.equal(hash, "#country=United%20States"); return true;};
            global.updateShareMetadata = () => {};
            assert.equal(updateDeepLink("country", ""), true);
            assert.equal(updateDeepLink("year", ""), true);
            assert.equal(cleared, 2);
            assert.equal(updateDeepLink("country", "United States"), true);
        ''')


if __name__ == "__main__":
    unittest.main()
