(function () {
  const EMPTY_DATA = { payload: "core", generatedAt: null, pins: [], aircraft: [], squadrons: [], airshows: [], photos: [] };
  const EMPTY_PHOTOS = Object.freeze([]);
  const RECENT_PHOTO_LIMIT = 8;
  const MOBILE_ARCHIVE_PAGE_SIZE = 12;
  const MOBILE_DETAIL_PAGE_SIZE = 12;
  const MOBILE_ARCHIVE_PREFETCH_OFFSET = Math.max(0, Math.floor(MOBILE_ARCHIVE_PAGE_SIZE / 2) - 1);
  const VIEWER_SWIPE_MIN_DISTANCE = 56;
  const VIEWER_SWIPE_MAX_DURATION = 650;
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
  const MOBILE_MAP_TRAFFIC_PIN_LIMIT = 10;
  const MAP_PANEL_COACH_STORAGE_KEY = "spotterdex-map-panel-coach-dismissed";
  const MOBILE_SESSION_KEY_PREFIX = "spotterdex-mobile-session-v1:";
  const INSTALL_DISMISSED_STORAGE_KEY = "spotterdex-install-dismissed-v1";
  const SHEET_DISMISS_DISTANCE = 140;
  const SHEET_SNAP_DISTANCE = 52;
  const SHEET_DISMISS_VELOCITY = 0.78;
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
  const FOCUSED_MOBILE_MEDIA_QUERY = "(max-width: 760px)";
  const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";
  const LEAFLET_SCRIPT_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  const LEAFLET_SCRIPT_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
  const MAPLIBRE_SCRIPT_URL = "https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.js";
  const MAPLIBRE_LEAFLET_SCRIPT_URL = "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js";
  const OPENFREEMAP_DARK_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
  let leafletLoadPromise = null;
  let openFreeMapLoadPromise = null;
  let statsExifLoadPromise = null;
  let mobileShellEventsBound = false;
  let viewerEventsBound = false;
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
    selectedSquadronId: null,
    selectedAirshowId: null,
    expandedLocationGroupKeys: new Set(),
    dexGroupMode: "squadron",
    dexFamilyFilter: "",
    dexVisibleCount: MOBILE_ARCHIVE_PAGE_SIZE,
    squadronVisibleCount: MOBILE_ARCHIVE_PAGE_SIZE,
    airshowVisibleCount: MOBILE_ARCHIVE_PAGE_SIZE,
    squadronQuery: "",
    squadronCountryFilter: "",
    statsSection: "summary",
    recentPhotoLimit: RECENT_PHOTO_LIMIT,
    recentPhotoResizeObserver: null,
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
    viewerSwipeStart: null,
    viewerInfoSnap: "expanded",
    viewerHistoryPushed: false,
    viewerReturnFocus: null,
    mobileMapPanel: null,
    mapSheetSnap: "compact",
    sheetDrag: null,
    installPromptEvent: null,
    connectivityOffline: false,
    sessionRestore: null,
    toastTimer: null,
    mapControlPanelOpen: true,
    renderedViews: new Set(),
    detailGalleries: new Map(),
    pageNavigationLoading: false,
    fullDataPromise: null,
    lastHandledHistoryUrl: "",
    isApplyingHash: false
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    ensureMobileAppShell();
    cacheElements();
    state.sessionRestore = readPageSessionState();
    restoreSessionFilters(state.sessionRestore);
    setupEvents();

    state.data = prepareData(await loadData());
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
    schedulePageShellWarmup();
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

  function schedulePageShellWarmup() {
    const warmup = () => {
      registerServiceWorker();
      prefetchPageShells();
    };
    if (document.readyState === "complete") {
      warmup();
      return;
    }
    window.addEventListener("load", warmup, { once: true });
  }

  function prefetchPageShells() {
    const currentPath = new URL(pageRouteForView(currentPageViewId()), document.baseURI).pathname;
    unique(Object.values(PAGE_ROUTES)).forEach((route) => {
      const url = new URL(route, document.baseURI);
      if (url.pathname === currentPath) {
        return;
      }
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "document";
      link.href = url.href;
      document.head.appendChild(link);
    });
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
            <img id="viewerImage" alt="" draggable="false">
            <button class="viewer-button next" type="button" id="nextPhotoButton" aria-label="Next photo">▶</button>
          </div>
          <div class="viewer-filmstrip" id="viewerFilmstrip" aria-label="Photo thumbnails"></div>
        </div>
        <aside class="viewer-info" id="viewerInfo">
          <div class="viewer-info-sheet-bar">
            <button class="viewer-info-sheet-handle" type="button" data-sheet-handle="viewer" aria-label="Collapse photo information" aria-expanded="true"></button>
            <button class="viewer-info-close" type="button" id="viewerInfoCloseButton" aria-label="Close photo information">Close</button>
          </div>
          <p class="eyebrow" id="viewerKicker">Photo</p>
          <h2 id="viewerTitle">Photo details</h2>
          <p class="viewer-caption" id="viewerCaption"></p>
          <div class="metadata-panel" id="viewerMetadata"></div>
        </aside>
      </div>
    `);
    cacheViewerElements();
    bindPhotoViewerEvents();
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
      <div class="app-toast" id="appToast" role="status" aria-live="polite" hidden></div>
      <div class="page-loading-indicator" id="pageLoadingIndicator" role="status" aria-live="polite" aria-label="Loading page" hidden>
        <span class="page-loading-spinner" aria-hidden="true"></span>
        <span id="pageLoadingLabel">Loading…</span>
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
      els.aircraftSearch = document.getElementById("aircraftSearch");
      els.dexFamilyFilter = document.getElementById("dexFamilyFilter");
      els.recentPhotosStrip = document.getElementById("recentPhotosStrip");
      els.recentPhotosCount = document.getElementById("recentPhotosCount");
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
      els.squadronSearch = document.getElementById("squadronSearch");
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
      els.statsHeroPhotoCount = document.getElementById("statsHeroPhotoCount");
      els.statsHeroAircraftCount = document.getElementById("statsHeroAircraftCount");
      els.statsHeroLocationCount = document.getElementById("statsHeroLocationCount");
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
    els.pageLoadingIndicator = document.getElementById("pageLoadingIndicator");
    els.pageLoadingLabel = document.getElementById("pageLoadingLabel");
  }

  function cacheViewerElements() {
    els.photoViewer = document.getElementById("photoViewer");
    els.viewerImageFrame = document.querySelector(".viewer-image-frame");
    els.viewerImage = document.getElementById("viewerImage");
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
    if (viewerEventsBound || !els.photoViewer || !els.viewerImage) {
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
    els.viewerImage.addEventListener("contextmenu", (event) => event.preventDefault());
    els.viewerImage.setAttribute("draggable", "false");
    els.viewerImage.addEventListener("wheel", handleViewerWheel, { passive: false });
    els.viewerImage.addEventListener("pointerdown", handleViewerPointerDown);
    els.viewerImage.addEventListener("pointermove", handleViewerPointerMove);
    els.viewerImage.addEventListener("pointerup", handleViewerPointerUp);
    els.viewerImage.addEventListener("pointercancel", handleViewerPointerUp);
    els.viewerImage.addEventListener("dblclick", () => {
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
        data = EMPTY_DATA;
      }
    }

    if (currentPageViewId() === "statsView") {
      await loadStatsExifBundle();
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
      writeUp: normalizeWriteUp(event.writeUp)
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
      script.addEventListener("load", () => resolve(window.SPOTTERDEX_EXIF || null), { once: true });
      script.addEventListener("error", () => reject(new Error("Could not load Stats EXIF data")), { once: true });
      document.head.append(script);
    }).catch((error) => {
      console.warn(error);
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
    const mostRecentLocation = recentLocations()[0];
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
    document.getElementById("fitPinsButton")?.addEventListener("click", handleHeaderMapButton);
    document.getElementById("fitPinsPanelButton")?.addEventListener("click", fitMapToPins);
    els.mapPanelCoachDismiss?.addEventListener("click", dismissMapPanelCoach);

    els.locationSearch?.addEventListener("input", renderLocations);
    els.aircraftSearch?.addEventListener("input", () => {
      state.dexVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
      renderDex();
    });
    els.squadronSearch?.addEventListener("input", () => {
      state.squadronQuery = els.squadronSearch.value;
      state.squadronVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
      renderSquadronsPage();
    });

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("pointerdown", handleSheetPointerDown);
    document.addEventListener("pointermove", handleSheetPointerMove, { passive: false });
    document.addEventListener("pointerup", handleSheetPointerUp);
    document.addEventListener("pointercancel", handleSheetPointerUp);
    window.addEventListener("popstate", handleHistoryNavigation);
    window.addEventListener("hashchange", handleHistoryNavigation);
    window.addEventListener("pagehide", saveCurrentSessionState);
    window.addEventListener("pageshow", () => setPageNavigationLoading(false));
    window.addEventListener("online", () => updateConnectivityUi({ offline: false }));
    window.addEventListener("offline", () => updateConnectivityUi({ offline: true }));
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", () => {
      state.installPromptEvent = null;
      if (els.mobileInstallPrompt) els.mobileInstallPrompt.hidden = true;
      showToast("SpotterDex installed");
    });
    document.addEventListener("fullscreenchange", updateViewerFullscreenButton);
    window.addEventListener("resize", debounce(() => {
      ensureMobileAppShell();
      updateMapPanelState();
      updateMapPanelCoach();
      updateViewerInfoState();
      updateMobileAppChrome();
      refreshMapLayout();
      updateRecentPhotoLimit();
      if (state.renderedViews.has("dexView")) {
        renderDex();
      }
      if (state.renderedViews.has("squadronsView")) {
        renderSquadronsPage();
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

    if (
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
      && !isReducedMotion()
    ) {
      document.addEventListener("pointermove", handleLensPointerMove, { passive: true });
      document.addEventListener("pointerout", handleLensPointerOut, { passive: true });
    }
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
    const routed = applyDeepLinkFromHash();
    if (!routed) {
      if (isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false });
      }
      setActiveTab(currentPageViewId(), { updateHash: false });
    }
  }

  function handleLensPointerMove(event) {
    const surface = event.target instanceof Element
      ? event.target.closest(".photo-card, .recent-photo-card, .location-recent-card, .location-hero, .squadron-logo-card")
      : null;
    if (!surface) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
    surface.style.setProperty("--lens-x", `${x.toFixed(1)}%`);
    surface.style.setProperty("--lens-y", `${y.toFixed(1)}%`);
    surface.style.setProperty("--lens-opacity", "1");
  }

  function handleLensPointerOut(event) {
    const surface = event.target instanceof Element
      ? event.target.closest(".photo-card, .recent-photo-card, .location-recent-card, .location-hero, .squadron-logo-card")
      : null;
    if (!surface || (event.relatedTarget instanceof Node && surface.contains(event.relatedTarget))) {
      return;
    }
    surface.style.setProperty("--lens-opacity", "0");
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

    const copyFieldGuideButton = event.target.closest("[data-copy-field-guide]");
    if (copyFieldGuideButton) {
      copyFieldGuideLink(copyFieldGuideButton).catch(() => {
        copyFieldGuideButton.textContent = "Copy failed";
      });
      return;
    }

    const mapPanelButton = event.target.closest("[data-map-panel-toggle]");
    if (mapPanelButton) {
      toggleMapPanel(mapPanelButton.dataset.mapPanelToggle);
      return;
    }

    if (event.target.closest("[data-map-panel-close]")) {
      setMapPanel(null);
      return;
    }

    const countryJump = event.target.closest("[data-squadron-country-jump]");
    if (countryJump) {
      if (isFocusedMobileLayout()) {
        state.squadronCountryFilter = countryJump.dataset.squadronCountryFilter || "";
        state.squadronVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
        renderSquadronsPage();
        return;
      }
      const target = document.getElementById(countryJump.dataset.squadronCountryJump || "");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const dexFamilyFilterClear = event.target.closest("[data-clear-dex-family-filter]");
    if (dexFamilyFilterClear) {
      state.dexFamilyFilter = "";
      state.dexVisibleCount = MOBILE_ARCHIVE_PAGE_SIZE;
      renderDex();
      clearDeepLink();
      els.aircraftSearch?.focus({ preventScroll: true });
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
        statsFilter.dataset.statsFilterLabel || "Selected frames"
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
      state.dexGroupMode = dexGroupButton.dataset.dexGroup;
      renderAircraftDetail();
      return;
    }

    const locationPageButton = event.target.closest("[data-location-page-id]");
    if (locationPageButton) {
      if (isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectLocationPage(locationPageButton.dataset.locationPageId);
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
      setActiveTab(detailBackButton.dataset.detailBack);
      return;
    }

    const detailLoadButton = event.target.closest("[data-detail-load-more]");
    if (detailLoadButton) {
      appendDetailGalleryPage(detailLoadButton);
      return;
    }

    const locationButton = event.target.closest("[data-location-id]");
    if (locationButton) {
      selectPin(locationButton.dataset.locationId);
      return;
    }

    const aircraftButton = event.target.closest("[data-aircraft-id]");
    if (aircraftButton) {
      if (isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectAircraft(aircraftButton.dataset.aircraftId);
      return;
    }

    const squadronButton = event.target.closest("[data-squadron-id]");
    if (squadronButton) {
      if (isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectSquadron(squadronButton.dataset.squadronId);
      return;
    }

    const airshowButton = event.target.closest("[data-airshow-id]");
    if (airshowButton) {
      if (isViewerOpen()) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectAirshow(airshowButton.dataset.airshowId);
      return;
    }

    const filmstripButton = event.target.closest("[data-viewer-photo-index]");
    if (filmstripButton) {
      selectViewerPhoto(Number(filmstripButton.dataset.viewerPhotoIndex));
      return;
    }

    const photoButton = event.target.closest("[data-photo-id]");
    if (photoButton) {
      openViewer(photoButton.dataset.photoId, photoButton.dataset.photoContext);
    }
  }

  function handleKeydown(event) {
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
        stepPhoto(-1);
      } else if (event.key === "ArrowRight") {
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
    const focusable = Array.from(els.photoViewer.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.hidden && element.getClientRects().length);
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
      const isOpen = Boolean(activePanel && isFocusedMobileLayout());
      els.mapPanelBackdrop.setAttribute("aria-hidden", String(!isOpen));
      els.mapPanelBackdrop.tabIndex = isOpen ? 0 : -1;
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
      aircraftQuery: els.aircraftSearch?.value || "",
      dexFamilyFilter: state.dexFamilyFilter,
      dexVisibleCount: state.dexVisibleCount,
      airshowVisibleCount: state.airshowVisibleCount,
      squadronQuery: els.squadronSearch?.value || state.squadronQuery,
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
    state.squadronQuery = String(snapshot.squadronQuery || "");
    state.squadronCountryFilter = String(snapshot.squadronCountryFilter || "");
    state.squadronVisibleCount = Math.max(MOBILE_ARCHIVE_PAGE_SIZE, Number(snapshot.squadronVisibleCount) || MOBILE_ARCHIVE_PAGE_SIZE);
    state.statsSection = normalizeStatsSection(snapshot.statsSection);
    if (els.aircraftSearch) els.aircraftSearch.value = String(snapshot.aircraftQuery || "");
    if (els.squadronSearch) els.squadronSearch.value = state.squadronQuery;
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
    if (state.pageNavigationLoading) {
      event.preventDefault();
      return;
    }
    const link = event.currentTarget;
    const targetView = link.dataset.mobileTabView;
    if (!targetView) {
      return;
    }
    event.preventDefault();
    const activeView = document.querySelector("[data-view].is-active")?.id || currentPageViewId();
    if (navigationViewFor(activeView) === targetView) {
      if (activeView !== targetView) {
        handleMobileContextBack();
      } else {
        window.scrollTo({ top: 0, behavior: isReducedMotion() ? "auto" : "smooth" });
      }
      return;
    }
    els.mobileTabLinks?.forEach((tabLink) => {
      const isDestination = tabLink === link;
      tabLink.classList.toggle("is-active", isDestination);
      if (isDestination) tabLink.setAttribute("aria-current", "page");
      else tabLink.removeAttribute("aria-current");
    });
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
    const destinationLabel = link.querySelector("span")?.textContent.trim() || "page";
    setPageNavigationLoading(true, destinationLabel);
    window.requestAnimationFrame(() => {
      if (state.pageNavigationLoading) {
        window.location.assign(destination.href);
      }
    });
  }

  function setPageNavigationLoading(isLoading, label = "page") {
    state.pageNavigationLoading = isLoading;
    const indicator = els.pageLoadingIndicator;
    if (indicator) {
      indicator.hidden = !isLoading;
      indicator.setAttribute("aria-label", isLoading ? `Loading ${label}` : "Loading page");
    }
    if (els.pageLoadingLabel) {
      els.pageLoadingLabel.textContent = isLoading ? `Loading ${label}…` : "Loading…";
    }
    document.body.classList.toggle("is-page-navigation-loading", isLoading);
    els.mobileTabLinks?.forEach((tabLink) => {
      if (isLoading) {
        tabLink.setAttribute("aria-disabled", "true");
      } else {
        tabLink.removeAttribute("aria-disabled");
      }
    });
  }

  function handleMobileContextBack() {
    const activeView = document.querySelector("[data-view].is-active")?.id;
    const collectionView = navigationViewFor(activeView);
    if (activeView === collectionView) {
      return;
    }
    openDirectoryView(collectionView);
    window.scrollTo({ top: 0, behavior: "auto" });
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

  function handleInstallPrompt(event) {
    event.preventDefault();
    state.installPromptEvent = event;
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(INSTALL_DISMISSED_STORAGE_KEY) === "1";
    } catch (error) {
      dismissed = false;
    }
    if (!dismissed && els.mobileInstallPrompt) {
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
    if (options.announce !== false) {
      showToast(offline ? "Offline · cached catalog available" : "Back online");
    }
  }

  function showToast(message) {
    if (!els.appToast || !message) {
      return;
    }
    window.clearTimeout(state.toastTimer);
    els.appToast.textContent = message;
    els.appToast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      els.appToast.hidden = true;
    }, 2400);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || (window.location.protocol !== "https:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1")) {
      return;
    }
    navigator.serviceWorker.register(new URL("service-worker.js", document.baseURI), {
      scope: new URL("./", document.baseURI).pathname
    }).catch((error) => console.warn("SpotterDex service worker registration failed", error));
  }

  function toggleSheetSnap(kind) {
    if (kind === "map" && state.mobileMapPanel) {
      state.mapSheetSnap = state.mapSheetSnap === "expanded" ? "compact" : "expanded";
      updateMapPanelState();
      return;
    }
    if (kind === "viewer" && state.viewerInfoOpen) {
      state.viewerInfoSnap = state.viewerInfoSnap === "expanded" ? "compact" : "expanded";
      updateViewerInfoState();
    }
  }

  function handleSheetPointerDown(event) {
    const handle = event.target instanceof Element ? event.target.closest("[data-sheet-handle]") : null;
    if (!handle || event.button) {
      return;
    }
    const kind = handle.dataset.sheetHandle;
    if ((kind === "map" && !isFocusedMobileLayout()) || (kind === "viewer" && !isMobileViewerLayout())) {
      return;
    }
    const landscapeViewer = kind === "viewer" && window.matchMedia("(orientation: landscape)").matches;
    const panel = kind === "map"
      ? state.mobileMapPanel === "locations" ? els.mapControlPanel : state.mobileMapPanel === "results" ? els.mapResults : null
      : state.viewerInfoOpen ? els.viewerInfo : null;
    if (!panel) {
      return;
    }
    state.sheetDrag = {
      kind,
      handle,
      panel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      originalSnap: kind === "map" ? state.mapSheetSnap : state.viewerInfoSnap,
      landscapeViewer,
      moved: false
    };
    handle.setPointerCapture?.(event.pointerId);
    panel.classList.add("is-sheet-dragging");
  }

  function handleSheetPointerMove(event) {
    const drag = state.sheetDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const distance = drag.landscapeViewer ? deltaX : deltaY;
    if (Math.abs(distance) > 7) {
      drag.moved = true;
      drag.handle.dataset.dragged = "true";
    }
    if (!drag.moved) {
      return;
    }
    event.preventDefault();
    if (drag.landscapeViewer) {
      drag.panel.style.setProperty("--sheet-drag-x", `${Math.max(0, deltaX)}px`);
    } else {
      const height = drag.panel.getBoundingClientRect().height || window.innerHeight;
      drag.panel.style.setProperty("--sheet-drag-y", `${Math.max(-height * 0.5, Math.min(height, deltaY))}px`);
    }
  }

  function handleSheetPointerUp(event) {
    const drag = state.sheetDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const delta = drag.landscapeViewer ? event.clientX - drag.startX : event.clientY - drag.startY;
    const duration = Math.max(1, performance.now() - drag.startedAt);
    const velocity = delta / duration;
    drag.panel.classList.remove("is-sheet-dragging");
    drag.panel.style.removeProperty("--sheet-drag-x");
    drag.panel.style.removeProperty("--sheet-drag-y");
    drag.handle.releasePointerCapture?.(event.pointerId);
    state.sheetDrag = null;
    if (!drag.moved) {
      return;
    }

    const dismiss = delta > SHEET_DISMISS_DISTANCE || velocity > SHEET_DISMISS_VELOCITY;
    if (drag.kind === "map") {
      if (dismiss) {
        setMapPanel(null);
      } else {
        state.mapSheetSnap = delta < -SHEET_SNAP_DISTANCE ? "expanded" : delta > SHEET_SNAP_DISTANCE ? "compact" : drag.originalSnap;
        updateMapPanelState();
      }
    } else if (dismiss) {
      setViewerInfoOpen(false);
    } else {
      state.viewerInfoSnap = delta < -SHEET_SNAP_DISTANCE ? "expanded" : delta > SHEET_SNAP_DISTANCE ? "compact" : drag.originalSnap;
      updateViewerInfoState();
    }
  }

  function setActiveTab(viewId, options = {}) {
    if (!document.getElementById(viewId)) {
      navigateToViewPage(viewId);
      return false;
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
          if (!activeBefore || activeBefore.id !== viewId) {
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

  async function copyFieldGuideLink(button) {
    await copyText(shareUrlForCurrentState());
    showToast("Field guide link copied");
    const originalLabel = button.dataset.copyFieldGuide || "Copy link";
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1800);
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
      updateDeepLink("aircraft", state.selectedAircraftId);
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
      window.setTimeout(initializeMapWhenReady, 0);
      updateMapPanelCoach();
    } else if (directoryView === "dexView") {
      renderDexHero();
      renderRecentPhotos();
      renderDex();
    } else if (directoryView === "squadronsView") {
      renderSquadronsPage();
    } else if (directoryView === "airshowsView") {
      renderAirshowsPage();
    } else if (directoryView === "statsView") {
      renderStatsArchiveHero();
      renderStatsDashboard();
      renderExifDashboard();
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

  function renderLocations() {
    const query = normalizeText(els.locationSearch.value);
    const locations = recentLocations()
      .filter((location) => !query || normalizeText(`${location.pin.name} ${location.pin.country}`).includes(query));

    if (!locations.length) {
      els.locationList.innerHTML = '<div class="empty-state">No recent locations match this search.</div>';
      updateRecentLocationNav();
      return;
    }

    els.locationList.innerHTML = locations
      .map((location) => {
        const pin = location.pin;
        const activeClass = pin.id === state.selectedPinId ? " is-active" : "";
        return `
          <button class="location-row${activeClass}" type="button" data-location-id="${escapeAttr(pin.id)}">
            <span>
              <strong>${escapeHtml(pin.name)}</strong>
              <span>${escapeHtml(formatDisplayDate(location.latestDate))} - ${escapeHtml(pin.country || "Location")}</span>
            </span>
            <span class="count-pill">${location.photos.length}</span>
          </button>
        `;
      })
      .join("");
    updateRecentLocationNav();
  }

  function updateRecentLocationNav() {
    if (!els.mobileMapLocationNav) {
      return;
    }

    const buttons = new Map(
      Array.from(els.mobileMapLocationNav.querySelectorAll("[data-location-nav]")).map((button) => [button.dataset.locationNav, button])
    );
    const locations = recentLocations();
    const selectedIndex = locations.findIndex((location) => location.pin.id === state.selectedPinId);
    const olderButton = buttons.get("older");
    const newerButton = buttons.get("newer");
    if (olderButton) {
      olderButton.disabled = !locations.length || selectedIndex < 0 || selectedIndex >= locations.length - 1;
    }
    if (newerButton) {
      newerButton.disabled = !locations.length || (selectedIndex >= 0 ? selectedIndex === 0 : false);
    }
  }

  function stepRecentLocation(direction) {
    if (direction !== "older" && direction !== "newer") {
      return;
    }

    const locations = recentLocations();
    if (!locations.length) {
      return;
    }

    const selectedIndex = locations.findIndex((location) => location.pin.id === state.selectedPinId);
    let nextIndex = selectedIndex;
    if (selectedIndex < 0) {
      nextIndex = direction === "newer" ? 0 : locations.length - 1;
    } else if (direction === "older") {
      nextIndex += 1;
    } else {
      nextIndex -= 1;
    }

    if (nextIndex < 0 || nextIndex >= locations.length) {
      return;
    }
    if (isMobileMapLayout()) {
      setMapPanel(null);
    }
    selectPin(locations[nextIndex].pin.id, { openPanel: false });
  }

  function initMap() {
    if (state.map || !els.worldMap) {
      return;
    }

    if (!window.L) {
      els.mapFallback.hidden = false;
      return;
    }

    const mobileLayout = isMobileMapLayout();
    state.map = window.L.map(els.worldMap, {
      scrollWheelZoom: true,
      zoomControl: true,
      fadeAnimation: !mobileLayout,
      zoomAnimation: true,
      markerZoomAnimation: true,
      zoomAnimationThreshold: 4,
      inertia: true
    });

    const tileLayer = window.L.maplibreGL({
      style: OPENFREEMAP_DARK_STYLE_URL,
      attributionControl: {
        customAttribution: '<a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    });
    tileLayer.once("add", () => {
      const vectorMap = tileLayer.getMaplibreMap();
      if (!vectorMap) {
        if (els.mapFallback) {
          els.mapFallback.hidden = false;
        }
        return;
      }

      let basemapReady = false;
      const basemapLoadTimeout = window.setTimeout(() => {
        if (!basemapReady && els.mapFallback) {
          els.mapFallback.hidden = false;
        }
      }, 12000);
      vectorMap.on("load", () => {
        basemapReady = true;
        window.clearTimeout(basemapLoadTimeout);
        if (!state.connectivityOffline && els.mapFallback) {
          els.mapFallback.hidden = true;
        }
      });
    });
    tileLayer.addTo(state.map);

    const leaderPane = state.map.createPane("spotterdexLeaderPane");
    leaderPane.style.zIndex = "550";
    leaderPane.style.pointerEvents = "none";
    const markerPane = state.map.getPane("markerPane");
    if (markerPane) {
      markerPane.style.zIndex = "700";
    }
    const labelPane = state.map.createPane("spotterdexLabelPane");
    labelPane.style.zIndex = "650";
    // Let map gestures pass through the full-size pane. Individual label
    // icons opt back into pointer events via .spotterdex-marker-label-shell.
    labelPane.style.pointerEvents = "none";
    const trafficPane = state.map.createPane("spotterdexTrafficPane");
    trafficPane.style.zIndex = "600";
    trafficPane.style.pointerEvents = "none";
    state.mapTrafficLayer = window.L.layerGroup().addTo(state.map);
    state.mapLeaderLayer = window.L.layerGroup().addTo(state.map);
    state.markerLayer = window.L.layerGroup().addTo(state.map);
    state.mapLabelLayer = window.L.layerGroup().addTo(state.map);
    state.map.on("zoomstart", () => {
      state.mapZoomInProgress = true;
      if (isMobileMapLayout()) {
        window.cancelAnimationFrame(state.mapCalloutRefreshHandle);
        window.clearTimeout(state.mapCalloutRefreshTimer);
        els.worldMap.classList.add("is-map-zooming");
      }
    });
    state.map.on("zoomend", () => {
      state.mapZoomInProgress = false;
      if (isMobileMapLayout()) {
        scheduleMapCalloutRefresh();
      } else {
        refreshMapLayout();
      }
    });
    state.map.on("moveend", () => {
      if (state.mapZoomInProgress) {
        return;
      }
      if (isMobileMapLayout()) {
        scheduleMapCalloutRefresh();
      } else if (mapCalloutsNeedReflow()) {
        refreshMapLayout();
      }
    });
    observeMapSize();
  }

  function initializeMapWhenReady() {
    if (!els.worldMap || state.map) {
      return;
    }

    loadLeaflet()
      .then(() => loadOpenFreeMap())
      .then(() => {
        if (state.map || !els.worldMap) {
          return;
        }
        els.mapFallback.hidden = true;
        initMap();
        if (state.pendingMapFocusId) {
          const pendingPinId = state.pendingMapFocusId;
          state.pendingMapFocusId = null;
          focusMapPin(pendingPinId);
        } else {
          fitMapToPins({ animate: false });
        }
      })
      .catch((error) => {
        console.warn("Leaflet could not be loaded", error);
        els.mapFallback.hidden = false;
      });
  }

  function loadLeaflet() {
    if (window.L) {
      return Promise.resolve(window.L);
    }
    if (leafletLoadPromise) {
      return leafletLoadPromise;
    }

    leafletLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = LEAFLET_SCRIPT_URL;
      script.integrity = LEAFLET_SCRIPT_INTEGRITY;
      script.crossOrigin = "";
      script.async = true;
      script.dataset.leafletRuntime = "true";
      script.addEventListener("load", () => resolve(window.L), { once: true });
      script.addEventListener("error", () => reject(new Error("Leaflet runtime request failed")), { once: true });
      document.head.append(script);
    });
    return leafletLoadPromise;
  }

  function loadOpenFreeMap() {
    if (window.L?.maplibreGL) {
      return Promise.resolve(window.L.maplibreGL);
    }
    if (openFreeMapLoadPromise) {
      return openFreeMapLoadPromise;
    }

    openFreeMapLoadPromise = loadRuntimeScript(MAPLIBRE_SCRIPT_URL, "maplibreRuntime")
      .then(() => loadRuntimeScript(MAPLIBRE_LEAFLET_SCRIPT_URL, "maplibreLeafletRuntime"))
      .then(() => {
        if (!window.L?.maplibreGL) {
          throw new Error("OpenFreeMap Leaflet bridge did not initialize");
        }
        return window.L.maplibreGL;
      });
    return openFreeMapLoadPromise;
  }

  function loadRuntimeScript(src, dataAttribute) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset[dataAttribute] = "true";
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", () => reject(new Error(`${src} request failed`)), { once: true });
      document.head.append(script);
    });
  }

  function observeMapSize() {
    if (!window.ResizeObserver || !els.worldMap || state.mapResizeObserver) {
      return;
    }

    state.mapResizeObserver = new ResizeObserver(() => refreshMapLayout());
    state.mapResizeObserver.observe(els.worldMap);
    if (els.mapWorkspace) {
      state.mapResizeObserver.observe(els.mapWorkspace);
    }
  }

  function refreshMapLayout() {
    if (!state.map || !Number.isFinite(state.map.getZoom())) {
      return;
    }

    window.cancelAnimationFrame(state.mapRefreshHandle);
    window.clearTimeout(state.mapRefreshTimer);
    state.mapRefreshHandle = window.requestAnimationFrame(() => {
      state.map.invalidateSize({ pan: false });
      renderPins();
      const renderedSize = mapSizeKey();
      state.mapRefreshTimer = window.setTimeout(() => {
        state.map.invalidateSize({ pan: false });
        if (mapSizeKey() !== renderedSize) {
          renderPins();
        }
      }, 120);
    });
  }

  function scheduleMapCalloutRefresh(delay = 160) {
    if (!state.map || !Number.isFinite(state.map.getZoom())) {
      return;
    }
    window.cancelAnimationFrame(state.mapCalloutRefreshHandle);
    window.clearTimeout(state.mapCalloutRefreshTimer);
    state.mapCalloutRefreshTimer = window.setTimeout(() => {
      state.mapCalloutRefreshHandle = window.requestAnimationFrame(() => {
        renderMapCallouts();
        els.worldMap?.classList.remove("is-map-zooming");
      });
    }, delay);
  }

  function renderPins(options = {}) {
    if (
      !state.map ||
      !Number.isFinite(state.map.getZoom()) ||
      !state.markerLayer ||
      !state.mapLeaderLayer ||
      !state.mapLabelLayer ||
      !window.L
    ) {
      return;
    }

    ensureMapPinMarkers();
    renderMapCallouts();
    renderMapTraffic(options.refreshTraffic);
    if (!performance.getEntriesByName("spotterdex-map-ready").length) {
      performance.mark("spotterdex-map-ready");
    }
  }

  function ensureMapPinMarkers() {
    const pins = state.enabledPins;
    const hasEveryPin = state.markersByPinId.size === pins.length
      && pins.every((pin) => state.markersByPinId.has(pin.id));
    if (hasEveryPin) {
      return;
    }

    state.markerLayer.clearLayers();
    state.markersByPinId = new Map();
    pins.forEach((pin) => {
      const marker = window.L.marker([pin.lat, pin.lon], {
        icon: mapMarkerIcon(pin, pin.id === state.selectedPinId),
        title: pin.name,
        zIndexOffset: pin.id === state.selectedPinId ? 800 : 0
      })
        .on("click", () => selectPin(pin.id, { pan: false }))
        .addTo(state.markerLayer);
      const markerElement = marker.getElement();
      if (markerElement) {
        markerElement.setAttribute("aria-label", `Select ${pin.name}`);
        markerElement.setAttribute("title", pin.name);
      }
      state.markersByPinId.set(pin.id, marker);
    });
    state.activeMapMarkerId = state.selectedPinId;
  }

  function renderMapCallouts() {
    state.mapLeaderLayer.clearLayers();
    state.mapLabelLayer.clearLayers();
    state.mapLabelsByPinId = new Map();
    const pins = mapPinsForCallouts();
    const markerLayouts = mapMarkerLayouts(pins);
    const combineMobileCallouts = isMobileMapLayout();

    markerLayouts.forEach((layout) => {
      const { pin, callout } = layout;
      if (!combineMobileCallouts) {
        window.L.marker([pin.lat, pin.lon], {
          icon: mapLeaderIcon(callout),
          interactive: false,
          keyboard: false,
          pane: "spotterdexLeaderPane"
        }).addTo(state.mapLeaderLayer);
      }
      const labelMarker = window.L.marker([pin.lat, pin.lon], {
        icon: mapLabelIcon(pin, pin.id === state.selectedPinId, callout, combineMobileCallouts),
        title: `Select ${pin.name}`,
        keyboard: false,
        pane: "spotterdexLabelPane",
        zIndexOffset: pin.id === state.selectedPinId ? 900 : 0
      })
        .on("click", () => selectPin(pin.id, { pan: false }))
        .addTo(state.mapLabelLayer);
      state.mapLabelsByPinId.set(pin.id, labelMarker);
    });
    state.mapCalloutLayouts = markerLayouts.map((layout) => ({
      pinId: layout.pin.id,
      point: { x: layout.point.x, y: layout.point.y },
      bounds: layout.bounds
    }));
  }

  function mapPinsForCallouts() {
    if (!isMobileMapLayout() || !state.map) {
      return state.enabledPins;
    }

    const visibleBounds = state.map.getBounds().pad(0.22);
    const pins = state.enabledPins.filter((pin) => visibleBounds.contains([pin.lat, pin.lon]));
    const selectedPin = state.pinById.get(state.selectedPinId);
    if (selectedPin && !pins.some((pin) => pin.id === selectedPin.id)) {
      pins.push(selectedPin);
    }
    return declutterMobileCalloutPins(pins);
  }

  function declutterMobileCalloutPins(pins) {
    const zoom = state.map.getZoom();
    const minimumSeparation = zoom <= 3 ? 18 : zoom <= 5 ? 16 : zoom <= 7 ? 12 : 0;
    if (!minimumSeparation) {
      return pins;
    }

    const prioritized = pins.slice().sort((a, b) => {
      if (a.id === state.selectedPinId) return -1;
      if (b.id === state.selectedPinId) return 1;
      const aTime = photosForPin(a)[0]?.sortTime || 0;
      const bTime = photosForPin(b)[0]?.sortTime || 0;
      return bTime - aTime || a.name.localeCompare(b.name);
    });
    const accepted = [];
    const acceptedPoints = [];
    prioritized.forEach((pin) => {
      const point = state.map.latLngToContainerPoint([pin.lat, pin.lon]);
      const overlaps = acceptedPoints.some((other) => Math.hypot(point.x - other.x, point.y - other.y) < minimumSeparation);
      if (!overlaps || pin.id === state.selectedPinId) {
        accepted.push(pin);
        acceptedPoints.push(point);
      }
    });
    return accepted;
  }

  function mapSizeKey() {
    if (!state.map) {
      return "";
    }
    const size = state.map.getSize();
    return `${size.x}x${size.y}`;
  }

  function mapCalloutsNeedReflow() {
    if (!state.mapCalloutLayouts.length) {
      return true;
    }
    const mapSize = state.map.getSize();
    const margin = isMobileMapLayout() ? 8 : 12;
    return state.mapCalloutLayouts.some((layout) => {
      const pin = state.pinById.get(layout.pinId);
      if (!pin) {
        return true;
      }
      const point = state.map.latLngToContainerPoint([pin.lat, pin.lon]);
      const shiftX = point.x - layout.point.x;
      const shiftY = point.y - layout.point.y;
      return (
        layout.bounds.left + shiftX < margin ||
        layout.bounds.right + shiftX > mapSize.x - margin ||
        layout.bounds.top + shiftY < margin ||
        layout.bounds.bottom + shiftY > mapSize.y - margin
      );
    });
  }

  function mapMarkerLayouts(pins) {
    const mapSize = state.map.getSize();
    const markerRadius = 12;
    const margin = isMobileMapLayout() ? 8 : 12;
    const blockedBounds = mapCalloutBlockedBounds();
    const layouts = pins.map((pin) => {
      return {
        pin,
        // Callouts are positioned inside the marker DOM, so keep their collision
        // layout in the map container's coordinate system. Layer points drift when
        // Leaflet translates a pane during a resize or pan.
        point: state.map.latLngToContainerPoint([pin.lat, pin.lon]),
        labelText: mapPinLabel(pin),
        labelSize: mapLabelSize(mapPinLabel(pin)),
        callout: null
      };
    });
    const reachableLayouts = layouts.filter((layout) => mapLayoutCanReachViewport(layout, mapSize));
    const offscreenLayouts = layouts.filter((layout) => !reachableLayouts.includes(layout));
    assignLocalCalloutFans(reachableLayouts, mapSize, margin);
    reachableLayouts.forEach((layout) => {
      layout.candidates = mapLabelCandidates(layout, mapSize);
    });
    const markerPoints = layouts
      .map((layout) => layout.point)
      .filter((point) => (
        point.x >= -markerRadius && point.x <= mapSize.x + markerRadius &&
        point.y >= -markerRadius && point.y <= mapSize.y + markerRadius
      ));
    const order = reachableLayouts.slice().sort((a, b) => mapSelectedFirstOrder(a, b, mapLayoutScreenOrder));
    const bestArrangement = mapLabelArrangement(order, markerPoints, markerRadius, blockedBounds);
    reachableLayouts.forEach((layout) => {
      layout.bounds = bestArrangement.bounds.get(layout);
    });
    resolveMapLabelCollisions(reachableLayouts, markerPoints, markerRadius, blockedBounds);
    resolveMapLabelObstructions(reachableLayouts, markerPoints, markerRadius, blockedBounds);
    resolveMapLabelCollisions(reachableLayouts, markerPoints, markerRadius, blockedBounds);
    offscreenLayouts.forEach((layout) => {
      layout.calloutClusterId = -1;
      layout.calloutClusterSize = 1;
      layout.bounds = mapOffscreenLabelBounds(layout, mapSize);
    });
    layouts.forEach((layout) => {
      layout.callout = mapCalloutForBounds(layout, layout.bounds);
    });

    return layouts;
  }

  function mapLayoutCanReachViewport(layout, mapSize) {
    const reach = mapLeaderMaximumLength();
    return (
      layout.point.x >= -reach && layout.point.x <= mapSize.x + reach &&
      layout.point.y >= -reach && layout.point.y <= mapSize.y + reach
    );
  }

  function mapOffscreenLabelBounds(layout, mapSize) {
    const { width, height } = layout.labelSize;
    const offset = isMobileMapLayout() ? 20 : 28;
    const placeLeft = layout.point.x > mapSize.x / 2;
    const left = placeLeft
      ? layout.point.x - offset - width
      : layout.point.x + offset;
    const top = Math.round(layout.point.y - height / 2);
    return { left, right: left + width, top, bottom: top + height };
  }

  function mapSelectedFirstOrder(a, b, fallbackComparator) {
    const aSelected = a.pin.id === state.selectedPinId;
    const bSelected = b.pin.id === state.selectedPinId;
    if (aSelected !== bSelected) {
      return aSelected ? -1 : 1;
    }
    return fallbackComparator(a, b);
  }

  function mapLabelArrangement(order, markerPoints, markerRadius, blockedBounds) {
    const occupied = [];
    const bounds = new Map();
    order.forEach((layout) => {
      const available = layout.candidates.find((candidate) => (
        !candidateOverlapsLabels(candidate.bounds, occupied) &&
        !candidateOverlapsBlockedBounds(candidate.bounds, blockedBounds) &&
        !candidateOverlapsMarkers(candidate.bounds, markerPoints, markerRadius) &&
        !candidateCrossesOccupiedLeaders(candidate, layout, occupied)
      ));
      let chosen = available;
      if (!chosen) {
        let bestScore = Number.POSITIVE_INFINITY;
        layout.candidates.forEach((candidate) => {
          const score = mapLabelCandidateScore(candidate, layout, occupied, markerPoints, markerRadius, blockedBounds);
          if (score < bestScore) {
            chosen = candidate;
            bestScore = score;
          }
        });
      }
      bounds.set(layout, chosen.bounds);
      occupied.push({ layout, bounds: chosen.bounds });
    });
    return { bounds };
  }

  function mapLabelSize(title) {
    const isCompact = isMobileMapLayout();
    if (isCompact) {
      return {
        width: Math.min(132, Math.max(54, Math.ceil(title.length * 7.2 + 14))),
        height: 24
      };
    }

    if (isDenseDesktopMapLayout()) {
      return {
        width: Math.min(252, Math.max(82, Math.ceil(title.length * 6 + 12))),
        height: 25
      };
    }
    return {
      width: Math.min(280, Math.max(88, Math.ceil(title.length * 6.65 + 14))),
      height: 28
    };
  }

  function mapLabelGap() {
    return isMobileMapLayout() ? MAP_LABEL_GAP_COMPACT : MAP_LABEL_GAP_DESKTOP;
  }

  function mapLeaderPreferredLength() {
    return isMobileMapLayout() ? MAP_LEADER_PREFERRED_COMPACT : MAP_LEADER_PREFERRED_DESKTOP;
  }

  function mapLeaderMaximumLength() {
    return isMobileMapLayout() ? MAP_LEADER_MAXIMUM_COMPACT : MAP_LEADER_MAXIMUM_DESKTOP;
  }

  function mapLabelCandidates(layout, mapSize) {
    const margin = isMobileMapLayout() ? 8 : 12;
    const candidates = [];
    const preferredDirection = layout.preferredFan?.direction || "right";
    const alternateDirection = preferredDirection === "right" ? "left" : "right";

    if (layout.calloutClusterSize === 1) {
      appendCompassMapLabelCandidates(candidates, layout, mapSize, margin, 0);
    }

    appendLocalFanCandidates(candidates, layout, mapSize, margin, preferredDirection, true);
    appendLocalFanCandidates(candidates, layout, mapSize, margin, alternateDirection, false);

    if (layout.calloutClusterSize > 1) {
      appendCompassMapLabelCandidates(candidates, layout, mapSize, margin, 72);
    }
    appendLocalGridMapLabelCandidates(candidates, layout, mapSize, margin);

    const deduped = Array.from(new Map(candidates.map((candidate) => [
      `${candidate.bounds.left}:${candidate.bounds.top}:${candidate.bounds.right}:${candidate.bounds.bottom}`,
      candidate
    ])).values())
      .sort((a, b) => (
        a.baseScore - b.baseScore ||
        a.bounds.top - b.bounds.top ||
        a.bounds.left - b.bounds.left
      ))
      .slice(0, 120);

    if (deduped.length) {
      return deduped;
    }

    const { width, height } = layout.labelSize;
    const offset = isMobileMapLayout() ? 20 : 28;
    const placeRight = layout.point.x <= mapSize.x / 2;
    const left = Math.max(margin, Math.min(mapSize.x - margin - width, layout.point.x - width / 2));
    const top = Math.max(margin, Math.min(mapSize.y - margin - height, layout.point.y - height / 2));
    const fallbackLeft = Math.max(margin, Math.min(
      mapSize.x - margin - width,
      placeRight ? layout.point.x + offset : layout.point.x - offset - width
    ));
    const bounds = {
      left: Number.isFinite(fallbackLeft) ? fallbackLeft : left,
      right: (Number.isFinite(fallbackLeft) ? fallbackLeft : left) + width,
      top,
      bottom: top + height
    };
    return [{
      bounds,
      direction: placeRight ? "right" : "left",
      leaderPoints: mapLeaderAbsolutePoints(layout, bounds),
      leaderLength: mapLeaderLength(mapLeaderAbsolutePoints(layout, bounds)),
      distance: 0,
      baseScore: 10000
    }];
  }

  function assignLocalCalloutFans(layouts, mapSize, margin) {
    const clusters = mapCalloutClusters(layouts, mapSize);
    clusters.forEach((cluster, clusterId) => {
      const lanes = mapLocalFanLanes(cluster, mapSize, margin);
      const defaultDirection = mapLocalFanDefaultDirection(cluster, lanes, mapSize);
      const assignments = mapLocalFanAssignments(cluster, lanes, defaultDirection);
      const rowTops = mapLocalFanRowTops(assignments, mapSize, margin);
      cluster.forEach((layout) => {
        layout.calloutClusterId = clusterId;
        layout.calloutClusterSize = cluster.length;
        layout.localFanLanes = lanes;
        const direction = assignments.get(layout) || defaultDirection;
        layout.preferredFan = {
          direction,
          anchor: lanes[direction]?.anchor ?? null,
          top: rowTops.get(layout) ?? Math.round(layout.point.y - layout.labelSize.height / 2)
        };
      });
    });
  }

  function mapLocalFanLanes(cluster, mapSize, margin) {
    const offset = isMobileMapLayout() ? 20 : 28;
    const maximumWidth = Math.max(...cluster.map((layout) => layout.labelSize.width));
    const minimumX = Math.min(...cluster.map((layout) => layout.point.x));
    const maximumX = Math.max(...cluster.map((layout) => layout.point.x));
    const leftAnchor = Math.round(minimumX - offset);
    const rightAnchor = Math.round(maximumX + offset);
    const maximumLeader = mapLeaderMaximumLength();

    const leftValid = leftAnchor - maximumWidth >= margin && cluster.every((layout) => (
      layout.point.x - leftAnchor <= maximumLeader
    ));
    const rightValid = rightAnchor + maximumWidth <= mapSize.x - margin && cluster.every((layout) => (
      rightAnchor - layout.point.x <= maximumLeader
    ));

    return {
      left: leftValid ? { direction: "left", anchor: leftAnchor } : null,
      right: rightValid ? { direction: "right", anchor: rightAnchor } : null
    };
  }

  function mapLocalFanDefaultDirection(cluster, lanes, mapSize) {
    const centerX = cluster.reduce((total, layout) => total + layout.point.x, 0) / cluster.length;
    const outwardDirection = centerX <= mapSize.x / 2 ? "left" : "right";
    if (lanes[outwardDirection]) {
      return outwardDirection;
    }
    const alternateDirection = outwardDirection === "right" ? "left" : "right";
    return lanes[alternateDirection] ? alternateDirection : outwardDirection;
  }

  function mapLocalFanAssignments(cluster, lanes, defaultDirection) {
    const assignments = new Map();
    const alternateDirection = defaultDirection === "right" ? "left" : "right";
    const canSplit = cluster.length >= 5 && lanes.left && lanes.right;
    const fallbackDirection = lanes[defaultDirection]
      ? defaultDirection
      : lanes[alternateDirection]
        ? alternateDirection
        : defaultDirection;

    if (!canSplit) {
      cluster.forEach((layout) => assignments.set(layout, fallbackDirection));
      return assignments;
    }

    const sideHeights = { left: 0, right: 0 };
    cluster
      .slice()
      .sort(mapLayoutScreenOrder)
      .forEach((layout) => {
        const direction = sideHeights[defaultDirection] <= sideHeights[alternateDirection]
          ? defaultDirection
          : alternateDirection;
        assignments.set(layout, direction);
        sideHeights[direction] += layout.labelSize.height + mapLabelGap();
      });
    return assignments;
  }

  function mapLocalFanRowTops(assignments, mapSize, margin) {
    const tops = new Map();
    ["left", "right"].forEach((direction) => {
      const layouts = Array.from(assignments.entries())
        .filter(([, assignedDirection]) => assignedDirection === direction)
        .map(([layout]) => layout)
        .sort(mapLayoutScreenOrder);
      if (!layouts.length) {
        return;
      }

      let previousBottom = -Infinity;
      layouts.forEach((layout) => {
        const idealTop = Math.round(layout.point.y - layout.labelSize.height / 2);
        const top = Math.max(idealTop, previousBottom + mapLabelGap());
        tops.set(layout, top);
        previousBottom = top + layout.labelSize.height;
      });

      const firstTop = tops.get(layouts[0]);
      const lastLayout = layouts[layouts.length - 1];
      const lastBottom = tops.get(lastLayout) + lastLayout.labelSize.height;
      const shiftDown = Math.max(0, margin - firstTop);
      const shiftUp = Math.max(0, lastBottom + shiftDown - (mapSize.y - margin));
      const shift = shiftDown - shiftUp;
      if (shift) {
        layouts.forEach((layout) => tops.set(layout, tops.get(layout) + shift));
      }
    });
    return tops;
  }

  function mapLayoutScreenOrder(a, b) {
    return a.point.y - b.point.y || a.point.x - b.point.x || a.pin.id.localeCompare(b.pin.id);
  }

  function mapCalloutClusters(layouts) {
    const threshold = isMobileMapLayout()
      ? MAP_CLUSTER_SCREEN_DISTANCE_COMPACT
      : MAP_CLUSTER_SCREEN_DISTANCE_DESKTOP;
    const remaining = new Set(layouts);
    const clusters = [];

    while (remaining.size) {
      const candidates = Array.from(remaining);
      const anchor = candidates
        .map((layout) => ({
          layout,
          nearby: candidates.filter((candidate) => (
            mapPinsShareCalloutCluster(candidate, layout, threshold)
          )).length
        }))
        .sort((a, b) => (
          b.nearby - a.nearby ||
          mapLayoutScreenOrder(a.layout, b.layout)
        ))[0].layout;
      const cluster = candidates.filter((candidate) => (
        mapPinsShareCalloutCluster(candidate, anchor, threshold)
      )).sort(mapLayoutScreenOrder);
      cluster.forEach((layout) => remaining.delete(layout));
      clusters.push(cluster);
    }

    return clusters;
  }

  function mapPinsShareCalloutCluster(first, second, screenThreshold) {
    const screenDistance = Math.hypot(first.point.x - second.point.x, first.point.y - second.point.y);
    return screenDistance <= screenThreshold && mapPinDistanceKm(first.pin, second.pin) <= MAP_CLUSTER_DISTANCE_KM;
  }

  function mapPinDistanceKm(first, second) {
    const toRadians = Math.PI / 180;
    const latitudeDelta = (second.lat - first.lat) * toRadians;
    const longitudeDelta = (second.lon - first.lon) * toRadians;
    const a = (
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(first.lat * toRadians) * Math.cos(second.lat * toRadians) *
      Math.sin(longitudeDelta / 2) ** 2
    );
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function appendLocalFanCandidates(candidates, layout, mapSize, margin, direction, isPreferred) {
    const { width, height } = layout.labelSize;
    const lane = layout.localFanLanes?.[direction];
    if (!lane) {
      return;
    }

    const verticalStep = isMobileMapLayout() ? 8 : 12;
    const maximumVerticalOffset = isMobileMapLayout() ? 112 : 168;
    const verticalOffsets = [0];
    for (let offset = verticalStep; offset <= maximumVerticalOffset; offset += verticalStep) {
      verticalOffsets.push(-offset, offset);
    }
    const laneStep = isMobileMapLayout() ? 20 : 28;
    const preferredTop = isPreferred
      ? layout.preferredFan.top
      : Math.round(layout.point.y - height / 2);

    for (let laneIndex = 0; laneIndex < 4; laneIndex += 1) {
      const anchor = lane.anchor + (direction === "right" ? laneIndex * laneStep : -laneIndex * laneStep);
      const horizontalDistance = direction === "right"
        ? anchor - layout.point.x
        : layout.point.x - anchor;
      if (horizontalDistance < 0 || horizontalDistance > mapLeaderMaximumLength()) {
        continue;
      }

      verticalOffsets.forEach((verticalOffset, verticalIndex) => {
        const top = preferredTop + verticalOffset;
        const left = direction === "right" ? anchor : anchor - width;
        const bounds = {
          left,
          right: left + width,
          top,
          bottom: top + height
        };
        appendMapLabelCandidate(
          candidates,
          layout,
          bounds,
          direction,
          mapSize,
          margin,
          (isPreferred ? 0 : 42) + laneIndex * 18 + verticalIndex * 9
        );
      });
    }
  }

  function appendCompassMapLabelCandidates(candidates, layout, mapSize, margin, preferencePenalty) {
    const { width, height } = layout.labelSize;
    const offset = isMobileMapLayout() ? 20 : 28;
    const preferredDirection = layout.preferredFan?.direction || "right";
    const right = layout.point.x + offset;
    const left = layout.point.x - offset - width;
    const above = layout.point.y - offset - height;
    const below = layout.point.y + offset;
    const centeredLeft = Math.round(layout.point.x - width / 2);
    const centeredTop = Math.round(layout.point.y - height / 2);
    const positions = preferredDirection === "right"
      ? [
          [right, centeredTop, "right"],
          [right, above, "right"],
          [right, below, "right"],
          [centeredLeft, above, "top"],
          [centeredLeft, below, "bottom"],
          [left, above, "left"],
          [left, below, "left"],
          [left, centeredTop, "left"]
        ]
      : [
          [left, centeredTop, "left"],
          [left, above, "left"],
          [left, below, "left"],
          [centeredLeft, above, "top"],
          [centeredLeft, below, "bottom"],
          [right, above, "right"],
          [right, below, "right"],
          [right, centeredTop, "right"]
        ];

    positions.forEach(([candidateLeft, candidateTop, direction], index) => {
      appendMapLabelCandidate(
        candidates,
        layout,
        {
          left: Math.round(candidateLeft),
          right: Math.round(candidateLeft + width),
          top: Math.round(candidateTop),
          bottom: Math.round(candidateTop + height)
        },
        direction,
        mapSize,
        margin,
        preferencePenalty + index * 5
      );
    });
  }

  function appendLocalGridMapLabelCandidates(candidates, layout, mapSize, margin) {
    const { width, height } = layout.labelSize;
    const minimumOffset = isMobileMapLayout() ? 20 : 28;
    const horizontalStep = isMobileMapLayout() ? 24 : 36;
    const verticalStep = isMobileMapLayout() ? 10 : 18;
    const maximumLength = mapLeaderMaximumLength();
    let laneIndex = 0;

    for (let horizontalOffset = minimumOffset; horizontalOffset <= maximumLength; horizontalOffset += horizontalStep) {
      ["left", "right"].forEach((direction) => {
        const anchor = direction === "right"
          ? layout.point.x + horizontalOffset
          : layout.point.x - horizontalOffset;
        const left = direction === "right" ? anchor : anchor - width;

        for (let verticalOffset = -maximumLength; verticalOffset <= maximumLength; verticalOffset += verticalStep) {
          const top = Math.round(layout.point.y - height / 2 + verticalOffset);
          appendMapLabelCandidate(
            candidates,
            layout,
            { left, right: left + width, top, bottom: top + height },
            direction,
            mapSize,
            margin,
            120 + laneIndex * 4 + Math.abs(verticalOffset) * 0.2
          );
        }
      });
      laneIndex += 1;
    }
  }

  function appendMapLabelCandidate(candidates, layout, bounds, direction, mapSize, margin, preferencePenalty) {
    if (
      bounds.left < margin ||
      bounds.right > mapSize.x - margin ||
      bounds.top < margin ||
      bounds.bottom > mapSize.y - margin
    ) {
      return;
    }

    const leaderPoints = mapLeaderAbsolutePoints(layout, bounds);
    const leaderLength = mapLeaderLength(leaderPoints);
    if (leaderLength > mapLeaderMaximumLength()) {
      return;
    }

    const verticalDisplacement = Math.abs((bounds.top + bounds.bottom) / 2 - layout.point.y);
    const excessLength = Math.max(0, leaderLength - mapLeaderPreferredLength());
    candidates.push({
      bounds,
      direction,
      leaderPoints,
      leaderLength,
      distance: leaderLength,
      baseScore: leaderLength + verticalDisplacement * 0.7 + excessLength * 8 + preferencePenalty
    });
  }

  function mapLeaderAbsolutePoints(layout, bounds) {
    const labelLeft = bounds.left - layout.point.x;
    const labelTop = bounds.top - layout.point.y;
    const labelRight = bounds.right - layout.point.x;
    const labelBottom = bounds.bottom - layout.point.y;
    const endpoint = {
      x: Math.max(labelLeft, Math.min(0, labelRight)),
      y: Math.max(labelTop, Math.min(0, labelBottom))
    };
    const isHorizontalEdge = endpoint.x === labelLeft || endpoint.x === labelRight;
    const bend = isHorizontalEdge
      ? { x: Math.round(endpoint.x * 0.58), y: endpoint.y }
      : { x: endpoint.x, y: Math.round(endpoint.y * 0.58) };
    return [
      { x: layout.point.x, y: layout.point.y },
      { x: layout.point.x + bend.x, y: layout.point.y + bend.y },
      { x: layout.point.x + endpoint.x, y: layout.point.y + endpoint.y }
    ];
  }

  function mapLeaderLength(points) {
    let length = 0;
    for (let index = 1; index < points.length; index += 1) {
      length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    }
    return length;
  }

  function mapCalloutBlockedBounds() {
    const mapRect = els.worldMap && els.worldMap.getBoundingClientRect();
    if (!mapRect || !mapRect.width || !mapRect.height) {
      return [];
    }
    return [els.mapControlPanel, els.mapResults]
      .map((panel) => mapPanelCalloutBounds(panel, mapRect))
      .filter(Boolean);
  }

  function mapPanelCalloutBounds(panel, mapRect) {
    if (!panel || !mapPanelShouldReserveSpace(panel)) {
      return null;
    }
    const rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }
    const isLeftPanel = panel === els.mapControlPanel;
    const style = window.getComputedStyle(panel);
    const sideProperty = isLeftPanel ? "left" : "right";
    const computedInset = Number.parseFloat(style[sideProperty]);
    const fallbackInset = isLeftPanel ? rect.left - mapRect.left : mapRect.right - rect.right;
    const inset = Number.isFinite(computedInset) ? computedInset : fallbackInset;
    const width = Math.min(rect.width, mapRect.width);
    const left = isLeftPanel ? inset : mapRect.width - inset - width;
    const top = Math.max(0, rect.top - mapRect.top);
    const bottom = Math.min(mapRect.height, rect.bottom - mapRect.top);
    if (bottom <= top) {
      return null;
    }
    return {
      left: Math.max(0, left - MAP_PANEL_GAP),
      right: Math.min(mapRect.width, left + width + MAP_PANEL_GAP),
      top: Math.max(0, top - MAP_PANEL_GAP),
      bottom: Math.min(mapRect.height, bottom + MAP_PANEL_GAP)
    };
  }

  function mapPanelShouldReserveSpace(panel) {
    if (isMobileMapLayout() || isReducedMotion()) {
      return false;
    }
    if (panel === els.mapControlPanel) {
      return state.mapControlPanelOpen;
    }
    if (panel === els.mapResults) {
      return state.mapDossierOpen;
    }
    return false;
  }

  function candidateOverlapsLabels(bounds, occupied) {
    return occupied.some((other) => rectsOverlap(bounds, other.bounds || other, mapLabelGap()));
  }

  function candidateOverlapsBlockedBounds(bounds, blockedBounds) {
    return blockedBounds.some((blocked) => rectsOverlap(bounds, blocked, mapLabelGap()));
  }

  function candidateOverlapsMarkers(bounds, markerPoints, radius) {
    return markerPoints.some((point) => (
      point.x >= bounds.left - radius &&
      point.x <= bounds.right + radius &&
      point.y >= bounds.top - radius &&
      point.y <= bounds.bottom + radius
    ));
  }

  function candidateCrossesOccupiedLeaders(candidate, layout, occupied) {
    const candidatePoints = candidate.leaderPoints || mapLeaderAbsolutePoints(layout, candidate.bounds);
    return occupied.some((other) => (
      mapPolylinesCross(candidatePoints, mapLeaderAbsolutePoints(other.layout, other.bounds))
    ));
  }

  function mapPolylinesCross(firstPoints, secondPoints) {
    for (let firstIndex = 1; firstIndex < firstPoints.length; firstIndex += 1) {
      for (let secondIndex = 1; secondIndex < secondPoints.length; secondIndex += 1) {
        if (mapSegmentsCross(
          firstPoints[firstIndex - 1],
          firstPoints[firstIndex],
          secondPoints[secondIndex - 1],
          secondPoints[secondIndex]
        )) {
          return true;
        }
      }
    }
    return false;
  }

  function mapSegmentsCross(firstStart, firstEnd, secondStart, secondEnd) {
    const samePoint = (first, second) => (
      Math.abs(first.x - second.x) < 0.5 && Math.abs(first.y - second.y) < 0.5
    );
    if (
      samePoint(firstStart, secondStart) ||
      samePoint(firstStart, secondEnd) ||
      samePoint(firstEnd, secondStart) ||
      samePoint(firstEnd, secondEnd)
    ) {
      return false;
    }

    const cross = (origin, first, second) => (
      (first.x - origin.x) * (second.y - origin.y) -
      (first.y - origin.y) * (second.x - origin.x)
    );
    const firstSide = cross(firstStart, firstEnd, secondStart);
    const secondSide = cross(firstStart, firstEnd, secondEnd);
    const thirdSide = cross(secondStart, secondEnd, firstStart);
    const fourthSide = cross(secondStart, secondEnd, firstEnd);
    return firstSide * secondSide < 0 && thirdSide * fourthSide < 0;
  }

  function mapLabelCandidateScore(candidate, layout, occupied, markerPoints, radius, blockedBounds) {
    const labelOverlap = occupied.reduce((total, other) => total + rectOverlapArea(candidate.bounds, other.bounds || other, mapLabelGap()), 0);
    const blockedOverlap = blockedBounds.reduce((total, blocked) => (
      total + rectOverlapArea(candidate.bounds, blocked, mapLabelGap())
    ), 0);
    const leaderCrossings = occupied.reduce((total, other) => (
      total + (mapPolylinesCross(
        candidate.leaderPoints || mapLeaderAbsolutePoints(layout, candidate.bounds),
        mapLeaderAbsolutePoints(other.layout, other.bounds)
      ) ? 1 : 0)
    ), 0);
    const markerOverlap = markerPoints.reduce((total, point) => {
      const overlaps = (
        point.x >= candidate.bounds.left - radius &&
        point.x <= candidate.bounds.right + radius &&
        point.y >= candidate.bounds.top - radius &&
        point.y <= candidate.bounds.bottom + radius
      );
      return total + (overlaps ? 1 : 0);
    }, 0);
    return (
      (candidate.baseScore || candidate.distance) +
      leaderCrossings * 4000 +
      labelOverlap * 1000 +
      markerOverlap * 100000 +
      blockedOverlap * 100000
    );
  }

  function resolveMapLabelCollisions(layouts, markerPoints, radius, blockedBounds) {
    const maximumPasses = layouts.length * layouts.length;
    for (let pass = 0; pass < maximumPasses; pass += 1) {
      const pairs = overlappingLabelPairs(layouts);
      if (!pairs.length) {
        return;
      }

      let moved = false;
      for (const [first, second] of pairs) {
        const otherLayouts = layouts.filter((layout) => layout !== first && layout !== second);
        const firstSelected = first.pin.id === state.selectedPinId;
        const secondSelected = second.pin.id === state.selectedPinId;
        const firstAlternative = firstSelected && !secondSelected
          ? null
          : mapLabelAlternative(first, second, otherLayouts, markerPoints, radius, blockedBounds);
        const secondAlternative = secondSelected && !firstSelected
          ? null
          : mapLabelAlternative(second, first, otherLayouts, markerPoints, radius, blockedBounds);

        if (firstAlternative || secondAlternative) {
          const useFirst = firstAlternative && (!secondAlternative || firstAlternative.baseScore <= secondAlternative.baseScore);
          const target = useFirst ? first : second;
          const alternative = useFirst ? firstAlternative : secondAlternative;
          target.bounds = alternative.bounds;
          moved = true;
          break;
        }
      }
      if (!moved) {
        return;
      }
    }
  }

  function resolveMapLabelObstructions(layouts, markerPoints, radius, blockedBounds) {
    const maximumPasses = layouts.length * 2;
    for (let pass = 0; pass < maximumPasses; pass += 1) {
      const obstructed = layouts.find((layout) => (
        candidateOverlapsBlockedBounds(layout.bounds, blockedBounds) ||
        candidateOverlapsMarkers(layout.bounds, markerPoints, radius)
      ));
      if (!obstructed) {
        return;
      }

      const occupied = layouts
        .filter((layout) => layout !== obstructed)
        .map((layout) => ({ layout, bounds: layout.bounds }));
      const alternative = obstructed.candidates.find((candidate) => (
        !sameRect(candidate.bounds, obstructed.bounds) &&
        !candidateOverlapsLabels(candidate.bounds, occupied) &&
        !candidateOverlapsBlockedBounds(candidate.bounds, blockedBounds) &&
        !candidateOverlapsMarkers(candidate.bounds, markerPoints, radius)
      ));
      if (!alternative) {
        return;
      }
      obstructed.bounds = alternative.bounds;
    }
  }

  function overlappingLabelPairs(layouts) {
    const pairs = [];
    for (let index = 0; index < layouts.length; index += 1) {
      for (let comparison = index + 1; comparison < layouts.length; comparison += 1) {
        if (rectsOverlap(layouts[index].bounds, layouts[comparison].bounds, mapLabelGap())) {
          pairs.push([layouts[index], layouts[comparison]]);
        }
      }
    }
    return pairs;
  }

  function mapLabelAlternative(layout, pairedLayout, otherLayouts, markerPoints, radius, blockedBounds) {
    const occupied = otherLayouts.map((otherLayout) => ({
      layout: otherLayout,
      bounds: otherLayout.bounds
    }));
    const allOccupied = occupied.concat({ layout: pairedLayout, bounds: pairedLayout.bounds });
    const viable = layout.candidates.filter((candidate) => (
      !sameRect(candidate.bounds, layout.bounds) &&
      !candidateOverlapsBlockedBounds(candidate.bounds, blockedBounds) &&
      !candidateOverlapsMarkers(candidate.bounds, markerPoints, radius)
    ));
    const clear = viable.find((candidate) => !candidateOverlapsLabels(candidate.bounds, allOccupied));
    if (clear) {
      return clear;
    }

    const currentPenalty = mapCandidateOverlapPenalty(layout.bounds, allOccupied);
    const best = viable
      .map((candidate) => ({
        candidate,
        penalty: mapCandidateOverlapPenalty(candidate.bounds, allOccupied)
      }))
      .filter(({ penalty }) => penalty < currentPenalty)
      .sort((a, b) => a.penalty - b.penalty || a.candidate.baseScore - b.candidate.baseScore)[0];
    return best ? best.candidate : null;
  }

  function mapCandidateOverlapPenalty(bounds, occupied) {
    return occupied.reduce((total, other) => {
      const area = rectOverlapArea(bounds, other.bounds || other, mapLabelGap());
      return total + (area > 0 ? 1000000 + area * 1000 : 0);
    }, 0);
  }

  function sameRect(a, b) {
    return a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;
  }

  function rectsOverlap(a, b, padding = 0) {
    return !(
      a.right + padding <= b.left ||
      a.left - padding >= b.right ||
      a.bottom + padding <= b.top ||
      a.top - padding >= b.bottom
    );
  }

  function rectOverlapArea(a, b, padding = 0) {
    const left = Math.max(a.left - padding, b.left - padding);
    const right = Math.min(a.right + padding, b.right + padding);
    const top = Math.max(a.top - padding, b.top - padding);
    const bottom = Math.min(a.bottom + padding, b.bottom + padding);
    return right > left && bottom > top ? (right - left) * (bottom - top) : 0;
  }

  function mapCalloutForBounds(layout, bounds) {
    const labelLeft = bounds.left - layout.point.x;
    const labelTop = bounds.top - layout.point.y;
    const labelRight = bounds.right - layout.point.x;
    const labelBottom = bounds.bottom - layout.point.y;
    const endpoint = {
      x: Math.max(labelLeft, Math.min(0, labelRight)),
      y: Math.max(labelTop, Math.min(0, labelBottom))
    };
    const isHorizontalEdge = endpoint.x === labelLeft || endpoint.x === labelRight;
    const bend = isHorizontalEdge
      ? { x: Math.round(endpoint.x * 0.58), y: endpoint.y }
      : { x: endpoint.x, y: Math.round(endpoint.y * 0.58) };
    const leader = mapLeaderGeometry([{ x: 0, y: 0 }, bend, endpoint]);

    return {
      labelLeft,
      labelTop,
      width: layout.labelSize.width,
      height: layout.labelSize.height,
      leader
    };
  }

  function mapLeaderGeometry(points) {
    const padding = 4;
    const minX = Math.min(...points.map((point) => point.x)) - padding;
    const maxX = Math.max(...points.map((point) => point.x)) + padding;
    const minY = Math.min(...points.map((point) => point.y)) - padding;
    const maxY = Math.max(...points.map((point) => point.y)) + padding;
    return {
      left: minX,
      top: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      points: points.map((point) => `${Math.round(point.x - minX)},${Math.round(point.y - minY)}`).join(" ")
    };
  }

  function renderMapTraffic(force = false) {
    if (!state.mapTrafficLayer || !window.L) {
      return;
    }
    const mobileLayout = isMobileMapLayout();
    if (state.mapTrafficInitialized && !force && state.mapTrafficMobileLayout === mobileLayout) {
      return;
    }
    stopMapTrafficFamilyRotation();
    state.mapTrafficLayer.clearLayers();
    state.mapTrafficMarkersByPinId = new Map();
    state.mapTrafficFamiliesByPinId = new Map();
    state.mapTrafficFamilyIndexByPinId = new Map();

    const trafficPins = mobileLayout
      ? mobileMapTrafficPins()
      : state.enabledPins;
    trafficPins.forEach((pin) => {
      const families = mapLocationPreview([pin]).families;
      if (!families.length) {
        return;
      }
      const initialIndex = Math.floor(Math.random() * families.length);
      const family = families[initialIndex];
      const marker = window.L.marker([pin.lat, pin.lon], {
        icon: mapTrafficIcon(pin, family),
        pane: "spotterdexTrafficPane",
        interactive: false,
        keyboard: false,
        zIndexOffset: -120
      }).addTo(state.mapTrafficLayer);
      state.mapTrafficMarkersByPinId.set(pin.id, marker);
      state.mapTrafficFamiliesByPinId.set(pin.id, families);
      state.mapTrafficFamilyIndexByPinId.set(pin.id, initialIndex);
    });
    startMapTrafficFamilyRotation();
    state.mapTrafficMobileLayout = mobileLayout;
    state.mapTrafficInitialized = true;
  }

  function mobileMapTrafficPins() {
    // Keep the phone map light while ensuring every selected pin has a family icon.
    const eligiblePins = state.enabledPins.filter((pin) => mapLocationPreview([pin]).families.length);
    if (!state.mobileMapTrafficPinIds) {
      const shuffled = eligiblePins.slice();
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      state.mobileMapTrafficPinIds = shuffled
        .slice(0, MOBILE_MAP_TRAFFIC_PIN_LIMIT)
        .map((pin) => pin.id);
    }

    const selectedPinIds = new Set(state.mobileMapTrafficPinIds);
    return eligiblePins.filter((pin) => selectedPinIds.has(pin.id));
  }

  function mapTrafficIcon(pin, family) {
    const motion = trafficMotionFor(pin.id);
    const directionClass = motion.approaching ? " is-approaching" : " is-departing";
    return window.L.divIcon({
      className: "spotterdex-traffic-anchor",
      html: `
        <span
          class="map-traffic-aircraft${directionClass}"
          data-traffic-pin="${escapeAttr(pin.id)}"
          style="--traffic-start-x: ${motion.startX}px; --traffic-start-y: ${motion.startY}px; --traffic-end-x: ${motion.endX}px; --traffic-end-y: ${motion.endY}px; --traffic-heading: ${motion.heading}deg; --traffic-delay: -${motion.delay}ms; --traffic-duration: ${motion.duration}ms;"
          aria-hidden="true"
        >
          <img src="${escapeAttr(family.mapIcon || family.icon)}" data-traffic-family="${escapeAttr(family.id)}" loading="lazy" decoding="async" fetchpriority="low" alt="">
        </span>
      `,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  function startMapTrafficFamilyRotation() {
    const hasRotatingBase = Array.from(state.mapTrafficFamiliesByPinId.values()).some((families) => families.length > 1);
    if (!hasRotatingBase || isMobileMapLayout() || isReducedMotion()) {
      return;
    }
    state.mapTrafficRotationTimer = window.setInterval(rotateMapTrafficFamilies, MAP_TRAFFIC_FAMILY_ROTATION_MS);
  }

  function stopMapTrafficFamilyRotation() {
    window.clearInterval(state.mapTrafficRotationTimer);
    state.mapTrafficRotationTimer = null;
  }

  function rotateMapTrafficFamilies() {
    if (isMobileMapLayout() || isReducedMotion()) {
      stopMapTrafficFamilyRotation();
      return;
    }
    if (document.hidden) {
      return;
    }
    state.mapTrafficFamiliesByPinId.forEach((families, pinId) => {
      if (families.length < 2) {
        return;
      }
      const nextIndex = ((state.mapTrafficFamilyIndexByPinId.get(pinId) || 0) + 1) % families.length;
      const family = families[nextIndex];
      const image = state.mapTrafficMarkersByPinId.get(pinId)?.getElement()?.querySelector("img[data-traffic-family]");
      if (!image) {
        return;
      }
      image.src = family.mapIcon || family.icon;
      image.dataset.trafficFamily = family.id;
      state.mapTrafficFamilyIndexByPinId.set(pinId, nextIndex);
    });
  }

  function trafficMotionFor(seedText) {
    const seed = stableHash(seedText);
    const departureHeading = seed % 360;
    const radians = ((departureHeading - 90) * Math.PI) / 180;
    const distance = 96 + (seed % 88);
    const vectorX = Math.round(Math.cos(radians) * distance);
    const vectorY = Math.round(Math.sin(radians) * distance);
    const approaching = Boolean(seed % 2);
    return {
      approaching,
      heading: approaching ? (departureHeading + 180) % 360 : departureHeading,
      startX: approaching ? vectorX : -4,
      startY: approaching ? vectorY : -4,
      endX: approaching ? -4 : vectorX,
      endY: approaching ? -4 : vectorY,
      delay: seed % 30000,
      duration: 20000 + (seed % 12000)
    };
  }

  function stableHash(value) {
    return Array.from(String(value)).reduce((hash, character) => {
      return ((hash << 5) - hash + character.charCodeAt(0)) >>> 0;
    }, 2166136261);
  }

  function renderMapResults() {
    const pin = state.pinById.get(state.selectedPinId);
    if (!pin) {
      els.mapResults.innerHTML = `${renderMapSheetBar("Photos", "Photos")}<div class="empty-state">Add enabled pins to start browsing the map.</div>`;
      delete els.mapResults.dataset.pinId;
      return;
    }

    const photos = photosForPin(pin);
    const profile = locationProfile(pin, photos);
    els.mapResults.innerHTML = `
      ${renderMapSheetBar("Photos", "Photos")}
      <h2 class="location-details-title">Location Details</h2>
      ${renderMapLocationPanel(profile)}
    `;
    els.mapResults.dataset.pinId = pin.id;
    activateDeferredMapImages();
  }

  function renderMapSheetBar(title, panelLabel) {
    const expanded = state.mapSheetSnap === "expanded";
    return `
      <div class="map-sheet-bar">
        <button class="map-sheet-handle" type="button" data-sheet-handle="map" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeAttr(panelLabel)} panel" aria-expanded="${expanded}"></button>
        <strong>${escapeHtml(title)}</strong>
        <button class="map-sheet-close" type="button" data-map-panel-close aria-label="Close ${escapeAttr(panelLabel)} panel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
        </button>
      </div>
    `;
  }

  function activateDeferredMapImages() {
    state.mapImageObserver?.disconnect();
    const images = Array.from(els.mapResults.querySelectorAll("img[data-deferred-src]"));
    const loadImage = (image) => {
      if (!image.dataset.deferredSrc) {
        return;
      }
      image.src = image.dataset.deferredSrc;
      delete image.dataset.deferredSrc;
    };
    if (!("IntersectionObserver" in window)) {
      images.forEach(loadImage);
      return;
    }

    state.mapImageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        loadImage(entry.target);
        observer.unobserve(entry.target);
      });
    }, { root: els.mapResults, rootMargin: "160px" });
    images.forEach((image) => state.mapImageObserver.observe(image));
  }

  function locationProfile(pin, photos) {
    const hero = locationHeroForPin(pin, photos);
    const heroPhoto = hero.photo;
    const heroAsset = hero.asset;
    const familiesById = new Map();

    photos.forEach((photo) => {
      const family = aircraftFamilyForPhoto(photo);
      if (family && !familiesById.has(family.id)) {
        familiesById.set(family.id, family);
      }
    });

    const units = locationUnitPreviews(photos);

    return {
      pin,
      photos,
      heroPhoto,
      heroAsset,
      hasCustomHero: hero.custom,
      families: Array.from(familiesById.values()),
      units,
      locationPhotos: photos.filter((photo) => photo.tagScope === "location")
    };
  }

  function locationHeroForPin(pin, photos) {
    const customPhotoId = pin.heroPhotoId || pin.hero_photo_id || "";
    const customPhoto = customPhotoId ? state.photoById.get(String(customPhotoId)) : null;
    if (customPhoto && (customPhoto.image || customPhoto.thumbnail)) {
      return { photo: customPhoto, asset: null, custom: true };
    }

    const customAsset = pin.heroPhoto && typeof pin.heroPhoto === "object" ? pin.heroPhoto : null;
    if (customAsset && (customAsset.image || customAsset.thumbnail)) {
      return { photo: null, asset: customAsset, custom: true };
    }

    return {
      photo: photos.find((photo) => photo.tagScope === "location" && (photo.image || photo.thumbnail))
        || photos.find((photo) => photo.image || photo.thumbnail)
        || null,
      asset: null,
      custom: false
    };
  }

  function renderMapLocationPanel(profile) {
    const { pin, heroPhoto, heroAsset, units, photos } = profile;
    const squadronSection = renderLocationExpandableSection(pin, photos, "squadron");
    const typeSection = renderLocationExpandableSection(pin, photos, "type");
    const locationSection = squadronSection || typeSection
      ? ""
      : renderLocationExpandableSection(pin, photos, "location");
    const heroImage = heroPhoto
      ? heroPhoto.image || heroPhoto.thumbnail
      : heroAsset
        ? heroAsset.image || heroAsset.thumbnail
        : "";
    const heroStyle = heroImage ? "" : " is-empty";

    return `
      <section class="location-detail-page location-map-panel" aria-label="${escapeAttr(pin.name)} location details">
        <div class="location-hero location-map-hero${heroStyle}">
          ${
            heroImage
              ? renderResponsivePhotoImage(heroPhoto || heroAsset, locationHeroAlt(pin, heroPhoto), {
                  eager: true,
                  fullResolution: true,
                  sizes: "(max-width: 1040px) 100vw, 430px"
                })
              : '<span class="empty-cover">No location photo</span>'
          }
          <span class="location-hero-overlay">
            <span class="eyebrow">${escapeHtml(locationKicker(pin))}</span>
            <strong>${escapeHtml(pin.name)}</strong>
            ${renderLocationIdentityMarks([], units, { includeFamilies: false })}
          </span>
        </div>
        <button class="location-page-button" type="button" data-location-page-id="${escapeAttr(pin.id)}">
          <span>Open location page</span>
          <span aria-hidden="true">→</span>
        </button>
        <div class="location-expandable-list">
          ${squadronSection}
          ${typeSection}
          ${locationSection}
        </div>
      </section>
    `;
  }

  function locationKicker(pin) {
    return [pin.icao, pin.country].filter(Boolean).join(" - ") || "Location";
  }

  function renderLocationIdentityMarks(families, units, options = {}) {
    return renderPhotoIdentityMarks(families, units, {
      wrapperClass: "location-identity-marks",
      familyClass: "location-identity-mark is-family",
      unitClass: "location-identity-mark is-unit",
      familyIcon: (family) => family.lightModeIcon || family.darkIcon || family.icon,
      includeFamilies: options.includeFamilies !== false,
      unitLimit: Infinity,
      unitImageAttributes: 'loading="lazy" decoding="async" fetchpriority="low"',
      mixedLabel: "Aircraft families and squadron logos"
    });
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
      group.photos.push(photo);
    });

    return Array.from(groups.values())
      .map((group) => ({ ...group, photos: group.photos.sort(photoSorter) }))
      .sort(groupSorter);
  }

  function locationPhotoGroups(pin, photos, kind) {
    return groupPhotoRecords(photos, (photo) => {
      if (kind === "location") {
        return photo.tagScope === "location"
          ? { key: "location", title: "Location-specific images", eyebrow: "Location tag", logo: "" }
          : null;
      }
      if (kind === "type") {
        if (photo.tagScope !== "aircraft") {
          return null;
        }
        const title = photo.aircraftType || "Unknown aircraft";
        return { key: `type-${normalizeKey(title)}`, title, eyebrow: "Aircraft type", logo: "" };
      }
      if (!photo.squadronName || photo.tagScope === "location") {
        return null;
      }
      const squadron = squadronForPhoto(photo);
      const title = squadron?.name || photo.squadronName;
      const unitType = squadron?.unitType || photo.unitType;
      return {
        key: `unit-${normalizeKey(`${photo.country || pin.country || ""}-${title}-${unitType || ""}`)}`,
        title,
        eyebrow: squadron?.unitLabel || photo.unitLabel || unitDisplayLabel(unitType),
        logo: squadron?.logo || "",
        unitType: normalizeUnitType(unitType),
        squadronId: squadron ? squadronPageIdForUnit(squadron) : squadronPageIdForPhoto(photo)
      };
    }, sortPhotos, (a, b) => {
        const latestDiff = (b.photos[0]?.sortTime || 0) - (a.photos[0]?.sortTime || 0);
        return latestDiff || a.title.localeCompare(b.title);
    });
  }

  function renderLocationExpandableSection(pin, photos, kind) {
    const groups = locationPhotoGroups(pin, photos, kind);
    if (!groups.length) {
      return "";
    }
    const labels = {
      location: "Location frames",
      type: "Aircraft type",
      squadron: locationUnitGroupLabel(groups)
    };
    return `
      <section class="location-expandable-section">
        <div class="compact-heading">
          <h3>${escapeHtml(labels[kind])}</h3>
          <span class="count-pill">${groups.length}</span>
        </div>
        <div class="location-expandable-groups${kind === "type" ? " is-aircraft-types" : ""}">
          ${groups.map((group) => kind === "type"
            ? renderLocationAircraftTypeGroup(pin, group)
            : renderLocationExpandableGroup(pin, group, kind)).join("")}
        </div>
      </section>
    `;
  }

  function locationUnitGroupLabel(groups) {
    const unitTypes = new Set(groups.map((group) => normalizeUnitType(group.unitType)));
    const hasSquadrons = unitTypes.has("squadron");
    const hasOrganisations = unitTypes.has("organisation");
    if (hasSquadrons && hasOrganisations) {
      return "Squadrons and organisations";
    }
    return hasOrganisations ? "Organisations" : "Squadrons";
  }

  function renderLocationAircraftTypeGroup(pin, group) {
    const groupKey = `${pin.id}:type:${group.key}`;
    const isExpanded = state.expandedLocationGroupKeys.has(groupKey);
    const latest = group.photos[0];
    const image = latest?.thumbnail || latest?.image || "";
    const photoCount = `${group.photos.length} photo${group.photos.length === 1 ? "" : "s"}`;
    const singlePhotoId = group.photos.length === 1 && latest?.id ? latest.id : "";

    return `
      <article class="location-type-group${isExpanded && !singlePhotoId ? " is-expanded" : ""}">
        <button
          class="location-type-toggle"
          type="button"
          data-location-group-key="${escapeAttr(groupKey)}"
          ${singlePhotoId
            ? `data-location-single-photo-id="${escapeAttr(singlePhotoId)}" aria-label="Open ${escapeAttr(`${group.title} photo`)}"`
            : `aria-expanded="${isExpanded ? "true" : "false"}" aria-controls="location-group-${escapeAttr(slugify(groupKey))}"`}
        >
          ${isExpanded && !singlePhotoId ? "" : `<span class="location-type-latest">
            ${image ? `<img data-deferred-src="${escapeAttr(image)}" alt="">` : '<span class="location-type-fallback">No photo</span>'}
          </span>`}
          <span class="location-type-copy">
            <strong>${escapeHtml(group.title)}</strong>
            <span class="location-type-meta">
              <span>${escapeHtml(photoCount)}</span>
              <span aria-hidden="true">${singlePhotoId ? "↗" : (isExpanded ? "−" : "+")}</span>
            </span>
          </span>
        </button>
        ${
          isExpanded && !singlePhotoId
            ? `<div class="location-type-archive" id="location-group-${escapeAttr(slugify(groupKey))}">
                <div class="photo-grid location-group-photo-grid">${group.photos.map((photo) => renderPhotoCard(photo, "map")).join("")}</div>
              </div>`
            : ""
        }
      </article>
    `;
  }

  function renderLocationExpandableGroup(pin, group, kind) {
    const groupKey = `${pin.id}:${kind}:${group.key}`;
    const isExpanded = state.expandedLocationGroupKeys.has(groupKey);
    const latest = group.photos[0];
    const image = latest?.thumbnail || latest?.image || "";
    const remaining = group.photos.slice(1);
    const singlePhotoId = group.photos.length === 1 && latest?.id ? latest.id : "";
    const squadronId = kind === "squadron" ? group.squadronId : "";
    const logo = group.logo
      ? `<img class="location-group-logo" data-deferred-src="${escapeAttr(group.logo)}" alt="${escapeAttr(`${group.title} logo`)}">`
      : "";
    return `
      <article class="location-expandable-group${isExpanded ? " is-expanded" : ""}">
        <button
          class="location-group-toggle"
          type="button"
          data-location-group-key="${escapeAttr(groupKey)}"
          ${squadronId
            ? `data-location-squadron-id="${escapeAttr(squadronId)}" aria-label="Open ${escapeAttr(`${group.title} squadron page`)}"`
            : singlePhotoId
            ? `data-location-single-photo-id="${escapeAttr(singlePhotoId)}" aria-label="Open ${escapeAttr(`${group.title} photo`)}"`
            : `aria-expanded="${isExpanded ? "true" : "false"}" aria-controls="location-group-${escapeAttr(slugify(groupKey))}"`}
        >
          <span class="location-group-latest">
            ${image ? `<img data-deferred-src="${escapeAttr(image)}" alt="">` : '<span class="location-group-fallback">No photo</span>'}
          </span>
          <span class="location-group-copy">
            <span class="eyebrow">${escapeHtml(group.eyebrow)}</span>
            <strong>${escapeHtml(group.title)}</strong>
            <span>${escapeHtml(displayPhotoDate(latest))} · ${group.photos.length} photo${group.photos.length === 1 ? "" : "s"}</span>
          </span>
          ${logo}
          <span class="location-group-chevron" aria-hidden="true">${squadronId || singlePhotoId ? "↗" : (isExpanded ? "−" : "+")}</span>
        </button>
        ${
          isExpanded && !squadronId
            ? `<div class="location-group-archive" id="location-group-${escapeAttr(slugify(groupKey))}">
                ${remaining.length
                  ? `<div class="photo-grid location-group-photo-grid">${remaining.map((photo) => renderPhotoCard(photo, "map")).join("")}</div>`
                  : '<p class="muted">This is the only frame in the group.</p>'}
              </div>`
            : ""
        }
      </article>
    `;
  }

  function locationHeroAlt(pin, heroPhoto) {
    if (heroPhoto) {
      return `${photoSubjectLabel(heroPhoto)} at ${pin.name}`;
    }
    return `${pin.name} location hero`;
  }

  function locationUnitPreviews(photos) {
    const byUnit = new Map();
    photos.forEach((photo) => {
      if (!photo.squadronName) {
        return;
      }
      const squadron = squadronForPhoto(photo);
      const name = squadron ? squadron.name : photo.squadronName;
      const unitType = squadron ? squadron.unitType : photo.unitType;
      const unitLabel = squadron ? squadron.unitLabel : photo.unitLabel || unitDisplayLabel(unitType);
      const key = normalizeKey(`${photo.country || ""}-${name || ""}-${unitType || ""}`);
      if (!key) {
        return;
      }

      if (!byUnit.has(key)) {
        byUnit.set(key, {
          name: name || unknownUnitName(unitType),
          unitLabel,
          unitType,
          logo: squadron ? squadron.logo || "" : "",
          squadronId: squadron ? squadronPageIdForUnit(squadron) : squadronPageIdForPhoto(photo),
          count: 0
        });
      }
      byUnit.get(key).count += 1;
    });

    return Array.from(byUnit.values())
      .sort((a, b) => {
        const countDiff = b.count - a.count;
        if (countDiff) {
          return countDiff;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }

  function renderRecentPhotos() {
    if (!els.recentPhotosStrip || !els.recentPhotosCount) {
      return;
    }

    const photos = recentPhotos(state.recentPhotoLimit);
    els.recentPhotosCount.textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"}`;
    els.recentPhotosStrip.style.setProperty("--recent-columns", String(Math.max(1, photos.length)));

    if (!photos.length) {
      els.recentPhotosStrip.innerHTML = '<div class="empty-state compact">Add dated photos to populate recent frames.</div>';
      return;
    }

    els.recentPhotosStrip.innerHTML = photos
      .map((photo, index) => {
        return `
          <button
            class="recent-photo-card"
            type="button"
            data-photo-id="${escapeAttr(photo.id)}"
            data-photo-context="recent"
            style="--dex-delay: ${Math.min(index, 7) * 55}ms"
          >
            ${renderResponsivePhotoImage(photo, `${photoSubjectLabel(photo)} at ${photo.locationName}`, {
              sizes: "(max-width: 520px) 50vw, (max-width: 900px) 33vw, 20vw"
            })}
            <span>
              <strong>${escapeHtml(photoSubjectLabel(photo))}</strong>
              <small>${escapeHtml(photo.locationName)} - ${escapeHtml(displayPhotoDate(photo))}</small>
            </span>
          </button>
        `;
      })
      .join("");

    ensureRecentPhotoSizing();
  }

  function ensureRecentPhotoSizing() {
    if (!els.recentPhotosStrip) {
      return;
    }

    if (!state.recentPhotoResizeObserver && "ResizeObserver" in window) {
      state.recentPhotoResizeObserver = new ResizeObserver(() => updateRecentPhotoLimit());
      state.recentPhotoResizeObserver.observe(els.recentPhotosStrip);
    }
    window.requestAnimationFrame(updateRecentPhotoLimit);
  }

  function updateRecentPhotoLimit() {
    if (!els.recentPhotosStrip || els.recentPhotosStrip.offsetParent === null) {
      return;
    }

    const width = els.recentPhotosStrip.getBoundingClientRect().width;
    if (!width) {
      return;
    }

    const minimumCardWidth = width < 520 ? 155 : width < 820 ? 190 : 230;
    const gap = 8;
    const nextLimit = Math.max(1, Math.min(RECENT_PHOTO_LIMIT, Math.floor((width + gap) / (minimumCardWidth + gap))));
    if (nextLimit === state.recentPhotoLimit) {
      return;
    }

    state.recentPhotoLimit = nextLimit;
    renderRecentPhotos();
  }

  function renderDexHero() {
    if (!els.dexHeroMedia || !els.dexHeroFeature) {
      return;
    }

    const latest = recentPhotos(1)[0] || null;
    const countryCount = unique(state.data.aircraft.flatMap((entry) => entry.countries || [])).length;
    els.dexHeroAircraftCount.textContent = String(state.data.aircraft.length);
    els.dexHeroPhotoCount.textContent = String(state.data.photos.length);
    els.dexHeroCountryCount.textContent = String(countryCount);

    if (!latest) {
      els.dexHeroMedia.innerHTML = '<span class="dex-hero-media-fallback"></span>';
      els.dexHeroFeature.innerHTML = '<p>No dated frames yet</p>';
      els.dexHeroAction.hidden = true;
      return;
    }

    els.dexHeroMedia.innerHTML = renderResponsivePhotoImage(latest, "", {
      sizes: "100vw",
      eager: true,
      fullResolution: true
    });
    els.dexHeroFeature.innerHTML = `
      <span>Newest in the archive</span>
      <strong>${escapeHtml(photoSubjectLabel(latest))}</strong>
      <small>${escapeHtml(latest.locationName)} · ${escapeHtml(displayPhotoDate(latest))}</small>
    `;
    els.dexHeroAction.hidden = false;
    els.dexHeroAction.dataset.photoId = latest.id;
    els.dexHeroAction.dataset.photoContext = "recent";
    els.dexHeroAction.innerHTML = 'View latest frame <span aria-hidden="true">↗</span>';
    els.dexHeroAction.setAttribute("aria-label", `Open latest frame: ${photoSubjectLabel(latest)} at ${latest.locationName}`);
  }

  function renderStatsDashboard() {
    if (!els.statsDashboard) {
      return;
    }

    const collectionStats = collectionStatsSummary();
    const countryCounts = countBy(state.data.photos, (photo) => photo.country || "Country not set");
    els.statsDashboard.innerHTML = `
      <div class="stats-summary-grid">
        ${statsDashboardPair(
          "Photos",
          collectionStats.photoCount,
          "Photographed locations",
          collectionStats.photographedLocationCount,
          `${collectionStats.photoCount} photo${collectionStats.photoCount === 1 ? "" : "s"} across ${collectionStats.photographedLocationCount} location${collectionStats.photographedLocationCount === 1 ? "" : "s"}`
        )}
        ${statsDashboardPair(
          "Aircraft types",
          collectionStats.aircraftTypeCount,
          "Squadrons",
          collectionStats.squadronCount,
          `${collectionStats.aircraftTypeCount} type${collectionStats.aircraftTypeCount === 1 ? "" : "s"} across ${collectionStats.squadronCount} squadron${collectionStats.squadronCount === 1 ? "" : "s"}`
        )}
        ${statsDashboardPair(
          "Locations",
          collectionStats.locationCount,
          "Countries",
          collectionStats.countryCount,
          `${collectionStats.locationCount} enabled map location${collectionStats.locationCount === 1 ? "" : "s"} across ${collectionStats.countryCount} countr${collectionStats.countryCount === 1 ? "y" : "ies"}`
        )}
      </div>
      <div class="stats-visual-grid">
        ${renderAircraftFamilyCoverage()}
        ${renderCountryDistribution(countryCounts)}
      </div>
    `;
  }

  function renderStatsArchiveHero() {
    if (!els.statsHeroMedia) {
      return;
    }

    const collectionStats = collectionStatsSummary();
    const sortedPhotos = recentPhotos(state.data.photos.length)
      .filter((photo) => photo.image || photo.thumbnail);
    const heroPhoto = sortedPhotos[2] || sortedPhotos[0] || null;

    els.statsHeroPhotoCount.textContent = String(collectionStats.photoCount);
    els.statsHeroAircraftCount.textContent = String(collectionStats.aircraftTypeCount);
    els.statsHeroLocationCount.textContent = String(collectionStats.locationCount);
    els.statsHeroMedia.innerHTML = heroPhoto
      ? renderResponsivePhotoImage(heroPhoto, "", { sizes: "100vw", eager: true, fullResolution: true })
      : '<span class="stats-archive-media-fallback"></span>';
  }

  function statsDashboardPair(primaryLabel, primaryValue, secondaryLabel, secondaryValue, detail) {
    return `
      <article class="stats-pair-card">
        <div>
          <strong>${escapeHtml(primaryValue)}</strong>
          <span>${escapeHtml(primaryLabel)}</span>
        </div>
        <div>
          <strong>${escapeHtml(secondaryValue)}</strong>
          <span>${escapeHtml(secondaryLabel)}</span>
        </div>
        <p>${escapeHtml(detail)}</p>
      </article>
    `;
  }

  function renderAircraftFamilyCoverage() {
    const families = AIRCRAFT_FAMILY_DEFINITIONS.map((family) => ({
      ...family,
      count: state.data.aircraft.filter((entry) => aircraftFamilyIdForEntry(entry) === family.id).length
    }));
    const total = families.reduce((sum, family) => sum + family.count, 0);

    return `
      <section class="stats-visual-card aircraft-family-coverage-card">
        <div class="stats-visual-heading">
          <div>
            <p class="eyebrow">Aircraft coverage</p>
            <h2>Types by family</h2>
          </div>
          <span>Open a family</span>
        </div>
        <p class="aircraft-family-coverage-summary">${total} aircraft type${total === 1 ? "" : "s"} classified across five families.</p>
        <div class="aircraft-family-distribution" aria-label="Aircraft types by family">
          ${families
            .map((family) => {
              const asset = aircraftFamilyAsset(family.id, family.label);
              const typeLabel = `aircraft type${family.count === 1 ? "" : "s"}`;
              return `
                <button
                  class="aircraft-family-segment is-${escapeAttr(family.id)}"
                  type="button"
                  data-dex-family-id="${escapeAttr(family.id)}"
                  aria-label="Open the Aircraft Dex filtered to ${family.count} ${escapeAttr(family.label.toLowerCase())} ${typeLabel}"
                >
                  <span class="aircraft-family-segment-icon"><img src="${escapeAttr(asset.icon)}" alt="" aria-hidden="true"></span>
                  <span class="aircraft-family-segment-body">
                    <span class="aircraft-family-segment-label">${escapeHtml(family.label)}</span>
                    <strong>${family.count}</strong>
                    <small>${typeLabel}</small>
                  </span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function renderCountryDistribution(counts) {
    const items = topCounts(counts, 6);
    const max = Math.max(1, ...items.map((item) => item.count));
    return `
      <section class="stats-visual-card">
        <div class="stats-visual-heading">
          <div>
            <p class="eyebrow">World coverage</p>
            <h2>Frames by country</h2>
          </div>
          <span>Open a country</span>
        </div>
        ${
          items.length
            ? `<div class="stats-country-list">
                ${items
                  .map(
                    (item) => `
                      <button
                        class="stats-country-row"
                        type="button"
                        data-stats-filter-kind="country"
                        data-stats-filter-value="${escapeAttr(item.label)}"
                        data-stats-filter-label="${escapeAttr(`${item.label} frames`)}"
                        aria-label="Open ${item.count} photo${item.count === 1 ? "" : "s"} from ${escapeAttr(item.label)}"
                      >
                        <span>${escapeHtml(item.label)}</span>
                        <span class="stats-country-track" aria-hidden="true"><span style="width: ${Math.max(10, Math.round((item.count / max) * 100))}%"></span></span>
                        <strong>${item.count}</strong>
                      </button>
                    `
                  )
                  .join("")}
              </div>`
            : '<p class="muted">Add photos with country metadata to see world coverage.</p>'
        }
      </section>
    `;
  }

  function renderExifDashboard() {
    if (!els.exifDashboard) {
      return;
    }

    const totalPhotos = state.data.photos.length;
    const exifPhotos = state.data.photos.filter(hasCameraExif);
    const cameraCounts = countBy(exifPhotos, (photo) => {
      const exif = photo.exif || {};
      return [exif.Make, exif.Model].filter(Boolean).join(" ");
    });
    const lensCounts = countByValues(exifPhotos, statsLensLabels);
    const focalCounts = countBy(exifPhotos, (photo) => statsFocalLength(photo, state.statsFocalMode));
    const shutterCounts = countBy(exifPhotos, (photo) => (photo.exif || {}).ExposureTime);
    const apertureCounts = countBy(exifPhotos, (photo) => (photo.exif || {}).FNumber);
    const isoCounts = countBy(exifPhotos, (photo) => (photo.exif || {}).ISO);
    const topFocal = topCounts(focalCounts, 1)[0];

    if (!totalPhotos) {
      els.exifDashboard.innerHTML = '<div class="empty-state compact">Add photos to populate EXIF stats.</div>';
      return;
    }

    els.exifDashboard.innerHTML = `
      <div class="browser-heading">
        <div>
          <p class="eyebrow">Photography stats</p>
          <h2 class="heading-with-icon">${statsIcon("aperture")}<span>EXIF Dashboard</span></h2>
        </div>
        <p class="muted">${exifPhotos.length} of ${totalPhotos} photo${totalPhotos === 1 ? "" : "s"} with camera data</p>
      </div>

      <div class="exif-summary-grid" aria-label="EXIF summary">
        ${exifSummaryTile("Coverage", `${Math.round((exifPhotos.length / totalPhotos) * 100)}%`, `${exifPhotos.length}/${totalPhotos} photos`)}
        ${exifSummaryTile("Cameras", cameraCounts.size || "0", "Unique bodies")}
        ${exifSummaryTile("Lenses", lensCounts.size || "0", "Unique lenses")}
        ${exifSummaryTile("Top focal", topFocal ? topFocal.label : "None", topFocal ? `${topFocal.count} frame${topFocal.count === 1 ? "" : "s"} · ${focalLengthModeLabel(state.statsFocalMode)}` : "No EXIF", "top-focal")}
      </div>

      <div class="exif-dashboard-grid">
        ${renderExifCountList("Camera bodies", cameraCounts, "camera")}
        ${renderExifCountList("Lenses", lensCounts, "lens")}
        ${renderFocalLengthDistribution(exifPhotos)}
        ${renderExifCountList("Shutter speeds", shutterCounts, "shutter", 8)}
        ${renderExifCountList("Apertures", apertureCounts, "aperture")}
        ${renderExifCountList("ISO", isoCounts, "iso")}
      </div>

      ${renderAtLimitsGallery(exifPhotos)}
    `;
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
      els.squadronLogoGrid.innerHTML = '<div class="empty-state compact">No squadrons match these mobile filters.</div>';
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
  }

  function squadronArchiveEntries() {
    const squadrons = collectSquadrons();
    const isMobile = isFocusedMobileLayout();
    const query = normalizeText(state.squadronQuery);
    const filteredSquadrons = isMobile
      ? squadrons.filter((squadron) => {
          if (state.squadronCountryFilter && squadron.country !== state.squadronCountryFilter) {
            return false;
          }
          return !query || normalizeText(`${squadron.name} ${squadron.country} ${squadron.aircraftTypes.join(" ")}`).includes(query);
        })
      : squadrons;
    const orderedSquadrons = isMobile
      ? groupSquadronsByCountry(filteredSquadrons).flatMap((group) => group.squadrons)
      : filteredSquadrons;
    return { squadrons, filteredSquadrons, orderedSquadrons, isMobile };
  }

  function renderSquadronArchiveHero(squadrons) {
    if (!els.squadronHeroMedia) {
      return;
    }

    const rankedSquadronPhotos = state.data.photos
      .filter((photo) => photo.squadronName && normalizeUnitType(photo.unitType) === "squadron" && (photo.image || photo.thumbnail))
      .sort(sortPhotos);
    const latest = rankedSquadronPhotos[1]
      || rankedSquadronPhotos[0]
      || squadrons.map(squadronCardHero).find(Boolean)
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

  function renderAirshowsPage() {
    if (!els.airshowTimeline || !els.airshowPageCount) {
      return;
    }

    const airshows = state.data.airshows || [];
    if (state.selectedAirshowId && !airshows.some((airshow) => airshow.id === state.selectedAirshowId)) {
      state.selectedAirshowId = null;
    }
    renderAirshowArchiveHero(airshows);

    if (!airshows.length) {
      els.airshowTimeline.innerHTML = '<div class="empty-state">Tag photos with an airshow or event name to build this timeline.</div>';
      renderArchivePagination(els.airshowPagination, 0, 0, "airshows", "airshow events");
      return;
    }

    const visibleAirshows = isFocusedMobileLayout()
      ? airshows.slice(0, state.airshowVisibleCount)
      : airshows;
    els.airshowTimeline.innerHTML = visibleAirshows.map(renderAirshowTimelineItem).join("");
    renderArchivePagination(
      els.airshowPagination,
      visibleAirshows.length,
      airshows.length,
      "airshows",
      "airshow events"
    );
  }

  function renderAirshowArchiveHero(airshows) {
    if (!els.airshowHeroMedia) {
      return;
    }

    const eventPhotoSets = airshows.map((airshow) => ({ airshow, photos: photosForAirshow(airshow) }));
    const eventHeroIds = new Set(
      eventPhotoSets
        .map(({ airshow, photos: eventPhotos }) => airshowHeroPhoto(airshow, eventPhotos)?.id)
        .filter(Boolean)
    );
    const photos = unique(airshows.flatMap((airshow) => airshow.photoIds || []))
      .map((photoId) => state.photoById.get(photoId))
      .filter(Boolean);
    const hero = photos
      .filter((photo) => !eventHeroIds.has(photo.id) && (photo.image || photo.thumbnail))
      .sort(sortPhotos)[0]
      || eventPhotoSets.map(({ airshow, photos: eventPhotos }) => airshowHeroPhoto(airshow, eventPhotos)).find(Boolean)
      || null;
    const locationCount = unique(photos.map((photo) => photo.pinId || photo.locationName)).length;
    const years = airshows
      .flatMap((airshow) => [airshow.firstDate, airshow.latestDate])
      .map((date) => Number(String(date || "").slice(0, 4)))
      .filter((year) => Number.isFinite(year) && year > 0)
      .sort((a, b) => a - b);
    const yearRange = years.length
      ? years[0] === years[years.length - 1]
        ? String(years[0])
        : `${years[0]} - ${years[years.length - 1]}`
      : "Archive dates unavailable";

    els.airshowPageCount.textContent = String(airshows.length);
    els.airshowPageCount.setAttribute("aria-label", `${airshows.length} airshow events`);
    els.airshowHeroPhotoCount.textContent = String(photos.length);
    els.airshowHeroLocationCount.textContent = String(locationCount);
    els.airshowYearRange.textContent = `${yearRange} · Newest first`;
    els.airshowHeroMedia.innerHTML = hero
      ? renderResponsivePhotoImage(hero, "", { sizes: "100vw", eager: true, fullResolution: true })
      : '<span class="airshow-archive-media-fallback"></span>';
  }

  function renderAirshowTimelineItem(airshow, index = 0) {
    const photos = photosForAirshow(airshow);
    const hero = airshowHeroPhoto(airshow, photos);
    const date = airshow.latestDate || airshow.firstDate || "";
    const cover = hero ? hero.image || hero.thumbnail || "" : "";
    const latestLabel = date ? formatDisplayDate(date) : "Date unknown";
    const identityMarks = renderAirshowIdentityMarks(photos);

    return `
      <article class="airshow-timeline-item" id="airshow-${escapeAttr(airshow.id)}">
        <div class="airshow-timeline-marker" aria-hidden="true">
          <span></span>
          <time datetime="${escapeAttr(date)}">${escapeHtml(latestLabel)}</time>
        </div>
        <button
          class="airshow-timeline-card"
          type="button"
          data-airshow-id="${escapeAttr(airshow.id)}"
          aria-label="${escapeAttr(`Open ${airshow.name}: ${photos.length} photo${photos.length === 1 ? "" : "s"}.`)}"
          style="--airshow-delay: ${Math.min(index, 8) * 55}ms"
        >
          ${cover ? renderResponsivePhotoImage(hero, `${airshow.name} hero photo`, {
            sizes: "(max-width: 760px) 100vw, 50vw",
            fullResolution: true
          }) : '<span class="airshow-timeline-placeholder">No event photo</span>'}
          <span class="airshow-timeline-scrim" aria-hidden="true"></span>
          <span class="airshow-card-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
          <span class="airshow-timeline-content">
            <span class="eyebrow">${escapeHtml(latestLabel)}</span>
            <strong>${escapeHtml(airshow.name)}</strong>
            <span class="airshow-timeline-meta">
              <span>${photos.length} photo${photos.length === 1 ? "" : "s"}</span>
              ${identityMarks}
            </span>
          </span>
        </button>
      </article>
    `;
  }

  function renderAirshowDetail() {
    if (!els.airshowDetail) {
      return;
    }

    const airshow = state.airshowById.get(state.selectedAirshowId);
    if (!airshow) {
      els.airshowDetail.innerHTML = '<div class="empty-state">Choose an event from the Airshows archive to open its field report.</div>';
      return;
    }

    const photos = photosForAirshow(airshow);
    const hero = airshowHeroPhoto(airshow, photos) || photos[0] || null;
    const heroImage = hero ? hero.image || hero.thumbnail || "" : "";
    const dateStart = airshow.firstDate || airshow.latestDate || "";
    const dateEnd = airshow.latestDate || airshow.firstDate || "";
    const dateLabel = dateStart && dateEnd && dateStart !== dateEnd
      ? `${formatDisplayDate(dateStart)} - ${formatDisplayDate(dateEnd)}`
      : dateStart
        ? formatDisplayDate(dateStart)
        : "Date unknown";
    const locations = unique(photos.map((photo) => photo.locationName));
    const units = unique(photos.map((photo) => photo.squadronName));
    const countries = unique(photos.map((photo) => photo.country));
    const groups = airshowPhotoGroups(photos);

    els.airshowDetail.innerHTML = `
      ${renderDetailHero({
        backView: "airshowsView",
        backLabel: "Airshows",
        eyebrow: "Event field report",
        title: airshow.name,
        description: `${dateLabel} · ${photos.length} photographed frame${photos.length === 1 ? "" : "s"}`,
        image: heroImage,
        alt: `${airshow.name} hero photo`,
        actions: renderFieldGuideActions("Airshow field report"),
        className: "airshow-field-guide-hero"
      })}
      ${renderPageWriteUp(airshow.writeUp, "About this airshow")}

      <div class="entry-stat-grid" aria-label="Airshow statistics">
        ${statTile("Photos", photos.length)}
        ${statTile("Locations", locations.length)}
        ${statTile("Units", units.length)}
        ${statTile("Countries", countries.length)}
      </div>

      <section class="detail-photo-section airshow-detail-archive">
        <div class="detail-section-heading">
          <div>
            <p class="eyebrow">Complete event archive</p>
            <h2>All frames</h2>
          </div>
          <span class="count-pill">${photos.length}</span>
        </div>
        ${groups.length ? renderAirshowPhotoGroups(groups) : '<div class="empty-state">No event photos found.</div>'}
      </section>
    `;
  }

  function photosForAirshow(airshow) {
    return (airshow.photoIds || []).map((photoId) => state.photoById.get(photoId)).filter(Boolean).sort(sortPhotos);
  }

  function airshowHeroPhoto(airshow, photos) {
    return state.photoById.get(airshow.heroPhotoId) || photos[0] || null;
  }

  function airshowPhotoGroups(photos) {
    return groupPhotoRecords(photos, (photo) => {
      if (photo.tagScope === "location" || !photo.squadronName) {
        return {
          key: `location-${photo.pinId || normalizeKey(photo.locationName || "untagged")}`,
          title: "Location-tagged frames",
          eyebrow: "Location tag",
          logo: ""
        };
      }

      const squadron = squadronForPhoto(photo);
      const name = squadron?.name || photo.squadronName;
      const unitType = squadron?.unitType || photo.unitType;
      const country = squadron?.country || photo.country || "";
      return {
        key: `unit-${normalizeKey(`${country}-${name}-${unitType || ""}`)}`,
        title: name,
        eyebrow: squadron?.unitLabel || photo.unitLabel || unitDisplayLabel(unitType),
        logo: squadron?.logo || ""
      };
    }, sortPhotosOldest, (a, b) => {
        const dateDiff = (a.photos[0]?.sortTime || 0) - (b.photos[0]?.sortTime || 0);
        return dateDiff || a.title.localeCompare(b.title);
    });
  }

  function renderAirshowPhotoGroups(groups) {
    return `
      <div class="airshow-squadron-groups">
        ${groups.map((group, index) => {
          const logo = group.logo
            ? `<span class="airshow-squadron-logo"><img src="${escapeAttr(group.logo)}" alt="${escapeAttr(`${group.title} logo`)}"></span>`
            : "";
          return `
            <section class="airshow-squadron-group">
              <div class="airshow-squadron-heading${logo ? " has-logo" : ""}">
                ${logo}
                <div>
                  <p class="eyebrow">${escapeHtml(group.eyebrow)}</p>
                  <h3>${escapeHtml(group.title)}</h3>
                </div>
                <span class="count-pill">${group.photos.length}</span>
                </div>
              ${renderProgressivePhotoGrid(group.photos, "airshow", `airshow-${index}-${group.key}`, "airshow-photo-grid")}
            </section>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderAirshowIdentityMarks(photos) {
    const { families, units } = collectPhotoIdentities(photos);
    return renderPhotoIdentityMarks(families, units, {
      wrapperClass: "airshow-identity-marks",
      familyClass: "airshow-identity-mark is-family",
      unitClass: "airshow-identity-mark is-squadron",
      familyIcon: (family) => family.darkIcon || family.mapIcon || family.icon,
      familyLimit: 3,
      unitLimit: 6
    });
  }

  function sortPhotosOldest(a, b) {
    const timeDiff = (a.sortTime || 0) - (b.sortTime || 0);
    if (timeDiff) {
      return timeDiff;
    }
    return `${photoSubjectLabel(a)} ${a.locationName}`.localeCompare(`${photoSubjectLabel(b)} ${b.locationName}`);
  }

  function renderSquadronCountryRail(squadrons) {
    if (!els.squadronCountryRail) {
      return;
    }
    const groups = groupSquadronsByCountry(squadrons);
    els.squadronCountryRail.innerHTML = groups.length
      ? `
          <button class="squadron-country-filter-all${state.squadronCountryFilter ? "" : " is-active"}" type="button" data-squadron-country-jump="squadronsView" data-squadron-country-filter="" aria-pressed="${state.squadronCountryFilter ? "false" : "true"}">
            <span class="squadron-country-nav-label">All</span>
            <span class="squadron-country-count">${squadrons.length}</span>
          </button>
          ${groups
          .map(
            (group) => `
              <button class="${state.squadronCountryFilter === group.country ? "is-active" : ""}" type="button" data-squadron-country-jump="${escapeAttr(squadronCountryId(group.country))}" data-squadron-country-filter="${escapeAttr(group.country)}" aria-pressed="${state.squadronCountryFilter === group.country ? "true" : "false"}">
                ${renderCountryLabel(group.country, "squadron-country-nav-label")}
                <span class="squadron-country-count">${group.squadrons.length}</span>
              </button>
            `
          )
          .join("")}
        `
      : '<span class="muted">No countries</span>';
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
        style="--squadron-delay: ${Math.min(index, 10) * 44}ms"
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
        description: `${photos.length} viewable photo${photos.length === 1 ? "" : "s"}${squadron.aircraftTypes.length ? ` across ${squadron.aircraftTypes.length} aircraft type${squadron.aircraftTypes.length === 1 ? "" : "s"}` : ""}`,
        image: heroImage,
        alt: `${squadron.name} hero photo`,
        mark: logo,
        className: "squadron-field-guide-hero"
      })}
      ${renderPageWriteUp(squadron.writeUp, "About this squadron")}
      <section class="detail-summary">
        <div>
          <p class="eyebrow">Aircraft types</p>
          <p class="detail-summary-copy">${escapeHtml(typePreview || "No aircraft types tagged yet.")}</p>
        </div>
      </section>
      ${
        squadronLevelPhotos.length
          ? `<section class="detail-photo-section">
              <div class="detail-section-heading">
                <div>
                  <p class="eyebrow">Unit archive</p>
                  <h2>Squadron-level frames</h2>
                  <p class="muted">Photos tagged directly to ${escapeHtml(squadron.name)}.</p>
                </div>
                <span class="count-pill">${squadronLevelPhotos.length}</span>
              </div>
              ${renderDetailPhotoGrid(squadronLevelPhotos, "squadron", "squadron-level")}
            </section>`
          : ""
      }
      <section class="detail-photo-section">
        <div class="detail-section-heading">
          <div>
            <p class="eyebrow">Aircraft archive</p>
            <h2>All images</h2>
          </div>
          <span class="count-pill">${otherPhotos.length}</span>
        </div>
        ${renderDetailPhotoGrid(otherPhotos, "squadron", "squadron-aircraft")}
      </section>
    `;
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
    const typeCount = locationPhotoGroups(pin, photos, "type").length;
    const unitCount = locationPhotoGroups(pin, photos, "squadron").length;

    els.locationDetail.innerHTML = `
      ${renderDetailHero({
        backView: "mapView",
        backLabel: "World Map",
        eyebrow: locationKicker(pin),
        title: pin.name,
        description: `${photos.length} photo${photos.length === 1 ? "" : "s"} at this location`,
        image: heroImage,
        alt: `${pin.name} hero photo`,
        actions: renderFieldGuideActions("Location field guide"),
        className: "location-field-guide-hero"
      })}
      ${renderPageWriteUp(pin.writeUp, "About this location")}
      <section class="detail-summary location-page-summary">
        <div>
          <p class="eyebrow">Location profile</p>
          <p class="detail-summary-copy">${escapeHtml([pin.country, pin.icao].filter(Boolean).join(" · ") || "Location archive")}</p>
        </div>
        ${renderLocationIdentityMarks(profile.families, profile.units)}
      </section>
      <div class="entry-stat-grid" aria-label="Location statistics">
        ${statTile("Photos", photos.length)}
        ${statTile("Location tags", locationPhotos.length)}
        ${statTile("Aircraft types", typeCount)}
        ${statTile("Units", unitCount)}
      </div>
      ${
        locationPhotos.length
          ? `<section class="detail-photo-section">
              <div class="detail-section-heading">
                <div>
                  <p class="eyebrow">Location archive</p>
                  <h2>Location-specific images</h2>
                  <p class="muted">Photos tagged directly to ${escapeHtml(pin.name)}.</p>
                </div>
                <span class="count-pill">${locationPhotos.length}</span>
              </div>
              ${renderDetailPhotoGrid(locationPhotos, "location", "location-tagged")}
            </section>`
          : ""
      }
      <section class="detail-photo-section">
        <div class="detail-section-heading">
          <div>
            <p class="eyebrow">Aircraft and unit archive</p>
            <h2>All other images</h2>
            <p class="muted">Aircraft- and squadron-tagged photos, newest first.</p>
          </div>
          <span class="count-pill">${otherPhotos.length}</span>
        </div>
        ${renderDetailPhotoGrid(otherPhotos, "location", "location-aircraft")}
      </section>
    `;
  }

  function renderFieldGuideActions(label) {
    return `
      <div class="detail-hero-actions" aria-label="${escapeAttr(label)} actions">
        <button class="detail-hero-action" type="button" data-copy-field-guide="Copy link">Copy link</button>
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

  function renderDetailHero({ backView, backLabel, eyebrow, title, description, image, alt, mark = "", actions = "", className = "" }) {
    return `
      <section class="detail-hero${image ? " has-image" : ""}${className ? ` ${escapeAttr(className)}` : ""}">
        ${image ? `<img src="${escapeAttr(image)}" alt="${escapeAttr(alt)}">` : ""}
        <div class="detail-hero-scrim" aria-hidden="true"></div>
        <button class="detail-back-button" type="button" data-detail-back="${escapeAttr(backView)}">← ${escapeHtml(backLabel)}</button>
        ${actions}
        <div class="detail-hero-content">
          <p class="eyebrow">${escapeHtml(eyebrow)}</p>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(description)}</p>
        </div>
        ${mark ? `<span class="detail-hero-mark" aria-hidden="true">${mark}</span>` : ""}
      </section>
    `;
  }

  function renderDetailPhotoGrid(photos, context, galleryKey) {
    if (!photos.length) {
      return '<div class="empty-state">No photos found for this section yet.</div>';
    }

    return renderProgressivePhotoGrid(photos, context, galleryKey, "detail-photo-grid");
  }

  function renderProgressivePhotoGrid(photos, context, galleryKey, className = "") {
    const key = normalizeKey(galleryKey) || `gallery-${normalizeKey(photos[0]?.id || "photos")}`;
    const galleryId = `detail-gallery-${key}`;
    const gridId = `${galleryId}-grid`;
    const mobile = isFocusedMobileLayout();
    const visiblePhotos = mobile ? photos.slice(0, MOBILE_DETAIL_PAGE_SIZE) : photos;
    state.detailGalleries.set(key, { photos, context });
    const hasMore = visiblePhotos.length < photos.length;
    const remaining = photos.length - visiblePhotos.length;

    return `
      <div class="detail-gallery" id="${escapeAttr(galleryId)}" data-detail-gallery-visible="${visiblePhotos.length}" data-detail-gallery-total="${photos.length}">
        <div class="photo-grid ${escapeAttr(className)}" id="${escapeAttr(gridId)}">
          ${visiblePhotos.map((photo) => renderPhotoCard(photo, context)).join("")}
        </div>
        ${hasMore
          ? `<button class="detail-gallery-load-more" type="button" data-detail-load-more="${escapeAttr(key)}" aria-controls="${escapeAttr(galleryId)}-grid">Show ${remaining} more photo${remaining === 1 ? "" : "s"}</button>`
          : ""}
      </div>
    `;
  }

  function appendDetailGalleryPage(button) {
    if (!isFocusedMobileLayout()) {
      return;
    }
    const key = button.dataset.detailLoadMore || "";
    const galleryRecord = state.detailGalleries.get(key);
    const gallery = document.getElementById(`detail-gallery-${key}`);
    const grid = gallery?.querySelector(".photo-grid");
    if (!galleryRecord || !gallery || !grid) {
      return;
    }

    const visibleCount = Number(gallery.dataset.detailGalleryVisible) || 0;
    const nextCount = Math.min(visibleCount + MOBILE_DETAIL_PAGE_SIZE, galleryRecord.photos.length);
    grid.insertAdjacentHTML(
      "beforeend",
      galleryRecord.photos
        .slice(visibleCount, nextCount)
        .map((photo) => renderPhotoCard(photo, galleryRecord.context))
        .join("")
    );
    gallery.dataset.detailGalleryVisible = String(nextCount);
    const remaining = galleryRecord.photos.length - nextCount;
    if (!remaining) {
      button.remove();
    } else {
      button.textContent = `Show ${remaining} more photo${remaining === 1 ? "" : "s"}`;
    }
  }

  function updateStatsFocalMode(mode) {
    if (!els.exifDashboard) {
      return;
    }
    if (state.statsFocalMode === mode) {
      els.exifDashboard.querySelector(`[data-stats-focal-mode="${mode}"]`)?.focus();
      return;
    }

    state.statsFocalMode = mode;
    const exifPhotos = state.data.photos.filter(hasCameraExif);
    const focalCounts = countBy(exifPhotos, (photo) => statsFocalLength(photo, mode));
    const topFocal = topCounts(focalCounts, 1)[0];
    const topFocalTile = els.exifDashboard.querySelector('[data-exif-summary-key="top-focal"]');
    if (topFocalTile) {
      topFocalTile.innerHTML = exifSummaryTileContent(
        "Top focal",
        topFocal ? topFocal.label : "None",
        topFocal ? `${frameCountLabel(topFocal.count)} · ${focalLengthModeLabel(mode)}` : "No EXIF"
      );
    }

    const distribution = els.exifDashboard.querySelector(".focal-distribution-card");
    if (distribution) {
      distribution.outerHTML = renderFocalLengthDistribution(exifPhotos);
    }

    const longestReachCard = els.exifDashboard.querySelector('[data-stats-limit-kind="longest-reach"]');
    const longestReach = statsLongestReachRecord(exifPhotos);
    if (longestReachCard && longestReach) {
      longestReachCard.outerHTML = renderStatsLimitCard(longestReach);
    }

    window.requestAnimationFrame(() => {
      els.exifDashboard?.querySelector(`[data-stats-focal-mode="${mode}"]`)?.focus();
    });
  }

  function exifSummaryTile(label, value, detail, key = "") {
    const keyAttribute = key ? ` data-exif-summary-key="${escapeAttr(key)}"` : "";
    return `
      <div${keyAttribute}>${exifSummaryTileContent(label, value, detail)}</div>
    `;
  }

  function exifSummaryTileContent(label, value, detail) {
    return `
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
      <small>${escapeHtml(detail)}</small>
    `;
  }

  function renderExifCountList(title, counts, filterKind, limit = 5) {
    const icon = statsIcon(exifIconForTitle(title));
    const items = topCounts(counts, limit);
    if (!items.length) {
      return `
        <section class="exif-stat-card">
          <h3 class="heading-with-icon">${icon}<span>${escapeHtml(title)}</span></h3>
          <p class="muted">No data found.</p>
        </section>
      `;
    }

    const max = Math.max(...items.map((item) => item.count));
    return `
      <section class="exif-stat-card">
        <h3 class="heading-with-icon">${icon}<span>${escapeHtml(title)}</span></h3>
        <div class="exif-bar-list">
          ${items
            .map((item) => {
              const width = Math.max(8, Math.round((item.count / max) * 100));
              return `
                <button
                  class="exif-bar-row"
                  type="button"
                  data-stats-filter-kind="${escapeAttr(filterKind)}"
                  data-stats-filter-value="${escapeAttr(item.label)}"
                  data-stats-filter-label="${escapeAttr(`${title}: ${item.label}`)}"
                  aria-label="Open ${item.count} photo${item.count === 1 ? "" : "s"} matching ${escapeAttr(item.label)}"
                >
                  <span class="exif-bar-label">${escapeHtml(item.label)}</span>
                  <span class="exif-bar-track" aria-hidden="true"><span style="width: ${width}%"></span></span>
                  <span class="exif-bar-count">${item.count}</span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function renderFocalLengthDistribution(photos) {
    const focalPhotos = photos
      .map((photo) => ({ photo, focalLength: statsFocalLengthValue(photo, state.statsFocalMode) }))
      .filter((item) => item.focalLength !== null);

    if (!focalPhotos.length) {
      return `
        <section class="exif-stat-card focal-distribution-card">
          <h3 class="heading-with-icon">${statsIcon("focal")}<span>Focal-length distribution</span></h3>
          <p class="muted">No focal-length data found.</p>
        </section>
      `;
    }

    const focalLengths = focalPhotos.map((item) => item.focalLength);
    const bins = focalLengthBins(focalLengths);
    const peak = Math.max(1, ...bins.map((bin) => bin.count));
    const minimum = Math.min(...focalLengths);
    const maximum = Math.max(...focalLengths);
    const teleconverterIncluded = focalPhotos.some(({ photo }) => /teleconverter/i.test((photo.exif || {}).LensModel || (photo.exif || {}).Lens || ""));
    const modeLabel = focalLengthModeLabel(state.statsFocalMode);

    return `
      <section class="exif-stat-card focal-distribution-card">
        <div class="focal-distribution-heading">
          <h3 class="heading-with-icon">${statsIcon("focal")}<span>Focal-length distribution</span></h3>
          ${renderFocalLengthModeControl()}
        </div>
        <p class="focal-distribution-summary">
          ${escapeHtml(`${modeLabel} · full range ${formatFocalLength(minimum)}-${formatFocalLength(maximum)}`)}${teleconverterIncluded ? " · includes teleconverter captures" : ""}
        </p>
        <div class="focal-distribution-chart" style="grid-template-columns: repeat(${bins.length}, minmax(24px, 1fr))" aria-label="${escapeAttr(`${modeLabel} focal-length distribution from ${formatFocalLength(minimum)} to ${formatFocalLength(maximum)} in ${FOCAL_DISTRIBUTION_BIN_WIDTH}mm bins`)}">
          ${bins
            .map((bin) => {
              const height = bin.count ? Math.max(8, Math.round((bin.count / peak) * 100)) : 0;
              const rangeLabel = bin.rangeLabel || formatFocalRange(bin.start, bin.end);
              return `
                <button
                  class="focal-distribution-column"
                  type="button"
                  data-stats-filter-kind="focal-range"
                  data-stats-filter-value="${bin.start}:${bin.end}:${bin.includesEnd ? "inclusive" : "exclusive"}"
                  data-stats-filter-label="Focal lengths: ${escapeAttr(rangeLabel)}"
                  aria-label="Open ${bin.count} photo${bin.count === 1 ? "" : "s"} captured from ${escapeAttr(rangeLabel)}"
                >
                  <span class="focal-distribution-plot" aria-hidden="true"><span class="focal-distribution-bar" style="height: ${height}%"></span></span>
                  <span class="focal-distribution-count">${bin.count}</span>
                  <span class="focal-distribution-label">${escapeHtml(bin.tickLabel)}</span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function renderFocalLengthModeControl() {
    return `
      <div class="focal-mode-control" role="group" aria-label="Focal length measurement">
        ${["equivalent", "actual"]
          .map((mode) => {
            const isActive = state.statsFocalMode === mode;
            const label = mode === "equivalent" ? "35mm equiv." : "Actual";
            return `<button class="focal-mode-button${isActive ? " is-active" : ""}" type="button" data-stats-focal-mode="${mode}" aria-pressed="${isActive}">${label}</button>`;
          })
          .join("")}
      </div>
    `;
  }

  function focalLengthBins(focalLengths) {
    const width = FOCAL_DISTRIBUTION_BIN_WIDTH;
    const halfWidth = width / 2;
    const firstCenter = FOCAL_DISTRIBUTION_FIRST_CENTER;
    const firstBoundary = firstCenter - halfWidth;
    const minimum = Math.min(...focalLengths);
    const maximum = Math.max(...focalLengths);
    const lastCenter = Math.max(
      firstCenter,
      firstCenter + Math.floor((maximum - firstBoundary) / width) * width
    );
    const bins = [];

    if (minimum < firstBoundary) {
      bins.push({
        start: 0,
        end: firstBoundary,
        includesEnd: false,
        tickLabel: `<${Math.round(firstBoundary)}`,
        rangeLabel: `Below ${formatFocalLength(firstBoundary)}`,
        count: focalLengths.filter((focalLength) => focalLength >= 0 && focalLength < firstBoundary).length
      });
    }

    for (let center = firstCenter; center <= lastCenter; center += width) {
      const start = center - halfWidth;
      const end = center + halfWidth;
      const includesEnd = false;
      bins.push({
        start,
        end,
        includesEnd,
        tickLabel: String(Math.round(center)),
        count: focalLengths.filter((focalLength) => focalLength >= start && (includesEnd ? focalLength <= end : focalLength < end)).length
      });
    }

    return bins;
  }

  function formatFocalLength(focalLength) {
    return `${Math.round(focalLength)}mm`;
  }

  function formatFocalRange(start, end) {
    if (start === end) {
      return formatFocalLength(start);
    }
    return `${Math.round(start)}-${(end - 0.01).toFixed(2)}mm`;
  }

  function focalLengthModeLabel(mode = state.statsFocalMode) {
    return mode === "actual" ? "Actual focal length" : "35mm equivalent";
  }

  function renderAtLimitsGallery(photos) {
    const longestReach = statsLongestReachRecord(photos);
    const slowestShutter = statsNumericExtreme(photos, statsExposureSeconds, "max");
    const highestIso = statsNumericExtreme(photos, statsIsoValue, "max");
    const smallestAperture = statsNumericExtreme(photos, statsApertureValue, "max");
    const records = [];

    if (longestReach) {
      records.push(longestReach);
    }
    if (slowestShutter) {
      records.push(statsLimitRecord(
        "Slowest shutter",
        slowestShutter.photo.exif.ExposureTime,
        `${frameCountLabel(slowestShutter.photos.length)} · motion at its limit`,
        slowestShutter,
        "shutter-seconds",
        slowestShutter.value
      ));
    }
    if (highestIso) {
      records.push(statsLimitRecord(
        "Highest sensitivity",
        `ISO ${Math.round(highestIso.value)}`,
        `${frameCountLabel(highestIso.photos.length)} · low-light reach`,
        highestIso,
        "iso-value",
        highestIso.value
      ));
    }
    if (smallestAperture) {
      records.push(statsLimitRecord(
        "Smallest aperture",
        formatApertureValue(smallestAperture.value),
        `${frameCountLabel(smallestAperture.photos.length)} · maximum depth`,
        smallestAperture,
        "aperture-value",
        smallestAperture.value
      ));
    }

    if (!records.length) {
      return "";
    }

    return `
      <section class="stats-limits-section" aria-labelledby="statsLimitsTitle">
        <div class="stats-limits-heading">
          <div>
            <p class="eyebrow">Archive edge cases</p>
            <h3 id="statsLimitsTitle">At the limits</h3>
          </div>
          <p>Open a card to inspect every tied frame.</p>
        </div>
        <div class="stats-limits-gallery">
          ${records.map(renderStatsLimitCard).join("")}
        </div>
      </section>
    `;
  }

  function statsLongestReachRecord(photos) {
    const longestFocal = statsNumericExtreme(
      photos,
      (photo) => statsFocalLengthValue(photo, state.statsFocalMode),
      "max"
    );
    if (!longestFocal) {
      return null;
    }
    return {
      ...statsLimitRecord(
        "Longest reach",
        formatFocalLength(longestFocal.value),
        `${focalLengthModeLabel(state.statsFocalMode)} · ${frameCountLabel(longestFocal.photos.length)}`,
        longestFocal,
        "focal-value",
        longestFocal.value
      ),
      limitKind: "longest-reach"
    };
  }

  function statsLimitRecord(label, value, detail, result, filterKind, filterValue) {
    return {
      label,
      value,
      detail,
      photo: result.photo,
      count: result.photos.length,
      filterKind,
      filterValue: String(filterValue)
    };
  }

  function renderStatsLimitCard(record) {
    const photo = record.photo;
    const limitKind = record.limitKind ? ` data-stats-limit-kind="${escapeAttr(record.limitKind)}"` : "";
    return `
      <button
        class="stats-limit-card"
        type="button"
        ${limitKind}
        data-stats-filter-kind="${escapeAttr(record.filterKind)}"
        data-stats-filter-value="${escapeAttr(record.filterValue)}"
        data-stats-filter-label="${escapeAttr(`${record.label}: ${record.value}`)}"
        aria-label="Open ${record.count} matching photo${record.count === 1 ? "" : "s"} for ${escapeAttr(record.label)}"
      >
        ${renderResponsivePhotoImage(photo, `${record.label}: ${photoSubjectLabel(photo)} at ${photo.locationName}`, {
          sizes: "(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 25vw"
        })}
        <span class="stats-limit-scrim" aria-hidden="true"></span>
        <span class="stats-limit-copy">
          <small>${escapeHtml(record.label)}</small>
          <strong>${escapeHtml(record.value)}</strong>
          <span>${escapeHtml(record.detail)}</span>
        </span>
      </button>
    `;
  }

  function statsNumericExtreme(photos, getValue, direction) {
    const valued = photos
      .map((photo) => ({ photo, value: Number(getValue(photo)) }))
      .filter((item) => Number.isFinite(item.value));
    if (!valued.length) {
      return null;
    }
    const values = valued.map((item) => item.value);
    const value = direction === "min" ? Math.min(...values) : Math.max(...values);
    const matchedPhotos = valued
      .filter((item) => Math.abs(item.value - value) < 0.0001)
      .map((item) => item.photo)
      .sort(sortPhotos);
    return { value, photos: matchedPhotos, photo: matchedPhotos[0] };
  }

  function frameCountLabel(count) {
    return `${count} frame${count === 1 ? "" : "s"}`;
  }

  function formatApertureValue(value) {
    return `f/${Number(value).toFixed(1)}`;
  }

  function exifIconForTitle(title) {
    const key = normalizeText(title);
    if (key.includes("camera")) {
      return "camera";
    }
    if (key.includes("lens")) {
      return "lens";
    }
    if (key.includes("focal")) {
      return "focal";
    }
    if (key.includes("shutter")) {
      return "shutter";
    }
    if (key.includes("aperture")) {
      return "aperture";
    }
    if (key.includes("iso")) {
      return "iso";
    }
    return "stats";
  }

  function renderDex() {
    if (!els.aircraftSearch || !els.dexCount || !els.aircraftGrid) {
      return;
    }
    const entries = filteredAircraftEntries();
    const familyFilter = state.dexFamilyFilter;

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
    const query = normalizeText(els.aircraftSearch?.value || "");
    const familyFilter = state.dexFamilyFilter;
    return state.data.aircraft.filter((entry) => {
      if (familyFilter && aircraftFamilyIdForEntry(entry) !== familyFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const squadronText = entry.squadrons.map((squadron) => `${squadron.name} ${squadron.unitLabel}`).join(" ");
      return normalizeText(`${entry.typeName} ${entry.countries.join(" ")} ${squadronText}`).includes(query);
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
    if (els.aircraftSearch) {
      els.aircraftSearch.value = "";
    }
    setActiveTab("dexView");
    updateDeepLink("family", family);
    renderDex();
    window.requestAnimationFrame(() => els.aircraftSearch?.focus({ preventScroll: true }));
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
      els.aircraftGrid.innerHTML = '<div class="empty-state">No aircraft entries match this search.</div>';
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
        style="--dex-delay: ${Math.min(index, 12) * 42}ms"
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
    const airshows = state.data.airshows || [];
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

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const previousRow = rows[rowIndex - 1];
      const currentRow = rows[rowIndex];
      if (!previousRow[0]?.isWide || !currentRow[0]?.isWide) {
        continue;
      }
      const normalIndex = currentRow.findIndex((item) => !item.isWide);
      if (normalIndex > 0) {
        [currentRow[0], currentRow[normalIndex]] = [currentRow[normalIndex], currentRow[0]];
      }
    }

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
    if (window.matchMedia("(max-width: 760px)").matches) {
      return { columns: 1, normalSpan: 1, wideSpan: 1 };
    }
    if (window.matchMedia("(max-width: 900px)").matches) {
      return { columns: 12, normalSpan: 6, wideSpan: 12 };
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
    const archiveGroupPanel = state.dexGroupMode === "location"
      ? renderAircraftLocationSection(locationGroups)
      : renderAircraftSquadronSection(entry);
    const cover = state.photoById.get(entry.coverPhoto) || photos[0] || null;
    const heroImage = cover ? cover.image || cover.thumbnail || "" : "";
    els.aircraftDetail.innerHTML = `
      ${renderDetailHero({
        backView: "dexView",
        backLabel: "Aircraft Dex",
        eyebrow: "Aircraft type",
        title: entry.typeName,
        description: `${stats.photoCount} photo${stats.photoCount === 1 ? "" : "s"} across ${unitCount} ${unitLabel}`,
        image: heroImage,
        alt: `${entry.typeName} hero photo`,
        actions: renderFieldGuideActions("Aircraft field guide"),
        className: "aircraft-field-guide-hero"
      })}
      ${renderPageWriteUp(entry.writeUp, "About this aircraft")}
      <section class="detail-summary detail-aircraft-summary">
        <div>
          <p class="eyebrow">Archive view</p>
          <p class="detail-summary-copy">Browse this type by ${escapeHtml(unitGroupLabel.toLowerCase())} or location.</p>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Organize aircraft photos">
          ${segmentButton(unitGroupLabel, "squadron", state.dexGroupMode, "data-dex-group")}
          ${segmentButton("Location", "location", state.dexGroupMode, "data-dex-group")}
        </div>
      </section>

      <div class="entry-stat-grid" aria-label="Aircraft statistics">
        ${statTile("Photos", stats.photoCount)}
        ${statTile(entryUnitNoun(entry, 2, true), unitCount)}
        ${statTile("Locations", stats.locationCount)}
        ${statTile("Latest", stats.latestDate ? formatDisplayDate(stats.latestDate) : "No photos")}
      </div>

      ${archiveGroupPanel}

      <section class="detail-photo-section">
        <div class="detail-section-heading">
          <div>
            <p class="eyebrow">Photo archive</p>
            <h2>All frames</h2>
          </div>
          <span class="count-pill">${photos.length}</span>
        </div>
        ${renderPhotoGroups(photos, state.dexGroupMode, "dex")}
      </section>
    `;
  }

  function renderAircraftSquadronSection(entry) {
    if (!entry.squadrons.length) {
      return "";
    }

    return `
      <section class="detail-unit-section">
        <div class="detail-section-heading">
          <div>
            <p class="eyebrow">Units</p>
            <h2>${escapeHtml(entryUnitNoun(entry, 2, true))}</h2>
          </div>
          <span class="count-pill">${entry.squadrons.length}</span>
        </div>
        <div class="squadron-grid">
          ${entry.squadrons.map(renderSquadronRow).join("")}
        </div>
      </section>
    `;
  }

  function aircraftLocationGroups(photos) {
    const groups = new Map();
    photos.forEach((photo) => {
      const name = photo.locationName || "Unknown location";
      const candidatePinId = photo.pinId ? String(photo.pinId) : "";
      const pinId = candidatePinId && state.pinById.has(candidatePinId)
        ? candidatePinId
        : pinIdFromLocation(name);
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

  function renderAircraftLocationSection(locations) {
    if (!locations.length) {
      return "";
    }

    return `
      <section class="detail-unit-section">
        <div class="detail-section-heading">
          <div>
            <p class="eyebrow">Archive locations</p>
            <h2>Locations</h2>
          </div>
          <span class="count-pill">${locations.length}</span>
        </div>
        <div class="squadron-grid">
          ${locations.map(renderAircraftLocationRow).join("")}
        </div>
      </section>
    `;
  }

  function renderAircraftLocationRow(location) {
    const pin = location.pinId ? state.pinById.get(location.pinId) : null;
    const locationMeta = [pin?.icao, pin?.country].filter(Boolean).join(" - ") || "Location archive";
    const photoLabel = `${location.count} photo${location.count === 1 ? "" : "s"}`;
    const rowTag = location.pinId ? "button" : "div";
    const rowClass = `squadron-row aircraft-location-row${location.pinId ? " is-clickable" : ""}`;
    const rowAttributes = location.pinId
      ? ` type="button" data-location-page-id="${escapeAttr(location.pinId)}" aria-label="Open ${escapeAttr(location.name)} location page"`
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

  function renderSquadronRow(squadron) {
    const logoContent = squadron.logo
      ? `<img class="squadron-logo" src="${escapeAttr(squadron.logo)}" alt="${escapeAttr(squadron.name)} logo">`
      : `<span class="logo-fallback" aria-hidden="true">${escapeHtml(initials(squadron.name))}</span>`;
    const photoCount = Number(squadron.photoCount || 0);
    const unitLabel = squadron.unitLabel || unitDisplayLabel(squadron.unitType);
    const squadronId = squadronPageIdForUnit(squadron);
    const rowTag = squadronId ? "button" : "div";
    const rowClass = `squadron-row${squadronId ? " is-clickable" : ""}`;
    const rowAttributes = squadronId
      ? ` type="button" data-squadron-id="${escapeAttr(squadronId)}" aria-label="Open ${escapeAttr(squadron.name)} on the Squadrons page"`
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

  function statTile(label, value) {
    return `
      <div>
        <strong>${escapeHtml(value)}</strong>
        <span>${escapeHtml(label)}</span>
      </div>
    `;
  }

  function renderPhotoGroups(photos, mode, context) {
    if (!photos.length) {
      return '<div class="empty-state">No photos found for this selection yet.</div>';
    }

    return `
      <div class="photo-groups photo-groups-${escapeAttr(context)}">
        ${groupPhotos(photos, mode)
          .map(
            (group, index) => `
              <section>
                <div class="group-header">
                  <h3>${escapeHtml(group.name)}</h3>
                  <span class="count-pill">${group.photos.length}</span>
                </div>
                ${renderProgressivePhotoGrid(group.photos, context, `${context}-${mode}-${index}-${group.name}`)}
              </section>
            `
          )
          .join("")}
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
    return `<img${className} src="${escapeAttr(source)}"${srcset}${sizes}${width}${height} loading="${loading}" decoding="async"${priority} alt="${escapeAttr(alt)}">`;
  }

  function parseImageSize(value) {
    const match = String(value || "").match(/(\d+)\s*x\s*(\d+)/i);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
  }

  function renderPhotoCard(photo, context) {
    return `
      <button class="photo-card" type="button" data-photo-id="${escapeAttr(photo.id)}" data-photo-context="${escapeAttr(context)}">
        ${renderResponsivePhotoImage(photo, `${photoSubjectLabel(photo)} at ${photo.locationName}`, {
          sizes: "(max-width: 520px) 100vw, (max-width: 1040px) 50vw, 360px"
        })}
        <span class="photo-body">
          <strong>${escapeHtml(photoSubjectLabel(photo))}</strong>
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

  function segmentButton(label, value, activeValue, dataName) {
    const isActive = value === activeValue;
    const activeClass = isActive ? " is-active" : "";
    return `<button class="segment-button${activeClass}" type="button" role="radio" aria-checked="${isActive ? "true" : "false"}" ${dataName}="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
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
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
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
    if (!document.getElementById("aircraftDetailView")) {
      navigateToViewPage("aircraftDetailView", `aircraft=${encodeURIComponent(aircraftId)}`);
      return;
    }
    state.selectedAircraftId = aircraftId;
    setActiveTab("aircraftDetailView", { updateHash: false });
    renderAircraftDetail();
    if (options.updateHash !== false) {
      updateDeepLink("aircraft", aircraftId);
    }
    if (options.scroll !== false) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function selectSquadron(squadronId, options = {}) {
    if (!document.getElementById("squadronDetailView")) {
      navigateToViewPage("squadronDetailView", `squadron=${encodeURIComponent(squadronId)}`);
      return;
    }
    state.selectedSquadronId = squadronId;
    setActiveTab("squadronDetailView", { updateHash: false });
    renderSquadronDetail();
    if (options.updateHash !== false) {
      updateDeepLink("squadron", squadronId);
    }
    if (options.scroll !== false) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
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
    state.selectedAirshowId = airshowId;
    setActiveTab("airshowDetailView", { updateHash: false });
    renderAirshowDetail();

    if (options.updateHash !== false) {
      updateDeepLink("airshow", airshowId);
    }

    if (options.scroll !== false) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
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

    if (options.updateHash !== false) {
      updateDeepLink("stats", statsSection);
    }

    if (options.scroll !== false) {
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
    document.body.style.overflow = "hidden";
    setViewerBackgroundInert(true);
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
    const shouldUseHistory = options.useHistory !== false
      && state.viewerHistoryPushed
      && new URLSearchParams(window.location.hash.replace(/^#/, "")).has("photo");
    els.photoViewer.hidden = true;
    document.body.classList.remove("is-viewer-open");
    document.body.style.overflow = "";
    setViewerBackgroundInert(false);
    setViewerInfoOpen(false);
    resetViewerTransform();
    state.viewerHistoryPushed = false;
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
      return;
    }

    if (options.updateHash !== false) {
      updateDeepLinkForViewerContext();
    }
  }

  function setViewerBackgroundInert(isInert) {
    [els.siteHeader, els.main, els.mobileTabBar].forEach((element) => {
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
    const renderToken = ++state.viewerRenderToken;
    state.viewerRevealToken = 0;
    els.viewerImage.classList.remove("is-entering");
    els.viewerImageFrame?.classList.remove("is-focusing");
    els.photoViewer.style.setProperty(
      "--viewer-backdrop",
      imageSource ? `url(${JSON.stringify(imageSource)})` : "none"
    );
    els.viewerImage.addEventListener("load", () => revealViewerPhoto(renderToken), { once: true });
    els.viewerImage.src = imageSource;
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
    els.viewerImage.classList.remove("is-entering");
    els.viewerImageFrame.classList.remove("is-focusing");
    void els.viewerImageFrame.offsetWidth;
    els.viewerImage.classList.add("is-entering");
    els.viewerImageFrame.classList.add("is-focusing");
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

  function resetViewerTransform() {
    state.viewerZoom = 1;
    state.viewerPanX = 0;
    state.viewerPanY = 0;
    state.viewerPointers.clear();
    state.viewerDragOrigin = null;
    state.viewerPinchStart = null;
    state.viewerSwipeStart = null;
    els.viewerImage?.classList.remove("is-dragging");
    updateViewerTransform();
  }

  function setViewerZoom(value) {
    state.viewerZoom = Math.min(4, Math.max(1, Number(value) || 1));
    if (state.viewerZoom <= 1) {
      state.viewerPanX = 0;
      state.viewerPanY = 0;
    } else {
      constrainViewerPan();
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

  function constrainViewerPan() {
    if (!els.viewerImage || !els.viewerImageFrame) {
      return;
    }
    const width = els.viewerImage.clientWidth || els.viewerImageFrame.clientWidth || 0;
    const height = els.viewerImage.clientHeight || els.viewerImageFrame.clientHeight || 0;
    const maxX = Math.max(0, (width * state.viewerZoom - els.viewerImageFrame.clientWidth) / 2);
    const maxY = Math.max(0, (height * state.viewerZoom - els.viewerImageFrame.clientHeight) / 2);
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
    els.viewerImage.setPointerCapture?.(event.pointerId);
    state.viewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.viewerPointers.size === 1) {
      state.viewerDragOrigin = {
        x: event.clientX,
        y: event.clientY,
        panX: state.viewerPanX,
        panY: state.viewerPanY
      };
      state.viewerSwipeStart = state.viewerZoom <= 1 && event.pointerType !== "mouse"
        ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() }
        : null;
    } else if (state.viewerPointers.size === 2) {
      const [first, second] = Array.from(state.viewerPointers.values());
      state.viewerPinchStart = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        zoom: state.viewerZoom
      };
      state.viewerDragOrigin = null;
      state.viewerSwipeStart = null;
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
      state.viewerSwipeStart = null;
      const [first, second] = Array.from(state.viewerPointers.values());
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      setViewerZoom(state.viewerPinchStart.zoom * (distance / Math.max(1, state.viewerPinchStart.distance)));
      event.preventDefault();
      return;
    }
    if (state.viewerZoom > 1 && state.viewerDragOrigin) {
      state.viewerPanX = state.viewerDragOrigin.panX + event.clientX - state.viewerDragOrigin.x;
      state.viewerPanY = state.viewerDragOrigin.panY + event.clientY - state.viewerDragOrigin.y;
      constrainViewerPan();
      updateViewerTransform();
      event.preventDefault();
    }
  }

  function handleViewerPointerUp(event) {
    const swipe = state.viewerSwipeStart?.pointerId === event.pointerId && event.type === "pointerup"
      ? {
          x: event.clientX - state.viewerSwipeStart.x,
          y: event.clientY - state.viewerSwipeStart.y,
          duration: performance.now() - state.viewerSwipeStart.time
        }
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
    state.viewerSwipeStart = null;

    if (
      swipe
      && state.viewerZoom <= 1
      && swipe.duration <= VIEWER_SWIPE_MAX_DURATION
      && Math.abs(swipe.x) >= VIEWER_SWIPE_MIN_DISTANCE
      && Math.abs(swipe.x) > Math.abs(swipe.y) * 1.25
    ) {
      event.preventDefault();
      stepPhoto(swipe.x < 0 ? 1 : -1);
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
      updateDeepLink("aircraft", state.selectedAircraftId, replace);
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

  function setViewerInfoOpen(isOpen) {
    if (isOpen && !state.viewerInfoOpen) {
      state.viewerInfoSnap = "expanded";
    }
    state.viewerInfoOpen = Boolean(isOpen);
    updateViewerInfoState();
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
    els.viewerInfo.setAttribute("aria-hidden", String(isMobile && !isOpen));
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
    const statsSection = params.get("stats");
    const aircraftFamily = normalizeAircraftFamily(params.get("family"));

    state.isApplyingHash = true;
    try {
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
          selectAircraft(entry.id, { updateHash: false, scroll: !options.initial });
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

      if (pageViewId === "dexView" && aircraftFamily) {
        state.dexFamilyFilter = aircraftFamily;
        openDirectoryView("dexView");
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
    if (state.isApplyingHash || !id) {
      return false;
    }
    const nextHash = `#${kind}=${encodeURIComponent(id)}`;
    const changed = navigateToHash(nextHash, {
      replace: options.replace,
      state: { spotterdex: true, spotterdexKind: kind, spotterdexId: String(id) }
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
})();
