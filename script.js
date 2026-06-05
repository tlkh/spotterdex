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
    markersByPinId: new Map(),
    activePhotoIds: [],
    activePhotoIndex: 0,
    activePhotoContext: "map",
    viewerInfoOpen: false,
    mobileMapPanel: null,
    isApplyingHash: false
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    setupTheme();
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
    els.recentPhotosStrip = document.getElementById("recentPhotosStrip");
    els.recentPhotosCount = document.getElementById("recentPhotosCount");
    els.aircraftGrid = document.getElementById("aircraftGrid");
    els.dexDetail = document.getElementById("dexDetail");
    els.dexCount = document.getElementById("dexCount");
    els.statsDashboard = document.getElementById("statsDashboard");
    els.exifDashboard = document.getElementById("exifDashboard");
    els.squadronLogoGrid = document.getElementById("squadronLogoGrid");
    els.squadronDetail = document.getElementById("squadronDetail");
    els.squadronPageCount = document.getElementById("squadronPageCount");
    els.photoViewer = document.getElementById("photoViewer");
    els.viewerImage = document.getElementById("viewerImage");
    els.viewerKicker = document.getElementById("viewerKicker");
    els.viewerTitle = document.getElementById("viewerTitle");
    els.viewerCaption = document.getElementById("viewerCaption");
    els.viewerMetadata = document.getElementById("viewerMetadata");
    els.viewerInfo = document.getElementById("viewerInfo");
    els.viewerInfoButton = document.getElementById("viewerInfoButton");
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
    document.getElementById("closeViewerButton").addEventListener("click", closeViewer);
    document.getElementById("previousPhotoButton").addEventListener("click", () => stepPhoto(-1));
    document.getElementById("nextPhotoButton").addEventListener("click", () => stepPhoto(1));
    els.viewerInfoButton.addEventListener("click", () => setViewerInfoOpen(!state.viewerInfoOpen));
    els.viewerImage.addEventListener("contextmenu", (event) => event.preventDefault());
    els.viewerImage.setAttribute("draggable", "false");

    els.locationSearch.addEventListener("input", renderLocations);
    els.aircraftSearch.addEventListener("input", renderDex);

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("hashchange", () => applyDeepLinkFromHash());
    window.addEventListener("resize", debounce(() => {
      updateMapPanelState();
      updateViewerInfoState();
      if (state.map) {
        state.map.invalidateSize();
        renderPins();
      }
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

    const photoButton = event.target.closest("[data-photo-id]");
    if (photoButton) {
      openViewer(photoButton.dataset.photoId, photoButton.dataset.photoContext);
    }
  }

  function handleKeydown(event) {
    if (!els.photoViewer.hidden) {
      if (event.key === "Escape") {
        if (state.viewerInfoOpen && isMobileViewerLayout()) {
          setViewerInfoOpen(false);
        } else {
          closeViewer();
        }
      } else if (event.key === "ArrowLeft") {
        stepPhoto(-1);
      } else if (event.key === "ArrowRight") {
        stepPhoto(1);
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
      window.requestAnimationFrame(() => state.map.invalidateSize());
    }
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
          state.map.invalidateSize();
          renderPins();
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
    renderLocations();
    initMap();
    fitMapToPins();
    renderPins();
    renderRecentPhotos();
    renderMapResults();
    updateMapPanelState();
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

    state.markerLayer = window.L.layerGroup().addTo(state.map);
    state.map.on("zoomend moveend", renderPins);
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
      ? 118
      : zoom <= 6
        ? 98
        : zoom <= 8
          ? 78
          : zoom <= 10
            ? 62
            : 48;
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
    els.mapResults.innerHTML = `
      ${renderLocationDetail(profile)}

      <div class="result-header location-photo-browser">
        <div>
          <p class="eyebrow">Photo archive</p>
          <h2>All frames</h2>
          <p class="muted">${photos.length} photo${photos.length === 1 ? "" : "s"} at this location</p>
        </div>
        <div class="segmented" aria-label="Organize map photos">
          ${segmentButton("Aircraft Type", "type", state.mapGroupMode, "data-map-group")}
          ${segmentButton(unitGroupLabel, "squadron", state.mapGroupMode, "data-map-group")}
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
    els.statsDashboard.innerHTML = `
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
        ${renderExifCountList("Camera bodies", cameraCounts)}
        ${renderExifCountList("Lenses", lensCounts)}
        ${renderExifCountList("Focal lengths", focalCounts)}
        ${renderExifCountList("Shutter speeds", shutterCounts)}
        ${renderExifCountList("Apertures", apertureCounts)}
        ${renderExifCountList("ISO", isoCounts)}
      </div>
    `;
  }

  function renderSquadronsPage() {
    if (!els.squadronLogoGrid || !els.squadronPageCount || !els.squadronDetail) {
      return;
    }

    const squadrons = collectSquadrons();
    els.squadronPageCount.textContent = `${squadrons.length} squadron${squadrons.length === 1 ? "" : "s"}`;

    if (!squadrons.length) {
      els.squadronLogoGrid.innerHTML = '<div class="empty-state compact">Add squadron entries to populate this page.</div>';
      els.squadronDetail.innerHTML = '<div class="empty-state">Squadron photos will appear here once entries are added.</div>';
      return;
    }

    els.squadronLogoGrid.innerHTML = renderSquadronCountrySections(squadrons);
    renderSquadronDetail(squadrons);
  }

  function renderSquadronCountrySections(squadrons) {
    return groupSquadronsByCountry(squadrons)
      .map(
        (group) => `
          <section class="squadron-country-section">
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
    const heroImage = squadron.heroPhoto ? squadron.heroPhoto.thumbnail || squadron.heroPhoto.image || "" : "";
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
    const heroImage = squadron.heroPhoto ? squadron.heroPhoto.image || squadron.heroPhoto.thumbnail || "" : "";
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
      ${renderSquadronPhotoGrid(photos)}
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

  function renderExifCountList(title, counts) {
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
                <div class="exif-bar-row">
                  <span class="exif-bar-label">${escapeHtml(item.label)}</span>
                  <span class="exif-bar-track" aria-hidden="true"><span style="width: ${width}%"></span></span>
                  <span class="exif-bar-count">${item.count}</span>
                </div>
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

    if (options.updateHash !== false) {
      updateDeepLink("location", pinId);
    }

    if (options.pan !== false) {
      focusMapPin(pinId);
    }

    if (isMobileMapLayout() && options.openPanel !== false) {
      setMapPanel("results");
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
      iconSize: [340, 54],
      iconAnchor: [15, 27]
    });
  }

  function mapPinLabel(pin) {
    return isMobileMapLayout() && pin.icao ? pin.icao : pin.name;
  }

  function mapClusterLabel(pins) {
    const labels = unique(pins.map(mapPinLabel));
    return labels.length <= 3
      ? labels.join(" / ")
      : `${labels.slice(0, 2).join(" / ")} / +${labels.length - 2}`;
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
      iconSize: [380, 58],
      iconAnchor: [18, 29]
    });
  }

  function renderMapMarkerLabel(title, preview) {
    return `
      <span class="spotterdex-marker-label">
        <span class="spotterdex-marker-title">${escapeHtml(title)}</span>
        ${renderMapMarkerLogos(preview.logos)}
        ${renderMapMarkerFamilies(preview.families)}
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
      return { id: "helicopter", label: "Helicopter", icon: "assets/icons/aircraft-family-helicopter.png" };
    }
    if (/\bf-?\d|fighter|eagle|falcon|hornet|raptor|typhoon|rafale|mirage/.test(type)) {
      return { id: "fighter", label: "Fighter", icon: "assets/icons/aircraft-family-fighter.png" };
    }
    if (/747|sentry|airlift|cargo|transport|tanker|freighter|heavy|c-2|ec-2|rc-2|u-125/.test(type)) {
      return { id: "heavy", label: "Heavy", icon: "assets/icons/aircraft-family-heavy.png" };
    }
    return null;
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

    const pins = state.data.pins.filter((pin) => pin.enabled);
    if (!pins.length) {
      state.map.setView([20, 0], 2);
      return;
    }

    const bounds = window.L.latLngBounds(pins.map((pin) => [pin.lat, pin.lon]));
    state.map.fitBounds(bounds, {
      ...mapFitPadding(),
      maxZoom: 9,
      animate: true
    });

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
    if (style.display === "none" || style.visibility === "hidden") {
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
        : viewerContext === "squadron"
          ? currentSquadronPhotoIds()
          : viewerContext === "photo"
            ? [photoId]
            : currentMapPhotoIds();
    state.activePhotoIds = collection.includes(photoId) ? collection : [photoId];
    state.activePhotoIndex = Math.max(0, state.activePhotoIds.indexOf(photoId));
    state.activePhotoContext = viewerContext;
    state.viewerInfoOpen = false;

    els.photoViewer.hidden = false;
    document.body.style.overflow = "hidden";
    updateViewerInfoState();
    renderViewerPhoto();

    if (options.updateHash !== false) {
      updateDeepLink("photo", photoId);
    }
  }

  function closeViewer(options = {}) {
    els.photoViewer.hidden = true;
    document.body.style.overflow = "";
    setViewerInfoOpen(false);

    if (options.updateHash !== false) {
      updateDeepLinkForViewerContext();
    }
  }

  function stepPhoto(offset) {
    if (!state.activePhotoIds.length) {
      return;
    }
    state.activePhotoIndex = (state.activePhotoIndex + offset + state.activePhotoIds.length) % state.activePhotoIds.length;
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
    els.viewerKicker.textContent = `${state.activePhotoIndex + 1} of ${state.activePhotoIds.length}`;
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
    updateViewerInfoState();
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
