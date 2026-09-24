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

    def test_mobile_navigation_places_squadrons_in_tabs_and_airshows_in_more(self):
        self.run_behavior(["ensureMobileAppShell", "mobileTabLink"], r'''
            const inserted = [];
            global.MOBILE_MAP_MEDIA_QUERY = "(max-width: 700px)";
            global.window = {matchMedia: () => ({matches: true})};
            global.document = {
                getElementById: () => null,
                querySelector: () => ({insertAdjacentHTML: (_position, html) => inserted.push(html)}),
                body: {insertAdjacentHTML: (_position, html) => inserted.push(html)}
            };
            global.cacheMobileElements = global.bindMobileShellEvents = () => {};
            ensureMobileAppShell();
            const markup = inserted.join("");
            const tabs = markup.match(/<nav class="mobile-tab-bar"[\s\S]*?<\/nav>/)?.[0];
            const more = markup.match(/<section class="mobile-more-sheet"[\s\S]*?<\/section>/)?.[0];
            assert(tabs && more);
            assert.match(tabs, /href="squadrons.html" data-mobile-tab-view="squadronsView"/);
            assert.match(tabs, /class="squadron-patch-eagle"/);
            assert.doesNotMatch(tabs, /href="airshows.html"/);
            assert.match(more, /href="airshows.html" data-mobile-more-view="airshowsView"/);
            assert.doesNotMatch(more, /href="squadrons.html"/);
        ''')

    def test_field_guide_buttons_target_rendered_archive_groups(self):
        self.run_behavior(["renderFieldGuideBrowser", "renderAircraftTypePhotoGroups"], r'''
            global.escapeHtml = global.escapeAttr = value => String(value);
            global.aircraftTypePhotoGroups = photos => photos.length ? [
                {key: "aircraft-type-a330", title: "Airbus A330", photos, eyebrow: "Aircraft type"},
                {key: "unit-example", title: "Example unit", photos, eyebrow: "Squadron"}
            ] : [];
            global.renderProgressivePhotoGrid = () => "<div>Photos</div>";
            for (const context of ["location", "squadron"]) {
                const key = `${context}-aircraft-types`;
                const browser = renderFieldGuideBrowser([{}], key);
                const archive = renderAircraftTypePhotoGroups([{}], context, key);
                const targets = [...browser.matchAll(/data-aircraft-photo-target="([^"]+)"/g)].map(match => match[1]);
                assert.equal(targets.length, 2);
                for (const target of targets) assert(archive.includes(`id="${target}"`));
                assert.equal(renderFieldGuideBrowser([], key), "");
                const tagged = renderFieldGuideBrowser([], key, [{title: "Location photos", target: "tagged", count: 2}]);
                assert(tagged.includes('data-aircraft-photo-target="tagged"'));
                assert(!tagged.includes("photos photos"));
            }
        ''')

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

    def test_aircraft_archive_balances_the_final_row(self):
        self.run_behavior(["aircraftGridEntries", "aircraftGridPromotionIds", "aircraftGridMetrics"], r'''
            global.window = {matchMedia: () => ({matches: false})};
            global.aircraftStats = () => ({photoCount: 0});
            global.photosForAircraft = () => [];
            const entries = Array.from({length: 12}, (_, index) => ({
                id: `aircraft-${index}`,
                typeName: `Aircraft ${String(index).padStart(2, "0")}`,
                doubleWidth: null
            }));
            let rendered = aircraftGridEntries(entries);
            assert.equal(rendered.at(-2).isWide, false);
            assert.equal(rendered.at(-1).entry.id, "aircraft-11");
            assert.equal(rendered.at(-1).isWide, true);

            entries.at(-1).doubleWidth = false;
            rendered = aircraftGridEntries(entries);
            assert.equal(rendered.at(-1).isWide, false, JSON.stringify(rendered));

            global.window.matchMedia = query => ({matches: query === "(max-width: 1040px)"});
            assert.deepEqual(aircraftGridMetrics(), {columns: 2, normalSpan: 1, wideSpan: 2});
            assert.deepEqual([...aircraftGridPromotionIds(entries)], []);
            entries.at(-1).doubleWidth = null;
            rendered = aircraftGridEntries(entries);
            assert.equal(rendered.at(-2).entry.id, "aircraft-10");
            assert.equal(rendered.at(-2).isWide, false);
            assert.equal(rendered.at(-1).entry.id, "aircraft-11");
            assert.equal(rendered.at(-1).isWide, false);
            const partialEntries = entries.slice(0, 11);
            rendered = aircraftGridEntries(partialEntries, {balanceFinalRow: false});
            assert.equal(rendered.at(-1).isWide, false);
            rendered = aircraftGridEntries(partialEntries);
            assert.equal(rendered.at(-1).isWide, true);
            entries[0].doubleWidth = true;
            assert.deepEqual([...aircraftGridPromotionIds(entries)], ["aircraft-0"]);
        ''')

    def test_photo_captions_default_to_icao_and_date_across_pages(self):
        self.run_behavior(["photoCaptionLocation", "renderPhotoCard"], r'''
            global.state = {pinById: new Map([["gifu", {icao: "RJNG"}]])};
            global.normalizeIcao = value => String(value || "").toUpperCase();
            global.escapeHtml = global.escapeAttr = value => String(value);
            global.photoSubjectLabel = () => "Mitsubishi F-2A";
            global.displayPhotoDate = () => "8 Apr 2026";
            global.renderResponsivePhotoImage = () => "<img>";
            global.photoContextLabel = () => "Air Development and Test Wing";
            const photo = {id: "f2a", pinId: "gifu", locationName: "Gifu Air Base", livery: "Anniversary"};
            for (const context of ["dex", "location", "squadron", "airshow"]) {
                const card = renderPhotoCard(photo, context);
                assert.match(card, /RJNG, 8 Apr 2026/);
                assert.doesNotMatch(card, />Mitsubishi F-2A</);
                assert.doesNotMatch(card, /Air Development and Test Wing/);
                assert.doesNotMatch(card, /Anniversary/);
            }
            state.pinById.clear();
            assert.match(renderPhotoCard(photo, "location"), /Gifu Air Base, 8 Apr 2026/);
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

    def test_country_flags_cover_india_korea_and_new_zealand(self):
        self.run_behavior(["countryFlag"], r'''
            global.normalizeText = value => String(value).toLowerCase().trim();
            assert.equal(countryFlag("India"), "🇮🇳");
            assert.equal(countryFlag("Korea"), "🇰🇷");
            assert.equal(countryFlag("New Zealand"), "🇳🇿");
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
            global.MOBILE_MAP_MEDIA_QUERY = "(max-width: 1040px)";
            global.window = {matchMedia: () => ({matches: true})};
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

    def test_homepage_forwards_legacy_map_hashes_to_map_page(self):
        self.run_behavior(["redirectLegacyMapDeepLink"], r'''
            let destination = "";
            global.currentPageViewId = () => "homeView";
            global.document = {baseURI: "https://spotterdex.example/index.html"};
            global.window = {
                location: {
                    hash: "#location=gifu&detail=1",
                    search: "?source=share",
                    replace(value) {destination = value;}
                }
            };
            assert.equal(redirectLegacyMapDeepLink(), true);
            assert.equal(destination, "https://spotterdex.example/map.html?source=share#location=gifu&detail=1");
            destination = "";
            window.location.hash = "#photo=example-photo";
            assert.equal(redirectLegacyMapDeepLink(), true);
            assert.equal(destination, "https://spotterdex.example/map.html?source=share#photo=example-photo");
            destination = "";
            window.location.hash = "#work=portfolio-photo";
            assert.equal(redirectLegacyMapDeepLink(), false);
            assert.equal(destination, "");
        ''')

    def test_portfolio_photo_order_and_work_deep_link(self):
        self.run_behavior(["currentPortfolioPhotoIds", "applyDeepLinkFromHash"], r'''
            const opened = [];
            global.state = {photoById: new Map([["hero", {}], ["one", {}], ["two", {}]]), isApplyingHash: false};
            global.document = {querySelectorAll: () => [
                {dataset: {workPhoto: "hero"}},
                {dataset: {workPhoto: "one"}},
                {dataset: {workPhoto: "hero"}},
                {dataset: {workPhoto: "missing"}},
                {dataset: {workPhoto: "two"}}
            ]};
            global.window = {location: {hash: "#work=one"}, history: {state: null}};
            global.currentPageViewId = () => "homeView";
            global.normalizeAircraftDetailGroup = global.normalizeAircraftFamily = value => value || "";
            global.isViewerOpen = () => false;
            global.findPhoto = id => state.photoById.has(id) ? {id} : null;
            global.openViewer = (...args) => opened.push(args);
            assert.deepEqual(currentPortfolioPhotoIds(), ["hero", "one", "two"]);
            assert.equal(applyDeepLinkFromHash({initial: true}), true);
            assert.deepEqual(opened, [["one", "portfolio", {updateHash: false}]]);
            assert.equal(state.viewerHistoryPushed, false);
            assert.equal(state.isApplyingHash, false);
        ''')

    def test_portfolio_viewer_steps_with_work_hash_and_closes_cleanly(self):
        self.run_behavior(["viewerPhotoHashKind", "stepPhoto", "isViewerPhotoHashActive", "updateDeepLinkForViewerContext"], r'''
            global.state = {activePhotoContext: "portfolio", activePhotoIds: ["hero", "one"], activePhotoIndex: 0, photoById: new Map([["one", {}]])};
            const links = [];
            global.resetViewerTransform = global.renderViewerPhoto = () => {};
            global.updateDeepLink = (...args) => links.push(args);
            global.window = {location: {hash: "#work=one"}};
            assert.equal(viewerPhotoHashKind(), "work");
            stepPhoto(1);
            assert.deepEqual(links, [["work", "one", {replace: true}]]);
            assert.equal(isViewerPhotoHashActive(), true);
            global.clearDeepLink = options => links.push(["clear", options]);
            global.currentPageViewId = () => "homeView";
            updateDeepLinkForViewerContext();
            assert.deepEqual(links.at(-1), ["clear", {replace: true}]);
        ''')

    def test_more_sheet_contains_focus_and_restores_the_opener(self):
        self.run_behavior(["openMobileMoreMenu", "closeMobileMoreMenu", "setMobileMoreBackgroundInert", "handleKeydown"], r'''
            let returnedFocus = 0;
            const classList = {add() {}, remove() {}};
            const opener = {isConnected: true, focus() {returnedFocus++;}};
            const makeElement = () => ({inert: false});
            const keyEvents = [];
            global.state = {mobileMoreOpen: false, searchComposing: false};
            global.document = {activeElement: opener, body: {classList}};
            global.window = {requestAnimationFrame: callback => callback()};
            global.els = {
                mobileMoreSheet: {hidden: true}, mobileMoreBackdrop: {hidden: true},
                mobileMoreButton: {setAttribute(name, value) {this[name] = value;}},
                mobileMoreClose: {focus() {keyEvents.push("menu focus");}},
                siteHeader: makeElement(), main: makeElement(), mobileTabBar: makeElement()
            };
            global.isGlobalSearchOpen = () => false;
            global.trapDialogFocus = (container, event) => {keyEvents.push([container, event.key]); event.preventDefault();};
            openMobileMoreMenu();
            assert.equal(state.mobileMoreOpen, true);
            assert.equal(els.mobileMoreSheet.hidden, false);
            assert.equal(els.mobileMoreBackdrop.hidden, false);
            assert.equal(els.mobileMoreButton["aria-expanded"], "true");
            assert.equal(els.main.inert, true);
            assert.deepEqual(keyEvents, ["menu focus"]);
            let prevented = 0;
            handleKeydown({key: "Tab", preventDefault() {prevented++;}});
            handleKeydown({key: "Escape", preventDefault() {prevented++;}});
            assert.equal(prevented, 2);
            assert.equal(state.mobileMoreOpen, false);
            assert.equal(els.mobileMoreSheet.hidden, true);
            assert.equal(els.mobileMoreBackdrop.hidden, true);
            assert.equal(els.main.inert, false);
            assert.equal(returnedFocus, 1);
            assert.deepEqual(keyEvents[1], [els.mobileMoreSheet, "Tab"]);
        ''')


if __name__ == "__main__":
    unittest.main()
