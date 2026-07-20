    const $ = (id) => document.getElementById(id);
    const tabAliases = {
      entries: "aircraft-database",
      "squadron-sources": "squadron-database",
      "aircraft-sources": "aircraft-database",
      locations: "location-heroes"
    };
    const savedTab = sessionStorage.getItem("spotterdex-manager.activeTab") || "attach";
    const savedActiveTab = tabAliases[savedTab] || savedTab;
    const state = {
      data: null,
      selectedAssets: new Set(),
      selectedIssueKey: "",
      assetFilter: "untagged",
      activeTab: savedActiveTab,
      assetsOpen: true,
      masterPage: 1,
      masterPageSize: 20,
      bulkEdit: {
        master: new Set(),
        tagged: new Set()
      },
      qualityShowAcknowledged: false,
      qualityFilter: "hard",
      qualityPollTimer: null,
      qualityPollInFlight: false,
      captionAssist: {
        attachAssetPath: "",
        editPhotoKey: "",
        missingPhotoKey: ""
      },
      thumbnailCacheNonce: "",
      bulkCaptions: {
        queue: null,
        results: {},
        running: false,
        excludeAi: true
      },
      orphans: {
        scanned: false,
        ready: false,
        items: [],
        message: ""
      },
      airshowStoryEventId: "",
      airshowStoryDraft: null,
      airshowStoryDirty: false,
      draggedStoryMoment: -1,
      airshowStorySelection: new Set(),
      airshowPreviewWindow: null
    };
    const viewMeta = {
      attach: ["Attach Photos", "Tag new raw images and maintain their catalog metadata."],
      master: ["Master Photo List", "Search and edit every photo record from one workspace."],
      "squadron-database": ["Squadron Database", "Create and maintain unit-level photo records."],
      "aircraft-database": ["Aircraft Database", "Create and maintain aircraft–squadron photo records."],
      "locations-database": ["Locations", "Create and maintain catalog locations and map metadata."],
      writeups: ["Page Write-ups", "Edit optional Markdown content for aircraft, squadron, and airshow pages."],
      "bulk-captions": ["Caption Review", "Generate and review caption suggestions for selected photos."],
      missing: ["Missing Fields", "Resolve incomplete catalog metadata from a focused queue."],
      quality: ["Source Quality", "Review image dimensions and conservative quality warnings."],
      airshows: ["Airshows", "Manage event dates, photo assignments, and featured images."],
      squadrons: ["Squadron Heroes", "Choose the featured image for each squadron."],
      "location-heroes": ["Location Heroes", "Choose featured images for each catalog location."],
      aircraft: ["Aircraft", "Configure aircraft heroes and card widths."],
      build: ["Build & Publish", "Validate the catalog, build the site, and clean generated files."]
    };
    const missingFieldLabels = {
      source: "Source image",
      location: "Location",
      caption: "Caption",
      captureDate: "Date or EXIF",
      aircraftType: "Aircraft type",
      aircraftFamily: "Aircraft family",
      squadronName: "Unit name",
      squadronLogo: "Squadron logo",
      country: "Country"
    };

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function thumbUrl(path) {
      const cache = state.thumbnailCacheNonce ? `&cache=${encodeURIComponent(state.thumbnailCacheNonce)}` : "";
      return `/api/thumb?path=${encodeURIComponent(path)}${cache}`;
    }

    function rawAssetUrl(path) {
      return `/api/raw?path=${encodeURIComponent(path)}`;
    }

    function selectedEntry() {
      const value = $("entrySelect").value;
      return entryByTargetKey(value);
    }

    function selectedPin(selectId = "pinSelect") {
      const value = $(selectId).value;
      return state.data?.pins.find((pin) => pin.key === value) || null;
    }

    function pinOptionLabel(pin) {
      const code = pin.icao ? `${pin.icao} - ` : "";
      return `${code}${pin.name} (${pin.country})`;
    }

    function entryOptionLabel(entry) {
      if (entry.sourceScope === "location") {
        return `Location - ${entry.locationName} (${entry.country || "Unknown"})`;
      }
      if (entry.sourceScope === "squadron-target") {
        return `Squadron-only - ${entry.squadronName} (${entry.country || "Unknown"})`;
      }
      const prefix = entry.sourceScope === "squadron" ? "Squadron-only" : entry.aircraftType;
      return `${prefix} - ${entry.squadronName} (${entry.country || "Unknown"})`;
    }

    function entryRequestFields(entry) {
      return {
        scope: entry.sourceScope || "aircraft",
        entryPath: entry.entryPath,
        targetPinId: entry.sourceScope === "location" ? entry.pinId : ""
      };
    }

    function squadronOnlyTargets() {
      const entries = state.data?.entries || [];
      const standaloneKeys = new Set(entries
        .filter((entry) => entry.sourceScope === "squadron")
        .map((entry) => `${String(entry.country || "").trim().toLowerCase()}::${String(entry.squadronName || "").trim().toLowerCase()}`));
      return (state.data?.squadronGroups || [])
        .filter((group) => {
          const key = `${String(group.country || "").trim().toLowerCase()}::${String(group.name || "").trim().toLowerCase()}`;
          return !standaloneKeys.has(key);
        })
        .map((group) => {
          const source = entries.find((entry) => (
            entry.sourceScope !== "location"
            && String(entry.country || "").trim().toLowerCase() === String(group.country || "").trim().toLowerCase()
            && String(entry.squadronName || "").trim().toLowerCase() === String(group.name || "").trim().toLowerCase()
          ));
          return {
            targetKey: `squadron-target::${group.key}`,
            sourceScope: "squadron-target",
            entryPath: "",
            aircraftType: "",
            squadronName: group.name,
            country: group.country,
            unitType: source?.unitType || "squadron",
            squadronLogo: "",
            photoCount: 0,
            missingPhotoCount: 0,
            photos: []
          };
        });
    }

    function squadronTargetPayload(entry) {
      return {
        squadronName: entry.squadronName,
        country: entry.country,
        unitType: entry.unitType || "squadron",
        squadronLogo: entry.squadronLogo || ""
      };
    }

    function attachTargetRequestFields(entry) {
      return entry?.sourceScope === "squadron-target"
        ? {squadronTarget: squadronTargetPayload(entry)}
        : entryRequestFields(entry);
    }

    async function readApiJson(response) {
      const contentType = response.headers.get("content-type") || "";
      const raw = await response.text();
      if (!contentType.includes("application/json")) {
        throw new Error(raw.trim().slice(0, 300) || `Request failed: ${response.status}`);
      }
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`The server returned invalid JSON (${response.status}).`);
      }
    }

    async function api(path, body = null) {
      const options = body ? {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
      } : {};
      const response = await fetch(path, options);
      const payload = await readApiJson(response);
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || `Request failed: ${response.status}`);
      }
      return payload;
    }

    async function loadState(keepSelection = true) {
      const previous = keepSelection ? new Set(state.selectedAssets) : new Set();
      const response = await fetch("/api/state");
      state.data = await readApiJson(response);
      state.selectedAssets = new Set([...previous].filter((path) => state.data.assets.some((asset) => asset.path === path)));
      const validMasterPhotoIds = new Set((state.data.masterPhotos || []).map((photo) => photo.id));
      state.bulkEdit.master = new Set([...state.bulkEdit.master].filter((photoId) => validMasterPhotoIds.has(photoId)));
      const validTaggedKeys = new Set();
      for (const entry of state.data.entries || []) {
        for (const photo of entry.photos || []) {
          if (!photo.invalid) validTaggedKeys.add(photoSelectionKey(entry, photo));
        }
      }
      state.bulkEdit.tagged = new Set([...state.bulkEdit.tagged].filter((key) => validTaggedKeys.has(key)));
      renderShared();
      renderActiveView();
      syncQualityPolling();
    }

    function qualityScanActive() {
      const status = state.data?.quality?.status;
      return status === "running" || status === "queued";
    }

    function qualityProgressMessage() {
      const quality = state.data?.quality || {};
      if (qualityScanActive()) {
        const completed = Number(quality.completed || 0);
        const total = Number(quality.total || 0);
        return total
          ? `Quality check is running in the background (${completed} of ${total} source photos checked). Results will appear here automatically.`
          : "Quality check is running in the background. Results will appear here automatically.";
      }
      if (quality.status === "error") return quality.message || "The background quality check failed.";
      return "";
    }

    function syncQualityPolling() {
      if (!qualityScanActive()) {
        if (state.qualityPollTimer) window.clearInterval(state.qualityPollTimer);
        state.qualityPollTimer = null;
        return;
      }
      if (!state.qualityPollTimer) {
        state.qualityPollTimer = window.setInterval(() => pollQualityStatus(), 800);
      }
    }

    async function pollQualityStatus() {
      if (state.qualityPollInFlight || !state.data) return;
      state.qualityPollInFlight = true;
      try {
        const payload = await api("/api/quality-status");
        state.data.quality = payload.quality || state.data.quality;
        if (state.data.quality?.status === "ready") {
          await loadState(true);
          return;
        }
        renderStats();
        if (state.activeTab === "quality") renderQualityControl();
      } catch (error) {
        if (state.qualityPollTimer) window.clearInterval(state.qualityPollTimer);
        state.qualityPollTimer = null;
        if (state.activeTab === "quality") renderQualityControl();
      } finally {
        state.qualityPollInFlight = false;
        syncQualityPolling();
      }
    }

    function renderShared() {
      renderStats();
      renderAssetGrid();
      renderEntryOptions();
      renderEditTagTargetOptions();
      renderPinOptions();
      renderSelectedStrip();
    }

    function renderActiveView() {
      if (!state.data) return;
      const renderers = {
        attach: renderEntryDetail,
        master: renderMasterView,
        "squadron-database": renderSquadronSourcePage,
        "aircraft-database": renderAircraftSourceCards,
        "locations-database": renderLocationDatabase,
        writeups: renderWriteUpEditor,
        "bulk-captions": renderBulkCaptions,
        airshows: () => { renderAirshowStoryManager(); renderAirshowHeroManager(); renderAirshowMissingImages(); renderBulkEvents(); },
        missing: renderMissingFields,
        quality: renderQualityControl,
        "location-heroes": renderLocationHeroManager,
        squadrons: renderSquadronHeroManager,
        aircraft: renderAircraftSettings,
        build: renderOrphans
      };
      renderers[state.activeTab]?.();
    }

    function writeUpEntities(type = $("writeUpType")?.value || "aircraft") {
      if (type === "squadron") {
        return (state.data?.squadronGroups || []).map((item) => ({id: item.unitId, name: `${item.name} (${item.country})`, writeUp: item.writeUp || ""})).filter((item) => item.id);
      }
      if (type === "airshow") {
        return (state.data?.airshowEvents || []).map((item) => ({id: item.id, name: item.name, writeUp: item.writeUp || ""}));
      }
      return (state.data?.aircraftCatalog || []).map((item) => ({id: item.id, name: item.name, writeUp: item.writeUp || ""}));
    }

    function renderWriteUpEditor(preferredId = "") {
      const type = $("writeUpType").value;
      const entities = writeUpEntities(type);
      const previousId = preferredId || $("writeUpEntity").value;
      $("writeUpEntity").innerHTML = entities.length
        ? entities.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.writeUp ? " · written" : ""}</option>`).join("")
        : '<option value="">No pages available</option>';
      if (entities.some((item) => item.id === previousId)) $("writeUpEntity").value = previousId;
      loadSelectedWriteUp();
    }

    function loadSelectedWriteUp() {
      const entity = writeUpEntities().find((item) => item.id === $("writeUpEntity").value);
      $("writeUpMarkdown").value = entity?.writeUp || "";
      renderWriteUpPreview();
      $("saveWriteUpBtn").disabled = !entity;
    }

    function renderWriteUpPreview() {
      const markdown = $("writeUpMarkdown").value.trim();
      if (!markdown) {
        $("writeUpPreview").innerHTML = '<p class="subtle">Nothing to preview yet.</p>';
        return;
      }
      const blocks = markdown.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => {
        const heading = block.match(/^(#{2,4})\s+(.+)$/s);
        if (heading && !heading[2].includes("\n")) return `<h${heading[1].length}>${managerMarkdownInline(heading[2])}</h${heading[1].length}>`;
        const lines = block.split("\n");
        if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${managerMarkdownInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
        return `<p>${lines.map(managerMarkdownInline).join("<br>")}</p>`;
      });
      $("writeUpPreview").innerHTML = blocks.join("");
    }

    function managerMarkdownInline(value) {
      let html = escapeHtml(value);
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
      html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return html;
    }

    async function saveWriteUp() {
      const entityType = $("writeUpType").value;
      const entityId = $("writeUpEntity").value;
      if (!entityId) return;
      const button = $("saveWriteUpBtn");
      button.disabled = true;
      try {
        const result = await api("/api/update-write-up", {entityType, entityId, writeUp: $("writeUpMarkdown").value});
        await loadState(true);
        $("writeUpType").value = entityType;
        renderWriteUpEditor(entityId);
        toast(result.message);
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    }

    function renderStats() {
      const project = state.data.project;
      $("projectRoot").textContent = project.root;
      $("stats").innerHTML = [
        ["Assets", project.assetCount],
        ["New", project.untaggedAssetCount],
        ["Aircraft", project.aircraftCount],
        ["Units", project.squadronEntryCount || 0],
        ["Locations", project.pinCount || project.locationEntryCount || 0],
        ["Database", project.databaseIntegrity === "ok" && project.sqlSnapshotCurrent ? "Healthy" : "Review",
          project.databaseIntegrity === "ok" && project.sqlSnapshotCurrent ? "status-good" : "status-warn"]
      ].map(([label, value, status = ""]) => `<span class="pill ${status}">${label}<strong>${value}</strong></span>`).join("");
      const missingCount = (project.missingPhotoCount || 0)
        + (project.missingFieldPhotoCount || 0)
        + (project.missingEntryFieldCount || 0);
      $("newAssetNavBadge").textContent = project.untaggedAssetCount || 0;
      $("missingNavBadge").textContent = missingCount;
      $("qualityNavBadge").textContent = qualityScanActive()
        ? "…"
        : project.qualityIssueAssetCount || 0;
    }

    function assetMatchesSearch(asset, term) {
      if (!term) return true;
      const haystack = [
        asset.path,
        asset.name,
        asset.extension,
        asset.captureDate,
        ...asset.tags.flatMap((tag) => [tag.kind, tag.label, tag.location, tag.path])
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    }

    function filteredAssets() {
      const term = $("assetSearch").value.trim().toLowerCase();
      return state.data.assets.filter((asset) => {
        if (state.assetFilter === "untagged" && asset.tags.length) return false;
        if (state.assetFilter === "tagged" && !asset.tags.length) return false;
        return assetMatchesSearch(asset, term);
      });
    }

    function renderAssetCard(asset) {
      const selected = state.selectedAssets.has(asset.path) ? " selected" : "";
      const tag = asset.tags.length
        ? `<span class="tag">${escapeHtml(asset.tags[0].kind)}</span>`
        : `<span class="tag warn">new</span>`;
      const captureLine = asset.captureDate ? `Captured: ${asset.captureDate}` : "No capture date";
      const tagLines = asset.tags.map((item) => `${item.kind}: ${item.label || item.path || ""}`);
      const title = [captureLine, ...tagLines].join("\n");
      const resolutionTag = asset.isUnderResolution
        ? `<span class="tag warn">${escapeHtml(asset.dimensionsLabel)}</span>`
        : `<span class="asset-dim">${escapeHtml(asset.dimensionsLabel)}</span>`;
      const qualityTags = (asset.qualityFlags || []).filter((flag) => flag.severity !== "info").map((flag) => {
        const short = flag.short || flag.label || "Quality";
        const detail = [flag.label, flag.detail].filter(Boolean).join(" - ");
        return `<span class="tag warn" title="${escapeHtml(detail)}">${escapeHtml(short)}</span>`;
      }).join("");
      return `
        <article class="asset-card${selected}">
          <button class="asset-select" type="button" data-asset="${escapeHtml(asset.path)}" aria-pressed="${state.selectedAssets.has(asset.path)}" title="${escapeHtml(title)}">
            <img src="${thumbUrl(asset.path)}" loading="lazy" alt="${escapeHtml(asset.name)}">
            <div class="asset-name">${escapeHtml(asset.name)}</div>
            <div class="asset-meta"><span class="asset-size">${escapeHtml(asset.sizeLabel)}</span>${resolutionTag}${qualityTags}${tag}</div>
          </button>
          <button class="asset-preview" type="button" data-asset-preview="${escapeHtml(asset.path)}">Open full preview</button>
        </article>
      `;
    }

    function renderAssetGrid() {
      const assets = filteredAssets();
      $("selectedCount").textContent = `${state.selectedAssets.size} selected`;
      $("attachSummary").textContent = state.selectedAssets.size
        ? `${state.selectedAssets.size} asset(s) selected`
        : "No assets selected";

      if (!assets.length) {
        $("assetGrid").innerHTML = `<div class="empty">No matching assets</div>`;
        return;
      }

      const grouped = new Map();
      for (const asset of assets) {
        const date = asset.captureDate || "undated";
        if (!grouped.has(date)) grouped.set(date, []);
        grouped.get(date).push(asset);
      }
      const orderedGroups = [...grouped.entries()].sort(([left], [right]) => {
        if (left === "undated") return 1;
        if (right === "undated") return -1;
        return right.localeCompare(left);
      });
      $("assetGrid").innerHTML = orderedGroups.map(([date, dateAssets]) => `
        <section class="asset-date-group" aria-labelledby="asset-date-${escapeHtml(date)}">
          <div class="asset-date-heading">
            <h3 id="asset-date-${escapeHtml(date)}">${escapeHtml(date === "undated" ? "Undated" : formatEventDate(date))}</h3>
            <span class="subtle">${dateAssets.length} image${dateAssets.length === 1 ? "" : "s"}</span>
          </div>
          <div class="asset-date-grid">${dateAssets.map(renderAssetCard).join("")}</div>
        </section>
      `).join("");
    }

    function openAssetPreview(path) {
      const asset = (state.data?.assets || []).find((item) => item.path === path);
      if (!asset) throw new Error("The selected raw asset is no longer available. Reload and try again.");
      const modal = $("assetPreviewModal");
      $("assetPreviewImage").src = rawAssetUrl(asset.path);
      $("assetPreviewImage").alt = asset.name || asset.path;
      $("assetPreviewTitle").textContent = asset.name || "Raw Asset Preview";
      $("assetPreviewMeta").textContent = [
        asset.path,
        asset.dimensionsLabel,
        asset.captureDate ? `Captured ${asset.captureDate}` : "No capture date"
      ].filter(Boolean).join(" · ");
      if (typeof modal.showModal === "function") modal.showModal();
      else modal.setAttribute("open", "");
    }

    function qualityMetricChips(asset, minimum) {
      const chips = [];
      const push = (label, value) => {
        if (value === null || value === undefined || value === "") return;
        chips.push(`<span class="metric-chip"><b>${escapeHtml(label)}</b> ${escapeHtml(String(value))}</span>`);
      };
      push("Dimensions", asset.dimensionsLabel);
      push("Luminance", asset.meanLuminance);
      push("Tonal range", asset.tonalRange);
      if (asset.pureBlackPercent) push("Pure black", `${asset.pureBlackPercent}%`);
      if (asset.pureWhitePercent) push("Pure white", `${asset.pureWhitePercent}%`);
      if (asset.neutralChannelSpread) {
        push("Colour spread", `${asset.neutralChannelSpread}${asset.colourCastDirection ? ` (${asset.colourCastDirection})` : ""}`);
      }
      if (asset.neutralGreenMagentaBias) push("Green/pink bias", asset.neutralGreenMagentaBias);
      if (asset.whiteBalanceChannelSpread) {
        push("WB spread", `${asset.whiteBalanceChannelSpread}${asset.whiteBalanceDirection ? ` (${asset.whiteBalanceDirection})` : ""}`);
      }
      if (asset.whiteBalanceLabDistance) push("WB Δ", `${asset.whiteBalanceLabDistance} LAB`);
      if (asset.collectionColourDistance) {
        push("Collection deviation", `${asset.collectionColourDistance} robust${asset.collectionColourDeviation ? ` (${asset.collectionColourDeviation})` : ""}`);
      }
      if (asset.emptySpacePercent !== null && asset.emptySpacePercent !== undefined) {
        push("Empty space", `${asset.emptySpacePercent}%`);
      }
      push("Acutance", asset.acutance);
      push("Noise residual", asset.noiseResidual);
      if (asset.iso) push("ISO", asset.iso);
      return chips.join("");
    }

    function renderQualityControl() {
      renderQualitySettings();
      const qualityProgress = qualityProgressMessage();
      const flagged = (state.data?.assets || []).filter((asset) => (
        asset.isPhotoSource && (asset.isUnderResolution || (asset.qualityFlags || []).length)
      ));
      const hardFailures = flagged.filter((asset) => asset.hardQualityFailure);
      const warnings = flagged.filter((asset) => !asset.hardQualityFailure);
      const passedQcEdits = (state.data?.assets || []).filter((asset) => asset.qcPrefixPasses);
      const activeQueue = state.qualityFilter === "warnings"
        ? warnings
        : state.qualityFilter === "passed"
          ? passedQcEdits
          : hardFailures;
      const showAcknowledged = state.qualityShowAcknowledged;
      const assets = state.qualityFilter === "passed"
        ? activeQueue
        : activeQueue.filter((asset) => showAcknowledged || !asset.qualityAcknowledged);
      const allPhotoSources = (state.data?.assets || []).filter((asset) => asset.isPhotoSource);
      const project = state.data?.project || {};
      const minimum = project.minimumSourcePhotoWidth || 2560;
      const belowMinimum = project.underResolutionAssetCount || 0;
      const exposure = project.exposureIssueAssetCount || 0;
      const colour = project.colourBalanceIssueAssetCount || 0;
      const emptySpace = project.emptySpaceIssueAssetCount || 0;
      const acknowledged = project.acknowledgedQualityCount || 0;
      const hardPrefixNeeded = project.qualityPrefixNeededCount || 0;
      const warningPrefixNeeded = warnings.filter((asset) => asset.needsQcWarningPrefix).length;
      const prefixNeeded = state.qualityFilter === "warnings"
        ? warningPrefixNeeded
        : state.qualityFilter === "passed"
          ? 0
          : hardPrefixNeeded;
      $("qualityShowAcknowledged").checked = showAcknowledged;
      document.querySelectorAll("[data-quality-filter]").forEach((button) => {
        const active = button.dataset.qualityFilter === state.qualityFilter;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      $("qualityHardCount").textContent = hardFailures.length;
      $("qualityWarningCount").textContent = warnings.length;
      $("qualityPassedCount").textContent = passedQcEdits.length;
      $("qualityApprovePassed").hidden = state.qualityFilter !== "passed";
      $("qualityApprovePassed").disabled = qualityScanActive() || passedQcEdits.length === 0;
      $("qualityApprovePassed").textContent = passedQcEdits.length
        ? `Approve ${passedQcEdits.length} passing QC_ image${passedQcEdits.length === 1 ? "" : "s"}`
        : "No passing QC_ images to approve";
      $("qualityPrefixFailures").disabled = qualityScanActive() || prefixNeeded === 0;
      $("qualityPrefixFailures").textContent = prefixNeeded
        ? `Prefix ${prefixNeeded} ${state.qualityFilter === "warnings" ? "warning" : "failure"}${prefixNeeded === 1 ? "" : "s"} with QC_`
        : state.qualityFilter === "passed"
          ? "QC_ edits in this tab already pass"
          : `All ${state.qualityFilter === "warnings" ? "warnings" : "hard failures"} have QC_ prefixes or are reviewed`;
      $("qualitySummary").textContent = qualityProgress || `${flagged.length} of ${allPhotoSources.length} source photograph(s) flagged: ${belowMinimum} below ${minimum}px, ${exposure} exposure, ${colour} colour, ${emptySpace} empty-space advisory. ${acknowledged} marked reviewed; ${hardPrefixNeeded} hard failure(s) need a QC_ filename; ${passedQcEdits.length} QC_ edit(s) now pass all checks.`;
      if (qualityScanActive()) {
        $("qualityList").innerHTML = '<div class="empty">The quality queue will appear when the background scan completes.</div>';
        return;
      }
      if (!assets.length) {
        const reviewedInQueue = activeQueue.filter((asset) => asset.qualityAcknowledged).length;
        const queueLabel = state.qualityFilter === "warnings"
          ? "advisory warnings"
          : state.qualityFilter === "passed"
            ? "QC_ edits that pass all checks"
            : "hard failures";
        const done = reviewedInQueue && !showAcknowledged
          ? `All ${reviewedInQueue} ${queueLabel} have been reviewed. Enable "Show reviewed" to see them.`
          : state.qualityFilter === "passed"
            ? `There are no ${queueLabel}.`
            : `There are no ${queueLabel} to review.`;
        $("qualityList").innerHTML = `<div class="empty">${escapeHtml(done)}</div>`;
        return;
      }
      const severityRank = (asset) => {
        if (asset.isUnderResolution) return 0;
        return (asset.qualityFlags || []).some((flag) => flag.severity !== "info") ? 0 : 1;
      };
      $("qualityList").innerHTML = assets
        .sort((a, b) => (
          Number(a.qualityAcknowledged) - Number(b.qualityAcknowledged)
          || severityRank(a) - severityRank(b)
          || (b.qualityFlags || []).length - (a.qualityFlags || []).length
          || a.width - b.width
          || a.path.localeCompare(b.path)
        ))
        .map((asset) => {
          const isPassedQueue = state.qualityFilter === "passed";
          const associations = asset.tags.length
            ? asset.tags.map((tag) => `${tag.kind}: ${tag.label || tag.path || "Source"}`).join(" · ")
            : "New raw asset";
          const chips = [];
          if (asset.isUnderResolution) {
            chips.push(`<span class="tag warn">${escapeHtml(asset.dimensionsLabel)} - below ${minimum}px</span>`);
          }
          if (asset.qcPrefixApplied) chips.push(`<span class="tag info">QC_ filename applied</span>`);
          if (isPassedQueue) chips.push(`<span class="tag">Passes current checks</span>`);
          for (const flag of asset.qualityFlags || []) {
            const cls = flag.severity === "info" ? "tag info" : "tag warn";
            chips.push(`<span class="${cls}">${escapeHtml(flag.detail || flag.label || "Quality warning")}</span>`);
          }
          const ackClass = asset.qualityAcknowledged ? " acknowledged" : "";
          const ackButton = isPassedQueue
            ? ""
            : asset.qualityAcknowledged
            ? `<button class="btn ghost" type="button" data-quality-unack="${escapeHtml(asset.path)}">Restore to queue</button>`
            : `<button class="btn secondary" type="button" data-quality-ack="${escapeHtml(asset.path)}">Mark reviewed</button>`;
          return `
            <article class="quality-card${ackClass}">
              <img src="${thumbUrl(asset.path)}" loading="lazy" alt="${escapeHtml(asset.name)}">
              <div class="quality-card-copy">
                <strong>${escapeHtml(asset.path)}</strong>
                <div class="quality-tags">${chips.join("")}</div>
                <div class="metric-row">${qualityMetricChips(asset, minimum)}</div>
                <span class="mini-meta">${escapeHtml(associations)}${asset.qualityAcknowledged ? " · reviewed" : ""}</span>
                <div class="card-actions">
                  <button class="btn ghost" type="button" data-quality-select="${escapeHtml(asset.path)}">Review in Attach</button>
                  ${ackButton}
                </div>
              </div>
            </article>
          `;
        }).join("");
    }

    async function acknowledgeQuality(path, acknowledged) {
      const result = await api("/api/acknowledge-quality", {path, acknowledged});
      toast(result.message);
      await loadState(true);
    }

    async function markQualityFailures() {
      const includeWarnings = state.qualityFilter === "warnings";
      const paths = (state.data?.assets || [])
        .filter((asset) => includeWarnings ? asset.needsQcWarningPrefix : asset.needsQcPrefix)
        .map((asset) => asset.path);
      if (!paths.length) return;
      const issueLabel = includeWarnings ? "advisory warning" : "hard QC failure";
      if (!window.confirm(`Rename ${paths.length} ${issueLabel}(s) with a QC_ prefix and update their catalog paths?`)) return;
      const result = await api("/api/mark-quality-failures", {paths, includeWarnings});
      toast(result.message);
      state.selectedAssets.clear();
      await loadState(true);
    }

    async function approvePassingQc() {
      const paths = (state.data?.assets || [])
        .filter((asset) => asset.qcPrefixPasses)
        .map((asset) => asset.path);
      if (!paths.length) return;
      if (!window.confirm(`Approve ${paths.length} passing QC_ image${paths.length === 1 ? "" : "s"} and remove the QC_ tag from their filenames?`)) return;
      const result = await api("/api/approve-passing-qc", {paths});
      state.selectedAssets.clear();
      await loadState(true);
      toast(result.message);
    }

    function renderSelectedStrip() {
      $("assetSelectionBadge").textContent = state.selectedAssets.size;
      const selected = [...state.selectedAssets];
      $("selectedStrip").innerHTML = selected.length
        ? selected.map((path) => `
          <button class="selected-asset" type="button" data-asset-preview="${escapeHtml(path)}" title="Open full preview: ${escapeHtml(path)}">
            <img src="${thumbUrl(path)}" alt="${escapeHtml(path)}">
            <span>${escapeHtml(path)}</span>
          </button>
        `).join("")
        : `<div class="empty">No selected assets</div>`;
    }

    function effectiveEventDate(photo) {
      return String(photo.exifDate || photo.date || photo.year || "").trim();
    }

    function airshowEventKey(value) {
      return String(value || "").trim().toLowerCase();
    }

    function taggedAirshowGroups() {
      const byEvent = new Map();
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (photo.invalid || !String(photo.airshow || "").trim()) continue;
          const name = String(photo.airshow).trim();
          const key = airshowEventKey(name);
          if (!byEvent.has(key)) byEvent.set(key, {name, photos: []});
          byEvent.get(key).photos.push({entry, photo});
        }
      }
      return [...byEvent.values()]
        .map((event) => ({
          ...event,
          photos: event.photos.sort((a, b) => effectiveEventDate(b.photo).localeCompare(effectiveEventDate(a.photo)))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    function configuredAirshowHero(eventName) {
      const key = airshowEventKey(eventName);
      return (state.data?.airshowEvents || []).find((event) => airshowEventKey(event.name) === key)?.hero || {};
    }

    function airshowStoryEvent(eventId = state.airshowStoryEventId) {
      return (state.data?.airshowEvents || []).find((event) => event.id === eventId) || null;
    }

    function airshowStoryPhotos(eventId = state.airshowStoryEventId) {
      return (state.data?.masterPhotos || [])
        .filter((photo) => photo.eventId === eventId)
        .slice()
        .sort((a, b) => {
          const aTime = String(a.capturedAt || a.exifDate || a.date || "");
          const bTime = String(b.capturedAt || b.exifDate || b.date || "");
          return aTime.localeCompare(bTime) || String(a.path || a.id).localeCompare(String(b.path || b.id));
        });
    }

    function storyPhotoSubject(photo) {
      const subjects = Array.isArray(photo?.subjects) ? photo.subjects : [];
      return subjects.find((subject) => subject.isPrimary) || subjects[0] || {};
    }

    function storyPhotoHeadline(photo) {
      const subject = storyPhotoSubject(photo);
      return subject.aircraftType || subject.unitName || "At the show";
    }

    function storyPhotoBody(photo) {
      const subject = storyPhotoSubject(photo);
      return photo.caption || photo.title || subject.unitName || photo.location || "";
    }

    function formatStoryCaptureLabel(value) {
      const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
      if (!match) return "Sequence time unavailable";
      const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1] || match[2];
      const day = String(Number(match[3]));
      return match[4] ? `${day} ${month} · ${match[4]}:${match[5]}` : `${day} ${month}`;
    }

    function cloneStory(value) {
      const copy = JSON.parse(JSON.stringify(value || {mode: "standard", segments: []}));
      const segments = Array.isArray(copy.segments)
        ? copy.segments
        : (Array.isArray(copy.moments) ? copy.moments : []);
      return {
        ...copy,
        segments: segments.map((segment, index) => ({
          ...segment,
          position: index,
          overlaySide: segment.overlaySide === "right" ? "right" : "left",
          photos: Array.isArray(segment.photos) ? segment.photos : []
        }))
      };
    }

    function loadAirshowStoryDraft(eventId, force = false) {
      const event = airshowStoryEvent(eventId);
      if (!event) {
        state.airshowStoryEventId = "";
        state.airshowStoryDraft = {mode: "standard", segments: []};
        state.airshowStoryDirty = false;
        state.airshowStorySelection.clear();
        return;
      }
      if (!force && state.airshowStoryEventId === eventId && state.airshowStoryDraft) return;
      state.airshowStoryEventId = eventId;
      state.airshowStoryDraft = cloneStory(event.story || {mode: event.storyMode || "standard", segments: []});
      state.airshowStoryDraft.mode = event.storyMode || state.airshowStoryDraft.mode || "standard";
      state.airshowStoryDirty = false;
      state.airshowStorySelection.clear();
    }

    function markAirshowStoryDirty() {
      state.airshowStoryDirty = true;
      const event = airshowStoryEvent();
      const count = state.airshowStoryDraft?.segments?.length || 0;
      $("airshowStorySummary").textContent = `${event?.name || "Airshow"} · ${count} segment${count === 1 ? "" : "s"} · Unsaved changes`;
      sendAirshowStoryPreview();
    }

    function storyPhotoCoverage(segments, photos) {
      const eventPhotoIds = new Set(photos.map((photo) => photo.id));
      const owners = new Map();
      for (const [segmentIndex, segment] of segments.entries()) {
        for (const record of segment.photos || []) {
          const photoId = String(record.photoId || "");
          if (!photoId) continue;
          const entries = owners.get(photoId) || [];
          entries.push(segmentIndex);
          owners.set(photoId, entries);
        }
      }
      const assigned = [...owners.keys()].filter((photoId) => eventPhotoIds.has(photoId));
      const duplicates = [...owners.entries()].filter(([, segmentIndexes]) => segmentIndexes.length > 1);
      const invalid = [...owners.keys()].filter((photoId) => !eventPhotoIds.has(photoId));
      return {
        eventPhotoIds,
        owners,
        assigned,
        unassigned: photos.filter((photo) => !owners.has(photo.id)),
        duplicates,
        invalid
      };
    }

    function renderAirshowStoryBulk(segments, photos, coverage) {
      const coverageNode = $("airshowStoryCoverage");
      const pool = $("airshowStoryPhotoPool");
      const target = $("airshowStoryBulkTarget");
      if (!coverageNode || !pool || !target) return;
      const previousTarget = target.value;
      const duplicateCount = coverage.duplicates.length;
      const invalidCount = coverage.invalid.length;
      const warning = coverage.unassigned.length || duplicateCount || invalidCount;
      coverageNode.className = `story-coverage${warning ? " is-warning" : ""}`;
      coverageNode.textContent = `${coverage.assigned.length} of ${photos.length} event photos assigned to the story · ${coverage.unassigned.length} unassigned${duplicateCount ? ` · ${duplicateCount} duplicate assignment${duplicateCount === 1 ? "" : "s"}` : ""}${invalidCount ? ` · ${invalidCount} invalid assignment${invalidCount === 1 ? "" : "s"}` : ""}`;
      target.innerHTML = segments.length
        ? segments.map((segment, index) => `<option value="${index}">${String(index + 1).padStart(2, "0")} · ${escapeHtml(segment.headline || "Untitled segment")}</option>`).join("")
        : '<option value="">No segments available</option>';
      if (segments[Number(previousTarget)]) target.value = previousTarget;
      const validPhotoIds = new Set(photos.map((photo) => photo.id));
      state.airshowStorySelection = new Set([...state.airshowStorySelection].filter((photoId) => validPhotoIds.has(photoId)));
      pool.innerHTML = photos.length
        ? photos.map((photo) => {
          const ownerIndexes = coverage.owners.get(photo.id) || [];
          const ownerLabel = ownerIndexes.length
            ? ownerIndexes.map((index) => `Segment ${index + 1}`).join(", ")
            : "Unassigned";
          const ownerClass = ownerIndexes.length ? "" : " is-unassigned";
          const checked = state.airshowStorySelection.has(photo.id) ? " checked" : "";
          const source = photo.sourceAssetPath ? thumbUrl(photo.sourceAssetPath) : "";
          return `
            <label class="story-photo-pool-item${checked ? " is-selected" : ""}">
              <input type="checkbox" data-story-selection="${escapeHtml(photo.id)}"${checked} aria-label="Select ${escapeHtml(storyPhotoOptionLabel(photo))}">
              ${source ? `<img src="${source}" alt="">` : '<span class="story-photo-pool-thumb"></span>'}
              <span class="story-photo-pool-copy">
                <strong>${escapeHtml(storyPhotoHeadline(photo))}</strong>
                <span>${escapeHtml(formatStoryCaptureLabel(photo.capturedAt || photo.exifDate || photo.date))} · <span class="${ownerClass.trim()}">${escapeHtml(ownerLabel)}</span></span>
              </span>
            </label>
          `;
        }).join("")
        : '<div class="empty">No event photos are available.</div>';
    }

    function sendAirshowStoryPreview() {
      const previewWindow = state.airshowPreviewWindow;
      if (!previewWindow || previewWindow.closed || !state.airshowStoryDraft || !state.airshowStoryEventId) return;
      previewWindow.postMessage({
        type: "spotterdex-story-preview",
        eventId: state.airshowStoryEventId,
        story: cloneStory(state.airshowStoryDraft)
      }, window.location.origin);
    }

    function openAirshowStoryPreview() {
      const event = airshowStoryEvent();
      const draft = state.airshowStoryDraft;
      if (!event || !draft?.segments?.length) {
        toast("Create at least one segment before opening a preview.");
        return;
      }
      const previewUrl = `/preview/airshows.html?storyPreview=1#airshow=${encodeURIComponent(event.id)}`;
      state.airshowPreviewWindow = window.open(previewUrl, "spotterdex-airshow-preview");
      if (!state.airshowPreviewWindow) {
        toast("Allow pop-ups to open the airshow preview.");
        return;
      }
      state.airshowPreviewWindow.focus();
      window.setTimeout(sendAirshowStoryPreview, 300);
    }

    function selectedAirshowStoryPhotoIds() {
      return [...state.airshowStorySelection].filter(Boolean);
    }

    function updateAirshowStorySelection(photoId, selected) {
      if (selected) state.airshowStorySelection.add(photoId);
      else state.airshowStorySelection.delete(photoId);
      renderAirshowStoryManager();
    }

    function selectedStoryTargetSegment() {
      const index = Number($("airshowStoryBulkTarget")?.value);
      return Number.isInteger(index) ? state.airshowStoryDraft?.segments?.[index] || null : null;
    }

    function assignSelectedAirshowPhotos({moveOnly = false} = {}) {
      const selectedIds = new Set(selectedAirshowStoryPhotoIds());
      const target = selectedStoryTargetSegment();
      if (!selectedIds.size || !target) {
        toast("Select photos and a target segment first.");
        return;
      }
      const photos = airshowStoryPhotos();
      const coverage = storyPhotoCoverage(state.airshowStoryDraft.segments || [], photos);
      const moveIds = new Set([...selectedIds].filter((photoId) => !moveOnly || coverage.owners.has(photoId)));
      if (!moveIds.size) {
        toast("Move selected requires photos already assigned to a segment.");
        return;
      }
      const moved = [];
      for (const segment of state.airshowStoryDraft.segments || []) {
        const keep = [];
        for (const record of segment.photos || []) {
          if (moveIds.has(record.photoId)) moved.push(record);
          else keep.push(record);
        }
        segment.photos = keep;
      }
      const movedIds = new Set(moved.map((record) => record.photoId));
      for (const photo of photos) {
        if (moveIds.has(photo.id) && !movedIds.has(photo.id)) {
          moved.push({photoId: photo.id, focalX: 0.5, focalY: 0.5, motion: "auto"});
        }
      }
      target.photos = [...(target.photos || []), ...moved];
      state.airshowStoryDraft.segments = (state.airshowStoryDraft.segments || [])
        .filter((segment) => segment === target || (segment.photos || []).length)
        .map((segment, index) => ({...segment, position: index}));
      state.airshowStorySelection.clear();
      markAirshowStoryDirty();
      renderAirshowStoryManager();
    }

    function sortTargetAirshowPhotos() {
      const target = selectedStoryTargetSegment();
      if (!target) {
        toast("Choose a target segment first.");
        return;
      }
      const photoById = new Map(airshowStoryPhotos().map((photo) => [photo.id, photo]));
      target.photos = (target.photos || []).slice().sort((a, b) => {
        const aPhoto = photoById.get(a.photoId);
        const bPhoto = photoById.get(b.photoId);
        return String(aPhoto?.capturedAt || aPhoto?.exifDate || aPhoto?.date || "").localeCompare(String(bPhoto?.capturedAt || bPhoto?.exifDate || bPhoto?.date || "")) || String(a.photoId).localeCompare(String(b.photoId));
      });
      markAirshowStoryDirty();
      renderAirshowStoryManager();
    }

    function removeDuplicateAirshowPhotos() {
      const seen = new Set();
      let removed = 0;
      for (const segment of state.airshowStoryDraft?.segments || []) {
        segment.photos = (segment.photos || []).filter((record) => {
          if (seen.has(record.photoId)) {
            removed += 1;
            return false;
          }
          seen.add(record.photoId);
          return true;
        });
      }
      state.airshowStoryDraft.segments = (state.airshowStoryDraft.segments || [])
        .filter((segment) => (segment.photos || []).length)
        .map((segment, index) => ({...segment, position: index}));
      if (!removed) {
        toast("No duplicate story photo assignments found.");
        return;
      }
      markAirshowStoryDirty();
      renderAirshowStoryManager();
      toast(`Removed ${removed} duplicate photo assignment${removed === 1 ? "" : "s"}.`);
    }

    function storyPhotoOptionLabel(photo) {
      return `${formatStoryCaptureLabel(photo.capturedAt || photo.exifDate || photo.date)} — ${storyPhotoHeadline(photo)}${storyPhotoSubject(photo).unitName ? ` / ${storyPhotoSubject(photo).unitName}` : ""}`;
    }

    function renderAirshowStoryManager() {
      const events = (state.data?.airshowEvents || []).filter((event) => (
        (state.data?.masterPhotos || []).some((photo) => photo.eventId === event.id)
      ));
      const previousEventId = state.airshowStoryEventId;
      $("airshowStoryEvent").innerHTML = events.length
        ? events.map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name)}</option>`).join("")
        : '<option value="">No events with photos</option>';
      const nextEventId = events.some((event) => event.id === previousEventId) ? previousEventId : events[0]?.id || "";
      $("airshowStoryEvent").value = nextEventId;
      loadAirshowStoryDraft(nextEventId);

      const event = airshowStoryEvent();
      const draft = state.airshowStoryDraft || {mode: "standard", segments: []};
      const segments = draft.segments || [];
      const photos = airshowStoryPhotos();
      $("airshowStoryEnabled").checked = draft.mode === "cinematic";
      $("airshowStoryEnabled").disabled = !event;
      $("generateAirshowStoryBtn").disabled = !event || photos.length < 2;
      const usedPhotoCount = new Set(segments.flatMap((segment) => (segment.photos || []).map((photo) => photo.photoId))).size;
      $("addAirshowStoryMomentBtn").disabled = !event || usedPhotoCount >= photos.length;
      $("previewAirshowStoryBtn").disabled = !event || !segments.length;
      $("resetAirshowStoryBtn").disabled = !event || !state.airshowStoryDirty;
      $("saveAirshowStoryBtn").disabled = !event || !state.airshowStoryDirty;
      if (!event) {
        $("airshowStorySummary").textContent = "Tag at least two photos with an event to build cinematic segments.";
        $("airshowStoryCoverage").textContent = "No airshow event selected.";
        $("airshowStoryPhotoPool").innerHTML = "";
        $("airshowStoryBulkTarget").innerHTML = '<option value="">No segments available</option>';
        $("airshowStoryEditor").innerHTML = '<div class="empty">No airshow events with photos are available.</div>';
        return;
      }
      if (!state.airshowStoryDirty) {
        const suffix = draft.mode === "cinematic" ? "Cinematic page enabled" : "Standard page";
        $("airshowStorySummary").textContent = `${event.name} · ${segments.length} segment${segments.length === 1 ? "" : "s"} · ${suffix}`;
      }
      if (!segments.length) {
        renderAirshowStoryBulk(segments, photos, storyPhotoCoverage(segments, photos));
        $("airshowStoryEditor").innerHTML = '<div class="empty">No chronological segments yet. Generate EXIF segments or add a segment manually.</div>';
        return;
      }

      renderAirshowStoryBulk(segments, photos, storyPhotoCoverage(segments, photos));
      const usedPhotoIds = new Set(segments.flatMap((segment) => (segment.photos || []).map((photo) => photo.photoId)));
      $("airshowStoryEditor").innerHTML = segments.map((segment, index) => {
        const storyPhoto = segment.photos?.[0] || {};
        const supportingPhotos = (segment.photos || []).slice(1);
        const photoIdsOwnedByOtherSegments = new Set(segments
          .filter((_, segmentIndex) => segmentIndex !== index)
          .flatMap((otherSegment) => (otherSegment.photos || []).map((photo) => photo.photoId)));
        const selectedPhoto = photos.find((photo) => photo.id === storyPhoto.photoId) || null;
        const heroOptions = photos
          .filter((photo) => !photoIdsOwnedByOtherSegments.has(photo.id))
          .map((photo) => `<option value="${escapeHtml(photo.id)}"${photo.id === storyPhoto.photoId ? " selected" : ""}>${escapeHtml(storyPhotoOptionLabel(photo))}</option>`)
          .join("");
        const supportOptions = photos
          .filter((photo) => !usedPhotoIds.has(photo.id))
          .map((photo) => `<option value="${escapeHtml(photo.id)}">${escapeHtml(storyPhotoOptionLabel(photo))}</option>`)
          .join("");
        const focalX = Number.isFinite(Number(storyPhoto.focalX)) ? Number(storyPhoto.focalX) : 0.5;
        const focalY = Number.isFinite(Number(storyPhoto.focalY)) ? Number(storyPhoto.focalY) : 0.5;
        const media = selectedPhoto?.sourceAssetPath
          ? `<img src="${thumbUrl(selectedPhoto.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(storyPhotoHeadline(selectedPhoto))}">`
          : '<span class="missing">Photo unavailable</span>';
        return `
          <article class="airshow-story-moment-card" data-story-moment="${index}" aria-label="Segment ${index + 1}">
            <div class="airshow-story-moment-order">
              <span class="story-drag-handle" draggable="true" aria-hidden="true">⋮⋮</span>
              <strong>${String(index + 1).padStart(2, "0")}</strong>
              <div class="story-order-actions" aria-label="Reorder segment">
                <button class="btn icon" type="button" data-story-move="-1" data-story-index="${index}" aria-label="Move segment earlier"${index === 0 ? " disabled" : ""}>↑</button>
                <button class="btn icon" type="button" data-story-move="1" data-story-index="${index}" aria-label="Move segment later"${index === segments.length - 1 ? " disabled" : ""}>↓</button>
              </div>
            </div>
            <button class="story-photo-focal" type="button" data-story-focal="${index}" style="--story-focal-x:${focalX * 100}%;--story-focal-y:${focalY * 100}%" aria-label="Set hero focal point for segment ${index + 1}">
              ${media}
              <span class="story-focal-marker" aria-hidden="true"></span>
            </button>
            <div class="airshow-story-moment-fields">
              <div class="field wide"><label>Hero photo</label><select data-story-photo="${index}">${heroOptions}</select></div>
              <div class="form-grid">
                <div class="field"><label>Sequence label</label><input data-story-field="label" data-story-index="${index}" value="${escapeHtml(segment.label || "")}" placeholder="6 Oct · 08:44"></div>
                <div class="field"><label>Overlay side</label><select data-story-overlay="${index}"><option value="left"${segment.overlaySide === "right" ? "" : " selected"}>Left</option><option value="right"${segment.overlaySide === "right" ? " selected" : ""}>Right</option></select></div>
              </div>
              <div class="field"><label>Hero motion</label><select data-story-motion="${index}">${["auto", "push-left", "push-right", "pull-in", "hold"].map((motion) => `<option value="${motion}"${motion === (storyPhoto.motion || "auto") ? " selected" : ""}>${motion.replace(/-/g, " ")}</option>`).join("")}</select></div>
              <div class="field wide"><label>Segment title</label><input data-story-field="headline" data-story-index="${index}" value="${escapeHtml(segment.headline || "")}" placeholder="Defaults to the hero subject"></div>
              <div class="field wide"><label>Segment caption</label><textarea data-story-field="body" data-story-index="${index}" rows="2" placeholder="Defaults to the hero photo caption">${escapeHtml(segment.body || "")}</textarea></div>
              <section class="story-supporting" aria-label="Supporting photos for segment ${index + 1}">
                <div class="story-supporting-head">
                  <div>
                    <strong>Supporting photos</strong>
                    <span>${supportingPhotos.length} added</span>
                  </div>
                  <label class="field story-support-add">
                    <span>Add supporting photo</span>
                    <select data-story-support-add="${index}" aria-label="Add supporting photo to segment ${index + 1}"${!supportOptions ? " disabled" : ""}>
                      <option value="">${supportOptions ? "Choose an unused event photo…" : "No unused event photos"}</option>
                      ${supportOptions}
                    </select>
                  </label>
                </div>
                <div class="story-supporting-list">
                  ${supportingPhotos.length ? supportingPhotos.map((supportRecord, supportIndex) => {
                    const photo = photos.find((candidate) => candidate.id === supportRecord.photoId);
                    const supportMedia = photo?.sourceAssetPath
                      ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="">`
                      : '<span class="missing">Photo unavailable</span>';
                    const label = photo ? storyPhotoOptionLabel(photo) : `Unavailable photo ${supportRecord.photoId || ""}`;
                    return `
                      <article class="story-supporting-photo">
                        <div class="story-supporting-thumb">${supportMedia}</div>
                        <span>${escapeHtml(label)}</span>
                        <div class="story-supporting-actions" aria-label="Reorder or remove supporting photo ${supportIndex + 1}">
                          <button class="btn icon" type="button" data-story-support-move="-1" data-story-index="${index}" data-story-support-index="${supportIndex}" aria-label="Move supporting photo ${supportIndex + 1} earlier"${supportIndex === 0 ? " disabled" : ""}>↑</button>
                          <button class="btn icon" type="button" data-story-support-move="1" data-story-index="${index}" data-story-support-index="${supportIndex}" aria-label="Move supporting photo ${supportIndex + 1} later"${supportIndex === supportingPhotos.length - 1 ? " disabled" : ""}>↓</button>
                          <button class="btn danger ghost" type="button" data-story-support-remove="${supportIndex}" data-story-index="${index}" aria-label="Remove supporting photo ${supportIndex + 1}">Remove</button>
                        </div>
                      </article>
                    `;
                  }).join("") : '<div class="story-supporting-empty">No supporting photos. The segment will show only its hero.</div>'}
                </div>
              </section>
              <div class="story-moment-footer">
                <span class="subtle">One hero and any number of supporting photos.</span>
                <button class="btn danger ghost" type="button" data-story-remove="${index}">Remove Segment</button>
              </div>
            </div>
          </article>
        `;
      }).join("");
    }

    function generateAirshowStoryDraft() {
      const photos = airshowStoryPhotos();
      if (state.airshowStoryDraft?.segments?.length && !window.confirm("Replace the current segment draft with newly grouped EXIF segments?")) return;
      const groups = [];
      let currentGroup = null;
      for (const photo of photos) {
        const capturedAt = String(photo.capturedAt || photo.exifDate || photo.date || "unknown");
        const day = capturedAt.slice(0, 10);
        const capturedMs = Date.parse(capturedAt);
        const startsNewGroup = !currentGroup
          || currentGroup.day !== day
          || (Number.isFinite(capturedMs) && Number.isFinite(currentGroup.lastCapturedMs) && capturedMs - currentGroup.lastCapturedMs > 120 * 60 * 1000);
        if (startsNewGroup) {
          currentGroup = {day, lastCapturedMs: capturedMs, photos: []};
          groups.push(currentGroup);
        }
        currentGroup.photos.push(photo);
        currentGroup.lastCapturedMs = capturedMs;
      }
      const motions = ["push-left", "pull-in", "push-right", "hold"];
      state.airshowStoryDraft = {
        mode: groups.length >= 2 ? "cinematic" : "standard",
        segments: groups.map((group, index) => {
          const photo = group.photos[0];
          return {
            id: "",
            position: index,
            label: formatStoryCaptureLabel(photo.capturedAt || photo.exifDate || photo.date),
            headline: storyPhotoHeadline(photo),
            body: storyPhotoBody(photo),
            overlaySide: index % 2 ? "right" : "left",
            photos: group.photos.map((groupPhoto, photoIndex) => ({
              photoId: groupPhoto.id,
              focalX: 0.5,
              focalY: 0.5,
              motion: photoIndex === 0 ? motions[index % motions.length] : "auto"
            }))
          };
        })
      };
      markAirshowStoryDirty();
      renderAirshowStoryManager();
      toast(`Grouped ${photos.length} photo${photos.length === 1 ? "" : "s"} into ${state.airshowStoryDraft.segments.length} deterministic EXIF segment${state.airshowStoryDraft.segments.length === 1 ? "" : "s"}.`);
    }

    function addAirshowStoryMoment() {
      const draft = state.airshowStoryDraft;
      const used = new Set((draft?.segments || []).flatMap((segment) => (segment.photos || []).map((photo) => photo.photoId)));
      const photo = airshowStoryPhotos().find((candidate) => !used.has(candidate.id));
      if (!photo || !draft) return toast("Every event photo is already used in a segment.");
      draft.segments.push({
        id: "",
        position: draft.segments.length,
        label: formatStoryCaptureLabel(photo.capturedAt || photo.exifDate || photo.date),
        headline: storyPhotoHeadline(photo),
        body: storyPhotoBody(photo),
        overlaySide: draft.segments.length % 2 ? "right" : "left",
        photos: [{photoId: photo.id, focalX: 0.5, focalY: 0.5, motion: "auto"}]
      });
      markAirshowStoryDirty();
      renderAirshowStoryManager();
    }

    function moveAirshowStoryMoment(fromIndex, toIndex) {
      const segments = state.airshowStoryDraft?.segments || [];
      if (fromIndex < 0 || fromIndex >= segments.length || toIndex < 0 || toIndex >= segments.length || fromIndex === toIndex) return;
      const [segment] = segments.splice(fromIndex, 1);
      segments.splice(toIndex, 0, segment);
      segments.forEach((item, index) => { item.position = index; });
      markAirshowStoryDirty();
      renderAirshowStoryManager();
    }

    async function saveAirshowStory() {
      const event = airshowStoryEvent();
      if (!event || !state.airshowStoryDraft) return;
      const mode = $("airshowStoryEnabled").checked ? "cinematic" : "standard";
      const segments = state.airshowStoryDraft.segments || [];
      if (mode === "cinematic" && segments.length < 2) throw new Error("Add at least two segments before enabling the cinematic page.");
      const result = await api("/api/save-event-story", {eventId: event.id, mode, segments});
      state.airshowStoryDraft = null;
      state.airshowStoryDirty = false;
      await loadState(true);
      toast(result.message);
    }

    function airshowHeroMatches(hero, entry, photo) {
      if (!hero || !Object.keys(hero).length) return false;
      const reference = entryRequestFields(entry);
      return hero.scope === reference.scope
        && hero.entryPath === reference.entryPath
        && (hero.targetPinId || "") === (reference.targetPinId || "")
        && Number(hero.index) === Number(photo.index);
    }

    function renderAirshowHeroManager() {
      const events = taggedAirshowGroups();
      if (!events.length) {
        $("airshowHeroSummary").textContent = "Apply an airshow or event tag to photos before choosing an event hero.";
        $("airshowHeroList").innerHTML = `<div class="empty">Apply an airshow or event tag to photos before choosing an event hero.</div>`;
        return;
      }

      const missingHeroCount = events.filter((event) => !Object.keys(configuredAirshowHero(event.name)).length).length;
      $("airshowHeroSummary").textContent = missingHeroCount
        ? `${missingHeroCount} of ${events.length} event${events.length === 1 ? "" : "s"} need an explicit hero. Choose any tagged image to feature it on the timeline.`
        : `All ${events.length} event${events.length === 1 ? "" : "s"} have a selected hero. Choose another image below to replace one.`;

      $("airshowHeroList").innerHTML = events.map((event) => {
        const hero = configuredAirshowHero(event.name);
        const heroStatus = Object.keys(hero).length ? "Hero selected" : "No hero selected";
        const missingClass = Object.keys(hero).length ? "" : " needs-hero";
        return `
          <article class="airshow-hero-card${missingClass}">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(event.name)}</h3>
                <p class="subtle">${event.photos.length} tagged photo${event.photos.length === 1 ? "" : "s"} · ${heroStatus}</p>
              </div>
              <button class="btn ghost" type="button" data-airshow-hero-clear="${escapeHtml(event.name)}"${Object.keys(hero).length ? "" : " disabled"}>Clear Hero</button>
            </div>
            <div class="airshow-hero-picker">
              ${event.photos.map(({entry, photo}) => {
                const selected = airshowHeroMatches(hero, entry, photo) ? " selected" : "";
                const media = photo.exists && photo.sourceAssetPath
                  ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
                  : `<div class="missing">Missing source</div>`;
                const label = [entry.aircraftType || entry.locationName || "Photo", formatEventDate(effectiveEventDate(photo))].filter(Boolean).join(" - ");
                return `
                  <button class="airshow-hero-photo${selected}" type="button" data-airshow-hero-event="${escapeHtml(event.name)}" data-airshow-hero-photo="${escapeHtml(captionPhotoKey(entry, photo.index))}">
                    ${media}
                    <span>${escapeHtml(label)}</span>
                  </button>
                `;
              }).join("")}
            </div>
          </article>
        `;
      }).join("");
    }

    async function setAirshowHero(eventName, photoKey = "") {
      const event = taggedAirshowGroups().find((item) => airshowEventKey(item.name) === airshowEventKey(eventName));
      if (!event) throw new Error("This event is no longer available. Reload and try again.");
      const candidate = event.photos.find(({entry, photo}) => captionPhotoKey(entry, photo.index) === photoKey);
      if (photoKey && !candidate) throw new Error("This event photo is no longer available. Reload and try again.");
      const result = await api("/api/set-airshow-hero", {
        eventName: event.name,
        hero: candidate ? {...entryRequestFields(candidate.entry), index: candidate.photo.index} : null
      });
      toast(result.message);
      await loadState(true);
    }

    function untaggedAirshowDayGroups() {
      const eventsByDate = new Map();
      taggedAirshowGroups().forEach((event) => {
        event.photos.forEach(({photo}) => {
          const date = effectiveEventDate(photo);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
          if (!eventsByDate.has(date)) eventsByDate.set(date, new Set());
          eventsByDate.get(date).add(event.name);
        });
      });

      const missingByDate = new Map();
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          const date = effectiveEventDate(photo);
          if (photo.invalid || String(photo.airshow || "").trim() || !eventsByDate.has(date)) continue;
          if (!missingByDate.has(date)) missingByDate.set(date, []);
          missingByDate.get(date).push({entry, photo});
        }
      }

      return [...missingByDate.entries()]
        .map(([date, photos]) => ({
          date,
          photos,
          eventNames: [...(eventsByDate.get(date) || [])].sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
    }

    function missingAirshowInputValue(date) {
      const node = [...document.querySelectorAll("[data-airshow-missing-input]")]
        .find((item) => item.dataset.airshowMissingInput === date);
      return node ? node.value.trim() : "";
    }

    function renderAirshowMissingImages() {
      const events = taggedAirshowGroups();
      const groups = untaggedAirshowDayGroups();
      const photoCount = groups.reduce((total, group) => total + group.photos.length, 0);
      $("airshowEventOptions").innerHTML = events
        .map((event) => `<option value="${escapeHtml(event.name)}"></option>`)
        .join("");
      $("airshowMissingImageSummary").textContent = groups.length
        ? `${photoCount} untagged photo${photoCount === 1 ? "" : "s"} found across ${groups.length} event day${groups.length === 1 ? "" : "s"}. Apply the suggested event or choose another.`
        : "No untagged photos currently share a capture date with a tagged event.";

      if (!groups.length) {
        $("airshowMissingImageList").innerHTML = `<div class="empty">No untagged images match a known event day.</div>`;
        return;
      }

      $("airshowMissingImageList").innerHTML = groups.map((group) => {
        const suggestedEvent = group.eventNames.length === 1 ? group.eventNames[0] : "";
        const eventSummary = group.eventNames.length === 1
          ? `Suggested event: ${group.eventNames[0]}`
          : `Events on this day: ${group.eventNames.join(" / ")}`;
        const preview = group.photos.slice(0, 6).map(({entry, photo}) => {
          const media = photo.exists && photo.sourceAssetPath
            ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
            : `<div class="missing">Missing source</div>`;
          const label = [entry.aircraftType || entry.locationName || "Photo", entry.squadronName || photo.location].filter(Boolean).join(" - ");
          return `<div class="bulk-event-photo" title="${escapeHtml(`${photo.path}\n${entry.entryPath}`)}">${media}<span>${escapeHtml(label)}</span></div>`;
        }).join("");
        const remaining = group.photos.length - 6;
        return `
          <article class="bulk-event-date-card">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(formatEventDate(group.date))}</h3>
                <p class="subtle">${group.photos.length} untagged photo${group.photos.length === 1 ? "" : "s"} · ${escapeHtml(eventSummary)}</p>
              </div>
              <span class="pill">${escapeHtml(group.date)}</span>
            </div>
            <div class="form-grid">
              <div class="field wide">
                <label>Assign these images to</label>
                <input data-airshow-missing-input="${escapeHtml(group.date)}" list="airshowEventOptions" type="text" value="${escapeHtml(suggestedEvent)}" placeholder="Select or enter an airshow event">
              </div>
            </div>
            <div class="card-actions">
              <button class="btn primary" type="button" data-airshow-missing-apply="${escapeHtml(group.date)}">Add Event to ${group.photos.length}</button>
            </div>
            <div class="bulk-event-photos">
              ${preview}
              ${remaining > 0 ? `<div class="bulk-event-more">+${remaining} more</div>` : ""}
            </div>
          </article>
        `;
      }).join("");
    }

    async function applyMissingAirshowImages(date) {
      const group = untaggedAirshowDayGroups().find((item) => item.date === date);
      if (!group) throw new Error("These images are no longer available. Reload and try again.");
      const airshow = missingAirshowInputValue(date);
      if (!airshow) throw new Error("Choose or enter an airshow event before adding these images.");
      const result = await api("/api/bulk-airshow", {
        airshow,
        photos: group.photos.map(({entry, photo}) => ({
          ...entryRequestFields(entry),
          index: photo.index
        }))
      });
      toast(result.message);
      await loadState(true);
    }

    function formatEventDate(value) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return new Intl.DateTimeFormat(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric"
        }).format(new Date(`${value}T12:00:00`));
      }
      if (/^\d{4}$/.test(value)) return value;
      return "No capture date";
    }

    function bulkEventGroups() {
      const byDate = new Map();
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (photo.invalid) continue;
          const date = effectiveEventDate(photo) || "undated";
          if (!byDate.has(date)) byDate.set(date, []);
          byDate.get(date).push({entry, photo});
        }
      }
      return [...byDate.entries()]
        .map(([date, photos]) => ({date, photos}))
        .sort((a, b) => {
          if (a.date === "undated") return 1;
          if (b.date === "undated") return -1;
          return b.date.localeCompare(a.date);
        });
    }

    function bulkEventInputValue(date) {
      const node = [...document.querySelectorAll("[data-bulk-event-input]")]
        .find((item) => item.dataset.bulkEventInput === date);
      return node ? node.value.trim() : "";
    }

    function renderBulkEvents() {
      if (!state.data) return;
      renderAirshowHeroManager();
      renderAirshowMissingImages();
      const term = $("bulkEventSearch").value.trim().toLowerCase();
      const allGroups = bulkEventGroups();
      const groups = allGroups.filter((group) => {
        if (!term) return true;
        const haystack = [
          group.date,
          formatEventDate(group.date),
          ...group.photos.flatMap(({entry, photo}) => [
            entry.aircraftType,
            entry.squadronName,
            entry.country,
            entry.locationName,
            photo.path,
            photo.location,
            photo.airshow
          ])
        ].join(" ").toLowerCase();
        return haystack.includes(term);
      });
      const photoCount = allGroups.reduce((total, group) => total + group.photos.length, 0);
      $("bulkEventSummary").textContent = `${groups.length} of ${allGroups.length} date group(s), ${photoCount} photo record(s). Set an event once to update every source photo on that date.`;

      if (!groups.length) {
        $("bulkEventList").innerHTML = `<div class="empty">No photo dates match this filter.</div>`;
        return;
      }

      $("bulkEventList").innerHTML = groups.map((group) => {
        const events = [...new Set(group.photos.map(({photo}) => String(photo.airshow || "").trim()).filter(Boolean))];
        const eventValue = events.length === 1 ? events[0] : "";
        const eventSummary = events.length === 1
          ? `Current event: ${events[0]}`
          : events.length > 1
            ? `Mixed events: ${events.join(" / ")}`
            : "No event set";
        const preview = group.photos.slice(0, 6).map(({entry, photo}) => {
          const media = photo.exists && photo.sourceAssetPath
            ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
            : `<div class="missing">Missing source</div>`;
          const label = [entry.aircraftType || entry.locationName || "Photo", photo.location].filter(Boolean).join(" - ");
          return `<div class="bulk-event-photo" title="${escapeHtml(`${photo.path}\n${entry.entryPath}`)}">${media}<span>${escapeHtml(label)}</span></div>`;
        }).join("");
        const remaining = group.photos.length - 6;
        return `
          <article class="bulk-event-date-card">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(formatEventDate(group.date))}</h3>
                <p class="subtle">${group.photos.length} photo${group.photos.length === 1 ? "" : "s"} · ${escapeHtml(eventSummary)}</p>
              </div>
              <span class="pill">${escapeHtml(group.date === "undated" ? "No date" : group.date)}</span>
            </div>
            <div class="form-grid">
              <div class="field wide">
                <label>Airshow or event for this date</label>
                <input data-bulk-event-input="${escapeHtml(group.date)}" type="text" value="${escapeHtml(eventValue)}" placeholder="Singapore Airshow 2026">
              </div>
            </div>
            <div class="card-actions">
              <button class="btn secondary" type="button" data-bulk-event-apply="${escapeHtml(group.date)}">Set Event on ${group.photos.length}</button>
              <button class="btn ghost" type="button" data-bulk-event-clear="${escapeHtml(group.date)}">Clear Event</button>
            </div>
            <div class="bulk-event-photos">
              ${preview}
              ${remaining > 0 ? `<div class="bulk-event-more">+${remaining} more</div>` : ""}
            </div>
          </article>
        `;
      }).join("");
    }

    async function applyBulkEvent(date, clear = false) {
      const group = bulkEventGroups().find((item) => item.date === date);
      if (!group) throw new Error("This date group is no longer available. Reload and try again.");
      const airshow = clear ? "" : bulkEventInputValue(date);
      if (!clear && !airshow) throw new Error("Enter an airshow or event name, or use Clear Event.");
      const result = await api("/api/bulk-airshow", {
        airshow,
        photos: group.photos.map(({entry, photo}) => ({
          ...entryRequestFields(entry),
          index: photo.index
        }))
      });
      toast(result.message);
      await loadState(true);
    }

    function captionPhotoKey(entry, index) {
      return `${entry.targetKey}::${index}`;
    }

    function selectedBulkCaptionCandidates() {
      const candidates = [];
      let existingPhotoCount = 0;
      let aiExcludedCount = 0;
      let missingCaptionCount = 0;
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (photo.invalid || !photo.exists || !photo.sourceAssetPath) continue;
          existingPhotoCount += 1;
          if (!String(photo.caption || "").trim()) {
            missingCaptionCount += 1;
            continue;
          }
          if (state.bulkCaptions.excludeAi && photo.captionAiAssisted) {
            aiExcludedCount += 1;
            continue;
          }
          candidates.push({
            key: captionPhotoKey(entry, photo.index),
            entry,
            photo
          });
        }
      }
      return {candidates, existingPhotoCount, aiExcludedCount, missingCaptionCount};
    }

    function currentBulkCaptionQueue() {
      return state.bulkCaptions.queue || selectedBulkCaptionCandidates().candidates;
    }

    function resetBulkCaptionQueue() {
      if (state.bulkCaptions.running) return;
      state.bulkCaptions.queue = null;
      state.bulkCaptions.results = {};
    }

    function bulkProposalValue(key, fallback = "") {
      const node = [...document.querySelectorAll("[data-bulk-caption-key]")]
        .find((item) => item.dataset.bulkCaptionKey === key);
      return node ? node.value : fallback;
    }

    function renderBulkCaptions() {
      if (!state.data) return;
      const selection = selectedBulkCaptionCandidates();
      const queue = currentBulkCaptionQueue();
      const results = state.bulkCaptions.results;
      const usingSavedQueue = state.bulkCaptions.queue !== null;
      const selectedLabel = `${selection.existingPhotoCount} existing photo entr${selection.existingPhotoCount === 1 ? "y" : "ies"}, ${selection.candidates.length} eligible human-written caption(s)`;
      const exclusions = [
        selection.aiExcludedCount ? `${selection.aiExcludedCount} AI-assisted excluded` : "",
        selection.missingCaptionCount ? `${selection.missingCaptionCount} without a caption` : ""
      ].filter(Boolean).join("; ");
      $("bulkCaptionSummary").textContent = [
        selectedLabel,
        exclusions,
        usingSavedQueue ? `${queue.length} caption(s) in the current review queue` : ""
      ].filter(Boolean).join(". ");
      $("bulkExcludeAiCaptions").checked = state.bulkCaptions.excludeAi;
      $("refreshBulkCaptionsBtn").disabled = state.bulkCaptions.running;
      $("runBulkCaptionsBtn").disabled = state.bulkCaptions.running || !queue.length;
      $("runBulkCaptionsBtn").textContent = state.bulkCaptions.running ? "Proposing..." : "Propose Captions";

      if (!queue.length) {
        $("bulkCaptionList").innerHTML = `<div class="empty">No existing photo entries with eligible human-written captions were found.</div>`;
        return;
      }

      $("bulkCaptionList").innerHTML = queue.map((candidate) => {
        const result = results[candidate.key] || {status: "ready"};
        const photo = candidate.photo;
        const media = `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`;
        const metadata = [candidate.entry.aircraftType, candidate.entry.squadronName, photo.location || photo.pinId || "No location", photo.airshow].filter(Boolean).join(" / ");
        let review = `<div class="bulk-caption-status">Ready to propose</div>`;
        if (result.status === "generating") {
          review = `<div class="bulk-caption-status">Writing a proposed caption...</div>`;
        } else if (result.status === "error") {
          review = `<div class="bulk-caption-status error">Could not propose a caption: ${escapeHtml(result.message || "Unknown error")}</div>`;
        } else if (result.status === "rejected") {
          review = `<div class="bulk-caption-status">Rejected. The original caption remains unchanged.</div>`;
        } else if (result.status === "proposed") {
          review = `
            <div class="field">
              <label>Proposed caption</label>
              <textarea data-bulk-caption-key="${escapeHtml(candidate.key)}">${escapeHtml(result.caption || "")}</textarea>
            </div>
            <div class="card-actions">
              <button class="btn secondary" type="button" data-bulk-accept="${escapeHtml(candidate.key)}">Accept Caption</button>
              <button class="btn ghost" type="button" data-bulk-reject="${escapeHtml(candidate.key)}">Reject</button>
            </div>
          `;
        }
        return `
          <article class="bulk-caption-card">
            <div>${media}</div>
            <div class="bulk-caption-content">
              <div class="mini-title">${escapeHtml(photo.path)}</div>
              <div class="mini-meta">${escapeHtml(metadata)}<br>${escapeHtml(candidate.entry.entryPath)}</div>
              <div class="bulk-caption-current">
                <div class="mini-meta"><strong>Current caption</strong></div>
                <div class="mini-meta">${escapeHtml(photo.caption || "")}</div>
              </div>
              ${review}
            </div>
          </article>
        `;
      }).join("");
    }

    function wait(milliseconds) {
      return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    async function runBulkCaptions() {
      if (state.bulkCaptions.running) return;
      const {candidates} = selectedBulkCaptionCandidates();
      if (!candidates.length) {
        throw new Error("No existing photo entries with eligible human-written captions were found.");
      }
      state.bulkCaptions.queue = candidates;
      state.bulkCaptions.results = {};
      state.bulkCaptions.running = true;
      renderBulkCaptions();
      try {
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          state.bulkCaptions.results[candidate.key] = {status: "generating"};
          renderBulkCaptions();
          try {
            const result = await api("/api/generate-caption", {
              ...entryRequestFields(candidate.entry),
              index: candidate.photo.index,
              draftCaption: candidate.photo.caption
            });
            state.bulkCaptions.results[candidate.key] = {status: "proposed", caption: result.caption || ""};
          } catch (error) {
            state.bulkCaptions.results[candidate.key] = {status: "error", message: error.message || "Request failed"};
          }
          renderBulkCaptions();
          if (index < candidates.length - 1) await wait(500);
        }
      } finally {
        state.bulkCaptions.running = false;
        renderBulkCaptions();
      }
    }

    async function acceptBulkCaption(key) {
      const candidate = currentBulkCaptionQueue().find((item) => item.key === key);
      const result = state.bulkCaptions.results[key];
      if (!candidate || !result || result.status !== "proposed") return;
      const caption = bulkProposalValue(key, result.caption).trim();
      if (!caption) throw new Error("A caption is required before accepting it.");
      const photo = candidate.photo;
      await api("/api/update-photo", {
        ...entryRequestFields(candidate.entry),
        index: photo.index,
        photo: {
          path: photo.path,
          location: photo.location || "",
          pin_id: photo.pinId || "",
          date: photo.date || "",
          year: photo.year || "",
          airshow: photo.airshow || "",
          title: photo.title || "",
          caption,
          captionAiAssisted: true
        }
      });
      state.bulkCaptions.queue = currentBulkCaptionQueue().filter((item) => item.key !== key);
      delete state.bulkCaptions.results[key];
      await loadState(true);
      toast("Caption accepted and marked as AI-assisted.");
    }

    function rejectBulkCaption(key) {
      const result = state.bulkCaptions.results[key];
      if (!result || result.status !== "proposed") return;
      state.bulkCaptions.results[key] = {status: "rejected"};
      renderBulkCaptions();
    }

    function renderEntryOptions() {
      const search = $("entrySearch").value.trim().toLowerCase();
      const current = $("entrySelect").value;
      const entries = [...(state.data.entries || []), ...squadronOnlyTargets()].filter((entry) => {
        if (!search) return true;
        return entryOptionLabel(entry).toLowerCase().includes(search) || String(entry.entryPath || "").toLowerCase().includes(search);
      });
      const option = (entry) => (
        `<option value="${escapeHtml(entry.targetKey)}">${escapeHtml(entryOptionLabel(entry))}</option>`
      );
      const byLabel = (left, right) => entryOptionLabel(left).localeCompare(entryOptionLabel(right));
      const aircraftEntries = entries.filter((entry) => entry.sourceScope === "aircraft").sort(byLabel);
      const squadronEntries = entries
        .filter((entry) => entry.sourceScope === "squadron" || entry.sourceScope === "squadron-target")
        .sort(byLabel);
      const locationEntries = entries.filter((entry) => entry.sourceScope === "location").sort(byLabel);
      $("entrySelect").innerHTML = [
        aircraftEntries.length ? `<optgroup label="Aircraft sources">${aircraftEntries.map(option).join("")}</optgroup>` : "",
        squadronEntries.length ? `<optgroup label="Squadron-only sources">${squadronEntries.map(option).join("")}</optgroup>` : "",
        locationEntries.length ? `<optgroup label="Location sources">${locationEntries.map(option).join("")}</optgroup>` : ""
      ].join("");
      if (entries.some((entry) => entry.targetKey === current)) {
        $("entrySelect").value = current;
      }
      if (state.activeTab === "attach") renderEntryDetail();
    }

    function renderEditTagTargetOptions() {
      const current = $("editTagTarget").value;
      const targetEntries = (state.data?.entries || []).filter((entry) => (
        entry.sourceScope === "aircraft" || entry.sourceScope === "squadron"
      ));
      const squadronOnlyEntries = squadronOnlyTargets();
      const option = (entry) => (
        `<option value="${escapeHtml(entry.targetKey)}">${escapeHtml(entryOptionLabel(entry))}</option>`
      );
      const aircraftEntries = targetEntries.filter((entry) => entry.sourceScope === "aircraft");
      const squadronEntries = targetEntries.filter((entry) => entry.sourceScope === "squadron");
      $("editTagTarget").innerHTML = [
        `<option value="">Keep current photo source</option>`,
        aircraftEntries.length ? `<optgroup label="Aircraft">${aircraftEntries.map(option).join("")}</optgroup>` : "",
        squadronEntries.length ? `<optgroup label="Squadron-only sources">${squadronEntries.map(option).join("")}</optgroup>` : "",
        squadronOnlyEntries.length ? `<optgroup label="Tag directly to squadron">${squadronOnlyEntries.map(option).join("")}</optgroup>` : ""
      ].join("");
      if ([...targetEntries, ...squadronOnlyEntries].some((entry) => entry.targetKey === current)) {
        $("editTagTarget").value = current;
      }
    }

    function renderPinOptions() {
      const options = state.data.pins.map((pin) => (
        `<option value="${escapeHtml(pin.key)}">${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
      const selects = ["pinSelect", "editLocation"];
      for (const id of selects) {
        const current = $(id).value;
        $(id).innerHTML = `<option value="">No location</option>${options}`;
        if (state.data.pins.some((pin) => pin.key === current)) {
          $(id).value = current;
        }
      }
    }

    function photoSelectionKey(entry, photo) {
      return photo.photoId || `${entry.targetKey}::${photo.index}`;
    }

    function findBulkSelection(mode, key) {
      if (mode === "master") {
        const photo = (state.data?.masterPhotos || []).find((item) => item.id === key);
        return photo ? {photo, entry: null} : null;
      }
      for (const entry of state.data?.entries || []) {
        const photo = (entry.photos || []).find((item) => !item.invalid && photoSelectionKey(entry, item) === key);
        if (photo) return {photo, entry};
      }
      return null;
    }

    function bulkPhotoReference(selection) {
      if (selection.photo.id && !selection.entry) return {photoId: selection.photo.id};
      if (selection.photo.photoId) return {photoId: selection.photo.photoId};
      return {...entryRequestFields(selection.entry), index: selection.photo.index};
    }

    function bulkEditorMarkup(mode) {
      const locationOptions = (state.data?.pins || []).map((pin) => (
        `<option value="${escapeHtml(pin.id)}">${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
      return `
        <section class="bulk-editor" data-bulk-editor="${mode}">
          <div class="bulk-editor-head">
            <div>
              <strong>Bulk edit selected photos</strong>
              <span class="subtle" data-bulk-selected-count>0 selected</span>
            </div>
            <div class="card-actions">
              <button class="btn ghost" type="button" data-bulk-select-all>Select visible</button>
              <button class="btn ghost" type="button" data-bulk-clear>Clear selection</button>
            </div>
          </div>
          <div class="bulk-editor-grid">
            <div class="bulk-field">
              <label><input type="checkbox" data-bulk-apply-field="locationId"> Apply location</label>
              <select data-bulk-field="locationId">
                <option value="">Choose a location</option>
                ${locationOptions}
              </select>
            </div>
            <div class="bulk-field">
              <label><input type="checkbox" data-bulk-apply-field="date"> Apply date</label>
              <input data-bulk-field="date" type="date">
            </div>
            <div class="bulk-field wide">
              <label><input type="checkbox" data-bulk-apply-field="airshow"> Apply event</label>
              <input data-bulk-field="airshow" type="text" placeholder="Blank clears the event">
            </div>
            <div class="bulk-field wide">
              <label><input type="checkbox" data-bulk-apply-field="livery"> Apply livery</label>
              <input data-bulk-field="livery" type="text" placeholder="Blank clears the livery">
            </div>
            <div class="bulk-field wide">
              <label><input type="checkbox" data-bulk-apply-field="caption"> Apply caption</label>
              <textarea data-bulk-field="caption" rows="3" placeholder="Blank clears the caption"></textarea>
            </div>
          </div>
          <div class="bulk-editor-foot">
            <span class="subtle">Only checked fields change. Blank checked fields clear existing values.</span>
            <button class="btn secondary" type="button" data-bulk-submit disabled>Apply to selected</button>
          </div>
        </section>
      `;
    }

    function updateBulkEditorStatus(mode) {
      const editor = document.querySelector(`[data-bulk-editor="${mode}"]`);
      if (!editor) return;
      const selectedCount = state.bulkEdit[mode].size;
      const hasField = [...editor.querySelectorAll("[data-bulk-apply-field]")].some((input) => input.checked);
      editor.querySelector("[data-bulk-selected-count]").textContent = `${selectedCount} selected`;
      editor.querySelector("[data-bulk-clear]").disabled = selectedCount === 0;
      editor.querySelector("[data-bulk-submit]").disabled = selectedCount === 0 || !hasField;
    }

    function renderBulkEditor(mode, containerId) {
      const container = $(containerId);
      if (!container) return;
      container.innerHTML = bulkEditorMarkup(mode);
      updateBulkEditorStatus(mode);
    }

    function toggleBulkSelection(mode, key, selected) {
      if (selected) state.bulkEdit[mode].add(key);
      else state.bulkEdit[mode].delete(key);
      const input = document.querySelector(`[data-bulk-select-mode="${mode}"][data-bulk-select-key="${CSS.escape(key)}"]`);
      input?.closest(".photo-card, .master-row")?.classList.toggle("selected", selected);
      updateBulkEditorStatus(mode);
    }

    function clearBulkSelection(mode) {
      state.bulkEdit[mode].clear();
      document.querySelectorAll(`[data-bulk-select-mode="${mode}"]`).forEach((input) => {
        input.checked = false;
        input.closest(".photo-card, .master-row")?.classList.remove("selected");
      });
      updateBulkEditorStatus(mode);
    }

    function selectAllBulkVisible(mode) {
      document.querySelectorAll(`[data-bulk-select-mode="${mode}"]`).forEach((input) => {
        input.checked = true;
        state.bulkEdit[mode].add(input.dataset.bulkSelectKey);
        input.closest(".photo-card, .master-row")?.classList.add("selected");
      });
      updateBulkEditorStatus(mode);
    }

    async function applyBulkEdit(mode) {
      const editor = document.querySelector(`[data-bulk-editor="${mode}"]`);
      if (!editor) return;
      const selections = [...state.bulkEdit[mode]].map((key) => findBulkSelection(mode, key)).filter(Boolean);
      if (!selections.length) throw new Error("Select at least one photo.");
      const fields = {};
      editor.querySelectorAll("[data-bulk-apply-field]").forEach((input) => {
        if (!input.checked) return;
        const field = input.dataset.bulkApplyField;
        fields[field] = editor.querySelector(`[data-bulk-field="${field}"]`).value;
      });
      if (!Object.keys(fields).length) throw new Error("Choose at least one field to update.");
      const result = await api("/api/bulk-update-photos", {
        photos: selections.map(bulkPhotoReference),
        fields
      });
      state.bulkEdit[mode].clear();
      if (mode === "tagged") clearEditor();
      toast(result.message);
      await loadState(true);
    }

    function renderEntryDetail() {
      renderBulkEditor("tagged", "taggedBulkEditor");
      const entry = selectedEntry();
      if (!entry) {
        $("entrySummary").textContent = "";
        $("photoList").innerHTML = `<div class="empty">No entry selected</div>`;
        $("pinSelect").disabled = false;
        $("editLocation").disabled = false;
        return;
      }
      if (entry.sourceScope === "squadron-target") {
        $("entrySummary").textContent = `Unit-only tag: ${entry.squadronName} (${entry.country}). The manager will reuse the canonical unit without assigning an aircraft type.`;
        $("pinSelect").disabled = false;
        $("editLocation").disabled = false;
        $("photoList").innerHTML = `<div class="empty">Selected raw assets will be attached to this squadron-only source.</div>`;
        return;
      }
      const isLocationSource = entry.sourceScope === "location";
      $("entrySummary").textContent = `${entry.photoCount} photo(s), ${entry.missingPhotoCount} missing source(s), ${entry.entryPath}`;
      $("pinSelect").disabled = isLocationSource;
      $("editLocation").disabled = isLocationSource;
      if (isLocationSource) {
        const sourcePin = state.data.pins.find((pin) => pin.id === entry.pinId);
        if (sourcePin) $("pinSelect").value = sourcePin.key;
      }
      if (!entry.photos.length) {
        $("photoList").innerHTML = `<div class="empty">Entry has no photos</div>`;
        return;
      }
      $("photoList").innerHTML = entry.photos.map((photo) => {
        if (photo.invalid) {
          return `<article class="photo-card"><div class="missing">Invalid catalog item</div><div class="mini-meta">${escapeHtml(photo.raw)}</div></article>`;
        }
        const selectionKey = photoSelectionKey(entry, photo);
        const selected = state.bulkEdit.tagged.has(selectionKey);
        const media = photo.exists && photo.sourceAssetPath
          ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
          : `<div class="missing">Missing source</div>`;
        const location = photo.location || photo.pinId || "No location";
        const airshow = photo.airshow ? `<br>Airshow: ${escapeHtml(photo.airshow)}` : "";
        const livery = photo.livery ? `<br>Livery: ${escapeHtml(photo.livery)}` : "";
        return `
          <article class="photo-card${selected ? " selected" : ""}">
            ${media}
            <label class="photo-select"><input type="checkbox" data-bulk-select-mode="tagged" data-bulk-select-key="${escapeHtml(selectionKey)}"${selected ? " checked" : ""}> Select for bulk edit</label>
            <div class="mini-title">${escapeHtml(photo.path)}</div>
            <div class="mini-meta">${escapeHtml(location)}${airshow}${livery}<br>${escapeHtml(photo.year || photo.date || "")}</div>
            <div class="card-actions">
              <button class="btn ghost" type="button" data-edit-photo="${photo.index}">Edit</button>
              <button class="btn danger" type="button" data-delete-photo="${photo.index}">Delete</button>
            </div>
          </article>
        `;
      }).join("");
    }

    function renderSourceCards({listId, searchId, scope}) {
      const term = $(searchId).value.trim().toLowerCase();
      const entries = (state.data.entries || []).filter((entry) => entry.sourceScope === scope).filter((entry) => {
        if (!term) return true;
        return [entry.aircraftType, entry.squadronName, entry.country, entry.entryPath].join(" ").toLowerCase().includes(term);
      }).sort((left, right) => entryOptionLabel(left).localeCompare(entryOptionLabel(right)));
      $(listId).innerHTML = entries.map((entry) => `
        <article class="photo-card">
          <div class="mini-title">${escapeHtml(entryOptionLabel(entry))}</div>
          <div class="mini-meta">${escapeHtml(entry.entryPath)}</div>
          <div class="card-actions">
            <button class="btn ghost" type="button" data-open-entry="${escapeHtml(entry.targetKey)}">Open</button>
            <button class="btn secondary" type="button" data-edit-entry="${escapeHtml(entry.targetKey)}">Edit</button>
          </div>
        </article>
      `).join("") || `<div class="empty">No matching entries</div>`;
    }

    function renderSquadronSourceCards() {
      renderSourceCards({listId: "squadronSourceCards", searchId: "squadronSourceSearch", scope: "squadron"});
    }

    function renderAircraftSourceCards() {
      renderSourceCards({listId: "aircraftSourceCards", searchId: "aircraftSourceSearch", scope: "aircraft"});
    }

    function renderSquadronSourcePage() {
      renderSquadronSourceCards();
    }

    function aircraftWidthValue(aircraft) {
      if (aircraft.doubleWidth === true) return "1";
      if (aircraft.doubleWidth === false) return "0";
      return "";
    }

    function aircraftSettingsPhotos(aircraft) {
      const photos = [...(aircraft.photos || [])]
        .sort((left, right) => (
          effectiveEventDate(right).localeCompare(effectiveEventDate(left))
          || String(left.path || "").localeCompare(String(right.path || ""))
        ));
      const hasHeroCandidate = photos.some((photo) => photo.photoId === aircraft.heroPhotoId);
      if (aircraft.heroPhotoId && !hasHeroCandidate) {
        photos.unshift({
          photoId: aircraft.heroPhotoId,
          path: aircraft.heroAssetPath,
          sourceAssetPath: aircraft.heroAssetPath,
          exists: aircraft.heroExists,
          customHero: true
        });
      }
      return photos;
    }

    function renderAircraftSettings() {
      const list = $("aircraftSettingsList");
      if (!list || !state.data) return;
      const all = state.data.aircraftCatalog || [];
      const term = $("aircraftSettingsSearch").value.trim().toLowerCase();
      const aircraft = all.filter((item) => (
        !term || [item.name, item.family, item.id].join(" ").toLowerCase().includes(term)
      ));
      const configuredCount = all.filter((item) => item.doubleWidth !== null && item.doubleWidth !== undefined).length;
      $("aircraftSettingsSummary").textContent = all.length
        ? `${aircraft.length} of ${all.length} aircraft type${all.length === 1 ? "" : "s"} shown · ${configuredCount} with an explicit card width. Hero photos are optional.`
        : "Aircraft type settings are available when the canonical database is loaded.";
      if (!aircraft.length) {
        list.innerHTML = `<div class="empty">No aircraft types match this search.</div>`;
        return;
      }

      list.innerHTML = aircraft.map((item) => {
        const photos = aircraftSettingsPhotos(item);
        const hasHero = Boolean(item.heroPhotoId);
        const picker = photos.length
          ? `<div class="group-hero-picker">${photos.map((photo) => {
              const available = Boolean(photo.exists && photo.sourceAssetPath);
              const selectable = Boolean(available && !photo.customHero);
              const selected = photo.photoId === item.heroPhotoId;
              const media = available
                ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path || item.name)}">`
                : `<div class="missing">Missing source</div>`;
              const label = photo.customHero
                ? "Current hero"
                : [photo.location || "Tagged photo", formatEventDate(effectiveEventDate(photo))].filter(Boolean).join(" - ");
              return `
                <button class="group-hero-photo${selected ? " selected" : ""}" type="button"${selectable ? ` data-aircraft-hero-aircraft="${escapeHtml(item.id)}" data-aircraft-hero-photo="${escapeHtml(photo.photoId)}"` : ""} aria-pressed="${selected}"${selectable ? "" : " disabled"}>
                  ${media}
                  <span>${escapeHtml(label)}</span>
                </button>
              `;
            }).join("")}</div>`
          : `<p class="subtle">No photos are currently tagged to this aircraft type.</p>`;
        return `
          <article class="group-hero-card${hasHero ? "" : " needs-hero"}" data-aircraft-settings-row="${escapeHtml(item.id)}">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(item.name)}</h3>
                <p class="subtle">${escapeHtml(item.family)} · ${item.photoCount} tagged photo${item.photoCount === 1 ? "" : "s"} · ${hasHero ? "Hero selected" : "No hero selected"}</p>
              </div>
              <div class="card-actions">
                <button class="btn ghost" type="button" data-aircraft-hero-clear="${escapeHtml(item.id)}"${hasHero ? "" : " disabled"}>Clear Hero</button>
              </div>
            </div>
            ${picker}
            <div class="aircraft-settings-footer">
              <div class="field">
                <label for="aircraft-width-${escapeHtml(item.id)}">Aircraft card width</label>
                <select id="aircraft-width-${escapeHtml(item.id)}" data-aircraft-width="${escapeHtml(item.id)}">
                  <option value="">Automatic (archive layout)</option>
                  <option value="0"${aircraftWidthValue(item) === "0" ? " selected" : ""}>Standard width</option>
                  <option value="1"${aircraftWidthValue(item) === "1" ? " selected" : ""}>Double width</option>
                </select>
              </div>
              <button class="btn secondary" type="button" data-aircraft-settings-save="${escapeHtml(item.id)}">Save Width</button>
            </div>
          </article>
        `;
      }).join("");
    }

    function masterPhotoMatchesSearch(photo, term) {
      if (!term) return true;
      const subjects = (photo.subjects || []).flatMap((subject) => [
        subject.aircraftType,
        subject.unitName,
        subject.country,
        subject.entryPath
      ]);
      return [
        photo.id,
        photo.path,
        photo.location,
        photo.country,
        photo.airshow,
        photo.date,
        photo.exifDate,
        photo.title,
        photo.livery,
        photo.caption,
        ...subjects
      ].join(" ").toLowerCase().includes(term);
    }

    function masterLocationOptions(selectedId) {
      return (state.data?.pins || []).map((pin) => (
        `<option value="${escapeHtml(pin.id)}"${pin.id === selectedId ? " selected" : ""}>${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
    }

    function masterSubjectLabel(photo) {
      const subjects = (photo.subjects || []).map((subject) => (
        [subject.aircraftType, subject.unitName].filter(Boolean).join(" / ")
      )).filter(Boolean);
      return subjects.length ? subjects.join(" · ") : "Location-only photo";
    }

    function renderMasterView() {
      if (!state.data || !$("masterList")) return;
      renderBulkEditor("master", "masterBulkEditor");
      const all = state.data.masterPhotos || [];
      const term = $("masterSearch").value.trim().toLowerCase();
      const photos = all.filter((photo) => masterPhotoMatchesSearch(photo, term));
      const pageCount = Math.max(1, Math.ceil(photos.length / state.masterPageSize));
      state.masterPage = Math.min(Math.max(1, state.masterPage), pageCount);
      const start = (state.masterPage - 1) * state.masterPageSize;
      const pagePhotos = photos.slice(start, start + state.masterPageSize);
      $("masterSummary").textContent = `${photos.length} of ${all.length} database photos · page ${state.masterPage} of ${pageCount}`;
      if (!photos.length) {
        $("masterList").innerHTML = `<div class="empty">No database photos match this search.</div>`;
        $("masterPagination").innerHTML = "";
        return;
      }
      $("masterList").innerHTML = pagePhotos.map((photo) => {
        const media = photo.exists && photo.sourceAssetPath
          ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
          : `<div class="missing">Missing source</div>`;
        const dateMeta = photo.date ? `Override: ${photo.date}` : `EXIF: ${photo.exifDate || "none"}`;
        const subjectLabel = masterSubjectLabel(photo);
        const selected = state.bulkEdit.master.has(photo.id);
        return `
          <article class="master-row${selected ? " selected" : ""}" data-master-row="${escapeHtml(photo.id)}">
            <div class="master-media">${media}</div>
            <div class="master-content">
              <div class="master-heading">
                <div>
                  <div class="mini-title">${escapeHtml(photo.path)}</div>
                  <div class="mini-meta">${escapeHtml(photo.id)} · ${escapeHtml(dateMeta)} · ${photo.captionAiAssisted ? "AI-assisted caption" : ""}</div>
                </div>
                <div class="master-heading-actions">
                  <label class="photo-select"><input type="checkbox" data-bulk-select-mode="master" data-bulk-select-key="${escapeHtml(photo.id)}"${selected ? " checked" : ""}> Select</label>
                  <span class="tag${photo.exists ? "" : " warn"}">${photo.exists ? "source present" : "source missing"}</span>
                </div>
              </div>
              <div class="master-subjects"><strong>Subjects:</strong> ${escapeHtml(subjectLabel)}</div>
              <div class="form-grid master-fields">
                <div class="field">
                  <label>Location</label>
                  <select data-master-field="locationId">${masterLocationOptions(photo.locationId)}</select>
                </div>
                <div class="field">
                  <label>Date override</label>
                  <input data-master-field="date" type="date" value="${escapeHtml(photo.date || "")}">
                </div>
                <div class="field wide">
                  <label>Airshow event</label>
                  <input data-master-field="airshow" type="text" value="${escapeHtml(photo.airshow || "")}" placeholder="Optional event name">
                </div>
                <div class="field wide">
                  <label>Title</label>
                  <input data-master-field="title" type="text" value="${escapeHtml(photo.title || "")}" placeholder="Optional title">
                </div>
                <div class="field wide">
                  <label>Livery</label>
                  <input data-master-field="livery" type="text" value="${escapeHtml(photo.livery || "")}" placeholder="Optional livery">
                </div>
                <div class="field wide">
                  <label>Caption</label>
                  <textarea data-master-field="caption" rows="3">${escapeHtml(photo.caption || "")}</textarea>
                </div>
              </div>
              <div class="card-actions">
                <button class="btn secondary" type="button" data-master-save="${escapeHtml(photo.id)}">Save changes</button>
                <button class="btn danger" type="button" data-master-detach="${escapeHtml(photo.id)}">Detach raw image</button>
              </div>
            </div>
          </article>
        `;
      }).join("");
      $("masterPagination").innerHTML = `
        <button class="btn ghost" type="button" data-master-page="${state.masterPage - 1}"${state.masterPage === 1 ? " disabled" : ""}>Previous</button>
        <span>${start + 1}–${Math.min(start + state.masterPageSize, photos.length)} of ${photos.length}</span>
        <button class="btn ghost" type="button" data-master-page="${state.masterPage + 1}"${state.masterPage === pageCount ? " disabled" : ""}>Next</button>`;
    }

    function entryByTargetKey(targetKey) {
      return (state.data?.entries || []).find((entry) => entry.targetKey === targetKey)
        || squadronOnlyTargets().find((entry) => entry.targetKey === targetKey)
        || null;
    }

    function photoReferenceByKey(key) {
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (captionPhotoKey(entry, photo.index) === key) return {entry, photo};
        }
      }
      return null;
    }

    function managerKey(value) {
      return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
    }

    function photoMatchesLocation(photo, pin) {
      const photoPinId = managerKey(photo.pinId);
      return photoPinId
        ? photoPinId === managerKey(pin.id)
        : managerKey(photo.location) === managerKey(pin.name);
    }

    function locationHeroPhotos(pin) {
      const photos = [];
      const seen = new Set();
      const addMatchingPhotos = (entry) => {
        for (const photo of entry?.photos || []) {
          if (photo.invalid || !photoMatchesLocation(photo, pin)) continue;
          const key = captionPhotoKey(entry, photo.index);
          if (seen.has(key)) continue;
          seen.add(key);
          photos.push({entry, photo});
        }
      };

      const entries = state.data?.entries || [];
      // Keep location-scoped catalog photos at the front of their own picker. This
      // makes a recently tagged pin photo available even when the location has
      // many aircraft and squadron frames associated with it.
      const locationEntries = entries.filter((entry) => (
        entry.sourceScope === "location"
        && (managerKey(entry.pinId) === managerKey(pin.id)
          || managerKey(entry.locationName) === managerKey(pin.name))
      ));
      locationEntries.forEach(addMatchingPhotos);
      entries.filter((entry) => entry.sourceScope !== "location").forEach(addMatchingPhotos);
      photos.sort((a, b) => {
        const scopeOrder = Number(a.entry.sourceScope !== "location") - Number(b.entry.sourceScope !== "location");
        return scopeOrder
          || effectiveEventDate(b.photo).localeCompare(effectiveEventDate(a.photo))
          || a.photo.path.localeCompare(b.photo.path);
      });
      const hasHeroCandidate = photos.some(({photo}) => photo.sourceAssetPath && photo.sourceAssetPath === pin.heroAssetPath);
      if (pin.heroPhoto && !hasHeroCandidate) {
        photos.unshift({
          entry: null,
          photo: {
            path: pin.heroPhoto,
            sourceAssetPath: pin.heroAssetPath,
            exists: pin.heroExists,
            customHero: true,
          },
        });
      }
      return photos;
    }

    function pinByKey(key) {
      return (state.data?.pins || []).find((pin) => pin.key === key) || null;
    }

    function squadronGroupByKey(key) {
      return (state.data?.squadronGroups || []).find((group) => group.key === key) || null;
    }

    function renderLocationDatabase() {
      const list = $("locationDatabaseList");
      if (!list || !state.data) return;
      const term = $("locationDatabaseSearch").value.trim().toLowerCase();
      const pins = (state.data.pins || [])
        .filter((pin) => {
          if (!term) return true;
          return [pin.name, pin.country, pin.icao, pin.id, pin.lat, pin.lon].join(" ").toLowerCase().includes(term);
        })
        .sort((left, right) => pinOptionLabel(left).localeCompare(pinOptionLabel(right)));
      list.innerHTML = pins.map((pin) => {
        const coordinateLabel = pin.lat === null || pin.lon === null ? "No coordinates" : `${pin.lat}, ${pin.lon}`;
        const metadata = [pin.country || "Country not set", pin.icao ? `ICAO ${pin.icao}` : "", coordinateLabel].filter(Boolean).join(" · ");
        return `
          <article class="photo-card">
            <div class="mini-title">${escapeHtml(pin.name)}</div>
            <div class="mini-meta">${escapeHtml(metadata)}<br>${escapeHtml(pin.id)} · ${pin.enabled ? "Enabled" : "Disabled"}</div>
            <div class="card-actions">
              <button class="btn secondary" type="button" data-edit-location="${escapeHtml(pin.id)}">Edit</button>
            </div>
          </article>
        `;
      }).join("") || `<div class="empty">No matching locations</div>`;
    }

    function renderLocationHeroManager() {
      const pins = state.data?.pins || [];
      if (!pins.length) {
        $("locationHeroSummary").textContent = "Create a map pin before assigning location hero images.";
        $("locationHeroList").innerHTML = `<div class="empty">No locations are available yet.</div>`;
        return;
      }

      const missingHeroCount = pins.filter((pin) => !pin.heroPhoto).length;
      $("locationHeroSummary").textContent = missingHeroCount
        ? `${missingHeroCount} of ${pins.length} location${pins.length === 1 ? "" : "s"} need an explicit hero. Click a tagged image to set one.`
        : `All ${pins.length} location${pins.length === 1 ? "" : "s"} have a selected hero. Click another image to replace one.`;

      $("locationHeroList").innerHTML = pins.map((pin) => {
        const photos = locationHeroPhotos(pin);
        const taggedPhotoCount = photos.filter(({photo}) => !photo.customHero).length;
        const hasHero = Boolean(pin.heroPhoto);
        const coord = pin.lat === null || pin.lon === null ? "No coordinates" : `${pin.lat}, ${pin.lon}`;
        const metadata = [pin.country || "Country not set", pin.icao ? `ICAO ${pin.icao}` : "", coord].filter(Boolean).join(" · ");
        const picker = photos.length
          ? `<div class="group-hero-picker">${photos.map(({entry, photo}) => {
              const available = Boolean(photo.exists && photo.sourceAssetPath);
              const selectable = Boolean(entry && available && !photo.customHero);
              const selected = Boolean(photo.customHero || (pin.heroAssetPath && photo.sourceAssetPath === pin.heroAssetPath));
              const media = available
                ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
                : `<div class="missing">Missing source</div>`;
              const label = photo.customHero
                ? "Current custom hero"
                : [entry.aircraftType || entry.squadronName || "Location photo", photo.path, formatEventDate(effectiveEventDate(photo))].filter(Boolean).join(" - ");
              return `
                <button class="group-hero-photo${selected ? " selected" : ""}" type="button"${selectable ? ` data-location-hero-pin="${escapeHtml(pin.key)}" data-location-hero-photo="${escapeHtml(captionPhotoKey(entry, photo.index))}"` : ""} aria-pressed="${selected}"${selectable ? "" : " disabled"}>
                  ${media}
                  <span>${escapeHtml(label)}</span>
                </button>
              `;
            }).join("")}</div>`
          : `<p class="subtle">No photos are currently tagged to this location. Select one raw asset in the left panel to set a custom hero.</p>`;
        return `
          <article class="group-hero-card${hasHero ? "" : " needs-hero"}">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(pin.name)}</h3>
                <p class="subtle">${escapeHtml(metadata)} · ${taggedPhotoCount} tagged photo${taggedPhotoCount === 1 ? "" : "s"} · ${hasHero ? "Hero selected" : "No hero selected"}</p>
              </div>
              <div class="card-actions">
                <button class="btn ghost" type="button" data-location-hero-clear="${escapeHtml(pin.key)}"${hasHero ? "" : " disabled"}>Clear Hero</button>
                <button class="btn secondary" type="button" data-location-hero-asset="${escapeHtml(pin.key)}">Use Selected Raw Asset</button>
              </div>
            </div>
            ${picker}
          </article>
        `;
      }).join("");
    }

    function squadronGroupPhotos(group) {
      const photos = (group.photos || [])
        .map((reference) => {
          const entry = entryByTargetKey(reference.entryTargetKey);
          const photo = entry?.photos?.find((item) => Number(item.index) === Number(reference.index));
          return entry && photo ? {entry, photo} : null;
        })
        .filter(Boolean)
        .sort((a, b) => effectiveEventDate(b.photo).localeCompare(effectiveEventDate(a.photo)) || a.photo.path.localeCompare(b.photo.path));
      const hero = group.hero || {};
      const hasHeroCandidate = photos.some(({photo}) => photo.sourceAssetPath && photo.sourceAssetPath === hero.assetPath);
      const heroEntry = entryByTargetKey(hero.entryTargetKey);
      if (hero.sourcePath && hero.assetPath && heroEntry && !hasHeroCandidate) {
        photos.unshift({
          entry: heroEntry,
          photo: {
            path: hero.sourcePath,
            sourceAssetPath: hero.assetPath,
            exists: true,
            customHero: true,
          },
        });
      }
      return photos;
    }

    function renderSquadronHeroManager() {
      const groups = state.data?.squadronGroups || [];
      if (!groups.length) {
        $("squadronHeroSummary").textContent = "Create a squadron source before assigning a squadron hero image.";
        $("squadronHeroList").innerHTML = `<div class="empty">No squadron groups are available yet.</div>`;
        return;
      }

      const missingHeroCount = groups.filter((group) => !group.hero?.assetPath).length;
      $("squadronHeroSummary").textContent = missingHeroCount
        ? `${missingHeroCount} of ${groups.length} squadron${groups.length === 1 ? "" : "s"} need an explicit hero. Click a tagged image to set one.`
        : `All ${groups.length} squadron${groups.length === 1 ? "" : "s"} have a selected hero. Click another image to replace one.`;

      $("squadronHeroList").innerHTML = groups.map((group) => {
        const hero = group.hero || {};
        const photos = squadronGroupPhotos(group);
        const taggedPhotoCount = photos.filter(({photo}) => !photo.customHero).length;
        const hasHero = Boolean(hero.assetPath);
        const logoStatus = group.logo
          ? (group.logoExists ? "Logo source available" : "Logo source missing")
          : "No logo selected";
        const picker = photos.length
          ? `<div class="group-hero-picker">${photos.map(({entry, photo}) => {
              const available = Boolean(photo.exists && photo.sourceAssetPath);
              const selectable = Boolean(available && !photo.customHero);
              // A squadron hero is stored on the unit, but its source photo may
              // live under any aircraft entry for that unit. Match the unique
              // raw source path rather than the entry that happened to store
              // the unit-level hero reference.
              const selected = Boolean(photo.customHero || (hero.assetPath && hero.assetPath === photo.sourceAssetPath));
              const media = available
                ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
                : `<div class="missing">Missing source</div>`;
              const label = photo.customHero
                ? "Current custom hero"
                : [entry.aircraftType || "Squadron image", formatEventDate(effectiveEventDate(photo))].filter(Boolean).join(" - ");
              return `
                <button class="group-hero-photo${selected ? " selected" : ""}" type="button"${selectable ? ` data-squadron-hero-group="${escapeHtml(group.key)}" data-squadron-hero-photo="${escapeHtml(captionPhotoKey(entry, photo.index))}"` : ""} aria-pressed="${selected}"${selectable ? "" : " disabled"}>
                  ${media}
                  <span>${escapeHtml(label)}</span>
                </button>
              `;
            }).join("")}</div>`
          : `<p class="subtle">No photos are tagged to this squadron yet.</p>`;
        return `
          <article class="group-hero-card${hasHero ? "" : " needs-hero"}">
            <div class="bulk-event-date-head">
              <div>
                <h3>${escapeHtml(group.name)}</h3>
                <p class="subtle">${escapeHtml(group.country || "Country not set")} · ${taggedPhotoCount} tagged image${taggedPhotoCount === 1 ? "" : "s"} · ${hasHero ? "Hero selected" : "No hero selected"}</p>
              </div>
              <button class="btn ghost" type="button" data-squadron-hero-clear="${escapeHtml(group.key)}"${hasHero ? "" : " disabled"}>Clear Hero</button>
            </div>
            <div class="unit-logo-editor" data-unit-logo-row="${escapeHtml(group.key)}">
              <div class="field">
                <label for="unit-logo-${escapeHtml(group.key)}">Shared squadron logo</label>
                <input id="unit-logo-${escapeHtml(group.key)}" type="text" data-unit-logo-input value="${escapeHtml(group.logo || "")}" placeholder="logos/squadron-logo.png">
              </div>
              <div class="unit-logo-status">
                <span class="tag${group.logoExists ? "" : " warn"}">${escapeHtml(logoStatus)}</span>
                <span class="subtle">Used by every aircraft type in this squadron.</span>
              </div>
              <button class="btn secondary" type="button" data-unit-logo-save="${escapeHtml(group.key)}"${group.unitId ? "" : " disabled"}>Save Logo</button>
            </div>
            ${picker}
          </article>
        `;
      }).join("");
    }

    async function saveUnitLogo(groupKey, button) {
      const group = (state.data?.squadronGroups || []).find((item) => item.key === groupKey);
      const row = button.closest("[data-unit-logo-row]");
      const input = row?.querySelector("[data-unit-logo-input]");
      if (!group?.unitId || !input) throw new Error("This squadron is no longer available. Reload and try again.");
      button.disabled = true;
      try {
        const result = await api("/api/update-unit-logo", {
          unitId: group.unitId,
          logoSource: input.value
        });
        toast(result.message);
        await loadState(true);
      } finally {
        button.disabled = false;
      }
    }

    function openUtilityDrawer(title, eyebrow, content) {
      $("utilityDrawerTitle").textContent = title;
      $("utilityDrawerEyebrow").textContent = eyebrow;
      $("utilityDrawerBody").innerHTML = content;
      $("utilityScrim").hidden = false;
      $("utilityDrawer").setAttribute("aria-hidden", "false");
      document.body.dataset.utilityOpen = "true";
      requestAnimationFrame(() => $("utilityDrawerBody").querySelector("input, select, button")?.focus());
    }

    function closeUtilityDrawer() {
      $("utilityDrawer").setAttribute("aria-hidden", "true");
      $("utilityScrim").hidden = true;
      delete document.body.dataset.utilityOpen;
    }

    function pinSelectOptions(selectedId = "") {
      return (state.data?.pins || []).map((pin) => (
        `<option value="${escapeHtml(pin.id)}"${pin.id === selectedId ? " selected" : ""}>${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
    }

    function openInlineSourceCreator() {
      openUtilityDrawer("Create photo source", "Inline creation", `
        <form class="drawer-form" data-inline-create="source">
          <div class="field"><label>Tag level</label><select name="scope"><option value="aircraft">Aircraft and unit</option><option value="squadron">Unit only</option></select></div>
          <div class="field" data-inline-aircraft><label>Aircraft type</label><input name="aircraftType" required placeholder="Lockheed C-130R"></div>
          <div class="field" data-inline-aircraft><label>Aircraft family</label><select name="aircraftFamily"><option value="fighter">Fighter</option><option value="helicopter">Helicopter</option><option value="light">Light</option><option value="medium">Medium</option><option value="heavy">Heavy</option></select></div>
          <div class="field"><label>Unit name</label><input name="unitName" required placeholder="Air Transport Squadron 61"></div>
          <div class="field"><label>Country</label><input name="country" required placeholder="Japan"></div>
          <div class="field"><label>Unit type</label><select name="unitType"><option value="squadron">Squadron</option><option value="organisation">Organisation</option></select></div>
          <p class="subtle">Existing aircraft and units are reused automatically when their names match.</p>
          <button class="btn primary" type="submit">Create and select</button>
        </form>`);
    }

    function sourceDestinationOptions(sourceKey) {
      const source = entryByTargetKey(sourceKey);
      return (state.data?.entries || [])
        .filter((entry) => (
          entry.sourceScope !== "location"
          && entry.targetKey !== sourceKey
          && !(source?.sourceScope === "squadron" && entry.unitId === source.unitId)
        ))
        .sort((left, right) => entryOptionLabel(left).localeCompare(entryOptionLabel(right)))
        .map((entry) => `<option value="${escapeHtml(entry.targetKey)}">${escapeHtml(entryOptionLabel(entry))}</option>`)
        .join("");
    }

    function openEntryEditor(targetKey) {
      const entry = entryByTargetKey(targetKey);
      if (!entry || entry.sourceScope === "location") return toast("This source is managed in the Locations workspace.");
      const isAircraft = entry.sourceScope === "aircraft";
      const unitWarning = isAircraft
        ? "Deleting this entry removes only this aircraft–unit relationship."
        : "Deleting this unit also removes every aircraft relationship owned by the unit.";
      openUtilityDrawer(entryOptionLabel(entry), "Edit photo source", `
        <form class="drawer-form" data-entry-edit="${escapeHtml(entry.targetKey)}">
          ${isAircraft ? `<div class="field"><label>Aircraft type</label><input name="aircraftType" required value="${escapeHtml(entry.aircraftType || "")}"></div><div class="field"><label>Aircraft family</label><select name="aircraftFamily">${["fighter","helicopter","light","medium","heavy"].map((family) => `<option value="${family}"${entry.aircraftFamily === family ? " selected" : ""}>${family[0].toUpperCase()}${family.slice(1)}</option>`).join("")}</select></div>` : ""}
          <div class="field"><label>Unit name</label><input name="squadronName" required value="${escapeHtml(entry.squadronName || "")}"></div>
          <div class="field"><label>Country</label><input name="country" required value="${escapeHtml(entry.country || "")}"></div>
          <div class="field"><label>Unit type</label><select name="unitType"><option value="squadron"${entry.unitType === "squadron" ? " selected" : ""}>Squadron</option><option value="organisation"${entry.unitType === "organisation" ? " selected" : ""}>Organisation</option></select></div>
          ${isAircraft ? "" : `<div class="field"><label>Shared unit logo</label><input name="squadronLogo" value="${escapeHtml(entry.squadronLogo || "")}" placeholder="logos/unit-logo.png"></div>`}
          <button class="btn primary" type="submit">Save Entry</button>
        </form>
        <section class="drawer-danger-zone" data-entry-delete-zone="${escapeHtml(entry.targetKey)}">
          <h3>Delete entry</h3>
          <p class="subtle">${escapeHtml(unitWarning)} Photo records and raw files are never deleted.</p>
          <label class="choice-row"><input type="radio" name="deleteMode" value="transfer" checked> Transfer affected photos to another entry</label>
          <div class="field" data-transfer-destination><label>Destination entry</label><select data-delete-destination><option value="">Choose destination</option>${sourceDestinationOptions(entry.targetKey)}</select></div>
          <label class="choice-row"><input type="radio" name="deleteMode" value="untag"> Untag affected photos</label>
          <button class="btn danger" type="button" data-delete-entry-confirm="${escapeHtml(entry.targetKey)}">Delete Entry</button>
        </section>`);
    }

    function openInlineLocationCreator() {
      openUtilityDrawer("Create location", "Inline creation", `
        <form class="drawer-form" data-inline-create="location">
          <div class="field"><label>Country</label><input name="country" required placeholder="Japan"></div>
          <div class="field"><label>Name</label><input name="name" required placeholder="Atsugi Air Base"></div>
          <div class="form-grid"><div class="field"><label>ICAO / map code</label><input name="icao" minlength="2" maxlength="4" placeholder="RJTA or SG"></div><div class="field"><label>ID override</label><input name="id" placeholder="atsugi-air-base"></div></div>
          <div class="form-grid"><div class="field"><label>Latitude</label><input name="lat" required inputmode="decimal"></div><div class="field"><label>Longitude</label><input name="lon" required inputmode="decimal"></div></div>
          <button class="btn primary" type="submit">Create and select</button>
        </form>`);
    }

    function openLocationEditor(locationId) {
      const pin = (state.data?.pins || []).find((item) => item.id === locationId);
      if (!pin) return toast("This location is no longer available. Reload and try again.");
      openUtilityDrawer(pin.name, "Location database", `
        <form class="drawer-form" data-location-edit="${escapeHtml(pin.id)}">
          <div class="field"><label>Location name</label><input name="name" required value="${escapeHtml(pin.name || "")}"></div>
          <div class="field"><label>Country</label><input name="country" required value="${escapeHtml(pin.country || "")}"></div>
          <div class="field"><label>ICAO / map code</label><input name="icao" minlength="2" maxlength="4" value="${escapeHtml(pin.icao || "")}"></div>
          <div class="form-grid"><div class="field"><label>Latitude</label><input name="lat" required inputmode="decimal" value="${escapeHtml(pin.lat ?? "")}"></div><div class="field"><label>Longitude</label><input name="lon" required inputmode="decimal" value="${escapeHtml(pin.lon ?? "")}"></div></div>
          <div class="field"><label>Status</label><select name="enabled"><option value="1"${pin.enabled ? " selected" : ""}>Enabled</option><option value="0"${pin.enabled ? "" : " selected"}>Disabled</option></select></div>
          <p class="subtle">Location ID <code>${escapeHtml(pin.id)}</code> is immutable because photos and links reference it.</p>
          <button class="btn primary" type="submit">Save Location</button>
        </form>`);
    }

    function openInlineEventCreator() {
      const selected = selectedPin();
      openUtilityDrawer("Create event", "Inline creation", `
        <form class="drawer-form" data-inline-create="event">
          <div class="field"><label>Event name</label><input name="name" required value="${escapeHtml($("airshowInput").value)}" placeholder="Singapore Airshow 2026"></div>
          <div class="field"><label>Location</label><select name="locationId" required><option value="">Choose a location</option>${pinSelectOptions(selected?.id || "")}</select></div>
          <div class="form-grid"><div class="field"><label>Starts on</label><input name="startsOn" type="date" value="${escapeHtml($("photoDate").value)}"></div><div class="field"><label>Ends on</label><input name="endsOn" type="date" value="${escapeHtml($("photoDate").value)}"></div></div>
          <button class="btn primary" type="submit">Create and select</button>
        </form>`);
    }

    function inspectorPhotos(photos) {
      const available = (photos || []).filter((photo) => photo.sourceAssetPath).slice(0, 8);
      if (!available.length) return `<div class="empty">No related photos</div>`;
      return `<div class="inspector-photo-grid">${available.map((photo) => `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`).join("")}</div>`;
    }

    function inspectSelectedSource() {
      const entry = selectedEntry();
      if (!entry) return toast("Choose a photo source first.");
      const related = (state.data.entries || []).filter((item) => item.unitId && item.unitId === entry.unitId);
      const photoCount = related.reduce((total, item) => total + (item.photos?.length || 0), 0);
      openUtilityDrawer(entry.aircraftType || entry.squadronName || "Photo source", "Entity inspector", `
        <div class="inspector-stack">
          <div class="inspector-facts"><span>Scope<strong>${escapeHtml(entry.sourceScope)}</strong></span><span>Country<strong>${escapeHtml(entry.country || "—")}</strong></span><span>Photos<strong>${photoCount}</strong></span><span>Issues<strong>${(entry.entryMissingFields || []).length}</strong></span></div>
          ${entry.aircraftType ? `<section><h3>Aircraft</h3><p><strong>${escapeHtml(entry.aircraftType)}</strong><br><span class="subtle">${escapeHtml(entry.aircraftFamily || "Family not set")} · ${escapeHtml(entry.aircraftId || "")}</span></p></section>` : ""}
          <section><h3>Unit</h3><p><strong>${escapeHtml(entry.squadronName || "—")}</strong><br><span class="subtle">${escapeHtml(entry.unitLabel || entry.unitType || "Unit")} · ${escapeHtml(entry.unitId || "")}</span></p><p class="subtle">Logo: ${escapeHtml(entry.squadronLogo || "not set")} · Hero: ${escapeHtml(entry.squadronHero || "not set")}</p></section>
          <section><h3>Related photos</h3>${inspectorPhotos(related.flatMap((item) => item.photos || []))}</section>
        </div>`);
    }

    function inspectSelectedLocation() {
      const pin = selectedPin();
      if (!pin) return toast("Choose a location first.");
      const photos = (state.data.masterPhotos || []).filter((photo) => photo.locationId === pin.id);
      openUtilityDrawer(pin.name, "Location inspector", `<div class="inspector-stack"><div class="inspector-facts"><span>Country<strong>${escapeHtml(pin.country)}</strong></span><span>ICAO<strong>${escapeHtml(pin.icao || "—")}</strong></span><span>Photos<strong>${photos.length}</strong></span><span>Hero<strong>${pin.heroAssetPath ? "Set" : "Missing"}</strong></span></div><p class="subtle">${escapeHtml(pin.id)} · ${pin.lat}, ${pin.lon}</p><section><h3>Related photos</h3>${inspectorPhotos(photos)}</section></div>`);
    }

    function inspectSelectedEvent() {
      const name = $("airshowInput").value.trim();
      if (!name) return toast("Enter or choose an event first.");
      const event = (state.data.airshowEvents || []).find((item) => item.name.toLowerCase() === name.toLowerCase());
      const photos = (state.data.masterPhotos || []).filter((photo) => String(photo.airshow || "").toLowerCase() === name.toLowerCase());
      const locations = [...new Set(photos.map((photo) => photo.locationName || photo.location).filter(Boolean))];
      const dates = photos.map((photo) => photo.date || photo.exifDate).filter(Boolean).sort();
      openUtilityDrawer(event?.name || name, "Event inspector", `<div class="inspector-stack"><div class="inspector-facts"><span>Catalogued<strong>${event ? "Yes" : "No"}</strong></span><span>Photos<strong>${photos.length}</strong></span><span>Locations<strong>${locations.length}</strong></span><span>Date range<strong>${dates.length ? `${escapeHtml(dates[0])}–${escapeHtml(dates.at(-1))}` : "—"}</strong></span></div><p class="subtle">${escapeHtml(locations.join(" · ") || "No linked locations")}</p><section><h3>Related photos</h3>${inspectorPhotos(photos)}</section></div>`);
    }

    function allMissingIssues() {
      const issues = [];
      for (const entry of state.data.entries || []) {
        if (entry.entryMissingFields?.length) {
          issues.push({
            key: `entry::${entry.targetKey}`,
            type: "entry",
            entry,
            missingFields: entry.entryMissingFields,
            labels: entry.entryMissingFields.map((field) => missingFieldLabels[field] || field)
          });
        }
        for (const photo of entry.photos || []) {
          if (photo.invalid || !photo.missingFields?.length) continue;
          issues.push({
            key: `photo::${entry.targetKey}::${photo.index}`,
            type: "photo",
            entry,
            photo,
            missingFields: photo.missingFields,
            labels: photo.missingFields.map((field) => missingFieldLabels[field] || field)
          });
        }
      }
      return issues;
    }

    function filteredMissingIssues() {
      const all = allMissingIssues();
      const term = $("missingSearch").value.trim().toLowerCase();
      const field = $("missingFilter").value;
      return all.filter((issue) => {
        if (field === "entry" && issue.type !== "entry") return false;
        if (field && field !== "entry" && !issue.missingFields.includes(field)) return false;
        if (!term) return true;
        const haystack = [
          issue.type,
          issue.entry.aircraftType,
          issue.entry.squadronName,
          issue.entry.country,
          issue.entry.entryPath,
          issue.photo?.path,
          issue.photo?.location,
          issue.photo?.airshow,
          issue.photo?.caption,
          ...issue.labels
        ].join(" ").toLowerCase();
        return haystack.includes(term);
      });
    }

    function renderQualitySettings() {
      const settings = state.data?.qualitySettings || {};
      document.querySelectorAll("[data-quality-setting]").forEach((input) => {
        const key = input.dataset.qualitySetting;
        if (!(key in settings) || document.activeElement === input) return;
        if (input.type === "checkbox") input.checked = Boolean(settings[key]);
        else input.value = settings[key];
      });
      $("qualitySettingsStatus").textContent = state.data
        ? qualityScanActive()
          ? "Quality check is running in the background. Settings changes start a fresh scan."
          : "Empty-space detection settings apply to the next quality scan."
        : "";
    }

    function collectQualitySettings() {
      const settings = {...(state.data?.qualitySettings || {})};
      document.querySelectorAll("[data-quality-setting]").forEach((input) => {
        settings[input.dataset.qualitySetting] = input.type === "checkbox"
          ? input.checked
          : Number(input.value);
      });
      return settings;
    }

    async function saveQualitySettings(reset = false) {
      const result = await api("/api/save-quality-settings", reset ? {reset: true} : {settings: collectQualitySettings()});
      toast(result.message);
      await loadState(true);
    }

    function renderBuildSettings() {
      const settings = state.data?.buildSettings || {};
      document.querySelectorAll("[data-build-setting]").forEach((input) => {
        const key = input.dataset.buildSetting;
        if (!(key in settings) || document.activeElement === input) return;
        input.value = settings[key];
      });
      $("buildSettingsStatus").textContent = state.data
        ? "These values are used by the next build. Save settings to keep them for future sessions."
        : "";
    }

    function collectBuildSettings() {
      const defaults = state.data?.buildSettings || {};
      const settings = {};
      document.querySelectorAll("[data-build-setting]").forEach((input) => {
        const value = Number(input.value);
        settings[input.dataset.buildSetting] = Number.isFinite(value) && value > 0
          ? value
          : defaults[input.dataset.buildSetting];
      });
      return settings;
    }

    async function saveBuildSettings(reset = false) {
      const result = await api("/api/save-build-settings", reset ? {reset: true} : {settings: collectBuildSettings()});
      toast(result.message);
      await loadState(true);
    }

    function getSelectedIssue() {
      return allMissingIssues().find((issue) => issue.key === state.selectedIssueKey) || null;
    }

    function renderMissingFields() {
      const all = allMissingIssues();
      const issues = filteredMissingIssues();
      if (!issues.some((issue) => issue.key === state.selectedIssueKey)) {
        state.selectedIssueKey = issues[0]?.key || "";
      }
      $("missingSummary").textContent = `${issues.length} of ${all.length} item(s)`;
      if (!issues.length) {
        $("missingList").innerHTML = `<div class="empty">No missing fields</div>`;
        $("missingEditor").innerHTML = `<div class="empty">No item selected</div>`;
        return;
      }
      $("missingList").innerHTML = issues.map((issue) => {
        const active = issue.key === state.selectedIssueKey ? " active" : "";
        const media = issue.type === "photo" && issue.photo.exists && issue.photo.sourceAssetPath
          ? `<img src="${thumbUrl(issue.photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(issue.photo.path)}">`
          : "";
        const title = issue.type === "entry"
          ? `${issue.entry.aircraftType} / ${issue.entry.squadronName}`
          : issue.photo.path;
        const meta = issue.type === "entry"
          ? issue.entry.entryPath
          : `${issue.entry.aircraftType} / ${issue.entry.squadronName}`;
        return `
          <button class="issue-card${active}" type="button" data-issue="${escapeHtml(issue.key)}">
            ${media}
            <div class="mini-title">${escapeHtml(title)}</div>
            <div class="mini-meta">${escapeHtml(meta)}</div>
            <div class="issue-tags">${issue.labels.map((label) => `<span class="issue-chip">${escapeHtml(label)}</span>`).join("")}</div>
          </button>
        `;
      }).join("");
      renderMissingEditor();
    }

    function renderMissingEditor() {
      const issue = getSelectedIssue();
      if (!issue) {
        $("missingEditor").innerHTML = `<div class="empty">No item selected</div>`;
        return;
      }
      if (issue.type === "entry") {
        renderMissingEntryEditor(issue);
      } else {
        renderMissingPhotoEditor(issue);
      }
    }

    function renderMissingEntryEditor(issue) {
      const isUnitEntry = issue.entry.sourceScope === "squadron";
      const aircraftFields = isUnitEntry ? "" : `
          <div class="field wide">
            <label for="missingEntryAircraftType">Aircraft Type</label>
            <input id="missingEntryAircraftType" type="text" value="${escapeHtml(issue.entry.aircraftType || "")}">
          </div>
          <div class="field">
            <label for="missingEntryAircraftFamily">Aircraft Family</label>
            <select id="missingEntryAircraftFamily">
              <option value="">No family</option>
              <option value="fighter"${issue.entry.aircraftFamily === "fighter" ? " selected" : ""}>Fighter</option>
              <option value="light"${issue.entry.aircraftFamily === "light" ? " selected" : ""}>Light</option>
              <option value="medium"${issue.entry.aircraftFamily === "medium" ? " selected" : ""}>Medium</option>
              <option value="heavy"${issue.entry.aircraftFamily === "heavy" ? " selected" : ""}>Heavy</option>
              <option value="helicopter"${issue.entry.aircraftFamily === "helicopter" ? " selected" : ""}>Helicopter</option>
            </select>
          </div>`;
      const logoField = isUnitEntry ? `
          <div class="field wide">
            <label for="missingEntrySquadronLogo">Shared Unit Logo</label>
            <input id="missingEntrySquadronLogo" type="text" value="${escapeHtml(issue.entry.squadronLogo || "")}" placeholder="logos/unit-logo.png">
            <div class="subtle">This single source is reused for every aircraft type assigned to the unit.</div>
          </div>` : "";
      $("missingEditor").innerHTML = `
        <div class="form-grid">
          ${aircraftFields}
          <div class="field wide">
            <label for="missingEntrySquadronName">Unit Name</label>
            <input id="missingEntrySquadronName" type="text" value="${escapeHtml(issue.entry.squadronName || "")}">
          </div>
          ${logoField}
          <div class="field">
            <label for="missingEntryCountry">Country</label>
            <input id="missingEntryCountry" type="text" value="${escapeHtml(issue.entry.country || "")}">
          </div>
          <div class="field">
            <label for="missingEntryUnitType">Unit Type</label>
            <select id="missingEntryUnitType">
              <option value="squadron"${issue.entry.unitType === "squadron" ? " selected" : ""}>Squadron</option>
              <option value="organisation"${issue.entry.unitType === "organisation" ? " selected" : ""}>Organisation</option>
            </select>
          </div>
        </div>
        <div class="mini-meta" style="margin-top: 10px;">${escapeHtml(issue.entry.entryPath)}</div>
        <div class="bar"><button class="btn secondary" id="saveMissingEntryBtn" type="button">Save Entry</button></div>
      `;
    }

    function renderMissingPhotoEditor(issue) {
      state.captionAssist.missingPhotoKey = "";
      const selectedPin = state.data.pins.find((pin) => pin.id === issue.photo.pinId || pin.name === issue.photo.location);
      const pinOptions = state.data.pins.map((pin) => (
        `<option value="${escapeHtml(pin.key)}"${selectedPin?.key === pin.key ? " selected" : ""}>${escapeHtml(pinOptionLabel(pin))}</option>`
      )).join("");
      $("missingEditor").innerHTML = `
        <div class="form-grid">
          <div class="field wide">
            <label for="missingPhotoPath">Path</label>
            <input id="missingPhotoPath" type="text" value="${escapeHtml(issue.photo.path || "")}">
          </div>
          <div class="field wide">
            <label for="missingPhotoLocation">Location</label>
            <select id="missingPhotoLocation"><option value="">No location</option>${pinOptions}</select>
          </div>
          <div class="field wide">
            <label for="missingPhotoAirshow">Airshow Event (optional)</label>
            <input id="missingPhotoAirshow" type="text" value="${escapeHtml(issue.photo.airshow || "")}">
          </div>
          <div class="field">
            <label for="missingPhotoDate">Date</label>
            <input id="missingPhotoDate" type="date" value="${escapeHtml(issue.photo.date || "")}">
          </div>
          <div class="field">
            <label for="missingPhotoYear">Year</label>
            <input id="missingPhotoYear" type="text" inputmode="numeric" value="${escapeHtml(issue.photo.year || "")}">
          </div>
          <div class="field wide">
            <label for="missingPhotoCaption">Caption</label>
            <textarea id="missingPhotoCaption">${escapeHtml(issue.photo.caption || "")}</textarea>
            <div class="caption-actions">
              <span class="subtle">Uses Nemotron 3 Omni; review before saving.</span>
              <button class="btn ghost" id="generateMissingCaptionBtn" type="button">AI Caption</button>
            </div>
          </div>
        </div>
        <div class="mini-meta" style="margin-top: 10px;">
          ${escapeHtml(issue.entry.aircraftType)} / ${escapeHtml(issue.entry.squadronName)}<br>
          ${escapeHtml(issue.entry.entryPath)}<br>
          EXIF: ${escapeHtml(issue.photo.exifDate || "None")}
        </div>
        <div class="bar"><button class="btn secondary" id="saveMissingPhotoBtn" type="button">Save Photo</button></div>
      `;
    }

    function fillEditor(index) {
      const entry = selectedEntry();
      if (!entry) return;
      const photo = entry.photos.find((item) => item.index === index);
      if (!photo || photo.invalid) return;
      state.captionAssist.editPhotoKey = "";
      $("editIndex").value = String(index);
      $("editPath").value = photo.path || "";
      $("editDate").value = photo.date || "";
      $("editYear").value = photo.year || "";
      $("editAirshow").value = photo.airshow || "";
      $("editLivery").value = photo.livery || "";
      $("editCaption").value = photo.caption || "";
      $("editTagTarget").value = ["aircraft", "squadron"].includes(entry.sourceScope) ? entry.targetKey : "";
      const matchingPin = state.data.pins.find((pin) => pin.id === photo.pinId || pin.name === photo.location);
      $("editLocation").value = matchingPin ? matchingPin.key : "";
    }

    function clearEditor() {
      state.captionAssist.editPhotoKey = "";
      $("editIndex").value = "";
      $("editPath").value = "";
      $("editDate").value = "";
      $("editYear").value = "";
      $("editAirshow").value = "";
      $("editLivery").value = "";
      $("editCaption").value = "";
      $("editTagTarget").value = "";
      $("editLocation").value = "";
    }

    async function populateCaption(buttonId, targetId, payload) {
      const button = $(buttonId);
      const originalLabel = button ? button.textContent : "AI Caption";
      if (button) {
        button.disabled = true;
        button.textContent = "Writing...";
      }
      try {
        const result = await api("/api/generate-caption", payload);
        $(targetId).value = result.caption || "";
        toast(result.message || "Caption suggestion ready. Review it before saving.");
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    }

    async function generateAttachCaption() {
      const entry = selectedEntry();
      if (!entry) throw new Error("Choose an entry before generating a caption.");
      if (state.selectedAssets.size !== 1) {
        throw new Error("Select exactly one raw image to generate an attachment caption.");
      }
      const pin = selectedPin("pinSelect");
      const [assetPath] = [...state.selectedAssets];
      await populateCaption("generateAttachCaptionBtn", "captionInput", {
        ...attachTargetRequestFields(entry),
        assetPath,
        locationName: pin ? pin.name : "",
        airshow: $("airshowInput").value,
        livery: $("liveryInput").value,
        draftCaption: $("captionInput").value
      });
      state.captionAssist.attachAssetPath = assetPath;
    }

    async function generateEditedCaption() {
      const entry = selectedEntry();
      const index = $("editIndex").value;
      if (!entry || index === "") throw new Error("Choose a photo to edit before generating a caption.");
      const pin = selectedPin("editLocation");
      await populateCaption("generateEditCaptionBtn", "editCaption", {
        ...entryRequestFields(entry),
        index: Number(index),
        locationName: pin ? pin.name : "",
        airshow: $("editAirshow").value,
        livery: $("editLivery").value,
        draftCaption: $("editCaption").value
      });
      state.captionAssist.editPhotoKey = captionPhotoKey(entry, Number(index));
    }

    async function generateMissingCaption() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "photo") throw new Error("Choose a photo item before generating a caption.");
      const pin = state.data.pins.find((item) => item.key === $("missingPhotoLocation").value);
      await populateCaption("generateMissingCaptionBtn", "missingPhotoCaption", {
        ...entryRequestFields(issue.entry),
        index: issue.photo.index,
        locationName: pin ? pin.name : "",
        airshow: $("missingPhotoAirshow").value,
        draftCaption: $("missingPhotoCaption").value
      });
      state.captionAssist.missingPhotoKey = captionPhotoKey(issue.entry, issue.photo.index);
    }

    async function attachSelected() {
      const entry = selectedEntry();
      if (!entry) throw new Error("Choose an entry.");
      const pin = selectedPin("pinSelect");
      const selectedAssetPaths = [...state.selectedAssets];
      const aiCaptionAssetPath = state.captionAssist.attachAssetPath;
      if (aiCaptionAssetPath && (selectedAssetPaths.length !== 1 || selectedAssetPaths[0] !== aiCaptionAssetPath)) {
        throw new Error("The AI caption belongs to one selected image. Re-select it or generate a new caption before attaching.");
      }
      const payload = {
        ...attachTargetRequestFields(entry),
        assetPaths: selectedAssetPaths,
        locationName: pin ? pin.name : "",
        pinId: pin ? pin.id : "",
        airshow: $("airshowInput").value,
        livery: $("liveryInput").value,
        caption: $("captionInput").value,
        captionAiAssisted: Boolean(aiCaptionAssetPath),
        date: $("photoDate").value,
        year: $("photoYear").value,
        dedupe: $("dedupeSelect").value !== "allow"
      };
      const result = await api("/api/attach", payload);
      state.selectedAssets.clear();
      state.captionAssist.attachAssetPath = "";
      toast(result.message);
      await loadState(false);
    }

    async function saveEditedPhoto() {
      const entry = selectedEntry();
      const index = $("editIndex").value;
      if (!entry || index === "") throw new Error("Choose a photo to edit.");
      const pin = selectedPin("editLocation");
      const tagTarget = entryByTargetKey($("editTagTarget").value);
      const payload = {
        ...entryRequestFields(entry),
        index: Number(index),
        tagTargetEntryPath: tagTarget?.sourceScope === "squadron-target" ? "" : tagTarget?.entryPath || "",
        tagTargetScope: tagTarget?.sourceScope === "squadron-target" ? "" : tagTarget?.sourceScope || "",
        tagTargetSquadron: tagTarget?.sourceScope === "squadron-target" ? squadronTargetPayload(tagTarget) : null,
        photo: {
          path: $("editPath").value,
          location: pin ? pin.name : "",
          pin_id: pin ? pin.id : "",
          date: $("editDate").value,
          year: $("editYear").value,
          airshow: $("editAirshow").value,
          livery: $("editLivery").value,
          caption: $("editCaption").value,
          captionAiAssisted: state.captionAssist.editPhotoKey === captionPhotoKey(entry, Number(index))
        }
      };
      const result = await api("/api/update-photo", payload);
      toast(result.message);
      state.captionAssist.editPhotoKey = "";
      clearEditor();
      await loadState(true);
    }

    function masterField(row, name) {
      return row.querySelector(`[data-master-field="${name}"]`);
    }

    async function saveMasterPhoto(photoId, button) {
      const row = button.closest("[data-master-row]");
      if (!row) return;
      button.disabled = true;
      try {
        const result = await api("/api/update-master-photo", {
          photoId,
          photo: {
            locationId: masterField(row, "locationId").value,
            date: masterField(row, "date").value,
            airshow: masterField(row, "airshow").value,
            title: masterField(row, "title").value,
            livery: masterField(row, "livery").value,
            caption: masterField(row, "caption").value
          }
        });
        toast(result.message);
        await loadState(true);
      } finally {
        button.disabled = false;
      }
    }

    async function detachMasterPhoto(photoId) {
      const photo = (state.data?.masterPhotos || []).find((item) => item.id === photoId);
      if (!photo) return;
      const confirmed = window.confirm(
        `Detach this raw image from the database?\n\n${photo.path}\n\nThe file in raw_assets will not be deleted.`
      );
      if (!confirmed) return;
      const result = await api("/api/delete-master-photo", {photoId});
      toast(result.message);
      await loadState(true);
    }

    async function saveMissingPhoto() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "photo") throw new Error("Choose a photo item.");
      const pin = state.data.pins.find((item) => item.key === $("missingPhotoLocation").value);
      const result = await api("/api/update-photo", {
        ...entryRequestFields(issue.entry),
        index: issue.photo.index,
        photo: {
          path: $("missingPhotoPath").value,
          location: pin ? pin.name : "",
          pin_id: pin ? pin.id : "",
          date: $("missingPhotoDate").value,
          year: $("missingPhotoYear").value,
          airshow: $("missingPhotoAirshow").value,
          title: issue.photo.title || "",
          caption: $("missingPhotoCaption").value,
          captionAiAssisted: state.captionAssist.missingPhotoKey === captionPhotoKey(issue.entry, issue.photo.index)
        }
      });
      toast(result.message);
      state.captionAssist.missingPhotoKey = "";
      state.selectedIssueKey = "";
      await loadState(true);
      renderMissingFields();
    }

    async function saveMissingEntry() {
      const issue = getSelectedIssue();
      if (!issue || issue.type !== "entry") throw new Error("Choose an entry item.");
      const payload = {
        entryPath: issue.entry.entryPath,
        unitId: issue.entry.unitId || "",
        scope: issue.entry.sourceScope,
        squadronName: $("missingEntrySquadronName").value,
        country: $("missingEntryCountry").value,
        unitType: $("missingEntryUnitType").value
      };
      if (issue.entry.sourceScope === "squadron") {
        payload.squadronLogo = $("missingEntrySquadronLogo").value;
      } else {
        payload.aircraftType = $("missingEntryAircraftType").value;
        payload.aircraftFamily = $("missingEntryAircraftFamily").value;
      }
      const result = await api("/api/update-entry", payload);
      toast(result.message);
      state.selectedIssueKey = "";
      await loadState(true);
      renderMissingFields();
    }

    async function deletePhoto(index) {
      const entry = selectedEntry();
      if (!entry) return;
      const result = await api("/api/delete-photo", {...entryRequestFields(entry), index});
      toast(result.message);
      clearEditor();
      await loadState(true);
    }

    async function openCreatedSource(result) {
      toast(result.message);
      await loadState(false);
      $("entrySelect").value = result.entryPath;
      setTab("attach");
      renderEntryDetail();
    }

    async function createSquadronSource() {
      const result = await api("/api/create-entry", {
        scope: "squadron",
        squadronName: $("newSquadronSourceName").value,
        country: $("newSquadronSourceCountry").value,
        unitType: $("newSquadronSourceType").value
      });
      $("newSquadronSourceName").value = "";
      $("newSquadronSourceCountry").value = "";
      await openCreatedSource(result);
    }

    async function createAircraftSource() {
      const result = await api("/api/create-entry", {
        scope: "aircraft",
        aircraftType: $("newAircraftSourceType").value,
        aircraftFamily: $("newAircraftSourceFamily").value,
        aircraftDoubleWidth: $("newAircraftSourceDisplayWidth").value,
        squadronName: $("newAircraftSourceSquadron").value,
        country: $("newAircraftSourceCountry").value,
        unitType: $("newAircraftSourceUnitType").value
      });
      $("newAircraftSourceType").value = "";
      $("newAircraftSourceFamily").value = "";
      $("newAircraftSourceDisplayWidth").value = "";
      $("newAircraftSourceSquadron").value = "";
      $("newAircraftSourceCountry").value = "";
      await openCreatedSource(result);
    }

    async function createPin() {
      const result = await api("/api/create-pin", {
        country: $("pinCountry").value,
        name: $("pinName").value,
        icao: $("pinIcao").value,
        id: $("pinId").value,
        lat: $("pinLat").value,
        lon: $("pinLon").value
      });
      toast(result.message);
      await loadState(true);
    }

    async function setLocationHero(pinKey) {
      if (state.selectedAssets.size !== 1) {
        throw new Error("Select exactly one raw asset first.");
      }
      const pin = pinByKey(pinKey);
      if (!pin) throw new Error("This location is no longer available. Reload and try again.");
      const [assetPath] = [...state.selectedAssets];
      const result = await api("/api/set-pin-hero", {
        pinPath: pin.pinPath,
        pinId: pin.id,
        assetPath
      });
      toast(result.message);
      await loadState(true);
    }

    async function setLocationHeroFromPhoto(pinKey, photoKey) {
      const pin = pinByKey(pinKey);
      const reference = photoReferenceByKey(photoKey);
      if (!pin || !reference?.photo?.sourceAssetPath) throw new Error("Choose an available location photo.");
      const result = await api("/api/set-pin-hero", {
        pinPath: pin.pinPath,
        pinId: pin.id,
        assetPath: reference.photo.sourceAssetPath
      });
      toast(result.message);
      await loadState(true);
    }

    async function clearLocationHero(pinKey) {
      const pin = pinByKey(pinKey);
      if (!pin) throw new Error("This location is no longer available. Reload and try again.");
      const result = await api("/api/set-pin-hero", {pinPath: pin.pinPath, pinId: pin.id, clear: true});
      toast(result.message);
      await loadState(true);
    }

    async function setSquadronHero(groupKey, photoKey = "") {
      const group = squadronGroupByKey(groupKey);
      if (!group) throw new Error("This squadron is no longer available. Reload and try again.");
      const reference = photoKey ? photoReferenceByKey(photoKey) : null;
      if (photoKey && !reference) throw new Error("The selected squadron photo is no longer available.");
      const result = await api("/api/set-squadron-hero", {
        squadronName: group.name,
        country: group.country,
        hero: reference ? {...entryRequestFields(reference.entry), index: reference.photo.index} : null
      });
      toast(result.message);
      await loadState(true);
    }

    async function setAircraftHero(aircraftId, photoId = "") {
      const aircraft = (state.data?.aircraftCatalog || []).find((item) => item.id === aircraftId);
      if (!aircraft) throw new Error("This aircraft type is no longer available. Reload and try again.");
      const result = await api("/api/set-aircraft-hero", {aircraftId: aircraft.id, photoId});
      toast(result.message);
      await loadState(true);
    }

    async function saveAircraftSettings(aircraftId, button) {
      const row = button.closest("[data-aircraft-settings-row]");
      const select = row?.querySelector("[data-aircraft-width]");
      if (!select) throw new Error("Choose an aircraft card width first.");
      const result = await api("/api/update-aircraft-settings", {
        aircraftId,
        doubleWidth: select.value
      });
      toast(result.message);
      await loadState(true);
    }

    function appendBuildLog(line, stream = "stdout") {
      const prefix = stream === "stderr" ? "stderr" : "stdout";
      $("buildLog").textContent += `${prefix}: ${line}\n`;
      $("buildLog").scrollTop = $("buildLog").scrollHeight;
    }

    function renderBuildSummary(summary) {
      const counts = summary.manifestCounts || [];
      const changes = summary.generatedChanges || {changes: {}, totals: {}, categoryTotals: {}};
      const warnings = summary.warnings || [];
      const notes = summary.notes || [];
      const scope = summary.commitScope || {sections: [], recommendedGlobs: [], excluded: []};
      const database = summary.databaseStatus || {};
      const totalChanges = Object.values(changes.totals || {}).reduce((sum, value) => sum + Number(value || 0), 0);

      $("buildSummary").innerHTML = `
        <div class="summary-grid">
          <div class="summary-card">
            <h3>Manifest Counts</h3>
            ${renderCountTable(counts)}
          </div>
          <div class="summary-card">
            <h3>Generated Changes</h3>
            <div class="mini-meta">
              ${totalChanges} file change(s)<br>
              ${Number(changes.categoryTotals?.photos || 0)} photos,
              ${Number(changes.categoryTotals?.thumbs || 0)} thumbs,
              ${Number(changes.categoryTotals?.logos || 0)} logos,
              ${Number(changes.categoryTotals?.data || 0)} data files
            </div>
          </div>
          <div class="summary-card">
            <h3>Warnings</h3>
            ${renderWarningList(warnings, notes)}
          </div>
          <div class="summary-card">
            <h3>Canonical Database</h3>
            <div class="mini-meta">
              Integrity: ${escapeHtml(database.integrity || "unknown")}<br>
              SQL snapshot: ${database.snapshotCurrent ? "current" : "stale"}
            </div>
            ${database.errors?.length ? renderWarningList(database.errors, []) : ""}
          </div>
          <div class="summary-card">
            <h3>Commit Scope</h3>
            ${renderCommitScope(scope)}
          </div>
        </div>
        ${renderChangeGroups(changes)}
      `;
    }

    function renderCountTable(rows) {
      return `
        <table class="count-table">
          <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Delta</th></tr></thead>
          <tbody>
            ${rows.map((row) => {
              const delta = row.delta === "" ? "" : Number(row.delta || 0);
              const deltaClass = delta > 0 ? "delta-pos" : delta < 0 ? "delta-neg" : "";
              const deltaText = row.delta === "" ? "" : `${delta > 0 ? "+" : ""}${delta}`;
              return `
                <tr>
                  <td>${escapeHtml(row.label)}</td>
                  <td>${escapeHtml(row.before)}</td>
                  <td>${escapeHtml(row.after)}</td>
                  <td class="${deltaClass}">${escapeHtml(deltaText)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `;
    }

    function renderWarningList(warnings, notes) {
      const items = [
        ...warnings.map((line) => ({className: "", line})),
        ...notes.map((line) => ({className: "mini-meta", line}))
      ];
      if (!items.length) return `<div class="mini-meta">No warnings or notes</div>`;
      return `<ul class="warning-list">${items.map((item) => `<li class="${item.className}">${escapeHtml(item.line)}</li>`).join("")}</ul>`;
    }

    function renderCommitScope(scope) {
      const included = (scope.sections || []).filter((section) => section.include);
      const sectionHtml = included.length
        ? included.map((section) => {
          const files = section.files?.length
            ? `<ul class="change-list">${section.files.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>`
            : `<div class="mini-meta">Include matching generated output if present.</div>`;
          return `<details class="change-group"><summary>${escapeHtml(section.label)} (${section.files?.length || 0})</summary>${files}</details>`;
        }).join("")
        : `<div class="mini-meta">No tracked commit-scope files changed.</div>`;
      return `
        <div class="mini-meta">Recommended globs: ${(scope.recommendedGlobs || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(", ")}</div>
        <div class="mini-meta">Exclude: ${(scope.excluded || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(", ")}</div>
        ${sectionHtml}
      `;
    }

    function renderChangeGroups(changes) {
      const labels = {
        added: "Added",
        modified: "Modified",
        deleted: "Deleted"
      };
      const categories = [
        ["photos", "Generated photos"],
        ["thumbs", "Generated thumbs"],
        ["logos", "Published logos"],
        ["data", "Generated data"],
        ["other", "Other generated output"]
      ];
      return Object.entries(labels).map(([kind, label]) => {
        const groups = categories.map(([category, categoryLabel]) => {
          const files = changes.changes?.[kind]?.[category] || [];
          if (!files.length) return "";
          return `
            <details class="change-group" open>
              <summary>${escapeHtml(label)} ${escapeHtml(categoryLabel)} (${files.length})</summary>
              <ul class="change-list">
                ${files.map((file) => `
                  <li>
                    <code>${escapeHtml(file.path)}</code>
                    <span>${escapeHtml(file.afterSizeLabel || file.beforeSizeLabel || "")}</span>
                  </li>
                `).join("")}
              </ul>
            </details>
          `;
        }).join("");
        return groups;
      }).join("") || `<div class="empty">No generated file changes</div>`;
    }

    async function runBuild() {
      const buildSettings = collectBuildSettings();
      $("buildBtn").disabled = true;
      $("buildBtn2").disabled = true;
      $("buildStatus").textContent = "Running";
      $("buildLog").textContent = "";
      $("buildSummary").innerHTML = "";
      state.orphans = {scanned: false, ready: false, items: [], message: ""};
      renderOrphans();
      setTab("build");
      await new Promise((resolve, reject) => {
        let finished = false;
        const params = new URLSearchParams({nonce: String(Date.now())});
        Object.entries({
          width: buildSettings.image_width,
          "thumb-width": buildSettings.thumbnail_width,
          "jpeg-quality": buildSettings.image_jpeg_quality,
          "thumb-jpeg-quality": buildSettings.thumbnail_jpeg_quality
        }).forEach(([key, value]) => params.set(key, String(value)));
        const source = new EventSource(`/api/build-stream?${params.toString()}`);

        source.addEventListener("status", (event) => {
          const payload = JSON.parse(event.data);
          $("buildStatus").textContent = payload.message || "Running";
          appendBuildLog(payload.command || payload.message || "Build started", "stdout");
        });
        source.addEventListener("log", (event) => {
          const payload = JSON.parse(event.data);
          appendBuildLog(payload.line || "", payload.stream || "stdout");
          if (payload.kind === "warning") $("buildStatus").textContent = "Running with warnings";
        });
        source.addEventListener("summary", (event) => {
          renderBuildSummary(JSON.parse(event.data));
        });
        source.addEventListener("done", async (event) => {
          const payload = JSON.parse(event.data);
          finished = true;
          source.close();
          $("buildStatus").textContent = `${payload.message} (${payload.durationSeconds}s)`;
          appendBuildLog(`returncode: ${payload.returncode}`, "stdout");
          toast(payload.message);
          await loadState(true);
          resolve();
        });
        source.addEventListener("error", (event) => {
          if (finished) return;
          source.close();
          try {
            const payload = event.data ? JSON.parse(event.data) : {};
            reject(new Error(payload.message || "Build stream failed"));
          } catch (error) {
            reject(new Error("Build stream failed"));
          }
        });
      }).finally(() => {
        $("buildBtn").disabled = false;
        $("buildBtn2").disabled = false;
      });
    }

    async function clearBuildCache() {
      const button = $("clearBuildCacheBtn");
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Clearing...";
      try {
        const result = await api("/api/clear-build-cache", {});
        state.thumbnailCacheNonce = String(Date.now());
        await loadState(true);
        toast(result.message || "Build cache cleared.");
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }

    function renderOrphans() {
      renderBuildSettings();
      const orphans = state.orphans;
      const summary = $("orphanSummary");
      const list = $("orphanList");
      const deleteBtn = $("deleteOrphansBtn");
      if (!orphans.scanned) {
        summary.textContent = "Generated JPEGs under assets/generated/ that the current manifest no longer references. Build first, then scan.";
        list.innerHTML = "";
        deleteBtn.disabled = true;
        deleteBtn.textContent = "Delete All";
        return;
      }
      summary.textContent = orphans.message || "";
      const items = orphans.items || [];
      deleteBtn.disabled = orphans.running || items.length === 0;
      deleteBtn.textContent = items.length ? `Delete All (${items.length})` : "Delete All";
      if (!items.length) {
        list.innerHTML = `<div class="empty">${orphans.ready ? "No orphaned files found." : escapeHtml(orphans.message || "Nothing to clean up.")}</div>`;
        return;
      }
      list.innerHTML = items.map((item) => `
        <div class="orphan-row">
          <div class="orphan-info">
            <code>${escapeHtml(item.path)}</code>
            <span class="mini-meta">${escapeHtml(item.category || "")} &middot; ${escapeHtml(item.sizeLabel || "")}</span>
          </div>
          <button class="btn ghost" type="button" data-delete-orphan="${escapeHtml(item.path)}">Delete</button>
        </div>
      `).join("");
    }

    async function findOrphans() {
      const button = $("findOrphansBtn");
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Scanning...";
      try {
        const result = await api("/api/find-orphans", {});
        state.orphans = {
          scanned: true,
          ready: Boolean(result.manifestReady),
          items: result.orphans || [],
          message: result.message || "",
          running: false
        };
        renderOrphans();
        toast(result.message || "Orphan scan complete.");
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }

    async function deleteOrphans(paths) {
      const targets = (paths && paths.length ? paths : (state.orphans.items || []).map((item) => item.path));
      if (!targets.length) {
        toast("No orphaned files to delete.");
        return;
      }
      const many = targets.length > 1;
      const prompt = many
        ? `Delete ${targets.length} orphaned generated file(s)? This cannot be undone.`
        : `Delete this orphaned file?\n${targets[0]}`;
      if (!window.confirm(prompt)) return;
      state.orphans.running = true;
      renderOrphans();
      try {
        const result = await api("/api/delete-orphans", {paths: targets});
        state.thumbnailCacheNonce = String(Date.now());
        toast(result.message || "Deleted orphaned files.");
        await findOrphans();
      } finally {
        state.orphans.running = false;
        renderOrphans();
      }
    }

    function setAssetDrawer(open, restoreFocus = false) {
      state.assetsOpen = Boolean(open);
      document.body.dataset.assetsOpen = String(state.assetsOpen);
      $("toggleAssetsBtn").setAttribute("aria-expanded", String(state.assetsOpen));
      $("assetPanel").setAttribute("aria-hidden", String(!state.assetsOpen));
      $("assetPanel").inert = !state.assetsOpen;
      if (!state.assetsOpen && restoreFocus) $("toggleAssetsBtn").focus();
    }

    function setTab(name) {
      if (!viewMeta[name]) name = "attach";
      state.activeTab = name;
      sessionStorage.setItem("spotterdex-manager.activeTab", name);
      document.body.dataset.activeTab = name;
      document.querySelectorAll(".tab").forEach((button) => {
        const active = button.dataset.tab === name;
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      document.querySelectorAll(".view").forEach((view) => {
        view.classList.toggle("active", view.id === `${name}View`);
      });
      const [title, description] = viewMeta[name];
      $("viewTitle").textContent = title;
      $("viewDescription").textContent = description;
      setAssetDrawer(name === "attach");
      renderActiveView();
    }

    function toast(message) {
      const node = $("toast");
      node.textContent = message;
      node.classList.add("show");
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(() => node.classList.remove("show"), 2800);
    }

    function bindEvents() {
      $("assetSearch").addEventListener("input", renderAssetGrid);
      $("entrySearch").addEventListener("input", renderEntryOptions);
      $("squadronSourceSearch").addEventListener("input", renderSquadronSourceCards);
      $("aircraftSourceSearch").addEventListener("input", renderAircraftSourceCards);
      $("locationDatabaseSearch").addEventListener("input", renderLocationDatabase);
      $("aircraftSettingsSearch").addEventListener("input", renderAircraftSettings);
      $("masterSearch").addEventListener("input", () => { state.masterPage = 1; renderMasterView(); });
      $("missingSearch").addEventListener("input", renderMissingFields);
      $("missingFilter").addEventListener("change", renderMissingFields);
      $("bulkEventSearch").addEventListener("input", renderBulkEvents);
      $("airshowStoryEvent").addEventListener("change", (event) => {
        const nextEventId = event.target.value;
        if (state.airshowStoryDirty && !window.confirm("Discard unsaved segment changes and open another event?")) {
          event.target.value = state.airshowStoryEventId;
          return;
        }
        loadAirshowStoryDraft(nextEventId, true);
        renderAirshowStoryManager();
      });
      $("airshowStoryEnabled").addEventListener("change", (event) => {
        if (!state.airshowStoryDraft) return;
        state.airshowStoryDraft.mode = event.target.checked ? "cinematic" : "standard";
        markAirshowStoryDirty();
        $("resetAirshowStoryBtn").disabled = false;
        $("saveAirshowStoryBtn").disabled = false;
      });
      $("generateAirshowStoryBtn").addEventListener("click", generateAirshowStoryDraft);
      $("addAirshowStoryMomentBtn").addEventListener("click", addAirshowStoryMoment);
      $("resetAirshowStoryBtn").addEventListener("click", () => {
        loadAirshowStoryDraft(state.airshowStoryEventId, true);
        renderAirshowStoryManager();
      });
      $("saveAirshowStoryBtn").addEventListener("click", () => saveAirshowStory().catch((error) => toast(error.message)));
      $("airshowStoryEditor").addEventListener("input", (event) => {
        const field = event.target.closest("[data-story-field]");
        if (field) {
          const segment = state.airshowStoryDraft?.segments?.[Number(field.dataset.storyIndex)];
          if (!segment) return;
          segment[field.dataset.storyField] = field.value;
          markAirshowStoryDirty();
          $("resetAirshowStoryBtn").disabled = false;
          $("saveAirshowStoryBtn").disabled = false;
        }
      });
      $("airshowStoryEditor").addEventListener("change", (event) => {
        const photoSelect = event.target.closest("[data-story-photo]");
        const motionSelect = event.target.closest("[data-story-motion]");
        const overlaySelect = event.target.closest("[data-story-overlay]");
        const supportSelect = event.target.closest("[data-story-support-add]");
        if (photoSelect) {
          const index = Number(photoSelect.dataset.storyPhoto);
          const segment = state.airshowStoryDraft?.segments?.[index];
          const photo = airshowStoryPhotos().find((candidate) => candidate.id === photoSelect.value);
          if (!segment || !photo) return;
          segment.label = formatStoryCaptureLabel(photo.capturedAt || photo.exifDate || photo.date);
          segment.headline = storyPhotoHeadline(photo);
          segment.body = storyPhotoBody(photo);
          const currentSegmentPhotoIndex = (segment.photos || []).findIndex((record) => record.photoId === photo.id);
          if (currentSegmentPhotoIndex > 0) {
            const previousHero = segment.photos[0];
            segment.photos[0] = segment.photos[currentSegmentPhotoIndex];
            segment.photos[currentSegmentPhotoIndex] = previousHero;
          } else if (currentSegmentPhotoIndex < 0) {
            segment.photos = [
              {photoId: photo.id, focalX: 0.5, focalY: 0.5, motion: segment.photos?.[0]?.motion || "auto"},
              ...(segment.photos || []).slice(1)
            ];
          }
          markAirshowStoryDirty();
          renderAirshowStoryManager();
        }
        if (motionSelect) {
          const segment = state.airshowStoryDraft?.segments?.[Number(motionSelect.dataset.storyMotion)];
          if (!segment?.photos?.[0]) return;
          segment.photos[0].motion = motionSelect.value;
          markAirshowStoryDirty();
          $("resetAirshowStoryBtn").disabled = false;
          $("saveAirshowStoryBtn").disabled = false;
        }
        if (overlaySelect) {
          const segment = state.airshowStoryDraft?.segments?.[Number(overlaySelect.dataset.storyOverlay)];
          if (!segment) return;
          segment.overlaySide = overlaySelect.value === "right" ? "right" : "left";
          markAirshowStoryDirty();
          $("resetAirshowStoryBtn").disabled = false;
          $("saveAirshowStoryBtn").disabled = false;
        }
        if (supportSelect?.value) {
          const segment = state.airshowStoryDraft?.segments?.[Number(supportSelect.dataset.storySupportAdd)];
          const usedPhotoIds = new Set((state.airshowStoryDraft?.segments || []).flatMap((item) => (item.photos || []).map((photo) => photo.photoId)));
          const photo = airshowStoryPhotos().find((candidate) => candidate.id === supportSelect.value);
          if (!segment || !photo || usedPhotoIds.has(photo.id)) return;
          segment.photos.push({photoId: photo.id, focalX: 0.5, focalY: 0.5, motion: "auto"});
          markAirshowStoryDirty();
          renderAirshowStoryManager();
        }
      });
      $("airshowStoryPhotoPool").addEventListener("change", (event) => {
        const checkbox = event.target.closest("[data-story-selection]");
        if (!checkbox) return;
        updateAirshowStorySelection(checkbox.dataset.storySelection, checkbox.checked);
      });
      $("airshowStorySelectAllBtn").addEventListener("click", () => {
        airshowStoryPhotos().forEach((photo) => state.airshowStorySelection.add(photo.id));
        renderAirshowStoryManager();
      });
      $("airshowStoryClearSelectionBtn").addEventListener("click", () => {
        state.airshowStorySelection.clear();
        renderAirshowStoryManager();
      });
      $("airshowStoryAssignSelectedBtn").addEventListener("click", () => assignSelectedAirshowPhotos());
      $("airshowStoryMoveSelectedBtn").addEventListener("click", () => assignSelectedAirshowPhotos({moveOnly: true}));
      $("airshowStorySortSelectedBtn").addEventListener("click", sortTargetAirshowPhotos);
      $("airshowStoryDeduplicateBtn").addEventListener("click", removeDuplicateAirshowPhotos);
      $("previewAirshowStoryBtn").addEventListener("click", openAirshowStoryPreview);
      window.addEventListener("message", (event) => {
        if (event.data?.type !== "spotterdex-story-preview-ready") return;
        if (state.airshowPreviewWindow && event.source !== state.airshowPreviewWindow) return;
        sendAirshowStoryPreview();
      });
      $("airshowStoryEditor").addEventListener("click", (event) => {
        const move = event.target.closest("[data-story-move]");
        const remove = event.target.closest("[data-story-remove]");
        const focal = event.target.closest("[data-story-focal]");
        const supportMove = event.target.closest("[data-story-support-move]");
        const supportRemove = event.target.closest("[data-story-support-remove]");
        if (move) {
          const from = Number(move.dataset.storyIndex);
          moveAirshowStoryMoment(from, from + Number(move.dataset.storyMove));
        }
        if (remove) {
          const index = Number(remove.dataset.storyRemove);
          state.airshowStoryDraft?.segments?.splice(index, 1);
          (state.airshowStoryDraft?.segments || []).forEach((segment, segmentIndex) => { segment.position = segmentIndex; });
          markAirshowStoryDirty();
          renderAirshowStoryManager();
        }
        if (supportMove) {
          const segment = state.airshowStoryDraft?.segments?.[Number(supportMove.dataset.storyIndex)];
          const from = Number(supportMove.dataset.storySupportIndex) + 1;
          const to = from + Number(supportMove.dataset.storySupportMove);
          if (!segment || from < 1 || to < 1 || from >= segment.photos.length || to >= segment.photos.length) return;
          const [photo] = segment.photos.splice(from, 1);
          segment.photos.splice(to, 0, photo);
          markAirshowStoryDirty();
          renderAirshowStoryManager();
        }
        if (supportRemove) {
          const segment = state.airshowStoryDraft?.segments?.[Number(supportRemove.dataset.storyIndex)];
          const supportIndex = Number(supportRemove.dataset.storySupportRemove) + 1;
          if (!segment || supportIndex < 1 || supportIndex >= segment.photos.length) return;
          segment.photos.splice(supportIndex, 1);
          markAirshowStoryDirty();
          renderAirshowStoryManager();
        }
        if (focal) {
          const segment = state.airshowStoryDraft?.segments?.[Number(focal.dataset.storyFocal)];
          if (!segment?.photos?.[0]) return;
          const rect = focal.getBoundingClientRect();
          segment.photos[0].focalX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          segment.photos[0].focalY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
          markAirshowStoryDirty();
          renderAirshowStoryManager();
        }
      });
      $("airshowStoryEditor").addEventListener("dragstart", (event) => {
        const card = event.target.closest("[data-story-moment]");
        if (!card) return;
        state.draggedStoryMoment = Number(card.dataset.storyMoment);
        card.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
      });
      $("airshowStoryEditor").addEventListener("dragover", (event) => {
        if (event.target.closest("[data-story-moment]")) event.preventDefault();
      });
      $("airshowStoryEditor").addEventListener("drop", (event) => {
        const card = event.target.closest("[data-story-moment]");
        if (!card) return;
        event.preventDefault();
        moveAirshowStoryMoment(state.draggedStoryMoment, Number(card.dataset.storyMoment));
        state.draggedStoryMoment = -1;
      });
      $("airshowStoryEditor").addEventListener("dragend", () => {
        state.draggedStoryMoment = -1;
        document.querySelectorAll(".airshow-story-moment-card.is-dragging").forEach((card) => card.classList.remove("is-dragging"));
      });
      $("bulkExcludeAiCaptions").addEventListener("change", (event) => {
        state.bulkCaptions.excludeAi = event.target.checked;
        resetBulkCaptionQueue();
        renderBulkCaptions();
      });
      $("entrySelect").addEventListener("change", () => {
        clearBulkSelection("tagged");
        clearEditor();
        renderEntryDetail();
      });
      $("reloadBtn").addEventListener("click", () => loadState(true).then(() => toast("Reloaded")));
      $("createSourceInlineBtn").addEventListener("click", openInlineSourceCreator);
      $("createLocationInlineBtn").addEventListener("click", openInlineLocationCreator);
      $("createEventInlineBtn").addEventListener("click", openInlineEventCreator);
      $("inspectSourceBtn").addEventListener("click", inspectSelectedSource);
      $("inspectLocationBtn").addEventListener("click", inspectSelectedLocation);
      $("inspectEventBtn").addEventListener("click", inspectSelectedEvent);
      $("closeUtilityDrawerBtn").addEventListener("click", closeUtilityDrawer);
      $("utilityScrim").addEventListener("click", closeUtilityDrawer);
      $("utilityDrawerBody").addEventListener("change", (event) => {
        if (event.target.name === "scope") {
          const show = event.target.value === "aircraft";
          $("utilityDrawerBody").querySelectorAll("[data-inline-aircraft]").forEach((field) => { field.hidden = !show; });
        }
        if (event.target.name === "deleteMode") {
          const zone = event.target.closest("[data-entry-delete-zone]");
          const destination = zone?.querySelector("[data-transfer-destination]");
          if (destination) destination.hidden = event.target.value !== "transfer";
        }
      });
      $("utilityDrawerBody").addEventListener("submit", async (event) => {
        const locationForm = event.target.closest("[data-location-edit]");
        if (locationForm) {
          event.preventDefault();
          const submit = locationForm.querySelector("button[type='submit']");
          const values = Object.fromEntries(new FormData(locationForm));
          submit.disabled = true;
          try {
            const result = await api("/api/update-pin", {
              locationId: locationForm.dataset.locationEdit,
              ...values
            });
            await loadState(true);
            closeUtilityDrawer();
            toast(result.message);
          } catch (error) {
            toast(error.message);
          } finally {
            submit.disabled = false;
          }
          return;
        }
        const editForm = event.target.closest("[data-entry-edit]");
        if (editForm) {
          event.preventDefault();
          const submit = editForm.querySelector("button[type='submit']");
          const values = Object.fromEntries(new FormData(editForm));
          submit.disabled = true;
          try {
            const entry = entryByTargetKey(editForm.dataset.entryEdit);
            const result = await api("/api/update-entry", {
              entryPath: editForm.dataset.entryEdit,
              unitId: entry?.unitId || "",
              scope: entry.sourceScope,
              ...values
            });
            await loadState(true);
            closeUtilityDrawer();
            toast(result.message);
          } catch (error) {
            toast(error.message);
          } finally {
            submit.disabled = false;
          }
          return;
        }
        const form = event.target.closest("[data-inline-create]");
        if (!form) return;
        event.preventDefault();
        const submit = form.querySelector("button[type='submit']");
        const values = Object.fromEntries(new FormData(form));
        submit.disabled = true;
        try {
          if (form.dataset.inlineCreate === "source") {
            const result = await api("/api/create-entry", {
              scope: values.scope,
              aircraftType: values.aircraftType || "",
              aircraftFamily: values.aircraftFamily || "",
              squadronName: values.unitName,
              country: values.country,
              unitType: values.unitType
            });
            $("entrySearch").value = "";
            await loadState(true);
            $("entrySelect").value = result.entryPath;
            renderEntryDetail();
            toast(result.message);
          } else if (form.dataset.inlineCreate === "location") {
            const result = await api("/api/create-pin", values);
            await loadState(true);
            const pin = state.data.pins.find((item) => item.id === result.pinId);
            if (pin) $("pinSelect").value = pin.key;
            toast(result.message);
          } else if (form.dataset.inlineCreate === "event") {
            const result = await api("/api/create-event", values);
            await loadState(true);
            $("airshowInput").value = result.name;
            toast(result.message);
          }
          closeUtilityDrawer();
        } catch (error) {
          toast(error.message);
        } finally {
          submit.disabled = false;
        }
      });
      $("utilityDrawerBody").addEventListener("click", async (event) => {
        const button = event.target.closest("[data-delete-entry-confirm]");
        if (!button) return;
        const zone = button.closest("[data-entry-delete-zone]");
        const mode = zone.querySelector("input[name='deleteMode']:checked")?.value;
        const destination = zone.querySelector("[data-delete-destination]")?.value || "";
        if (mode === "transfer" && !destination) return toast("Choose a destination entry.");
        const entry = entryByTargetKey(button.dataset.deleteEntryConfirm);
        const destinationEntry = destination ? entryByTargetKey(destination) : null;
        const action = mode === "transfer"
          ? `transfer all affected photo subjects to ${entryOptionLabel(destinationEntry)}`
          : "remove this source from every affected photo";
        if (!window.confirm(`Delete ${entryOptionLabel(entry)}?\n\nThis will ${action}. Photo records and raw files will remain.`)) return;
        button.disabled = true;
        try {
          const result = await api("/api/delete-entry", {
            entryPath: entry.targetKey,
            mode,
            destinationEntryPath: destination
          });
          await loadState(true);
          closeUtilityDrawer();
          toast(result.message);
        } catch (error) {
          toast(error.message);
          button.disabled = false;
        }
      });
      $("toggleAssetsBtn").addEventListener("click", () => setAssetDrawer(!state.assetsOpen));
      $("closeAssetsBtn").addEventListener("click", () => setAssetDrawer(false, true));
      $("clearBuildCacheBtn").addEventListener("click", () => clearBuildCache().catch((error) => toast(error.message)));
      $("clearSelectionBtn").addEventListener("click", () => {
        state.selectedAssets.clear();
        resetBulkCaptionQueue();
        renderAssetGrid();
        renderSelectedStrip();
        renderBulkCaptions();
      });
      $("clearEditorBtn").addEventListener("click", clearEditor);
      $("attachBtn").addEventListener("click", () => attachSelected().catch((error) => toast(error.message)));
      $("generateAttachCaptionBtn").addEventListener("click", () => generateAttachCaption().catch((error) => toast(error.message)));
      $("savePhotoBtn").addEventListener("click", () => saveEditedPhoto().catch((error) => toast(error.message)));
      $("generateEditCaptionBtn").addEventListener("click", () => generateEditedCaption().catch((error) => toast(error.message)));
      $("createSquadronSourceBtn").addEventListener("click", () => createSquadronSource().catch((error) => toast(error.message)));
      $("createAircraftSourceBtn").addEventListener("click", () => createAircraftSource().catch((error) => toast(error.message)));
      $("createPinBtn").addEventListener("click", () => createPin().catch((error) => toast(error.message)));
      $("refreshBulkCaptionsBtn").addEventListener("click", () => {
        resetBulkCaptionQueue();
        renderBulkCaptions();
      });
      $("runBulkCaptionsBtn").addEventListener("click", () => runBulkCaptions().catch((error) => toast(error.message)));
      $("buildBtn").addEventListener("click", () => runBuild().catch((error) => toast(error.message)));
      $("buildBtn2").addEventListener("click", () => runBuild().catch((error) => toast(error.message)));
      $("backupDatabaseBtn").addEventListener("click", async () => {
        try {
          const result = await api("/api/backup-database", {});
          toast(result.message);
          await loadState(true);
        } catch (error) {
          toast(error.message);
        }
      });
      $("saveBuildSettingsBtn").addEventListener("click", () => {
        saveBuildSettings().catch((error) => toast(error.message));
      });
      $("resetBuildSettingsBtn").addEventListener("click", () => {
        saveBuildSettings(true).catch((error) => toast(error.message));
      });
      $("findOrphansBtn").addEventListener("click", () => findOrphans().catch((error) => toast(error.message)));
      $("deleteOrphansBtn").addEventListener("click", () => deleteOrphans().catch((error) => toast(error.message)));
      $("writeUpType").addEventListener("change", () => renderWriteUpEditor());
      $("writeUpEntity").addEventListener("change", loadSelectedWriteUp);
      $("writeUpMarkdown").addEventListener("input", renderWriteUpPreview);
      $("saveWriteUpBtn").addEventListener("click", () => saveWriteUp());
      $("orphanList").addEventListener("click", (event) => {
        const button = event.target.closest("[data-delete-orphan]");
        if (button) deleteOrphans([button.dataset.deleteOrphan]).catch((error) => toast(error.message));
      });
      $("assetFilter").addEventListener("click", (event) => {
        const button = event.target.closest("button[data-filter]");
        if (!button) return;
        state.assetFilter = button.dataset.filter;
        document.querySelectorAll("#assetFilter button").forEach((node) => node.classList.toggle("active", node === button));
        renderAssetGrid();
      });
      $("assetGrid").addEventListener("click", (event) => {
        const preview = event.target.closest("[data-asset-preview]");
        if (preview) {
          openAssetPreview(preview.dataset.assetPreview);
          return;
        }
        const card = event.target.closest("[data-asset]");
        if (!card) return;
        const path = card.dataset.asset;
        if (state.selectedAssets.has(path)) state.selectedAssets.delete(path);
        else state.selectedAssets.add(path);
        resetBulkCaptionQueue();
        renderAssetGrid();
        renderSelectedStrip();
        renderBulkCaptions();
      });
      $("selectedStrip").addEventListener("click", (event) => {
        const preview = event.target.closest("[data-asset-preview]");
        if (preview) openAssetPreview(preview.dataset.assetPreview);
      });
      $("closeAssetPreviewBtn").addEventListener("click", () => $("assetPreviewModal").close());
      $("assetPreviewModal").addEventListener("click", (event) => {
        if (event.target === $("assetPreviewModal")) $("assetPreviewModal").close();
      });
      $("qualityShowAcknowledged").addEventListener("change", (event) => {
        state.qualityShowAcknowledged = event.target.checked;
        renderQualityControl();
      });
      document.querySelector("[data-quality-setting='empty_space_enabled']").addEventListener("change", () => {
        saveQualitySettings().catch((error) => toast(error.message));
      });
      $("qualityFilters").addEventListener("click", (event) => {
        const button = event.target.closest("[data-quality-filter]");
        if (!button) return;
        state.qualityFilter = button.dataset.qualityFilter;
        renderQualityControl();
      });
      $("qualityPrefixFailures").addEventListener("click", () => {
        markQualityFailures().catch((error) => toast(error.message));
      });
      $("qualityApprovePassed").addEventListener("click", () => {
        approvePassingQc().catch((error) => toast(error.message));
      });
      $("qualityList").addEventListener("click", (event) => {
        const ack = event.target.closest("[data-quality-ack]");
        const unack = event.target.closest("[data-quality-unack]");
        const select = event.target.closest("[data-quality-select]");
        if (ack) {
          acknowledgeQuality(ack.dataset.qualityAck, true).catch((error) => toast(error.message));
          return;
        }
        if (unack) {
          acknowledgeQuality(unack.dataset.qualityUnack, false).catch((error) => toast(error.message));
          return;
        }
        if (!select) return;
        state.selectedAssets.clear();
        state.selectedAssets.add(select.dataset.qualitySelect);
        resetBulkCaptionQueue();
        setTab("attach");
        renderAssetGrid();
        renderSelectedStrip();
        renderBulkCaptions();
        toast("Selected source image for review");
      });
      $("bulkCaptionList").addEventListener("click", (event) => {
        const accept = event.target.closest("[data-bulk-accept]");
        const reject = event.target.closest("[data-bulk-reject]");
        if (accept) acceptBulkCaption(accept.dataset.bulkAccept).catch((error) => toast(error.message));
        if (reject) rejectBulkCaption(reject.dataset.bulkReject);
      });
      $("bulkEventList").addEventListener("click", (event) => {
        const apply = event.target.closest("[data-bulk-event-apply]");
        const clear = event.target.closest("[data-bulk-event-clear]");
        if (apply) applyBulkEvent(apply.dataset.bulkEventApply).catch((error) => toast(error.message));
        if (clear) applyBulkEvent(clear.dataset.bulkEventClear, true).catch((error) => toast(error.message));
      });
      $("airshowHeroList").addEventListener("click", (event) => {
        const photo = event.target.closest("[data-airshow-hero-photo]");
        const clear = event.target.closest("[data-airshow-hero-clear]");
        if (photo) setAirshowHero(photo.dataset.airshowHeroEvent, photo.dataset.airshowHeroPhoto).catch((error) => toast(error.message));
        if (clear) setAirshowHero(clear.dataset.airshowHeroClear).catch((error) => toast(error.message));
      });
      $("locationHeroList").addEventListener("click", (event) => {
        const photo = event.target.closest("[data-location-hero-photo]");
        const clear = event.target.closest("[data-location-hero-clear]");
        const asset = event.target.closest("[data-location-hero-asset]");
        if (photo) setLocationHeroFromPhoto(photo.dataset.locationHeroPin, photo.dataset.locationHeroPhoto).catch((error) => toast(error.message));
        if (clear) clearLocationHero(clear.dataset.locationHeroClear).catch((error) => toast(error.message));
        if (asset) setLocationHero(asset.dataset.locationHeroAsset).catch((error) => toast(error.message));
      });
      $("locationDatabaseList").addEventListener("click", (event) => {
        const edit = event.target.closest("[data-edit-location]");
        if (edit) openLocationEditor(edit.dataset.editLocation);
      });
      $("squadronHeroList").addEventListener("click", (event) => {
        const logo = event.target.closest("[data-unit-logo-save]");
        const photo = event.target.closest("[data-squadron-hero-photo]");
        const clear = event.target.closest("[data-squadron-hero-clear]");
        if (logo) {
          saveUnitLogo(logo.dataset.unitLogoSave, logo).catch((error) => toast(error.message));
          return;
        }
        if (photo) setSquadronHero(photo.dataset.squadronHeroGroup, photo.dataset.squadronHeroPhoto).catch((error) => toast(error.message));
        if (clear) setSquadronHero(clear.dataset.squadronHeroClear).catch((error) => toast(error.message));
      });
      $("aircraftSettingsList").addEventListener("click", (event) => {
        const photo = event.target.closest("[data-aircraft-hero-photo]");
        const clear = event.target.closest("[data-aircraft-hero-clear]");
        const save = event.target.closest("[data-aircraft-settings-save]");
        if (photo) {
          setAircraftHero(photo.dataset.aircraftHeroAircraft, photo.dataset.aircraftHeroPhoto).catch((error) => toast(error.message));
          return;
        }
        if (clear) {
          setAircraftHero(clear.dataset.aircraftHeroClear).catch((error) => toast(error.message));
          return;
        }
        if (save) saveAircraftSettings(save.dataset.aircraftSettingsSave, save).catch((error) => toast(error.message));
      });
      $("airshowMissingImageList").addEventListener("click", (event) => {
        const apply = event.target.closest("[data-airshow-missing-apply]");
        if (apply) applyMissingAirshowImages(apply.dataset.airshowMissingApply).catch((error) => toast(error.message));
      });
      $("photoList").addEventListener("click", (event) => {
        const edit = event.target.closest("[data-edit-photo]");
        const del = event.target.closest("[data-delete-photo]");
        if (edit) fillEditor(Number(edit.dataset.editPhoto));
        if (del) deletePhoto(Number(del.dataset.deletePhoto)).catch((error) => toast(error.message));
      });
      $("photoList").addEventListener("change", (event) => {
        const input = event.target.closest("[data-bulk-select-mode='tagged']");
        if (input) toggleBulkSelection("tagged", input.dataset.bulkSelectKey, input.checked);
      });
      function handleSourceCardClick(event) {
        const edit = event.target.closest("[data-edit-entry]");
        const button = event.target.closest("[data-open-entry]");
        if (edit) {
          openEntryEditor(edit.dataset.editEntry);
          return;
        }
        if (!button) return;
        clearBulkSelection("tagged");
        $("entrySelect").value = button.dataset.openEntry;
        setTab("attach");
        renderEntryDetail();
      }
      $("squadronSourceCards").addEventListener("click", handleSourceCardClick);
      $("aircraftSourceCards").addEventListener("click", handleSourceCardClick);
      $("masterList").addEventListener("click", (event) => {
        const save = event.target.closest("[data-master-save]");
        const detach = event.target.closest("[data-master-detach]");
        if (save) saveMasterPhoto(save.dataset.masterSave, save).catch((error) => toast(error.message));
        if (detach) detachMasterPhoto(detach.dataset.masterDetach).catch((error) => toast(error.message));
      });
      $("masterList").addEventListener("change", (event) => {
        const input = event.target.closest("[data-bulk-select-mode='master']");
        if (input) toggleBulkSelection("master", input.dataset.bulkSelectKey, input.checked);
      });
      $("masterPagination").addEventListener("click", (event) => {
        const button = event.target.closest("[data-master-page]");
        if (!button || button.disabled) return;
        state.masterPage = Number(button.dataset.masterPage) || 1;
        renderMasterView();
        $("masterView").scrollTo({top: 0, behavior: "smooth"});
      });
      $("taggedBulkEditor").addEventListener("click", (event) => {
        const selectAll = event.target.closest("[data-bulk-select-all]");
        const clear = event.target.closest("[data-bulk-clear]");
        const submit = event.target.closest("[data-bulk-submit]");
        if (selectAll) selectAllBulkVisible("tagged");
        if (clear) clearBulkSelection("tagged");
        if (submit) applyBulkEdit("tagged").catch((error) => toast(error.message));
      });
      $("taggedBulkEditor").addEventListener("change", () => updateBulkEditorStatus("tagged"));
      $("masterBulkEditor").addEventListener("click", (event) => {
        const selectAll = event.target.closest("[data-bulk-select-all]");
        const clear = event.target.closest("[data-bulk-clear]");
        const submit = event.target.closest("[data-bulk-submit]");
        if (selectAll) selectAllBulkVisible("master");
        if (clear) clearBulkSelection("master");
        if (submit) applyBulkEdit("master").catch((error) => toast(error.message));
      });
      $("masterBulkEditor").addEventListener("change", () => updateBulkEditorStatus("master"));
      $("missingList").addEventListener("click", (event) => {
        const button = event.target.closest("[data-issue]");
        if (!button) return;
        state.selectedIssueKey = button.dataset.issue;
        renderMissingFields();
      });
      $("missingEditor").addEventListener("click", (event) => {
        if (event.target.closest("#generateMissingCaptionBtn")) {
          generateMissingCaption().catch((error) => toast(error.message));
        }
        if (event.target.closest("#saveMissingPhotoBtn")) {
          saveMissingPhoto().catch((error) => toast(error.message));
        }
        if (event.target.closest("#saveMissingEntryBtn")) {
          saveMissingEntry().catch((error) => toast(error.message));
        }
      });
      document.querySelectorAll(".tab").forEach((button) => {
        button.addEventListener("click", () => setTab(button.dataset.tab));
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && document.body.dataset.utilityOpen === "true") {
          closeUtilityDrawer();
          return;
        }
        if (event.key === "Escape" && state.assetsOpen && !$("assetPreviewModal").open) {
          setAssetDrawer(false, true);
        }
      });
    }

    bindEvents();
    setTab(state.activeTab);
    loadState(false).catch((error) => toast(error.message));
