    const $ = (id) => document.getElementById(id);
    const state = {
      data: null,
      selectedAssets: new Set(),
      selectedIssueKey: "",
      assetFilter: "untagged",
      activeTab: "attach",
      qualityShowAcknowledged: false,
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
      }
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
      renderAll();
    }

    function renderAll() {
      renderStats();
      renderAssetGrid();
      renderEntryOptions();
      renderEditTagTargetOptions();
      renderPinOptions();
      renderSelectedStrip();
      renderEntryDetail();
      renderEntryCards();
      renderLocationHeroManager();
      renderSquadronHeroManager();
      renderMissingFields();
      renderQualityControl();
      renderBulkCaptions();
      renderBulkEvents();
    }

    function renderStats() {
      const project = state.data.project;
      $("projectRoot").textContent = project.root;
      $("stats").innerHTML = [
        ["Assets", project.assetCount],
        ["New", project.untaggedAssetCount],
        ["Used", project.taggedAssetCount],
        ["Aircraft", project.aircraftCount],
        ["Squadrons", project.squadronEntryCount || 0],
        ["Locations", project.locationEntryCount || 0],
        ["Pins", project.pinCount],
        ["Missing", project.missingPhotoCount],
        ["Fields", (project.missingFieldPhotoCount || 0) + (project.missingEntryFieldCount || 0)],
        ["<2560px", project.underResolutionAssetCount || 0],
        ["Exposure", project.exposureIssueAssetCount || 0],
        ["Colour", project.colourBalanceIssueAssetCount || 0]
      ].map(([label, value]) => `<span class="pill">${label} <strong>${value}</strong></span>`).join("");
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

      $("assetGrid").innerHTML = assets.map((asset) => {
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
          <button class="asset-card${selected}" type="button" data-asset="${escapeHtml(asset.path)}" title="${escapeHtml(title)}">
            <img src="${thumbUrl(asset.path)}" loading="lazy" alt="${escapeHtml(asset.name)}">
            <div class="asset-name">${escapeHtml(asset.name)}</div>
            <div class="asset-meta"><span class="asset-size">${escapeHtml(asset.sizeLabel)}</span>${resolutionTag}${qualityTags}${tag}</div>
          </button>
        `;
      }).join("");
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
      push("Acutance", asset.acutance);
      if (asset.iso) push("ISO", asset.iso);
      return chips.join("");
    }

    function renderQualityControl() {
      const flagged = (state.data?.assets || []).filter((asset) => (
        asset.isPhotoSource && (asset.isUnderResolution || (asset.qualityFlags || []).length)
      ));
      const showAcknowledged = state.qualityShowAcknowledged;
      const assets = flagged.filter((asset) => showAcknowledged || !asset.qualityAcknowledged);
      const allPhotoSources = (state.data?.assets || []).filter((asset) => asset.isPhotoSource);
      const project = state.data?.project || {};
      const minimum = project.minimumSourcePhotoWidth || 2560;
      const belowMinimum = project.underResolutionAssetCount || 0;
      const exposure = project.exposureIssueAssetCount || 0;
      const colour = project.colourBalanceIssueAssetCount || 0;
      const acknowledged = project.acknowledgedQualityCount || 0;
      $("qualityShowAcknowledged").checked = showAcknowledged;
      $("qualitySummary").textContent = `${flagged.length} of ${allPhotoSources.length} source photograph(s) flagged: ${belowMinimum} below ${minimum}px, ${exposure} exposure, ${colour} colour. ${acknowledged} marked reviewed.`;
      if (!assets.length) {
        const done = acknowledged && !showAcknowledged
          ? `All ${acknowledged} flagged source photograph(s) have been reviewed. Enable "Show reviewed" to see them.`
          : `All source photographs meet the ${minimum}px requirement with no quality warnings.`;
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
          const associations = asset.tags.length
            ? asset.tags.map((tag) => `${tag.kind}: ${tag.label || tag.path || "Source"}`).join(" · ")
            : "New raw asset";
          const chips = [];
          if (asset.isUnderResolution) {
            chips.push(`<span class="tag warn">${escapeHtml(asset.dimensionsLabel)} - below ${minimum}px</span>`);
          }
          for (const flag of asset.qualityFlags || []) {
            const cls = flag.severity === "info" ? "tag info" : "tag warn";
            chips.push(`<span class="${cls}">${escapeHtml(flag.detail || flag.label || "Quality warning")}</span>`);
          }
          const ackClass = asset.qualityAcknowledged ? " acknowledged" : "";
          const ackButton = asset.qualityAcknowledged
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

    function renderSelectedStrip() {
      const selected = [...state.selectedAssets];
      $("selectedStrip").innerHTML = selected.length
        ? selected.map((path) => `<img src="${thumbUrl(path)}" alt="${escapeHtml(path)}" title="${escapeHtml(path)}">`).join("")
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
      let selectedPhotoCount = 0;
      let aiExcludedCount = 0;
      let missingCaptionCount = 0;
      for (const entry of state.data?.entries || []) {
        for (const photo of entry.photos || []) {
          if (photo.invalid || !photo.exists || !photo.sourceAssetPath || !state.selectedAssets.has(photo.sourceAssetPath)) continue;
          selectedPhotoCount += 1;
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
      return {candidates, selectedPhotoCount, aiExcludedCount, missingCaptionCount};
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
      const selectedLabel = `${state.selectedAssets.size} selected source image(s), ${selection.candidates.length} eligible human-written caption(s)`;
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
        $("bulkCaptionList").innerHTML = `<div class="empty">Select one or more existing raw photo assets with human-written captions, then return here to create a review queue.</div>`;
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
              <details>
                <summary class="mini-meta">Current caption</summary>
                <div class="mini-meta" style="margin-top: 6px;">${escapeHtml(photo.caption || "")}</div>
              </details>
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
        throw new Error("Select existing images with eligible human-written captions first.");
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
      renderEntryDetail();
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

    function renderEntryDetail() {
      const entry = selectedEntry();
      if (!entry) {
        $("entrySummary").textContent = "";
        $("photoList").innerHTML = `<div class="empty">No entry selected</div>`;
        $("pinSelect").disabled = false;
        $("editLocation").disabled = false;
        return;
      }
      if (entry.sourceScope === "squadron-target") {
        $("entrySummary").textContent = `Squadron-only tag: ${entry.squadronName} (${entry.country}). The manager will create or reuse squadrons/${entry.squadronName} without an aircraft type.`;
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
          return `<article class="photo-card"><div class="missing">Invalid YAML item</div><div class="mini-meta">${escapeHtml(photo.raw)}</div></article>`;
        }
        const media = photo.exists && photo.sourceAssetPath
          ? `<img src="${thumbUrl(photo.sourceAssetPath)}" loading="lazy" alt="${escapeHtml(photo.path)}">`
          : `<div class="missing">Missing source</div>`;
        const location = photo.location || photo.pinId || "No location";
        const airshow = photo.airshow ? `<br>Airshow: ${escapeHtml(photo.airshow)}` : "";
        const livery = photo.livery ? `<br>Livery: ${escapeHtml(photo.livery)}` : "";
        return `
          <article class="photo-card">
            ${media}
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

    function renderEntryCards() {
      const term = $("entryListSearch").value.trim().toLowerCase();
      const entries = (state.data.entries || []).filter((entry) => {
        if (!term) return true;
        return [entry.aircraftType, entry.squadronName, entry.country, entry.entryPath].join(" ").toLowerCase().includes(term);
      });
      $("entryCards").innerHTML = entries.map((entry) => `
        <article class="photo-card">
          <div class="mini-title">${escapeHtml(entryOptionLabel(entry))}</div>
          <div class="mini-meta">${escapeHtml(entry.entryPath)}</div>
          <div class="card-actions">
            <button class="btn ghost" type="button" data-open-entry="${escapeHtml(entry.targetKey)}">Open</button>
          </div>
        </article>
      `).join("") || `<div class="empty">No matching entries</div>`;
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
      // Keep location-scoped YAML photos at the front of their own picker. This
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
        const picker = photos.length
          ? `<div class="group-hero-picker">${photos.map(({entry, photo}) => {
              const available = Boolean(photo.exists && photo.sourceAssetPath);
              const selectable = Boolean(available && !photo.customHero);
              const selected = Boolean(photo.customHero || (hero.entryTargetKey === entry.targetKey && hero.assetPath === photo.sourceAssetPath));
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
            ${picker}
          </article>
        `;
      }).join("");
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
      $("missingEditor").innerHTML = `
        <div class="form-grid">
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
          </div>
          <div class="field wide">
            <label for="missingEntrySquadronName">Unit Name</label>
            <input id="missingEntrySquadronName" type="text" value="${escapeHtml(issue.entry.squadronName || "")}">
          </div>
          <div class="field wide">
            <label for="missingEntrySquadronLogo">Squadron Logo</label>
            <input id="missingEntrySquadronLogo" type="text" value="${escapeHtml(issue.entry.squadronLogo || "")}" placeholder="logo.png or ../../../assets/logos/unit.svg">
          </div>
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
      const result = await api("/api/update-entry", {
        entryPath: issue.entry.entryPath,
        scope: issue.entry.sourceScope,
        aircraftType: $("missingEntryAircraftType").value,
        aircraftFamily: $("missingEntryAircraftFamily").value,
        squadronName: $("missingEntrySquadronName").value,
        squadronLogo: $("missingEntrySquadronLogo").value,
        country: $("missingEntryCountry").value,
        unitType: $("missingEntryUnitType").value
      });
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

    async function createEntry() {
      const result = await api("/api/create-entry", {
        scope: $("newEntryScope").value,
        aircraftType: $("newAircraftType").value,
        squadronName: $("newSquadronName").value,
        country: $("newCountry").value,
        unitType: $("newUnitType").value
      });
      toast(result.message);
      $("newAircraftType").value = "";
      $("newSquadronName").value = "";
      await loadState(false);
      $("entrySelect").value = result.entryPath;
      setTab("attach");
      renderEntryDetail();
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
        const source = new EventSource(`/api/build-stream?nonce=${Date.now()}`);

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

    function setTab(name) {
      state.activeTab = name;
      document.querySelectorAll(".tab").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === name);
      });
      document.querySelectorAll(".view").forEach((view) => {
        view.classList.toggle("active", view.id === `${name}View`);
      });
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
      $("entryListSearch").addEventListener("input", renderEntryCards);
      $("missingSearch").addEventListener("input", renderMissingFields);
      $("missingFilter").addEventListener("change", renderMissingFields);
      $("bulkEventSearch").addEventListener("input", renderBulkEvents);
      $("bulkExcludeAiCaptions").addEventListener("change", (event) => {
        state.bulkCaptions.excludeAi = event.target.checked;
        resetBulkCaptionQueue();
        renderBulkCaptions();
      });
      $("entrySelect").addEventListener("change", () => {
        clearEditor();
        renderEntryDetail();
      });
      $("reloadBtn").addEventListener("click", () => loadState(true).then(() => toast("Reloaded")));
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
      $("createEntryBtn").addEventListener("click", () => createEntry().catch((error) => toast(error.message)));
      $("createPinBtn").addEventListener("click", () => createPin().catch((error) => toast(error.message)));
      $("refreshBulkCaptionsBtn").addEventListener("click", () => {
        resetBulkCaptionQueue();
        renderBulkCaptions();
      });
      $("runBulkCaptionsBtn").addEventListener("click", () => runBulkCaptions().catch((error) => toast(error.message)));
      $("buildBtn").addEventListener("click", () => runBuild().catch((error) => toast(error.message)));
      $("buildBtn2").addEventListener("click", () => runBuild().catch((error) => toast(error.message)));
      $("findOrphansBtn").addEventListener("click", () => findOrphans().catch((error) => toast(error.message)));
      $("deleteOrphansBtn").addEventListener("click", () => deleteOrphans().catch((error) => toast(error.message)));
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
      $("qualityShowAcknowledged").addEventListener("change", (event) => {
        state.qualityShowAcknowledged = event.target.checked;
        renderQualityControl();
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
      $("squadronHeroList").addEventListener("click", (event) => {
        const photo = event.target.closest("[data-squadron-hero-photo]");
        const clear = event.target.closest("[data-squadron-hero-clear]");
        if (photo) setSquadronHero(photo.dataset.squadronHeroGroup, photo.dataset.squadronHeroPhoto).catch((error) => toast(error.message));
        if (clear) setSquadronHero(clear.dataset.squadronHeroClear).catch((error) => toast(error.message));
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
      $("entryCards").addEventListener("click", (event) => {
        const button = event.target.closest("[data-open-entry]");
        if (!button) return;
        $("entrySelect").value = button.dataset.openEntry;
        setTab("attach");
        renderEntryDetail();
      });
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
    }

    bindEvents();
    loadState(false).catch((error) => toast(error.message));
