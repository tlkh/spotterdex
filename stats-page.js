// Route-only Stats rendering. Loaded before script.js so these declarations
// share the classic-script global lexical environment without a bundler.
let statsExifRenderPromise = null;
let statsExifObserver = null;

function observeStatsExifSection() {
  if (!els.exifDashboard || state.statsExifReady) {
    return;
  }
  els.exifDashboard.innerHTML = '<div class="empty-state compact stats-exif-placeholder">Camera data loads when this section is opened.</div>';
  if (!("IntersectionObserver" in window)) {
    return;
  }
  statsExifObserver?.disconnect();
  statsExifObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) {
      return;
    }
    statsExifObserver?.disconnect();
    statsExifObserver = null;
    ensureStatsExifRendered();
  }, { rootMargin: "480px 0px" });
  statsExifObserver.observe(els.exifDashboard);
}

function mergeStatsExif(exifBundle) {
  const exifByPhotoId = exifBundle?.photos || {};
  state.data.photos.forEach((photo) => {
    photo.exif = exifByPhotoId[photo.id] || {};
  });
  state.statsExifReady = true;
}

function ensureStatsExifRendered() {
  if (!els.exifDashboard) {
    return Promise.resolve();
  }
  if (state.statsExifReady) {
    renderExifDashboard();
    return Promise.resolve();
  }
  if (statsExifRenderPromise) {
    return statsExifRenderPromise;
  }
  els.exifDashboard.setAttribute("aria-busy", "true");
  els.exifDashboard.innerHTML = '<div class="empty-state compact stats-exif-placeholder">Loading camera data…</div>';
  statsExifRenderPromise = loadStatsExifBundle().then((bundle) => {
    if (!bundle) {
      els.exifDashboard.innerHTML = '<div class="empty-state compact">Camera data is unavailable right now.</div>';
      return;
    }
    mergeStatsExif(bundle);
    renderStatsArchiveHero();
    renderExifDashboard();
  }).finally(() => {
    els.exifDashboard.removeAttribute("aria-busy");
  });
  return statsExifRenderPromise;
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
    const exifHero = statsAtLimitsRecords(state.data.photos.filter(hasCameraExif))
      .flatMap((record) => record.photos || [record.photo])
      .filter((photo) => photo && (photo.image || photo.thumbnail))
      .sort(sortPhotos)[0] || null;
    const heroPhoto = exifHero || state.data.photos
      .filter((photo) => photo.image || photo.thumbnail)
      .slice()
      .sort(sortPhotos)[0] || null;

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
                  <span class="aircraft-family-segment-icon"><img src="${escapeAttr(asset.darkIcon)}" alt="" aria-hidden="true" width="64" height="64" decoding="async"></span>
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
    const records = statsAtLimitsRecords(photos);

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

  function statsAtLimitsRecords(photos) {
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
        `${frameCountLabel(smallestAperture.photos.length)} · extreme exposure control`,
        smallestAperture,
        "aperture-value",
        smallestAperture.value
      ));
    }

    return records;
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
      photos: result.photos || [result.photo],
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
