(function () {
  const EMPTY_DATA = { generatedAt: null, pins: [], aircraft: [], squadrons: [], airshows: [], photos: [] };
  const EMPTY_PHOTOS = Object.freeze([]);
  const RECENT_PHOTO_LIMIT = 8;
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
  const FOCAL_DISTRIBUTION_MINIMUM = 50;
  const FOCAL_DISTRIBUTION_MAXIMUM = 850;
  const FOCAL_DISTRIBUTION_BIN_WIDTH = 50;
  const AIRCRAFT_FAMILY_DEFINITIONS = [
    { id: "fighter", label: "Fighter" },
    { id: "helicopter", label: "Helicopter" },
    { id: "light", label: "Light" },
    { id: "medium", label: "Medium" },
    { id: "heavy", label: "Heavy" }
  ];
  const AIRCRAFT_FAMILY_LABELS = new Map(AIRCRAFT_FAMILY_DEFINITIONS.map((family) => [family.id, family.label]));

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
    recentPhotoLimit: RECENT_PHOTO_LIMIT,
    recentPhotoResizeObserver: null,
    map: null,
    markerLayer: null,
    mapLeaderLayer: null,
    mapLabelLayer: null,
    mapTrafficLayer: null,
    mapTrafficInitialized: false,
    mapPreviewCache: new Map(),
    mapDossierOpen: true,
    markersByPinId: new Map(),
    mapCalloutLayouts: [],
    activeMapMarkerId: null,
    mapZoomInProgress: false,
    mapResizeObserver: null,
    mapRefreshHandle: null,
    mapRefreshTimer: null,
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
    viewerRenderToken: 0,
    viewerRevealToken: 0,
    viewerPointers: new Map(),
    viewerDragOrigin: null,
    viewerPinchStart: null,
    viewerHistoryPushed: false,
    viewerReturnFocus: null,
    mobileMapPanel: null,
    mapControlPanelOpen: true,
    renderedViews: new Set(),
    lastHandledHistoryUrl: "",
    isApplyingHash: false
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    setupEvents();

    state.data = prepareData(await loadData());
    chooseInitialSelections();
    renderAll();
    const routed = applyDeepLinkFromHash({ initial: true });
    if (!routed) {
      setActiveTab("mapView", { updateHash: false });
    }
    updateShareMetadata();
  }

  function cacheElements() {
    els.siteHeader = document.querySelector(".site-header");
    els.main = document.getElementById("main");
    els.brand = document.querySelector(".brand");
    els.metaDescription = document.querySelector('meta[name="description"]');
    els.ogTitle = document.querySelector('meta[property="og:title"]');
    els.ogDescription = document.querySelector('meta[property="og:description"]');
    els.ogImage = document.querySelector('meta[property="og:image"]');
    els.ogUrl = document.querySelector('meta[property="og:url"]');
    els.twitterTitle = document.querySelector('meta[name="twitter:title"]');
    els.twitterDescription = document.querySelector('meta[name="twitter:description"]');
    els.twitterImage = document.querySelector('meta[name="twitter:image"]');
    els.canonical = document.querySelector('link[rel="canonical"]');
    els.viewSelect = document.getElementById("viewSelect");
    els.aircraftCount = document.getElementById("aircraftCount");
    els.photoCount = document.getElementById("photoCount");
    els.locationCount = document.getElementById("locationCount");
    els.locationSearch = document.getElementById("locationSearch");
    els.aircraftSearch = document.getElementById("aircraftSearch");
    els.dexFamilyFilter = document.getElementById("dexFamilyFilter");
    els.locationList = document.getElementById("locationList");
    els.mapWorkspace = document.querySelector("#mapView .map-workspace");
    els.mapControlPanel = document.getElementById("mapControlPanel");
    els.mapPanelToggles = document.querySelectorAll("[data-map-panel-toggle]");
    els.worldMap = document.getElementById("worldMap");
    els.mapFallback = document.getElementById("mapFallback");
    els.mapResults = document.getElementById("mapResults");
    els.recentPhotosStrip = document.getElementById("recentPhotosStrip");
    els.recentPhotosCount = document.getElementById("recentPhotosCount");
    els.dexHeroMedia = document.getElementById("dexHeroMedia");
    els.dexHeroFeature = document.getElementById("dexHeroFeature");
    els.dexHeroAction = document.getElementById("dexHeroAction");
    els.dexHeroAircraftCount = document.getElementById("dexHeroAircraftCount");
    els.dexHeroPhotoCount = document.getElementById("dexHeroPhotoCount");
    els.dexHeroCountryCount = document.getElementById("dexHeroCountryCount");
    els.aircraftGrid = document.getElementById("aircraftGrid");
    els.aircraftDetail = document.getElementById("aircraftDetail");
    els.dexCount = document.getElementById("dexCount");
    els.statsHeroMedia = document.getElementById("statsHeroMedia");
    els.statsHeroPhotoCount = document.getElementById("statsHeroPhotoCount");
    els.statsHeroAircraftCount = document.getElementById("statsHeroAircraftCount");
    els.statsHeroLocationCount = document.getElementById("statsHeroLocationCount");
    els.statsDashboard = document.getElementById("statsDashboard");
    els.exifDashboard = document.getElementById("exifDashboard");
    els.squadronLogoGrid = document.getElementById("squadronLogoGrid");
    els.squadronCountryRail = document.getElementById("squadronCountryRail");
    els.squadronHeroMedia = document.getElementById("squadronHeroMedia");
    els.squadronHeroCountryCount = document.getElementById("squadronHeroCountryCount");
    els.squadronHeroPhotoCount = document.getElementById("squadronHeroPhotoCount");
    els.squadronDetail = document.getElementById("squadronDetail");
    els.locationDetail = document.getElementById("locationDetail");
    els.squadronPageCount = document.getElementById("squadronPageCount");
    els.airshowTimeline = document.getElementById("airshowTimeline");
    els.airshowPageCount = document.getElementById("airshowPageCount");
    els.airshowHeroMedia = document.getElementById("airshowHeroMedia");
    els.airshowHeroPhotoCount = document.getElementById("airshowHeroPhotoCount");
    els.airshowHeroLocationCount = document.getElementById("airshowHeroLocationCount");
    els.airshowYearRange = document.getElementById("airshowYearRange");
    els.airshowDetail = document.getElementById("airshowDetail");
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
    els.viewerShareButton = document.getElementById("viewerShareButton");
    els.viewerFullscreenButton = document.getElementById("viewerFullscreenButton");
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
      squadrons: Array.isArray(rawData.squadrons) ? rawData.squadrons : [],
      airshows: Array.isArray(rawData.airshows) ? rawData.airshows : [],
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
      const tagScope = normalizePhotoScope(photo.tagScope || photo.tag_scope);
      const unitType = tagScope === "location" ? "" : normalizeUnitType(photo.unitType || photo.unit_type || photo.squadronType);
      return {
        ...photo,
        id: String(photo.id || `photo-${index + 1}`),
        tagScope,
        year: photo.year ? String(photo.year) : "",
        date: photo.date ? String(photo.date) : "",
        sortDate: photo.sortDate ? String(photo.sortDate) : deriveSortDate(photo),
        locationName: photo.locationName || photo.location || "Unknown location",
        airshow: photo.airshow || photo.airshowName || photo.airshow_name || "",
        livery: photo.livery || photo.paintScheme || photo.paint_scheme || "",
        aircraftType: photo.aircraftType || defaultPhotoSubject(tagScope),
        squadronName: photo.squadronName || photo.unitName || (tagScope === "location" ? "" : unknownUnitName(unitType)),
        unitType,
        unitLabel: tagScope === "location" ? "" : photo.unitLabel || unitDisplayLabel(unitType),
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
    data.squadrons = data.squadrons
      .map(normalizeUnitRecord)
      .sort((a, b) => `${a.country} ${a.name}`.localeCompare(`${b.country} ${b.name}`));

    state.pinById = new Map(data.pins.map((pin) => [pin.id, pin]));
    state.photoById = new Map(data.photos.map((photo) => [photo.id, photo]));
    state.aircraftById = new Map(data.aircraft.map((entry) => [entry.id, entry]));
    data.airshows = normalizeAirshows(data.airshows, data.photos);
    state.airshowById = new Map(data.airshows.map((airshow) => [airshow.id, airshow]));
    state.photosByPinId = indexPhotosByPin(data.pins, data.photos);
    state.enabledPins = data.pins.filter((pin) => pin.enabled);
    state.mapPreviewCache.clear();

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

  function normalizeAirshows(rawAirshows, photos) {
    const byKey = new Map();
    const addAirshow = (rawAirshow, fallbackName = "") => {
      const name = String(rawAirshow?.name || rawAirshow?.event || fallbackName || "").trim();
      if (!name) {
        return null;
      }
      const key = normalizeKey(name);
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: String(rawAirshow?.id || slugify(name)),
          name,
          photoIds: [],
          heroPhotoId: String(rawAirshow?.heroPhotoId || rawAirshow?.hero_photo_id || ""),
          firstDate: String(rawAirshow?.firstDate || ""),
          latestDate: String(rawAirshow?.latestDate || "")
        });
      }
      const airshow = byKey.get(key);
      airshow.photoIds.push(...(Array.isArray(rawAirshow?.photoIds) ? rawAirshow.photoIds.map(String) : []));
      if (!airshow.heroPhotoId && rawAirshow?.heroPhotoId) {
        airshow.heroPhotoId = String(rawAirshow.heroPhotoId);
      }
      return airshow;
    };

    rawAirshows.forEach((airshow) => addAirshow(airshow));
    photos.forEach((photo) => {
      if (!photo.airshow) {
        return;
      }
      const airshow = addAirshow({}, photo.airshow);
      airshow.photoIds.push(photo.id);
    });

    return Array.from(byKey.values())
      .map((airshow) => {
        const photoIds = unique(airshow.photoIds).filter((photoId) => state.photoById.has(photoId));
        const eventPhotos = photoIds.map((photoId) => state.photoById.get(photoId)).filter(Boolean).sort(sortPhotos);
        const dates = eventPhotos.map((photo) => photo.sortDate).filter(Boolean).sort();
        return {
          ...airshow,
          photoIds,
          photoCount: eventPhotos.length,
          firstDate: airshow.firstDate || dates[0] || "",
          latestDate: airshow.latestDate || dates[dates.length - 1] || ""
        };
      })
      .filter((airshow) => airshow.photoIds.length)
      .sort((a, b) => {
        const dateDiff = Date.parse(b.latestDate || "") - Date.parse(a.latestDate || "");
        if (Number.isFinite(dateDiff) && dateDiff) {
          return dateDiff;
        }
        return b.latestDate.localeCompare(a.latestDate) || a.name.localeCompare(b.name);
      });
  }

  function chooseInitialSelections() {
    const mostRecentLocation = recentLocations()[0];
    const firstEnabledPin = state.data.pins.find((pin) => pin.enabled);

    state.selectedPinId = mostRecentLocation ? mostRecentLocation.pin.id : firstEnabledPin ? firstEnabledPin.id : null;
    state.selectedAircraftId = null;
  }

  function setupEvents() {
    document.querySelectorAll("[data-tab-target]").forEach((button) => {
      button.addEventListener("click", () => openDirectoryView(button.dataset.tabTarget));
    });
    if (els.brand) {
      els.brand.addEventListener("click", (event) => {
        event.preventDefault();
        goToMapHome();
      });
    }
    els.viewSelect.addEventListener("change", () => openDirectoryView(els.viewSelect.value));

    document.getElementById("fitPinsButton").addEventListener("click", fitMapToPins);
    document.getElementById("closeViewerButton").addEventListener("click", closeViewer);
    document.getElementById("previousPhotoButton").addEventListener("click", () => stepPhoto(-1));
    document.getElementById("nextPhotoButton").addEventListener("click", () => stepPhoto(1));
    els.viewerInfoButton.addEventListener("click", () => setViewerInfoOpen(!state.viewerInfoOpen));
    els.viewerZoomOutButton.addEventListener("click", () => setViewerZoom(state.viewerZoom - 0.25));
    els.viewerZoomResetButton.addEventListener("click", resetViewerTransform);
    els.viewerZoomInButton.addEventListener("click", () => setViewerZoom(state.viewerZoom + 0.25));
    els.viewerCleanButton.addEventListener("click", () => setViewerCleanMode(!state.viewerCleanMode));
    els.viewerShareButton.addEventListener("click", () => shareViewerPhoto());
    els.viewerFullscreenButton.addEventListener("click", toggleViewerFullscreen);
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
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("popstate", handleHistoryNavigation);
    window.addEventListener("hashchange", handleHistoryNavigation);
    document.addEventListener("fullscreenchange", updateViewerFullscreenButton);
    window.addEventListener("resize", debounce(() => {
      updateMapPanelState();
      updateViewerInfoState();
      refreshMapLayout();
      updateRecentPhotoLimit();
    }, 150));

    if (
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      document.addEventListener("pointermove", handleLensPointerMove, { passive: true });
      document.addEventListener("pointerout", handleLensPointerOut, { passive: true });
    }
  }

  function openDirectoryView(viewId) {
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
      if (!els.photoViewer.hidden) {
        closeViewer({ updateHash: false, useHistory: false });
      }
      setActiveTab("mapView", { updateHash: false });
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

    if (!els.photoViewer.hidden && state.viewerInfoOpen && isMobileViewerLayout() && !event.target.closest("#viewerInfo")) {
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

    const countryJump = event.target.closest("[data-squadron-country-jump]");
    if (countryJump) {
      const target = document.getElementById(countryJump.dataset.squadronCountryJump || "");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const dexFamilyFilterClear = event.target.closest("[data-clear-dex-family-filter]");
    if (dexFamilyFilterClear) {
      state.dexFamilyFilter = "";
      renderDex();
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

    const dexGroupButton = event.target.closest("[data-dex-group]");
    if (dexGroupButton) {
      state.dexGroupMode = dexGroupButton.dataset.dexGroup;
      renderAircraftDetail();
      return;
    }

    const locationPageButton = event.target.closest("[data-location-page-id]");
    if (locationPageButton) {
      if (!els.photoViewer.hidden) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectLocationPage(locationPageButton.dataset.locationPageId);
      return;
    }

    const locationGroupButton = event.target.closest("[data-location-group-key]");
    if (locationGroupButton) {
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

    const locationButton = event.target.closest("[data-location-id]");
    if (locationButton) {
      selectPin(locationButton.dataset.locationId);
      return;
    }

    const aircraftButton = event.target.closest("[data-aircraft-id]");
    if (aircraftButton) {
      if (!els.photoViewer.hidden) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectAircraft(aircraftButton.dataset.aircraftId);
      return;
    }

    const squadronButton = event.target.closest("[data-squadron-id]");
    if (squadronButton) {
      if (!els.photoViewer.hidden) {
        closeViewer({ updateHash: false, useHistory: false, restoreFocus: false });
      }
      selectSquadron(squadronButton.dataset.squadronId);
      return;
    }

    const airshowButton = event.target.closest("[data-airshow-id]");
    if (airshowButton) {
      if (!els.photoViewer.hidden) {
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
    if (!els.photoViewer.hidden) {
      if (event.key === "Tab") {
        trapViewerFocus(event);
      } else if (event.key === "Escape") {
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

    els.mapPanelToggles.forEach((button) => {
      const isExpanded = button.dataset.mapPanelToggle === activePanel;
      button.classList.toggle("is-active", isExpanded);
      button.setAttribute("aria-expanded", String(isExpanded));
    });
  }

  function isMobileMapLayout() {
    return window.matchMedia("(max-width: 1040px)").matches;
  }

  function isDenseDesktopMapLayout() {
    return window.matchMedia("(min-width: 1041px) and (max-width: 1500px)").matches;
  }

  function isMobileViewerLayout() {
    return window.matchMedia("(max-width: 1040px)").matches;
  }

  function setActiveTab(viewId, options = {}) {
    const activeBefore = document.querySelector("[data-view].is-active");
    const navigationViewId = navigationViewFor(viewId);
    document.querySelectorAll("[data-view]").forEach((view) => {
      const isActive = view.id === viewId;
      view.hidden = !isActive;
      view.classList.toggle("is-active", isActive);
    });

    document.querySelectorAll("[data-tab-target]").forEach((button) => {
      const isActive = button.dataset.tabTarget === navigationViewId;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });
    if (els.viewSelect) {
      els.viewSelect.value = navigationViewId;
    }

    ensureViewRendered(viewId);

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
    const defaultTitle = "SpotterDex - Timothy's Logbook";
    const defaultDescription = "An aircraft spotting logbook and aviation photography field guide.";
    const defaultImage = "assets/generated/photos/location-hero-gifu-air-base.jpg";
    let title = defaultTitle;
    let description = defaultDescription;
    let image = defaultImage;

    if (activePhoto) {
      title = `${activePhoto.title || photoSubjectLabel(activePhoto)} | SpotterDex`;
      description = activePhoto.caption || `${photoSubjectLabel(activePhoto)} photographed at ${activePhoto.locationName}.`;
      image = activePhoto.image || activePhoto.thumbnail || defaultImage;
    } else if (activeView === "aircraftDetailView") {
      const aircraft = state.aircraftById?.get(state.selectedAircraftId);
      if (aircraft) {
        const photos = photosForAircraft(aircraft);
        const cover = state.photoById.get(aircraft.coverPhoto) || photos[0];
        title = `${aircraft.typeName} field guide | SpotterDex`;
        description = `${photos.length} photographed frame${photos.length === 1 ? "" : "s"} of ${aircraft.typeName}, organised by unit and location.`;
        image = cover?.image || cover?.thumbnail || defaultImage;
      }
    } else if (activeView === "locationDetailView") {
      const pin = state.pinById?.get(state.selectedPinId);
      if (pin) {
        const photos = photosForPin(pin);
        const profile = locationProfile(pin, photos);
        const hero = profile.heroPhoto || profile.heroAsset || photos[0];
        title = `${pin.name} field guide | SpotterDex`;
        description = `${photos.length} photographed frame${photos.length === 1 ? "" : "s"} at ${pin.name}${pin.country ? `, ${pin.country}` : ""}.`;
        image = hero?.image || hero?.thumbnail || defaultImage;
      }
    } else if (activeView === "squadronDetailView") {
      const squadron = collectSquadrons().find((item) => item.id === state.selectedSquadronId);
      if (squadron) {
        const photos = photosForSquadronRecord(squadron);
        const hero = squadronCardHero(squadron) || photos[0];
        title = `${squadron.name} | SpotterDex`;
        description = `${photos.length} aviation photograph${photos.length === 1 ? "" : "s"} from ${squadron.name}${squadron.country ? ` in ${squadron.country}` : ""}.`;
        image = hero?.image || hero?.thumbnail || defaultImage;
      }
    } else if (activeView === "airshowDetailView" && state.selectedAirshowId) {
      const airshow = state.airshowById.get(state.selectedAirshowId);
      if (airshow) {
        const photos = photosForAirshow(airshow);
        const hero = airshowHeroPhoto(airshow, photos) || photos[0];
        title = `${airshow.name} | SpotterDex`;
        description = `${photos.length} aviation photograph${photos.length === 1 ? "" : "s"} from ${airshow.name}.`;
        image = hero?.image || hero?.thumbnail || defaultImage;
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
    if (els.ogUrl) els.ogUrl.content = shareUrl;
    if (els.twitterTitle) els.twitterTitle.content = title;
    if (els.twitterDescription) els.twitterDescription.content = description;
    if (els.twitterImage) els.twitterImage.content = imageUrl;
    if (els.canonical) els.canonical.href = canonicalUrl;
  }

  async function copyFieldGuideLink(button) {
    await copyText(shareUrlForCurrentState());
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
    } else if (viewId === "dexView") {
      updateDeepLink("view", "dex");
    } else if (viewId === "squadronsView") {
      updateDeepLink("view", "squadrons");
    } else if (viewId === "airshowsView") {
      updateDeepLink("view", "airshows");
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
    renderStats();
    updateMapPanelState();
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
      initMap();
      fitMapToPins();
      renderPins();
      renderMapResults();
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
    }

    state.renderedViews.add(directoryView);
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

    const leaderPane = state.map.createPane("spotterdexLeaderPane");
    leaderPane.style.zIndex = "590";
    leaderPane.style.pointerEvents = "none";
    const labelPane = state.map.createPane("spotterdexLabelPane");
    labelPane.style.zIndex = "650";
    labelPane.style.pointerEvents = "auto";
    state.mapTrafficLayer = window.L.layerGroup().addTo(state.map);
    state.mapLeaderLayer = window.L.layerGroup().addTo(state.map);
    state.markerLayer = window.L.layerGroup().addTo(state.map);
    state.mapLabelLayer = window.L.layerGroup().addTo(state.map);
    state.map.on("zoomstart", () => {
      state.mapZoomInProgress = true;
    });
    state.map.on("moveend", () => {
      const needsReflow = state.mapZoomInProgress || mapCalloutsNeedReflow();
      state.mapZoomInProgress = false;
      if (needsReflow) {
        renderPins();
      }
    });
    observeMapSize();
    refreshMapLayout();
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

  function renderPins(options = {}) {
    if (!state.map || !state.markerLayer || !state.mapLeaderLayer || !state.mapLabelLayer || !window.L) {
      return;
    }

    state.markerLayer.clearLayers();
    state.mapLeaderLayer.clearLayers();
    state.mapLabelLayer.clearLayers();
    state.markersByPinId = new Map();
    const pins = state.enabledPins;
    const markerLayouts = mapMarkerLayouts(pins);

    markerLayouts.forEach((layout) => {
      const { pin, preview, callout } = layout;
      window.L.marker([pin.lat, pin.lon], {
        icon: mapLeaderIcon(callout),
        interactive: false,
        keyboard: false,
        pane: "spotterdexLeaderPane"
      }).addTo(state.mapLeaderLayer);
      window.L.marker([pin.lat, pin.lon], {
        icon: mapLabelIcon(pin, pin.id === state.selectedPinId, preview, callout),
        title: `Select ${pin.name}`,
        keyboard: true,
        pane: "spotterdexLabelPane",
        zIndexOffset: pin.id === state.selectedPinId ? 900 : 0
      })
        .on("click", () => selectPin(pin.id, { pan: false }))
        .addTo(state.mapLabelLayer);
      const marker = window.L.marker([pin.lat, pin.lon], {
        icon: mapMarkerIcon(pin, pin.id === state.selectedPinId),
        title: pin.name,
        zIndexOffset: pin.id === state.selectedPinId ? 800 : 0
      })
        .on("click", () => selectPin(pin.id, { pan: false }));

      marker.addTo(state.markerLayer);
      state.markersByPinId.set(pin.id, marker);
    });
    state.mapCalloutLayouts = markerLayouts.map((layout) => ({
      pinId: layout.pin.id,
      point: { x: layout.point.x, y: layout.point.y },
      bounds: layout.bounds
    }));
    state.activeMapMarkerId = state.selectedPinId;

    renderMapTraffic(options.refreshTraffic);

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
      const preview = mapLocationPreview([pin]);
      return {
        pin,
        preview,
        // Callouts are positioned inside the marker DOM, so keep their collision
        // layout in the map container's coordinate system. Layer points drift when
        // Leaflet translates a pane during a resize or pan.
        point: state.map.latLngToContainerPoint([pin.lat, pin.lon]),
        labelText: mapPinLabel(pin),
        labelSize: mapLabelSize(mapPinLabel(pin), preview),
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
      const chosen = available || layout.candidates
        .slice()
        .sort((a, b) => (
          mapLabelCandidateScore(a, layout, occupied, markerPoints, markerRadius, blockedBounds) -
          mapLabelCandidateScore(b, layout, occupied, markerPoints, markerRadius, blockedBounds)
        ))[0];
      bounds.set(layout, chosen.bounds);
      occupied.push({ layout, bounds: chosen.bounds });
    });
    return { bounds };
  }

  function mapLabelSize(title, preview) {
    const isCompact = isMobileMapLayout();
    if (isCompact) {
      return {
        width: Math.min(132, Math.max(54, Math.ceil(title.length * 7.2 + 14))),
        height: 24
      };
    }

    const hasAssets = preview.families.length || preview.logos.length;
    if (isDenseDesktopMapLayout()) {
      return {
        width: Math.min(252, Math.max(82, Math.ceil(title.length * 6 + 12))),
        height: hasAssets ? 38 : 25
      };
    }
    return {
      width: Math.min(280, Math.max(88, Math.ceil(title.length * 6.65 + 14))),
      height: hasAssets ? 45 : 28
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
      ));

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
    if (isMobileMapLayout()) {
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
    if (state.mapTrafficInitialized && !force) {
      return;
    }
    state.mapTrafficLayer.clearLayers();

    state.enabledPins.forEach((pin) => {
        const families = mapLocationPreview([pin]).families;
        families.forEach((family, index) => {
          window.L.marker([pin.lat, pin.lon], {
            icon: mapTrafficIcon(pin, family, index),
            interactive: false,
            keyboard: false,
            zIndexOffset: -120
          }).addTo(state.mapTrafficLayer);
        });
    });
    state.mapTrafficInitialized = true;
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
      els.mapResults.innerHTML = '<div class="empty-state">Add enabled pins to start browsing the map.</div>';
      return;
    }

    const photos = photosForPin(pin);
    const profile = locationProfile(pin, photos);
    els.mapResults.innerHTML = `
      <h2 class="location-details-title">Location Details</h2>
      ${renderMapLocationPanel(profile)}
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
    const { pin, heroPhoto, heroAsset, families, units, photos } = profile;
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
                  sizes: "(max-width: 1040px) 100vw, 430px"
                })
              : '<span class="empty-cover">No location photo</span>'
          }
          <span class="location-hero-overlay">
            <span class="eyebrow">${escapeHtml(locationKicker(pin))}</span>
            <strong>${escapeHtml(pin.name)}</strong>
            ${renderLocationIdentityMarks(families, units)}
          </span>
        </div>
        <button class="location-page-button" type="button" data-location-page-id="${escapeAttr(pin.id)}">
          <span>Open location page</span>
          <span aria-hidden="true">→</span>
        </button>
        <div class="location-expandable-list">
          ${renderLocationExpandableSection(pin, photos, "squadron")}
          ${renderLocationExpandableSection(pin, photos, "type")}
        </div>
      </section>
    `;
  }

  function locationKicker(pin) {
    return [pin.icao, pin.country].filter(Boolean).join(" - ") || "Location";
  }

  function renderLocationIdentityMarks(families, units) {
    const familyMarks = (families || []).slice(0, 3).map((family) => `
      <span class="location-identity-mark is-family" title="${escapeAttr(family.label)}">
        <img src="${escapeAttr(family.lightModeIcon || family.darkIcon || family.icon)}" alt="${escapeAttr(family.label)}">
      </span>
    `);
    const unitMarks = (units || []).filter((unit) => unit.logo).slice(0, 6).map((unit) => `
      <span class="location-identity-mark is-unit" title="${escapeAttr(`${unit.name} logo`)}">
        <img src="${escapeAttr(unit.logo)}" alt="${escapeAttr(`${unit.name} logo`)}">
      </span>
    `);
    if (!familyMarks.length && !unitMarks.length) {
      return "";
    }
    return `<span class="location-identity-marks" aria-label="Aircraft families and squadron logos">${familyMarks.join("")}${unitMarks.join("")}</span>`;
  }

  function locationPhotoGroups(pin, photos, kind) {
    const groups = new Map();
    const addPhoto = (key, details, photo) => {
      if (!groups.has(key)) {
        groups.set(key, { ...details, key, photos: [] });
      }
      groups.get(key).photos.push(photo);
    };

    photos.forEach((photo) => {
      if (kind === "location") {
        if (photo.tagScope !== "location") return;
        addPhoto("location", { title: "Location-specific images", eyebrow: "Location tag", logo: "" }, photo);
        return;
      }
      if (kind === "type") {
        if (photo.tagScope !== "aircraft") return;
        const title = photo.aircraftType || "Unknown aircraft";
        addPhoto(`type-${normalizeKey(title)}`, { title, eyebrow: "Aircraft type", logo: "" }, photo);
        return;
      }
      if (!photo.squadronName || photo.tagScope === "location") return;
      const squadron = squadronForPhoto(photo);
      const title = squadron?.name || photo.squadronName;
      const unitType = squadron?.unitType || photo.unitType;
      addPhoto(
        `unit-${normalizeKey(`${photo.country || pin.country || ""}-${title}-${unitType || ""}`)}`,
        { title, eyebrow: squadron?.unitLabel || photo.unitLabel || unitDisplayLabel(unitType), logo: squadron?.logo || "" },
        photo
      );
    });

    return Array.from(groups.values())
      .map((group) => ({ ...group, photos: group.photos.sort(sortPhotos) }))
      .sort((a, b) => {
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
      squadron: "Squadrons and organisations"
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

  function renderLocationAircraftTypeGroup(pin, group) {
    const groupKey = `${pin.id}:type:${group.key}`;
    const isExpanded = state.expandedLocationGroupKeys.has(groupKey);
    const latest = group.photos[0];
    const image = latest?.thumbnail || latest?.image || "";
    const remaining = group.photos.slice(1);
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
          <span class="location-type-latest">
            ${image ? `<img src="${escapeAttr(image)}" alt="${escapeAttr(`${group.title} most recent photo`)}">` : '<span class="location-type-fallback">No photo</span>'}
          </span>
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
                ${remaining.length
                  ? `<div class="photo-grid location-group-photo-grid">${remaining.map((photo) => renderPhotoCard(photo, "map")).join("")}</div>`
                  : '<p class="muted">This is the only frame in the group.</p>'}
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
    const logo = group.logo
      ? `<img class="location-group-logo" src="${escapeAttr(group.logo)}" alt="${escapeAttr(`${group.title} logo`)}">`
      : "";
    return `
      <article class="location-expandable-group${isExpanded ? " is-expanded" : ""}">
        <button
          class="location-group-toggle"
          type="button"
          data-location-group-key="${escapeAttr(groupKey)}"
          ${singlePhotoId
            ? `data-location-single-photo-id="${escapeAttr(singlePhotoId)}" aria-label="Open ${escapeAttr(`${group.title} photo`)}"`
            : `aria-expanded="${isExpanded ? "true" : "false"}" aria-controls="location-group-${escapeAttr(slugify(groupKey))}"`}
        >
          <span class="location-group-latest">
            ${image ? `<img src="${escapeAttr(image)}" alt="${escapeAttr(`${group.title} most recent photo`)}">` : '<span class="location-group-fallback">No photo</span>'}
          </span>
          <span class="location-group-copy">
            <span class="eyebrow">${escapeHtml(group.eyebrow)}</span>
            <strong>${escapeHtml(group.title)}</strong>
            <span>${escapeHtml(displayPhotoDate(latest))} · ${group.photos.length} photo${group.photos.length === 1 ? "" : "s"}</span>
          </span>
          ${logo}
          <span class="location-group-chevron" aria-hidden="true">${singlePhotoId ? "↗" : (isExpanded ? "−" : "+")}</span>
        </button>
        ${
          isExpanded
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
      eager: true
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
      ? renderResponsivePhotoImage(heroPhoto, "", { sizes: "100vw", eager: true })
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
        ${renderFocalLengthDistribution(exifPhotos)}
        ${renderExifCountList("Shutter speeds", shutterCounts, "shutter")}
        ${renderExifCountList("Apertures", apertureCounts, "aperture")}
        ${renderExifCountList("ISO", isoCounts, "iso")}
      </div>
    `;
  }

  function renderSquadronsPage() {
    if (!els.squadronLogoGrid || !els.squadronPageCount) {
      return;
    }

    const squadrons = collectSquadrons();
    renderSquadronArchiveHero(squadrons);
    renderSquadronCountryRail(squadrons);

    if (!squadrons.length) {
      els.squadronLogoGrid.innerHTML = '<div class="empty-state compact">Add squadron entries to populate this page.</div>';
      return;
    }

    els.squadronLogoGrid.innerHTML = renderSquadronCountrySections(squadrons);
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
      ? renderResponsivePhotoImage(latest, "", { sizes: "100vw", eager: true })
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
      return;
    }

    els.airshowTimeline.innerHTML = airshows.map(renderAirshowTimelineItem).join("");
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
      ? renderResponsivePhotoImage(hero, "", { sizes: "100vw", eager: true })
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
            sizes: "(max-width: 760px) 100vw, 50vw"
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
    const groups = new Map();
    const addPhoto = (key, details, photo) => {
      if (!groups.has(key)) {
        groups.set(key, { ...details, key, photos: [] });
      }
      const group = groups.get(key);
      if (!group.logo && details.logo) {
        group.logo = details.logo;
      }
      group.photos.push(photo);
    };

    photos.forEach((photo) => {
      if (photo.tagScope === "location" || !photo.squadronName) {
        addPhoto(
          `location-${photo.pinId || normalizeKey(photo.locationName || "untagged")}`,
          { title: "Location-tagged frames", eyebrow: "Location tag", logo: "" },
          photo
        );
        return;
      }

      const squadron = squadronForPhoto(photo);
      const name = squadron?.name || photo.squadronName;
      const unitType = squadron?.unitType || photo.unitType;
      const country = squadron?.country || photo.country || "";
      addPhoto(
        `unit-${normalizeKey(`${country}-${name}-${unitType || ""}`)}`,
        {
          title: name,
          eyebrow: squadron?.unitLabel || photo.unitLabel || unitDisplayLabel(unitType),
          logo: squadron?.logo || ""
        },
        photo
      );
    });

    return Array.from(groups.values())
      .map((group) => ({ ...group, photos: group.photos.sort(sortPhotosOldest) }))
      .sort((a, b) => {
        const dateDiff = (a.photos[0]?.sortTime || 0) - (b.photos[0]?.sortTime || 0);
        return dateDiff || a.title.localeCompare(b.title);
      });
  }

  function renderAirshowPhotoGroups(groups) {
    return `
      <div class="airshow-squadron-groups">
        ${groups.map((group) => {
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
              <div class="photo-grid airshow-photo-grid">
                ${group.photos.map((photo) => renderPhotoCard(photo, "airshow")).join("")}
              </div>
            </section>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderAirshowIdentityMarks(photos) {
    const families = new Map();
    const squadrons = new Map();

    photos.forEach((photo) => {
      const family = aircraftFamilyForPhoto(photo);
      if (family && !families.has(family.id)) {
        families.set(family.id, family);
      }

      const squadron = squadronForPhoto(photo);
      if (!squadron || !squadron.logo) {
        return;
      }
      const squadronId = squadronPageIdForUnit(squadron) || normalizeKey(`${squadron.country || photo.country || ""}-${squadron.name}`);
      if (!squadrons.has(squadronId)) {
        squadrons.set(squadronId, squadron);
      }
    });

    const familyMarks = Array.from(families.values()).slice(0, 3).map((family) => `
      <span class="airshow-identity-mark is-family" title="${escapeAttr(family.label)}">
        <img src="${escapeAttr(family.darkIcon || family.mapIcon || family.icon)}" alt="${escapeAttr(family.label)}">
      </span>
    `);
    const squadronMarks = Array.from(squadrons.values()).slice(0, 6).map((squadron) => `
      <span class="airshow-identity-mark is-squadron" title="${escapeAttr(`${squadron.name} logo`)}">
        <img src="${escapeAttr(squadron.logo)}" alt="${escapeAttr(`${squadron.name} logo`)}">
      </span>
    `);

    if (!familyMarks.length && !squadronMarks.length) {
      return "";
    }

    return `
      <span class="airshow-identity-marks" aria-label="Aircraft families and squadron logos">
        ${familyMarks.join("")}
        ${squadronMarks.join("")}
      </span>
    `;
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
      ? groups
          .map(
            (group) => `
              <button type="button" data-squadron-country-jump="${escapeAttr(squadronCountryId(group.country))}">
                ${renderCountryLabel(group.country, "squadron-country-nav-label")}
                <span class="squadron-country-count">${group.squadrons.length}</span>
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
                <h2>${renderCountryLabel(group.country)}</h2>
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
    const addSquadron = (squadron, aircraftType = "") => {
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
              ${renderDetailPhotoGrid(squadronLevelPhotos, "squadron")}
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
        ${renderDetailPhotoGrid(otherPhotos, "squadron")}
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
              ${renderDetailPhotoGrid(locationPhotos, "location")}
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
        ${renderDetailPhotoGrid(otherPhotos, "location")}
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

  function renderDetailPhotoGrid(photos, context) {
    if (!photos.length) {
      return '<div class="empty-state">No photos found for this section yet.</div>';
    }

    return `
      <div class="photo-grid detail-photo-grid">
        ${photos.map((photo) => renderPhotoCard(photo, context)).join("")}
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

  function renderFocalLengthDistribution(photos) {
    const focalPhotos = photos
      .map((photo) => ({ photo, focalLength: statsFocalLengthValue(photo) }))
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
    const teleconverterIncluded = focalPhotos.some(({ photo }) => /teleconverter/i.test((photo.exif || {}).LensModel || (photo.exif || {}).Lens || ""));

    return `
      <section class="exif-stat-card focal-distribution-card">
        <h3 class="heading-with-icon">${statsIcon("focal")}<span>Focal-length distribution</span></h3>
        <p class="focal-distribution-summary">
          ${escapeHtml(`${formatFocalLength(FOCAL_DISTRIBUTION_MINIMUM)} to ${formatFocalLength(FOCAL_DISTRIBUTION_MAXIMUM)} · ${FOCAL_DISTRIBUTION_BIN_WIDTH}mm bins`)}${teleconverterIncluded ? " · includes teleconverter captures" : ""}
        </p>
        <div class="focal-distribution-chart" aria-label="Focal-length distribution from ${escapeAttr(formatFocalLength(FOCAL_DISTRIBUTION_MINIMUM))} to ${escapeAttr(formatFocalLength(FOCAL_DISTRIBUTION_MAXIMUM))} in ${FOCAL_DISTRIBUTION_BIN_WIDTH}mm bins">
          ${bins
            .map((bin) => {
              const height = bin.count ? Math.max(8, Math.round((bin.count / peak) * 100)) : 0;
              const rangeLabel = formatFocalRange(bin.start, bin.end, bin.includesEnd);
              const tickLabel = String(Math.round(bin.start));
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
                  <span class="focal-distribution-label">${escapeHtml(tickLabel)}</span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function focalLengthBins(focalLengths) {
    const minimum = FOCAL_DISTRIBUTION_MINIMUM;
    const maximum = FOCAL_DISTRIBUTION_MAXIMUM;
    const width = FOCAL_DISTRIBUTION_BIN_WIDTH;
    const bins = [];

    for (let start = minimum; start < maximum; start += width) {
      const end = Math.min(maximum, start + width);
      const includesEnd = end === maximum;
      bins.push({
        start,
        end,
        includesEnd,
        count: focalLengths.filter((focalLength) => focalLength >= start && (includesEnd ? focalLength <= end : focalLength < end)).length
      });
    }

    return bins;
  }

  function formatFocalLength(focalLength) {
    return `${Math.round(focalLength)}mm`;
  }

  function formatFocalRange(start, end, includesEnd = true) {
    if (start === end) {
      return formatFocalLength(start);
    }
    return `${Math.round(start)}-${Math.round(includesEnd ? end : end - 1)}mm`;
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
    const familyFilter = state.dexFamilyFilter;
    const entries = state.data.aircraft.filter((entry) => {
      if (familyFilter && aircraftFamilyIdForEntry(entry) !== familyFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const squadronText = entry.squadrons.map((squadron) => `${squadron.name} ${squadron.unitLabel}`).join(" ");
      return normalizeText(`${entry.typeName} ${entry.countries.join(" ")} ${squadronText}`).includes(query);
    });

    renderDexFamilyFilter();
    els.dexCount.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}${familyFilter ? ` in ${AIRCRAFT_FAMILY_LABELS.get(familyFilter) || "selected family"}` : ""}`;
    renderAircraftGrid(entries);
  }

  function openAircraftFamilyDex(familyId) {
    const family = normalizeAircraftFamily(familyId);
    if (!family) {
      return;
    }

    state.dexFamilyFilter = family;
    state.selectedAircraftId = null;
    if (els.aircraftSearch) {
      els.aircraftSearch.value = "";
    }
    setActiveTab("dexView");
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
      <span class="dex-family-label">Airframe class</span>
      <span class="dex-family-options">
        <button
          class="${family ? "" : "is-active"}"
          type="button"
          data-clear-dex-family-filter
          aria-pressed="${family ? "false" : "true"}"
        >All <small>${state.data.aircraft.length}</small></button>
        ${AIRCRAFT_FAMILY_DEFINITIONS.map((definition) => {
          const count = state.data.aircraft.filter((entry) => aircraftFamilyIdForEntry(entry) === definition.id).length;
          return `
            <button
              class="${family === definition.id ? "is-active" : ""}"
              type="button"
              data-dex-family-id="${escapeAttr(definition.id)}"
              aria-pressed="${family === definition.id ? "true" : "false"}"
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

    els.aircraftGrid.innerHTML = entries
      .map((entry, index) => {
        const cover = state.photoById.get(entry.coverPhoto);
        const stats = aircraftStats(entry);
        const countries = unique(entry.countries).slice(0, 3);
        const activeClass = entry.id === state.selectedAircraftId ? " is-active" : "";
        const coverImage = cover ? cover.thumbnail || cover.image : "";
        const unitCount = stats.unitCount;
        const unitLabel = entryUnitNoun(entry, unitCount);
        const familyId = aircraftFamilyIdForEntry(entry);
        const familyLabel = AIRCRAFT_FAMILY_LABELS.get(familyId) || "Aircraft";
        const layoutClass = index === 0
          ? " is-feature"
          : index % 11 === 5 || index % 11 === 8
            ? " is-wide"
            : "";
        const catalogueNumber = String(index + 1).padStart(3, "0");

        return `
          <button
            class="aircraft-card${layoutClass}${activeClass}"
            type="button"
            data-aircraft-id="${escapeAttr(entry.id)}"
            style="--dex-delay: ${Math.min(index, 12) * 42}ms"
            aria-label="Open ${escapeAttr(entry.typeName)} field guide"
          >
            <div class="aircraft-cover">
              ${
                coverImage
                  ? renderResponsivePhotoImage(cover, entry.typeName, {
                      sizes: "(max-width: 620px) 100vw, (max-width: 1040px) 50vw, 34vw"
                    })
                  : '<div class="empty-cover">No photo</div>'
              }
            </div>
            <span class="aircraft-card-index">${catalogueNumber}</span>
            <div class="aircraft-body">
              <span class="aircraft-card-kicker">
                <span>${escapeHtml(familyLabel)}</span>
                <span>${stats.photoCount} frame${stats.photoCount === 1 ? "" : "s"}</span>
              </span>
              <strong class="aircraft-title">${formatAircraftCardTitle(entry.typeName)}</strong>
              <span class="aircraft-card-meta">
                ${unitCount} ${unitLabel} · ${stats.locationCount} location${stats.locationCount === 1 ? "" : "s"}
              </span>
              <span class="aircraft-card-footer">
                <span>${countries.map((country) => escapeHtml(country)).join(" / ") || "Country not set"}</span>
                <span aria-hidden="true">↗</span>
              </span>
            </div>
          </button>
        `;
      })
      .join("");
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
      <section class="detail-summary detail-aircraft-summary">
        <div>
          <p class="eyebrow">Archive view</p>
          <p class="detail-summary-copy">Browse this type by ${escapeHtml(unitGroupLabel.toLowerCase())} or location.</p>
        </div>
        <div class="segmented" aria-label="Organize aircraft photos">
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

      ${
        entry.squadrons.length
          ? `<section class="detail-unit-section">
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
            </section>`
          : ""
      }

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

  function renderResponsivePhotoImage(photo, alt, options = {}) {
    if (!photo) {
      return "";
    }
    const source = photo.thumbnail || photo.image || "";
    if (!source) {
      return "";
    }

    const thumbnailSize = parseImageSize(photo.thumbnailSize);
    const processedSize = parseImageSize(photo.processedSize);
    const candidates = [];
    if (photo.thumbnail && thumbnailSize.width) {
      candidates.push(`${escapeAttr(photo.thumbnail)} ${thumbnailSize.width}w`);
    }
    if (photo.image && processedSize.width && photo.image !== photo.thumbnail) {
      candidates.push(`${escapeAttr(photo.image)} ${processedSize.width}w`);
    }

    const dimensions = thumbnailSize.width ? thumbnailSize : processedSize;
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
          <span>${escapeHtml(photoContextLabel(photo))} - ${escapeHtml(displayPhotoDate(photo))}</span>
        </span>
      </button>
    `;
  }

  function segmentButton(label, value, activeValue, dataName) {
    const activeClass = value === activeValue ? " is-active" : "";
    return `<button class="segment-button${activeClass}" type="button" ${dataName}="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
  }

  function selectPin(pinId, options = {}) {
    const previousPinId = state.selectedPinId;
    state.selectedPinId = pinId;
    if (previousPinId !== pinId) {
      state.expandedLocationGroupKeys.clear();
    }
    renderLocations();
    updateActiveMapMarker(previousPinId, pinId);
    renderMapResults();

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

  function selectLocationPage(pinId, options = {}) {
    const pin = state.pinById.get(pinId);
    if (!pin) {
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
    const updateMarker = (pinId, isActive) => {
      const marker = state.markersByPinId.get(pinId);
      if (!marker) {
        return;
      }
      marker.setZIndexOffset(isActive ? 800 : 0);
      const element = marker.getElement();
      if (element) {
        element.classList.toggle("is-active", isActive);
      }
    };

    if (previousPinId && previousPinId !== nextPinId) {
      updateMarker(previousPinId, false);
    }
    if (nextPinId) {
      updateMarker(nextPinId, true);
    }
    state.activeMapMarkerId = nextPinId || null;
  }

  function selectAircraft(aircraftId, options = {}) {
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

  function mapLabelIcon(pin, isActive, preview, callout) {
    return window.L.divIcon({
      className: "spotterdex-marker-label-shell",
      html: renderMapMarkerLabel(mapPinLabel(pin), pin.name, preview, callout, isActive),
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

  function renderMapMarkerLabel(title, fullTitle, preview, callout, isActive = false) {
    const assets = isMobileMapLayout()
      ? ""
      : [
          preview.families.length ? renderMapMarkerFamilies(preview.families) : "",
          preview.families.length && preview.logos.length ? '<span class="map-marker-divider" aria-hidden="true">|</span>' : "",
          preview.logos.length ? renderMapMarkerLogos(preview.logos) : ""
        ]
          .filter(Boolean)
          .join("");
    return `
      <span
        class="spotterdex-marker-label${isActive ? " is-active" : ""}"
        style="--label-left: ${callout.labelLeft}px; --label-top: ${callout.labelTop}px; --label-width: ${callout.width}px; --label-height: ${callout.height}px;"
        title="${escapeAttr(fullTitle)}"
      >
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

  function fitMapToPins() {
    if (!state.map || !window.L) {
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
    setViewerCleanMode(false);
    resetViewerTransform();

    const wasClosed = els.photoViewer.hidden;
    if (wasClosed && document.activeElement instanceof HTMLElement) {
      state.viewerReturnFocus = document.activeElement;
    }
    els.photoViewer.hidden = false;
    document.body.style.overflow = "hidden";
    setViewerBackgroundInert(true);
    updateViewerInfoState();
    renderViewerPhoto();
    if (wasClosed) {
      window.requestAnimationFrame(() => document.getElementById("closeViewerButton")?.focus());
    }

    if (options.updateHash !== false) {
      const wasPhotoRoute = new URLSearchParams(window.location.hash.replace(/^#/, "")).has("photo");
      const changed = updateDeepLink("photo", photoId);
      state.viewerHistoryPushed = Boolean(changed && !wasPhotoRoute);
    } else {
      state.viewerHistoryPushed = false;
    }
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
    return false;
  }

  function closeViewer(options = {}) {
    const shouldUseHistory = options.useHistory !== false
      && state.viewerHistoryPushed
      && new URLSearchParams(window.location.hash.replace(/^#/, "")).has("photo");
    els.photoViewer.hidden = true;
    document.body.style.overflow = "";
    setViewerBackgroundInert(false);
    setViewerInfoOpen(false);
    setViewerCleanMode(false);
    resetViewerTransform();
    state.viewerHistoryPushed = false;
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
    [els.siteHeader, els.main].forEach((element) => {
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
    els.viewerCaption.textContent = [
      photo.caption,
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
        return;
      }
      await copyText(url);
      showViewerActionStatus(els.viewerShareButton, "Copied");
    } catch (error) {
      if (error?.name !== "AbortError") {
        showViewerActionStatus(els.viewerShareButton, "Failed");
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

    if (state.activePhotoContext === "dex" && state.selectedAircraftId) {
      updateDeepLink("aircraft", state.selectedAircraftId, replace);
    } else if (state.activePhotoContext === "squadron" && state.selectedSquadronId) {
      updateDeepLink("squadron", state.selectedSquadronId, replace);
    } else if (state.activePhotoContext === "location" && state.selectedPinId) {
      updateLocationDetailLink(state.selectedPinId, replace);
    } else if (state.activePhotoContext === "airshow" && state.selectedAirshowId) {
      updateDeepLink("airshow", state.selectedAirshowId, replace);
    } else if (photo) {
      const pinId = photo.pinId || pinIdFromLocation(photo.locationName);
      if (pinId) {
        updateDeepLink("location", pinId, replace);
      }
    } else if (state.selectedPinId) {
      updateDeepLink("location", state.selectedPinId, replace);
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
    return normalizeKey(`${squadron.country || ""}-${squadron.name || ""}`);
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

  function statsFocalLength(photo) {
    const exif = photo.exif || {};
    const raw = exif.FocalLength;
    if (!raw) {
      return "";
    }

    const focalLength = statsFocalLengthValue(photo);
    if (focalLength === null) {
      return String(raw).trim();
    }

    return formatFocalLength(focalLength);
  }

  function statsFocalLengthValue(photo) {
    const exif = photo.exif || {};
    const focalMm = parseFocalLengthMm(exif.FocalLength);
    if (focalMm === null || !Number.isFinite(focalMm)) {
      return null;
    }

    return isSonyRx10M4(exif)
      ? Math.round(focalMm * RX10M4_FOCAL_LENGTH_MULTIPLIER)
      : Math.round(focalMm);
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
    const photoId = params.get("photo");
    const squadronId = params.get("squadron");
    const airshowId = params.get("airshow");
    const locationId = params.get("location");
    const locationDetail = params.get("detail") === "1";
    const aircraftId = params.get("aircraft");
    const statsSection = params.get("stats");
    const directoryView = params.get("view");

    state.isApplyingHash = true;
    try {
      if (!photoId && !els.photoViewer.hidden) {
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

      if (squadronId) {
        const squadron = findSquadron(squadronId);
        if (squadron) {
          selectSquadron(squadron.id, { updateHash: false });
          return true;
        }
      }

      if (airshowId) {
        const airshow = findAirshow(airshowId);
        if (airshow) {
          selectAirshow(airshow.id, { updateHash: false, scroll: !options.initial });
          return true;
        }
      }

      if (locationId) {
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

      if (aircraftId) {
        const entry = findAircraft(aircraftId);
        if (entry) {
          selectAircraft(entry.id, { updateHash: false, scroll: !options.initial });
          return true;
        }
      }

      if (statsSection) {
        selectStatsSection(statsSection, { updateHash: false, initial: options.initial });
        return true;
      }

      const directoryViews = {
        dex: "dexView",
        squadrons: "squadronsView",
        airshows: "airshowsView"
      };
      if (directoryViews[directoryView]) {
        openDirectoryView(directoryViews[directoryView]);
        return true;
      }
    } finally {
      state.isApplyingHash = false;
    }
    return false;
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

  function normalizeIcao(value) {
    const code = String(value || "").trim().toUpperCase();
    return /^[A-Z0-9]{4}$/.test(code) ? code : "";
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
