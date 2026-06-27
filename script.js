(function () {
  const EMPTY_DATA = { generatedAt: null, pins: [], aircraft: [], photos: [] };
  const RECENT_PHOTO_LIMIT = 8;

  const state = {
    data: EMPTY_DATA,
    pinById: new Map(),
    photoById: new Map(),
    aircraftById: new Map(),
    selectedPinId: null,
    selectedAircraftId: null,
    selectedSquadronId: null,
    mapGroupMode: "squadron",
    dexGroupMode: "squadron",
    map: null,
    markerLayer: null,
    mapTrafficLayer: null,
    mapRouteLayer: null,
    mapRouteVisible: false,
    mapDossierOpen: true,
    markersByPinId: new Map(),
    mapResizeObserver: null,
    mapRefreshHandle: null,
    activePhotoIds: [],
    activePhotoIndex: 0,
    activePhotoContext: "map",
    statsPhotoIds: [],
    statsPhotoLabel: "",
    viewerInfoOpen: false,
    viewerZoom: 1,
    viewerPanX: 0,
    viewerPanY: 0,
    viewerCleanMode: false,
    viewerPointers: new Map(),
    viewerDragOrigin: null,
    viewerPinchStart: null,
    mobileMapPanel: null,
    mapControlPanelOpen: true,
    squadronHeroOverrides: new Map(),
    squadronPhotographedOnly: false,
    isApplyingHash: false
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    setupTheme();
    loadSquadronHeroOverrides();
    setupEvents();

    state.data = prepareData(await loadData());
    chooseInitialSelections();
    renderAll();
    applyDeepLinkFromHash({ initial: true });
  }

  function cacheElements() {
    els.root = document.documentElement;
    els.brand = document.querySelector(".brand");
    els.themeToggle = document.getElementById("themeToggle");
    els.viewSelect = document.getElementById("viewSelect");
    els.aircraftCount = document.getElementById("aircraftCount");
    els.photoCount = document.getElementById("photoCount");
    els.locationCount = document.getElementById("locationCount");
    els.locationSearch = document.getElementById("locationSearch");
    els.aircraftSearch = document.getElementById("aircraftSearch");
    els.locationList = document.getElementById("locationList");
    els.mapWorkspace = document.querySelector("#mapView .map-workspace");
    els.mapControlPanel = document.getElementById("mapControlPanel");
    els.mapPanelToggles = document.querySelectorAll("[data-map-panel-toggle]");
    els.worldMap = document.getElementById("worldMap");
    els.mapFallback = document.getElementById("mapFallback");
    els.mapResults = document.getElementById("mapResults");
    els.mapMissionHud = document.getElementById("mapMissionHud");
    els.mapRouteButton = document.getElementById("mapRouteButton");
    els.mapDossierButton = document.getElementById("mapDossierButton");
    els.recentPhotosStrip = document.getElementById("recentPhotosStrip");
    els.recentPhotosCount = document.getElementById("recentPhotosCount");
    els.aircraftGrid = document.getElementById("aircraftGrid");
    els.dexDetail = document.getElementById("dexDetail");
    els.dexCount = document.getElementById("dexCount");
    els.statsDashboard = document.getElementById("statsDashboard");
    els.exifDashboard = document.getElementById("exifDashboard");
    els.squadronLogoGrid = document.getElementById("squadronLogoGrid");
    els.squadronFilters = document.getElementById("squadronFilters");
    els.squadronCountryRail = document.getElementById("squadronCountryRail");
    els.squadronDetail = document.getElementById("squadronDetail");
    els.squadronPageCount = document.getElementById("squadronPageCount");
    els.photoViewer = document.getElementById("photoViewer");
    els.viewerImageFrame = document.querySelector(".viewer-image-frame");
    els.viewerImage = document.getElementById("viewerImage");
    els.viewerKicker = document.getElementById("viewerKicker");
    els.viewerTitle = document.getElementById("viewerTitle");
    els.viewerCaption = document.getElementById("viewerCaption");
    els.viewerMetadata = document.getElementById("viewerMetadata");
    els.viewerInfo = document.getElementById("viewerInfo");
    els.viewerInfoButton = document.getElementById("viewerInfoButton");
    els.viewerFilmstrip = document.getElementById("viewerFilmstrip");
    els.viewerTelemetry = document.getElementById("viewerTelemetry");
    els.viewerZoomOutButton = document.getElementById("viewerZoomOutButton");
    els.viewerZoomResetButton = document.getElementById("viewerZoomResetButton");
    els.viewerZoomInButton = document.getElementById("viewerZoomInButton");
    els.viewerCleanButton = document.getElementById("viewerCleanButton");
  }

  async function loadData() {
    if (window.SPOTTERDEX_DATA) {
      return window.SPOTTERDEX_DATA;
    }

    try {
      const response = await fetch("data/spotterdex.json", { cache: "no-cache" });
      if (!response.ok) {
        throw new Error("Could not load SpotterDex data");
      }
      return await response.json();
    } catch (error) {
      console.warn(error);
      return EMPTY_DATA;
    }
  }

  function prepareData(rawData) {
    const data = {
      generatedAt: rawData.generatedAt || null,
      pins: Array.isArray(rawData.pins) ? rawData.pins : [],
      aircraft: Array.isArray(rawData.aircraft) ? rawData.aircraft : [],
      photos: Array.isArray(rawData.photos) ? rawData.photos : []
    };

    data.pins = data.pins
      .map((pin) => ({
        ...pin,
        id: String(pin.id || slugify(pin.name || "pin")),
        name: pin.name || "Unnamed location",
        country: pin.country || "",
        icao: normalizeIcao(pin.icao || pin.icaoCode || pin.icao_code),
        lat: Number(pin.lat),
        lon: Number(pin.lon),
        enabled: pin.enabled !== false
      }))
      .filter((pin) => Number.isFinite(pin.lat) && Number.isFinite(pin.lon));

    data.photos = data.photos.map((photo, index) => {
      const unitType = normalizeUnitType(photo.unitType || photo.unit_type || photo.squadronType);
      return {
        ...photo,
        id: String(photo.id || `photo-${index + 1}`),
        year: photo.year ? String(photo.year) : "",
        date: photo.date ? String(photo.date) : "",
        sortDate: photo.sortDate ? String(photo.sortDate) : deriveSortDate(photo),
        locationName: photo.locationName || photo.location || "Unknown location",
        aircraftType: photo.aircraftType || "Unknown aircraft",
        squadronName: photo.squadronName || photo.unitName || unknownUnitName(unitType),
        unitType,
        unitLabel: photo.unitLabel || unitDisplayLabel(unitType),
        thumbnail: photo.thumbnail || photo.image || "",
        exif: photo.exif && typeof photo.exif === "object" ? photo.exif : {}
      };
    });

    data.photos.forEach((photo) => {
      photo.sortTime = Date.parse(photo.sortDate || photo.date || `${photo.year || "0000"}-01-01`);
      if (!Number.isFinite(photo.sortTime)) {
        photo.sortTime = 0;
      }
    });

    data.aircraft = data.aircraft
      .map((entry) => ({
        ...entry,
        id: String(entry.id || slugify(entry.typeName || "aircraft")),
        typeName: entry.typeName || entry.aircraftType || "Unknown aircraft",
        countries: Array.isArray(entry.countries) ? entry.countries : [],
        squadrons: Array.isArray(entry.squadrons) ? entry.squadrons.map(normalizeUnitRecord) : [],
        photoIds: Array.isArray(entry.photoIds) ? entry.photoIds : [],
        stats: entry.stats && typeof entry.stats === "object" ? entry.stats : {}
      }))
      .sort((a, b) => a.typeName.localeCompare(b.typeName));

    state.pinById = new Map(data.pins.map((pin) => [pin.id, pin]));
    state.photoById = new Map(data.photos.map((photo) => [photo.id, photo]));
    state.aircraftById = new Map(data.aircraft.map((entry) => [entry.id, entry]));

    data.aircraft.forEach((entry) => {
      const matchingPhotoIds = data.photos
        .filter((photo) => photo.aircraftId === entry.id)
        .map((photo) => photo.id);
      entry.photoIds = unique([...entry.photoIds, ...matchingPhotoIds]);
      entry.coverPhoto = entry.coverPhoto || entry.photoIds[0] || null;
      entry.stats = normalizeAircraftStats(entry);
    });

    return data;
  }

  function normalizeUnitRecord(squadron) {
    const unitType = normalizeUnitType(squadron.unitType || squadron.unit_type || squadron.squadronType);
    return {
      ...squadron,
      id: String(squadron.id || slugify(squadron.name || "unit")),
      name: squadron.name || unknownUnitName(unitType),
      country: squadron.country || "",
      logo: squadron.logo || "",
      heroPhoto: squadron.heroPhoto && typeof squadron.heroPhoto === "object" ? squadron.heroPhoto : null,
      photoIds: Array.isArray(squadron.photoIds) ? squadron.photoIds : [],
      unitType,
      unitLabel: squadron.unitLabel || unitDisplayLabel(unitType),
      showOnSquadronsPage: squadron.showOnSquadronsPage !== false && unitType === "squadron"
    };
  }

  function chooseInitialSelections() {
    const mostRecentLocation = recentLocations()[0];
    const firstEnabledPin = state.data.pins.find((pin) => pin.enabled);

    state.selectedPinId = mostRecentLocation ? mostRecentLocation.pin.id : firstEnabledPin ? firstEnabledPin.id : null;
    state.selectedAircraftId = null;
  }

  function setupTheme() {
    const storedTheme = localStorage.getItem("spotterdex-theme");
    if (storedTheme === "dark" || storedTheme === "light") {
      els.root.dataset.theme = storedTheme;
    }
    updateThemeButton();
  }

  function loadSquadronHeroOverrides() {
    try {
      const stored = JSON.parse(localStorage.getItem("spotterdex-squadron-heroes") || "{}");
      if (stored && typeof stored === "object") {
        state.squadronHeroOverrides = new Map(
          Object.entries(stored).filter(([, photoId]) => typeof photoId === "string" && photoId)
        );
      }
    } catch (error) {
      state.squadronHeroOverrides = new Map();
    }
  }

  function setSquadronHeroOverride(squadronId, photoId) {
    if (!squadronId) {
      return;
    }
    if (photoId && state.photoById.has(photoId)) {
      state.squadronHeroOverrides.set(squadronId, photoId);
    } else {
      state.squadronHeroOverrides.delete(squadronId);
    }
    localStorage.setItem("spotterdex-squadron-heroes", JSON.stringify(Object.fromEntries(state.squadronHeroOverrides)));
    renderSquadronsPage();
  }

  function setupEvents() {
    document.querySelectorAll("[data-tab-target]").forEach((button) => {
      button.addEventListener("click", () => setActiveTab(button.dataset.tabTarget));
    });
    if (els.brand) {
      els.brand.addEventListener("click", (event) => {
        event.preventDefault();
        goToMapHome();
      });
    }
    els.viewSelect.addEventListener("change", () => setActiveTab(els.viewSelect.value));

    els.themeToggle.addEventListener("click", toggleTheme);
    document.getElementById("fitPinsButton").addEventListener("click", fitMapToPins);
    els.mapRouteButton.addEventListener("click", toggleMapRoute);
    els.mapDossierButton.addEventListener("click", () => {
      if (isMobileMapLayout()) {
        toggleMapPanel("results");
      } else {
        setMapDossierOpen(!state.mapDossierOpen);
      }
    });
    document.getElementById("closeViewerButton").addEventListener("click", closeViewer);
    document.getElementById("previousPhotoButton").addEventListener("click", () => stepPhoto(-1));
    document.getElementById("nextPhotoButton").addEventListener("click", () => stepPhoto(1));
    els.viewerInfoButton.addEventListener("click", () => setViewerInfoOpen(!state.viewerInfoOpen));
    els.viewerZoomOutButton.addEventListener("click", () => setViewerZoom(state.viewerZoom - 0.25));
    els.viewerZoomResetButton.addEventListener("click", resetViewerTransform);
    els.viewerZoomInButton.addEventListener("click", () => setViewerZoom(state.viewerZoom + 0.25));
    els.viewerCleanButton.addEventListener("click", () => setViewerCleanMode(!state.viewerCleanMode));
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

    els.locationSearch.addEventListener("input", renderLocations);
    els.aircraftSearch.addEventListener("input", renderDex);

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("change", handleDocumentChange);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("hashchange", () => applyDeepLinkFromHash());
    window.addEventListener("resize", debounce(() => {
      updateMapPanelState();
      updateViewerInfoState();
      renderMapMissionHud();
      refreshMapLayout();
    }, 150));
  }

  function handleDocumentClick(event) {
    if (event.target.closest("#viewerInfoButton")) {
      return;
    }

    if (!els.photoViewer.hidden && state.viewerInfoOpen && isMobileViewerLayout() && !event.target.closest("#viewerInfo")) {
      setViewerInfoOpen(false);
    }

    const mapPanelButton = event.target.closest("[data-map-panel-toggle]");
    if (mapPanelButton) {
      toggleMapPanel(mapPanelButton.dataset.mapPanelToggle);
      return;
    }

    const mapDossierButton = event.target.closest("[data-map-dossier-toggle]");
    if (mapDossierButton) {
      if (isMobileMapLayout()) {
        setMapPanel(null);
      } else {
        setMapDossierOpen(false);
      }
      return;
    }

    const mapControlToggle = event.target.closest("[data-map-control-toggle]");
    if (mapControlToggle) {
      setMapControlPanelOpen(!state.mapControlPanelOpen);
      return;
    }

    const squadronPhotoToggle = event.target.closest("[data-squadron-photographed-toggle]");
    if (squadronPhotoToggle) {
      state.squadronPhotographedOnly = !state.squadronPhotographedOnly;
      renderSquadronsPage();
      return;
    }

    const countryJump = event.target.closest("[data-squadron-country-jump]");
    if (countryJump) {
      const target = document.getElementById(countryJump.dataset.squadronCountryJump || "");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
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

    const squadronHeroReset = event.target.closest("[data-squadron-hero-reset]");
    if (squadronHeroReset) {
      setSquadronHeroOverride(squadronHeroReset.dataset.squadronHeroReset, "");
      return;
    }

    const mapGroupButton = event.target.closest("[data-map-group]");
    if (mapGroupButton) {
      state.mapGroupMode = mapGroupButton.dataset.mapGroup;
      renderMapResults();
      return;
    }

    const dexGroupButton = event.target.closest("[data-dex-group]");
    if (dexGroupButton) {
      state.dexGroupMode = dexGroupButton.dataset.dexGroup;
      renderDexDetail();
      return;
    }

    const locationButton = event.target.closest("[data-location-id]");
    if (locationButton) {
      selectPin(locationButton.dataset.locationId);
      return;
    }

    const aircraftButton = event.target.closest("[data-aircraft-id]");
    if (aircraftButton) {
      selectAircraft(aircraftButton.dataset.aircraftId);
      return;
    }

    const squadronButton = event.target.closest("[data-squadron-id]");
    if (squadronButton) {
      if (!els.photoViewer.hidden) {
        closeViewer({ updateHash: false });
      }
      selectSquadron(squadronButton.dataset.squadronId);
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

  function handleDocumentChange(event) {
    const heroPicker = event.target.closest("[data-squadron-hero-picker]");
    if (heroPicker) {
      setSquadronHeroOverride(heroPicker.dataset.squadronHeroPicker, heroPicker.value);
    }
  }

  function handleKeydown(event) {
    if (!els.photoViewer.hidden) {
      if (event.key === "Escape") {
        if (state.viewerCleanMode) {
          setViewerCleanMode(false);
        } else if (state.viewerInfoOpen && isMobileViewerLayout()) {
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
      } else if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        setViewerCleanMode(!state.viewerCleanMode);
      }
    } else if (event.key === "Escape" && state.mobileMapPanel && isMobileMapLayout()) {
      setMapPanel(null);
    }
  }

  function toggleMapPanel(panel) {
    setMapPanel(state.mobileMapPanel === panel ? null : panel);
  }

  function setMapPanel(panel) {
    state.mobileMapPanel = panel === "locations" || panel === "results" ? panel : null;
    updateMapPanelState();

    if (state.map) {
      refreshMapLayout();
    }
  }

  function setMapDossierOpen(isOpen) {
    state.mapDossierOpen = Boolean(isOpen);
    updateMapDossierState();
    refreshMapLayout();
  }

  function setMapControlPanelOpen(isOpen) {
    state.mapControlPanelOpen = Boolean(isOpen);
    updateMapControlPanelState();
    refreshMapLayout();
  }

  function updateMapControlPanelState() {
    if (!els.mapWorkspace) {
      return;
    }
    els.mapWorkspace.classList.toggle("is-control-panel-open", state.mapControlPanelOpen);
    const toggle = els.mapResults?.querySelector("[data-map-control-toggle]");
    if (toggle) {
      const label = state.mapControlPanelOpen ? "Hide collection panel" : "Show collection panel";
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
      const icon = toggle.querySelector("span");
      if (icon) {
        icon.textContent = state.mapControlPanelOpen ? "◀" : "☰";
      }
    }
  }

  function updateMapDossierState() {
    if (!els.mapWorkspace || !els.mapDossierButton) {
      return;
    }
    els.mapWorkspace.classList.toggle("is-dossier-open", state.mapDossierOpen);
    els.mapDossierButton.setAttribute("aria-expanded", String(state.mapDossierOpen));
    els.mapDossierButton.setAttribute("aria-label", state.mapDossierOpen ? "Hide location details" : "Show location details");
    els.mapDossierButton.querySelector("span:last-child").textContent = state.mapDossierOpen
      ? "Hide details"
      : "Location details";
  }

  function updateMapPanelState() {
    if (!els.mapWorkspace) {
      return;
    }

    const activePanel = state.mobileMapPanel;
    els.mapWorkspace.classList.toggle("is-locations-open", activePanel === "locations");
    els.mapWorkspace.classList.toggle("is-results-open", activePanel === "results");

    els.mapPanelToggles.forEach((button) => {
      const isExpanded = button.dataset.mapPanelToggle === activePanel;
      button.classList.toggle("is-active", isExpanded);
      button.setAttribute("aria-expanded", String(isExpanded));
    });
  }

  function isMobileMapLayout() {
    return window.matchMedia("(max-width: 1040px)").matches;
  }

  function isMobileViewerLayout() {
    return window.matchMedia("(max-width: 1040px)").matches;
  }

  function setActiveTab(viewId, options = {}) {
    const activeBefore = document.querySelector("[data-view].is-active");
    document.querySelectorAll("[data-view]").forEach((view) => {
      const isActive = view.id === viewId;
      view.hidden = !isActive;
      view.classList.toggle("is-active", isActive);
    });

    document.querySelectorAll("[data-tab-target]").forEach((button) => {
      const isActive = button.dataset.tabTarget === viewId;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });
    if (els.viewSelect) {
      els.viewSelect.value = viewId;
    }

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
  }

  function goToMapHome() {
    setActiveTab("mapView");
    setMapPanel(null);
    if (state.selectedPinId) {
      selectPin(state.selectedPinId, { updateHash: false, pan: true, openPanel: false });
      updateDeepLink("location", state.selectedPinId);
    } else {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }

  function updateDeepLinkForView(viewId) {
    if (viewId === "mapView" && state.selectedPinId) {
      updateDeepLink("location", state.selectedPinId);
    } else if (viewId === "dexView" && state.selectedAircraftId) {
      updateDeepLink("aircraft", state.selectedAircraftId);
    } else if (viewId === "squadronsView" && state.selectedSquadronId) {
      updateDeepLink("squadron", state.selectedSquadronId);
    } else if (viewId === "statsView") {
      updateDeepLink("stats", "summary");
    }
  }

  function toggleTheme() {
    const current = resolvedTheme();
    const next = current === "dark" ? "light" : "dark";
    els.root.dataset.theme = next;
    localStorage.setItem("spotterdex-theme", next);
    updateThemeButton();
    if (state.map) {
      renderPins();
      renderMapResults();
    }
  }

  function resolvedTheme() {
    const explicit = els.root.dataset.theme;
    if (explicit === "dark" || explicit === "light") {
      return explicit;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function updateThemeButton() {
    const isDark = resolvedTheme() === "dark";
    els.themeToggle.innerHTML = isDark ? themeIcon("sun") : themeIcon("moon");
    els.themeToggle.title = isDark ? "Switch to light mode" : "Switch to dark mode";
    els.themeToggle.setAttribute("aria-label", els.themeToggle.title);
  }

  function themeIcon(name) {
    if (name === "sun") {
      return `
        <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2"></path>
          <path d="M12 20v2"></path>
          <path d="m4.93 4.93 1.41 1.41"></path>
          <path d="m17.66 17.66 1.41 1.41"></path>
          <path d="M2 12h2"></path>
          <path d="M20 12h2"></path>
          <path d="m6.34 17.66-1.41 1.41"></path>
          <path d="m19.07 4.93-1.41 1.41"></path>
        </svg>
      `;
    }

    return `
      <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.99 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.78 9.79Z"></path>
      </svg>
    `;
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
    renderStats();
    renderMapMissionHud();
    renderLocations();
    initMap();
    fitMapToPins();
    renderPins();
    renderRecentPhotos();
    renderMapResults();
    updateMapPanelState();
    updateMapControlPanelState();
    updateMapDossierState();
    renderDex();
    renderStatsDashboard();
    renderExifDashboard();
    renderSquadronsPage();
  }

  function renderStats() {
    const enabledPins = state.data.pins.filter((pin) => pin.enabled);
    els.aircraftCount.textContent = String(state.data.aircraft.length);
    els.photoCount.textContent = String(state.data.photos.length);
    els.locationCount.textContent = String(enabledPins.length);
  }

  function renderLocations() {
    const query = normalizeText(els.locationSearch.value);
    const locations = recentLocations()
      .filter((location) => !query || normalizeText(`${location.pin.name} ${location.pin.country}`).includes(query));

    if (!locations.length) {
      els.locationList.innerHTML = '<div class="empty-state">No recent locations match this search.</div>';
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
  }

  function initMap() {
    if (state.map || !els.worldMap) {
      return;
    }

    if (!window.L) {
      els.mapFallback.hidden = false;
      return;
    }

    state.map = window.L.map(els.worldMap, {
      scrollWheelZoom: true,
      zoomControl: true
    });

    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(state.map);

    state.mapTrafficLayer = window.L.layerGroup().addTo(state.map);
    state.markerLayer = window.L.layerGroup().addTo(state.map);
    state.mapRouteLayer = window.L.layerGroup().addTo(state.map);
    state.map.on("zoomend moveend", () => {
      renderPins();
      renderMapMissionHud();
    });
    observeMapSize();
    refreshMapLayout();
    renderMapRoute();
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
    if (!state.map) {
      return;
    }

    window.cancelAnimationFrame(state.mapRefreshHandle);
    state.mapRefreshHandle = window.requestAnimationFrame(() => {
      state.map.invalidateSize({ pan: false });
      renderPins();
      window.setTimeout(() => {
        state.map.invalidateSize({ pan: false });
        renderPins();
      }, 120);
    });
  }

  function renderPins() {
    if (!state.map || !state.markerLayer || !window.L) {
      return;
    }

    state.markerLayer.clearLayers();
    state.markersByPinId = new Map();
    const clusters = clusterPins(state.data.pins.filter((pin) => pin.enabled));

    clusters.forEach((cluster) => {
      if (cluster.pins.length === 1) {
        const pin = cluster.pins[0];
        const marker = window.L.marker([pin.lat, pin.lon], {
          icon: mapMarkerIcon(pin, pin.id === state.selectedPinId),
          title: pin.name
        })
          .on("click", () => selectPin(pin.id, { pan: false }));

        marker.addTo(state.markerLayer);
        state.markersByPinId.set(pin.id, marker);
        return;
      }

      const clusterLabel = mapClusterLabel(cluster.pins);
      const marker = window.L.marker([cluster.lat, cluster.lon], {
        icon: clusterMarkerIcon(cluster, clusterLabel),
        title: `${cluster.pins.length} locations`
      })
        .on("click", () => zoomToCluster(cluster.pins));

      marker.addTo(state.markerLayer);
    });

    renderMapTraffic();

  }

  function renderMapTraffic() {
    if (!state.mapTrafficLayer || !window.L) {
      return;
    }
    state.mapTrafficLayer.clearLayers();

    state.data.pins
      .filter((pin) => pin.enabled)
      .forEach((pin) => {
        const families = uniqueFamiliesForPhotos(photosForPin(pin));
        families.forEach((family, index) => {
          window.L.marker([pin.lat, pin.lon], {
            icon: mapTrafficIcon(pin, family, index),
            interactive: false,
            keyboard: false,
            zIndexOffset: -120
          }).addTo(state.mapTrafficLayer);
        });
      });
  }

  function uniqueFamiliesForPhotos(photos) {
    const families = new Map();
    photos.forEach((photo) => {
      const family = aircraftFamilyForPhoto(photo);
      if (family && !families.has(family.id)) {
        families.set(family.id, family);
      }
    });
    return Array.from(families.values());
  }

  function mapTrafficIcon(pin, family, index) {
    const motion = trafficMotionFor(`${pin.id}-${family.id}-${index}`);
    const directionClass = motion.approaching ? " is-approaching" : " is-departing";
    return window.L.divIcon({
      className: "spotterdex-traffic-anchor",
      html: `
        <span
          class="map-traffic-aircraft${directionClass}"
          style="--traffic-start-x: ${motion.startX}px; --traffic-start-y: ${motion.startY}px; --traffic-end-x: ${motion.endX}px; --traffic-end-y: ${motion.endY}px; --traffic-heading: ${motion.heading}deg; --traffic-delay: -${motion.delay}ms; --traffic-duration: ${motion.duration}ms;"
          aria-hidden="true"
        >
          <img src="${escapeAttr(family.mapIcon || family.icon)}" alt="">
        </span>
      `,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  function trafficMotionFor(seedText) {
    const seed = stableHash(seedText);
    const departureHeading = seed % 360;
    const radians = ((departureHeading - 90) * Math.PI) / 180;
    const distance = 38 + (seed % 34);
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
      delay: seed % 12000,
      duration: 11000 + (seed % 7000)
    };
  }

  function stableHash(value) {
    return Array.from(String(value)).reduce((hash, character) => {
      return ((hash << 5) - hash + character.charCodeAt(0)) >>> 0;
    }, 2166136261);
  }

  function renderMapMissionHud() {
    if (!els.mapMissionHud) {
      return;
    }

    const locations = recentLocations();
    const newest = locations[0] || null;
    const oldest = locations[locations.length - 1] || null;
    const pin = state.pinById.get(state.selectedPinId);
    const coordinate = state.map
      ? `${state.map.getCenter().lat.toFixed(2)}° ${state.map.getCenter().lng.toFixed(2)}°`
      : "Atlas standby";
    const range = newest && oldest
      ? `${formatDisplayDate(oldest.latestDate)} — ${formatDisplayDate(newest.latestDate)}`
      : "No dated frames yet";

    els.mapMissionHud.innerHTML = `
      <span class="map-hud-kicker">Field atlas</span>
      <strong>${escapeHtml(pin ? pin.name : "Global coverage")}</strong>
      <span>${state.data.photos.length} frames · ${locations.length} photographed locations</span>
      <span class="map-hud-meta">${escapeHtml(range)}</span>
      <span class="map-hud-coordinate">${escapeHtml(coordinate)}</span>
    `;
  }

  function toggleMapRoute() {
    state.mapRouteVisible = !state.mapRouteVisible;
    renderMapRoute();
  }

  function renderMapRoute() {
    if (!els.mapRouteButton) {
      return;
    }

    els.mapRouteButton.setAttribute("aria-pressed", String(state.mapRouteVisible));
    els.mapRouteButton.setAttribute("aria-label", state.mapRouteVisible ? "Hide chronological route" : "Show chronological route");
    els.mapRouteButton.classList.toggle("is-active", state.mapRouteVisible);
    els.mapRouteButton.querySelector("span:last-child").textContent = state.mapRouteVisible
      ? "Hide route"
      : "Show route";

    if (!state.mapRouteLayer || !window.L) {
      return;
    }

    state.mapRouteLayer.clearLayers();
    if (!state.mapRouteVisible) {
      return;
    }

    const stops = recentLocations()
      .filter((location) => Number.isFinite(location.latestTime))
      .sort((a, b) => a.latestTime - b.latestTime);
    if (stops.length < 2) {
      return;
    }

    const points = stops.map((location) => [location.pin.lat, location.pin.lon]);
    window.L.polyline(points, {
      color: "#d8c59a",
      weight: 2.5,
      opacity: 0.86,
      dashArray: "9 10",
      lineCap: "round",
      className: "spotterdex-route-line"
    }).addTo(state.mapRouteLayer);

    stops.forEach((location, index) => {
      window.L.circleMarker([location.pin.lat, location.pin.lon], {
        radius: index === stops.length - 1 ? 6 : 4,
        color: "#f4ead2",
        weight: 1,
        fillColor: "#6f5832",
        fillOpacity: 0.92,
        className: "spotterdex-route-stop"
      })
        .bindTooltip(`${location.pin.name} · ${formatDisplayDate(location.latestDate)}`, { direction: "top", offset: [0, -6] })
        .addTo(state.mapRouteLayer);
    });
  }

  function clusterPins(pins) {
    const zoom = state.map ? state.map.getZoom() : NaN;
    if (!state.map || !Number.isFinite(zoom) || zoom >= 13) {
      return pins.map((pin) => ({
        pins: [pin],
        lat: pin.lat,
        lon: pin.lon,
        point: null
      }));
    }

    const threshold = zoom <= 4
      ? 92
      : zoom <= 6
        ? 76
        : zoom <= 8
          ? 60
          : zoom <= 10
            ? 46
            : 36;
    const clusters = [];
    pins.forEach((pin) => {
      const point = state.map.latLngToLayerPoint([pin.lat, pin.lon]);
      let match = null;
      for (const cluster of clusters) {
        if (point.distanceTo(cluster.point) <= threshold) {
          match = cluster;
          break;
        }
      }

      if (!match) {
        clusters.push({
          pins: [pin],
          lat: pin.lat,
          lon: pin.lon,
          point
        });
        return;
      }

      const nextCount = match.pins.length + 1;
      match.lat = (match.lat * match.pins.length + pin.lat) / nextCount;
      match.lon = (match.lon * match.pins.length + pin.lon) / nextCount;
      match.point = window.L.point(
        (match.point.x * match.pins.length + point.x) / nextCount,
        (match.point.y * match.pins.length + point.y) / nextCount
      );
      match.pins.push(pin);
    });

    return clusters;
  }

  function zoomToCluster(pins) {
    if (!state.map || !window.L || !pins.length) {
      return;
    }

    if (pins.length === 1) {
      selectPin(pins[0].id);
      return;
    }

    const bounds = window.L.latLngBounds(pins.map((pin) => [pin.lat, pin.lon]));
    state.map.fitBounds(bounds, {
      padding: [58, 58],
      maxZoom: 13,
      animate: true
    });
  }

  function renderMapResults() {
    const pin = state.pinById.get(state.selectedPinId);
    if (!pin) {
      els.mapResults.innerHTML = '<div class="empty-state">Add enabled pins to start browsing the map.</div>';
      return;
    }

    const photos = photosForPin(pin);
    const profile = locationProfile(pin, photos);
    const unitGroupLabel = photoUnitGroupLabel(photos);
    const typeCount = unique(photos.map((photo) => normalizeKey(photo.aircraftType))).length;
    const unitCount = unique(
      photos.map((photo) => {
        const squadron = squadronForPhoto(photo);
        const unitName = squadron ? squadron.name : photo.squadronName;
        const unitType = squadron ? squadron.unitType : photo.unitType;
        return normalizeKey(`${photo.country || ""}-${unitName || ""}-${unitType || ""}`);
      })
    ).length;
    const typeLabel = `${typeCount} ${typeCount === 1 ? "Type" : "Types"}`;
    const unitLabel = `${unitCount} ${unitGroupLabel}${unitCount === 1 ? "" : "s"}`;
    els.mapResults.innerHTML = `
      <div class="mission-dossier-heading">
        <div>
          <h2>Location Details</h2>
        </div>
        <button
          class="map-control-toggle"
          type="button"
          data-map-dossier-toggle
          aria-label="Hide location details"
          title="Hide location details"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      ${renderLocationDetail(profile)}

      <div class="location-photo-browser">
        <div class="segmented location-archive-toggle" aria-label="Organize map photos">
          ${segmentButton(typeLabel, "type", state.mapGroupMode, "data-map-group")}
          ${segmentButton(unitLabel, "squadron", state.mapGroupMode, "data-map-group")}
        </div>
      </div>
      ${renderPhotoGroups(photos, state.mapGroupMode, "map")}
    `;
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
      recentPhotos: photos
        .filter((photo) => (photo.thumbnail || photo.image) && (hero.custom || !heroPhoto || photo.id !== heroPhoto.id))
        .slice(0, 4)
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
      photo: photos.find((photo) => photo.image || photo.thumbnail) || null,
      asset: null,
      custom: false
    };
  }

  function renderLocationDetail(profile) {
    const { pin, heroPhoto, heroAsset, families, units, recentPhotos } = profile;
    const heroImage = heroPhoto
      ? heroPhoto.image || heroPhoto.thumbnail
      : heroAsset
        ? heroAsset.image || heroAsset.thumbnail
        : "";
    const heroStyle = heroImage ? "" : " is-empty";
    const heroTag = heroPhoto ? "button" : "div";
    const heroAttrs = heroPhoto
      ? `type="button" data-photo-id="${escapeAttr(heroPhoto.id)}" data-photo-context="map"`
      : "";

    return `
      <section class="location-detail-page" aria-label="${escapeAttr(pin.name)} location details">
        <${heroTag} class="location-hero${heroStyle}" ${heroAttrs}>
          ${
            heroImage
              ? `<img src="${escapeAttr(heroImage)}" alt="${escapeAttr(locationHeroAlt(pin, heroPhoto))}">`
              : '<span class="empty-cover">No location photo</span>'
          }
          <span class="location-hero-overlay">
            <span class="eyebrow">${escapeHtml(pin.country || "Location")}</span>
            <strong>${escapeHtml(pin.name)}</strong>
            <span>${escapeHtml(locationMetaLine(pin))}</span>
          </span>
        </${heroTag}>

        <div class="location-detail-grid">
          <section class="location-detail-block">
            <div class="compact-heading">
              <h3>Aircraft families</h3>
              <span class="count-pill">${families.length}</span>
            </div>
            ${renderLocationFamilies(families)}
          </section>

          <section class="location-detail-block">
            <div class="compact-heading">
              <h3>Units observed</h3>
              <span class="count-pill">${units.length}</span>
            </div>
            ${renderLocationUnits(units)}
          </section>
        </div>

        <section class="location-detail-block">
          <div class="compact-heading">
            <h3>Recent photos</h3>
            <span class="count-pill">${recentPhotos.length}</span>
          </div>
          ${renderLocationRecentPhotos(recentPhotos)}
        </section>
      </section>
    `;
  }

  function locationMetaLine(pin) {
    return [pin.icao ? `ICAO ${pin.icao}` : "", pin.country || ""]
      .filter(Boolean)
      .join(" - ");
  }

  function locationHeroAlt(pin, heroPhoto) {
    if (heroPhoto) {
      return `${heroPhoto.aircraftType} at ${pin.name}`;
    }
    return `${pin.name} location hero`;
  }

  function renderLocationFamilies(families) {
    if (!families.length) {
      return '<div class="empty-state compact">No aircraft families detected yet.</div>';
    }

    return `
      <div class="location-family-list">
        ${families
          .map(
            (family) => `
              <span class="location-family-chip" title="${escapeAttr(family.label)}" aria-label="${escapeAttr(family.label)}">
                <img src="${escapeAttr(family.icon)}" alt="">
              </span>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderLocationUnits(units) {
    if (!units.length) {
      return '<div class="empty-state compact">No squadrons or organisations linked yet.</div>';
    }

    return `
      <div class="location-unit-list">
        ${units
          .map(
            (unit) => {
              const tagName = unit.squadronId ? "button" : "span";
              const attrs = unit.squadronId
                ? `type="button" data-squadron-id="${escapeAttr(unit.squadronId)}"`
                : "";
              return `
              <${tagName} class="location-unit-chip" ${attrs} title="${escapeAttr(unit.name)}" aria-label="${escapeAttr(`${unit.name} ${unit.unitLabel}`)}">
                ${
                  unit.logo
                    ? `<img src="${escapeAttr(unit.logo)}" alt="${escapeAttr(unit.name)} logo">`
                    : `<span class="location-unit-fallback" aria-hidden="true">${escapeHtml(initials(unit.name))}</span>`
                }
              </${tagName}>
            `;
            }
          )
          .join("")}
      </div>
    `;
  }

  function renderLocationRecentPhotos(photos) {
    if (!photos.length) {
      return '<div class="empty-state compact">No recent photos found for this location.</div>';
    }

    return `
      <div class="location-recent-grid">
        ${photos
          .map((photo) => {
            const image = photo.thumbnail || photo.image || "";
            return `
              <button class="location-recent-card" type="button" data-photo-id="${escapeAttr(photo.id)}" data-photo-context="map">
                <img src="${escapeAttr(image)}" alt="${escapeAttr(photo.aircraftType)} at ${escapeAttr(photo.locationName)}">
                <span>
                  <strong>${escapeHtml(photo.aircraftType)}</strong>
                  <small>${escapeHtml(displayPhotoDate(photo))}</small>
                </span>
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function locationUnitPreviews(photos) {
    const byUnit = new Map();
    photos.forEach((photo) => {
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

    const photos = recentPhotos(RECENT_PHOTO_LIMIT);
    els.recentPhotosCount.textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"}`;

    if (!photos.length) {
      els.recentPhotosStrip.innerHTML = '<div class="empty-state compact">Add dated photos to populate recent frames.</div>';
      return;
    }

    els.recentPhotosStrip.innerHTML = photos
      .map((photo) => {
        const image = photo.thumbnail || photo.image || "";
        return `
          <button class="recent-photo-card" type="button" data-photo-id="${escapeAttr(photo.id)}" data-photo-context="recent">
            <img src="${escapeAttr(image)}" alt="${escapeAttr(photo.aircraftType)} at ${escapeAttr(photo.locationName)}">
            <span>
              <strong>${escapeHtml(photo.aircraftType)}</strong>
              <small>${escapeHtml(photo.locationName)} - ${escapeHtml(displayPhotoDate(photo))}</small>
            </span>
          </button>
        `;
      })
      .join("");
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
      <div class="stats-visual-grid stats-visual-grid-single">
        ${renderCountryDistribution(countryCounts)}
      </div>
    `;
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
    const focalCounts = countBy(exifPhotos, statsFocalLength);
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
        ${exifSummaryTile("Top focal", topFocal ? topFocal.label : "None", topFocal ? `${topFocal.count} frame${topFocal.count === 1 ? "" : "s"}` : "No EXIF")}
      </div>

      <div class="exif-dashboard-grid">
        ${renderExifCountList("Camera bodies", cameraCounts, "camera")}
        ${renderExifCountList("Lenses", lensCounts, "lens")}
        ${renderExifCountList("Focal lengths", focalCounts, "focal")}
        ${renderExifCountList("Shutter speeds", shutterCounts, "shutter")}
        ${renderExifCountList("Apertures", apertureCounts, "aperture")}
        ${renderExifCountList("ISO", isoCounts, "iso")}
      </div>
    `;
  }

  function renderSquadronsPage() {
    if (!els.squadronLogoGrid || !els.squadronPageCount || !els.squadronDetail) {
      return;
    }

    const allSquadrons = collectSquadrons();
    const squadrons = filterSquadrons(allSquadrons);
    const countLabel = `${squadrons.length} of ${allSquadrons.length} squadron${allSquadrons.length === 1 ? "" : "s"}`;
    els.squadronPageCount.textContent = countLabel;
    renderSquadronFilters(allSquadrons, squadrons);
    renderSquadronCountryRail(squadrons);

    if (!allSquadrons.length) {
      els.squadronLogoGrid.innerHTML = '<div class="empty-state compact">Add squadron entries to populate this page.</div>';
      els.squadronDetail.innerHTML = '<div class="empty-state">Squadron photos will appear here once entries are added.</div>';
      return;
    }

    if (!squadrons.length) {
      els.squadronLogoGrid.innerHTML = '<div class="empty-state compact">No squadrons match this wall filter.</div>';
      renderSquadronDetail([]);
      return;
    }

    els.squadronLogoGrid.innerHTML = renderSquadronCountrySections(squadrons);
    renderSquadronDetail(squadrons);
  }

  function filterSquadrons(squadrons) {
    return squadrons.filter((squadron) => {
      const photos = photosForSquadronRecord(squadron);
      return !state.squadronPhotographedOnly || photos.length > 0;
    });
  }

  function renderSquadronFilters(allSquadrons, filteredSquadrons) {
    if (!els.squadronFilters) {
      return;
    }
    els.squadronFilters.innerHTML = `
      <button
        class="squadron-photo-filter${state.squadronPhotographedOnly ? " is-active" : ""}"
        type="button"
        data-squadron-photographed-toggle
        aria-pressed="${state.squadronPhotographedOnly ? "true" : "false"}"
      >
        <span aria-hidden="true">◉</span>
        Photographed only
      </button>
      <span class="squadron-filter-count">${filteredSquadrons.length} shown</span>
    `;
  }

  function renderSquadronCountryRail(squadrons) {
    if (!els.squadronCountryRail) {
      return;
    }
    const groups = groupSquadronsByCountry(squadrons);
    els.squadronCountryRail.innerHTML = groups.length
      ? groups
          .map(
            (group) => `
              <button type="button" data-squadron-country-jump="${escapeAttr(squadronCountryId(group.country))}">
                <span>${escapeHtml(group.country)}</span>
                <span>${group.squadrons.length}</span>
              </button>
            `
          )
          .join("")
      : '<span class="muted">No countries</span>';
  }

  function renderSquadronCountrySections(squadrons) {
    return groupSquadronsByCountry(squadrons)
      .map(
        (group) => `
          <section class="squadron-country-section" id="${escapeAttr(squadronCountryId(group.country))}">
            <div class="group-header squadron-country-header">
              <div>
                <p class="eyebrow">Country</p>
                <h2>${escapeHtml(group.country)}</h2>
              </div>
              <span class="count-pill">${group.squadrons.length}</span>
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
    state.data.aircraft.forEach((entry) => {
      (entry.squadrons || []).forEach((squadron) => {
        if (!isSquadronUnit(squadron)) {
          return;
        }
        const key = normalizeKey(`${squadron.country || ""}-${squadron.name || ""}`);
        if (!byKey.has(key)) {
          byKey.set(key, {
            id: key,
            name: squadron.name || "Unknown squadron",
            country: squadron.country || "",
            logo: squadron.logo || "",
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
        record.aircraftTypes.push(entry.typeName);
        record.photoIds.push(...(squadron.photoIds || []));
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

  function renderSquadronLogoCard(squadron) {
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
      <button class="squadron-logo-card${activeClass}" type="button" data-squadron-id="${escapeAttr(squadron.id)}" title="${escapeAttr(squadron.name)}">
        <div class="squadron-logo-media${mediaClass}">
          ${heroImage ? `<img class="squadron-card-hero" src="${escapeAttr(heroImage)}" alt="${escapeAttr(squadron.name)} hero photo">` : ""}
          <span class="squadron-card-logo${heroImage ? "" : " is-standalone"}">
            ${logoContent}
          </span>
        </div>
        <div class="squadron-logo-body">
          <p class="eyebrow">${escapeHtml(squadron.country || "Country not set")}</p>
          <h2>${escapeHtml(squadron.name)}</h2>
          <p>${escapeHtml(typePreview || "No aircraft types linked yet")}${extraTypes ? ` + ${extraTypes} more` : ""}</p>
          <span>${squadron.photoIds.length} photo${squadron.photoIds.length === 1 ? "" : "s"} - ${squadron.aircraftTypes.length} type${squadron.aircraftTypes.length === 1 ? "" : "s"}</span>
        </div>
      </button>
    `;
  }

  function squadronCardHero(squadron) {
    const overrideId = state.squadronHeroOverrides.get(squadron.id);
    const override = overrideId ? state.photoById.get(overrideId) : null;
    if (override && (override.thumbnail || override.image)) {
      return override;
    }
    if (squadron.heroPhoto && (squadron.heroPhoto.thumbnail || squadron.heroPhoto.image)) {
      return squadron.heroPhoto;
    }
    return photosForSquadronRecord(squadron).find((photo) => photo.thumbnail || photo.image) || null;
  }

  function squadronCountryId(country) {
    return `squadron-country-${normalizeKey(country || "unknown")}`;
  }

  function renderSquadronDetail(squadrons = collectSquadrons()) {
    if (!els.squadronDetail) {
      return;
    }

    if (state.selectedSquadronId && !squadrons.some((squadron) => squadron.id === state.selectedSquadronId)) {
      state.selectedSquadronId = null;
    }

    const squadron = squadrons.find((item) => item.id === state.selectedSquadronId);
    if (!squadron) {
      els.squadronDetail.innerHTML = '<div class="empty-state">Select a squadron emblem to view its aircraft photos.</div>';
      return;
    }

    const photos = photosForSquadronRecord(squadron);
    const typePreview = squadron.aircraftTypes.join(", ");
    const hero = squadronCardHero(squadron);
    const heroImage = hero ? hero.image || hero.thumbnail || "" : "";
    const logo = squadron.logo
      ? `<img src="${escapeAttr(squadron.logo)}" alt="${escapeAttr(squadron.name)} logo">`
      : `<span class="squadron-logo-fallback">${escapeHtml(initials(squadron.name))}</span>`;
    els.squadronDetail.innerHTML = `
      ${
        heroImage
          ? `<div class="squadron-detail-hero">
              <img src="${escapeAttr(heroImage)}" alt="${escapeAttr(squadron.name)} hero photo">
              <span class="squadron-detail-logo" aria-hidden="true">${logo}</span>
            </div>`
          : ""
      }
      <div class="result-header">
        <div>
          <p class="eyebrow">${escapeHtml(squadron.country || "Squadron")}</p>
          <h2>${escapeHtml(squadron.name)}</h2>
          <p class="muted">${photos.length} viewable photo${photos.length === 1 ? "" : "s"} across ${squadron.aircraftTypes.length} aircraft type${squadron.aircraftTypes.length === 1 ? "" : "s"}</p>
        </div>
      </div>
      ${typePreview ? `<p class="muted squadron-type-list">${escapeHtml(typePreview)}</p>` : ""}
      ${renderSquadronHeroPicker(squadron, photos)}
      ${renderSquadronPhotoGrid(photos)}
    `;
  }

  function renderSquadronHeroPicker(squadron, photos) {
    if (!photos.length) {
      return "";
    }
    const overrideId = state.squadronHeroOverrides.get(squadron.id) || "";
    return `
      <div class="squadron-hero-picker">
        <label for="squadronHero-${escapeAttr(squadron.id)}">Card hero</label>
        <select id="squadronHero-${escapeAttr(squadron.id)}" data-squadron-hero-picker="${escapeAttr(squadron.id)}">
          <option value="">Use source/default hero</option>
          ${photos
            .map(
              (photo) => `
                <option value="${escapeAttr(photo.id)}"${photo.id === overrideId ? " selected" : ""}>
                  ${escapeHtml(`${photo.aircraftType} — ${displayPhotoDate(photo)}`)}
                </option>
              `
            )
            .join("")}
        </select>
        ${
          overrideId
            ? `<button type="button" data-squadron-hero-reset="${escapeAttr(squadron.id)}">Reset</button>`
            : ""
        }
      </div>
    `;
  }

  function renderSquadronPhotoGrid(photos) {
    if (!photos.length) {
      return '<div class="empty-state">No viewable photos found for this squadron yet.</div>';
    }

    return `
      <div class="photo-grid photo-grid-squadron">
        ${photos.map((photo) => renderPhotoCard(photo, "squadron")).join("")}
      </div>
    `;
  }

  function exifSummaryTile(label, value, detail) {
    return `
      <div>
        <strong>${escapeHtml(value)}</strong>
        <span>${escapeHtml(label)}</span>
        <small>${escapeHtml(detail)}</small>
      </div>
    `;
  }

  function renderExifCountList(title, counts, filterKind) {
    const icon = statsIcon(exifIconForTitle(title));
    const items = topCounts(counts, 5);
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
    const query = normalizeText(els.aircraftSearch.value);
    const entries = state.data.aircraft.filter((entry) => {
      if (!query) {
        return true;
      }
      const squadronText = entry.squadrons.map((squadron) => `${squadron.name} ${squadron.unitLabel}`).join(" ");
      return normalizeText(`${entry.typeName} ${entry.countries.join(" ")} ${squadronText}`).includes(query);
    });

    if (state.selectedAircraftId && !entries.some((entry) => entry.id === state.selectedAircraftId)) {
      state.selectedAircraftId = null;
    }

    els.dexCount.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
    renderAircraftGrid(entries);
    renderDexDetail();
  }

  function renderAircraftGrid(entries) {
    if (!entries.length) {
      els.aircraftGrid.innerHTML = '<div class="empty-state">No aircraft entries match this search.</div>';
      return;
    }

    els.aircraftGrid.innerHTML = entries
      .map((entry) => {
        const cover = state.photoById.get(entry.coverPhoto);
        const stats = aircraftStats(entry);
        const countries = unique(entry.countries).slice(0, 3);
        const activeClass = entry.id === state.selectedAircraftId ? " is-active" : "";
        const coverImage = cover ? cover.thumbnail || cover.image : "";
        const unitCount = stats.unitCount;
        const unitLabel = entryUnitNoun(entry, unitCount);

        return `
          <button class="aircraft-card${activeClass}" type="button" data-aircraft-id="${escapeAttr(entry.id)}">
            <div class="aircraft-cover">
              ${
                coverImage
                  ? `<img src="${escapeAttr(coverImage)}" alt="${escapeAttr(entry.typeName)}">`
                  : '<div class="empty-cover">No photo</div>'
              }
            </div>
            <div class="aircraft-body">
              <strong class="aircraft-title">${escapeHtml(entry.typeName)}</strong>
              <span>${unitCount} ${unitLabel} - ${stats.photoCount} photo${stats.photoCount === 1 ? "" : "s"}</span>
              <span class="aircraft-stat-row">
                <span><strong>${stats.locationCount}</strong> Locations</span>
                <span><strong>${escapeHtml(stats.latestDate ? formatDisplayDate(stats.latestDate) : "None")}</strong> Latest</span>
              </span>
              <span class="badge-row">
                ${countries.map((country) => `<span class="badge">${escapeHtml(country)}</span>`).join("")}
              </span>
            </div>
          </button>
        `;
      })
      .join("");
  }

  function renderDexDetail() {
    const entry = state.aircraftById.get(state.selectedAircraftId);
    if (!entry) {
      els.dexDetail.innerHTML = '<div class="empty-state">Select an aircraft entry to expand its photos.</div>';
      return;
    }

    const photos = photosForAircraft(entry);
    const stats = aircraftStats(entry);
    const unitCount = stats.unitCount;
    const unitLabel = entryUnitNoun(entry, unitCount);
    const unitGroupLabel = photos.length ? photoUnitGroupLabel(photos) : entryUnitNoun(entry, 1, true);
    els.dexDetail.innerHTML = `
      <div class="result-header">
        <div>
          <p class="eyebrow">Selected entry</p>
          <h2>${escapeHtml(entry.typeName)}</h2>
          <p class="muted">${stats.photoCount} photo${stats.photoCount === 1 ? "" : "s"} across ${unitCount} ${unitLabel}</p>
        </div>
        <div class="segmented" aria-label="Organize aircraft photos">
          ${segmentButton(unitGroupLabel, "squadron", state.dexGroupMode, "data-dex-group")}
          ${segmentButton("Location", "location", state.dexGroupMode, "data-dex-group")}
        </div>
      </div>

      <div class="entry-stat-grid" aria-label="Aircraft statistics">
        ${statTile("Photos", stats.photoCount)}
        ${statTile(entryUnitNoun(entry, 2, true), unitCount)}
        ${statTile("Locations", stats.locationCount)}
        ${statTile("Latest", stats.latestDate ? formatDisplayDate(stats.latestDate) : "No photos")}
      </div>

      <div class="squadron-grid">
        ${entry.squadrons.map(renderSquadronRow).join("")}
      </div>

      ${renderPhotoGroups(photos, state.dexGroupMode, "dex")}
    `;
  }

  function renderSquadronRow(squadron) {
    const logoContent = squadron.logo
      ? `<img class="squadron-logo" src="${escapeAttr(squadron.logo)}" alt="${escapeAttr(squadron.name)} logo">`
      : `<span class="logo-fallback" aria-hidden="true">${escapeHtml(initials(squadron.name))}</span>`;
    const photoCount = Number(squadron.photoCount || 0);
    const unitLabel = squadron.unitLabel || unitDisplayLabel(squadron.unitType);
    const squadronId = squadronPageIdForUnit(squadron);
    const logo = squadronId
      ? `<button class="squadron-logo-link" type="button" data-squadron-id="${escapeAttr(squadronId)}" aria-label="Open ${escapeAttr(squadron.name)} on the Squadrons page">${logoContent}</button>`
      : logoContent;

    return `
      <div class="squadron-row">
        ${logo}
        <span>
          <strong>${escapeHtml(squadron.name)}</strong>
          <span>${escapeHtml(unitLabel)} - ${escapeHtml(squadron.country || "Country not set")} - ${photoCount} photo${photoCount === 1 ? "" : "s"}</span>
        </span>
      </div>
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
            (group) => `
              <section>
                <div class="group-header">
                  <h3>${escapeHtml(group.name)}</h3>
                  <span class="count-pill">${group.photos.length}</span>
                </div>
                <div class="photo-grid">
                  ${group.photos.map((photo) => renderPhotoCard(photo, context)).join("")}
                </div>
              </section>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderPhotoCard(photo, context) {
    const image = photo.thumbnail || photo.image || "";
    return `
      <button class="photo-card" type="button" data-photo-id="${escapeAttr(photo.id)}" data-photo-context="${escapeAttr(context)}">
        <img src="${escapeAttr(image)}" alt="${escapeAttr(photo.aircraftType)} at ${escapeAttr(photo.locationName)}">
        <span class="photo-body">
          <strong>${escapeHtml(photo.aircraftType)}</strong>
          <span>${escapeHtml(photo.squadronName)} - ${escapeHtml(displayPhotoDate(photo))}</span>
        </span>
      </button>
    `;
  }

  function segmentButton(label, value, activeValue, dataName) {
    const activeClass = value === activeValue ? " is-active" : "";
    return `<button class="segment-button${activeClass}" type="button" ${dataName}="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
  }

  function selectPin(pinId, options = {}) {
    state.selectedPinId = pinId;
    renderLocations();
    renderPins();
    renderMapResults();
    renderMapMissionHud();

    if (options.updateHash !== false) {
      updateDeepLink("location", pinId);
    }

    if (options.pan !== false) {
      focusMapPin(pinId);
    }

    if (isMobileMapLayout() && options.openPanel !== false) {
      setMapPanel("results");
    } else if (!isMobileMapLayout() && options.openDossier !== false) {
      setMapDossierOpen(true);
    }
  }

  function selectAircraft(aircraftId, options = {}) {
    state.selectedAircraftId = aircraftId;
    renderDex();
    if (options.updateHash !== false) {
      updateDeepLink("aircraft", aircraftId);
    }
    if (options.scroll !== false) {
      els.dexDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function selectSquadron(squadronId, options = {}) {
    state.selectedSquadronId = squadronId;
    setActiveTab("squadronsView", { updateHash: false });
    renderSquadronsPage();
    if (options.updateHash !== false) {
      updateDeepLink("squadron", squadronId);
    }
    if (els.squadronDetail && options.scroll !== false) {
      els.squadronDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function selectStatsSection(section, options = {}) {
    const statsSection = normalizeStatsSection(section);
    setActiveTab("statsView", { updateHash: false });

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

  function photosForPin(pin) {
    const pinKey = normalizeKey(pin.name);
    return state.data.photos
      .filter((photo) => photo.pinId === pin.id || normalizeKey(photo.locationName) === pinKey)
      .sort(sortPhotos);
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
    const preview = mapLocationPreview([pin]);
    return window.L.divIcon({
      className: `spotterdex-marker-shell${isActive ? " is-active" : ""}`,
      html: `
        <span class="spotterdex-marker-dot">${escapeHtml(countryFlag(pin.country))}</span>
        ${renderMapMarkerLabel(mapPinLabel(pin), preview)}
      `,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  function mapPinLabel(pin) {
    return pin.name;
  }

  function mapClusterLabel(pins) {
    const names = unique(pins.map((pin) => pin.name));
    const fullLabel = names.join(" / ");
    if (names.length <= 3 && fullLabel.length <= 44) {
      return fullLabel;
    }

    const codes = unique(pins.map((pin) => pin.icao || pin.name));
    if (codes.length <= 4) {
      return codes.join(" / ");
    }
    return `${codes.slice(0, 3).join(" / ")} / +${codes.length - 3}`;
  }

  function clusterMarkerIcon(cluster, clusterLabel) {
    const flags = unique(cluster.pins.map((pin) => countryFlag(pin.country))).slice(0, 3).join("");
    const preview = mapLocationPreview(cluster.pins);
    return window.L.divIcon({
      className: "spotterdex-marker-shell spotterdex-cluster-shell",
      html: `
        <span class="spotterdex-marker-dot cluster-dot">
          <span class="cluster-count">${cluster.pins.length}</span>
          <span class="cluster-flags">${escapeHtml(flags)}</span>
        </span>
        ${renderMapMarkerLabel(clusterLabel, preview)}
      `,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
  }

  function renderMapMarkerLabel(title, preview) {
    const assets = [
      preview.families.length ? renderMapMarkerFamilies(preview.families) : "",
      preview.families.length && preview.logos.length ? '<span class="map-marker-divider" aria-hidden="true">|</span>' : "",
      preview.logos.length ? renderMapMarkerLogos(preview.logos) : ""
    ]
      .filter(Boolean)
      .join("");
    return `
      <span class="spotterdex-marker-label">
        <span class="spotterdex-marker-title">${escapeHtml(title)}</span>
        ${assets ? `<span class="map-marker-assets">${assets}</span>` : ""}
      </span>
    `;
  }

  function renderMapMarkerLogos(logos) {
    if (!logos.length) {
      return "";
    }

    return `
      <span class="map-logo-row" aria-label="Units photographed here">
        ${logos
          .map((logo) => `<img src="${escapeAttr(logo.src)}" alt="${escapeAttr(logo.alt)}">`)
          .join("")}
      </span>
    `;
  }

  function renderMapMarkerFamilies(families) {
    if (!families.length) {
      return "";
    }

    return `
      <span class="map-family-row" aria-label="Aircraft families photographed here">
        ${families
          .map(
            (family) => `
              <img
                class="map-family-icon"
                src="${escapeAttr(family.icon)}"
                alt="${escapeAttr(family.label)}"
                title="${escapeAttr(family.label)}"
              >
            `
          )
          .join("")}
      </span>
    `;
  }

  function mapLocationPreview(pins) {
    const photos = pins.flatMap((pin) => photosForPin(pin));
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

    return {
      logos: logos.slice(0, 4),
      families: Array.from(familyById.values()).slice(0, 3)
    };
  }

  function aircraftFamilyForPhoto(photo) {
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
  const variant = resolvedTheme() === "dark" ? "light" : "dark";
  const extension = id === "helicopter" ? "gif" : "png";
  const stem = id === "helicopter" ? "aircraft-family-helicopter-top" : `aircraft-family-${id}`;
  return {
    id,
    label,
    icon: `assets/icons/aircraft-family-${id}.png`,
    mapIcon: `assets/icons/${stem}-${variant}.${extension}`
  };
}

  function focusMapPin(pinId) {
    if (!state.map) {
      return;
    }

    const pin = state.pinById.get(pinId);
    if (!pin) {
      return;
    }

    state.map.flyTo([pin.lat, pin.lon], Math.max(state.map.getZoom(), 11), {
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
        name = photo.squadronName || unknownUnitName(photo.unitType);
      } else if (mode === "location") {
        name = photo.locationName || "Unknown location";
      } else {
        name = photo.aircraftType || "Unknown aircraft";
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
    return `${a.aircraftType} ${a.locationName}`.localeCompare(`${b.aircraftType} ${b.locationName}`);
  }

  function fitMapToPins() {
    if (!state.map || !window.L) {
      return;
    }

    state.map.invalidateSize({ pan: false });
    const pins = state.data.pins.filter((pin) => pin.enabled);
    if (!pins.length) {
      state.map.setView([20, 0], 2);
      refreshMapLayout();
      return;
    }

    const bounds = window.L.latLngBounds(pins.map((pin) => [pin.lat, pin.lon]));
    state.map.fitBounds(bounds, {
      ...mapFitPadding(),
      maxZoom: 9,
      animate: true
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
    if (!panel) {
      return { left: 0, right: 0 };
    }

    const style = window.getComputedStyle(panel);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return { left: 0, right: 0 };
    }

    const rect = panel.getBoundingClientRect();
    const verticalOverlap = Math.max(0, Math.min(rect.bottom, mapRect.bottom) - Math.max(rect.top, mapRect.top));
    const horizontalOverlap = Math.max(0, Math.min(rect.right, mapRect.right) - Math.max(rect.left, mapRect.left));
    if (!verticalOverlap || !horizontalOverlap) {
      return { left: 0, right: 0 };
    }

    const panelCenter = rect.left + rect.width / 2;
    const mapCenter = mapRect.left + mapRect.width / 2;
    if (panelCenter < mapCenter) {
      return { left: Math.max(0, Math.min(rect.right, mapRect.right) - mapRect.left), right: 0 };
    }
    return { left: 0, right: Math.max(0, mapRect.right - Math.max(rect.left, mapRect.left)) };
  }

  function openViewer(photoId, context, options = {}) {
    const photo = state.photoById.get(photoId);
    if (!photo) {
      return;
    }

    const viewerContext = context || "map";
    const collection = viewerContext === "dex"
      ? currentDexPhotoIds()
      : viewerContext === "recent"
        ? currentRecentPhotoIds()
        : viewerContext === "stats"
          ? state.statsPhotoIds
        : viewerContext === "squadron"
          ? currentSquadronPhotoIds()
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
    setViewerCleanMode(false);
    resetViewerTransform();

    els.photoViewer.hidden = false;
    document.body.style.overflow = "hidden";
    updateViewerInfoState();
    renderViewerPhoto();

    if (options.updateHash !== false) {
      updateDeepLink("photo", photoId);
    }
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
    if (kind === "shutter") {
      return String(exif.ExposureTime || "") === value;
    }
    if (kind === "aperture") {
      return String(exif.FNumber || "") === value;
    }
    if (kind === "iso") {
      return String(exif.ISO || "") === value;
    }
    return false;
  }

  function closeViewer(options = {}) {
    els.photoViewer.hidden = true;
    document.body.style.overflow = "";
    setViewerInfoOpen(false);
    setViewerCleanMode(false);
    resetViewerTransform();

    if (options.updateHash !== false) {
      updateDeepLinkForViewerContext();
    }
  }

  function stepPhoto(offset) {
    if (!state.activePhotoIds.length) {
      return;
    }
    state.activePhotoIndex = (state.activePhotoIndex + offset + state.activePhotoIds.length) % state.activePhotoIds.length;
    resetViewerTransform();
    renderViewerPhoto();
    updateDeepLink("photo", state.activePhotoIds[state.activePhotoIndex]);
  }

  function selectViewerPhoto(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.activePhotoIds.length) {
      return;
    }
    state.activePhotoIndex = index;
    resetViewerTransform();
    renderViewerPhoto();
    updateDeepLink("photo", state.activePhotoIds[state.activePhotoIndex]);
  }

  function renderViewerPhoto() {
    const photoId = state.activePhotoIds[state.activePhotoIndex];
    const photo = state.photoById.get(photoId);
    if (!photo) {
      closeViewer();
      return;
    }

    els.viewerImage.src = photo.image || "";
    els.viewerImage.alt = `${photo.aircraftType} photographed at ${photo.locationName}`;
    els.viewerKicker.textContent = state.activePhotoContext === "stats" && state.statsPhotoLabel
      ? `${state.statsPhotoLabel} · ${state.activePhotoIndex + 1} of ${state.activePhotoIds.length}`
      : `${state.activePhotoIndex + 1} of ${state.activePhotoIds.length}`;
    els.viewerTitle.textContent = photo.title || photo.aircraftType;
    els.viewerCaption.textContent = [
      photo.caption,
      `${photo.squadronName} at ${photo.locationName}${photo.year ? `, ${photo.year}` : ""}`
    ]
      .filter(Boolean)
      .join(" ");
    els.viewerMetadata.innerHTML = metadataSections(photo)
      .map(renderMetadataSection)
      .join("");
    renderViewerTelemetry(photo);
    renderViewerFilmstrip();
    updateViewerInfoState();
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

  function setViewerCleanMode(isClean) {
    state.viewerCleanMode = Boolean(isClean);
    if (!els.photoViewer || !els.viewerCleanButton) {
      return;
    }
    els.photoViewer.classList.toggle("is-clean", state.viewerCleanMode);
    els.viewerCleanButton.setAttribute("aria-pressed", String(state.viewerCleanMode));
    els.viewerCleanButton.textContent = state.viewerCleanMode ? "Exit clean" : "Clean";
  }

  function updateViewerTransform() {
    if (!els.viewerImage) {
      return;
    }
    const zoom = state.viewerZoom || 1;
    els.viewerImage.style.transform = `translate3d(${state.viewerPanX}px, ${state.viewerPanY}px, 0) scale(${zoom})`;
    els.viewerImage.classList.toggle("is-zoomed", zoom > 1);
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
    if (els.photoViewer.hidden) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY < 0 ? 0.18 : -0.18;
    setViewerZoom(state.viewerZoom + direction);
  }

  function handleViewerPointerDown(event) {
    if (els.photoViewer.hidden) {
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
    } else if (state.viewerPointers.size === 2) {
      const [first, second] = Array.from(state.viewerPointers.values());
      state.viewerPinchStart = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        zoom: state.viewerZoom
      };
      state.viewerDragOrigin = null;
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
                ? `<img src="${escapeAttr(image)}" alt="">`
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

    if (state.activePhotoContext === "dex" && state.selectedAircraftId) {
      updateDeepLink("aircraft", state.selectedAircraftId);
    } else if (state.activePhotoContext === "squadron" && state.selectedSquadronId) {
      updateDeepLink("squadron", state.selectedSquadronId);
    } else if (photo) {
      const pinId = photo.pinId || pinIdFromLocation(photo.locationName);
      if (pinId) {
        updateDeepLink("location", pinId);
      }
    } else if (state.selectedPinId) {
      updateDeepLink("location", state.selectedPinId);
    }
  }

  function setViewerInfoOpen(isOpen) {
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
    els.viewerInfoButton.classList.toggle("is-active", isOpen);
    els.viewerInfoButton.setAttribute("aria-expanded", String(isOpen));
    els.viewerInfoButton.setAttribute("aria-label", isOpen ? "Hide photo info" : "Show photo info");
    els.viewerInfo.setAttribute("aria-hidden", String(isMobile && !isOpen));
  }

  function metadataSections(photo) {
    const exif = photo.exif || {};
    const camera = [exif.Make, exif.Model].filter(Boolean).join(" ");
    const squadron = squadronForPhoto(photo);
    const squadronLogo = squadron && squadron.logo ? renderViewerSquadronLogo(squadron) : "";
    const cameraRows = [
      ["Camera", camera],
      ["Lens model", exif.LensModel || exif.Lens],
      ["Focal length", exif.FocalLength],
      ["Aperture", exif.FNumber],
      ["Shutter speed", exif.ExposureTime],
      ["ISO", exif.ISO]
    ].filter((row) => row[1]);

    return [
      {
        title: "Frame",
        rows: [
          ["Aircraft", photo.aircraftType],
          [photo.unitLabel || unitDisplayLabel(photo.unitType), photo.squadronName, squadronLogo],
          ["Country", photo.country],
          ["Location", photo.locationName],
          ["Date", exif.DateTimeOriginal ? displayPhotoDate(photo) : photo.year]
        ].filter((row) => row[1])
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
    if (!entry || !Array.isArray(entry.squadrons)) {
      return null;
    }

    return (
      entry.squadrons.find((squadron) => squadron.id === photo.squadronId) ||
      entry.squadrons.find((squadron) => normalizeKey(squadron.name) === normalizeKey(photo.squadronName)) ||
      null
    );
  }

  function squadronPageIdForUnit(squadron) {
    if (!squadron || !isSquadronUnit(squadron)) {
      return "";
    }
    return normalizeKey(`${squadron.country || ""}-${squadron.name || ""}`);
  }

  function squadronPageIdForPhoto(photo) {
    const squadron = squadronForPhoto(photo);
    if (squadron) {
      return squadronPageIdForUnit(squadron);
    }
    if (normalizeUnitType(photo.unitType) !== "squadron") {
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

  function statsFocalLength(photo) {
    const exif = photo.exif || {};
    const raw = exif.FocalLength;
    if (!raw) {
      return "";
    }

    const focalMm = parseFocalLengthMm(raw);
    if (focalMm === null) {
      return String(raw).trim();
    }

    if (isSonyRx10M4(exif)) {
      return `${Math.round(focalMm * RX10M4_FOCAL_LENGTH_MULTIPLIER)}mm`;
    }

    return String(raw).trim();
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
    const photoId = params.get("photo");
    const squadronId = params.get("squadron");
    const locationId = params.get("location");
    const aircraftId = params.get("aircraft");
    const statsSection = params.get("stats");

    state.isApplyingHash = true;
    try {
      if (photoId) {
        const photo = findPhoto(photoId);
        if (photo) {
          openPhotoDeepLink(photo, options);
          return;
        }
      }

      if (squadronId) {
        const squadron = findSquadron(squadronId);
        if (squadron) {
          selectSquadron(squadron.id, { updateHash: false });
          return;
        }
      }

      if (locationId) {
        const pin = findPin(locationId);
        if (pin) {
          setActiveTab("mapView", { updateHash: false });
          selectPin(pin.id, { updateHash: false, pan: !options.initial });
          if (options.initial) {
            focusMapPin(pin.id);
          }
          return;
        }
      }

      if (aircraftId) {
        const entry = findAircraft(aircraftId);
        if (entry) {
          setActiveTab("dexView", { updateHash: false });
          selectAircraft(entry.id, { updateHash: false, scroll: !options.initial });
          return;
        }
      }

      if (statsSection) {
        selectStatsSection(statsSection, { updateHash: false, initial: options.initial });
      }
    } finally {
      state.isApplyingHash = false;
    }
  }

  function openPhotoDeepLink(photo, options = {}) {
    const pinId = photo.pinId || pinIdFromLocation(photo.locationName);
    if (pinId && state.pinById.has(pinId)) {
      setActiveTab("mapView", { updateHash: false });
      selectPin(pinId, { updateHash: false, pan: !options.initial });
      if (options.initial) {
        focusMapPin(pinId);
      }
      openViewer(photo.id, "map", { updateHash: false });
      return;
    }

    if (photo.aircraftId && state.aircraftById.has(photo.aircraftId)) {
      setActiveTab("dexView", { updateHash: false });
      selectAircraft(photo.aircraftId, { updateHash: false, scroll: false });
      openViewer(photo.id, "dex", { updateHash: false });
      return;
    }

    openViewer(photo.id, "photo", { updateHash: false });
  }

  function updateDeepLink(kind, id) {
    if (state.isApplyingHash || !id) {
      return;
    }
    const nextHash = `#${kind}=${encodeURIComponent(id)}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
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

  function normalizeIcao(value) {
    const code = String(value || "").trim().toUpperCase();
    return /^[A-Z0-9]{4}$/.test(code) ? code : "";
  }

  function normalizeUnitType(value) {
    const key = normalizeKey(value || "squadron");
    return ["organisation", "organization", "org"].includes(key) ? "organisation" : "squadron";
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
    const unitTypes = unique(photos.map((photo) => normalizeUnitType(photo.unitType)));
    if (unitTypes.length === 1) {
      return unitNoun(unitTypes[0], 1, true);
    }
    return "Unit";
  }

  function countryFlag(country) {
    const codes = {
      "hong kong": "HK",
      japan: "JP",
      malaysia: "MY",
      singapore: "SG",
      thailand: "TH",
      "united kingdom": "GB",
      "united states": "US"
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

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
