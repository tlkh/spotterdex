// Shared classic-script runtime. Route modules load immediately before this
// file and provide only the renderers needed by the current static page.
  const EMPTY_DATA = { payload: "core", generatedAt: null, pins: [], aircraft: [], squadrons: [], airshows: [], photos: [] };
  const EMPTY_PHOTOS = Object.freeze([]);
  const RECENT_PHOTO_LIMIT = 8;
  const MOBILE_ARCHIVE_PAGE_SIZE = 12;
  const MOBILE_ARCHIVE_PREFETCH_OFFSET = Math.max(0, Math.floor(MOBILE_ARCHIVE_PAGE_SIZE / 2) - 1);
  const GESTURE_INTENT_DISTANCE = 8;
  const GESTURE_AXIS_DOMINANCE = 1.25;
  const GESTURE_SAMPLE_LIMIT = 6;
  const GESTURE_SAMPLE_WINDOW_MS = 100;
  const MOTION_DECELERATION_RATE = 0.99;
  const MOTION_RUBBERBAND_CONSTANT = 0.55;
  const MOTION_SPRING_RESPONSE = 0.34;
  const MOTION_SPRING_DAMPING = 0.82;
  const MOTION_POSITION_EPSILON = 0.5;
  const MOTION_VELOCITY_EPSILON = 5;
  const MAP_LABEL_GAP_DESKTOP = 6;
  const MAP_LABEL_GAP_COMPACT = 4;
  const MAP_CLUSTER_SCREEN_DISTANCE_DESKTOP = 120;
  const MAP_CLUSTER_SCREEN_DISTANCE_COMPACT = 88;
  const MAP_CLUSTER_DISTANCE_KM = 250;
  const MAP_LEADER_PREFERRED_DESKTOP = 180;
  const MAP_LEADER_PREFERRED_COMPACT = 120;
  const MAP_LEADER_MAXIMUM_DESKTOP = 220;
  const MAP_LEADER_MAXIMUM_COMPACT = 140;
  const MAP_PANEL_GAP = 10;
  const MAP_TRAFFIC_FAMILY_ROTATION_MS = 24000;
  const DESKTOP_MAP_TRAFFIC_PIN_LIMIT = 16;
  const MOBILE_MAP_TRAFFIC_PIN_LIMIT = 4;
  const MAP_PANEL_COACH_STORAGE_KEY = "spotterdex-map-panel-coach-dismissed";
  const MOBILE_SESSION_KEY_PREFIX = "spotterdex-mobile-session-v1:";
  const INSTALL_DISMISSED_STORAGE_KEY = "spotterdex-install-dismissed-v1";
  const IOS_INSTALL_HINT_VISITS_STORAGE_KEY = "spotterdex-ios-install-hint-visits-v1";
  const IOS_INSTALL_HINT_DISMISSED_STORAGE_KEY = "spotterdex-ios-install-hint-dismissed-v1";
  const SEARCH_RESULT_LIMIT_PER_KIND = 6;
  const SEARCH_KIND_ORDER = ["aircraft", "squadron", "location", "airshow", "photo"];
  const SEARCH_KIND_LABELS = {
    aircraft: "Aircraft",
    squadron: "Squadrons",
    location: "Locations",
    airshow: "Airshows",
    photo: "Photos"
  };
  const DEFAULT_SHARE_IMAGE_ALT = "Aircraft formation over Gifu Air Base in Japan";
  const FOCAL_DISTRIBUTION_FIRST_CENTER = 100;
  const FOCAL_DISTRIBUTION_BIN_WIDTH = 100;
  const AIRCRAFT_FAMILY_DEFINITIONS = [
    { id: "fighter", label: "Fighter" },
    { id: "helicopter", label: "Helicopter" },
    { id: "light", label: "Light" },
    { id: "medium", label: "Medium" },
    { id: "heavy", label: "Heavy" }
  ];
  const AIRCRAFT_FAMILY_LABELS = new Map(AIRCRAFT_FAMILY_DEFINITIONS.map((family) => [family.id, family.label]));
  const MOBILE_MAP_MEDIA_QUERY = "(max-width: 1040px)";
  const FOCUSED_MOBILE_MEDIA_QUERY = "(max-width: 1040px)";
  const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";
  const LEAFLET_SCRIPT_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  const LEAFLET_SCRIPT_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
  const MAPLIBRE_SCRIPT_URL = "https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.js";
  const MAPLIBRE_LEAFLET_SCRIPT_URL = "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js";
  const OPENFREEMAP_DARK_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
  let leafletLoadPromise = null;
  let openFreeMapLoadPromise = null;
  let statsExifLoadPromise = null;
  let simplePageAnimationFrame = 0;
  let mobileShellEventsBound = false;
  let viewerEventsBound = false;
  let serviceWorkerEventsBound = false;
  const motionControllers = new WeakMap();
  const PAGE_ROUTES = {
    mapView: "index.html",
    locationDetailView: "index.html",
    dexView: "aircraft-dex.html",
    aircraftDetailView: "aircraft-dex.html",
    squadronsView: "squadrons.html",
    squadronDetailView: "squadrons.html",
    airshowsView: "airshows.html",
    airshowDetailView: "airshows.html",
    statsView: "stats.html"
  };

  const state = {
    data: EMPTY_DATA,
    pinById: new Map(),
    photoById: new Map(),
    aircraftById: new Map(),
    airshowById: new Map(),
    photosByPinId: new Map(),
    enabledPins: [],
    selectedPinId: null,
    selectedAircraftId: null,
    selectedAircraftLocationId: "",
    selectedSquadronId: null,
    selectedAirshowId: null,
    airshowStoryController: null,
    airshowPreview: null,
    expandedLocationGroupKeys: new Set(),
    dexGroupMode: "squadron",
    dexFamilyFilter: "",
    dexVisibleCount: MOBILE_ARCHIVE_PAGE_SIZE,
    squadronVisibleCount: MOBILE_ARCHIVE_PAGE_SIZE,
    airshowVisibleCount: MOBILE_ARCHIVE_PAGE_SIZE,
    airshowYearFilter: "",
    catalogLoadError: false,
    catalogLoading: false,
    squadronCountryFilter: "",
    statsSection: "summary",
    detailRailDrag: null,
    suppressDetailRailClickUntil: 0,
    map: null,
    markerLayer: null,
    mapLeaderLayer: null,
    mapLabelLayer: null,
    mapTrafficLayer: null,
    mapTrafficInitialized: false,
    mapTrafficMobileLayout: null,
    mapTrafficMarkersByPinId: new Map(),
    mapTrafficFamiliesByPinId: new Map(),
    mapTrafficFamilyIndexByPinId: new Map(),
    mobileMapTrafficPinIds: null,
    mapTrafficRotationTimer: null,
    mapPreviewCache: new Map(),
    mapDossierOpen: true,
    markersByPinId: new Map(),
    mapLabelsByPinId: new Map(),
    mapCalloutLayouts: [],
    activeMapMarkerId: null,
    pendingMapFocusId: null,
    mapZoomInProgress: false,
    mapResizeObserver: null,
    mapImageObserver: null,
    archiveLoadObserver: null,
    archiveLoadFallbackHandler: null,
    archiveLoadPending: false,
    squadronCountryObserver: null,
    squadronCurrentCountry: "",
    mapRefreshHandle: null,
    mapRefreshTimer: null,
    mapCalloutRefreshHandle: null,
    mapCalloutRefreshTimer: null,
    mapResultsRenderHandle: null,
    activePhotoIds: [],
    activePhotoIndex: 0,
    activePhotoContext: "map",
    statsPhotoIds: [],
    statsPhotoLabel: "",
    statsFocalMode: "equivalent",
    viewerInfoOpen: false,
    viewerZoom: 1,
    viewerPanX: 0,
    viewerPanY: 0,
    viewerRenderToken: 0,
    viewerRevealToken: 0,
    viewerPointers: new Map(),
    viewerDragOrigin: null,
    viewerPinchStart: null,
    viewerGestureGeometry: null,
    viewerCarouselDrag: null,
    viewerInfoSnap: "expanded",
    viewerHistoryPushed: false,
    viewerReturnFocus: null,
    viewerReturnStory: null,
    mobileMapPanel: null,
    mapSheetSnap: "compact",
    sheetDrag: null,
    suppressMapLocationClickUntil: 0,
    scrollEdgeFrame: 0,
    installPromptEvent: null,
    iosInstallHintVisitRecorded: false,
    iosInstallHintVisitCount: 0,
    iosInstallHintEligible: false,
    iosInstallHintDismissed: false,
    overlayViewportCleanup: null,
    connectivityOffline: false,
    offlineMediaCoverageToken: 0,
    offlineMediaRefreshFrame: 0,
    sessionRestore: null,
    toastTimer: null,
    searchIndex: [],
    searchResults: [],
    searchActiveIndex: -1,
    searchReady: false,
    searchComposing: false,
    searchCategory: "",
    searchVisibleCounts: {},
    searchReturnFocus: null,
    serviceWorkerRegistration: null,
    waitingServiceWorker: null,
    updateVersion: "",
    updateReloadPending: false,
    updateRequiresReloadOnly: false,
    updateCheckTime: 0,
    serviceWorkerHadController: false,
    mapControlPanelOpen: true,
    renderedViews: new Set(),
    fullDataPromise: null,
    detailReturnContext: null,
    dexHeroSignature: "",
    lastHandledHistoryUrl: "",
    isApplyingHash: false
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    ensureAppToast();
    ensureGlobalSearch();
    ensureAppUpdatePrompt();
    ensureIosInstallHint();
    ensureMobileAppShell();
    cacheElements();
    if (els.siteHeader && "ResizeObserver" in window) {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty("--archive-sticky-top", `${els.siteHeader.getBoundingClientRect().height}px`);
      }).observe(els.siteHeader);
    }
    state.sessionRestore = readPageSessionState();
    restoreSessionFilters(state.sessionRestore);
    setupEvents();
    state.iosInstallHintVisitCount = recordIosInstallHintVisit();
    maybeShowIosInstallHint();

    await initializeCatalog();
  }

  async function initializeCatalog() {
    if (state.catalogLoading) return;
    const retryHadFocus = document.activeElement?.matches("[data-catalog-retry]");
    state.catalogLoading = true;
    document.querySelectorAll("[data-catalog-retry]").forEach((button) => { button.disabled = true; });
    try {
      state.data = prepareData(await loadData());
      state.catalogLoadError = false;
      document.getElementById("catalogLoadError")?.remove();
    } catch (error) {
      console.warn(error);
      state.catalogLoadError = true;
      if (!document.getElementById("catalogLoadError")) {
        els.main?.insertAdjacentHTML("afterbegin", '<section class="catalog-load-error empty-state" id="catalogLoadError" role="alert"><p>The catalog could not be loaded. Check your connection and try again.</p><button type="button" class="empty-state-reset" data-catalog-retry>Retry loading catalog</button></section>');
      }
      if (isGlobalSearchOpen()) renderGlobalSearchResults();
      return;
    } finally {
      state.catalogLoading = false;
      document.querySelectorAll("[data-catalog-retry]").forEach((button) => { button.disabled = false; });
    }
    state.searchIndex = buildGlobalSearchIndex();
    state.searchReady = true;
    if (isGlobalSearchOpen()) {
      renderGlobalSearchResults();
    }
    chooseInitialSelections();
    restoreSessionSelections(state.sessionRestore);
    renderAll();
    const routed = applyDeepLinkFromHash({ initial: true });
    if (!routed) {
      setActiveTab(currentPageViewId(), { updateHash: false });
    }
    updateShareMetadata();
    updateMobileAppChrome();
    updateConnectivityUi({ announce: false });
    restoreSessionScroll(state.sessionRestore);
    scheduleScrollEdgeUpdate();
    scheduleServiceWorkerRegistration();
    announceStoryPreviewReady();
    if (retryHadFocus && !isViewerOpen()) {
      const target = isGlobalSearchOpen() ? els.globalSearchInput : els.main;
      if (target) {
        if (target === els.main) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
  }

  function announceStoryPreviewReady() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("storyPreview") !== "1" || !window.opener) return;
    window.opener.postMessage({type: "spotterdex-story-preview-ready"}, window.location.origin);
  }

  function handleStoryPreviewMessage(event) {
    const message = event.data;
    if (!message || message.type !== "spotterdex-story-preview") return;
    if (window.opener && event.source !== window.opener) return;
    const eventId = String(message.eventId || "");
    const story = message.story && typeof message.story === "object" ? message.story : null;
    if (!eventId || !story || !state.airshowById.has(eventId)) return;
    state.airshowPreview = {eventId, story};
    state.selectedAirshowId = eventId;
    if (document.getElementById("airshowDetailView")) {
      setActiveTab("airshowDetailView", {updateHash: false});
      renderAirshowDetail();
    }
  }

  function currentPageViewId() {
    return document.body.dataset.pageView || document.querySelector("[data-view]")?.id || "mapView";
  }

  function pageRouteForView(viewId) {
    return PAGE_ROUTES[navigationViewFor(viewId)] || PAGE_ROUTES[viewId] || PAGE_ROUTES.mapView;
  }

  function navigateToViewPage(viewId, hash = "") {
    const url = new URL(pageRouteForView(viewId), document.baseURI);
    url.hash = hash.replace(/^#/, "");
    window.location.assign(url.href);
  }

  function scheduleServiceWorkerRegistration() {
    const register = () => registerServiceWorker();
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
  }

  function ensurePhotoViewer() {
    if (document.getElementById("photoViewer")) {
      cacheViewerElements();
      bindPhotoViewerEvents();
      return;
    }

    document.body.insertAdjacentHTML("beforeend", `
      <div class="photo-viewer" id="photoViewer" role="dialog" aria-modal="true" aria-label="Photo viewer" hidden>
        <div class="viewer-ambient" aria-hidden="true"></div>
        <div class="viewer-viewport">
          <div class="viewer-stage">
          <button class="viewer-button close" type="button" id="closeViewerButton" aria-label="Close viewer" title="Close viewer">
            <svg class="viewer-control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m6 6 12 12M18 6 6 18"></path>
            </svg>
          </button>
          <button class="viewer-button info-toggle" type="button" id="viewerInfoButton" aria-label="Show photo info" aria-controls="viewerInfo" aria-expanded="false">i</button>
          <div class="viewer-telemetry" id="viewerTelemetry" aria-live="polite"></div>
          <div class="viewer-zoom-controls" aria-label="Photo display controls">
            <button class="viewer-button viewer-tool" type="button" id="viewerZoomOutButton" aria-label="Zoom out">−</button>
            <button class="viewer-button viewer-tool viewer-zoom-readout" type="button" id="viewerZoomResetButton" aria-label="Reset photo zoom">1×</button>
            <button class="viewer-button viewer-tool" type="button" id="viewerZoomInButton" aria-label="Zoom in">+</button>
            <button class="viewer-button viewer-tool viewer-action" type="button" id="viewerShareButton" aria-label="Share photo" title="Share photo">
              <svg class="viewer-control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12 16V3"></path><path d="m7 8 5-5 5 5"></path><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"></path>
              </svg>
            </button>
            <button class="viewer-button viewer-tool viewer-action" type="button" id="viewerFullscreenButton" aria-label="Enter fullscreen" title="Enter fullscreen" aria-pressed="false">
              <svg class="viewer-control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"></path>
              </svg>
            </button>
          </div>
          <div class="viewer-image-frame">
            <button class="viewer-button previous" type="button" id="previousPhotoButton" aria-label="Previous photo">◀</button>
            <div class="viewer-carousel-track" id="viewerCarouselTrack">
              <img class="viewer-carousel-preview" id="viewerPreviousImage" alt="" aria-hidden="true" draggable="false">
              <img id="viewerImage" alt="" draggable="false">
              <img class="viewer-carousel-preview" id="viewerNextImage" alt="" aria-hidden="true" draggable="false">
            </div>
            <button class="viewer-button next" type="button" id="nextPhotoButton" aria-label="Next photo">▶</button>
          </div>
            <div class="viewer-filmstrip" id="viewerFilmstrip" aria-label="Photo thumbnails"></div>
          </div>
          <aside class="viewer-info" id="viewerInfo">
            <div class="viewer-info-sheet-bar">
              <button class="viewer-info-sheet-handle" type="button" data-sheet-handle="viewer" aria-label="Collapse photo information" aria-expanded="true"></button>
              <button class="viewer-info-close" type="button" id="viewerInfoCloseButton" aria-label="Close photo information" title="Close photo information">
                <svg class="viewer-control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="m6 6 12 12M18 6 6 18"></path>
                </svg>
              </button>
            </div>
            <p class="eyebrow" id="viewerKicker">Photo</p>
            <h2 id="viewerTitle">Photo details</h2>
            <p class="viewer-caption" id="viewerCaption"></p>
            <div class="metadata-panel" id="viewerMetadata"></div>
          </aside>
        </div>
      </div>
    `);
    cacheViewerElements();
    bindPhotoViewerEvents();
  }

  function ensureAppToast() {
    let toast = document.getElementById("appToast");
    if (!toast) {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div class="app-toast" id="appToast" role="status" aria-live="polite" hidden></div>'
      );
      toast = document.getElementById("appToast");
    }
    els.appToast = toast;
  }

  function ensureGlobalSearch() {
    if (!document.getElementById("mobileGlobalSearchTrigger")) {
      document.body.insertAdjacentHTML("beforeend", `
        <button class="mobile-global-search-trigger" id="mobileGlobalSearchTrigger" type="button" data-global-search-trigger aria-label="Search SpotterDex" title="Search SpotterDex" aria-keyshortcuts="Control+K Meta+K">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m16.5 16.5 4 4"></path>
          </svg>
        </button>
      `);
    }
    if (!document.getElementById("globalSearchOverlay")) {
      document.body.insertAdjacentHTML("beforeend", `
        <div class="global-search-overlay" id="globalSearchOverlay" role="dialog" aria-modal="true" aria-labelledby="globalSearchTitle" hidden>
          <button class="global-search-backdrop" type="button" tabindex="-1" data-global-search-close aria-label="Close search"></button>
          <section class="global-search-panel">
            <header class="global-search-heading">
              <div>
                <p class="eyebrow">Search the archive</p>
                <h2 id="globalSearchTitle">Find anything</h2>
              </div>
              <button class="global-search-close" type="button" data-global-search-close aria-label="Close search" title="Close search">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"></path></svg>
              </button>
            </header>
            <label class="global-search-control" for="globalSearchInput">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="7"></circle>
                <path d="m16.5 16.5 4 4"></path>
              </svg>
              <input id="globalSearchInput" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Aircraft, squadron, location, airshow, or photo" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <kbd aria-hidden="true">⌘ K</kbd>
            </label>
            <label class="global-search-category" for="globalSearchCategory">Category
              <select id="globalSearchCategory"><option value="">All categories</option>${SEARCH_KIND_ORDER.map((kind) => `<option value="${kind}">${SEARCH_KIND_LABELS[kind]}</option>`).join("")}</select>
            </label>
            <p class="global-search-summary" id="globalSearchSummary" aria-live="polite">Start typing to search the entire SpotterDex.</p>
            <div class="global-search-results" id="globalSearchResults" aria-label="Search results"></div>
          </section>
        </div>
      `);
    }
  }

  function ensureAppUpdatePrompt() {
    if (document.getElementById("appUpdatePrompt")) {
      return;
    }
    document.body.insertAdjacentHTML("beforeend", `
      <section class="app-update-prompt" id="appUpdatePrompt" role="region" aria-label="SpotterDex update" aria-live="polite" hidden>
        <img src="assets/icons/spotterdex-app-icon-192.png" alt="">
        <span>
          <strong>Update available</strong>
          <small>Reload to use the latest SpotterDex.</small>
        </span>
        <button class="app-update-action" type="button" id="appUpdateButton">Update</button>
        <button class="app-update-dismiss" type="button" id="appUpdateDismiss" aria-label="Update later">Later</button>
      </section>
    `);
  }

  function ensureIosInstallHint() {
    if (document.getElementById("iosInstallHint")) {
      return;
    }
    document.body.insertAdjacentHTML("beforeend", `
      <section class="ios-install-hint" id="iosInstallHint" role="region" aria-label="Install SpotterDex on iPhone or iPad" hidden>
        <img src="assets/icons/spotterdex-apple-touch-icon-v4.png" alt="">
        <p>Add SpotterDex to your Home Screen for a full-screen field guide. Tap <span class="ios-install-share-glyph" role="img" aria-label="Share">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 16V3"></path><path d="m7 8 5-5 5 5"></path><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"></path></svg>
        </span>, then <strong>Add to Home Screen</strong>.</p>
        <button class="ios-install-hint-dismiss" type="button" id="iosInstallHintDismiss" aria-label="Dismiss installation hint">×</button>
      </section>
    `);
  }

  function ensureMobileAppShell() {
    if (document.getElementById("mobileTabBar")) {
      cacheMobileElements();
      bindMobileShellEvents();
      return;
    }
    if (!window.matchMedia(MOBILE_MAP_MEDIA_QUERY).matches) {
      return;
    }
    const header = document.querySelector(".site-header");
    header?.insertAdjacentHTML("beforeend", `
      <div class="mobile-context-bar" id="mobileContextBar" hidden>
        <button class="mobile-context-back" id="mobileContextBack" type="button" aria-label="Back to collection">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        <strong id="mobileContextTitle">SpotterDex</strong>
      </div>
      <span class="mobile-connectivity" id="mobileConnectivity" role="status" hidden>Offline</span>
    `);
    document.body.insertAdjacentHTML("beforeend", `
      <nav class="mobile-tab-bar" id="mobileTabBar" aria-label="Primary navigation">
        ${mobileTabLink("mapView", "index.html", "Map", '<path class="globe-earth-land" d="M21.54 15H17a2 2 0 0 0-2 2v4.54"></path><path class="globe-earth-land" d="M7 3.34V5a3 3 0 0 0 3 3 2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"></path><path class="globe-earth-land" d="M11 21.95V18a2 2 0 0 0-2-2 2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"></path><circle class="globe-earth-outline" cx="12" cy="12" r="10"></circle>')}
        ${mobileTabLink("dexView", "aircraft-dex.html", "Aircraft", '<path d="M3 13.5 10 11V5.5a2 2 0 0 1 4 0V11l7 2.5v2l-7-.8V19l2 1v1l-4-1-4 1v-1l2-1v-4.3l-7 .8Z"></path>')}
        ${mobileTabLink("squadronsView", "squadrons.html", "Squadrons", '<circle cx="12" cy="10" r="8"></circle><path class="squadron-patch-compass" d="M12 3v4M4.5 10h3M16.5 10h3"></path><path class="squadron-patch-eagle" d="M12 10.5C10 7.8 7.8 6.8 5 7c.8 3 2.8 5 6 6l-1.8 3 2.8-1 2.8 1-1.8-3c3.2-1 5.2-3 6-6-2.8-.2-5 .8-7 3.5Z"></path><path d="M5 17.5 3.5 20 8 21l4-1 4 1 4.5-1-1.5-2.5"></path>')}
        ${mobileTabLink("airshowsView", "airshows.html", "Airshows", '<path class="airshow-formation-trails" d="M12 9.2v9.2M7 15.2V22M17 15.2V22"></path><g class="airshow-formation-jets"><path transform="translate(12 5) scale(.68)" d="M0-4c.8 0 1.1.8 1.1 2v2l4.2 2v1.5l-4.2-.9v2l1.5 1v.9L0 5.8l-2.6.7v-.9l1.5-1v-2l-4.2.9V2l4.2-2v-2c0-1.2.3-2 1.1-2Z"></path><path transform="translate(7 11) scale(.68)" d="M0-4c.8 0 1.1.8 1.1 2v2l4.2 2v1.5l-4.2-.9v2l1.5 1v.9L0 5.8l-2.6.7v-.9l1.5-1v-2l-4.2.9V2l4.2-2v-2c0-1.2.3-2 1.1-2Z"></path><path transform="translate(17 11) scale(.68)" d="M0-4c.8 0 1.1.8 1.1 2v2l4.2 2v1.5l-4.2-.9v2l1.5 1v.9L0 5.8l-2.6.7v-.9l1.5-1v-2l-4.2.9V2l4.2-2v-2c0-1.2.3-2 1.1-2Z"></path></g>')}
        ${mobileTabLink("statsView", "stats.html", "Stats", '<path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7M3 20h18"></path>')}
      </nav>
      <div class="mobile-install-prompt" id="mobileInstallPrompt" hidden>
        <img src="assets/icons/spotterdex-app-icon-192.png" alt="">
        <span><strong>Install SpotterDex</strong><small>Open it from your home screen.</small></span>
        <button type="button" id="mobileInstallButton">Install</button>
        <button class="mobile-install-dismiss" type="button" id="mobileInstallDismiss" aria-label="Dismiss install prompt">×</button>
      </div>
    `);
    cacheMobileElements();
    bindMobileShellEvents();
  }

  function mobileTabLink(viewId, href, label, icon) {
    return `
      <a href="${href}" data-mobile-tab-view="${viewId}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
        <span>${label}</span>
      </a>
    `;
  }

  function cacheElements() {
    els.siteHeader = document.querySelector(".site-header");
    els.main = document.getElementById("main");
    els.brand = document.querySelector(".brand");
    els.brandMark = document.getElementById("fitPinsIconButton");
    els.metaDescription = document.querySelector('meta[name="description"]');
    els.ogTitle = document.querySelector('meta[property="og:title"]');
    els.ogDescription = document.querySelector('meta[property="og:description"]');
    els.ogImage = document.querySelector('meta[property="og:image"]');
    els.ogImageAlt = document.querySelector('meta[property="og:image:alt"]');
    els.ogUrl = document.querySelector('meta[property="og:url"]');
    els.twitterTitle = document.querySelector('meta[name="twitter:title"]');
    els.twitterDescription = document.querySelector('meta[name="twitter:description"]');
    els.twitterImage = document.querySelector('meta[name="twitter:image"]');
    els.twitterImageAlt = document.querySelector('meta[name="twitter:image:alt"]');
    els.canonical = document.querySelector('link[rel="canonical"]');
    els.viewSelect = document.getElementById("viewSelect");
    els.globalSearchTriggers = document.querySelectorAll("[data-global-search-trigger]");
    els.mobileGlobalSearchTrigger = document.getElementById("mobileGlobalSearchTrigger");
    els.globalSearchOverlay = document.getElementById("globalSearchOverlay");
    els.globalSearchInput = document.getElementById("globalSearchInput");
    els.globalSearchCategory = document.getElementById("globalSearchCategory");
    els.airshowYearFilter = document.getElementById("airshowYearFilter");
    els.globalSearchResults = document.getElementById("globalSearchResults");
    els.globalSearchSummary = document.getElementById("globalSearchSummary");
    els.appUpdatePrompt = document.getElementById("appUpdatePrompt");
    els.appUpdateButton = document.getElementById("appUpdateButton");
    els.appUpdateDismiss = document.getElementById("appUpdateDismiss");
    els.iosInstallHint = document.getElementById("iosInstallHint");
    els.iosInstallHintDismiss = document.getElementById("iosInstallHintDismiss");
    const viewId = currentPageViewId();
    if (viewId === "mapView") {
      els.aircraftCount = document.getElementById("aircraftCount");
      els.photoCount = document.getElementById("photoCount");
      els.locationCount = document.getElementById("locationCount");
      els.locationSearch = document.getElementById("locationSearch");
      els.locationList = document.getElementById("locationList");
      els.mapWorkspace = document.querySelector("#mapView .map-workspace");
      els.mapControlPanel = document.getElementById("mapControlPanel");
      els.mapPanelToggles = document.querySelectorAll("[data-map-panel-toggle]");
      els.mapPanelBackdrop = document.querySelector(".map-panel-backdrop");
      els.mapPanelCoach = document.getElementById("mapPanelCoach");
      els.mapPanelCoachDismiss = document.getElementById("mapPanelCoachDismiss");
      els.worldMap = document.getElementById("worldMap");
      els.mapFallback = document.getElementById("mapFallback");
      els.mapResults = document.getElementById("mapResults");
      els.locationDetail = document.getElementById("locationDetail");
    } else if (viewId === "dexView") {
      els.dexFamilyFilter = document.getElementById("dexFamilyFilter");
      els.dexHeroMedia = document.getElementById("dexHeroMedia");
      els.dexHeroFeature = document.getElementById("dexHeroFeature");
      els.dexHeroAction = document.getElementById("dexHeroAction");
      els.dexHeroAircraftCount = document.getElementById("dexHeroAircraftCount");
      els.dexHeroPhotoCount = document.getElementById("dexHeroPhotoCount");
      els.dexHeroCountryCount = document.getElementById("dexHeroCountryCount");
      els.aircraftGrid = document.getElementById("aircraftGrid");
      els.dexPagination = document.getElementById("dexPagination");
      els.aircraftDetail = document.getElementById("aircraftDetail");
      els.dexCount = document.getElementById("dexCount");
    } else if (viewId === "squadronsView") {
      els.squadronLogoGrid = document.getElementById("squadronLogoGrid");
      els.squadronPagination = document.getElementById("squadronPagination");
      els.squadronCountryRail = document.getElementById("squadronCountryRail");
      els.squadronHeroMedia = document.getElementById("squadronHeroMedia");
      els.squadronHeroCountryCount = document.getElementById("squadronHeroCountryCount");
      els.squadronHeroPhotoCount = document.getElementById("squadronHeroPhotoCount");
      els.squadronDetail = document.getElementById("squadronDetail");
      els.squadronPageCount = document.getElementById("squadronPageCount");
    } else if (viewId === "airshowsView") {
      els.airshowTimeline = document.getElementById("airshowTimeline");
      els.airshowPagination = document.getElementById("airshowPagination");
      els.airshowPageCount = document.getElementById("airshowPageCount");
      els.airshowHeroMedia = document.getElementById("airshowHeroMedia");
      els.airshowHeroPhotoCount = document.getElementById("airshowHeroPhotoCount");
      els.airshowHeroLocationCount = document.getElementById("airshowHeroLocationCount");
      els.airshowYearRange = document.getElementById("airshowYearRange");
      els.airshowDetail = document.getElementById("airshowDetail");
    } else if (viewId === "statsView") {
      els.statsHeroMedia = document.getElementById("statsHeroMedia");
      els.statsDashboard = document.getElementById("statsDashboard");
      els.exifDashboard = document.getElementById("exifDashboard");
      els.statsSectionNav = document.getElementById("statsSectionNav");
    }
  }

  function cacheMobileElements() {
    els.mobileContextBar = document.getElementById("mobileContextBar");
    els.mobileContextBack = document.getElementById("mobileContextBack");
    els.mobileContextTitle = document.getElementById("mobileContextTitle");
    els.mobileTabBar = document.getElementById("mobileTabBar");
    els.mobileTabLinks = document.querySelectorAll("[data-mobile-tab-view]");
    els.mobileConnectivity = document.getElementById("mobileConnectivity");
    els.mobileInstallPrompt = document.getElementById("mobileInstallPrompt");
    els.mobileInstallButton = document.getElementById("mobileInstallButton");
    els.mobileInstallDismiss = document.getElementById("mobileInstallDismiss");
    els.mobileMapLocationCard = document.querySelector(".mobile-map-location-card");
    els.mobileMapBrand = document.getElementById("mobileMapFitButton");
    els.mobileMapLocationTitle = document.getElementById("mobileMapLocationTitle");
    els.mobileMapPhotosCard = document.querySelector(".mobile-map-photos-card");
    els.mobileMapLocationNav = document.querySelector(".mobile-map-location-nav");
    els.mobileMapPhotoCount = document.getElementById("mobileMapPhotoCount");
    els.mobileMapPhotoLocation = document.getElementById("mobileMapPhotoLocation");
    els.appToast = document.getElementById("appToast");
  }

  function cacheViewerElements() {
    els.photoViewer = document.getElementById("photoViewer");
    els.viewerImageFrame = document.querySelector(".viewer-image-frame");
    els.viewerCarouselTrack = document.getElementById("viewerCarouselTrack");
    els.viewerPreviousImage = document.getElementById("viewerPreviousImage");
    els.viewerImage = document.getElementById("viewerImage");
    els.viewerNextImage = document.getElementById("viewerNextImage");
    els.viewerKicker = document.getElementById("viewerKicker");
    els.viewerTitle = document.getElementById("viewerTitle");
    els.viewerCaption = document.getElementById("viewerCaption");
    els.viewerMetadata = document.getElementById("viewerMetadata");
    els.viewerInfo = document.getElementById("viewerInfo");
    els.viewerInfoButton = document.getElementById("viewerInfoButton");
    els.viewerInfoCloseButton = document.getElementById("viewerInfoCloseButton");
    els.viewerFilmstrip = document.getElementById("viewerFilmstrip");
    els.viewerTelemetry = document.getElementById("viewerTelemetry");
    els.viewerZoomOutButton = document.getElementById("viewerZoomOutButton");
    els.viewerZoomResetButton = document.getElementById("viewerZoomResetButton");
    els.viewerZoomInButton = document.getElementById("viewerZoomInButton");
    els.viewerShareButton = document.getElementById("viewerShareButton");
    els.viewerFullscreenButton = document.getElementById("viewerFullscreenButton");
  }

  function isViewerOpen() {
    return Boolean(els.photoViewer && !els.photoViewer.hidden);
  }

  function willOpenKeyboard(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) {
      return true;
    }
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    return !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"])
      .has(element.type);
  }

  function syncOverlayPageSize() {
    const root = document.documentElement;
    const body = document.body;
    const width = Math.max(root.scrollWidth, body?.scrollWidth || 0, window.innerWidth);
    const height = Math.max(root.scrollHeight, body?.scrollHeight || 0, window.innerHeight);
    root.style.setProperty("--overlay-page-width", `${Math.ceil(width)}px`);
    root.style.setProperty("--overlay-page-height", `${Math.ceil(height)}px`);
  }

  function syncOverlayViewport() {
    const viewport = window.visualViewport;
    if (viewport && viewport.scale > 1.01) {
      return;
    }
    const scale = viewport?.scale || 1;
    const height = (viewport?.height || window.innerHeight) * scale;
    const offsetTop = viewport?.offsetTop || 0;
    const pageTop = viewport?.pageTop ?? window.scrollY + offsetTop;
    const root = document.documentElement;
    root.style.setProperty("--overlay-viewport-height", `${Math.max(1, Math.round(height))}px`);
    root.style.setProperty("--overlay-viewport-offset-top", `${Math.max(0, Math.round(offsetTop))}px`);
    root.style.setProperty("--overlay-viewport-page-top", `${Math.max(0, Math.round(pageTop))}px`);
  }

  function startOverlayViewportSync() {
    let keyboardSettleTimer = 0;
    let syncFrame = 0;
    let pageSizeSyncPending = false;
    const flushOverlaySync = () => {
      syncFrame = 0;
      if (pageSizeSyncPending) {
        pageSizeSyncPending = false;
        syncOverlayPageSize();
      }
      syncOverlayViewport();
    };
    const scheduleOverlaySync = ({ pageSize = false } = {}) => {
      pageSizeSyncPending = pageSizeSyncPending || pageSize;
      if (!syncFrame) {
        syncFrame = window.requestAnimationFrame(flushOverlaySync);
      }
    };
    const scheduleKeyboardSettle = () => {
      window.clearTimeout(keyboardSettleTimer);
      keyboardSettleTimer = window.setTimeout(scheduleOverlaySync, 360);
    };
    const handleViewportChange = () => {
      if (window.visualViewport && window.visualViewport.scale > 1.01) {
        return;
      }
      scheduleOverlaySync();
      if (!willOpenKeyboard(document.activeElement)) {
        scheduleKeyboardSettle();
      }
    };
    const handleWindowResize = () => {
      scheduleOverlaySync({ pageSize: true });
      if (!willOpenKeyboard(document.activeElement)) {
        scheduleKeyboardSettle();
      }
    };
    const handleFocusChange = (event) => {
      scheduleOverlaySync();
      if (event.type === "focusout" || !willOpenKeyboard(event.target)) {
        scheduleKeyboardSettle();
      }
    };

    syncOverlayPageSize();
    syncOverlayViewport();
    window.addEventListener("resize", handleWindowResize, { passive: true });
    window.addEventListener("scroll", handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener("resize", handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener("scroll", handleViewportChange, { passive: true });
    document.addEventListener("focusin", handleFocusChange, true);
    document.addEventListener("focusout", handleFocusChange, true);

    return () => {
      window.clearTimeout(keyboardSettleTimer);
      window.cancelAnimationFrame(syncFrame);
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("scroll", handleViewportChange);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
      document.removeEventListener("focusin", handleFocusChange, true);
      document.removeEventListener("focusout", handleFocusChange, true);
    };
  }

  function activateOverlayViewportSync() {
    state.overlayViewportCleanup?.();
    state.overlayViewportCleanup = startOverlayViewportSync();
  }

  function deactivateOverlayViewportSync() {
    if (isGlobalSearchOpen() || isViewerOpen()) {
      return;
    }
    state.overlayViewportCleanup?.();
    state.overlayViewportCleanup = null;
  }

  function bindMobileShellEvents() {
    if (mobileShellEventsBound) {
      return;
    }
    mobileShellEventsBound = true;
    els.mobileMapBrand?.addEventListener("click", () => fitMapToPins());
    els.mobileContextBack?.addEventListener("click", handleMobileContextBack);
    els.mobileTabLinks?.forEach((link) => link.addEventListener("click", handleMobileTabNavigation));
    els.mobileInstallButton?.addEventListener("click", installSpotterDex);
    els.mobileInstallDismiss?.addEventListener("click", dismissInstallPrompt);
    els.mobileMapLocationNav?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-location-nav]");
      if (button) {
        stepRecentLocation(button.dataset.locationNav);
      }
    });
  }

  function bindPhotoViewerEvents() {
    if (viewerEventsBound || !els.photoViewer || !els.viewerImage || !els.viewerCarouselTrack) {
      return;
    }
    viewerEventsBound = true;
    document.getElementById("closeViewerButton")?.addEventListener("click", closeViewer);
    document.getElementById("previousPhotoButton")?.addEventListener("click", () => stepPhoto(-1));
    document.getElementById("nextPhotoButton")?.addEventListener("click", () => stepPhoto(1));
    els.viewerInfoButton?.addEventListener("click", () => setViewerInfoOpen(!state.viewerInfoOpen));
    els.viewerInfoCloseButton?.addEventListener("click", () => setViewerInfoOpen(false));
    els.viewerZoomOutButton?.addEventListener("click", () => setViewerZoom(state.viewerZoom - 0.25));
    els.viewerZoomResetButton?.addEventListener("click", resetViewerTransform);
    els.viewerZoomInButton?.addEventListener("click", () => setViewerZoom(state.viewerZoom + 0.25));
    els.viewerShareButton?.addEventListener("click", () => shareViewerPhoto());
    els.viewerFullscreenButton?.addEventListener("click", toggleViewerFullscreen);
    els.viewerCarouselTrack.addEventListener("contextmenu", (event) => event.preventDefault());
    els.viewerImage.setAttribute("draggable", "false");
    els.viewerCarouselTrack.addEventListener("wheel", handleViewerWheel, { passive: false });
    els.viewerCarouselTrack.addEventListener("pointerdown", handleViewerPointerDown);
    els.viewerCarouselTrack.addEventListener("pointermove", handleViewerPointerMove);
    els.viewerCarouselTrack.addEventListener("pointerup", handleViewerPointerUp);
    els.viewerCarouselTrack.addEventListener("pointercancel", handleViewerPointerUp);
    els.viewerCarouselTrack.addEventListener("dblclick", () => {
      if (state.viewerZoom > 1) {
        resetViewerTransform();
      } else {
        setViewerZoom(2);
      }
    });
  }

  async function loadData() {
    let data = window.SPOTTERDEX_DATA;
    if (!data) {
      try {
        const response = await fetch("data/spotterdex.json", { cache: "no-cache" });
        if (!response.ok) {
          throw new Error("Could not load SpotterDex data");
        }
        data = await response.json();
      } catch (error) {
        console.warn(error);
        throw error;
      }
    }

    if (Number(data?.schemaVersion) !== 2 || !data?.entities || !data?.indexes) {
      throw new Error("Invalid SpotterDex catalog");
    }
    return data;
  }

  function normalizedPhotoViewModels(rawData, exifByPhotoId = {}) {
    if (Number(rawData?.schemaVersion) !== 2 || !rawData?.entities || !rawData?.indexes) {
      return [];
    }
    const entities = rawData.entities;
    const indexes = rawData.indexes;
    const countries = entities.countries || {};
    const aircraftEntities = entities.aircraft || {};
    const unitEntities = entities.units || {};
    const locationEntities = entities.locations || {};
    const eventEntities = entities.events || {};
    const photoEntities = entities.photos || {};

    return Object.values(photoEntities).map((photo, index) => {
      const subjects = Array.isArray(photo.subjects) ? photo.subjects : [];
      const primary = subjects.find((subject) => subject?.primary) || subjects[0] || {};
      const aircraft = aircraftEntities[primary.aircraftId] || {};
      const unit = unitEntities[primary.unitId] || {};
      const location = locationEntities[photo.locationId] || {};
      const event = eventEntities[photo.eventId] || {};
      const country = countries[unit.countryId || location.countryId] || {};
      const tagScope = aircraft.id ? "aircraft" : unit.id ? "squadron" : "location";
      const unitType = unit.kind ? normalizeUnitType(unit.kind) : "";
      const sortDate = String(photo.sortDate || photo.date || (photo.year ? `${photo.year}-01-01` : ""));
      const sortTime = Date.parse(sortDate);
      return {
        ...photo,
        id: String(photo.id || `photo-${index + 1}`),
        tagScope,
        aircraftId: aircraft.id || "",
        aircraftType: aircraft.name || defaultPhotoSubject(tagScope),
        aircraftFamily: aircraft.family || "",
        squadronId: unit.id || "",
        squadronName: unit.name || "",
        unitType,
        unitLabel: unit.id ? unitDisplayLabel(unitType) : "",
        country: country.name || "",
        locationName: location.name || "Unknown location",
        pinId: location.id || photo.locationId || "",
        airshow: event.name || "",
        livery: photo.livery || "",
        year: photo.year ? String(photo.year) : "",
        date: photo.date ? String(photo.date) : "",
        sortDate,
        sortTime: Number.isFinite(sortTime) ? sortTime : 0,
        thumbnail: photo.thumbnail || photo.image || "",
        exif: exifByPhotoId?.[photo.id] || photo.exif || {}
      };
    });
  }

  function normalizedCatalogViewModel(rawData, exifByPhotoId = {}) {
    if (Number(rawData?.schemaVersion) !== 2 || !rawData?.entities || !rawData?.indexes) {
      return { ...EMPTY_DATA };
    }
    const entities = rawData.entities;
    const indexes = rawData.indexes;
    const countries = entities.countries || {};
    const aircraftEntities = entities.aircraft || {};
    const unitEntities = entities.units || {};
    const locationEntities = entities.locations || {};
    const eventEntities = entities.events || {};
    const photos = normalizedPhotoViewModels(rawData, exifByPhotoId);
    const photoById = new Map(photos.map((photo) => [photo.id, photo]));
    const unitRecord = (unit) => {
      const country = countries[unit.countryId] || {};
      const hero = photoById.get(unit.heroPhotoId);
      const photoIds = (indexes.photoIdsByUnit?.[unit.id] || []).map(String);
      const unitType = normalizeUnitType(unit.kind);
      return {
        id: String(unit.id),
        name: unit.name || unknownUnitName(unitType),
        country: country.name || "",
        logo: unit.logo || "",
        unitType,
        unitLabel: unitDisplayLabel(unitType),
        showOnSquadronsPage: unitType === "squadron",
        photoIds,
        photoCount: photoIds.length,
        heroPhoto: hero ? {
          image: hero.image,
          thumbnail: hero.thumbnail,
          source: hero.source || "",
          originalSize: hero.originalSize || "",
          processedSize: hero.processedSize || "",
          thumbnailSize: hero.thumbnailSize || ""
        } : null,
        writeUp: normalizeWriteUp(unit.writeUp)
      };
    };
    const units = Object.values(unitEntities).map(unitRecord);
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const pins = Object.values(locationEntities).map((location) => ({
      id: location.id,
      name: location.name,
      country: countries[location.countryId]?.name || "",
      icao: location.icao || "",
      lat: Number(location.lat),
      lon: Number(location.lon),
      enabled: location.enabled !== false,
      heroPhotoId: location.heroPhotoId || "",
      writeUp: normalizeWriteUp(location.writeUp)
    })).filter((pin) => Number.isFinite(pin.lat) && Number.isFinite(pin.lon));
    const aircraft = Object.values(aircraftEntities).map((entry) => {
      const unitIds = (indexes.unitIdsByAircraft?.[entry.id] || []).map(String);
      const entryUnits = unitIds.map((unitId) => unitById.get(unitId)).filter(Boolean);
      const photoIds = (indexes.photoIdsByAircraft?.[entry.id] || []).map(String);
      const aircraftPhotoIds = new Set(photoIds);
      return {
        id: String(entry.id),
        typeName: entry.name || "Unknown aircraft",
        aircraftFamily: entry.family || "",
        countries: unique(entryUnits.map((unit) => unit.country).filter(Boolean)),
        squadrons: entryUnits.map((unit) => {
          const unitPhotoIds = unit.photoIds.filter((photoId) => aircraftPhotoIds.has(photoId));
          return { ...unit, photoIds: unitPhotoIds, photoCount: unitPhotoIds.length };
        }),
        photoIds,
        coverPhoto: entry.heroPhotoId || photoIds[0] || null,
        doubleWidth: entry.doubleWidth === true ? true : entry.doubleWidth === false ? false : null,
        writeUp: normalizeWriteUp(entry.writeUp),
        stats: {}
      };
    });
    const airshows = Object.values(eventEntities).map((event) => ({
      id: String(event.id),
      name: event.name || "Unnamed event",
      photoIds: (indexes.photoIdsByEvent?.[event.id] || []).map(String),
      heroPhotoId: event.heroPhotoId || "",
      firstDate: event.startsOn || "",
      latestDate: event.endsOn || "",
      writeUp: normalizeWriteUp(event.writeUp),
      story: event.story?.mode === "cinematic" && (
        Array.isArray(event.story.segments) || Array.isArray(event.story.moments)
      ) ? event.story : null
    }))
      .map((airshow) => ({ ...airshow, photoCount: airshow.photoIds.length }))
      .filter((airshow) => airshow.photoIds.length)
      .sort((a, b) => Date.parse(b.latestDate || "") - Date.parse(a.latestDate || "") || a.name.localeCompare(b.name));
    return {
      payload: rawData.payload || "full",
      generatedAt: rawData.generatedAt || null,
      pins,
      aircraft,
      squadrons: units,
      airshows,
      photos
    };
  }

  function loadStatsExifBundle() {
    if (window.SPOTTERDEX_EXIF) {
      return Promise.resolve(window.SPOTTERDEX_EXIF);
    }
    if (statsExifLoadPromise) {
      return statsExifLoadPromise;
    }

    statsExifLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "data/spotterdex-exif.js";
      script.async = true;
      script.addEventListener("load", () => {
        script.remove();
        if (window.SPOTTERDEX_EXIF) resolve(window.SPOTTERDEX_EXIF);
        else reject(new Error("Stats EXIF data is unavailable"));
      }, { once: true });
      script.addEventListener("error", () => {
        script.remove();
        reject(new Error("Could not load Stats EXIF data"));
      }, { once: true });
      document.head.append(script);
    }).catch((error) => {
      console.warn(error);
      statsExifLoadPromise = null;
      return null;
    });
    return statsExifLoadPromise;
  }

  function prepareData(rawData) {
    const data = normalizedCatalogViewModel(rawData, window.SPOTTERDEX_EXIF?.photos || {});
    data.aircraft.sort((a, b) => a.typeName.localeCompare(b.typeName));
    data.squadrons.sort((a, b) => `${a.country} ${a.name}`.localeCompare(`${b.country} ${b.name}`));
    state.pinById = new Map(data.pins.map((pin) => [pin.id, pin]));
    state.photoById = new Map(data.photos.map((photo) => [photo.id, photo]));
    state.aircraftById = new Map(data.aircraft.map((entry) => [entry.id, entry]));
    state.airshowById = new Map(data.airshows.map((airshow) => [airshow.id, airshow]));
    state.photosByPinId = indexPhotosByPin(data.pins, data.photos);
    state.enabledPins = data.pins.filter((pin) => pin.enabled);
    state.mapPreviewCache.clear();

    data.aircraft.forEach((entry) => {
      entry.coverPhoto = entry.coverPhoto || entry.photoIds[0] || null;
      entry.stats = normalizeAircraftStats(entry);
    });

    return data;
  }

  function buildGlobalSearchIndex() {
    const records = [];
    const addRecord = (record, keywords) => {
      const label = String(record.label || "").trim();
      records.push({
        ...record,
        label,
        searchLabel: normalizeText(label),
        haystack: normalizeText([label, record.id, record.meta, ...keywords].filter(Boolean).join(" "))
      });
    };

    state.data.aircraft.forEach((entry) => {
      const cover = state.photoById.get(entry.coverPhoto);
      addRecord({
        kind: "aircraft",
        id: entry.id,
        label: entry.typeName,
        meta: [AIRCRAFT_FAMILY_LABELS.get(entry.aircraftFamily), entry.countries.join(", ")].filter(Boolean).join(" · "),
        thumbnail: cover?.thumbnail || cover?.image || "",
        targetKind: "aircraft",
        targetId: entry.id
      }, [
        entry.aircraftFamily,
        ...entry.countries,
        ...(entry.squadrons || []).flatMap((unit) => [unit.name, unit.country, unit.unitLabel])
      ]);
    });

    const squadrons = collectSquadrons();
    const squadronIds = new Set(squadrons.map((squadron) => squadron.id));
    squadrons.forEach((squadron) => {
      addRecord({
        kind: "squadron",
        id: squadron.id,
        label: squadron.name,
        meta: [squadron.country, squadron.aircraftTypes.slice(0, 3).join(", ")].filter(Boolean).join(" · "),
        thumbnail: squadron.logo || squadron.heroPhoto?.thumbnail || squadron.heroPhoto?.image || "",
        targetKind: "squadron",
        targetId: squadron.id
      }, [squadron.country, ...squadron.aircraftTypes]);
    });

    state.enabledPins.forEach((pin) => {
      const pinPhotos = photosForPin(pin);
      const hero = state.photoById.get(pin.heroPhotoId) || pinPhotos[0];
      addRecord({
        kind: "location",
        id: pin.id,
        label: pin.name,
        meta: [normalizeIcao(pin.icao), pin.country, `${pinPhotos.length} photo${pinPhotos.length === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
        thumbnail: hero?.thumbnail || hero?.image || "",
        targetKind: "location",
        targetId: pin.id
      }, [pin.icao, pin.country]);
    });

    state.data.airshows.forEach((airshow) => {
      const hero = state.photoById.get(airshow.heroPhotoId) || state.photoById.get(airshow.photoIds[0]);
      const dateRange = airshow.firstDate && airshow.latestDate && airshow.firstDate !== airshow.latestDate
        ? `${formatDisplayDate(airshow.firstDate)} – ${formatDisplayDate(airshow.latestDate)}`
        : formatDisplayDate(airshow.latestDate || airshow.firstDate);
      addRecord({
        kind: "airshow",
        id: airshow.id,
        label: airshow.name,
        meta: [dateRange, `${airshow.photoCount} photo${airshow.photoCount === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
        thumbnail: hero?.thumbnail || hero?.image || "",
        targetKind: "airshow",
        targetId: airshow.id
      }, [airshow.firstDate, airshow.latestDate]);
    });

    state.data.photos.forEach((photo) => {
      let targetKind = "location";
      let targetId = photo.pinId;
      if (photo.aircraftId && state.aircraftById.has(photo.aircraftId)) {
        targetKind = "aircraft";
        targetId = photo.aircraftId;
      } else if (photo.eventId && state.airshowById.has(photo.eventId)) {
        targetKind = "airshow";
        targetId = photo.eventId;
      } else if (photo.squadronId && squadronIds.has(photo.squadronId)) {
        targetKind = "squadron";
        targetId = photo.squadronId;
      }
      if (!targetId) {
        return;
      }
      const label = photo.title || photoSubjectLabel(photo);
      addRecord({
        kind: "photo",
        id: photo.id,
        label,
        meta: [
          photoSubjectLabel(photo),
          photo.squadronName,
          photo.locationName,
          photo.airshow,
          displayPhotoDate(photo)
        ].filter(Boolean).join(" · "),
        thumbnail: photo.thumbnail || photo.image || "",
        targetLabel: records.find((record) => record.kind === targetKind && record.id === targetId)?.label || photo.locationName,
        targetKind,
        targetId
      }, [
        photo.aircraftType,
        photo.squadronName,
        photo.locationName,
        photo.country,
        photo.airshow,
        photo.livery,
        photo.date,
        photo.year
      ]);
    });

    return records;
  }

  function globalSearchScore(record, query, tokens) {
    if (!tokens.every((token) => record.haystack.includes(token))) {
      return -1;
    }
    let score = 100;
    if (record.searchLabel === query) score += 1000;
    else if (normalizeText(record.id) === query) score += 900;
    else if (record.searchLabel.startsWith(query)) score += 600;
    else if (record.searchLabel.includes(query)) score += 350;
    tokens.forEach((token) => {
      if (record.searchLabel.startsWith(token)) score += 120;
      else if (record.searchLabel.includes(token)) score += 60;
      const position = record.haystack.indexOf(token);
      score += Math.max(0, 30 - Math.min(30, position));
    });
    return score;
  }

  function globalSearchMatches(query) {
    const normalizedQuery = normalizeText(query).replace(/\s+/g, " ");
    const tokens = normalizedQuery.split(" ").filter(Boolean);
    if (!tokens.length) {
      return [];
    }
    const byKind = new Map(SEARCH_KIND_ORDER.map((kind) => [kind, []]));
    state.searchIndex.forEach((record) => {
      const score = globalSearchScore(record, normalizedQuery, tokens);
      if (score >= 0) {
        byKind.get(record.kind)?.push({ ...record, score });
      }
    });
    const matches = [];
    SEARCH_KIND_ORDER.forEach((kind) => {
      const records = byKind.get(kind)
        .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
      matches.push(...records);
    });
    return matches;
  }

  function renderGlobalSearchResults() {
    if (!els.globalSearchResults || !els.globalSearchSummary) {
      return;
    }
    const query = els.globalSearchInput?.value || "";
    els.globalSearchInput?.removeAttribute("aria-controls");
    els.globalSearchInput?.setAttribute("aria-expanded", "false");
    if (!normalizeText(query) && els.globalSearchCategory) {
      els.globalSearchCategory.innerHTML = `<option value="">All categories</option>${SEARCH_KIND_ORDER.map((kind) => `<option value="${kind}">${SEARCH_KIND_LABELS[kind]}</option>`).join("")}`;
      els.globalSearchCategory.value = state.searchCategory;
    }
    if (!state.searchReady) {
      state.searchResults = [];
      state.searchActiveIndex = -1;
      els.globalSearchInput?.removeAttribute("aria-activedescendant");
      els.globalSearchSummary.textContent = state.catalogLoadError ? "The catalog could not be loaded." : "Loading the catalog…";
      els.globalSearchResults.innerHTML = state.catalogLoadError
        ? '<div class="global-search-empty"><p>Check your connection and try again.</p><button type="button" class="empty-state-reset" data-catalog-retry>Retry loading catalog</button></div>'
        : '<p class="global-search-empty">Preparing aircraft, squadrons, locations, airshows, and photos.</p>';
      return;
    }
    if (!normalizeText(query)) {
      state.searchResults = [];
      state.searchActiveIndex = -1;
      els.globalSearchSummary.textContent = "Start typing to search the entire SpotterDex.";
      els.globalSearchResults.innerHTML = `
        <div class="global-search-hint">
          <span>Search across the field guide</span>
          <small>Try an aircraft type, ICAO code, squadron, event, photo title, or date.</small>
        </div>
      `;
      els.globalSearchInput?.removeAttribute("aria-activedescendant");
      return;
    }

    const matches = globalSearchMatches(query);
    const selectedMatches = matches.filter((record) => !state.searchCategory || record.kind === state.searchCategory);
    const totals = new Map(SEARCH_KIND_ORDER.map((kind) => [kind, matches.filter((record) => record.kind === kind).length]));
    if (els.globalSearchCategory) {
      els.globalSearchCategory.innerHTML = `<option value="">All categories (${matches.length})</option>${SEARCH_KIND_ORDER.map((kind) => `<option value="${kind}">${SEARCH_KIND_LABELS[kind]} (${totals.get(kind)})</option>`).join("")}`;
      els.globalSearchCategory.value = state.searchCategory;
    }
    state.searchResults = SEARCH_KIND_ORDER.flatMap((kind) => selectedMatches.filter((record) => record.kind === kind).slice(0, state.searchVisibleCounts[kind] || SEARCH_RESULT_LIMIT_PER_KIND));
    state.searchActiveIndex = state.searchResults.length ? 0 : -1;
    if (!state.searchResults.length) {
      els.globalSearchSummary.textContent = `No results${state.searchCategory ? ` in ${SEARCH_KIND_LABELS[state.searchCategory]}` : ""} for “${query.trim()}”. ${matches.length} total across all categories.`;
      els.globalSearchResults.innerHTML = '<p class="global-search-empty">No matching records. Try a broader term or ICAO code.</p>';
      els.globalSearchInput?.removeAttribute("aria-activedescendant");
      return;
    }

    els.globalSearchSummary.textContent = `Showing ${state.searchResults.length} of ${selectedMatches.length} results for “${query.trim()}”.${state.searchCategory ? ` ${matches.length} total across all categories.` : ""}`;
    let resultIndex = 0;
    els.globalSearchResults.innerHTML = SEARCH_KIND_ORDER.map((kind) => {
      const records = state.searchResults.filter((record) => record.kind === kind);
      if (!records.length) {
        return "";
      }
      const headingId = `global-search-${kind}-heading`;
      const items = records.map((record) => {
        const index = resultIndex;
        const active = index === state.searchActiveIndex;
        resultIndex += 1;
        const targetLabel = SEARCH_KIND_LABELS[record.targetKind] || "Record";
        return `
          <button
            class="global-search-result${active ? " is-active" : ""}"
            id="globalSearchResult${index}"
            type="button"
            role="option"
            aria-selected="${active ? "true" : "false"}"
            data-search-result-index="${index}"
          >
            ${record.thumbnail
              ? `<img src="${escapeAttr(record.thumbnail)}" alt="" loading="lazy" decoding="async">`
              : `<span class="global-search-result-fallback" aria-hidden="true">${escapeHtml((SEARCH_KIND_LABELS[kind] || kind).slice(0, 2).toUpperCase())}</span>`}
            <span class="global-search-result-copy">
              <strong>${escapeHtml(record.label)}</strong>
              <small>${escapeHtml(record.meta || SEARCH_KIND_LABELS[kind])}</small>
            </span>
            <span class="global-search-result-target">${record.kind === "photo" ? record.targetLabel ? `Open in ${escapeHtml(record.targetLabel)}` : `Open ${escapeHtml(targetLabel)}` : "Open"}</span>
          </button>
        `;
      }).join("");
      const total = totals.get(kind);
      const more = records.length < total ? `<button type="button" class="global-search-show-more" data-search-show-more="${kind}">Show more ${SEARCH_KIND_LABELS[kind].toLowerCase()} (${total - records.length} remaining)</button>` : "";
      return `<section class="global-search-group" aria-labelledby="${headingId}"><h3 id="${headingId}">${SEARCH_KIND_LABELS[kind]} <span class="global-search-group-count">${records.length} of ${total}</span></h3><div class="global-search-options" id="globalSearchOptions-${kind}" role="listbox" aria-labelledby="${headingId}">${items}</div>${more}</section>`;
    }).join("");
    els.globalSearchInput?.setAttribute("aria-expanded", "true");
    els.globalSearchInput?.setAttribute("aria-controls", SEARCH_KIND_ORDER.filter((kind) => state.searchResults.some((record) => record.kind === kind)).map((kind) => `globalSearchOptions-${kind}`).join(" "));
    updateGlobalSearchActiveResult();
  }

  function isGlobalSearchOpen() {
    return Boolean(els.globalSearchOverlay && !els.globalSearchOverlay.hidden);
  }

  function openGlobalSearch(event) {
    if (isViewerOpen()) {
      return;
    }
    event?.preventDefault();
    state.searchReturnFocus = event?.currentTarget || document.activeElement;
    if (state.mobileMapPanel) {
      setMapPanel(null, { motion: false });
    }
    els.globalSearchOverlay.hidden = false;
    document.body.classList.add("is-search-open");
    activateOverlayViewportSync();
    setGlobalSearchBackgroundInert(true);
    renderGlobalSearchResults();
    noteMeaningfulIosInstallInteraction();
    window.requestAnimationFrame(() => els.globalSearchInput?.focus({ preventScroll: true }));
  }

  function closeGlobalSearch(options = {}) {
    if (!isGlobalSearchOpen()) {
      return;
    }
    els.globalSearchOverlay.hidden = true;
    state.searchComposing = false;
    document.body.classList.remove("is-search-open");
    deactivateOverlayViewportSync();
    setGlobalSearchBackgroundInert(false);
    syncIosInstallHintVisibility();
    if (options.restoreFocus !== false && state.searchReturnFocus instanceof HTMLElement) {
      state.searchReturnFocus.focus({ preventScroll: true });
    }
    state.searchReturnFocus = null;
  }

  function setGlobalSearchBackgroundInert(inert) {
    [
      els.siteHeader,
      els.main,
      els.mobileTabBar,
      els.mobileGlobalSearchTrigger,
      els.appUpdatePrompt,
      els.mobileInstallPrompt,
      els.iosInstallHint
    ].forEach((element) => {
      if (element) element.inert = inert;
    });
  }

  function updateGlobalSearchActiveResult(options = {}) {
    if (!els.globalSearchResults || !els.globalSearchInput) {
      return;
    }
    const optionsList = Array.from(els.globalSearchResults.querySelectorAll("[data-search-result-index]"));
    optionsList.forEach((option, index) => {
      const active = index === state.searchActiveIndex;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", String(active));
    });
    const active = optionsList[state.searchActiveIndex];
    if (active) {
      els.globalSearchInput.setAttribute("aria-activedescendant", active.id);
      if (options.scroll !== false) {
        active.scrollIntoView({ block: "nearest" });
      }
    } else {
      els.globalSearchInput.removeAttribute("aria-activedescendant");
    }
  }

  function moveGlobalSearchSelection(delta) {
    if (!state.searchResults.length) {
      return;
    }
    const resultHasFocus = Boolean(document.activeElement?.closest?.("[data-search-result-index]"));
    state.searchActiveIndex = (state.searchActiveIndex + delta + state.searchResults.length) % state.searchResults.length;
    updateGlobalSearchActiveResult();
    if (resultHasFocus) document.getElementById(`globalSearchResult${state.searchActiveIndex}`)?.focus({ preventScroll: true });
  }

  function activateGlobalSearchResult(index = state.searchActiveIndex) {
    const record = state.searchResults[index];
    if (!record) {
      return;
    }
    closeGlobalSearch({ restoreFocus: false });
    saveCurrentSessionState();
    if (record.targetKind === "aircraft") {
      selectAircraft(record.targetId);
    } else if (record.targetKind === "squadron") {
      selectSquadron(record.targetId);
    } else if (record.targetKind === "airshow") {
      selectAirshow(record.targetId);
    } else {
      selectLocationPage(record.targetId);
    }
  }

  function indexPhotosByPin(pins, photos) {
    const photosByPinId = new Map(pins.map((pin) => [pin.id, []]));
    const pinIdsByLocation = new Map();
    pins.forEach((pin) => {
      const locationKey = normalizeKey(pin.name);
      const ids = pinIdsByLocation.get(locationKey) || [];
      ids.push(pin.id);
      pinIdsByLocation.set(locationKey, ids);
    });

    photos.forEach((photo) => {
      const matchingPinIds = new Set();
      if (photosByPinId.has(photo.pinId)) {
        matchingPinIds.add(photo.pinId);
      }
      (pinIdsByLocation.get(normalizeKey(photo.locationName)) || []).forEach((pinId) => matchingPinIds.add(pinId));
      matchingPinIds.forEach((pinId) => photosByPinId.get(pinId).push(photo));
    });
    photosByPinId.forEach((pinPhotos) => pinPhotos.sort(sortPhotos));
    return photosByPinId;
  }

  function chooseInitialSelections() {
    const recent = recentLocations();
    const mostRecentLocation = recent.find(({ pin }) => normalizeKey(pin.country) !== "singapore") || recent[0];
    const firstEnabledPin = state.data.pins.find((pin) => pin.enabled);
    state.selectedPinId = isFocusedMobileLayout()
      ? null
      : mostRecentLocation?.pin.id || firstEnabledPin?.id || null;
    state.selectedAircraftId = null;
  }

  function setupEvents() {
    const fitMapFromBrand = (event) => {
      if (currentPageViewId() !== "mapView") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      fitMapToPins();
    };

    els.brandMark?.addEventListener("click", fitMapFromBrand);
    els.brandMark?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        fitMapFromBrand(event);
      }
    });
    if (els.brand) {
      els.brand.addEventListener("click", (event) => {
        if (currentPageViewId() !== "mapView" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        goToMapHome();
      });
    }
    if (els.viewSelect) {
      els.viewSelect.addEventListener("change", () => {
        saveCurrentSessionState();
        window.location.assign(els.viewSelect.value);
      });
    }
    els.globalSearchTriggers?.forEach((trigger) => trigger.addEventListener("click", openGlobalSearch));
    els.globalSearchOverlay?.querySelectorAll("[data-global-search-close]").forEach((button) => {
      button.addEventListener("click", closeGlobalSearch);
    });
    const refreshSearch = () => {
      state.searchVisibleCounts = {};
      renderGlobalSearchResults();
    };
    els.globalSearchInput?.addEventListener("compositionstart", () => { state.searchComposing = true; });
    els.globalSearchInput?.addEventListener("compositionend", () => {
      state.searchComposing = false;
      refreshSearch();
    });
    els.globalSearchInput?.addEventListener("input", (event) => {
      if (!event.isComposing && !state.searchComposing) refreshSearch();
    });
    els.globalSearchCategory?.addEventListener("change", () => {
      state.searchCategory = els.globalSearchCategory.value;
      refreshSearch();
    });
    els.airshowYearFilter?.addEventListener("change", () => {
      state.airshowYearFilter = els.airshowYearFilter.value;
      state.airshowVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
      renderAirshowsPage();
      updateDeepLink("year", state.airshowYearFilter);
      saveCurrentSessionState();
    });
    els.globalSearchResults?.addEventListener("focusin", (event) => {
      const result = event.target.closest("[data-search-result-index]");
      if (result) {
        state.searchActiveIndex = Number(result.dataset.searchResultIndex);
        updateGlobalSearchActiveResult({ scroll: false });
      }
    });
    els.globalSearchResults?.addEventListener("click", (event) => {
      const more = event.target.closest("[data-search-show-more]");
      if (more) {
        const kind = more.dataset.searchShowMore;
        const previousCount = state.searchVisibleCounts[kind] || SEARCH_RESULT_LIMIT_PER_KIND;
        state.searchVisibleCounts[kind] = previousCount + SEARCH_RESULT_LIMIT_PER_KIND;
        renderGlobalSearchResults();
        const firstNewIndex = state.searchResults.findIndex((record) => record.kind === kind) + previousCount;
        state.searchActiveIndex = firstNewIndex;
        updateGlobalSearchActiveResult({ scroll: false });
        document.getElementById(`globalSearchResult${firstNewIndex}`)?.focus({ preventScroll: true });
        return;
      }
      const result = event.target.closest("[data-search-result-index]");
      if (result) {
        activateGlobalSearchResult(Number(result.dataset.searchResultIndex));
      }
    });
    els.appUpdateButton?.addEventListener("click", applyAppUpdate);
    els.appUpdateDismiss?.addEventListener("click", dismissAppUpdate);
    els.iosInstallHintDismiss?.addEventListener("click", dismissIosInstallHint);
    document.getElementById("fitPinsButton")?.addEventListener("click", handleHeaderMapButton);
    document.getElementById("mobileMapHeaderFitButton")?.addEventListener("click", handleHeaderMapButton);
    document.getElementById("fitPinsPanelButton")?.addEventListener("click", fitMapToPins);
    els.mapPanelCoachDismiss?.addEventListener("click", dismissMapPanelCoach);
    els.worldMap?.addEventListener("pointerdown", handleMapDirectInteraction, { capture: true, passive: true });

    els.locationSearch?.addEventListener("input", renderLocations);

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("error", handlePhotoMediaError, true);
    document.addEventListener("load", handlePhotoMediaLoad, true);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("message", handleStoryPreviewMessage);
    document.addEventListener("pointerdown", handleSheetPointerDown);
    document.addEventListener("pointermove", handleSheetPointerMove, { passive: false });
    document.addEventListener("pointerup", handleSheetPointerUp);
    document.addEventListener("pointercancel", handleSheetPointerUp);
    document.addEventListener("pointerdown", handleDetailRailPointerDown);
    document.addEventListener("pointermove", handleDetailRailPointerMove, { passive: false });
    document.addEventListener("pointerup", handleDetailRailPointerUp);
    document.addEventListener("pointercancel", handleDetailRailPointerUp);
    document.addEventListener("click", suppressDetailRailClick, true);
    window.addEventListener("popstate", handleHistoryNavigation);
    window.addEventListener("hashchange", handleHistoryNavigation);
    window.addEventListener("pagehide", saveCurrentSessionState);
    window.addEventListener("pageshow", (event) => {
      scheduleScrollEdgeUpdate();
      if (event.persisted) {
        checkForServiceWorkerUpdate({ force: true });
      }
    });
    document.addEventListener("scroll", scheduleScrollEdgeUpdate, { passive: true, capture: true });
    window.addEventListener("scroll", scheduleScrollEdgeUpdate, { passive: true });
    window.addEventListener("online", () => updateConnectivityUi({ offline: false }));
    window.addEventListener("offline", () => updateConnectivityUi({ offline: true }));
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", () => {
      state.installPromptEvent = null;
      if (els.mobileInstallPrompt) els.mobileInstallPrompt.hidden = true;
      state.iosInstallHintEligible = false;
      syncIosInstallHintVisibility();
      showToast("SpotterDex installed");
    });
    document.addEventListener("fullscreenchange", updateViewerFullscreenButton);
    window.addEventListener("resize", debounce(() => {
      ensureMobileAppShell();
      if (els.mapWorkspace) {
        updateMobileMapHeader();
        updateRecentLocationNav();
        updateMapPanelState();
        updateMapPanelCoach();
      }
      updateViewerInfoState();
      updateMobileAppChrome();
      cancelGesturesForGeometryChange();
      syncMotionSurfaceGeometry();
      if (isViewerOpen()) {
        resetViewerCarousel();
        measureViewerGestureGeometry();
        constrainViewerPan(state.viewerGestureGeometry);
        updateViewerTransform();
        updateViewerNavigationPosition();
      }
      scheduleScrollEdgeUpdate();
      if (els.mapWorkspace) refreshMapLayout();
      if (state.renderedViews.has("dexView")) {
        renderDex();
      }
      if (state.renderedViews.has("squadronsView")) {
        renderSquadronsPage();
      }
      if (state.renderedViews.has("airshowsView")) {
        renderAirshowsPage();
      }
      const activeView = document.querySelector("[data-view].is-active")?.id;
      if (activeView === "aircraftDetailView") {
        renderAircraftDetail();
      } else if (activeView === "squadronDetailView") {
        renderSquadronDetail();
      } else if (activeView === "airshowDetailView") {
        renderAirshowDetail();
      } else if (activeView === "locationDetailView") {
        renderLocationPage();
      }
    }, 150));

  }

  function openDirectoryView(viewId) {
    if (!document.getElementById(viewId)) {
      navigateToViewPage(viewId);
      return;
    }
    if (viewId === "dexView") {
      state.selectedAircraftId = null;
    } else if (viewId === "squadronsView") {
      state.selectedSquadronId = null;
    } else if (viewId === "airshowsView") {
      state.selectedAirshowId = null;
    }
    setActiveTab(viewId);
  }

  function handleHistoryNavigation() {
    const currentUrl = window.location.href;
    if (state.lastHandledHistoryUrl === currentUrl) {
      return;
    }
    state.lastHandledHistoryUrl = currentUrl;
    const activeBefore = activeViewId();
    const collectionView = navigationViewFor(activeBefore);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const detailHashKeys = {
      aircraftDetailView: hashParams.has("aircraft"),
      squadronDetailView: hashParams.has("squadron"),
      airshowDetailView: hashParams.has("airshow"),
      locationDetailView: hashParams.get("detail") === "1"
    };
    if (
      activeBefore !== collectionView
      && state.detailReturnContext?.backView === collectionView
      && !detailHashKeys[activeBefore]
    ) {
      if (isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false });
      }
      returnFromDetail(collectionView, { updateHash: false });
      return;
    }
    const routed = applyDeepLinkFromHash();
    if (!routed) {
      if (isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false });
      }
      if (activeBefore !== collectionView && state.detailReturnContext?.backView === collectionView) {
        returnFromDetail(collectionView, { updateHash: false });
      } else {
        setActiveTab(currentPageViewId(), { updateHash: false });
      }
    }
  }

  function handleDocumentClick(event) {
    if (event.target.closest("#viewerInfoButton")) {
      return;
    }

    const sheetHandle = event.target.closest("[data-sheet-handle]");
    if (sheetHandle) {
      if (sheetHandle.dataset.dragged === "true") {
        delete sheetHandle.dataset.dragged;
      } else {
        toggleSheetSnap(sheetHandle.dataset.sheetHandle);
      }
      return;
    }

    if (isViewerOpen() && state.viewerInfoOpen && isMobileViewerLayout() && !event.target.closest("#viewerInfo")) {
      setViewerInfoOpen(false);
    }

    const fieldGuideShareButton = event.target.closest("[data-field-guide-share]");
    if (fieldGuideShareButton) {
      shareFieldGuide(fieldGuideShareButton).catch(() => {
        fieldGuideShareButton.textContent = nativeShareAvailable() ? "Share failed" : "Copy failed";
      });
      return;
    }

    const mapPanelButton = event.target.closest("[data-map-panel-toggle]");
    if (mapPanelButton) {
      if (
        mapPanelButton.classList.contains("mobile-map-location-card")
        && (performance.now() < state.suppressMapLocationClickUntil || mapPanelButton.dataset.dragged === "true")
      ) {
        delete mapPanelButton.dataset.dragged;
        return;
      }
      toggleMapPanel(mapPanelButton.dataset.mapPanelToggle);
      return;
    }

    if (event.target.closest("[data-map-panel-close]")) {
      setMapPanel(null);
      return;
    }

    if (event.target.closest("[data-catalog-retry]")) {
      initializeCatalog();
      return;
    }

    const airshowYearButton = event.target.closest("[data-airshow-year]");
    if (airshowYearButton) {
      state.airshowYearFilter = airshowYearButton.dataset.airshowYear || "";
      state.airshowVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
      renderAirshowsPage();
      updateDeepLink("year", state.airshowYearFilter);
      saveCurrentSessionState();
      els.airshowYearFilter?.focus({ preventScroll: true });
      return;
    }

    const countryJump = event.target.closest("[data-squadron-country-jump]");
    if (countryJump) {
      state.squadronCountryFilter = countryJump.dataset.squadronCountryFilter || "";
      state.squadronVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
      renderSquadronsPage();
      updateDeepLink("country", state.squadronCountryFilter);
      saveCurrentSessionState();
      Array.from(els.squadronCountryRail?.querySelectorAll("[data-squadron-country-filter]") || []).find((button) => button.dataset.squadronCountryFilter === state.squadronCountryFilter)?.focus({ preventScroll: true });
      return;
    }

    const dexFamilyFilterClear = event.target.closest("[data-clear-dex-family-filter]");
    if (dexFamilyFilterClear) {
      state.dexFamilyFilter = "";
      state.dexVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
      renderDex();
      clearDeepLink();
      saveCurrentSessionState();
      document.querySelector("[data-clear-dex-family-filter]")?.focus({ preventScroll: true });
      return;
    }

    const aircraftFamilyButton = event.target.closest("[data-dex-family-id]");
    if (aircraftFamilyButton) {
      openAircraftFamilyDex(aircraftFamilyButton.dataset.dexFamilyId || "");
      return;
    }

    const statsFilter = event.target.closest("[data-stats-filter-kind]");
    if (statsFilter) {
      openStatsPhotoSet(
        statsFilter.dataset.statsFilterKind,
        statsFilter.dataset.statsFilterValue || "",
        statsFilter.dataset.statsFilterLabel || "Selected photos"
      );
      return;
    }

    const statsSectionButton = event.target.closest("[data-stats-section]");
    if (statsSectionButton) {
      selectStatsSection(statsSectionButton.dataset.statsSection || "summary");
      return;
    }

    const statsFocalMode = event.target.closest("[data-stats-focal-mode]");
    if (statsFocalMode) {
      const mode = statsFocalMode.dataset.statsFocalMode;
      if (mode === "actual" || mode === "equivalent") {
        updateStatsFocalMode(mode);
      }
      return;
    }

    const dexGroupButton = event.target.closest("[data-dex-group]");
    if (dexGroupButton) {
      state.dexGroupMode = normalizeAircraftDetailGroup(dexGroupButton.dataset.dexGroup);
      renderAircraftDetail();
      if (state.selectedAircraftId) {
        updateAircraftDetailLink(state.selectedAircraftId, {
          group: state.dexGroupMode,
          locationId: state.selectedAircraftLocationId
        });
      }
      const targetId = dexGroupButton.dataset.dexGroupTarget;
      if (targetId) {
        window.requestAnimationFrame(() => {
          document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
      return;
    }

    const aircraftPhotoTarget = event.target.closest("[data-aircraft-photo-target]");
    if (aircraftPhotoTarget) {
      document.getElementById(aircraftPhotoTarget.dataset.aircraftPhotoTarget || "")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
      return;
    }

    const locationPageButton = event.target.closest("[data-location-page-id]");
    if (locationPageButton) {
      const viewerWasOpen = isViewerOpen();
      if (viewerWasOpen) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectLocationPage(locationPageButton.dataset.locationPageId, {
        transitionSource: viewerWasOpen ? null : locationPageButton
      });
      return;
    }

    const locationGroupButton = event.target.closest("[data-location-group-key]");
    if (locationGroupButton) {
      const squadronId = locationGroupButton.dataset.locationSquadronId;
      if (squadronId) {
        if (isViewerOpen()) {
          closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
        }
        selectSquadron(squadronId);
        return;
      }
      const singlePhotoId = locationGroupButton.dataset.locationSinglePhotoId;
      if (singlePhotoId) {
        openViewer(singlePhotoId, "map");
        return;
      }
      const key = locationGroupButton.dataset.locationGroupKey;
      if (state.expandedLocationGroupKeys.has(key)) {
        state.expandedLocationGroupKeys.delete(key);
      } else {
        state.expandedLocationGroupKeys.add(key);
      }
      renderMapResults();
      return;
    }

    const detailBackButton = event.target.closest("[data-detail-back]");
    if (detailBackButton) {
      returnFromDetail(detailBackButton.dataset.detailBack);
      return;
    }

    const locationButton = event.target.closest("[data-location-id]");
    if (locationButton) {
      selectPin(locationButton.dataset.locationId);
      return;
    }

    const aircraftButton = event.target.closest("[data-aircraft-id]");
    if (aircraftButton) {
      const viewerWasOpen = isViewerOpen();
      if (viewerWasOpen) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      const aircraftGroup = aircraftButton.dataset.aircraftGroup;
      const aircraftLocationId = aircraftButton.dataset.aircraftLocationId;
      const aircraftOptions = {};
      if (aircraftGroup) aircraftOptions.group = aircraftGroup;
      if (aircraftLocationId) {
        aircraftOptions.locationId = aircraftLocationId;
        aircraftOptions.focusLocation = true;
      }
      aircraftOptions.transitionSource = viewerWasOpen ? null : aircraftButton;
      selectAircraft(
        aircraftButton.dataset.aircraftId,
        aircraftOptions
      );
      return;
    }

    const squadronButton = event.target.closest("[data-squadron-id]");
    if (squadronButton) {
      const viewerWasOpen = isViewerOpen();
      if (viewerWasOpen) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectSquadron(squadronButton.dataset.squadronId, {
        transitionSource: viewerWasOpen ? null : squadronButton
      });
      return;
    }

    const airshowButton = event.target.closest("[data-airshow-id]");
    if (airshowButton) {
      const viewerWasOpen = isViewerOpen();
      if (viewerWasOpen) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectAirshow(airshowButton.dataset.airshowId, {
        transitionSource: viewerWasOpen ? null : airshowButton
      });
      return;
    }

    const filmstripButton = event.target.closest("[data-viewer-photo-index]");
    if (filmstripButton) {
      selectViewerPhoto(Number(filmstripButton.dataset.viewerPhotoIndex));
      return;
    }

    const photoButton = event.target.closest("[data-photo-id]");
    if (photoButton) {
      const rawStorySegmentIndex = photoButton.dataset.storySegmentIndex;
      const storySegmentIndex = rawStorySegmentIndex == null ? undefined : Number(rawStorySegmentIndex);
      openViewer(photoButton.dataset.photoId, photoButton.dataset.photoContext, {
        storySegmentIndex: Number.isInteger(storySegmentIndex) ? storySegmentIndex : undefined
      });
    }
  }

  function handleKeydown(event) {
    if (event.isComposing || state.searchComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (isGlobalSearchOpen()) {
        closeGlobalSearch();
      } else {
        openGlobalSearch();
      }
      return;
    }
    if (isGlobalSearchOpen()) {
      const searchNavigation = document.activeElement === els.globalSearchInput || Boolean(document.activeElement?.closest?.("[data-search-result-index]"));
      if (event.key !== "Tab" && event.key !== "Escape" && !searchNavigation) return;
      if (event.key === "Tab") {
        trapDialogFocus(els.globalSearchOverlay, event);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeGlobalSearch();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveGlobalSearchSelection(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveGlobalSearchSelection(-1);
      } else if (event.key === "Home" && document.activeElement === els.globalSearchInput) {
        event.preventDefault();
        state.searchActiveIndex = state.searchResults.length ? 0 : -1;
        updateGlobalSearchActiveResult();
      } else if (event.key === "End" && document.activeElement === els.globalSearchInput) {
        event.preventDefault();
        state.searchActiveIndex = state.searchResults.length - 1;
        updateGlobalSearchActiveResult();
      } else if (event.key === "Enter" && state.searchActiveIndex >= 0) {
        event.preventDefault();
        const focusedResult = document.activeElement?.closest?.("[data-search-result-index]");
        const focusedIndex = focusedResult ? Number(focusedResult.dataset.searchResultIndex) : state.searchActiveIndex;
        activateGlobalSearchResult(focusedIndex);
      }
      return;
    }
    if (isViewerOpen()) {
      if (event.key === "Tab") {
        trapViewerFocus(event);
      } else if (event.key === "Escape") {
        if (state.viewerInfoOpen && isMobileViewerLayout()) {
          setViewerInfoOpen(false);
        } else {
          closeViewer();
        }
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepPhoto(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepPhoto(1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setViewerZoom(state.viewerZoom + 0.25);
      } else if (event.key === "-") {
        event.preventDefault();
        setViewerZoom(state.viewerZoom - 0.25);
      } else if (event.key === "0") {
        event.preventDefault();
        resetViewerTransform();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        toggleViewerFullscreen();
      }
    } else if (event.key === "Escape" && state.mobileMapPanel && isMobileMapLayout()) {
      setMapPanel(null);
    }
  }

  function trapViewerFocus(event) {
    trapDialogFocus(els.photoViewer, event);
  }

  function trapDialogFocus(container, event) {
    const focusable = Array.from(container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.hidden && !element.closest("[inert], [aria-hidden=\"true\"]") && element.getClientRects().length);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleMapPanel(panel) {
    setMapPanel(state.mobileMapPanel === panel ? null : panel);
  }

  function setMapPanel(panel, options = {}) {
    const nextPanel = panel === "locations" || panel === "results" ? panel : null;
    const previousPanel = state.mobileMapPanel;
    if (nextPanel) {
      dismissMapPanelCoach();
      if (options.snap === "compact" || options.snap === "expanded") {
        state.mapSheetSnap = options.snap;
      } else if (!state.mobileMapPanel) {
        state.mapSheetSnap = "compact";
      }
    }
    state.mobileMapPanel = nextPanel;
    updateMapPanelState();
    updateMapPanelCoach();

    if (state.mobileMapPanel === "results") {
      scheduleMobileMapResults();
    }

    if (isFocusedMobileLayout() && options.motion !== false) {
      if (previousPanel && nextPanel && previousPanel !== nextPanel) {
        moveSheetTo(previousPanel === "locations" ? "locations" : "map", "closed");
      }
      if (nextPanel) {
        const surface = nextPanel === "locations" ? "locations" : "map";
        const targetSnap = nextPanel === "locations" ? "open" : state.mapSheetSnap;
        moveSheetTo(surface, targetSnap, {
          fromSnap: previousPanel === nextPanel ? null : "closed"
        });
      } else if (previousPanel) {
        moveSheetTo(previousPanel === "locations" ? "locations" : "map", "closed");
      }
    } else if (isFocusedMobileLayout() && nextPanel) {
      const surface = nextPanel === "locations" ? "locations" : "map";
      const descriptor = sheetMotionDescriptor(surface);
      descriptor?.panel.classList.add("is-motion-presented");
    }

    if (state.map && !isMobileMapLayout()) {
      refreshMapLayout();
    }
  }

  function scheduleMobileMapResults() {
    if (!isMobileMapLayout() || !els.mapResults || els.mapResults.dataset.pinId === state.selectedPinId) {
      return;
    }
    window.cancelAnimationFrame(state.mapResultsRenderHandle);
    els.mapResults.innerHTML = `${renderMapSheetBar("Photos", "Photos")}<div class="empty-state compact">Loading location details...</div>`;
    state.mapResultsRenderHandle = window.requestAnimationFrame(() => {
      if (state.mobileMapPanel === "results") {
        renderMapResults();
      }
    });
  }

  function setMapDossierOpen(isOpen) {
    state.mapDossierOpen = Boolean(isOpen);
    updateMapDossierState();
    refreshMapLayout();
  }

  function updateMapControlPanelState() {
    if (!els.mapWorkspace) {
      return;
    }
    els.mapWorkspace.classList.toggle("is-control-panel-open", state.mapControlPanelOpen);
  }

  function updateMapDossierState() {
    if (!els.mapWorkspace) {
      return;
    }
    els.mapWorkspace.classList.toggle("is-dossier-open", state.mapDossierOpen);
  }

  function updateMapPanelState() {
    if (!els.mapWorkspace) {
      return;
    }

    const activePanel = state.mobileMapPanel;
    els.mapWorkspace.classList.toggle("is-locations-open", activePanel === "locations");
    els.mapWorkspace.classList.toggle("is-results-open", activePanel === "results");
    els.mapWorkspace.classList.toggle("is-sheet-expanded", activePanel && state.mapSheetSnap === "expanded");
    if (els.mapPanelBackdrop) {
      els.mapPanelBackdrop.setAttribute("aria-hidden", "true");
      els.mapPanelBackdrop.tabIndex = -1;
    }

    els.mapPanelToggles.forEach((button) => {
      const isExpanded = button.dataset.mapPanelToggle === activePanel;
      button.classList.toggle("is-active", isExpanded);
      button.setAttribute("aria-expanded", String(isExpanded));
    });
    els.mapWorkspace.querySelectorAll('[data-sheet-handle="map"]').forEach((handle) => {
      const expanded = state.mapSheetSnap === "expanded";
      handle.setAttribute("aria-expanded", String(expanded));
      handle.setAttribute("aria-label", expanded ? "Collapse map panel" : "Expand map panel");
    });
  }

  function mapPanelCoachDismissed() {
    try {
      return window.localStorage.getItem(MAP_PANEL_COACH_STORAGE_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function dismissMapPanelCoach() {
    try {
      window.localStorage.setItem(MAP_PANEL_COACH_STORAGE_KEY, "1");
    } catch (error) {
      // Ignore storage failures; the coach simply will not persist.
    }
    updateMapPanelCoach();
  }

  function updateMapPanelCoach() {
    if (!els.mapPanelCoach || !els.mapWorkspace) {
      return;
    }

    const mapPageActive = Boolean(document.getElementById("mapView")?.classList.contains("is-active"));
    const viewerOpen = isViewerOpen();
    const showCoach = mapPageActive
      && isMobileMapLayout()
      && !mapPanelCoachDismissed()
      && !state.mobileMapPanel
      && !viewerOpen;

    els.mapPanelCoach.hidden = !showCoach;
    els.mapWorkspace.classList.toggle("is-panel-coach-visible", showCoach);
    els.mapPanelToggles.forEach((button) => {
      if (showCoach) {
        button.setAttribute("aria-describedby", "mapPanelCoach");
      } else {
        button.removeAttribute("aria-describedby");
      }
    });
  }

  function isMobileMapLayout() {
    return window.matchMedia(MOBILE_MAP_MEDIA_QUERY).matches;
  }

  function isFocusedMobileLayout() {
    return window.matchMedia(FOCUSED_MOBILE_MEDIA_QUERY).matches;
  }

  function isDenseDesktopMapLayout() {
    return window.matchMedia("(min-width: 1041px) and (max-width: 1500px)").matches;
  }

  function isMobileViewerLayout() {
    return isMobileMapLayout();
  }

  function isReducedMotion() {
    return window.matchMedia(REDUCED_MOTION_MEDIA_QUERY).matches;
  }

  function activeViewId() {
    return document.querySelector("[data-view].is-active")?.id || currentPageViewId();
  }

  function detailTriggerSelector(kind, entityId) {
    const selectors = {
      aircraft: "data-aircraft-id",
      squadron: "data-squadron-id",
      airshow: "data-airshow-id",
      location: "data-location-page-id"
    };
    const attribute = selectors[kind];
    return attribute && entityId
      ? `[${attribute}="${CSS.escape(String(entityId))}"]`
      : "";
  }

  function detailTransitionTrigger(context) {
    if (!context) {
      return null;
    }
    if (context.trigger?.isConnected) {
      return context.trigger;
    }
    const selector = detailTriggerSelector(context.kind, context.entityId);
    return selector ? document.querySelector(selector) : null;
  }

  function captureDetailReturnContext(backView, sourceElement, kind, entityId) {
    if (!(sourceElement instanceof Element) || activeViewId() !== backView) {
      return null;
    }
    return {
      backView,
      kind,
      entityId: String(entityId || ""),
      trigger: sourceElement,
      scrollY: Math.max(0, Math.round(window.scrollY)),
      mobileMapPanel: state.mobileMapPanel,
      mapSheetSnap: state.mapSheetSnap,
      mapDossierOpen: state.mapDossierOpen
    };
  }

  function cancelSimplePageAnimation() {
    window.cancelAnimationFrame(simplePageAnimationFrame);
    simplePageAnimationFrame = 0;
    document.querySelectorAll(".is-simple-arriving").forEach((view) => {
      view.classList.remove("is-simple-arriving");
    });
  }

  function runSimplePageTransition({
    update,
    targetViewId,
    after
  }) {
    cancelSimplePageAnimation();
    const arrivingView = document.getElementById(targetViewId);
    const shouldAnimate = Boolean(arrivingView) && !isReducedMotion();
    if (shouldAnimate) {
      arrivingView.classList.add("is-simple-arriving");
    }
    update();
    if (!shouldAnimate) {
      window.requestAnimationFrame(() => after?.());
      return null;
    }
    simplePageAnimationFrame = window.requestAnimationFrame(() => {
      simplePageAnimationFrame = 0;
      arrivingView?.classList.remove("is-simple-arriving");
      after?.();
    });
    return null;
  }

  function enterDetailView({ backView, detailView, kind, entityId, sourceElement, update }) {
    const returnContext = captureDetailReturnContext(backView, sourceElement, kind, entityId);
    if (returnContext) {
      state.detailReturnContext = returnContext;
    } else if (
      activeViewId() === backView
      || state.detailReturnContext?.kind !== kind
      || state.detailReturnContext?.entityId !== String(entityId || "")
    ) {
      state.detailReturnContext = null;
    }
    return runSimplePageTransition({
      update,
      targetViewId: detailView
    });
  }

  function restoreDetailReturnState(context) {
    if (!context) {
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    window.scrollTo({ top: context.scrollY, behavior: "auto" });
    if (context.backView === "mapView") {
      state.mapDossierOpen = context.mapDossierOpen;
      if (isMobileMapLayout()) {
        setMapPanel(context.mobileMapPanel, {
          snap: context.mapSheetSnap,
          motion: false
        });
      } else {
        setMapDossierOpen(context.mapDossierOpen);
      }
    }
  }

  function returnFromDetail(backView, options = {}) {
    const context = state.detailReturnContext?.backView === backView
      ? state.detailReturnContext
      : null;
    const update = () => {
      setActiveTab(backView, {
        updateHash: options.updateHash,
        preserveMapView: true
      });
      restoreDetailReturnState(context);
    };
    const focusReturnTarget = () => {
      const trigger = detailTransitionTrigger(context);
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      } else {
        const heading = document.querySelector(`#${CSS.escape(backView)} h1`);
        if (heading instanceof HTMLElement) {
          const hadTabIndex = heading.hasAttribute("tabindex");
          heading.setAttribute("tabindex", "-1");
          heading.focus({ preventScroll: true });
          if (!hadTabIndex) {
            heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
          }
        }
      }
      state.detailReturnContext = null;
    };

    return runSimplePageTransition({
      update,
      targetViewId: backView,
      after: focusReturnTarget
    });
  }

  function sessionKeyForView(viewId = currentPageViewId()) {
    return `${MOBILE_SESSION_KEY_PREFIX}${navigationViewFor(viewId)}`;
  }

  function readPageSessionState(viewId = currentPageViewId()) {
    try {
      const value = window.sessionStorage.getItem(sessionKeyForView(viewId));
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  }

  function saveCurrentSessionState() {
    const pageViewId = currentPageViewId();
    const snapshot = {
      version: 1,
      url: window.location.href,
      scrollY: Math.max(0, Math.round(window.scrollY)),
      dexFamilyFilter: state.dexFamilyFilter,
      dexVisibleCount: state.dexVisibleCount,
      airshowVisibleCount: state.airshowVisibleCount,
      airshowYearFilter: state.airshowYearFilter,
      squadronCountryFilter: state.squadronCountryFilter,
      squadronVisibleCount: state.squadronVisibleCount,
      statsSection: state.statsSection,
      selectedPinId: state.selectedPinId,
      selectedAircraftId: state.selectedAircraftId,
      selectedSquadronId: state.selectedSquadronId,
      selectedAirshowId: state.selectedAirshowId,
      mobileMapPanel: state.mobileMapPanel,
      mapSheetSnap: state.mapSheetSnap
    };
    try {
      window.sessionStorage.setItem(sessionKeyForView(pageViewId), JSON.stringify(snapshot));
    } catch (error) {
      // Session restoration is an enhancement; navigation remains usable without storage.
    }
  }

  function restoreSessionFilters(snapshot) {
    if (!snapshot || snapshot.version !== 1) {
      return;
    }
    state.dexFamilyFilter = normalizeAircraftFamily(snapshot.dexFamilyFilter) || "";
    state.dexVisibleCount = Math.max(MOBILE_ARCHIVE_PAGE_SIZE, Number(snapshot.dexVisibleCount) || MOBILE_ARCHIVE_PAGE_SIZE);
    state.airshowVisibleCount = Math.max(MOBILE_ARCHIVE_PAGE_SIZE, Number(snapshot.airshowVisibleCount) || MOBILE_ARCHIVE_PAGE_SIZE);
    state.airshowYearFilter = String(snapshot.airshowYearFilter || "");
    state.squadronCountryFilter = String(snapshot.squadronCountryFilter || "");
    state.squadronVisibleCount = Math.max(MOBILE_ARCHIVE_PAGE_SIZE, Number(snapshot.squadronVisibleCount) || MOBILE_ARCHIVE_PAGE_SIZE);
    state.statsSection = normalizeStatsSection(snapshot.statsSection);
  }

  function restoreSessionSelections(snapshot) {
    if (!snapshot || snapshot.version !== 1) {
      return;
    }
    if (snapshot.selectedPinId && state.pinById.has(snapshot.selectedPinId)) state.selectedPinId = snapshot.selectedPinId;
    if (snapshot.selectedAircraftId && state.aircraftById.has(snapshot.selectedAircraftId)) state.selectedAircraftId = snapshot.selectedAircraftId;
    if (snapshot.selectedSquadronId) state.selectedSquadronId = snapshot.selectedSquadronId;
    if (snapshot.selectedAirshowId && state.airshowById.has(snapshot.selectedAirshowId)) state.selectedAirshowId = snapshot.selectedAirshowId;
    if (snapshot.mapSheetSnap === "expanded" || snapshot.mapSheetSnap === "compact") state.mapSheetSnap = snapshot.mapSheetSnap;
  }

  function restoreSessionScroll(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !snapshot.url) {
      return;
    }
    let savedUrl;
    try {
      savedUrl = new URL(snapshot.url);
    } catch (error) {
      return;
    }
    if (savedUrl.origin !== window.location.origin || savedUrl.pathname !== window.location.pathname || savedUrl.hash !== window.location.hash) {
      return;
    }
    if (currentPageViewId() === "mapView" && (snapshot.mobileMapPanel === "locations" || snapshot.mobileMapPanel === "results")) {
      setMapPanel(snapshot.mobileMapPanel, { snap: snapshot.mapSheetSnap });
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.scrollTo({ top: Number(snapshot.scrollY) || 0, behavior: "auto" })));
  }

  function handleMobileTabNavigation(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) {
      return;
    }
    const link = event.currentTarget;
    const targetView = link.dataset.mobileTabView;
    if (!targetView) {
      return;
    }
    const activeView = document.querySelector("[data-view].is-active")?.id || currentPageViewId();
    if (navigationViewFor(activeView) === targetView) {
      event.preventDefault();
      if (activeView !== targetView) {
        handleMobileContextBack();
      } else {
        window.scrollTo({ top: 0, behavior: isReducedMotion() ? "auto" : "smooth" });
      }
      return;
    }
    saveCurrentSessionState();
    const saved = readPageSessionState(targetView);
    let destination = new URL(link.getAttribute("href"), document.baseURI);
    if (saved?.url) {
      try {
        const savedUrl = new URL(saved.url);
        const expectedPath = new URL(pageRouteForView(targetView), document.baseURI).pathname;
        if (savedUrl.origin === window.location.origin && savedUrl.pathname === expectedPath) {
          destination = savedUrl;
        }
      } catch (error) {
        // Use the tab's root URL when saved session data is malformed.
      }
    }
    link.href = destination.href;
  }

  function handleMobileContextBack() {
    const activeView = document.querySelector("[data-view].is-active")?.id;
    const collectionView = navigationViewFor(activeView);
    if (activeView === collectionView) {
      return;
    }
    const detailKinds = {
      aircraftDetailView: "aircraft",
      squadronDetailView: "squadron",
      airshowDetailView: "airshow",
      locationDetailView: "location"
    };
    if (window.history.state?.spotterdexKind === detailKinds[activeView]) {
      window.history.back();
      return;
    }
    returnFromDetail(collectionView, { updateHash: false });
    clearDeepLink({ replace: true });
  }

  function handleMapDirectInteraction() {
    if (!isFocusedMobileLayout()) {
      return;
    }
    if (state.mobileMapPanel === "locations") {
      setMapPanel(null);
    } else if (state.mobileMapPanel === "results" && state.mapSheetSnap === "expanded") {
      setMapPanel("results", { snap: "compact" });
    }
  }

  function scheduleScrollEdgeUpdate() {
    if (state.scrollEdgeFrame) {
      return;
    }
    state.scrollEdgeFrame = window.requestAnimationFrame(() => {
      state.scrollEdgeFrame = 0;
      updateScrollEdgeStates();
    });
  }

  function updateScrollEdgeStates() {
    const root = document.documentElement;
    const scrollTop = window.scrollY || root.scrollTop || 0;
    const pageRemaining = root.scrollHeight - (scrollTop + window.innerHeight);
    document.body.classList.toggle("has-page-scroll-above", scrollTop > 4);
    document.body.classList.toggle("has-page-scroll-below", pageRemaining > 4);

    document.querySelectorAll("#mapControlPanel, #mapResults, #viewerInfo").forEach((element) => {
      const overflow = element.scrollHeight > element.clientHeight + 1;
      element.classList.toggle("has-scroll-above", overflow && element.scrollTop > 4);
      element.classList.toggle(
        "has-scroll-below",
        overflow && element.scrollTop + element.clientHeight < element.scrollHeight - 4
      );
    });

    document.querySelectorAll("#viewerFilmstrip, #dexFamilyFilter, #squadronCountryRail, .dex-family-options, .squadron-country-nav").forEach((element) => {
      const overflow = element.scrollWidth > element.clientWidth + 1;
      element.classList.toggle("has-scroll-before", overflow && element.scrollLeft > 4);
      element.classList.toggle(
        "has-scroll-after",
        overflow && element.scrollLeft + element.clientWidth < element.scrollWidth - 4
      );
    });
  }

  function updateMobileAppChrome() {
    const activeView = document.querySelector("[data-view].is-active")?.id || currentPageViewId();
    const navigationView = navigationViewFor(activeView);
    const detailTitles = {
      aircraftDetailView: state.aircraftById.get(state.selectedAircraftId)?.typeName,
      squadronDetailView: collectSquadrons().find((item) => item.id === state.selectedSquadronId)?.name,
      airshowDetailView: state.airshowById.get(state.selectedAirshowId)?.name,
      locationDetailView: state.pinById.get(state.selectedPinId)?.name
    };
    const isDetail = activeView !== navigationView && Boolean(detailTitles[activeView]);
    els.siteHeader?.classList.toggle("is-contextual", isDetail);
    if (els.mobileGlobalSearchTrigger) {
      els.mobileGlobalSearchTrigger.hidden = isDetail;
    }
    const headerMapButton = document.getElementById("fitPinsButton");
    if (headerMapButton) {
      const label = activeView === "locationDetailView" ? "Back to World Map" : "Fit all map locations";
      headerMapButton.setAttribute("aria-label", label);
      headerMapButton.title = label;
    }
    if (els.mobileContextBar) els.mobileContextBar.hidden = !isDetail;
    if (els.mobileContextTitle) els.mobileContextTitle.textContent = detailTitles[activeView] || "SpotterDex";
    if (els.mobileContextBack) {
      const labels = { mapView: "World Map", dexView: "Aircraft Dex", squadronsView: "Squadrons", airshowsView: "Airshows" };
      els.mobileContextBack.setAttribute("aria-label", `Back to ${labels[navigationView] || "collection"}`);
    }
    els.mobileTabLinks?.forEach((link) => {
      const active = link.dataset.mobileTabView === navigationView;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function handleHeaderMapButton() {
    if (document.querySelector("[data-view].is-active")?.id === "locationDetailView") {
      goToMapHome();
      return;
    }
    fitMapToPins();
  }

  function isIosSafariBrowser() {
    const userAgent = navigator.userAgent || "";
    const isIosDevice = /iPad|iPhone|iPod/i.test(userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isWebKit = /WebKit/i.test(userAgent);
    const isSafari = /Version\/[^ ]+.*Safari/i.test(userAgent);
    const isExcludedBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Ddg|GSA|FBAN|FBAV|Instagram|Line|MicroMessenger|LinkedInApp|Twitter|Snapchat|Pinterest/i
      .test(userAgent);
    return isIosDevice && isWebKit && isSafari && !isExcludedBrowser;
  }

  function isStandaloneWebApp() {
    return navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: fullscreen)").matches;
  }

  function recordIosInstallHintVisit() {
    if (state.iosInstallHintVisitRecorded) {
      return state.iosInstallHintVisitCount;
    }
    state.iosInstallHintVisitRecorded = true;
    let nextCount = 1;
    try {
      const previous = Number.parseInt(window.localStorage.getItem(IOS_INSTALL_HINT_VISITS_STORAGE_KEY) || "0", 10);
      nextCount = Math.max(0, Number.isFinite(previous) ? previous : 0) + 1;
      window.localStorage.setItem(IOS_INSTALL_HINT_VISITS_STORAGE_KEY, String(nextCount));
    } catch (error) {
      // A meaningful interaction can still reveal the in-memory hint when
      // private browsing or storage policy makes visit persistence unavailable.
    }
    state.iosInstallHintVisitCount = nextCount;
    return nextCount;
  }

  function hasDismissedIosInstallHint() {
    if (state.iosInstallHintDismissed) {
      return true;
    }
    try {
      return window.localStorage.getItem(IOS_INSTALL_HINT_DISMISSED_STORAGE_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function syncIosInstallHintVisibility() {
    if (!els.iosInstallHint) {
      return;
    }
    const isSuppressed = isGlobalSearchOpen()
      || isViewerOpen()
      || els.appUpdatePrompt?.hidden === false;
    els.iosInstallHint.hidden = !state.iosInstallHintEligible || isSuppressed;
  }

  function maybeShowIosInstallHint(options = {}) {
    const hasMeaningfulInteraction = options.meaningfulInteraction === true;
    const meetsTiming = state.iosInstallHintVisitCount >= 2 || hasMeaningfulInteraction;
    state.iosInstallHintEligible = Boolean(
      isIosSafariBrowser()
      && !isStandaloneWebApp()
      && !hasDismissedIosInstallHint()
      && (state.iosInstallHintEligible || meetsTiming)
    );
    syncIosInstallHintVisibility();
  }

  function noteMeaningfulIosInstallInteraction() {
    maybeShowIosInstallHint({ meaningfulInteraction: true });
  }

  function dismissIosInstallHint() {
    state.iosInstallHintDismissed = true;
    state.iosInstallHintEligible = false;
    syncIosInstallHintVisibility();
    try {
      window.localStorage.setItem(IOS_INSTALL_HINT_DISMISSED_STORAGE_KEY, "1");
    } catch (error) {
      // The dismissal remains effective for this document when storage fails.
    }
  }

  function handleInstallPrompt(event) {
    event.preventDefault();
    state.installPromptEvent = event;
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(INSTALL_DISMISSED_STORAGE_KEY) === "1";
    } catch (error) {
      dismissed = false;
    }
    if (!dismissed && els.mobileInstallPrompt && els.appUpdatePrompt?.hidden !== false) {
      els.mobileInstallPrompt.hidden = false;
    }
  }

  async function installSpotterDex() {
    const promptEvent = state.installPromptEvent;
    if (!promptEvent) {
      return;
    }
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    state.installPromptEvent = null;
    if (els.mobileInstallPrompt) els.mobileInstallPrompt.hidden = true;
    showToast(choice.outcome === "accepted" ? "Installing SpotterDex" : "Install cancelled");
  }

  function dismissInstallPrompt() {
    if (els.mobileInstallPrompt) els.mobileInstallPrompt.hidden = true;
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_STORAGE_KEY, "1");
    } catch (error) {
      // Dismissal remains effective for the current page when storage is unavailable.
    }
  }

  function updateConnectivityUi(options = {}) {
    const offline = typeof options.offline === "boolean" ? options.offline : !navigator.onLine;
    state.connectivityOffline = offline;
    document.body.classList.toggle("is-offline", offline);
    if (els.mobileConnectivity) {
      els.mobileConnectivity.hidden = !offline;
    }
    if (els.mapFallback) {
      if (offline) {
        els.mapFallback.hidden = false;
      } else if (state.map) {
        els.mapFallback.hidden = true;
        refreshMapLayout();
      }
    }
    updatePhotoMediaFallbackCopy();
    if (!offline) {
      retryUnavailablePhotoMedia();
    }
    scheduleOfflineMediaCoverageRefresh();
    if (options.announce !== false) {
      showToast(offline ? "Offline · cached catalog available" : "Back online");
    }
  }

  function photoMediaFallbackCopy() {
    return state.connectivityOffline
      ? { kicker: "Not cached", hint: "Reconnect to load this photo." }
      : { kicker: "Photo unavailable", hint: "Try again when the connection is stable." };
  }

  function renderPhotoMediaFallback(photo, label = "") {
    const copy = photoMediaFallbackCopy();
    const subject = photo ? photoSubjectLabel(photo) : label || "Aviation photo";
    const metadata = photo
      ? [photoContextLabel(photo), displayPhotoDate(photo)].filter(Boolean).join(" · ")
      : "SpotterDex photo";
    return `
      <span class="photo-media-fallback" data-photo-media-fallback role="img" aria-label="${escapeAttr(`${copy.kicker}. ${subject}. ${metadata}. ${copy.hint}`)}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 18V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12"></path>
          <path d="m4 16 4.5-4.5 3 3 2-2L20 19H5a1 1 0 0 1-1-1Z"></path>
          <circle cx="15.5" cy="8.5" r="1.5"></circle>
        </svg>
        <span class="photo-media-fallback-kicker">${escapeHtml(copy.kicker)}</span>
        <strong>${escapeHtml(subject)}</strong>
        <span class="photo-media-fallback-meta">${escapeHtml(metadata)}</span>
        <small class="photo-media-fallback-hint">${escapeHtml(copy.hint)}</small>
      </span>
    `;
  }

  function photoMediaSurface(image) {
    return image.closest(
      ".photo-card, .detail-hero, .airshow-story-scene, .airshow-story-carousel-frame, .viewer-image-frame"
    );
  }

  function handlePhotoMediaError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.dataset.photoMedia) {
      return;
    }
    const surface = photoMediaSurface(image);
    if (!surface) {
      image.hidden = true;
      return;
    }
    const photo = state.photoById?.get(image.dataset.photoId) || null;
    image.hidden = true;
    image.dataset.mediaUnavailable = "true";
    surface.classList.add("is-media-unavailable");
    if (!surface.querySelector("[data-photo-media-fallback]")) {
      surface.insertAdjacentHTML("beforeend", renderPhotoMediaFallback(photo, image.alt));
    }
    if (surface.matches(".photo-card")) {
      if (!surface.dataset.originalAriaLabel) {
        surface.dataset.originalAriaLabel = surface.getAttribute("aria-label") || "";
      }
      const copy = photoMediaFallbackCopy();
      const subject = photo ? photoSubjectLabel(photo) : image.alt || "Photo";
      surface.setAttribute("aria-label", `${copy.kicker}. ${subject}. ${copy.hint}`);
    }
  }

  function handlePhotoMediaLoad(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.dataset.photoMedia) {
      return;
    }
    image.hidden = false;
    delete image.dataset.mediaUnavailable;
    const surface = photoMediaSurface(image);
    if (!surface) {
      return;
    }
    const unavailable = Array.from(surface.querySelectorAll("img[data-photo-media]"))
      .some((candidate) => candidate.dataset.mediaUnavailable === "true");
    if (!unavailable) {
      surface.classList.remove("is-media-unavailable");
      surface.querySelector("[data-photo-media-fallback]")?.remove();
      if (surface.dataset.originalAriaLabel !== undefined) {
        const originalLabel = surface.dataset.originalAriaLabel;
        if (originalLabel) surface.setAttribute("aria-label", originalLabel);
        else surface.removeAttribute("aria-label");
        delete surface.dataset.originalAriaLabel;
      }
    }
  }

  function updatePhotoMediaFallbackCopy() {
    const copy = photoMediaFallbackCopy();
    document.querySelectorAll("[data-photo-media-fallback]").forEach((fallback) => {
      const kicker = fallback.querySelector(".photo-media-fallback-kicker");
      const hint = fallback.querySelector(".photo-media-fallback-hint");
      if (kicker) kicker.textContent = copy.kicker;
      if (hint) hint.textContent = copy.hint;
      const subject = fallback.querySelector("strong")?.textContent || "Aviation photo";
      const metadata = fallback.querySelector(".photo-media-fallback-meta")?.textContent || "";
      fallback.setAttribute("aria-label", [copy.kicker, subject, metadata, copy.hint].filter(Boolean).join(". "));
    });
  }

  function retryUnavailablePhotoMedia() {
    const images = Array.from(document.querySelectorAll('img[data-media-unavailable="true"]'));
    if (!images.length) {
      return;
    }
    images.forEach((image) => {
      const source = image.getAttribute("src");
      image.hidden = false;
      if (source) image.removeAttribute("src");
      window.requestAnimationFrame(() => {
        if (source) image.setAttribute("src", source);
      });
    });
  }

  function renderOfflineMediaCoverage() {
    return `
      <aside class="offline-media-coverage" data-offline-media-coverage role="status" aria-live="polite" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6.5 18.5h11a3.5 3.5 0 0 0 .8-6.9A6.5 6.5 0 0 0 5.7 10a4.3 4.3 0 0 0 .8 8.5Z"></path>
          <path d="m9 13 6 6M15 13l-6 6"></path>
        </svg>
        <span>
          <strong data-offline-media-count>Checking saved photos…</strong>
          <small data-offline-media-hint>Only previously viewed media is available without a connection.</small>
        </span>
      </aside>
    `;
  }

  function activeDetailPhotosForOffline() {
    const activeView = document.querySelector("[data-view].is-active")?.id;
    if (activeView === "aircraftDetailView") {
      const aircraft = state.aircraftById?.get(state.selectedAircraftId);
      return aircraft ? photosForAircraft(aircraft) : [];
    }
    if (activeView === "squadronDetailView") {
      const squadron = collectSquadrons().find((item) => item.id === state.selectedSquadronId);
      return squadron ? photosForSquadronRecord(squadron) : [];
    }
    if (activeView === "locationDetailView") {
      const pin = state.pinById?.get(state.selectedPinId);
      return pin ? photosForPin(pin) : [];
    }
    if (activeView === "airshowDetailView") {
      const airshow = previewAirshow(state.airshowById?.get(state.selectedAirshowId));
      return airshow ? photosForAirshow(airshow) : [];
    }
    return [];
  }

  function photoMediaSources(photo) {
    return unique([photo?.thumbnail, photo?.image].filter(Boolean));
  }

  async function photoIsCachedForOffline(photo) {
    if (!("caches" in window)) {
      return document.querySelector(`img[data-photo-id="${CSS.escape(photo.id)}"]`)?.naturalWidth > 0;
    }
    for (const source of photoMediaSources(photo)) {
      try {
        const response = await window.caches.match(new URL(source, document.baseURI).href);
        if (response) {
          return true;
        }
      } catch (error) {
        console.warn("Could not inspect offline photo cache", error);
        return false;
      }
    }
    return false;
  }

  async function refreshOfflineMediaCoverage() {
    const panel = document.querySelector("[data-view].is-active [data-offline-media-coverage]");
    if (!panel) {
      return;
    }
    if (!state.connectivityOffline) {
      panel.hidden = true;
      return;
    }

    const photos = Array.from(
      new Map(activeDetailPhotosForOffline().map((photo) => [photo.id, photo])).values()
    );
    const token = ++state.offlineMediaCoverageToken;
    const count = panel.querySelector("[data-offline-media-count]");
    const hint = panel.querySelector("[data-offline-media-hint]");
    panel.hidden = false;
    if (count) count.textContent = "Checking saved photos…";
    if (hint) hint.textContent = "Only previously viewed media is available without a connection.";
    const availability = await Promise.all(photos.map((photo) => photoIsCachedForOffline(photo)));
    if (token !== state.offlineMediaCoverageToken || !panel.isConnected || !state.connectivityOffline) {
      return;
    }
    const available = availability.filter(Boolean).length;
    const total = photos.length;
    if (count) count.textContent = `${available} of ${total} photo${total === 1 ? "" : "s"} available offline`;
    if (hint) {
      hint.textContent = available === total
        ? "This field guide is ready to browse without a connection."
        : `Reconnect to load the remaining ${total - available} photo${total - available === 1 ? "" : "s"}.`;
    }
  }

  function scheduleOfflineMediaCoverageRefresh() {
    window.cancelAnimationFrame(state.offlineMediaRefreshFrame);
    state.offlineMediaRefreshFrame = window.requestAnimationFrame(() => {
      refreshOfflineMediaCoverage().catch((error) => console.warn("Could not update offline media coverage", error));
    });
  }

  function showToast(message) {
    if (!els.appToast || !message) {
      return;
    }
    window.clearTimeout(state.toastTimer);
    els.appToast.textContent = message;
    els.appToast.hidden = false;
    window.requestAnimationFrame(() => {
      els.appToast?.classList.add("is-visible");
    });
    state.toastTimer = window.setTimeout(() => {
      els.appToast.classList.remove("is-visible");
      state.toastTimer = window.setTimeout(() => {
        if (!els.appToast.classList.contains("is-visible")) {
          els.appToast.hidden = true;
        }
      }, 180);
    }, 2400);
  }

  function isIosPwa() {
    const standalone = window.navigator.standalone === true
      || Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches);
    if (!standalone) {
      return false;
    }
    const userAgent = String(window.navigator.userAgent || "");
    const isIosUserAgent = /iPad|iPhone|iPod/.test(userAgent);
    const isIpadDesktopUserAgent = window.navigator.platform === "MacIntel"
      && Number(window.navigator.maxTouchPoints || 0) > 1;
    return isIosUserAgent || isIpadDesktopUserAgent;
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || (window.location.protocol !== "https:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1")) {
      return;
    }
    state.serviceWorkerHadController = Boolean(navigator.serviceWorker.controller);
    setupServiceWorkerUpdateEvents();
    try {
      const registration = await navigator.serviceWorker.register(new URL("service-worker.js", document.baseURI), {
        scope: new URL("./", document.baseURI).pathname
      });
      state.serviceWorkerRegistration = registration;
      if (registration.waiting && state.serviceWorkerHadController) {
        handleWaitingServiceWorker(registration.waiting);
      }
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) {
          return;
        }
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && state.serviceWorkerHadController) {
            handleWaitingServiceWorker(registration.waiting || installing);
          }
        });
      });
      checkForServiceWorkerUpdate({ force: true });
    } catch (error) {
      console.warn("SpotterDex service worker registration failed", error);
    }
  }

  function setupServiceWorkerUpdateEvents() {
    if (serviceWorkerEventsBound) {
      return;
    }
    serviceWorkerEventsBound = true;
    navigator.serviceWorker.addEventListener("controllerchange", handleServiceWorkerControllerChange);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        checkForServiceWorkerUpdate();
      }
    });
    window.addEventListener("focus", () => checkForServiceWorkerUpdate());
  }

  async function checkForServiceWorkerUpdate(options = {}) {
    const registration = state.serviceWorkerRegistration;
    if (!registration) {
      return;
    }
    const now = Date.now();
    if (!options.force && now - state.updateCheckTime < 60000) {
      return;
    }
    state.updateCheckTime = now;
    try {
      await registration.update();
      if (registration.waiting && state.serviceWorkerHadController) {
        await handleWaitingServiceWorker(registration.waiting);
      }
    } catch (error) {
      // Update checks are opportunistic and expected to fail while offline.
    }
  }

  async function handleWaitingServiceWorker(worker) {
    if (!worker) {
      return;
    }
    if (isIosPwa()) {
      await presentServiceWorkerUpdate(worker);
      return;
    }
    // Browser tabs should never make the user manage a service-worker update.
    // Activating here lets controllerchange reload the page onto the new shell.
    activateWaitingServiceWorker(worker);
  }

  function activateWaitingServiceWorker(worker) {
    if (!worker || state.updateReloadPending) {
      return;
    }
    state.waitingServiceWorker = worker;
    state.updateReloadPending = true;
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch (error) {
      state.updateReloadPending = false;
      // A browser update is best-effort; the next registration check can retry.
    }
  }

  function serviceWorkerVersion(worker) {
    if (!worker || typeof MessageChannel === "undefined") {
      return Promise.resolve("");
    }
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (version = "") => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(String(version || ""));
      };
      const timeout = window.setTimeout(() => finish(""), 1500);
      channel.port1.onmessage = (event) => finish(event.data?.version);
      try {
        worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
      } catch (error) {
        finish("");
      }
    });
  }

  async function presentServiceWorkerUpdate(worker, options = {}) {
    if (!worker || !els.appUpdatePrompt || !isIosPwa()) {
      return;
    }
    const version = await serviceWorkerVersion(worker);
    // iOS standalone has no reliable background refresh UI of its own, so keep
    // this prompt eligible on every launch/check instead of remembering Later.
    state.waitingServiceWorker = worker;
    state.updateVersion = version;
    state.updateRequiresReloadOnly = options.requiresReload === true;
    if (els.mobileInstallPrompt) {
      els.mobileInstallPrompt.hidden = true;
    }
    els.appUpdateButton.disabled = false;
    els.appUpdateButton.textContent = state.updateRequiresReloadOnly ? "Reload" : "Update";
    els.appUpdatePrompt.hidden = false;
    document.body.classList.add("has-app-update");
    syncIosInstallHintVisibility();
  }

  function dismissAppUpdate() {
    if (!els.appUpdatePrompt) {
      return;
    }
    els.appUpdatePrompt.hidden = true;
    document.body.classList.remove("has-app-update");
    syncIosInstallHintVisibility();
    // “Later” only dismisses this presentation. The next foreground check in
    // the iOS app shell should be allowed to bring the prompt back.
    state.updateCheckTime = 0;
  }

  function applyAppUpdate() {
    if (state.updateRequiresReloadOnly) {
      window.location.reload();
      return;
    }
    const worker = state.serviceWorkerRegistration?.waiting || state.waitingServiceWorker;
    if (!worker) {
      window.location.reload();
      return;
    }
    state.updateReloadPending = true;
    if (els.appUpdateButton) {
      els.appUpdateButton.disabled = true;
      els.appUpdateButton.textContent = "Updating…";
    }
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch (error) {
      state.updateReloadPending = false;
      if (els.appUpdateButton) {
        els.appUpdateButton.disabled = false;
        els.appUpdateButton.textContent = "Update";
      }
      showToast("Update is still preparing. Try again.");
      return;
    }
    window.setTimeout(() => {
      if (!state.updateReloadPending) {
        return;
      }
      state.updateReloadPending = false;
      if (els.appUpdateButton) {
        els.appUpdateButton.disabled = false;
        els.appUpdateButton.textContent = "Update";
      }
      showToast("Update is still preparing. Try again.");
    }, 6000);
  }

  function handleServiceWorkerControllerChange() {
    if (state.updateReloadPending) {
      state.updateReloadPending = false;
      window.location.reload();
      return;
    }
    const controller = navigator.serviceWorker.controller;
    if (state.serviceWorkerHadController && controller) {
      if (isIosPwa()) {
        presentServiceWorkerUpdate(controller, { requiresReload: true });
      } else {
        window.location.reload();
      }
    }
    state.serviceWorkerHadController = Boolean(controller);
  }

  function projectMotion(initialVelocity, decelerationRate = MOTION_DECELERATION_RATE) {
    return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
  }

  function rubberbandMotion(overshoot, dimension, constant = MOTION_RUBBERBAND_CONSTANT) {
    const distance = Math.max(1, dimension);
    return (overshoot * distance * constant) / (distance + constant * Math.abs(overshoot));
  }

  function motionControllerFor(element, apply) {
    let controller = motionControllers.get(element);
    if (!controller) {
      controller = {
        element,
        apply,
        value: 0,
        velocity: 0,
        target: 0,
        frame: 0,
        initialized: false,
        lastTime: 0
      };
      motionControllers.set(element, controller);
    }
    controller.apply = apply;
    return controller;
  }

  function setMotionValue(controller, value) {
    controller.value = Number.isFinite(value) ? value : 0;
    controller.apply(controller.value);
  }

  function stopMotion(controller) {
    if (!controller) {
      return;
    }
    window.cancelAnimationFrame(controller.frame);
    controller.frame = 0;
    controller.lastTime = 0;
    controller.element.classList.remove("is-motion-settling");
  }

  function settleMotion(controller, target, initialVelocity = controller.velocity, onComplete) {
    stopMotion(controller);
    controller.target = target;
    controller.velocity = Number.isFinite(initialVelocity) ? initialVelocity : 0;
    controller.element.classList.add("is-motion-settling");

    const complete = () => {
      setMotionValue(controller, target);
      controller.velocity = 0;
      controller.frame = 0;
      controller.lastTime = 0;
      controller.element.classList.remove("is-motion-settling");
      onComplete?.();
    };

    if (isReducedMotion()) {
      complete();
      return;
    }

    const angularFrequency = (2 * Math.PI) / MOTION_SPRING_RESPONSE;
    const stiffness = angularFrequency * angularFrequency;
    const damping = 2 * MOTION_SPRING_DAMPING * angularFrequency;
    const tick = (time) => {
      if (!controller.lastTime) {
        controller.lastTime = time;
      }
      const deltaTime = Math.min(0.032, Math.max(0.001, (time - controller.lastTime) / 1000));
      controller.lastTime = time;
      const acceleration = -stiffness * (controller.value - target) - damping * controller.velocity;
      controller.velocity += acceleration * deltaTime;
      setMotionValue(controller, controller.value + controller.velocity * deltaTime);
      if (
        Math.abs(controller.value - target) <= MOTION_POSITION_EPSILON
        && Math.abs(controller.velocity) <= MOTION_VELOCITY_EPSILON
      ) {
        complete();
        return;
      }
      controller.frame = window.requestAnimationFrame(tick);
    };
    controller.frame = window.requestAnimationFrame(tick);
  }

  function pushGestureSample(samples, position, time = performance.now()) {
    samples.push({ position, time });
    while (samples.length > GESTURE_SAMPLE_LIMIT || (samples[0] && time - samples[0].time > GESTURE_SAMPLE_WINDOW_MS)) {
      samples.shift();
    }
  }

  function gestureVelocity(samples) {
    if (samples.length < 2) {
      return 0;
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = (last.time - first.time) / 1000;
    return elapsed > 0 ? (last.position - first.position) / elapsed : 0;
  }

  function boundedMotionValue(value, minimum, maximum, dimension) {
    if (value < minimum) {
      return minimum + rubberbandMotion(value - minimum, dimension);
    }
    if (value > maximum) {
      return maximum + rubberbandMotion(value - maximum, dimension);
    }
    return value;
  }

  function sheetMotionDescriptor(surface) {
    if (!isFocusedMobileLayout()) {
      return null;
    }
    const landscapeViewer = surface === "viewer" && window.matchMedia("(orientation: landscape)").matches;
    const panel = surface === "locations"
      ? els.mapControlPanel
      : surface === "map"
        ? els.mapResults
        : surface === "viewer"
          ? els.viewerInfo
          : null;
    if (!panel) {
      return null;
    }
    const bounds = panel.getBoundingClientRect();
    if (surface === "locations") {
      const height = Math.max(1, bounds.height || panel.scrollHeight || window.innerHeight * 0.62);
      return {
        surface,
        panel,
        axis: "y",
        dimension: height,
        snaps: [
          { name: "closed", value: -(height + 12) },
          { name: "open", value: 0 }
        ]
      };
    }
    if (surface === "map") {
      const height = Math.max(1, bounds.height || window.innerHeight);
      const compactVisible = Math.min(height, Math.min(310, Math.max(224, window.innerHeight * 0.34)));
      return {
        surface,
        panel,
        axis: "y",
        dimension: height,
        snaps: [
          { name: "expanded", value: 0 },
          { name: "compact", value: Math.max(0, height - compactVisible) },
          { name: "closed", value: height + 92 }
        ]
      };
    }
    if (landscapeViewer) {
      const width = Math.max(1, bounds.width || Math.min(390, window.innerWidth * 0.54));
      return {
        surface,
        panel,
        axis: "x",
        dimension: width,
        snaps: [
          { name: "expanded", value: 0 },
          { name: "closed", value: width }
        ]
      };
    }
    const height = Math.max(1, bounds.height || Math.min(680, window.innerHeight * 0.7));
    const compactVisible = Math.min(height, Math.min(520, window.innerHeight * 0.44));
    return {
      surface,
      panel,
      axis: "y",
      dimension: height,
      snaps: [
        { name: "expanded", value: 0 },
        { name: "compact", value: Math.max(0, height - compactVisible) },
        { name: "closed", value: height }
      ]
    };
  }

  function sheetSnapForState(surface) {
    if (surface === "locations") {
      return state.mobileMapPanel === "locations" ? "open" : "closed";
    }
    if (surface === "map") {
      return state.mobileMapPanel === "results" ? state.mapSheetSnap : "closed";
    }
    if (surface === "viewer") {
      if (!state.viewerInfoOpen) {
        return "closed";
      }
      return window.matchMedia("(orientation: landscape)").matches ? "expanded" : state.viewerInfoSnap;
    }
    return "closed";
  }

  function sheetMotionController(descriptor, initialSnap = sheetSnapForState(descriptor.surface)) {
    const controller = motionControllerFor(descriptor.panel, (value) => {
      descriptor.panel.style.transform = descriptor.axis === "x"
        ? `translate3d(${value}px, 0, 0)`
        : `translate3d(0, ${value}px, 0)`;
    });
    if (!controller.initialized) {
      const initial = descriptor.snaps.find((snap) => snap.name === initialSnap) || descriptor.snaps[0];
      setMotionValue(controller, initial.value);
      controller.initialized = true;
    }
    return controller;
  }

  function moveSheetTo(surface, snapName, options = {}) {
    const descriptor = sheetMotionDescriptor(surface);
    if (!descriptor) {
      return;
    }
    const target = descriptor.snaps.find((snap) => snap.name === snapName) || descriptor.snaps[0];
    const controller = sheetMotionController(descriptor, options.fromSnap || snapName);
    if (options.fromSnap) {
      const from = descriptor.snaps.find((snap) => snap.name === options.fromSnap);
      if (from) {
        stopMotion(controller);
        setMotionValue(controller, from.value);
        controller.velocity = 0;
      }
    }
    if (snapName !== "closed") {
      descriptor.panel.classList.add("is-motion-presented");
    }
    const finish = () => {
      if (snapName === "closed") {
        descriptor.panel.classList.remove("is-motion-presented");
      }
      scheduleScrollEdgeUpdate();
      options.onComplete?.();
    };
    if (options.immediate) {
      stopMotion(controller);
      setMotionValue(controller, target.value);
      controller.velocity = 0;
      finish();
      return;
    }
    settleMotion(controller, target.value, options.velocity, finish);
  }

  function syncMotionSurfaceGeometry() {
    ["locations", "map", "viewer"].forEach((surface) => {
      const descriptor = sheetMotionDescriptor(surface);
      if (!descriptor) {
        const panel = surface === "locations" ? els.mapControlPanel : surface === "map" ? els.mapResults : els.viewerInfo;
        if (panel) {
          const controller = motionControllers.get(panel);
          stopMotion(controller);
          panel.style.removeProperty("transform");
          panel.classList.remove("is-motion-presented");
          if (controller) controller.initialized = false;
        }
        return;
      }
      const snapName = sheetSnapForState(surface);
      const snap = descriptor.snaps.find((entry) => entry.name === snapName) || descriptor.snaps[0];
      const controller = sheetMotionController(descriptor, snapName);
      stopMotion(controller);
      setMotionValue(controller, snap.value);
      controller.velocity = 0;
      descriptor.panel.classList.toggle("is-motion-presented", snapName !== "closed");
    });
  }

  function cancelGesturesForGeometryChange() {
    const sheetDrag = state.sheetDrag;
    if (sheetDrag) {
      sheetDrag.descriptor.panel.classList.remove("is-sheet-dragging");
      if (sheetDrag.handle.hasPointerCapture?.(sheetDrag.pointerId)) {
        sheetDrag.handle.releasePointerCapture(sheetDrag.pointerId);
      }
      state.sheetDrag = null;
    }
    const carouselPointerId = state.viewerCarouselDrag?.pointerId;
    if (carouselPointerId != null && els.viewerCarouselTrack?.hasPointerCapture?.(carouselPointerId)) {
      els.viewerCarouselTrack.releasePointerCapture(carouselPointerId);
    }
    state.viewerPointers.clear();
    state.viewerDragOrigin = null;
    state.viewerPinchStart = null;
    state.viewerCarouselDrag = null;
    els.viewerCarouselTrack?.classList.remove("is-carousel-dragging");
    els.viewerImage?.classList.remove("is-dragging");
  }

  function toggleSheetSnap(kind) {
    if (kind === "map" && state.mobileMapPanel === "results") {
      setMapPanel("results", { snap: state.mapSheetSnap === "expanded" ? "compact" : "expanded" });
      return;
    }
    if (kind === "viewer" && state.viewerInfoOpen) {
      setViewerInfoOpen(true, { snap: state.viewerInfoSnap === "expanded" ? "compact" : "expanded" });
    }
  }

  function handleSheetPointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    const topDrawerHandle = target?.closest(".mobile-map-location-card");
    const handle = topDrawerHandle || target?.closest("[data-sheet-handle]");
    if (!handle || event.button !== 0) {
      return;
    }
    const surface = topDrawerHandle ? "locations" : handle.dataset.sheetHandle === "map" ? "map" : "viewer";
    if ((surface !== "viewer" && !isFocusedMobileLayout()) || (surface === "viewer" && !isMobileViewerLayout())) {
      return;
    }
    if ((surface === "map" && state.mobileMapPanel !== "results") || (surface === "viewer" && !state.viewerInfoOpen)) {
      return;
    }
    const descriptor = sheetMotionDescriptor(surface);
    if (!descriptor) return;
    const originalSnap = sheetSnapForState(surface);
    const controller = sheetMotionController(descriptor, originalSnap);
    stopMotion(controller);
    if (surface === "locations") descriptor.panel.classList.add("is-motion-presented");
    const primary = descriptor.axis === "x" ? event.clientX : event.clientY;
    state.sheetDrag = {
      surface,
      handle,
      descriptor,
      controller,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startValue: controller.value,
      originalSnap,
      samples: [{ position: primary, time: performance.now() }],
      moved: false,
      rejected: false
    };
    handle.setPointerCapture?.(event.pointerId);
  }

  function detailPhotoRailForTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    return target.closest(
      ".detail-view .photo-groups:not(.is-single-group) > section .photo-grid, "
      + ".detail-view .aircraft-type-photo-groups:not(.is-single-group) > section .photo-grid, "
      + ".detail-view .airshow-squadron-groups:not(.is-single-group) > section .photo-grid, "
      + ".detail-view .location-specific-photo-section.has-other-sections .photo-grid, "
      + ".detail-view .squadron-specific-photo-section.has-other-sections .photo-grid"
    );
  }

  function handleDetailRailPointerDown(event) {
    if (event.pointerType !== "mouse" || event.button !== 0 || !isFocusedMobileLayout()) {
      return;
    }
    const rail = detailPhotoRailForTarget(event.target);
    if (!rail || rail.scrollWidth <= rail.clientWidth + 1) {
      return;
    }
    state.detailRailDrag = {
      rail,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: rail.scrollLeft,
      moved: false
    };
  }

  function handleDetailRailPointerMove(event) {
    const drag = state.detailRailDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(deltaX) < 5) {
      return;
    }
    if (!drag.moved && Math.abs(deltaY) > Math.abs(deltaX)) {
      handleDetailRailPointerUp(event);
      return;
    }
    drag.moved = true;
    drag.rail.setPointerCapture?.(event.pointerId);
    drag.rail.classList.add("is-mouse-dragging");
    drag.rail.scrollLeft = drag.startScrollLeft - deltaX;
    event.preventDefault();
  }

  function handleDetailRailPointerUp(event) {
    const drag = state.detailRailDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    drag.rail.classList.remove("is-mouse-dragging");
    if (drag.rail.hasPointerCapture?.(event.pointerId)) {
      drag.rail.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      state.suppressDetailRailClickUntil = performance.now() + 250;
    }
    state.detailRailDrag = null;
  }

  function suppressDetailRailClick(event) {
    if (performance.now() > state.suppressDetailRailClickUntil || !detailPhotoRailForTarget(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function handleSheetPointerMove(event) {
    const drag = state.sheetDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const primaryDelta = drag.descriptor.axis === "x" ? deltaX : deltaY;
    const crossDelta = drag.descriptor.axis === "x" ? deltaY : deltaX;
    if (!drag.moved && !drag.rejected) {
      const primaryDistance = Math.abs(primaryDelta);
      const crossDistance = Math.abs(crossDelta);
      if (primaryDistance < GESTURE_INTENT_DISTANCE && crossDistance < GESTURE_INTENT_DISTANCE) {
        return;
      }
      if (primaryDistance >= crossDistance * GESTURE_AXIS_DOMINANCE) {
        drag.moved = true;
        if (drag.surface === "locations" && state.mobileMapPanel === "results") {
          setMapPanel(null);
        }
        drag.handle.dataset.dragged = "true";
        drag.descriptor.panel.classList.add("is-sheet-dragging");
      } else if (crossDistance >= primaryDistance * GESTURE_AXIS_DOMINANCE) {
        drag.rejected = true;
        drag.handle.dataset.dragged = "true";
        if (drag.surface === "locations") {
          state.suppressMapLocationClickUntil = performance.now() + 350;
        }
      } else {
        return;
      }
    }
    if (!drag.moved || drag.rejected) {
      return;
    }
    event.preventDefault();
    const values = drag.descriptor.snaps.map((snap) => snap.value);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const nextValue = boundedMotionValue(
      drag.startValue + primaryDelta,
      minimum,
      maximum,
      drag.descriptor.dimension
    );
    setMotionValue(drag.controller, nextValue);
    pushGestureSample(
      drag.samples,
      drag.descriptor.axis === "x" ? event.clientX : event.clientY,
      performance.now()
    );
  }

  function handleSheetPointerUp(event) {
    const drag = state.sheetDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const cancelled = event.type === "pointercancel";
    if (drag.moved && !cancelled) {
      pushGestureSample(
        drag.samples,
        drag.descriptor.axis === "x" ? event.clientX : event.clientY,
        performance.now()
      );
    }
    const velocity = cancelled ? 0 : gestureVelocity(drag.samples);
    drag.descriptor.panel.classList.remove("is-sheet-dragging");
    drag.handle.releasePointerCapture?.(event.pointerId);
    state.sheetDrag = null;
    if (!drag.moved || drag.rejected) {
      if (drag.surface === "locations" && drag.originalSnap === "closed") {
        drag.descriptor.panel.classList.remove("is-motion-presented");
      }
      return;
    }
    drag.handle.dataset.dragged = "true";
    if (drag.surface === "locations") {
      state.suppressMapLocationClickUntil = performance.now() + 350;
    }
    const projected = drag.controller.value + (cancelled ? 0 : projectMotion(velocity));
    const target = cancelled
      ? drag.descriptor.snaps.find((snap) => snap.name === drag.originalSnap)
      : drag.descriptor.snaps.reduce((nearest, snap) => (
          Math.abs(snap.value - projected) < Math.abs(nearest.value - projected) ? snap : nearest
        ));
    if (!target) return;

    if (drag.surface === "locations") {
      setMapPanel(target.name === "closed" ? null : "locations", { motion: false });
    } else if (drag.surface === "map") {
      setMapPanel(target.name === "closed" ? null : "results", { snap: target.name, motion: false });
    } else {
      setViewerInfoOpen(target.name !== "closed", { snap: target.name, motion: false });
    }
    moveSheetTo(drag.surface, target.name, { velocity });
  }

  function setActiveTab(viewId, options = {}) {
    if (!document.getElementById(viewId)) {
      navigateToViewPage(viewId);
      return false;
    }
    if (viewId !== "airshowDetailView" && typeof destroyAirshowStory === "function") {
      destroyAirshowStory();
    }
    if (viewId !== "squadronsView") {
      disconnectSquadronCountryObserver();
    }
    const activeBefore = document.querySelector("[data-view].is-active");
    const navigationViewId = navigationViewFor(viewId);
    document.querySelectorAll("[data-view]").forEach((view) => {
      const isActive = view.id === viewId;
      view.hidden = !isActive;
      view.classList.toggle("is-active", isActive);
    });
    document.body.classList.toggle("is-map-canvas-active", viewId === "mapView");

    if (els.viewSelect) {
      els.viewSelect.value = pageRouteForView(navigationViewId);
    }

    ensureViewRendered(viewId);
    if (viewId === "statsView") {
      updateStatsSectionNav();
    } else if (viewId === "squadronsView") {
      window.requestAnimationFrame(observeSquadronCountrySections);
    }
    updateMapPanelCoach();
    updateMobileAppChrome();

    if (options.updateHash !== false && !state.isApplyingHash) {
      updateDeepLinkForView(viewId);
    }

    if (viewId === "mapView") {
      window.requestAnimationFrame(() => {
        if (state.map) {
          refreshMapLayout();
          if (!options.preserveMapView && (!activeBefore || activeBefore.id !== viewId)) {
            fitMapToPins();
          }
        }
      });
    }

    updateShareMetadata();
    return true;
  }

  function navigationViewFor(viewId) {
    if (viewId === "aircraftDetailView") {
      return "dexView";
    }
    if (viewId === "squadronDetailView") {
      return "squadronsView";
    }
    if (viewId === "locationDetailView") {
      return "mapView";
    }
    if (viewId === "airshowDetailView") {
      return "airshowsView";
    }
    return viewId;
  }

  function updateShareMetadata() {
    const activeView = document.querySelector("[data-view].is-active")?.id;
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const activePhoto = state.photoById?.get(hashParams.get("photo"));
    const pageDefaults = {
      mapView: {
        title: "SpotterDex - Timothy's Logbook",
        description: "An aircraft spotting logbook and aviation photography field guide."
      },
      dexView: {
        title: "Aircraft Dex | SpotterDex",
        description: "Browse the SpotterDex visual field guide by aircraft type, operator, and location."
      },
      squadronsView: {
        title: "Squadrons | SpotterDex",
        description: "Browse squadron insignia, aircraft, and photographic records in SpotterDex."
      },
      airshowsView: {
        title: "Airshows | SpotterDex",
        description: "Browse SpotterDex airshow field reports and event photography."
      },
      statsView: {
        title: "Stats | SpotterDex",
        description: "Explore collection totals and camera metadata from the SpotterDex archive."
      }
    };
    const pageDefault = pageDefaults[currentPageViewId()] || pageDefaults.mapView;
    const defaultTitle = pageDefault.title;
    const defaultDescription = pageDefault.description;
    const defaultImage = "assets/generated/photos/location-hero-gifu-air-base.jpg";
    let title = defaultTitle;
    let description = defaultDescription;
    let image = defaultImage;
    let imageAlt = DEFAULT_SHARE_IMAGE_ALT;

    if (activePhoto) {
      title = `${activePhoto.title || photoSubjectLabel(activePhoto)} | SpotterDex`;
      description = activePhoto.caption || `${photoSubjectLabel(activePhoto)} photographed at ${activePhoto.locationName}.`;
      image = activePhoto.image || activePhoto.thumbnail || defaultImage;
      imageAlt = `${photoSubjectLabel(activePhoto)} photographed at ${activePhoto.locationName}`;
    } else if (activeView === "aircraftDetailView") {
      const aircraft = state.aircraftById?.get(state.selectedAircraftId);
      if (aircraft) {
        const photos = photosForAircraft(aircraft);
        const cover = state.photoById.get(aircraft.coverPhoto) || photos[0];
        title = `${aircraft.typeName} field guide | SpotterDex`;
        description = pageDescription(aircraft.writeUp, `${photos.length} photographed frame${photos.length === 1 ? "" : "s"} of ${aircraft.typeName}, organised by unit and location.`);
        image = cover?.image || cover?.thumbnail || defaultImage;
        imageAlt = cover
          ? `${photoSubjectLabel(cover)} photographed at ${cover.locationName}`
          : `${aircraft.typeName} field guide cover`;
      }
    } else if (activeView === "locationDetailView") {
      const pin = state.pinById?.get(state.selectedPinId);
      if (pin) {
        const photos = photosForPin(pin);
        const profile = locationProfile(pin, photos);
        const hero = profile.heroPhoto || profile.heroAsset || photos[0];
        title = `${pin.name} field guide | SpotterDex`;
        description = pageDescription(pin.writeUp, `${photos.length} photographed frame${photos.length === 1 ? "" : "s"} at ${pin.name}${pin.country ? `, ${pin.country}` : ""}.`);
        image = hero?.image || hero?.thumbnail || defaultImage;
        imageAlt = hero
          ? `${photoSubjectLabel(hero)} photographed at ${hero.locationName || pin.name}`
          : `${pin.name} field guide cover`;
      }
    } else if (activeView === "squadronDetailView") {
      const squadron = collectSquadrons().find((item) => item.id === state.selectedSquadronId);
      if (squadron) {
        const photos = photosForSquadronRecord(squadron);
        const hero = squadronCardHero(squadron) || photos[0];
        title = `${squadron.name} | SpotterDex`;
        description = pageDescription(squadron.writeUp, `${photos.length} aviation photograph${photos.length === 1 ? "" : "s"} from ${squadron.name}${squadron.country ? ` in ${squadron.country}` : ""}.`);
        image = hero?.image || hero?.thumbnail || defaultImage;
        imageAlt = hero
          ? `${photoSubjectLabel(hero)} photographed at ${hero.locationName}`
          : `${squadron.name} squadron cover`;
      }
    } else if (activeView === "airshowDetailView" && state.selectedAirshowId) {
      const airshow = state.airshowById.get(state.selectedAirshowId);
      if (airshow) {
        const photos = photosForAirshow(airshow);
        const hero = airshowHeroPhoto(airshow, photos) || photos[0];
        title = `${airshow.name} | SpotterDex`;
        description = pageDescription(airshow.writeUp, `${photos.length} aviation photograph${photos.length === 1 ? "" : "s"} from ${airshow.name}.`);
        image = hero?.image || hero?.thumbnail || defaultImage;
        imageAlt = hero
          ? `${photoSubjectLabel(hero)} photographed at ${hero.locationName}`
          : `${airshow.name} event cover`;
      }
    }

    const shareUrl = shareUrlForCurrentState();
    const canonicalUrl = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const imageUrl = new URL(image, document.baseURI).href;
    document.title = title;
    if (els.metaDescription) els.metaDescription.content = description;
    if (els.ogTitle) els.ogTitle.content = title;
    if (els.ogDescription) els.ogDescription.content = description;
    if (els.ogImage) els.ogImage.content = imageUrl;
    if (els.ogImageAlt) els.ogImageAlt.content = imageAlt;
    if (els.ogUrl) els.ogUrl.content = shareUrl;
    if (els.twitterTitle) els.twitterTitle.content = title;
    if (els.twitterDescription) els.twitterDescription.content = description;
    if (els.twitterImage) els.twitterImage.content = imageUrl;
    if (els.twitterImageAlt) els.twitterImageAlt.content = imageAlt;
    if (els.canonical) els.canonical.href = canonicalUrl;
  }

  function nativeShareAvailable() {
    return typeof navigator.share === "function";
  }

  function fieldGuideSharePayload() {
    const title = document.title.replace(/\s*\|\s*SpotterDex\s*$/, "").trim() || "SpotterDex field guide";
    const description = String(els.metaDescription?.content || "").trim();
    return {
      title,
      text: description || `Open the ${title} field guide in SpotterDex.`,
      url: shareUrlForCurrentState()
    };
  }

  function showFieldGuideActionStatus(button, label) {
    const originalLabel = button.dataset.fieldGuideShare || (nativeShareAvailable() ? "Share" : "Copy link");
    button.textContent = label;
    window.clearTimeout(Number(button.dataset.statusTimer) || 0);
    button.dataset.statusTimer = String(window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1800));
  }

  async function shareFieldGuide(button) {
    const payload = fieldGuideSharePayload();
    if (nativeShareAvailable()) {
      try {
        await navigator.share(payload);
        showToast("Field guide shared");
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          return;
        }
      }
    }

    await copyText(payload.url);
    showFieldGuideActionStatus(button, "Copied");
    showToast("Field guide link copied");
  }

  function shareUrlForCurrentState() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const photoId = params.get("photo");
    if (photoId && state.photoById.has(photoId)) {
      return shareUrlForEntity("photo", photoId);
    }
    const activeView = document.querySelector("[data-view].is-active")?.id;
    if (activeView === "aircraftDetailView" && state.selectedAircraftId) {
      return shareUrlForEntity("aircraft", state.selectedAircraftId);
    }
    if (activeView === "squadronDetailView" && state.selectedSquadronId) {
      return shareUrlForEntity("squadron", state.selectedSquadronId);
    }
    if (activeView === "locationDetailView" && state.selectedPinId) {
      return shareUrlForEntity("location", state.selectedPinId);
    }
    if (activeView === "airshowDetailView" && state.selectedAirshowId) {
      return shareUrlForEntity("airshow", state.selectedAirshowId);
    }
    return window.location.href;
  }

  function shareUrlForEntity(kind, id) {
    return new URL(`share/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/`, document.baseURI).href;
  }

  function goToMapHome() {
    if (!document.getElementById("mapView")) {
      navigateToViewPage("mapView");
      return;
    }
    setActiveTab("mapView");
    setMapPanel(null);
    if (state.selectedPinId) {
      selectPin(state.selectedPinId, { updateHash: false, pan: true, openPanel: false });
      updateDeepLink("location", state.selectedPinId);
    } else {
      clearDeepLink();
    }
  }

  function updateDeepLinkForView(viewId) {
    if (viewId === "mapView" && state.selectedPinId) {
      updateDeepLink("location", state.selectedPinId);
    } else if (viewId === "locationDetailView" && state.selectedPinId) {
      updateLocationDetailLink(state.selectedPinId);
    } else if (viewId === "aircraftDetailView" && state.selectedAircraftId) {
      updateAircraftDetailLink(state.selectedAircraftId, {
        group: state.dexGroupMode,
        locationId: state.selectedAircraftLocationId
      });
    } else if (viewId === "squadronDetailView" && state.selectedSquadronId) {
      updateDeepLink("squadron", state.selectedSquadronId);
    } else if (viewId === "airshowDetailView" && state.selectedAirshowId) {
      updateDeepLink("airshow", state.selectedAirshowId);
    } else if (viewId === "statsView") {
      updateDeepLink("stats", "summary");
    } else if (["dexView", "squadronsView", "airshowsView"].includes(viewId)) {
      clearDeepLink();
    }
  }

  function statsIcon(name) {
    const icons = {
      aperture: `
        <svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="m14 3-4 9"></path>
          <path d="m21 10-9 2"></path>
          <path d="m18 19-6-7"></path>
          <path d="m7 21 5-9"></path>
          <path d="m3 14 9-2"></path>
          <path d="m6 5 6 7"></path>
        </svg>
      `,
      camera: `
        <svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8h4l2-3h4l2 3h4v11H4Z"></path>
          <circle cx="12" cy="13" r="4"></circle>
        </svg>
      `,
      lens: `
        <svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8"></circle>
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M12 4v3"></path>
          <path d="M20 12h-3"></path>
          <path d="M12 20v-3"></path>
          <path d="M4 12h3"></path>
        </svg>
      `,
      focal: `
        <svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 12h16"></path>
          <path d="M12 4v16"></path>
          <circle cx="12" cy="12" r="5"></circle>
        </svg>
      `,
      shutter: `
        <svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8"></circle>
          <path d="M12 4v8l5 5"></path>
        </svg>
      `,
      iso: `
        <svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 19a7 7 0 0 1 14 0"></path>
          <path d="M12 12l4-4"></path>
          <path d="M7 19h10"></path>
          <path d="M6 15l2 1"></path>
          <path d="M18 15l-2 1"></path>
        </svg>
      `,
      stats: `
        <svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 19V5"></path>
          <path d="M4 19h16"></path>
          <path d="M8 16v-5"></path>
          <path d="M12 16V8"></path>
          <path d="M16 16v-9"></path>
        </svg>
      `
    };

    return icons[name] || icons.stats;
  }

  function renderAll() {
    if (els.aircraftCount && els.photoCount && els.locationCount) {
      renderStats();
    }
    updateMapPanelState();
    updateMapPanelCoach();
    updateMapControlPanelState();
    updateMapDossierState();
  }

  function ensureViewRendered(viewId) {
    const directoryViews = new Set(["mapView", "dexView", "squadronsView", "airshowsView", "statsView"]);
    if (!directoryViews.has(viewId)) {
      return;
    }
    const directoryView = viewId;
    if (state.renderedViews.has(directoryView)) {
      return;
    }

    if (directoryView === "mapView") {
      renderLocations();
      if (!isMobileMapLayout()) {
        renderMapResults();
      }
      scheduleMapInitialization();
      updateMapPanelCoach();
    } else if (directoryView === "dexView") {
      renderDex();
    } else if (directoryView === "squadronsView") {
      renderSquadronsPage();
    } else if (directoryView === "airshowsView") {
      renderAirshowsPage();
    } else if (directoryView === "statsView") {
      renderStatsArchiveHero();
      renderStatsDashboard();
      observeStatsExifSection();
      updateStatsSectionNav();
    }

    state.renderedViews.add(directoryView);
  }

  function renderStats() {
    const enabledPins = state.data.pins.filter((pin) => pin.enabled);
    els.aircraftCount.textContent = String(state.data.aircraft.length);
    els.photoCount.textContent = String(state.data.photos.length);
    els.locationCount.textContent = String(enabledPins.length);
    updateMobileMapHeader();
    updateRecentLocationNav();
  }

  function updateMobileMapHeader() {
    if (!els.mobileMapLocationTitle || !els.mobileMapPhotoCount) {
      return;
    }

    const enabledPins = state.data.pins.filter((pin) => pin.enabled);
    const pin = state.pinById.get(state.selectedPinId);
    const photos = pin ? photosForPin(pin) : EMPTY_PHOTOS;
    els.mobileMapLocationTitle.textContent = `${enabledPins.length} spot${enabledPins.length === 1 ? "" : "s"}`;
    els.mobileMapPhotoCount.textContent = String(photos.length);
    if (els.mobileMapPhotoLocation) {
      els.mobileMapPhotoLocation.textContent = pin?.name || "No location selected";
    }

    if (els.mobileMapLocationCard) {
      els.mobileMapLocationCard.setAttribute("aria-label", "Browse locations");
    }
    if (els.mobileMapPhotosCard) {
      els.mobileMapPhotosCard.disabled = !pin;
      els.mobileMapPhotosCard.setAttribute(
        "aria-label",
        pin
          ? `Open ${photos.length} photo${photos.length === 1 ? "" : "s"} for ${pin.name}`
          : "Open photos for the selected location"
      );
    }
  }

  function dexHeroPhotos(entries = filteredAircraftEntries()) {
    const photoIds = new Set(entries.flatMap((entry) => entry.photoIds || []));
    return state.data.photos
      .filter((photo) => photoIds.has(photo.id))
      .sort(sortPhotos);
  }

  function updateDexHeroWithTransition(update, shouldAnimate) {
    const animatedTargets = shouldAnimate && !isReducedMotion()
      ? [els.dexHeroMedia, els.dexHeroFeature].filter(Boolean)
      : [];
    animatedTargets.forEach((target) => target.classList.add("is-contextual-update"));
    update();
    window.requestAnimationFrame(() => {
      animatedTargets.forEach((target) => target.classList.remove("is-contextual-update"));
    });
  }

  function renderDexHero() {
    if (!els.dexHeroMedia || !els.dexHeroFeature) {
      return;
    }

    const familyId = state.dexFamilyFilter;
    const entries = filteredAircraftEntries();
    const familyPhotos = dexHeroPhotos(entries);
    const photos = familyId ? familyPhotos : state.data.photos.slice().sort(sortPhotos);
    const latest = photos.find((photo) => photo.image || photo.thumbnail) || null;
    const familyLabel = familyId ? AIRCRAFT_FAMILY_LABELS.get(familyId) || "Selected family" : "";
    const aircraftCount = familyId ? entries.length : state.data.aircraft.length;
    const photoCount = familyId ? familyPhotos.length : state.data.photos.length;
    const countryCount = unique(entries.flatMap((entry) => entry.countries || [])).length;
    const signature = [familyId || "all", latest?.id || "none", aircraftCount, photoCount, countryCount].join(":");
    if (state.dexHeroSignature === signature) {
      return;
    }
    const shouldAnimate = Boolean(state.dexHeroSignature);

    updateDexHeroWithTransition(() => {
      if (state.dexFamilyFilter !== familyId) {
        return;
      }
      els.dexHeroAircraftCount.textContent = String(aircraftCount);
      els.dexHeroPhotoCount.textContent = String(photoCount);
      els.dexHeroCountryCount.textContent = String(countryCount);

      if (!latest) {
        els.dexHeroMedia.innerHTML = '<span class="dex-hero-media-fallback"></span>';
        els.dexHeroFeature.innerHTML = `<p>No ${familyId ? `${escapeHtml(familyLabel.toLowerCase())} ` : ""}photos yet</p>`;
        els.dexHeroAction.hidden = true;
        delete els.dexHeroAction.dataset.photoId;
        delete els.dexHeroAction.dataset.photoContext;
        state.dexHeroSignature = signature;
        return;
      }

      els.dexHeroMedia.innerHTML = renderResponsivePhotoImage(latest, "", {
        sizes: "100vw",
        eager: true,
        fullResolution: true
      });
      els.dexHeroFeature.innerHTML = `
        <span>${familyId ? `Newest ${escapeHtml(familyLabel.toLowerCase())} frame` : "Newest in the archive"}</span>
        <strong>${escapeHtml(photoSubjectLabel(latest))}</strong>
        <small>${escapeHtml(latest.locationName)} · ${escapeHtml(displayPhotoDate(latest))}</small>
      `;
      els.dexHeroAction.hidden = false;
      els.dexHeroAction.dataset.photoId = latest.id;
      els.dexHeroAction.dataset.photoContext = familyId ? "dex-family" : "recent";
      els.dexHeroAction.innerHTML = `${familyId ? `View latest ${escapeHtml(familyLabel.toLowerCase())} frame` : "View latest frame"} <span aria-hidden="true">↗</span>`;
      els.dexHeroAction.setAttribute(
        "aria-label",
        `Open latest ${familyId ? `${familyLabel.toLowerCase()} ` : ""}frame: ${photoSubjectLabel(latest)} at ${latest.locationName}`
      );
      state.dexHeroSignature = signature;
    }, shouldAnimate);
  }

  function renderSquadronsPage() {
    if (!els.squadronLogoGrid || !els.squadronPageCount) {
      return;
    }

    const { squadrons, filteredSquadrons, orderedSquadrons, isMobile } = squadronArchiveEntries();
    const visibleSquadrons = isMobile
      ? orderedSquadrons.slice(0, state.squadronVisibleCount)
      : orderedSquadrons;

    renderSquadronArchiveHero(squadrons);
    renderSquadronCountryRail(squadrons);

    if (!squadrons.length) {
      els.squadronLogoGrid.innerHTML = '<div class="empty-state compact">Add squadron entries to populate this page.</div>';
      renderArchivePagination(els.squadronPagination, 0, 0, "squadrons", "squadrons");
      return;
    }

    if (!visibleSquadrons.length) {
      els.squadronLogoGrid.innerHTML = '<div class="empty-state compact"><p>No squadrons match this country filter.</p><button class="empty-state-reset" type="button" data-squadron-country-jump="squadronsView" data-squadron-country-filter="">Show all squadrons</button></div>';
    } else {
      els.squadronLogoGrid.innerHTML = renderSquadronCountrySections(visibleSquadrons, filteredSquadrons);
    }
    renderArchivePagination(
      els.squadronPagination,
      visibleSquadrons.length,
      filteredSquadrons.length,
      "squadrons",
      "squadrons"
    );
    scrollActiveFilterChip(els.squadronCountryRail);
    window.requestAnimationFrame(observeSquadronCountrySections);
  }

  function squadronArchiveEntries() {
    const squadrons = collectSquadrons();
    const isMobile = isFocusedMobileLayout();
    const filteredSquadrons = squadrons.filter((squadron) => {
      return !state.squadronCountryFilter || (squadron.country || "Country not set") === state.squadronCountryFilter;
    });
    const orderedSquadrons = isMobile
      ? groupSquadronsByCountry(filteredSquadrons).flatMap((group) => group.squadrons)
      : filteredSquadrons;
    return { squadrons, filteredSquadrons, orderedSquadrons, isMobile };
  }

  function renderSquadronArchiveHero(squadrons) {
    if (!els.squadronHeroMedia) {
      return;
    }

    const aircraftDexHeroPhotoId = recentPhotos(1)[0]?.id || "";
    const squadronWithMostPhotos = squadrons
      .map((squadron) => ({ squadron, photos: photosForSquadronRecord(squadron) }))
      .filter(({ photos }) => photos.length)
      .sort((a, b) => {
        const countDiff = b.photos.length - a.photos.length;
        if (countDiff) return countDiff;
        const latestDiff = (b.photos[0]?.sortTime || 0) - (a.photos[0]?.sortTime || 0);
        if (latestDiff) return latestDiff;
        return a.squadron.name.localeCompare(b.squadron.name);
      })[0];
    const latest = squadronWithMostPhotos?.photos.find((photo) => photo.id !== aircraftDexHeroPhotoId)
      || null;
    const countryCount = unique(squadrons.map((squadron) => squadron.country || "Country not set")).length;
    const photoCount = unique(squadrons.flatMap((squadron) => squadron.photoIds || [])).length;

    els.squadronPageCount.textContent = String(squadrons.length);
    els.squadronPageCount.setAttribute("aria-label", `${squadrons.length} squadrons`);
    els.squadronHeroCountryCount.textContent = String(countryCount);
    els.squadronHeroPhotoCount.textContent = String(photoCount);

    els.squadronHeroMedia.innerHTML = latest
      ? renderResponsivePhotoImage(latest, "", { sizes: "100vw", eager: true, fullResolution: true })
      : '<span class="squadron-archive-media-fallback"></span>';
  }

  function renderSquadronCountryRail(squadrons) {
    if (!els.squadronCountryRail) {
      return;
    }
    const groups = groupSquadronsByCountry(squadrons);
    const allActive = !state.squadronCountryFilter;
    els.squadronCountryRail.innerHTML = groups.length
      ? `
          <button class="squadron-country-filter-all${allActive ? " is-active" : ""}" type="button" data-squadron-country-jump="squadronsView" data-squadron-country-filter="" aria-pressed="${String(allActive)}">
            <span class="squadron-country-nav-label">All</span>
            <span class="squadron-country-count">${squadrons.length}</span>
          </button>
          ${groups
          .map(
            (group) => {
              const active = state.squadronCountryFilter === group.country;
              return `
              <button class="${active ? "is-active" : ""}" type="button" data-squadron-country-jump="${escapeAttr(squadronCountryId(group.country))}" data-squadron-country-filter="${escapeAttr(group.country)}" aria-pressed="${String(active)}">
                ${renderCountryLabel(group.country, "squadron-country-nav-label")}
                <span class="squadron-country-count">${group.squadrons.length}</span>
              </button>
            `;
            }
          )
          .join("")}
        `
      : '<span class="muted">No countries</span>';
  }

  function disconnectSquadronCountryObserver() {
    state.squadronCountryObserver?.disconnect();
    state.squadronCountryObserver = null;
  }

  function updateSquadronCurrentCountry(country) {
    if (!els.squadronCountryRail || isFocusedMobileLayout()) {
      return;
    }
    const nextCountry = String(country || "");
    state.squadronCurrentCountry = nextCountry;
    let currentButton = null;
    els.squadronCountryRail.querySelectorAll("[data-squadron-country-jump]").forEach((button) => {
      const isCurrent = (button.dataset.squadronCountryFilter || "") === nextCountry;
      button.classList.toggle("is-active", isCurrent);
      if (isCurrent) {
        button.setAttribute("aria-current", "location");
        currentButton = button;
      } else {
        button.removeAttribute("aria-current");
      }
    });
    revealSquadronCountryChip(currentButton);
    scheduleScrollEdgeUpdate();
  }

  function revealSquadronCountryChip(button) {
    const rail = els.squadronCountryRail;
    if (!(button instanceof HTMLElement) || !rail) {
      return;
    }
    const railRect = rail.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    let nextScrollLeft = rail.scrollLeft;
    if (buttonRect.left < railRect.left) {
      nextScrollLeft += buttonRect.left - railRect.left;
    } else if (buttonRect.right > railRect.right) {
      nextScrollLeft += buttonRect.right - railRect.right;
    } else {
      return;
    }
    rail.scrollTo({ left: Math.max(0, nextScrollLeft), behavior: "auto" });
  }

  function currentSquadronCountryFromSections(sections) {
    const activationTop = 150;
    const candidates = sections
      .map((section) => ({ section, rect: section.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > activationTop);
    if (!candidates.length || candidates[0].rect.top > activationTop + 32) {
      return "";
    }
    candidates.sort((a, b) => Math.abs(a.rect.top - activationTop) - Math.abs(b.rect.top - activationTop));
    const id = candidates[0].section.id.replace(/^squadron-country-/, "");
    const button = els.squadronCountryRail?.querySelector(`[data-squadron-country-jump="${CSS.escape(candidates[0].section.id)}"]`);
    return button?.dataset.squadronCountryFilter || id;
  }

  function observeSquadronCountrySections() {
    disconnectSquadronCountryObserver();
  }

  function renderSquadronCountrySections(squadrons, totalSquadrons = squadrons) {
    const totals = new Map(groupSquadronsByCountry(totalSquadrons).map((group) => [group.country, group.squadrons.length]));
    return groupSquadronsByCountry(squadrons)
      .map(
        (group) => `
          <section class="squadron-country-section" id="${escapeAttr(squadronCountryId(group.country))}">
            <div class="group-header squadron-country-header">
              <div>
                <p class="eyebrow">Country</p>
                <h2>${renderCountryLabel(group.country)}</h2>
              </div>
              <span class="count-pill">${totals.get(group.country) || group.squadrons.length}</span>
            </div>
            <div class="squadron-logo-grid">
              ${group.squadrons.map(renderSquadronLogoCard).join("")}
            </div>
          </section>
        `
      )
      .join("");
  }

  function groupSquadronsByCountry(squadrons) {
    const byCountry = new Map();
    squadrons.forEach((squadron) => {
      const country = squadron.country || "Country not set";
      if (!byCountry.has(country)) {
        byCountry.set(country, []);
      }
      byCountry.get(country).push(squadron);
    });

    return Array.from(byCountry.entries())
      .map(([country, countrySquadrons]) => ({
        country,
        squadrons: countrySquadrons.sort((a, b) => a.name.localeCompare(b.name))
      }))
      .sort((a, b) => {
        const countDiff = b.squadrons.length - a.squadrons.length;
        if (countDiff) {
          return countDiff;
        }
        return a.country.localeCompare(b.country);
      });
  }

  function collectSquadrons() {
    const byKey = new Map();
    const addSquadron = (squadron, aircraftType = "") => {
      if (!isSquadronUnit(squadron)) {
        return;
      }
      const key = String(squadron.id || normalizeKey(`${squadron.country || ""}-${squadron.name || ""}`));
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: key,
          name: squadron.name || "Unknown squadron",
          country: squadron.country || "",
          logo: squadron.logo || "",
          writeUp: normalizeWriteUp(squadron.writeUp || squadron.write_up),
          heroPhoto: squadron.heroPhoto || null,
          aircraftTypes: [],
          photoIds: []
        });
      }

      const record = byKey.get(key);
      if (!record.logo && squadron.logo) {
        record.logo = squadron.logo;
      }
      if (!record.heroPhoto && squadron.heroPhoto) {
        record.heroPhoto = squadron.heroPhoto;
      }
      if (!record.writeUp && squadron.writeUp) {
        record.writeUp = squadron.writeUp;
      }
      if (aircraftType) {
        record.aircraftTypes.push(aircraftType);
      }
      record.photoIds.push(...(squadron.photoIds || []));
    };

    state.data.squadrons.forEach((squadron) => addSquadron(squadron));
    state.data.aircraft.forEach((entry) => {
      (entry.squadrons || []).forEach((squadron) => {
        addSquadron(squadron, entry.typeName);
      });
    });

    return Array.from(byKey.values())
      .map((squadron) => ({
        ...squadron,
        aircraftTypes: unique(squadron.aircraftTypes).sort((a, b) => a.localeCompare(b)),
        photoIds: unique(squadron.photoIds)
      }))
      .sort((a, b) => {
        const countryDiff = a.country.localeCompare(b.country);
        if (countryDiff) {
          return countryDiff;
        }
        return a.name.localeCompare(b.name);
      });
  }

  function renderSquadronLogoCard(squadron, index = 0) {
    const logoContent = squadron.logo
      ? `<img src="${escapeAttr(squadron.logo)}" alt="${escapeAttr(squadron.name)} logo">`
      : `<span class="squadron-logo-fallback">${escapeHtml(initials(squadron.name))}</span>`;
    const hero = squadronCardHero(squadron);
    const heroImage = hero ? hero.thumbnail || hero.image || "" : "";
    const typePreview = squadron.aircraftTypes.slice(0, 3).join(", ");
    const extraTypes = Math.max(0, squadron.aircraftTypes.length - 3);
    const activeClass = squadron.id === state.selectedSquadronId ? " is-active" : "";
    const mediaClass = heroImage ? " has-hero" : "";

    return `
      <button
        class="squadron-logo-card${activeClass}"
        type="button"
        data-squadron-id="${escapeAttr(squadron.id)}"
        style="--squadron-delay: ${Math.min(index, 5) * 30}ms"
        aria-label="Open ${escapeAttr(squadron.name)} squadron record"
        title="${escapeAttr(squadron.name)}"
      >
        <div class="squadron-logo-media${mediaClass}">
          ${heroImage ? renderResponsivePhotoImage(hero, `${squadron.name} hero photo`, {
            className: "squadron-card-hero",
            sizes: "(max-width: 760px) 100vw, (max-width: 1040px) 50vw, 33vw"
          }) : ""}
          <span class="squadron-card-logo${heroImage ? "" : " is-standalone"}">
            ${logoContent}
          </span>
        </div>
        <span class="squadron-card-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
        <div class="squadron-logo-body">
          <p class="eyebrow">${escapeHtml(squadron.country || "Country not set")}</p>
          <h2>${escapeHtml(squadron.name)}</h2>
          <p>${escapeHtml(typePreview || "Squadron-level images")}${extraTypes ? ` + ${extraTypes} more` : ""}</p>
          <span>${squadron.photoIds.length} photo${squadron.photoIds.length === 1 ? "" : "s"} - ${squadron.aircraftTypes.length} type${squadron.aircraftTypes.length === 1 ? "" : "s"}</span>
        </div>
      </button>
    `;
  }

  function squadronCardHero(squadron) {
    if (squadron.heroPhoto && (squadron.heroPhoto.thumbnail || squadron.heroPhoto.image)) {
      return squadron.heroPhoto;
    }
    const photos = photosForSquadronRecord(squadron);
    return photos.find((photo) => photo.tagScope === "squadron" && (photo.thumbnail || photo.image))
      || photos.find((photo) => photo.thumbnail || photo.image)
      || null;
  }

  function squadronCountryId(country) {
    return `squadron-country-${normalizeKey(country || "unknown")}`;
  }

  function renderCountryLabel(country, className = "") {
    const label = country || "Country not set";
    const flag = countryFlag(country);
    const classes = ["country-label", className].filter(Boolean).join(" ");
    const flagMarkup = flag === "?"
      ? ""
      : `<span class="country-flag" aria-hidden="true">${escapeHtml(flag)}</span>`;
    return `<span class="${classes}">${flagMarkup}<span>${escapeHtml(label)}</span></span>`;
  }

  function renderSquadronDetail() {
    if (!els.squadronDetail) {
      return;
    }

    const squadron = collectSquadrons().find((item) => item.id === state.selectedSquadronId);
    if (!squadron) {
      els.squadronDetail.innerHTML = '<div class="empty-state">Choose a squadron from the directory to open its photo page.</div>';
      return;
    }

    const photos = photosForSquadronRecord(squadron);
    const squadronLevelPhotos = photos.filter((photo) => photo.tagScope === "squadron");
    const otherPhotos = photos.filter((photo) => photo.tagScope !== "squadron");
    const typePreview = squadron.aircraftTypes.join(", ");
    const hero = squadronCardHero(squadron);
    const heroImage = hero ? hero.image || hero.thumbnail || "" : "";
    const logo = squadron.logo
      ? `<img src="${escapeAttr(squadron.logo)}" alt="${escapeAttr(squadron.name)} logo">`
      : `<span class="squadron-logo-fallback">${escapeHtml(initials(squadron.name))}</span>`;
    els.squadronDetail.innerHTML = `
      ${renderDetailHero({
        backView: "squadronsView",
        backLabel: "All squadrons",
        eyebrow: squadron.country || "Squadron",
        title: squadron.name,
        description: squadron.aircraftTypes.length
          ? `${squadron.aircraftTypes.length} aircraft type${squadron.aircraftTypes.length === 1 ? "" : "s"}`
          : "",
        image: heroImage,
        alt: `${squadron.name} hero photo`,
        photo: hero,
        mark: logo,
        actions: renderFieldGuideActions("Squadron field guide"),
        className: "squadron-field-guide-hero"
      })}
      ${renderOfflineMediaCoverage()}
      ${renderPageWriteUp(squadron.writeUp, "About this squadron")}
      <section class="detail-photo-section squadron-unit-archive squadron-specific-photo-section${otherPhotos.length ? " has-other-sections" : ""}">
        <div class="detail-section-heading">
          <div>
            <p class="eyebrow">Aircraft types</p>
            <p class="detail-summary-copy">${escapeHtml(typePreview || "No aircraft types tagged yet.")}</p>
          </div>
          ${squadronLevelPhotos.length ? `<span class="count-pill">${squadronLevelPhotos.length}</span>` : ""}
        </div>
        ${squadronLevelPhotos.length
          ? renderDetailPhotoGrid(squadronLevelPhotos, "squadron", "squadron-level")
          : ""}
      </section>
      <section class="detail-photo-section">
        <div class="detail-section-heading">
          <div>
            <h2>Aircraft archive</h2>
          </div>
          <span class="count-pill">${otherPhotos.length}</span>
        </div>
        ${renderAircraftTypePhotoGroups(otherPhotos, "squadron", "squadron-aircraft-types")}
      </section>
    `;
    scheduleOfflineMediaCoverageRefresh();
  }

  function renderLocationPage() {
    if (!els.locationDetail) {
      return;
    }

    const pin = state.pinById.get(state.selectedPinId);
    if (!pin) {
      els.locationDetail.innerHTML = '<div class="empty-state">Choose a location from the World Map to open its archive.</div>';
      return;
    }

    const photos = photosForPin(pin);
    const profile = locationProfile(pin, photos);
    const locationPhotos = profile.locationPhotos;
    const otherPhotos = photos.filter((photo) => photo.tagScope !== "location");
    const heroImage = profile.heroPhoto
      ? profile.heroPhoto.image || profile.heroPhoto.thumbnail || ""
      : profile.heroAsset
        ? profile.heroAsset.image || profile.heroAsset.thumbnail || ""
        : "";
    const identityMarks = renderLocationIdentityMarks(profile.families, profile.units);
    const profileLabel = [pin.country, pin.icao].filter(Boolean).join(" · ") || "Location archive";

    els.locationDetail.innerHTML = `
      ${renderDetailHero({
        backView: "mapView",
        backLabel: "World Map",
        eyebrow: locationKicker(pin),
        title: pin.name,
        description: "",
        image: heroImage,
        alt: `${pin.name} hero photo`,
        photo: profile.heroPhoto,
        actions: renderFieldGuideActions("Location field guide"),
        className: "location-field-guide-hero"
      })}
      ${renderOfflineMediaCoverage()}
      <section class="location-profile-card" aria-label="Location profile">
        <div class="location-profile-card-title">
          <p class="eyebrow">Location profile</p>
          <h2>${escapeHtml(profileLabel)}</h2>
        </div>
        <div class="location-profile-card-marks">
          ${identityMarks}
        </div>
        <dl class="detail-overview-stats location-profile-card-stats" aria-label="Location statistics">
          ${photos.length ? archiveStat("Photos", photos.length) : ""}
        </dl>
      </section>
      ${renderPageWriteUp(pin.writeUp, "About this location")}
      ${
        locationPhotos.length
          ? `<section class="detail-photo-section location-specific-photo-section${otherPhotos.length ? " has-other-sections" : ""}">
              ${renderDetailPhotoGrid(locationPhotos, "location", "location-tagged", { hidePhotoSubject: true })}
            </section>`
          : ""
      }
      <section class="detail-photo-section">
        <div class="detail-section-heading">
          <div>
            <h2>Aircraft and unit archive</h2>
          </div>
          <span class="count-pill">${otherPhotos.length}</span>
        </div>
        ${renderAircraftTypePhotoGroups(otherPhotos, "location", "location-aircraft-types")}
      </section>
    `;
    scheduleOfflineMediaCoverageRefresh();
  }

  function renderFieldGuideActions(label) {
    const actionLabel = nativeShareAvailable() ? "Share" : "Copy link";
    return `
      <div class="detail-hero-actions" aria-label="${escapeAttr(label)} actions">
        <button class="detail-hero-action" type="button" data-field-guide-share="${actionLabel}">${actionLabel}</button>
      </div>
    `;
  }

  function renderPageWriteUp(writeUp, label) {
    const text = normalizeWriteUp(writeUp);
    if (!text) {
      return "";
    }
    return `
      <section class="detail-write-up" aria-label="${escapeAttr(label)}">
        <p class="eyebrow">${escapeHtml(label)}</p>
        <div class="detail-write-up-copy">${renderSafeMarkdown(text)}</div>
      </section>
    `;
  }

  function renderSafeMarkdown(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let paragraph = [];
    let listType = "";
    const flushParagraph = () => {
      if (paragraph.length) output.push(`<p>${paragraph.map(renderMarkdownInline).join("<br>")}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (listType) output.push(`</${listType}>`);
      listType = "";
    };

    lines.forEach((line) => {
      const heading = line.match(/^(#{2,4})\s+(.+)$/);
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      const quote = line.match(/^>\s?(.*)$/);
      if (!line.trim()) {
        flushParagraph();
        closeList();
      } else if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        output.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      } else if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? "ul" : "ol";
        if (listType !== nextType) {
          closeList();
          listType = nextType;
          output.push(`<${listType}>`);
        }
        output.push(`<li>${renderMarkdownInline((unordered || ordered)[1])}</li>`);
      } else if (quote) {
        flushParagraph();
        closeList();
        output.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`);
      } else {
        closeList();
        paragraph.push(line.trim());
      }
    });
    flushParagraph();
    closeList();
    return output.join("");
  }

  function renderMarkdownInline(value) {
    let html = escapeHtml(value);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, href) => {
      const decodedHref = href.replace(/&amp;/g, "&");
      if (!/^(https?:\/\/|mailto:|\/|#)/i.test(decodedHref)) return text;
      return `<a href="${escapeAttr(decodedHref)}"${/^https?:\/\//i.test(decodedHref) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
    });
    return html;
  }

  function renderDetailHero({ backView, backLabel, eyebrow, title, description, image, alt, photo = null, mark = "", actions = "", footer = "", className = "" }) {
    const photoAttributes = image
      ? ` data-photo-media="hero"${photo?.id ? ` data-photo-id="${escapeAttr(photo.id)}"` : ""}`
      : "";
    return `
      <section class="detail-hero${image ? " has-image" : ""}${className ? ` ${escapeAttr(className)}` : ""}">
        ${image ? `<img src="${escapeAttr(image)}"${photoAttributes} alt="${escapeAttr(alt)}">` : ""}
        <div class="detail-hero-scrim" aria-hidden="true"></div>
        <button class="detail-back-button" type="button" data-detail-back="${escapeAttr(backView)}">← ${escapeHtml(backLabel)}</button>
        ${actions}
        <div class="detail-hero-content">
          ${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ""}
          <h1>${escapeHtml(title)}</h1>
          ${description ? `<p>${escapeHtml(description)}</p>` : ""}
        </div>
        ${mark ? `<span class="detail-hero-mark" aria-hidden="true">${mark}</span>` : ""}
        ${footer}
      </section>
    `;
  }

  function renderDetailPhotoGrid(photos, context, galleryKey, options = {}) {
    if (!photos.length) {
      return '<div class="empty-state">No photos found for this section yet.</div>';
    }

    return renderProgressivePhotoGrid(photos, context, galleryKey, "detail-photo-grid", options);
  }

  function renderProgressivePhotoGrid(photos, context, galleryKey, className = "", options = {}) {
    const key = normalizeKey(galleryKey) || `gallery-${normalizeKey(photos[0]?.id || "photos")}`;
    const galleryId = `detail-gallery-${key}`;
    const gridId = `${galleryId}-grid`;
    const photoGridCount = Math.min(photos.length, 4);

    return `
      <div class="detail-gallery" id="${escapeAttr(galleryId)}">
        <div class="photo-grid photo-grid-count-${photoGridCount}${photos.length === 1 ? " photo-grid-single" : ""} ${escapeAttr(className)}" id="${escapeAttr(gridId)}">
          ${photos.map((photo) => renderPhotoCard(photo, context, {
            ...options,
            fullResolution: options.fullResolution ?? photos.length === 1
          })).join("")}
        </div>
      </div>
    `;
  }

  function renderDex() {
    if (!els.dexCount || !els.aircraftGrid) {
      return;
    }
    const entries = filteredAircraftEntries();
    const familyFilter = state.dexFamilyFilter;

    renderDexHero();
    renderDexFamilyFilter();
    scrollActiveFilterChip(els.dexFamilyFilter);
    els.dexCount.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}${familyFilter ? ` in ${AIRCRAFT_FAMILY_LABELS.get(familyFilter) || "selected family"}` : ""}`;
    const visibleEntries = isFocusedMobileLayout()
      ? entries.slice(0, state.dexVisibleCount)
      : entries;
    renderAircraftGrid(visibleEntries);
    renderArchivePagination(els.dexPagination, visibleEntries.length, entries.length, "aircraft", "aircraft entries");
  }

  function filteredAircraftEntries() {
    const familyFilter = state.dexFamilyFilter;
    return state.data.aircraft.filter((entry) => {
      return !familyFilter || aircraftFamilyIdForEntry(entry) === familyFilter;
    });
  }

  function openAircraftFamilyDex(familyId) {
    const family = normalizeAircraftFamily(familyId);
    if (!family) {
      return;
    }
    if (!document.getElementById("dexView")) {
      navigateToViewPage("dexView", `family=${encodeURIComponent(family)}`);
      return;
    }

    state.dexFamilyFilter = family;
    state.dexVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
    state.selectedAircraftId = null;
    setActiveTab("dexView");
    updateDeepLink("family", family);
    renderDex();
    window.requestAnimationFrame(() => els.dexFamilyFilter?.querySelector(".is-active")?.focus({ preventScroll: true }));
  }

  function renderDexFamilyFilter() {
    if (!els.dexFamilyFilter) {
      return;
    }

    const family = state.dexFamilyFilter;
    els.dexFamilyFilter.hidden = false;
    els.dexFamilyFilter.innerHTML = `
      <span class="dex-family-label" id="dexFamilyFilterLabel">Airframe class</span>
      <span class="dex-family-options" role="radiogroup" aria-labelledby="dexFamilyFilterLabel">
        <button
          class="${family ? "" : "is-active"}"
          type="button"
          role="radio"
          data-clear-dex-family-filter
          aria-checked="${family ? "false" : "true"}"
        >All <small>${state.data.aircraft.length}</small></button>
        ${AIRCRAFT_FAMILY_DEFINITIONS.map((definition) => {
          const count = state.data.aircraft.filter((entry) => aircraftFamilyIdForEntry(entry) === definition.id).length;
          const isActive = family === definition.id;
          return `
            <button
              class="${isActive ? "is-active" : ""}"
              type="button"
              role="radio"
              data-dex-family-id="${escapeAttr(definition.id)}"
              aria-checked="${isActive ? "true" : "false"}"
            >${escapeHtml(definition.label)} <small>${count}</small></button>
          `;
        }).join("")}
      </span>
    `;
  }

  function normalizeAircraftFamily(value) {
    const family = normalizeText(value);
    return AIRCRAFT_FAMILY_LABELS.has(family) ? family : "";
  }

  function aircraftFamilyIdForEntry(entry) {
    const configuredFamily = normalizeAircraftFamily(entry?.aircraftFamily);
    if (configuredFamily) {
      return configuredFamily;
    }

    const photo = state.photoById.get(entry?.coverPhoto) || state.photoById.get(entry?.photoIds?.[0]);
    return aircraftFamilyForPhoto(photo || {})?.id || "";
  }

  function renderAircraftGrid(entries) {
    if (!entries.length) {
      els.aircraftGrid.innerHTML = '<div class="empty-state"><p>No aircraft entries match this filter.</p><button class="empty-state-reset" type="button" data-clear-dex-family-filter>Show all aircraft</button></div>';
      return;
    }

    const gridEntries = aircraftGridEntries(entries);
    els.aircraftGrid.innerHTML = gridEntries
      .map(({ entry, isWide }, index) => renderAircraftCard(entry, isWide, index))
      .join("");
  }

  function renderAircraftCard(entry, isWide, index) {
    const cover = state.photoById.get(entry.coverPhoto);
    const stats = aircraftStats(entry);
    const countries = unique(entry.countries).slice(0, 3);
    const activeClass = entry.id === state.selectedAircraftId ? " is-active" : "";
    const coverImage = cover ? cover.thumbnail || cover.image : "";
    const catalogueNumber = String(index + 1).padStart(3, "0");

    return `
      <button
        class="aircraft-card${isWide ? " is-wide" : ""}${activeClass}"
        type="button"
        data-aircraft-id="${escapeAttr(entry.id)}"
        style="--dex-delay: ${Math.min(index, 5) * 30}ms"
        aria-label="Open ${escapeAttr(entry.typeName)} field guide"
      >
        <div class="aircraft-cover">
          ${
            coverImage
              ? renderResponsivePhotoImage(cover, entry.typeName, {
                  sizes: isWide
                    ? "(max-width: 620px) 100vw, (max-width: 1040px) 100vw, 67vw"
                    : "(max-width: 620px) 100vw, (max-width: 1040px) 50vw, 34vw",
                  fullResolution: isWide
                })
              : '<div class="empty-cover">No photo</div>'
          }
        </div>
        <span class="aircraft-card-index">${catalogueNumber}</span>
        <div class="aircraft-body">
          <strong class="aircraft-title">${formatAircraftCardTitle(entry.typeName)}</strong>
          <span class="aircraft-card-hover-details">
            <span>
              <small>Countries</small>
              <strong>${escapeHtml(countries.join(" / ") || "Country not set")}</strong>
            </span>
            <span>
              <small>Squadrons</small>
              <strong>${stats.unitCount}</strong>
            </span>
            <span>
              <small>Number of Photos</small>
              <strong>${stats.photoCount}</strong>
            </span>
          </span>
        </div>
      </button>
    `;
  }

  function loadNextArchivePage(kind) {
    if (!isFocusedMobileLayout() || state.archiveLoadPending) {
      return;
    }

    state.archiveLoadPending = true;
    try {
      if (kind === "aircraft") {
        appendAircraftArchivePage();
      } else if (kind === "squadrons") {
        appendSquadronArchivePage();
      } else if (kind === "airshows") {
        appendAirshowArchivePage();
      }
    } finally {
      state.archiveLoadPending = false;
    }
  }

  function appendAircraftArchivePage() {
    const entries = filteredAircraftEntries();
    const previousCount = Math.min(state.dexVisibleCount, entries.length);
    const nextCount = Math.min(previousCount + MOBILE_ARCHIVE_PAGE_SIZE, entries.length);
    const gridEntries = aircraftGridEntries(entries.slice(0, nextCount));
    const markup = gridEntries
      .slice(previousCount)
      .map(({ entry, isWide }, offset) => renderAircraftCard(entry, isWide, previousCount + offset))
      .join("");
    if (markup) {
      els.aircraftGrid.insertAdjacentHTML("beforeend", markup);
    }
    state.dexVisibleCount = nextCount;
    renderArchivePagination(els.dexPagination, nextCount, entries.length, "aircraft", "aircraft entries");
  }

  function appendSquadronArchivePage() {
    const { filteredSquadrons, orderedSquadrons } = squadronArchiveEntries();
    const previousCount = Math.min(state.squadronVisibleCount, orderedSquadrons.length);
    const nextCount = Math.min(previousCount + MOBILE_ARCHIVE_PAGE_SIZE, orderedSquadrons.length);
    const groups = groupSquadronsByCountry(filteredSquadrons);
    const groupByCountry = new Map(groups.map((group) => [group.country, group]));

    orderedSquadrons.slice(previousCount, nextCount).forEach((squadron) => {
      const country = squadron.country || "Country not set";
      const group = groupByCountry.get(country);
      const sectionId = squadronCountryId(country);
      let section = document.getElementById(sectionId);
      if (!section || !els.squadronLogoGrid.contains(section)) {
        els.squadronLogoGrid.insertAdjacentHTML("beforeend", `
          <section class="squadron-country-section" id="${escapeAttr(sectionId)}">
            <div class="group-header squadron-country-header">
              <div>
                <p class="eyebrow">Country</p>
                <h2>${renderCountryLabel(country)}</h2>
              </div>
              <span class="count-pill">${group?.squadrons.length || 0}</span>
            </div>
            <div class="squadron-logo-grid"></div>
          </section>
        `);
        section = document.getElementById(sectionId);
      }
      const index = Math.max(0, group?.squadrons.findIndex((item) => item.id === squadron.id) ?? 0);
      section?.querySelector(".squadron-logo-grid")?.insertAdjacentHTML("beforeend", renderSquadronLogoCard(squadron, index));
    });

    state.squadronVisibleCount = nextCount;
    renderArchivePagination(els.squadronPagination, nextCount, filteredSquadrons.length, "squadrons", "squadrons");
  }

  function appendAirshowArchivePage() {
    const airshows = airshowArchiveEntries();
    const previousCount = Math.min(state.airshowVisibleCount, airshows.length);
    const nextCount = Math.min(previousCount + MOBILE_ARCHIVE_PAGE_SIZE, airshows.length);
    const markup = airshows
      .slice(previousCount, nextCount)
      .map((airshow, offset) => renderAirshowTimelineItem(airshow, previousCount + offset))
      .join("");
    if (markup) {
      els.airshowTimeline.insertAdjacentHTML("beforeend", markup);
    }
    state.airshowVisibleCount = nextCount;
    renderArchivePagination(els.airshowPagination, nextCount, airshows.length, "airshows", "airshow events");
  }

  function archiveItemSelector(kind) {
    if (kind === "aircraft") {
      return "#dexView .aircraft-card[data-aircraft-id]";
    }
    if (kind === "squadrons") {
      return "#squadronsView .squadron-logo-card[data-squadron-id]";
    }
    if (kind === "airshows") {
      return "#airshowsView .airshow-timeline-card[data-airshow-id]";
    }
    return "";
  }

  function archiveItemElements(kind) {
    const selector = archiveItemSelector(kind);
    return selector ? Array.from(document.querySelectorAll(selector)) : [];
  }

  function archiveVisibleCount(kind) {
    if (kind === "aircraft") {
      return state.dexVisibleCount;
    }
    if (kind === "squadrons") {
      return state.squadronVisibleCount;
    }
    if (kind === "airshows") {
      return state.airshowVisibleCount;
    }
    return 0;
  }

  function archiveLoadTarget(kind, visibleCount = archiveVisibleCount(kind)) {
    const items = archiveItemElements(kind);
    const batchStart = Math.max(0, visibleCount - MOBILE_ARCHIVE_PAGE_SIZE);
    return items[batchStart + MOBILE_ARCHIVE_PREFETCH_OFFSET] || null;
  }

  function disconnectArchiveLoadObserver() {
    state.archiveLoadObserver?.disconnect();
    state.archiveLoadObserver = null;
    if (state.archiveLoadFallbackHandler) {
      window.removeEventListener("scroll", state.archiveLoadFallbackHandler);
      state.archiveLoadFallbackHandler = null;
    }
  }

  function observeArchiveLoadSentinel() {
    disconnectArchiveLoadObserver();
    if (!isFocusedMobileLayout()) {
      return;
    }

    const sentinel = document.querySelector("[data-archive-load-sentinel]");
    if (!sentinel) {
      return;
    }

    const loadKind = sentinel.dataset.archiveLoadSentinel;
    const visibleCount = Number(sentinel.dataset.archiveVisibleCount) || MOBILE_ARCHIVE_PAGE_SIZE;
    const target = archiveLoadTarget(loadKind, visibleCount) || sentinel;
    if ("IntersectionObserver" in window) {
      state.archiveLoadObserver = new IntersectionObserver((entries, observer) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        observer.disconnect();
        loadNextArchivePage(loadKind);
      }, { rootMargin: "0px 0px 120px 0px" });
      state.archiveLoadObserver.observe(target);
      return;
    }

    const loadIfNearViewport = () => {
      if (target.getBoundingClientRect().top <= window.innerHeight + 120) {
        loadNextArchivePage(loadKind);
      }
    };
    state.archiveLoadFallbackHandler = loadIfNearViewport;
    window.addEventListener("scroll", loadIfNearViewport, { passive: true });
    window.requestAnimationFrame(loadIfNearViewport);
  }

  function renderArchivePagination(container, visibleCount, totalCount, kind, itemLabel) {
    disconnectArchiveLoadObserver();
    if (!container) {
      return;
    }
    if (!isFocusedMobileLayout() || !totalCount) {
      container.innerHTML = "";
      return;
    }

    const hasMore = visibleCount < totalCount;
    container.innerHTML = `
      <p>Showing ${visibleCount} of ${totalCount} ${escapeHtml(itemLabel)}</p>
      ${hasMore
        ? `<span class="archive-load-sentinel" data-archive-load-sentinel="${escapeAttr(kind)}" data-archive-visible-count="${visibleCount}" aria-hidden="true"></span>`
        : ""}
    `;
    if (hasMore) {
      observeArchiveLoadSentinel();
    }
  }

  function scrollActiveFilterChip(container) {
    if (!container || !isFocusedMobileLayout()) {
      return;
    }
    window.requestAnimationFrame(() => {
      container.querySelector("button.is-active")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center"
      });
    });
  }

  function aircraftGridEntries(entries) {
    const promotedEntryIds = aircraftGridPromotionIds(entries);
    const { columns, normalSpan, wideSpan } = aircraftGridMetrics();
    const rows = [];
    let row = [];
    let usedColumns = 0;

    entries.forEach((entry) => {
      const isWide = promotedEntryIds.has(entry.id);
      const span = isWide ? wideSpan : normalSpan;
      if (row.length && usedColumns + span > columns) {
        rows.push(row);
        row = [];
        usedColumns = 0;
      }
      row.push({ entry, isWide });
      usedColumns += span;
      if (usedColumns >= columns) {
        rows.push(row);
        row = [];
        usedColumns = 0;
      }
    });
    if (row.length) {
      rows.push(row);
    }

    let nextWideSide = "right";
    rows.forEach((currentRow) => {
      const wideIndex = currentRow.findIndex((item) => item.isWide);
      const normalIndex = currentRow.findIndex((item) => !item.isWide);
      if (wideIndex < 0 || normalIndex < 0) {
        return;
      }

      const wideShouldBeFirst = nextWideSide === "left";
      const wideIsFirst = wideIndex < normalIndex;
      if (wideShouldBeFirst !== wideIsFirst) {
        [currentRow[wideIndex], currentRow[normalIndex]] = [currentRow[normalIndex], currentRow[wideIndex]];
      }
      nextWideSide = nextWideSide === "left" ? "right" : "left";
    });

    return rows.flat();
  }

  function aircraftGridPromotionIds(entries) {
    const topPhotoEntryIds = entries
      .slice()
      .sort((a, b) => {
        const photoCountDiff = aircraftStats(b).photoCount - aircraftStats(a).photoCount;
        return photoCountDiff || a.typeName.localeCompare(b.typeName);
      })
      .slice(0, 10)
      .map((entry) => entry.id);
    const recentEntryIds = entries
      .map((entry) => {
        const latest = photosForAircraft(entry)[0] || null;
        return {
          entry,
          latestTime: latest?.sortTime || 0
        };
      })
      .filter((item) => item.latestTime > 0)
      .sort((a, b) => b.latestTime - a.latestTime || a.entry.typeName.localeCompare(b.entry.typeName))
      .slice(0, 5)
      .map((item) => item.entry.id);
    const candidates = new Set([...topPhotoEntryIds, ...recentEntryIds]);
    const { columns, normalSpan, wideSpan } = aircraftGridMetrics();
    const promoted = new Set();
    let usedColumns = 0;

    entries.forEach((entry) => {
      const wantsWide = entry.doubleWidth === true
        || (entry.doubleWidth !== false && candidates.has(entry.id));
      if (entry.doubleWidth === true && wideSpan > normalSpan && usedColumns + wideSpan > columns) {
        usedColumns = 0;
      }
      let span = normalSpan;

      if (wantsWide && usedColumns + wideSpan <= columns) {
        span = wideSpan;
      } else if (usedColumns + normalSpan > columns) {
        usedColumns = 0;
        span = wantsWide ? wideSpan : normalSpan;
      }

      if (span === wideSpan && wantsWide) {
        promoted.add(entry.id);
      }
      usedColumns += span;
      if (usedColumns >= columns) {
        usedColumns = 0;
      }
    });

    return promoted;
  }

  function aircraftGridMetrics() {
    if (window.matchMedia("(max-width: 1040px)").matches) {
      return { columns: 1, normalSpan: 1, wideSpan: 1 };
    }
    return { columns: 12, normalSpan: 4, wideSpan: 8 };
  }

  function renderAircraftDetail() {
    if (!els.aircraftDetail) {
      return;
    }

    const entry = state.aircraftById.get(state.selectedAircraftId);
    if (!entry) {
      els.aircraftDetail.innerHTML = '<div class="empty-state">Choose an aircraft type from the Aircraft Dex to open its photo page.</div>';
      return;
    }

    const photos = photosForAircraft(entry);
    const stats = aircraftStats(entry);
    const unitCount = stats.unitCount;
    const unitLabel = entryUnitNoun(entry, unitCount);
    const unitGroupLabel = photos.length ? photoUnitGroupLabel(photos) : entryUnitNoun(entry, 1, true);
    const locationGroups = aircraftLocationGroups(photos);
    const selectedLocation = state.dexGroupMode === "location"
      ? locationGroups.find(
          (location) => location.pinId && location.pinId === state.selectedAircraftLocationId
        ) || null
      : null;
    const archivePhotos = selectedLocation
      ? photos.filter((photo) => aircraftPhotoLocationId(photo) === selectedLocation.pinId)
      : photos;
    const archiveGroupPanel = state.dexGroupMode === "location"
      ? renderAircraftLocationSection(locationGroups, selectedLocation?.pinId || "")
      : renderAircraftSquadronSection(entry);
    const cover = state.photoById.get(entry.coverPhoto) || photos[0] || null;
    const heroImage = cover ? cover.image || cover.thumbnail || "" : "";
    els.aircraftDetail.innerHTML = `
      ${renderDetailHero({
        backView: "dexView",
        backLabel: "Aircraft Dex",
        eyebrow: "Aircraft type",
        title: entry.typeName,
        description: `${unitCount} ${unitLabel}`,
        image: heroImage,
        alt: `${entry.typeName} hero photo`,
        photo: cover,
        actions: renderFieldGuideActions("Aircraft field guide"),
        className: "aircraft-field-guide-hero"
      })}
      ${renderOfflineMediaCoverage()}
      ${renderPageWriteUp(entry.writeUp, "About this aircraft")}
      <section class="detail-overview-card aircraft-archive-browser" aria-labelledby="aircraftArchiveHeading">
        <div class="detail-overview-toolbar">
          <div class="detail-overview-title">
            <p class="eyebrow">Archive browser</p>
            <h2 id="aircraftArchiveHeading">Browse the collection</h2>
          </div>
          <div class="segmented" role="radiogroup" aria-label="Organize aircraft photos">
            ${segmentButton(unitGroupLabel, "squadron", state.dexGroupMode, "data-dex-group", "aircraftUnitPhotos")}
            ${segmentButton("Location", "location", state.dexGroupMode, "data-dex-group", "aircraftLocationPhotos")}
          </div>
        </div>
        ${archiveGroupPanel}
      </section>

      <section class="detail-photo-section" id="aircraftPhotoArchive">
        <span id="${state.dexGroupMode === "location" ? "aircraftLocationPhotos" : "aircraftUnitPhotos"}" class="aircraft-photo-anchor" aria-hidden="true"></span>
        <div class="detail-section-heading">
          <div>
            <h2>${escapeHtml(selectedLocation ? `${selectedLocation.name} photos` : "Photo archive")}</h2>
          </div>
          <span class="count-pill">${archivePhotos.length}</span>
        </div>
        ${renderPhotoGroups(archivePhotos, state.dexGroupMode, "dex")}
      </section>
    `;
    scheduleOfflineMediaCoverageRefresh();
  }

  function renderAircraftSquadronSection(entry) {
    if (!entry.squadrons.length) {
      return "";
    }

    return `
      <div class="aircraft-archive-results">
        <div class="aircraft-archive-results-heading">
          <div>
            <p class="eyebrow">By unit</p>
            <h3>${escapeHtml(entryUnitNoun(entry, 2, true))}</h3>
          </div>
          <span class="count-pill">${entry.squadrons.length}</span>
        </div>
        <div class="squadron-grid">
          ${entry.squadrons
            .map((squadron) => renderSquadronRow(squadron, aircraftPhotoGroupTargetId("squadron", squadron.id)))
            .join("")}
        </div>
      </div>
    `;
  }

  function aircraftLocationGroups(photos) {
    const groups = new Map();
    photos.forEach((photo) => {
      const name = photo.locationName || "Unknown location";
      const pinId = aircraftPhotoLocationId(photo);
      const key = pinId || normalizeKey(name);
      if (!groups.has(key)) {
        groups.set(key, {
          name,
          pinId,
          count: 0
        });
      }
      groups.get(key).count += 1;
    });

    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  function aircraftPhotoLocationId(photo) {
    const candidatePinId = photo?.pinId ? String(photo.pinId) : "";
    return candidatePinId && state.pinById.has(candidatePinId)
      ? candidatePinId
      : pinIdFromLocation(photo?.locationName);
  }

  function aircraftPhotoGroupTargetId(mode, groupOrId) {
    if (mode === "location") {
      const locationId = typeof groupOrId === "string"
        ? groupOrId
        : groupOrId?.pinId || aircraftPhotoLocationId(groupOrId?.photos?.[0]);
      const fallbackName = typeof groupOrId === "string" ? groupOrId : groupOrId?.name;
      const key = locationId || fallbackName;
      return key ? `aircraft-photo-location-${slugify(key)}` : "";
    }

    const firstPhoto = typeof groupOrId === "string" ? null : groupOrId?.photos?.[0];
    const unitId = typeof groupOrId === "string"
      ? groupOrId
      : firstPhoto?.squadronId || (firstPhoto ? squadronPageIdForPhoto(firstPhoto) : "");
    return unitId ? `aircraft-photo-unit-${slugify(unitId)}` : "";
  }

  function renderAircraftLocationSection(locations, selectedLocationId = "") {
    if (!locations.length) {
      return "";
    }

    return `
      <div class="aircraft-archive-results">
        <div class="aircraft-archive-results-heading">
          <div>
            <p class="eyebrow">By place</p>
            <h3>Locations</h3>
          </div>
          <span class="count-pill">${locations.length}</span>
        </div>
        <div class="squadron-grid">
          ${locations.map((location) => renderAircraftLocationRow(location, selectedLocationId)).join("")}
        </div>
      </div>
    `;
  }

  function renderAircraftLocationRow(location, selectedLocationId = "") {
    const pin = location.pinId ? state.pinById.get(location.pinId) : null;
    const locationMeta = [pin?.icao, pin?.country].filter(Boolean).join(" - ") || "Location archive";
    const photoLabel = `${location.count} photo${location.count === 1 ? "" : "s"}`;
    const isSelected = Boolean(location.pinId && location.pinId === selectedLocationId);
    const targetId = aircraftPhotoGroupTargetId("location", location);
    const rowTag = targetId ? "button" : "div";
    const rowClass = `squadron-row aircraft-location-row${targetId ? " is-clickable" : ""}${isSelected ? " is-selected" : ""}`;
    const rowAttributes = targetId
      ? ` type="button" data-aircraft-photo-target="${escapeAttr(targetId)}" aria-label="Show ${escapeAttr(location.name)} photos"${isSelected ? ' aria-current="location"' : ""}`
      : "";

    return `
      <${rowTag} class="${rowClass}"${rowAttributes}>
        <span class="aircraft-location-copy">
          <strong>${escapeHtml(location.name)}</strong>
          <span>${escapeHtml(locationMeta)} - ${escapeHtml(photoLabel)}</span>
        </span>
        <span class="count-pill">${location.count}</span>
      </${rowTag}>
    `;
  }

  function renderSquadronRow(squadron, targetId = "") {
    const logoContent = squadron.logo
      ? `<img class="squadron-logo" src="${escapeAttr(squadron.logo)}" alt="${escapeAttr(squadron.name)} logo">`
      : `<span class="logo-fallback" aria-hidden="true">${escapeHtml(initials(squadron.name))}</span>`;
    const photoCount = Number(squadron.photoCount || 0);
    const unitLabel = squadron.unitLabel || unitDisplayLabel(squadron.unitType);
    const rowTag = targetId ? "button" : "div";
    const rowClass = `squadron-row${targetId ? " is-clickable" : ""}`;
    const rowAttributes = targetId
      ? ` type="button" data-aircraft-photo-target="${escapeAttr(targetId)}" aria-label="Show ${escapeAttr(squadron.name)} photos"`
      : "";

    return `
      <${rowTag} class="${rowClass}"${rowAttributes}>
        ${logoContent}
        <span>
          <strong>${escapeHtml(squadron.name)}</strong>
          <span>${escapeHtml(unitLabel)} - ${escapeHtml(squadron.country || "Country not set")} - ${photoCount} photo${photoCount === 1 ? "" : "s"}</span>
        </span>
      </${rowTag}>
    `;
  }

  function archiveStat(label, value) {
    return `
      <div>
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value)}</dd>
      </div>
    `;
  }

  function renderPhotoGroups(photos, mode, context) {
    if (!photos.length) {
      return '<div class="empty-state">No photos found for this selection yet.</div>';
    }
    const groups = groupPhotos(photos, mode);

    return `
      <div class="photo-groups photo-groups-${escapeAttr(context)}${groups.length === 1 ? " is-single-group" : ""}">
        ${groups
          .map(
            (group, index) => {
              const targetId = aircraftPhotoGroupTargetId(mode, group);
              const locationId = mode === "location" ? aircraftPhotoLocationId(group.photos[0]) : "";
              const location = locationId ? state.pinById.get(locationId) : null;
              const squadronId = mode === "squadron" ? squadronPageIdForPhoto(group.photos[0]) : "";
              const groupPageAction = locationId
                ? renderPhotoGroupPageButton({
                    className: "photo-group-location-button",
                    dataName: "data-location-page-id",
                    id: locationId,
                    label: `Open ${location?.name || group.name} location page`
                  })
                : squadronId
                  ? renderPhotoGroupPageButton({
                      className: "photo-group-squadron-button",
                      dataName: "data-squadron-id",
                      id: squadronId,
                      label: `Open ${group.name} squadron page`
                    })
                  : "";
              return `
              <section${targetId ? ` id="${escapeAttr(targetId)}"` : ""}>
                <div class="group-header">
                  <div class="photo-group-title">
                    <h3>${escapeHtml(group.name)}</h3>
                    ${groupPageAction}
                  </div>
                  <span class="count-pill">${group.photos.length}</span>
                </div>
                ${renderProgressivePhotoGrid(group.photos, context, `${context}-${mode}-${index}-${group.name}`)}
              </section>
              `;
            }
          )
          .join("")}
      </div>
    `;
  }

  function renderPhotoGroupPageButton({ className, dataName, id, label }) {
    return `
      <button
        class="icon-button photo-group-title-button ${escapeAttr(className)}"
        type="button"
        ${dataName}="${escapeAttr(id)}"
        title="${escapeAttr(label)}"
        aria-label="${escapeAttr(label)}"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"></path></svg>
      </button>
    `;
  }

  function groupPhotoRecords(photos, descriptorForPhoto, photoSorter, groupSorter) {
    const groups = new Map();
    photos.forEach((photo) => {
      const descriptor = descriptorForPhoto(photo);
      if (!descriptor) {
        return;
      }
      const { key, ...details } = descriptor;
      if (!groups.has(key)) {
        groups.set(key, { ...details, key, photos: [] });
      }
      const group = groups.get(key);
      if (!group.logo && details.logo) {
        group.logo = details.logo;
      }
      if (!group.aircraftId && details.aircraftId) {
        group.aircraftId = details.aircraftId;
      }
      group.photos.push(photo);
    });

    return Array.from(groups.values())
      .map((group) => ({ ...group, photos: group.photos.sort(photoSorter) }))
      .sort(groupSorter);
  }

  function sortPhotosOldest(a, b) {
    const timeDiff = (a.sortTime || 0) - (b.sortTime || 0);
    if (timeDiff) {
      return timeDiff;
    }
    return `${photoSubjectLabel(a)} ${a.locationName}`.localeCompare(`${photoSubjectLabel(b)} ${b.locationName}`);
  }

  function chronologicalGroupSorter(a, b) {
    const firstA = firstChronologicalPhoto(a.photos);
    const firstB = firstChronologicalPhoto(b.photos);
    const timeDiff = (firstA?.sortTime || 0) - (firstB?.sortTime || 0);
    if (timeDiff) {
      return timeDiff;
    }
    const firstLabelA = firstA ? `${photoSubjectLabel(firstA)} ${firstA.locationName}` : a.title;
    const firstLabelB = firstB ? `${photoSubjectLabel(firstB)} ${firstB.locationName}` : b.title;
    return firstLabelA.localeCompare(firstLabelB) || a.title.localeCompare(b.title);
  }

  function reverseChronologicalGroupSorter(a, b) {
    return chronologicalGroupSorter(b, a);
  }

  function firstChronologicalPhoto(photos) {
    return (photos || []).reduce((first, photo) => {
      if (!first || sortPhotosOldest(photo, first) < 0) {
        return photo;
      }
      return first;
    }, null);
  }

  function aircraftArchiveGroupSorter(a, b) {
    const kindA = a.groupKind === "unit" ? 0 : 1;
    const kindB = b.groupKind === "unit" ? 0 : 1;
    return kindA - kindB || chronologicalGroupSorter(a, b);
  }

  function aircraftTypePhotoGroups(photos) {
    return groupPhotoRecords(
      photos,
      (photo) => {
        const isAircraft = photo.tagScope === "aircraft";
        const squadron = isAircraft ? null : squadronForPhoto(photo);
        const unitType = squadron?.unitType || photo.unitType;
        const title = isAircraft
          ? photo.aircraftType || "Unknown aircraft"
          : squadron?.name || photo.squadronName || unknownUnitName(unitType);
        return {
          key: isAircraft
            ? `aircraft-type-${normalizeKey(title)}`
            : `unit-${normalizeKey(`${squadron?.id || photo.country || ""}-${title}-${unitType || ""}`)}`,
          title,
          eyebrow: isAircraft ? "Aircraft type" : squadron?.unitLabel || photo.unitLabel || unitDisplayLabel(unitType),
          groupKind: isAircraft ? "aircraft" : "unit"
        };
      },
      sortPhotos,
      aircraftArchiveGroupSorter
    );
  }

  function renderAircraftTypePhotoGroups(photos, context, galleryKey) {
    if (!photos.length) {
      return '<div class="empty-state">No photos found for this section yet.</div>';
    }
    const groups = aircraftTypePhotoGroups(photos);

    return `
      <div class="aircraft-type-photo-groups${groups.length === 1 ? " is-single-group" : ""}">
        ${groups.map((group, index) => `
          <section class="aircraft-type-photo-group">
            <div class="group-header">
              <div>
                ${group.eyebrow ? `<p class="eyebrow">${escapeHtml(group.eyebrow)}</p>` : ""}
                <h3>${escapeHtml(group.title)}</h3>
              </div>
              <span class="count-pill">${group.photos.length}</span>
            </div>
            ${renderProgressivePhotoGrid(
              group.photos,
              context,
              `${galleryKey}-${index}-${group.key}`,
              "detail-photo-grid aircraft-type-photo-grid"
            )}
          </section>
        `).join("")}
      </div>
    `;
  }

  function renderResponsivePhotoImage(photo, alt, options = {}) {
    if (!photo) {
      return "";
    }
    const fullResolution = options.fullResolution === true;
    const source = (fullResolution ? photo.image || photo.thumbnail : photo.thumbnail || photo.image) || "";
    if (!source) {
      return "";
    }

    const thumbnailSize = parseImageSize(photo.thumbnailSize);
    const processedSize = parseImageSize(photo.processedSize);
    const candidates = [];
    if (fullResolution) {
      if (photo.thumbnail && thumbnailSize.width) {
        candidates.push(`${escapeAttr(photo.thumbnail)} ${thumbnailSize.width}w`);
      }
      if (photo.image && processedSize.width) {
        candidates.push(`${escapeAttr(photo.image)} ${processedSize.width}w`);
      }
    } else {
      if (photo.thumbnail && thumbnailSize.width) {
        candidates.push(`${escapeAttr(photo.thumbnail)} ${thumbnailSize.width}w`);
      }
      if (photo.image && processedSize.width && photo.image !== photo.thumbnail) {
        candidates.push(`${escapeAttr(photo.image)} ${processedSize.width}w`);
      }
    }

    const dimensions = fullResolution && processedSize.width
      ? processedSize
      : thumbnailSize.width
        ? thumbnailSize
        : processedSize;
    const className = options.className ? ` class="${escapeAttr(options.className)}"` : "";
    const loading = options.eager ? "eager" : "lazy";
    const priority = options.eager ? ' fetchpriority="high"' : "";
    const srcset = candidates.length > 1 ? ` srcset="${candidates.join(", ")}"` : "";
    const sizes = candidates.length > 1 && options.sizes ? ` sizes="${escapeAttr(options.sizes)}"` : "";
    const width = dimensions.width ? ` width="${dimensions.width}"` : "";
    const height = dimensions.height ? ` height="${dimensions.height}"` : "";
    return `<img${className} data-photo-media="photo" data-photo-id="${escapeAttr(photo.id)}" src="${escapeAttr(source)}"${srcset}${sizes}${width}${height} loading="${loading}" decoding="async"${priority} alt="${escapeAttr(alt)}">`;
  }

  function parseImageSize(value) {
    const match = String(value || "").match(/(\d+)\s*x\s*(\d+)/i);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
  }

  function renderPhotoCard(photo, context, options = {}) {
    const label = `${photoSubjectLabel(photo)} at ${photo.locationName}`;
    return `
      <button class="photo-card" type="button" data-photo-id="${escapeAttr(photo.id)}" data-photo-context="${escapeAttr(context)}" aria-label="Open ${escapeAttr(label)}">
        ${renderResponsivePhotoImage(photo, label, {
          sizes: options.fullResolution
            ? "100vw"
            : "(max-width: 520px) 100vw, (max-width: 1040px) 50vw, 360px",
          fullResolution: options.fullResolution === true
        })}
        <span class="photo-body">
          ${options.hidePhotoSubject ? "" : `<strong>${escapeHtml(photoSubjectLabel(photo))}</strong>`}
          ${photo.livery ? `<span class="photo-livery">${escapeHtml(photo.livery)}</span>` : ""}
          <span class="photo-meta">
            <span class="photo-context">${escapeHtml(photoContextLabel(photo))}</span>
            <span class="photo-meta-separator" aria-hidden="true"> - </span>
            <span class="photo-date">${escapeHtml(displayPhotoDate(photo))}</span>
          </span>
        </span>
      </button>
    `;
  }

  function segmentButton(label, value, activeValue, dataName, targetId = "") {
    const isActive = value === activeValue;
    const activeClass = isActive ? " is-active" : "";
    const targetAttributes = targetId
      ? ` data-dex-group-target="${escapeAttr(targetId)}" aria-controls="${escapeAttr(targetId)}"`
      : "";
    return `<button class="segment-button${activeClass}" type="button" role="radio" aria-checked="${isActive ? "true" : "false"}" ${dataName}="${escapeAttr(value)}"${targetAttributes}>${escapeHtml(label)}</button>`;
  }

  function selectPin(pinId, options = {}) {
    if (!document.getElementById("mapView")) {
      navigateToViewPage("mapView", `location=${encodeURIComponent(pinId)}`);
      return;
    }
    const previousPinId = state.selectedPinId;
    state.selectedPinId = pinId;
    if (previousPinId !== pinId) {
      state.expandedLocationGroupKeys.clear();
    }
    renderLocations();
    updateRecentLocationNav();
    updateMobileMapHeader();
    updateActiveMapMarker(previousPinId, pinId);

    if (!isMobileMapLayout()) {
      renderMapResults();
      refreshMapLayout();
    } else if (els.mapResults) {
      delete els.mapResults.dataset.pinId;
      scheduleMapCalloutRefresh(120);
    }

    if (options.updateHash !== false) {
      updateDeepLink("location", pinId);
    }

    if (options.pan !== false) {
      focusMapPin(pinId);
    }

    if (isMobileMapLayout() && options.openPanel !== false) {
      setMapPanel("results", { snap: "expanded" });
    } else if (!isMobileMapLayout() && options.openDossier !== false) {
      setMapDossierOpen(true);
    }
  }

  function selectLocationPage(pinId, options = {}) {
    const pin = state.pinById.get(pinId);
    if (!pin) {
      return;
    }
    if (!document.getElementById("locationDetailView")) {
      navigateToViewPage("locationDetailView", `location=${encodeURIComponent(pin.id)}&detail=1`);
      return;
    }
    enterDetailView({
      backView: "mapView",
      detailView: "locationDetailView",
      kind: "location",
      entityId: pin.id,
      sourceElement: options.transitionSource,
      update: () => {
        selectPin(pin.id, {
          updateHash: false,
          pan: false,
          openPanel: false,
          openDossier: false
        });
        setActiveTab("locationDetailView", { updateHash: false });
        renderLocationPage();
        if (options.updateHash !== false) {
          updateLocationDetailLink(pin.id);
        }
        if (options.scroll !== false) {
          window.scrollTo({ top: 0, behavior: "auto" });
        }
      }
    });
  }

  function updateActiveMapMarker(previousPinId, nextPinId) {
    const updateMarker = (marker, isActive, activeOffset) => {
      if (!marker) {
        return;
      }
      marker.setZIndexOffset(isActive ? activeOffset : 0);
      const element = marker.getElement();
      if (element) {
        element.classList.toggle("is-active", isActive);
        element.querySelector(".spotterdex-marker-label")?.classList.toggle("is-active", isActive);
      }
    };

    if (previousPinId && previousPinId !== nextPinId) {
      updateMarker(state.markersByPinId.get(previousPinId), false, 800);
      updateMarker(state.mapLabelsByPinId.get(previousPinId), false, 900);
    }
    if (nextPinId) {
      updateMarker(state.markersByPinId.get(nextPinId), true, 800);
      updateMarker(state.mapLabelsByPinId.get(nextPinId), true, 900);
    }
    state.activeMapMarkerId = nextPinId || null;
  }

  function selectAircraft(aircraftId, options = {}) {
    noteMeaningfulIosInstallInteraction();
    const group = normalizeAircraftDetailGroup(options.group ?? state.dexGroupMode);
    const aircraftChanged = state.selectedAircraftId !== aircraftId;
    if (options.locationId !== undefined) {
      state.selectedAircraftLocationId = String(options.locationId || "");
    } else if (aircraftChanged) {
      state.selectedAircraftLocationId = "";
    }
    if (!document.getElementById("aircraftDetailView")) {
      navigateToViewPage(
        "aircraftDetailView",
        aircraftDetailHash(aircraftId, group, state.selectedAircraftLocationId)
      );
      return;
    }
    enterDetailView({
      backView: "dexView",
      detailView: "aircraftDetailView",
      kind: "aircraft",
      entityId: aircraftId,
      sourceElement: options.focusLocation ? null : options.transitionSource,
      update: () => {
        state.dexGroupMode = group;
        state.selectedAircraftId = aircraftId;
        setActiveTab("aircraftDetailView", { updateHash: false });
        renderAircraftDetail();
        if (options.updateHash !== false) {
          updateAircraftDetailLink(aircraftId, { group });
        }
        if (options.scroll !== false) {
          window.scrollTo({ top: 0, behavior: "auto" });
        }
        if (options.focusLocation && state.selectedAircraftLocationId) {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              document.getElementById("aircraftPhotoArchive")?.scrollIntoView({
                block: "start",
                behavior: options.initial || isReducedMotion() ? "auto" : "smooth"
              });
            });
          });
        }
      }
    });
  }

  function selectSquadron(squadronId, options = {}) {
    if (!document.getElementById("squadronDetailView")) {
      navigateToViewPage("squadronDetailView", `squadron=${encodeURIComponent(squadronId)}`);
      return;
    }
    enterDetailView({
      backView: "squadronsView",
      detailView: "squadronDetailView",
      kind: "squadron",
      entityId: squadronId,
      sourceElement: options.transitionSource,
      update: () => {
        state.selectedSquadronId = squadronId;
        setActiveTab("squadronDetailView", { updateHash: false });
        renderSquadronDetail();
        if (options.updateHash !== false) {
          updateDeepLink("squadron", squadronId);
        }
        if (options.scroll !== false) {
          window.scrollTo({ top: 0, behavior: "auto" });
        }
      }
    });
  }

  function selectAirshow(airshowId, options = {}) {
    const airshow = state.airshowById.get(airshowId);
    if (!airshow) {
      return;
    }
    if (!document.getElementById("airshowDetailView")) {
      navigateToViewPage("airshowDetailView", `airshow=${encodeURIComponent(airshow.id)}`);
      return;
    }
    enterDetailView({
      backView: "airshowsView",
      detailView: "airshowDetailView",
      kind: "airshow",
      entityId: airshow.id,
      sourceElement: options.transitionSource,
      update: () => {
        state.selectedAirshowId = airshowId;
        setActiveTab("airshowDetailView", { updateHash: false });
        renderAirshowDetail();

        if (options.updateHash !== false) {
          updateDeepLink("airshow", airshowId);
        }

        if (options.scroll !== false) {
          window.scrollTo({ top: 0, behavior: "auto" });
        }
      }
    });
  }

  function selectStatsSection(section, options = {}) {
    const statsSection = normalizeStatsSection(section);
    if (!document.getElementById("statsView")) {
      navigateToViewPage("statsView", `stats=${encodeURIComponent(statsSection)}`);
      return;
    }
    state.statsSection = statsSection;
    setActiveTab("statsView", { updateHash: false });
    updateStatsSectionNav();

    if (statsSection === "exif") {
      ensureStatsExifRendered().then(() => {
        if (options.scroll !== false) {
          scrollStatsSection(statsSection, options);
        }
      });
    }

    if (options.updateHash !== false) {
      updateDeepLink("stats", statsSection);
    }

    if (statsSection !== "exif" && options.scroll !== false) {
      scrollStatsSection(statsSection, options);
    }
  }

  function normalizeStatsSection(section) {
    const key = normalizeKey(section || "summary");
    return key === "exif" || key === "camera" || key === "photography" ? "exif" : "summary";
  }

  function scrollStatsSection(section, options = {}) {
    const target = section === "exif" ? els.exifDashboard : els.statsDashboard;
    if (!target) {
      return;
    }

    window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: options.initial ? "auto" : "smooth", block: "start" });
    });
  }

  function updateStatsSectionNav() {
    if (!els.statsSectionNav) {
      return;
    }
    els.statsSectionNav.querySelectorAll("[data-stats-section]").forEach((button) => {
      const isActive = normalizeStatsSection(button.dataset.statsSection) === state.statsSection;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }

  function photosForPin(pin) {
    return state.photosByPinId.get(pin.id) || EMPTY_PHOTOS;
  }

  function photosForAircraft(entry) {
    const ids = new Set(entry.photoIds || []);
    return state.data.photos
      .filter((photo) => photo.aircraftId === entry.id || ids.has(photo.id))
      .sort(sortPhotos);
  }

  function photosForSquadronRecord(squadron) {
    const ids = new Set(squadron.photoIds || []);
    return state.data.photos
      .filter((photo) => ids.has(photo.id) && (photo.image || photo.thumbnail))
      .sort(sortPhotos);
  }

  function recentLocations() {
    return state.data.pins
      .filter((pin) => pin.enabled)
      .map((pin) => {
        const photos = photosForPin(pin);
        const latestPhoto = photos[0] || null;
        return {
          pin,
          photos,
          latestDate: latestPhoto ? latestPhoto.date || latestPhoto.year || latestPhoto.sortDate : "",
          latestTime: latestPhoto ? latestPhoto.sortTime || 0 : 0
        };
      })
      .filter((location) => location.photos.length)
      .sort((a, b) => {
        const timeDiff = b.latestTime - a.latestTime;
        if (timeDiff) {
          return timeDiff;
        }
        return a.pin.name.localeCompare(b.pin.name);
      });
  }

  function recentPhotos(limit) {
    return state.data.photos
      .slice()
      .sort(sortPhotos)
      .slice(0, limit);
  }

  function mapMarkerIcon(pin, isActive) {
    return window.L.divIcon({
      className: `spotterdex-marker-shell${isActive ? " is-active" : ""}`,
      html: `<span class="spotterdex-marker-dot">${escapeHtml(countryFlag(pin.country))}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  function mapPinLabel(pin) {
    if (!isMobileMapLayout()) {
      return pin.name;
    }
    if (pin.icao) {
      return pin.icao;
    }
    const name = String(pin.name || "Location");
    return name.length > 18 ? `${name.slice(0, 15)}...` : name;
  }

  function mapLeaderIcon(callout) {
    return window.L.divIcon({
      className: "spotterdex-marker-leader-shell",
      html: renderMapLeader(callout),
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  function mapLabelIcon(pin, isActive, callout, includeLeader = false) {
    return window.L.divIcon({
      className: "spotterdex-marker-label-shell",
      html: `${includeLeader ? renderMapLeader(callout) : ""}${renderMapMarkerLabel(mapPinLabel(pin), pin.name, callout, isActive)}`,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  function renderMapLeader(callout) {
    const { leader } = callout;
    return `
      <svg
        class="spotterdex-marker-leader"
        aria-hidden="true"
        width="${leader.width}"
        height="${leader.height}"
        viewBox="0 0 ${leader.width} ${leader.height}"
        style="--leader-left: ${leader.left}px; --leader-top: ${leader.top}px;"
      >
        <polyline points="${leader.points}"></polyline>
      </svg>
    `;
  }

  function renderMapMarkerLabel(title, fullTitle, callout, isActive = false) {
    return `
      <span
        class="spotterdex-marker-label${isActive ? " is-active" : ""}"
        style="--label-left: ${callout.labelLeft}px; --label-top: ${callout.labelTop}px; --label-width: ${callout.width}px; --label-height: ${callout.height}px;"
        title="${escapeAttr(fullTitle)}"
      >
        <span class="spotterdex-marker-title">${escapeHtml(title)}</span>
      </span>
    `;
  }

  function mapLocationPreview(pins) {
    const cacheKey = pins.length === 1 ? pins[0].id : "";
    if (cacheKey && state.mapPreviewCache.has(cacheKey)) {
      return state.mapPreviewCache.get(cacheKey);
    }

    const photos = pins.length === 1 ? photosForPin(pins[0]) : pins.flatMap((pin) => photosForPin(pin));
    const logos = [];
    const seenUnits = new Set();
    const familyById = new Map();

    photos.forEach((photo) => {
      const squadron = squadronForPhoto(photo);
      const unitKey = squadron ? normalizeKey(`${squadron.country || photo.country || ""}-${squadron.name || ""}`) : "";
      if (squadron && squadron.logo && unitKey && !seenUnits.has(unitKey)) {
        seenUnits.add(unitKey);
        logos.push({
          src: squadron.logo,
          alt: `${squadron.name} logo`
        });
      }

      const family = aircraftFamilyForPhoto(photo);
      if (family && !familyById.has(family.id)) {
        familyById.set(family.id, family);
      }
    });

    const preview = {
      logos: logos.slice(0, 4),
      families: Array.from(familyById.values()).slice(0, 3)
    };
    if (cacheKey) {
      state.mapPreviewCache.set(cacheKey, preview);
    }
    return preview;
  }

  function aircraftFamilyForPhoto(photo) {
    const configuredFamily = normalizeAircraftFamily(photo.aircraftFamily);
    if (configuredFamily) {
      return aircraftFamilyAsset(configuredFamily, AIRCRAFT_FAMILY_LABELS.get(configuredFamily));
    }

    const type = normalizeText(photo.aircraftType);
    if (/\b(ah|uh|ch|mh|sh)-?\d|apache|helicopter|rotor|uh-60|ah-64/.test(type)) {
      return aircraftFamilyAsset("helicopter", "Helicopter");
    }
    if (/\bf-?\d|fighter|eagle|falcon|hornet|raptor|typhoon|rafale|mirage/.test(type)) {
      return aircraftFamilyAsset("fighter", "Fighter");
    }
    if (/747|sentry|airlift|cargo|transport|tanker|freighter|heavy|c-2|ec-2|rc-2|u-125/.test(type)) {
      return aircraftFamilyAsset("heavy", "Heavy");
    }
    return null;
  }

  function aircraftFamilyAsset(id, label) {
    const variant = "light";
    const extension = id === "helicopter" ? "gif" : "png";
    const stem = id === "helicopter" ? "aircraft-family-helicopter-top" : `aircraft-family-${id}`;
    return {
      id,
      label,
      icon: `assets/icons/aircraft-family-${id}.png`,
      mapIcon: `assets/icons/${stem}-${variant}.${extension}`,
      darkIcon: `assets/icons/${stem}-dark.${extension}`,
      lightModeIcon: `assets/icons/${stem}-dark.${extension}`
    };
  }

  function collectPhotoIdentities(photos) {
    const families = new Map();
    const units = new Map();
    photos.forEach((photo) => {
      const family = aircraftFamilyForPhoto(photo);
      if (family && !families.has(family.id)) {
        families.set(family.id, family);
      }
      const squadron = squadronForPhoto(photo);
      if (!squadron) {
        return;
      }
      const unitId = squadronPageIdForUnit(squadron)
        || normalizeKey(`${squadron.country || photo.country || ""}-${squadron.name}`);
      if (!units.has(unitId)) {
        units.set(unitId, squadron);
      }
    });
    return { families: Array.from(families.values()), units: Array.from(units.values()) };
  }

  function renderPhotoIdentityMarks(families, units, options = {}) {
    const unitMarks = (units || [])
      .filter((unit) => unit.logo)
      .slice(0, options.unitLimit ?? 6)
      .map((unit) => {
        const imageAttributes = options.unitImageAttributes ? ` ${options.unitImageAttributes}` : "";
        return `
          <span class="${options.unitClass}" title="${escapeAttr(`${unit.name} logo`)}">
            <img src="${escapeAttr(unit.logo)}"${imageAttributes} alt="${escapeAttr(`${unit.name} logo`)}">
          </span>
        `;
      });
    const familyMarks = !unitMarks.length && options.includeFamilies !== false
      ? (families || []).slice(0, options.familyLimit ?? 3).map((family) => `
          <span class="${options.familyClass}" title="${escapeAttr(family.label)}">
            <img src="${escapeAttr(options.familyIcon(family))}" alt="${escapeAttr(family.label)}">
          </span>
        `)
      : [];
    if (!familyMarks.length && !unitMarks.length) {
      return "";
    }
    const unitTypes = new Set((units || []).map((unit) => normalizeUnitType(unit.unitType)));
    const hasSquadrons = unitTypes.has("squadron");
    const hasOrganisations = unitTypes.has("organisation");
    const unitLabel = hasSquadrons && hasOrganisations
      ? "Squadron and organisation logos"
      : hasOrganisations
        ? "Organisation logos"
        : "Squadron logos";
    const label = familyMarks.length && unitMarks.length
      ? options.mixedLabel || "Aircraft families and squadron logos"
      : familyMarks.length
        ? "Aircraft family icons"
        : unitLabel;
    return `<span class="${options.wrapperClass}" aria-label="${escapeAttr(label)}">${familyMarks.join("")}${unitMarks.join("")}</span>`;
  }

  function focusMapPin(pinId) {
    if (!state.map) {
      state.pendingMapFocusId = pinId || null;
      return;
    }

    const pin = state.pinById.get(pinId);
    if (!pin) {
      return;
    }

    const currentZoom = state.map.getZoom();
    if (!Number.isFinite(currentZoom)) {
      state.map.setView([pin.lat, pin.lon], 11, { animate: false });
      renderPins();
      return;
    }
    const nextZoom = Math.max(currentZoom, 11);
    if (isMobileMapLayout()) {
      state.map.setView([pin.lat, pin.lon], nextZoom, { animate: false });
      return;
    }
    state.map.flyTo([pin.lat, pin.lon], nextZoom, {
      animate: true,
      duration: 0.7
    });
  }

  function pinIdFromLocation(locationName) {
    const key = normalizeKey(locationName);
    const pin = state.data.pins.find((candidate) => normalizeKey(candidate.name) === key);
    return pin ? pin.id : null;
  }

  function groupPhotos(photos, mode) {
    const groups = new Map();
    photos.forEach((photo) => {
      let name = "Unsorted";
      if (mode === "squadron") {
        name = photo.squadronName || (photo.tagScope === "location" ? "Location images" : unknownUnitName(photo.unitType));
      } else if (mode === "location") {
        name = photo.locationName || "Unknown location";
      } else {
        name = photoSubjectLabel(photo);
      }
      if (!groups.has(name)) {
        groups.set(name, []);
      }
      groups.get(name).push(photo);
    });

    return Array.from(groups.entries())
      .map(([name, groupPhotosForName]) => ({
        name,
        photos: groupPhotosForName.sort(sortPhotos)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function sortPhotos(a, b) {
    const timeDiff = (b.sortTime || 0) - (a.sortTime || 0);
    if (timeDiff) {
      return timeDiff;
    }
    return `${photoSubjectLabel(a)} ${a.locationName}`.localeCompare(`${photoSubjectLabel(b)} ${b.locationName}`);
  }

  function fitMapToPins(options = {}) {
    if (!state.map || !window.L) {
      initializeMapWhenReady();
      return;
    }

    state.map.invalidateSize({ pan: false });
    const pins = state.enabledPins;
    if (!pins.length) {
      state.map.setView([20, 0], 2);
      refreshMapLayout();
      return;
    }

    const bounds = window.L.latLngBounds(pins.map((pin) => [pin.lat, pin.lon]));
    state.map.fitBounds(bounds, {
      ...mapFitPadding(),
      maxZoom: 9,
      animate: !isMobileMapLayout() && options.animate !== false
    });
    refreshMapLayout();

  }

  function mapFitPadding() {
    const base = 36;
    const mapRect = els.worldMap ? els.worldMap.getBoundingClientRect() : null;
    if (!mapRect || !mapRect.width || !mapRect.height) {
      return { padding: [base, base] };
    }

    const overlaps = [els.mapControlPanel, els.mapResults]
      .map((panel) => mapPanelOverlap(panel, mapRect))
      .reduce(
        (total, overlap) => ({
          left: total.left + overlap.left,
          right: total.right + overlap.right
        }),
        { left: 0, right: 0 }
      );

    let leftPadding = base + overlaps.left;
    let rightPadding = base + overlaps.right;
    const maxCombinedHorizontalPadding = Math.max(base * 2, mapRect.width * 0.82);
    const combinedHorizontalPadding = leftPadding + rightPadding;
    if (combinedHorizontalPadding > maxCombinedHorizontalPadding) {
      const scale = maxCombinedHorizontalPadding / combinedHorizontalPadding;
      leftPadding *= scale;
      rightPadding *= scale;
    }

    return {
      paddingTopLeft: [Math.round(leftPadding), base],
      paddingBottomRight: [Math.round(rightPadding), base]
    };
  }

  function mapPanelOverlap(panel, mapRect) {
    const bounds = mapPanelCalloutBounds(panel, mapRect);
    if (!bounds) {
      return { left: 0, right: 0 };
    }
    if (panel === els.mapControlPanel) {
      return { left: bounds.right, right: 0 };
    }
    return { left: 0, right: mapRect.width - bounds.left };
  }

  function openViewer(photoId, context, options = {}) {
    const photo = state.photoById.get(photoId);
    if (!photo) {
      return;
    }
    ensurePhotoViewer();

    const viewerContext = context || "map";
    const collection = viewerContext === "dex"
      ? currentDexPhotoIds()
      : viewerContext === "dex-family"
        ? currentDexFamilyPhotoIds()
      : viewerContext === "recent"
        ? currentRecentPhotoIds()
        : viewerContext === "stats"
          ? state.statsPhotoIds
        : viewerContext === "squadron"
          ? currentSquadronPhotoIds()
        : viewerContext === "location"
            ? currentLocationPhotoIds()
          : viewerContext === "airshow"
            ? currentAirshowPhotoIds()
          : viewerContext === "photo"
            ? [photoId]
            : currentMapPhotoIds();
    state.activePhotoIds = collection.includes(photoId) ? collection : [photoId];
    state.activePhotoIndex = Math.max(0, state.activePhotoIds.indexOf(photoId));
    state.activePhotoContext = viewerContext;
    state.viewerReturnStory = Number.isInteger(options.storySegmentIndex)
      ? {eventId: state.selectedAirshowId, segmentIndex: options.storySegmentIndex}
      : null;
    if (viewerContext !== "stats") {
      state.statsPhotoLabel = "";
    }
    state.viewerInfoOpen = false;
    resetViewerTransform();

    const wasClosed = !isViewerOpen();
    if (wasClosed && document.activeElement instanceof HTMLElement) {
      state.viewerReturnFocus = document.activeElement;
    }
    els.photoViewer.hidden = false;
    document.body.classList.add("is-viewer-open");
    activateOverlayViewportSync();
    setViewerBackgroundInert(true);
    noteMeaningfulIosInstallInteraction();
    updateViewerInfoState();
    updateMapPanelCoach();
    renderViewerPhoto();
    if (wasClosed) {
      window.requestAnimationFrame(() => document.getElementById("closeViewerButton")?.focus());
    }
    hydrateFullPhotoData().then((wasUpdated) => {
      if (wasUpdated && isViewerOpen()) {
        renderViewerPhoto();
      }
    });

    if (options.updateHash !== false) {
      const wasPhotoRoute = new URLSearchParams(window.location.hash.replace(/^#/, "")).has("photo");
      const changed = updateDeepLink("photo", photoId);
      state.viewerHistoryPushed = Boolean(changed && !wasPhotoRoute);
    } else {
      state.viewerHistoryPushed = false;
    }
  }

  function hydrateFullPhotoData() {
    if (state.data.payload === "full") {
      return Promise.resolve(false);
    }
    if (state.fullDataPromise) {
      return state.fullDataPromise;
    }

    state.fullDataPromise = fetch("data/spotterdex.json")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Could not load full photo metadata");
        }
        return response.json();
      })
      .then((fullData) => {
        const fullPhotos = new Map(normalizedPhotoViewModels(fullData).map((photo) => [photo.id, photo]));
        state.data.photos.forEach((photo) => Object.assign(photo, fullPhotos.get(photo.id) || {}));
        state.data.payload = "full";
        return true;
      })
      .catch((error) => {
        console.warn(error);
        state.fullDataPromise = null;
        return false;
      });
    return state.fullDataPromise;
  }

  function currentAirshowPhotoIds() {
    const airshow = state.airshowById.get(state.selectedAirshowId);
    return airshow ? photosForAirshow(airshow).map((photo) => photo.id) : [];
  }

  function openStatsPhotoSet(kind, value, label) {
    const photos = state.data.photos
      .filter((photo) => statsPhotoMatches(photo, kind, value))
      .sort(sortPhotos);
    if (!photos.length) {
      return;
    }
    state.statsPhotoIds = photos.map((photo) => photo.id);
    state.statsPhotoLabel = label;
    openViewer(photos[0].id, "stats");
  }

  function statsPhotoMatches(photo, kind, value) {
    const exif = photo.exif || {};
    if (kind === "country") {
      return (photo.country || "Country not set") === value;
    }
    if (kind === "camera") {
      return [exif.Make, exif.Model].filter(Boolean).join(" ") === value;
    }
    if (kind === "lens") {
      return statsLensLabels(photo).includes(value);
    }
    if (kind === "focal") {
      return statsFocalLength(photo) === value;
    }
    if (kind === "focal-value") {
      const focalLength = statsFocalLengthValue(photo);
      return focalLength !== null && Math.abs(focalLength - Number(value)) < 0.0001;
    }
    if (kind === "focal-range") {
      const [minimum, maximum, boundary] = String(value || "").split(":");
      const rangeMinimum = Number(minimum);
      const rangeMaximum = Number(maximum);
      const focalLength = statsFocalLengthValue(photo);
      return Number.isFinite(rangeMinimum)
        && Number.isFinite(rangeMaximum)
        && focalLength !== null
        && focalLength >= rangeMinimum
        && (boundary === "inclusive" ? focalLength <= rangeMaximum : focalLength < rangeMaximum);
    }
    if (kind === "shutter") {
      return String(exif.ExposureTime || "") === value;
    }
    if (kind === "aperture") {
      return String(exif.FNumber || "") === value;
    }
    if (kind === "iso") {
      return String(exif.ISO || "") === value;
    }
    if (kind === "shutter-seconds") {
      return Math.abs(statsExposureSeconds(photo) - Number(value)) < 0.0000001;
    }
    if (kind === "iso-value") {
      return Math.abs(statsIsoValue(photo) - Number(value)) < 0.0001;
    }
    if (kind === "aperture-value") {
      return Math.abs(statsApertureValue(photo) - Number(value)) < 0.0001;
    }
    return false;
  }

  function closeViewer(options = {}) {
    if (!els.photoViewer) {
      return;
    }
    const returnStory = state.viewerReturnStory;
    const shouldUseHistory = options.useHistory !== false
      && state.viewerHistoryPushed
      && new URLSearchParams(window.location.hash.replace(/^#/, "")).has("photo");
    els.photoViewer.hidden = true;
    document.body.classList.remove("is-viewer-open");
    deactivateOverlayViewportSync();
    setViewerBackgroundInert(false);
    syncIosInstallHintVisibility();
    setViewerInfoOpen(false, { motion: false });
    resetViewerTransform();
    state.viewerHistoryPushed = false;
    state.viewerReturnStory = null;
    updateMapPanelCoach();
    if (document.fullscreenElement === els.photoViewer) {
      document.exitFullscreen?.().catch(() => {});
    }

    if (options.restoreFocus !== false && state.viewerReturnFocus?.isConnected) {
      state.viewerReturnFocus.focus({ preventScroll: true });
    }
    state.viewerReturnFocus = null;

    if (shouldUseHistory) {
      window.history.back();
      if (returnStory) window.setTimeout(() => restoreAirshowStorySegment(returnStory), 0);
      return;
    }

    if (options.updateHash !== false) {
      updateDeepLinkForViewerContext();
    }
    if (returnStory) window.setTimeout(() => restoreAirshowStorySegment(returnStory), 0);
  }

  function restoreAirshowStorySegment(returnStory) {
    if (!returnStory || returnStory.eventId !== state.selectedAirshowId) return;
    const track = document.querySelector("[data-story-track]");
    const slide = track?.querySelector(`[data-story-slide="${returnStory.segmentIndex}"]`);
    if (!track || !slide) return;
    track.scrollTo({top: slide.offsetTop, behavior: "auto"});
    window.requestAnimationFrame(() => {
      track.scrollTo({top: slide.offsetTop, behavior: "auto"});
    });
  }

  function setViewerBackgroundInert(isInert) {
    [
      els.siteHeader,
      els.main,
      els.mobileTabBar,
      els.mobileGlobalSearchTrigger,
      els.appUpdatePrompt,
      els.mobileInstallPrompt,
      els.iosInstallHint
    ].forEach((element) => {
      if (element) {
        element.inert = Boolean(isInert);
      }
    });
  }

  function stepPhoto(offset) {
    if (!state.activePhotoIds.length) {
      return;
    }
    state.activePhotoIndex = (state.activePhotoIndex + offset + state.activePhotoIds.length) % state.activePhotoIds.length;
    resetViewerTransform();
    renderViewerPhoto();
    updateDeepLink("photo", state.activePhotoIds[state.activePhotoIndex], { replace: true });
  }

  function selectViewerPhoto(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.activePhotoIds.length) {
      return;
    }
    state.activePhotoIndex = index;
    resetViewerTransform();
    renderViewerPhoto();
    updateDeepLink("photo", state.activePhotoIds[state.activePhotoIndex], { replace: true });
  }

  function renderViewerPhoto() {
    const photoId = state.activePhotoIds[state.activePhotoIndex];
    const photo = state.photoById.get(photoId);
    if (!photo) {
      closeViewer();
      return;
    }

    const imageSource = photo.image || "";
    const backdropSource = photo.thumbnail || imageSource;
    const renderToken = ++state.viewerRenderToken;
    state.viewerRevealToken = 0;
    els.viewerImage.classList.remove("is-entering");
    els.photoViewer.style.setProperty(
      "--viewer-backdrop",
      backdropSource ? `url(${JSON.stringify(backdropSource)})` : "none"
    );
    els.viewerImage.addEventListener("load", () => revealViewerPhoto(renderToken), { once: true });
    els.viewerImage.dataset.photoMedia = "viewer";
    els.viewerImage.dataset.photoId = photo.id;
    els.viewerImage.src = imageSource;
    renderViewerCarouselNeighbors(photo);
    if (els.viewerImage.complete && imageSource) {
      window.requestAnimationFrame(() => revealViewerPhoto(renderToken));
    }
    els.viewerImage.alt = `${photoSubjectLabel(photo)} photographed at ${photo.locationName}`;
    els.viewerKicker.textContent = state.activePhotoContext === "stats" && state.statsPhotoLabel
      ? `${state.statsPhotoLabel} · ${state.activePhotoIndex + 1} of ${state.activePhotoIds.length}`
      : `${state.activePhotoIndex + 1} of ${state.activePhotoIds.length}`;
    els.viewerTitle.textContent = photo.title || photoSubjectLabel(photo);
    const caption = String(photo.caption || "").trim();
    els.viewerCaption.textContent = caption || [
      [photo.squadronName, photo.locationName].filter(Boolean).join(" at ") + (photo.year ? `, ${photo.year}` : "")
    ]
      .filter(Boolean)
      .join(" ");
    els.viewerMetadata.innerHTML = metadataSections(photo)
      .map(renderMetadataSection)
      .join("");
    renderViewerTelemetry(photo);
    renderViewerFilmstrip();
    updateViewerInfoState();
    prefetchAdjacentViewerPhotos();
  }

  async function shareViewerPhoto() {
    const photoId = state.activePhotoIds[state.activePhotoIndex];
    const photo = state.photoById.get(photoId);
    if (!photo || !els.viewerShareButton) {
      return;
    }
    const title = photo.title || `${photoSubjectLabel(photo)} | SpotterDex`;
    const text = photo.caption || `${photoSubjectLabel(photo)} photographed at ${photo.locationName}.`;
    const url = shareUrlForEntity("photo", photo.id);
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
        showToast("Photo shared");
        return;
      }
      await copyText(url);
      showViewerActionStatus(els.viewerShareButton, "Copied");
      showToast("Photo link copied");
    } catch (error) {
      if (error?.name !== "AbortError") {
        showViewerActionStatus(els.viewerShareButton, "Failed");
        showToast("Could not share this photo");
      }
    }
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const temporaryInput = document.createElement("textarea");
    temporaryInput.value = value;
    temporaryInput.setAttribute("readonly", "");
    temporaryInput.style.position = "fixed";
    temporaryInput.style.opacity = "0";
    document.body.appendChild(temporaryInput);
    temporaryInput.select();
    const copied = document.execCommand("copy");
    temporaryInput.remove();
    if (!copied) {
      throw new Error("Could not copy link");
    }
  }

  function showViewerActionStatus(button, label) {
    const originalLabel = button.dataset.originalAriaLabel || button.getAttribute("aria-label") || "";
    button.dataset.originalAriaLabel = originalLabel;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.dataset.statusLabel = label;
    button.classList.add("has-status");
    window.clearTimeout(Number(button.dataset.statusTimer) || 0);
    button.dataset.statusTimer = String(window.setTimeout(() => {
      button.setAttribute("aria-label", originalLabel);
      button.setAttribute("title", originalLabel);
      button.classList.remove("has-status");
      delete button.dataset.statusLabel;
      delete button.dataset.statusTimer;
    }, 1800));
  }

  function toggleViewerFullscreen() {
    if (document.fullscreenElement === els.photoViewer) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    els.photoViewer.requestFullscreen?.().catch(() => {
      showViewerActionStatus(els.viewerFullscreenButton, "Unavailable");
    });
  }

  function updateViewerFullscreenButton() {
    if (!els.viewerFullscreenButton) {
      return;
    }
    const isFullscreen = document.fullscreenElement === els.photoViewer;
    const label = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
    els.viewerFullscreenButton.setAttribute("aria-label", label);
    els.viewerFullscreenButton.setAttribute("title", label);
    els.viewerFullscreenButton.setAttribute("aria-pressed", String(isFullscreen));
  }

  function prefetchAdjacentViewerPhotos() {
    if (navigator.connection?.saveData || state.activePhotoIds.length < 2) {
      return;
    }
    const adjacentIndexes = unique([
      (state.activePhotoIndex - 1 + state.activePhotoIds.length) % state.activePhotoIds.length,
      (state.activePhotoIndex + 1) % state.activePhotoIds.length
    ]);
    const prefetch = () => {
      adjacentIndexes.forEach((index) => {
        const photo = state.photoById.get(state.activePhotoIds[index]);
        if (photo?.image) {
          const image = new Image();
          image.decoding = "async";
          image.src = photo.image;
        }
      });
    };
    if (window.requestIdleCallback) {
      window.requestIdleCallback(prefetch, { timeout: 800 });
    } else {
      window.setTimeout(prefetch, 120);
    }
  }

  function revealViewerPhoto(renderToken) {
    if (
      renderToken !== state.viewerRenderToken
      || renderToken === state.viewerRevealToken
      || !els.viewerImageFrame
    ) {
      return;
    }
    state.viewerRevealToken = renderToken;
    els.viewerImage.classList.add("is-entering");
    updateViewerNavigationPosition();
  }

  function updateViewerNavigationPosition() {
    if (!els.viewerImageFrame) {
      return;
    }
    if (!isMobileViewerLayout() || !els.viewerImage?.naturalWidth || !els.viewerImage?.naturalHeight) {
      els.viewerImageFrame.style.removeProperty("--viewer-image-bottom");
      return;
    }

    const frameWidth = els.viewerImageFrame.clientWidth;
    const frameHeight = els.viewerImageFrame.clientHeight;
    if (!frameWidth || !frameHeight) {
      return;
    }

    const imageScale = Math.min(
      frameWidth / els.viewerImage.naturalWidth,
      frameHeight / els.viewerImage.naturalHeight
    );
    const renderedHeight = els.viewerImage.naturalHeight * imageScale;
    const renderedBottom = (frameHeight + renderedHeight) / 2;
    els.viewerImageFrame.style.setProperty("--viewer-image-bottom", `${Math.round(renderedBottom)}px`);
  }

  function renderViewerTelemetry(photo) {
    if (!els.viewerTelemetry) {
      return;
    }
    const exif = photo.exif || {};
    const details = [
      `${state.activePhotoIndex + 1} / ${state.activePhotoIds.length}`,
      exif.FocalLength,
      exif.ExposureTime,
      exif.FNumber
    ].filter(Boolean);
    els.viewerTelemetry.innerHTML = details
      .map((detail, index) => `<span${index === 0 ? ' class="viewer-frame-count"' : ""}>${escapeHtml(detail)}</span>`)
      .join("");
  }

  function renderViewerCarouselNeighbors(currentPhoto) {
    if (!els.viewerCarouselTrack || !els.viewerPreviousImage || !els.viewerNextImage) {
      return;
    }
    const count = state.activePhotoIds.length;
    const hasNeighbors = count > 1;
    const previousIndex = (state.activePhotoIndex - 1 + count) % Math.max(1, count);
    const nextIndex = (state.activePhotoIndex + 1) % Math.max(1, count);
    const previousPhoto = hasNeighbors ? state.photoById.get(state.activePhotoIds[previousIndex]) : currentPhoto;
    const nextPhoto = hasNeighbors ? state.photoById.get(state.activePhotoIds[nextIndex]) : currentPhoto;
    els.viewerPreviousImage.src = previousPhoto?.image || "";
    els.viewerNextImage.src = nextPhoto?.image || "";
    els.viewerCarouselTrack.classList.toggle("is-single-photo", !hasNeighbors);
    scheduleScrollEdgeUpdate();
  }

  function viewerCarouselMotionController() {
    if (!els.viewerCarouselTrack) {
      return null;
    }
    const controller = motionControllerFor(els.viewerCarouselTrack, (value) => {
      els.viewerCarouselTrack.style.transform = `translate3d(calc(-33.333333% + ${value}px), 0, 0)`;
    });
    if (!controller.initialized) {
      setMotionValue(controller, 0);
      controller.initialized = true;
    }
    return controller;
  }

  function resetViewerCarousel() {
    state.viewerCarouselDrag = null;
    const controller = viewerCarouselMotionController();
    if (!controller) return;
    stopMotion(controller);
    setMotionValue(controller, 0);
    controller.velocity = 0;
    els.viewerCarouselTrack.classList.remove("is-carousel-dragging");
  }

  function settleViewerCarousel(target, velocity = 0) {
    const controller = viewerCarouselMotionController();
    if (!controller) return;
    const direction = target < 0 ? 1 : target > 0 ? -1 : 0;
    settleMotion(controller, target, velocity, () => {
      if (!direction) return;
      setMotionValue(controller, 0);
      stepPhoto(direction);
    });
  }

  function resetViewerTransform() {
    state.viewerZoom = 1;
    state.viewerPanX = 0;
    state.viewerPanY = 0;
    state.viewerPointers.clear();
    state.viewerDragOrigin = null;
    state.viewerPinchStart = null;
    resetViewerCarousel();
    els.viewerImage?.classList.remove("is-dragging");
    updateViewerTransform();
  }

  function setViewerZoom(value, options = {}) {
    state.viewerZoom = Math.min(4, Math.max(1, Number(value) || 1));
    if (state.viewerZoom <= 1) {
      state.viewerPanX = 0;
      state.viewerPanY = 0;
    } else {
      resetViewerCarousel();
      constrainViewerPan(options.geometry || measureViewerGestureGeometry());
    }
    updateViewerTransform();
  }

  function updateViewerTransform() {
    if (!els.viewerImage) {
      return;
    }
    const zoom = state.viewerZoom || 1;
    els.viewerImage.style.transform = `translate3d(${state.viewerPanX}px, ${state.viewerPanY}px, 0) scale(${zoom})`;
    els.viewerImage.classList.toggle("is-zoomed", zoom > 1);
    els.viewerImageFrame?.classList.toggle("is-zoomed", zoom > 1);
    if (els.viewerZoomResetButton) {
      els.viewerZoomResetButton.textContent = `${Math.round(zoom * 100)}%`;
      els.viewerZoomResetButton.setAttribute("aria-label", `Reset photo zoom, currently ${Math.round(zoom * 100)} percent`);
    }
  }

  function measureViewerGestureGeometry() {
    if (!els.viewerImage || !els.viewerImageFrame) {
      state.viewerGestureGeometry = null;
      return null;
    }
    const isMobile = isMobileViewerLayout();
    const frameWidth = els.viewerImageFrame.clientWidth || 0;
    const frameHeight = els.viewerImageFrame.clientHeight || 0;
    const contentWidth = isMobile
      ? frameWidth
      : els.viewerImage.clientWidth || frameWidth;
    const contentHeight = isMobile
      ? frameHeight
      : els.viewerImage.clientHeight || frameHeight;
    state.viewerGestureGeometry = {
      frameWidth: Math.max(1, frameWidth),
      frameHeight: Math.max(1, frameHeight),
      contentWidth: Math.max(1, contentWidth),
      contentHeight: Math.max(1, contentHeight)
    };
    return state.viewerGestureGeometry;
  }

  function constrainViewerPan(geometry = state.viewerGestureGeometry || measureViewerGestureGeometry()) {
    if (!geometry) {
      return;
    }
    const width = geometry.contentWidth;
    const height = geometry.contentHeight;
    const scaledWidth = width * state.viewerZoom;
    const scaledHeight = height * state.viewerZoom;
    const maxX = Math.max(0, (scaledWidth - geometry.frameWidth) / 2);
    const maxY = Math.max(0, (scaledHeight - geometry.frameHeight) / 2);
    state.viewerPanX = Math.min(maxX, Math.max(-maxX, state.viewerPanX));
    state.viewerPanY = Math.min(maxY, Math.max(-maxY, state.viewerPanY));
  }

  function handleViewerWheel(event) {
    if (!isViewerOpen()) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY < 0 ? 0.18 : -0.18;
    setViewerZoom(state.viewerZoom + direction);
  }

  function handleViewerPointerDown(event) {
    if (!isViewerOpen()) {
      return;
    }
    const gestureGeometry = measureViewerGestureGeometry();
    els.viewerCarouselTrack.setPointerCapture?.(event.pointerId);
    state.viewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.viewerPointers.size === 1) {
      state.viewerDragOrigin = {
        x: event.clientX,
        y: event.clientY,
        panX: state.viewerPanX,
        panY: state.viewerPanY
      };
      if (state.viewerZoom <= 1 && event.pointerType !== "mouse" && state.activePhotoIds.length > 1) {
        const controller = viewerCarouselMotionController();
        const resumeTarget = controller.target;
        const resumeVelocity = controller.velocity;
        stopMotion(controller);
        state.viewerCarouselDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startValue: controller.value,
          controller,
          resumeTarget,
          resumeVelocity,
          width: gestureGeometry?.frameWidth || 1,
          samples: [{ position: event.clientX, time: performance.now() }],
          moved: false,
          rejected: false
        };
      } else {
        state.viewerCarouselDrag = null;
      }
    } else if (state.viewerPointers.size === 2) {
      const [first, second] = Array.from(state.viewerPointers.values());
      state.viewerPinchStart = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        zoom: state.viewerZoom
      };
      state.viewerDragOrigin = null;
      resetViewerCarousel();
    }
    if (state.viewerZoom > 1 || state.viewerPointers.size > 1) {
      els.viewerImage.classList.add("is-dragging");
      event.preventDefault();
    }
  }

  function handleViewerPointerMove(event) {
    if (!state.viewerPointers.has(event.pointerId)) {
      return;
    }
    state.viewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.viewerPointers.size >= 2 && state.viewerPinchStart) {
      state.viewerCarouselDrag = null;
      const [first, second] = Array.from(state.viewerPointers.values());
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      setViewerZoom(
        state.viewerPinchStart.zoom * (distance / Math.max(1, state.viewerPinchStart.distance)),
        { geometry: state.viewerGestureGeometry }
      );
      event.preventDefault();
      return;
    }
    if (state.viewerZoom > 1 && state.viewerDragOrigin) {
      state.viewerPanX = state.viewerDragOrigin.panX + event.clientX - state.viewerDragOrigin.x;
      state.viewerPanY = state.viewerDragOrigin.panY + event.clientY - state.viewerDragOrigin.y;
      constrainViewerPan(state.viewerGestureGeometry);
      updateViewerTransform();
      event.preventDefault();
      return;
    }
    const drag = state.viewerCarouselDrag;
    if (!drag || drag.pointerId !== event.pointerId || state.viewerZoom > 1) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && !drag.rejected) {
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs(deltaY);
      if (horizontal < GESTURE_INTENT_DISTANCE && vertical < GESTURE_INTENT_DISTANCE) {
        return;
      }
      if (horizontal >= vertical * GESTURE_AXIS_DOMINANCE) {
        drag.moved = true;
        els.viewerCarouselTrack.classList.add("is-carousel-dragging");
      } else if (vertical >= horizontal * GESTURE_AXIS_DOMINANCE) {
        drag.rejected = true;
        settleViewerCarousel(0, 0);
        return;
      } else {
        return;
      }
    }
    if (!drag.moved || drag.rejected) return;
    const width = drag.width;
    setMotionValue(drag.controller, boundedMotionValue(drag.startValue + deltaX, -width, width, width));
    pushGestureSample(drag.samples, event.clientX, performance.now());
    event.preventDefault();
  }

  function handleViewerPointerUp(event) {
    const carouselDrag = state.viewerCarouselDrag?.pointerId === event.pointerId
      ? state.viewerCarouselDrag
      : null;
    state.viewerPointers.delete(event.pointerId);
    if (state.viewerPointers.size < 2) {
      state.viewerPinchStart = null;
    }
    if (state.viewerPointers.size === 1) {
      const [pointer] = Array.from(state.viewerPointers.values());
      state.viewerDragOrigin = {
        x: pointer.x,
        y: pointer.y,
        panX: state.viewerPanX,
        panY: state.viewerPanY
      };
    } else if (!state.viewerPointers.size) {
      state.viewerDragOrigin = null;
      els.viewerImage.classList.remove("is-dragging");
    }
    state.viewerCarouselDrag = null;
    els.viewerCarouselTrack.classList.remove("is-carousel-dragging");

    if (carouselDrag && !carouselDrag.rejected && carouselDrag.moved && state.viewerZoom <= 1) {
      const cancelled = event.type === "pointercancel";
      if (!cancelled) pushGestureSample(carouselDrag.samples, event.clientX, performance.now());
      const velocity = cancelled ? 0 : gestureVelocity(carouselDrag.samples);
      const width = carouselDrag.width;
      const projected = carouselDrag.controller.value + (isReducedMotion() || cancelled ? 0 : projectMotion(velocity));
      const threshold = width * 0.28;
      const target = projected <= -threshold ? -width : projected >= threshold ? width : 0;
      settleViewerCarousel(target, velocity);
      event.preventDefault();
    } else if (carouselDrag && !carouselDrag.rejected && !carouselDrag.moved && carouselDrag.resumeTarget) {
      settleViewerCarousel(carouselDrag.resumeTarget, carouselDrag.resumeVelocity);
    }
  }

  function renderViewerFilmstrip() {
    if (!els.viewerFilmstrip) {
      return;
    }

    if (state.activePhotoIds.length <= 1) {
      els.viewerFilmstrip.hidden = true;
      els.viewerFilmstrip.innerHTML = "";
      return;
    }

    els.viewerFilmstrip.hidden = false;
    els.viewerFilmstrip.innerHTML = state.activePhotoIds
      .map((photoId, index) => {
        const photo = state.photoById.get(photoId);
        if (!photo) {
          return "";
        }
        const image = photo.thumbnail || photo.image || "";
        const activeClass = index === state.activePhotoIndex ? " is-active" : "";
        return `
          <button
            class="viewer-filmstrip-item${activeClass}"
            type="button"
            data-viewer-photo-index="${index}"
            aria-label="Open photo ${index + 1} of ${state.activePhotoIds.length}: ${escapeAttr(photo.aircraftType)} at ${escapeAttr(photo.locationName)}"
            aria-current="${index === state.activePhotoIndex ? "true" : "false"}"
          >
            ${
              image
                ? renderResponsivePhotoImage(photo, "", {
                    sizes: "64px"
                  })
                : `<span class="viewer-filmstrip-fallback" aria-hidden="true">${index + 1}</span>`
            }
          </button>
        `;
      })
      .join("");

    window.requestAnimationFrame(() => {
      const activeItem = els.viewerFilmstrip.querySelector(".viewer-filmstrip-item.is-active");
      if (activeItem) {
        activeItem.scrollIntoView({ block: "nearest", inline: "center" });
      }
    });
  }

  function updateDeepLinkForViewerContext() {
    const photoId = state.activePhotoIds[state.activePhotoIndex];
    const photo = state.photoById.get(photoId);
    const replace = { replace: true };
    const pageViewId = currentPageViewId();

    if (state.activePhotoContext === "dex" && state.selectedAircraftId) {
      updateAircraftDetailLink(state.selectedAircraftId, {
        ...replace,
        group: state.dexGroupMode,
        locationId: state.selectedAircraftLocationId
      });
    } else if (state.activePhotoContext === "squadron" && state.selectedSquadronId) {
      updateDeepLink("squadron", state.selectedSquadronId, replace);
    } else if (state.activePhotoContext === "location" && state.selectedPinId) {
      updateLocationDetailLink(state.selectedPinId, replace);
    } else if (state.activePhotoContext === "airshow" && state.selectedAirshowId) {
      updateDeepLink("airshow", state.selectedAirshowId, replace);
    } else if (pageViewId === "statsView") {
      updateDeepLink("stats", "summary", replace);
    } else if (pageViewId === "mapView" && photo) {
      const pinId = photo.pinId || pinIdFromLocation(photo.locationName);
      if (pinId) {
        updateDeepLink("location", pinId, replace);
      }
    } else if (pageViewId === "mapView" && state.selectedPinId) {
      updateDeepLink("location", state.selectedPinId, replace);
    } else {
      clearDeepLink(replace);
    }
  }

  function setViewerInfoOpen(isOpen, options = {}) {
    const wasOpen = state.viewerInfoOpen;
    if (isOpen && !state.viewerInfoOpen) {
      state.viewerInfoSnap = "expanded";
    }
    if (isOpen && (options.snap === "compact" || options.snap === "expanded")) {
      state.viewerInfoSnap = options.snap;
    }
    state.viewerInfoOpen = Boolean(isOpen);
    updateViewerInfoState();
    if (isMobileViewerLayout() && options.motion !== false) {
      const targetSnap = state.viewerInfoOpen
        ? window.matchMedia("(orientation: landscape)").matches ? "expanded" : state.viewerInfoSnap
        : "closed";
      moveSheetTo("viewer", targetSnap, {
        fromSnap: state.viewerInfoOpen && !wasOpen ? "closed" : null
      });
    } else if (isMobileViewerLayout()) {
      if (state.viewerInfoOpen) {
        els.viewerInfo?.classList.add("is-motion-presented");
      } else {
        moveSheetTo("viewer", "closed", { immediate: true });
      }
    }
  }

  function updateViewerInfoState() {
    if (!els.photoViewer || !els.viewerInfoButton || !els.viewerInfo) {
      return;
    }

    const isOpen = Boolean(state.viewerInfoOpen);
    const isMobile = isMobileViewerLayout();
    els.photoViewer.classList.toggle("is-info-open", isOpen);
    els.photoViewer.classList.toggle("is-info-compact", isOpen && state.viewerInfoSnap === "compact");
    els.viewerInfoButton.classList.toggle("is-active", isOpen);
    els.viewerInfoButton.setAttribute("aria-expanded", String(isOpen));
    els.viewerInfoButton.setAttribute("aria-label", isOpen ? "Hide photo info" : "Show photo info");
    const hidden = isMobile && !isOpen;
    if (hidden && els.viewerInfo.contains(document.activeElement)) {
      els.viewerInfoButton.focus({ preventScroll: true });
    }
    els.viewerInfo.inert = hidden;
    els.viewerInfo.setAttribute("aria-hidden", String(hidden));
    const handle = els.viewerInfo.querySelector('[data-sheet-handle="viewer"]');
    if (handle) {
      const expanded = state.viewerInfoSnap === "expanded";
      handle.setAttribute("aria-expanded", String(expanded));
      handle.setAttribute("aria-label", expanded ? "Collapse photo information" : "Expand photo information");
    }
  }

  function metadataSections(photo) {
    const exif = photo.exif || {};
    const camera = [exif.Make, exif.Model].filter(Boolean).join(" ");
    const squadron = squadronForPhoto(photo);
    const squadronLogo = squadron && squadron.logo ? renderViewerSquadronLogo(squadron) : "";
    const locationId = photo.pinId || pinIdFromLocation(photo.locationName);
    const airshow = photo.airshow ? findAirshow(photo.airshow) : null;
    const cameraRows = [
      ["Camera", camera],
      ["Lens model", exif.LensModel || exif.Lens],
      ["Focal length", exif.FocalLength],
      ["Aperture", exif.FNumber],
      ["Shutter speed", exif.ExposureTime],
      ["ISO", exif.ISO]
    ].filter((row) => row[1]);

    const frameRows = [
      photo.tagScope === "aircraft"
        ? ["Aircraft", photo.aircraftType, metadataAction("Open aircraft", "data-aircraft-id", photo.aircraftId)]
        : ["Tagged as", photoTagScopeLabel(photo.tagScope)],
      ["Livery", photo.livery],
      photo.squadronName ? [photo.unitLabel || unitDisplayLabel(photo.unitType), photo.squadronName, squadronLogo] : null,
      ["Country", photo.country],
      ["Location", photo.locationName, metadataAction("Open location", "data-location-page-id", locationId)],
      ["Airshow", photo.airshow, metadataAction("Open airshow", "data-airshow-id", airshow?.id)],
      ["Date", exif.DateTimeOriginal ? displayPhotoDate(photo) : photo.year]
    ].filter((row) => row && row[1]);

    return [
      {
        title: "Frame",
        rows: frameRows
      },
      {
        title: "Camera",
        rows: cameraRows,
        note: cameraRows.length ? "" : "No camera EXIF data was found in the source image."
      }
    ];
  }

  function renderMetadataSection(section) {
    const rows = section.rows
      .map(renderMetadataRow)
      .join("");
    const note = section.note ? `<p>${escapeHtml(section.note)}</p>` : "";
    return `
      <section class="metadata-section">
        <h3>${escapeHtml(section.title)}</h3>
        ${rows ? `<dl class="metadata-list">${rows}</dl>` : ""}
        ${note}
      </section>
    `;
  }

  function renderMetadataRow(row) {
    const [label, value, detailHtml] = row;
    return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}${detailHtml || ""}</dd>`;
  }

  function metadataAction(label, attribute, value) {
    if (!value) {
      return "";
    }
    return `<button class="viewer-metadata-link" type="button" ${attribute}="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
  }

  function renderViewerSquadronLogo(squadron) {
    const squadronId = squadronPageIdForUnit(squadron);
    const image = `
      <img
        class="viewer-squadron-logo"
        src="${escapeAttr(squadron.logo)}"
        alt="${escapeAttr(squadron.name)} logo"
      >
    `;
    if (!squadronId) {
      return image;
    }
    return `
      <button
        class="viewer-squadron-logo-link"
        type="button"
        data-squadron-id="${escapeAttr(squadronId)}"
        aria-label="Open ${escapeAttr(squadron.name)} on the Squadrons page"
      >
        ${image}
      </button>
    `;
  }

  function squadronForPhoto(photo) {
    const entry = state.aircraftById.get(photo.aircraftId);
    if (entry && Array.isArray(entry.squadrons)) {
      const matched =
        entry.squadrons.find((squadron) => squadron.id === photo.squadronId) ||
        entry.squadrons.find((squadron) => normalizeKey(squadron.name) === normalizeKey(photo.squadronName));
      if (matched) {
        return matched;
      }
    }
    const squadronKey = squadronPageIdForPhotoFallback(photo);
    return state.data.squadrons.find((squadron) => squadronPageIdForUnit(squadron) === squadronKey) || null;
  }

  function squadronPageIdForUnit(squadron) {
    if (!squadron || !isSquadronUnit(squadron)) {
      return "";
    }
    return String(squadron.id || normalizeKey(`${squadron.country || ""}-${squadron.name || ""}`));
  }

  function squadronPageIdForPhoto(photo) {
    const squadron = squadronForPhoto(photo);
    if (squadron) {
      return squadronPageIdForUnit(squadron);
    }
    return squadronPageIdForPhotoFallback(photo);
  }

  function squadronPageIdForPhotoFallback(photo) {
    if (photo.tagScope === "location" || !photo.squadronName || normalizeUnitType(photo.unitType) !== "squadron") {
      return "";
    }
    return normalizeKey(`${photo.country || ""}-${photo.squadronName || ""}`);
  }

  function hasCameraExif(photo) {
    const exif = photo.exif && typeof photo.exif === "object" ? photo.exif : {};
    return Boolean(
      exif.Make ||
        exif.Model ||
        exif.LensModel ||
        exif.Lens ||
        exif.FocalLength ||
        exif.FNumber ||
        exif.ExposureTime ||
        exif.ISO
    );
  }

  const RX10M4_FOCAL_LENGTH_MULTIPLIER = 2.72727272727;

  function isSonyRx10M4(exif) {
    return String((exif || {}).Model || "").trim() === "DSC-RX10M4";
  }

  function parseFocalLengthMm(value) {
    const match = String(value || "").match(/([\d.]+)/);
    return match ? Number(match[1]) : null;
  }

  function statsFocalLength(photo, mode = state.statsFocalMode) {
    const exif = photo.exif || {};
    const focalLength = statsFocalLengthValue(photo, mode);
    if (focalLength === null) {
      return String(exif.FocalLength || "").trim();
    }

    return formatFocalLength(focalLength);
  }

  function statsFocalLengthValue(photo, mode = state.statsFocalMode) {
    const exif = photo.exif || {};
    const focalMm = parseFocalLengthMm(exif.FocalLength);
    if (mode === "equivalent") {
      const equivalentMm = parseFocalLengthMm(exif.FocalLengthIn35mmFilm);
      if (equivalentMm !== null && Number.isFinite(equivalentMm)) {
        return equivalentMm;
      }
      if (focalMm !== null && Number.isFinite(focalMm) && isSonyRx10M4(exif)) {
        return focalMm * RX10M4_FOCAL_LENGTH_MULTIPLIER;
      }
    }
    return focalMm !== null && Number.isFinite(focalMm) ? focalMm : null;
  }

  function statsExposureSeconds(photo) {
    const raw = String((photo.exif || {}).ExposureTime || "").trim().replace(/s$/i, "");
    const fraction = raw.match(/^([\d.]+)\/([\d.]+)$/);
    if (fraction) {
      const denominator = Number(fraction[2]);
      return denominator ? Number(fraction[1]) / denominator : NaN;
    }
    return Number(raw);
  }

  function statsApertureValue(photo) {
    const match = String((photo.exif || {}).FNumber || "").match(/[\d.]+/);
    return match ? Number(match[0]) : NaN;
  }

  function statsIsoValue(photo) {
    return Number((photo.exif || {}).ISO);
  }

  function statsLensLabels(photo) {
    const exif = photo.exif || {};
    const lens = String(exif.LensModel || exif.Lens || "").trim();
    if (!lens) {
      return [];
    }

    const parts = lens.split(/\s+\+\s+/).map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts : [lens];
  }

  function collectionStatsSummary() {
    const enabledPins = state.data.pins.filter((pin) => pin.enabled);
    const photographedLocations = unique(
      state.data.photos.map((photo) => photo.pinId || normalizeKey(photo.locationName))
    );
    const countries = unique(enabledPins.map((pin) => pin.country));
    const squadrons = collectSquadrons();

    return {
      photoCount: state.data.photos.length,
      photographedLocationCount: photographedLocations.length,
      aircraftTypeCount: state.data.aircraft.length,
      squadronCount: squadrons.length,
      locationCount: enabledPins.length,
      countryCount: countries.length
    };
  }

  function countBy(items, getValue) {
    const counts = new Map();
    items.forEach((item) => {
      const value = String(getValue(item) || "").trim();
      if (!value) {
        return;
      }
      counts.set(value, (counts.get(value) || 0) + 1);
    });
    return counts;
  }

  function countByValues(items, getValues) {
    const counts = new Map();
    items.forEach((item) => {
      const values = getValues(item);
      const list = Array.isArray(values) ? values : [values];
      list.forEach((raw) => {
        const value = String(raw || "").trim();
        if (!value) {
          return;
        }
        counts.set(value, (counts.get(value) || 0) + 1);
      });
    });
    return counts;
  }

  function topCounts(counts, limit) {
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => {
        const countDiff = b.count - a.count;
        if (countDiff) {
          return countDiff;
        }
        return a.label.localeCompare(b.label);
      })
      .slice(0, limit);
  }

  function currentMapPhotoIds() {
    const pin = state.pinById.get(state.selectedPinId);
    return pin ? photosForPin(pin).map((photo) => photo.id) : [];
  }

  function currentLocationPhotoIds() {
    const pin = state.pinById.get(state.selectedPinId);
    return pin ? photosForPin(pin).map((photo) => photo.id) : [];
  }

  function currentDexPhotoIds() {
    const entry = state.aircraftById.get(state.selectedAircraftId);
    return entry ? photosForAircraft(entry).map((photo) => photo.id) : [];
  }

  function currentDexFamilyPhotoIds() {
    return dexHeroPhotos().map((photo) => photo.id);
  }

  function currentRecentPhotoIds() {
    return recentPhotos(RECENT_PHOTO_LIMIT).map((photo) => photo.id);
  }

  function currentSquadronPhotoIds() {
    const squadron = collectSquadrons().find((item) => item.id === state.selectedSquadronId);
    return squadron ? photosForSquadronRecord(squadron).map((photo) => photo.id) : [];
  }

  function applyDeepLinkFromHash(options = {}) {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const pageViewId = currentPageViewId();
    const photoId = params.get("photo");
    const squadronId = params.get("squadron");
    const airshowId = params.get("airshow");
    const locationId = params.get("location");
    const locationDetail = params.get("detail") === "1";
    const aircraftId = params.get("aircraft");
    const aircraftGroup = normalizeAircraftDetailGroup(params.get("group"));
    const aircraftLocationId = params.get("location") || "";
    const statsSection = params.get("stats");
    const aircraftFamily = normalizeAircraftFamily(params.get("family"));

    state.isApplyingHash = true;
    try {
      if (pageViewId === "squadronsView" && (params.has("country") || (!options.initial && !squadronId && !photoId))) {
        const country = params.get("country") || "";
        if (country !== state.squadronCountryFilter) state.squadronVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
        state.squadronCountryFilter = country;
        renderSquadronsPage();
      }
      if (pageViewId === "airshowsView" && (params.has("year") || (!options.initial && !airshowId && !photoId))) {
        const year = params.get("year") || "";
        if (year !== state.airshowYearFilter) state.airshowVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
        state.airshowYearFilter = year;
        renderAirshowsPage();
      }
      if (!photoId && isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false });
      }

      if (photoId) {
        const photo = findPhoto(photoId);
        if (photo) {
          openPhotoDeepLink(photo, options);
          state.viewerHistoryPushed = window.history.state?.spotterdexKind === "photo";
          return true;
        }
      }

      if (pageViewId === "squadronsView" && squadronId) {
        const squadron = findSquadron(squadronId);
        if (squadron) {
          selectSquadron(squadron.id, { updateHash: false });
          return true;
        }
      }

      if (pageViewId === "airshowsView" && airshowId) {
        const airshow = findAirshow(airshowId);
        if (airshow) {
          selectAirshow(airshow.id, { updateHash: false, scroll: !options.initial });
          return true;
        }
      }

      if (pageViewId === "mapView" && locationId) {
        const pin = findPin(locationId);
        if (pin) {
          if (locationDetail) {
            selectLocationPage(pin.id, { updateHash: false, scroll: !options.initial });
          } else {
            setActiveTab("mapView", { updateHash: false });
            selectPin(pin.id, { updateHash: false, pan: !options.initial });
            if (options.initial) {
              focusMapPin(pin.id);
            }
          }
          return true;
        }
      }

      if (pageViewId === "dexView" && aircraftId) {
        const entry = findAircraft(aircraftId);
        if (entry) {
          selectAircraft(entry.id, {
            group: aircraftGroup,
            locationId: aircraftLocationId,
            focusLocation: Boolean(aircraftLocationId),
            initial: options.initial,
            updateHash: false,
            scroll: !options.initial
          });
          return true;
        }
      }

      if (pageViewId === "statsView" && statsSection) {
        selectStatsSection(statsSection, { updateHash: false, initial: options.initial });
        return true;
      }

      if (pageViewId === "statsView" && !statsSection) {
        state.statsSection = "summary";
        updateStatsSectionNav();
      }

      if ((pageViewId === "squadronsView" && params.has("country")) || (pageViewId === "airshowsView" && params.has("year"))) {
        openDirectoryView(pageViewId);
        saveCurrentSessionState();
        return true;
      }

      if (pageViewId === "dexView" && aircraftFamily) {
        state.dexFamilyFilter = aircraftFamily;
        openDirectoryView("dexView");
        renderDex();
        return true;
      }

    } finally {
      state.isApplyingHash = false;
    }
    return false;
  }

  function openPhotoDeepLink(photo, options = {}) {
    const pinId = photo.pinId || pinIdFromLocation(photo.locationName);
    if (document.getElementById("mapView") && pinId && state.pinById.has(pinId)) {
      setActiveTab("mapView", { updateHash: false });
      selectPin(pinId, { updateHash: false, pan: !options.initial });
      if (options.initial) {
        focusMapPin(pinId);
      }
      openViewer(photo.id, "map", { updateHash: false });
      return;
    }

    if (document.getElementById("aircraftDetailView") && photo.aircraftId && state.aircraftById.has(photo.aircraftId)) {
      setActiveTab("dexView", { updateHash: false });
      selectAircraft(photo.aircraftId, { updateHash: false, scroll: false });
      openViewer(photo.id, "dex", { updateHash: false });
      return;
    }

    openViewer(photo.id, "photo", { updateHash: false });
  }

  function updateDeepLink(kind, id, options = {}) {
    if (state.isApplyingHash) return false;
    if (!id) {
      return kind === "country" || kind === "year" ? clearDeepLink(options) : false;
    }
    const nextHash = `#${kind}=${encodeURIComponent(id)}`;
    const changed = navigateToHash(nextHash, {
      replace: options.replace,
      state: { spotterdex: true, spotterdexKind: kind, spotterdexId: String(id) }
    });
    updateShareMetadata();
    return changed;
  }

  function normalizeAircraftDetailGroup(group) {
    return String(group || "").toLowerCase() === "location" ? "location" : "squadron";
  }

  function aircraftDetailHash(aircraftId, group = state.dexGroupMode, locationId = state.selectedAircraftLocationId) {
    const params = new URLSearchParams();
    params.set("aircraft", String(aircraftId));
    if (normalizeAircraftDetailGroup(group) === "location") {
      params.set("group", "location");
      if (locationId) {
        params.set("location", String(locationId));
      }
    }
    return params.toString();
  }

  function updateAircraftDetailLink(aircraftId, options = {}) {
    if (state.isApplyingHash || !aircraftId) {
      return false;
    }
    const group = normalizeAircraftDetailGroup(options.group ?? state.dexGroupMode);
    const locationId = options.locationId ?? state.selectedAircraftLocationId;
    const nextHash = `#${aircraftDetailHash(aircraftId, group, locationId)}`;
    const changed = navigateToHash(nextHash, {
      replace: options.replace,
      state: {
        spotterdex: true,
        spotterdexKind: "aircraft",
        spotterdexId: String(aircraftId),
        group,
        locationId: locationId ? String(locationId) : ""
      }
    });
    updateShareMetadata();
    return changed;
  }

  function updateLocationDetailLink(pinId, options = {}) {
    if (state.isApplyingHash || !pinId) {
      return false;
    }
    const nextHash = `#location=${encodeURIComponent(pinId)}&detail=1`;
    const changed = navigateToHash(nextHash, {
      replace: options.replace,
      state: { spotterdex: true, spotterdexKind: "location", spotterdexId: String(pinId), detail: true }
    });
    updateShareMetadata();
    return changed;
  }

  function clearDeepLink(options = {}) {
    if (state.isApplyingHash || !window.location.hash) {
      return false;
    }
    const changed = navigateToHash("", {
      replace: options.replace,
      state: { spotterdex: true, spotterdexKind: "map" }
    });
    updateShareMetadata();
    return changed;
  }

  function navigateToHash(hash, options = {}) {
    const nextUrl = `${window.location.pathname}${window.location.search}${hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) {
      return false;
    }
    const method = options.replace ? "replaceState" : "pushState";
    window.history[method](options.state || { spotterdex: true }, "", nextUrl);
    state.lastHandledHistoryUrl = window.location.href;
    return true;
  }

  function findPin(value) {
    const text = String(value || "");
    return state.pinById.get(text) || state.data.pins.find((pin) => normalizeKey(pin.name) === normalizeKey(text));
  }

  function findAircraft(value) {
    const text = String(value || "");
    return state.aircraftById.get(text) || state.data.aircraft.find((entry) => normalizeKey(entry.typeName) === normalizeKey(text));
  }

  function findPhoto(value) {
    const text = String(value || "");
    return state.photoById.get(text) || state.data.photos.find((photo) => normalizeKey(photo.title || photo.id) === normalizeKey(text));
  }

  function findSquadron(value) {
    const text = String(value || "");
    const key = normalizeKey(text);
    return collectSquadrons().find((squadron) => {
      return (
        squadron.id === text ||
        normalizeKey(squadron.id) === key ||
        normalizeKey(squadron.name) === key ||
        normalizeKey(`${squadron.country} ${squadron.name}`) === key
      );
    });
  }

  function findAirshow(value) {
    const text = String(value || "");
    const key = normalizeKey(text);
    return state.airshowById.get(text) || state.data.airshows.find((airshow) => {
      return airshow.id === text || normalizeKey(airshow.name) === key;
    });
  }

  function aircraftStats(entry) {
    return normalizeAircraftStats(entry);
  }

  function normalizeAircraftStats(entry) {
    const manifestStats = entry.stats && typeof entry.stats === "object" ? entry.stats : {};
    const photos = state.photoById.size
      ? (entry.photoIds || []).map((photoId) => state.photoById.get(photoId)).filter(Boolean)
      : [];
    const locations = unique([
      ...(Array.isArray(manifestStats.locations) ? manifestStats.locations : []),
      ...photos.map((photo) => photo.locationName)
    ]);
    const dates = unique([
      manifestStats.firstDate,
      manifestStats.latestDate,
      ...photos.map((photo) => photo.sortDate)
    ])
      .filter(Boolean)
      .sort();
    const units = entry.squadrons || [];
    const unitCount = Number.isFinite(Number(manifestStats.unitCount)) ? Number(manifestStats.unitCount) : units.length;
    const squadronCount = Number.isFinite(Number(manifestStats.squadronCount))
      ? Number(manifestStats.squadronCount)
      : units.filter(isSquadronUnit).length;
    const organisationCount = Number.isFinite(Number(manifestStats.organisationCount))
      ? Number(manifestStats.organisationCount)
      : units.filter((squadron) => normalizeUnitType(squadron.unitType) === "organisation").length;

    return {
      photoCount: Number.isFinite(Number(manifestStats.photoCount)) ? Number(manifestStats.photoCount) : photos.length,
      unitCount,
      squadronCount,
      organisationCount,
      locationCount: Number.isFinite(Number(manifestStats.locationCount)) ? Number(manifestStats.locationCount) : locations.length,
      locations,
      firstDate: manifestStats.firstDate || dates[0] || "",
      latestDate: manifestStats.latestDate || dates[dates.length - 1] || ""
    };
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeWriteUp(value) {
    return String(value || "").trim();
  }

  function pageDescription(writeUp, fallback) {
    const text = normalizeWriteUp(writeUp).replace(/\s+/g, " ");
    return text ? text.slice(0, 260) : fallback;
  }

  function normalizeIcao(value) {
    const code = String(value || "").trim().toUpperCase();
    return /^[A-Z0-9]{2,4}$/.test(code) ? code : "";
  }

  function normalizeUnitType(value) {
    const key = normalizeKey(value || "squadron");
    return ["organisation", "organization", "org"].includes(key) ? "organisation" : "squadron";
  }

  function normalizePhotoScope(value) {
    const key = normalizeKey(value || "aircraft");
    if (key === "squadron" || key === "unit") {
      return "squadron";
    }
    if (key === "location" || key === "pin") {
      return "location";
    }
    return "aircraft";
  }

  function defaultPhotoSubject(tagScope) {
    if (tagScope === "squadron") {
      return "Squadron image";
    }
    if (tagScope === "location") {
      return "Location image";
    }
    return "Unknown aircraft";
  }

  function photoSubjectLabel(photo) {
    return photo.aircraftType || defaultPhotoSubject(photo.tagScope);
  }

  function photoContextLabel(photo) {
    return photo.squadronName || (photo.tagScope === "location" ? photo.locationName : photo.unitLabel || "Unassigned");
  }

  function photoTagScopeLabel(tagScope) {
    if (tagScope === "squadron") {
      return "Squadron-level image";
    }
    if (tagScope === "location") {
      return "Location-level image";
    }
    return "Aircraft-level image";
  }

  function unitDisplayLabel(unitType) {
    return normalizeUnitType(unitType) === "organisation" ? "Organisation" : "Squadron";
  }

  function unitNoun(unitType, count, titleCase = false) {
    const normalized = normalizeUnitType(unitType);
    const word = normalized === "organisation"
      ? count === 1 ? "organisation" : "organisations"
      : count === 1 ? "squadron" : "squadrons";
    return titleCase ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }

  function unknownUnitName(unitType) {
    return `Unknown ${unitNoun(unitType, 1)}`;
  }

  function isSquadronUnit(squadron) {
    return normalizeUnitType(squadron.unitType) === "squadron" && squadron.showOnSquadronsPage !== false;
  }

  function entryUnitNoun(entry, count, titleCase = false) {
    const unitTypes = unique((entry.squadrons || []).map((squadron) => normalizeUnitType(squadron.unitType)));
    if (unitTypes.length === 1) {
      return unitNoun(unitTypes[0], count, titleCase);
    }
    const word = count === 1 ? "unit" : "units";
    return titleCase ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }

  function photoUnitGroupLabel(photos) {
    const unitTypes = unique(
      photos.filter((photo) => photo.squadronName).map((photo) => normalizeUnitType(photo.unitType))
    );
    if (!unitTypes.length) {
      return "Unit";
    }
    if (unitTypes.length === 1) {
      return unitNoun(unitTypes[0], 1, true);
    }
    return "Unit";
  }

  function countryFlag(country) {
    const codes = {
      australia: "AU",
      bermuda: "BM",
      france: "FR",
      "hong kong": "HK",
      italy: "IT",
      japan: "JP",
      malaysia: "MY",
      singapore: "SG",
      thailand: "TH",
      "united kingdom": "GB",
      "united states": "US",
      vietnam: "VN"
    };
    const code = codes[normalizeText(country)];
    if (!code) {
      return "?";
    }
    return code
      .toUpperCase()
      .split("")
      .map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0)))
      .join("");
  }

  function deriveSortDate(photo) {
    if (photo.date) {
      return String(photo.date);
    }
    const exif = photo.exif && typeof photo.exif === "object" ? photo.exif : {};
    const exifDate = exif.DateTimeOriginal || exif.DateTime || "";
    const exifMatch = String(exifDate).match(/^(\d{4}):(\d{2}):(\d{2})/);
    if (exifMatch) {
      return `${exifMatch[1]}-${exifMatch[2]}-${exifMatch[3]}`;
    }
    if (photo.year) {
      return `${photo.year}-01-01`;
    }
    return "";
  }

  function formatDisplayDate(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "Undated";
    }
    const fullDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!fullDate) {
      return text;
    }
    const date = new Date(`${text}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) {
      return text;
    }
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC"
    }).format(date);
  }

  function displayPhotoDate(photo) {
    if (photo.date) {
      return formatDisplayDate(photo.date);
    }
    if (photo.year) {
      return String(photo.year);
    }
    return formatDisplayDate(photo.sortDate);
  }

  function normalizeKey(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function slugify(value) {
    return normalizeKey(value) || "item";
  }

  function initials(value) {
    const parts = String(value || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    return parts.map((part) => part[0]).join("").toUpperCase() || "SQ";
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function debounce(fn, wait) {
    let handle;
    return function debounced() {
      window.clearTimeout(handle);
      handle = window.setTimeout(fn, wait);
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
      const replacements = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      };
      return replacements[char];
    });
  }

  function formatAircraftCardTitle(value) {
    // Aircraft designations are units (for example, "E-4B"), so keep them
    // intact while still allowing the title to wrap naturally at spaces.
    return escapeHtml(value).replace(/-/g, "\u2011");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
