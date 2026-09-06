// Route-only map rendering. The heavy map runtime and decorative traffic are
// deliberately phased after the archive shell has painted.
let mapTrafficIdleHandle = null;

function createMapCircleSprite(size = 11) {
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size / 2 - 0.75;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const distance = Math.hypot(x - center, y - center);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      data[offset] = 101;
      data[offset + 1] = 101;
      data[offset + 2] = 101;
      data[offset + 3] = Math.round(255 * coverage);
    }
  }
  return { width: size, height: size, data };
}

function installMissingMapSprites(vectorMap) {
  vectorMap.on("styleimagemissing", ({ id }) => {
    if (id !== "circle-11" || vectorMap.hasImage(id)) {
      return;
    }
    vectorMap.addImage(id, createMapCircleSprite());
  });
}

function scheduleMapInitialization() {
  window.requestAnimationFrame(() => {
    const start = () => initializeMapWhenReady();
    if (window.requestIdleCallback) {
      window.requestIdleCallback(start, { timeout: 450 });
    } else {
      window.setTimeout(start, 80);
    }
  });
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
      installMissingMapSprites(vectorMap);

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
    if (options.refreshTraffic) {
      renderMapTraffic(true);
    } else {
      scheduleMapTraffic();
    }
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

  function mapTrafficIsAllowed() {
    const connection = navigator.connection;
    return !connection?.saveData
      && !["slow-2g", "2g"].includes(connection?.effectiveType)
      && !isReducedMotion();
  }

  function scheduleMapTraffic() {
    if (state.mapTrafficInitialized || mapTrafficIdleHandle !== null || !mapTrafficIsAllowed()) {
      return;
    }
    const render = () => {
      mapTrafficIdleHandle = null;
      renderMapTraffic();
    };
    if (window.requestIdleCallback) {
      mapTrafficIdleHandle = window.requestIdleCallback(render, { timeout: 1400 });
    } else {
      mapTrafficIdleHandle = window.setTimeout(render, 320);
    }
  }

  function renderMapTraffic(force = false) {
    if (!state.mapTrafficLayer || !window.L) {
      return;
    }
    if (!mapTrafficIsAllowed()) {
      stopMapTrafficFamilyRotation();
      state.mapTrafficLayer.clearLayers();
      state.mapTrafficInitialized = false;
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
      : desktopMapTrafficPins();
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

  function desktopMapTrafficPins() {
    // Keep the desktop map atmospheric without animating every enabled pin.
    // Hashing the IDs gives a stable, catalog-order-independent sample.
    return state.enabledPins
      .filter((pin) => mapLocationPreview([pin]).families.length)
      .slice()
      .sort((a, b) => stableHash(a.id) - stableHash(b.id) || a.id.localeCompare(b.id))
      .slice(0, DESKTOP_MAP_TRAFFIC_PIN_LIMIT);
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
        ${renderMapLocationFrameRail(photos)}
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

  function renderMapLocationFrameRail(photos) {
    const frames = (photos || [])
      .filter((photo) => photo && (photo.thumbnail || photo.image))
      .slice()
      .sort(sortPhotos)
      .slice(0, 6);
    if (!frames.length) {
      return "";
    }
    return `
      <section class="location-frame-rail-section" aria-labelledby="locationFrameRailHeading">
        <div class="location-frame-rail-heading">
          <h3 id="locationFrameRailHeading">Latest frames</h3>
          <span>${frames.length}</span>
        </div>
        <div class="location-frame-rail" data-location-frame-rail tabindex="0" aria-label="Latest photographs from this location">
          ${frames.map((photo) => `
            <button
              class="location-frame-card"
              type="button"
              data-photo-id="${escapeAttr(photo.id)}"
              data-photo-context="map"
              aria-label="Open ${escapeAttr(photoSubjectLabel(photo))}, ${escapeAttr(displayPhotoDate(photo))}"
            >
              ${renderResponsivePhotoImage(photo, `${photoSubjectLabel(photo)} at ${photo.locationName}`, {
                className: "location-frame-image",
                sizes: "(max-width: 1040px) 154px, 145px"
              })}
              <span class="location-frame-card-copy">
                <strong>${escapeHtml(photoSubjectLabel(photo))}</strong>
                <small>${escapeHtml(displayPhotoDate(photo))}</small>
              </span>
            </button>
          `).join("")}
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
        return {
          key: `type-${photo.aircraftId || normalizeKey(title)}`,
          title,
          eyebrow: "Aircraft type",
          logo: "",
          aircraftId: photo.aircraftId || ""
        };
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
    const aircraftId = group.aircraftId || latest?.aircraftId || "";

    return `
      <article class="location-type-group${isExpanded ? " is-expanded" : ""}">
        ${aircraftId
          ? `<button
              class="location-type-photo-link"
              type="button"
              data-aircraft-id="${escapeAttr(aircraftId)}"
              data-aircraft-group="location"
              data-aircraft-location-id="${escapeAttr(pin.id)}"
              aria-label="Open ${escapeAttr(`${group.title} aircraft page`)}"
            >
              <span class="location-type-latest">
                ${image ? `<img data-deferred-src="${escapeAttr(image)}" alt="">` : '<span class="location-type-fallback">No photo</span>'}
              </span>
            </button>`
          : `<span class="location-type-latest">
              ${image ? `<img data-deferred-src="${escapeAttr(image)}" alt="">` : '<span class="location-type-fallback">No photo</span>'}
            </span>`}
        <button
          class="location-type-toggle"
          type="button"
          data-location-group-key="${escapeAttr(groupKey)}"
          aria-expanded="${isExpanded ? "true" : "false"}"
          aria-controls="location-group-${escapeAttr(slugify(groupKey))}"
        >
          <span class="location-type-copy">
            <strong>${escapeHtml(group.title)}</strong>
            <span class="location-type-meta">
              <span>${escapeHtml(photoCount)}</span>
              <span aria-hidden="true">↗</span>
            </span>
          </span>
        </button>
        ${
          isExpanded
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
