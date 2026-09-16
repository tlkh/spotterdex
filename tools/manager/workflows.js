/* SpotterDex manager workflow enhancements.
 * Loaded before app.js. The module deliberately keeps all existing IDs and
 * handlers intact; it only adds navigation and presentation affordances.
 */
(function (global) {
  "use strict";

  const workflow = {
    initialized: false,
    attachStage: 1,
    eventSection: "photos",
    eventPhotoLimit: 24,
    catalogDialogs: new Map(),
    eventObserver: null
  };

  const byId = (id) => document.getElementById(id);

  function makeButton(label, className, attrs = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "btn ghost";
    button.textContent = label;
    Object.entries(attrs).forEach(([key, value]) => button.setAttribute(key, value));
    return button;
  }

  function setupAttachWorkflow() {
    const view = byId("attachView");
    if (!view || view.querySelector("[data-workflow-attach-stages]")) return;
    const stages = document.createElement("div");
    stages.className = "workflow-stagebar";
    stages.dataset.workflowAttachStages = "true";
    stages.setAttribute("role", "group");
    stages.setAttribute("aria-label", "Attach workflow");
    stages.innerHTML = `
      <div class="workflow-stage-list">
        <button type="button" class="workflow-stage active" data-attach-stage="1"><span>1</span><strong>Select images</strong></button>
        <button type="button" class="workflow-stage" data-attach-stage="2"><span>2</span><strong>Assign metadata</strong></button>
        <button type="button" class="workflow-stage" data-attach-stage="3"><span>3</span><strong>Review &amp; attach</strong></button>
      </div>
      <div class="workflow-stage-actions">
        <button type="button" class="btn ghost" data-attach-open-assets>Choose images</button>
        <button type="button" class="btn ghost" data-attach-prev disabled>Back</button>
        <button type="button" class="btn secondary" data-attach-next>Continue</button>
      </div>`;
    view.insertBefore(stages, view.firstElementChild);
    stages.addEventListener("click", (event) => {
      const stageButton = event.target.closest("[data-attach-stage]");
      if (stageButton) setAttachStage(Number(stageButton.dataset.attachStage));
      if (event.target.closest("[data-attach-prev]")) setAttachStage(workflow.attachStage - 1);
      if (event.target.closest("[data-attach-next]")) setAttachStage(workflow.attachStage + 1);
      if (event.target.closest("[data-attach-open-assets]")) {
        if (typeof setAssetDrawer === "function") setAssetDrawer(true);
        else byId("toggleAssetsBtn")?.click();
      }
    });
    const assetGrid = byId("assetGrid");
    assetGrid?.addEventListener("click", () => {
      // app.js updates selectedAssets in its own listener; defer one microtask
      // so the stage action reflects the committed selection immediately.
      queueMicrotask(() => setAttachStage(workflow.attachStage));
    });
    view.addEventListener("change", () => setAttachStage(workflow.attachStage));
    setAttachStage(1);
  }

  function setupWorkspaceTitle() {
    // The shell header owns the page title. Keep the first view bar's status
    // text and counts, while removing its repeated heading on wide screens.
    document.querySelectorAll(".view").forEach((view) => {
      const bar = view.querySelector(":scope > .bar");
      const heading = bar?.querySelector(":scope .panel-title");
      if (bar && heading) bar.classList.add("workflow-hide-duplicate-title");
    });
  }

  function setAttachStage(stage) {
    const view = byId("attachView");
    const stages = view?.querySelector("[data-workflow-attach-stages]");
    if (!view || !stages) return;
    workflow.attachStage = Math.max(1, Math.min(3, Number(stage) || 1));
    view.dataset.workflowAttachStage = String(workflow.attachStage);
    stages.querySelectorAll("[data-attach-stage]").forEach((button) => {
      const active = Number(button.dataset.attachStage) === workflow.attachStage;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "step" : "false");
    });
    const previous = stages.querySelector("[data-attach-prev]");
    const next = stages.querySelector("[data-attach-next]");
    if (previous) previous.disabled = workflow.attachStage === 1;
    if (next) {
      const selectedCount = typeof state !== "undefined" && state.selectedAssets ? state.selectedAssets.size : 0;
      next.disabled = workflow.attachStage === 3 || selectedCount === 0 || (workflow.attachStage === 2 && (!byId("entrySelect")?.value || !byId("pinSelect")?.value));
      next.textContent = workflow.attachStage === 2 ? "Review selection" : "Continue";
    }
    // The raw asset drawer is the source picker. Keep the form and selected
    // strip mounted so drafts and app.js event listeners survive each stage.
    view.querySelectorAll(":scope > .form-grid, :scope > .selected-strip").forEach((node) => {
      node.dataset.workflowStageVisible = node.classList.contains("selected-strip") ? "3" : "2";
    });
    const summaryBar = byId("attachBtn")?.closest(".bar");
    if (summaryBar) summaryBar.dataset.workflowStageVisible = "3";
    let review = byId("workflowAttachReview");
    if (!review) { review = document.createElement("div"); review.id = "workflowAttachReview"; review.className = "workflow-review"; review.dataset.workflowStageVisible = "3"; view.insertBefore(review, summaryBar); }
    if (typeof state !== "undefined" && state.data) {
      const selectedText = id => byId(id)?.selectedOptions?.[0]?.textContent || "Not selected";
      review.textContent = `${state.selectedAssets.size} images · ${selectedText("entrySelect")} · ${selectedText("pinSelect")} · Event: ${byId("airshowInput")?.value || "None"} · Date fallback: ${byId("photoDate")?.value || "None"} · Shared caption: ${byId("captionInput")?.value || "None"}`;
    }
  }

  function setupCatalogDialog(viewId, title, createHeading) {
    const view = byId(viewId);
    if (!view || workflow.catalogDialogs.has(viewId)) return;
    const split = view.querySelector(":scope > .split");
    const createSection = split?.querySelector(":scope > .section");
    if (!split || !createSection) return;
    const dialog = document.createElement("dialog");
    dialog.className = "workflow-create-dialog";
    dialog.setAttribute("aria-labelledby", `${viewId}-create-title`);
    const head = document.createElement("div");
    head.className = "workflow-dialog-head";
    head.innerHTML = `<div><div class="subtle">Create record</div><h2 id="${viewId}-create-title">${title}</h2></div>`;
    const close = makeButton("Close", "btn ghost", {"data-workflow-close": "true"});
    head.append(close);
    dialog.append(head);
    const status = document.createElement("p"); status.className = "workflow-status"; status.setAttribute("role", "status"); head.after(status); dialog.append(status);
    createSection.classList.add("workflow-create-form");
    dialog.append(createSection);
    document.body.append(dialog);
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => { open.focus(); });
    const toolbar = document.createElement("div");
    toolbar.className = "bar workflow-browse-toolbar";
    toolbar.innerHTML = `<div><h2 class="panel-title">${createHeading || title}</h2><div class="subtle">Browse existing records and open one to inspect or edit.</div></div>`;
    const open = makeButton("New", "btn primary", {"data-workflow-open-create": viewId});
    open.setAttribute("aria-label", `Create ${title}`);
    toolbar.append(open);
    view.insertBefore(toolbar, split);
    open.addEventListener("click", () => {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      if (typeof restoreManagerForms === "function") restoreManagerForms();
      dialog.querySelector("input, select, textarea, button:not([data-workflow-close])")?.focus();
    });
    workflow.catalogDialogs.set(viewId, dialog);
  }

  function setupCatalogWorkflows() {
    setupCatalogDialog("aircraft-databaseView", "Aircraft record", "Aircraft");
    setupCatalogDialog("squadron-databaseView", "Unit record", "Units");
    setupCatalogDialog("locations-databaseView", "Location", "Locations");
  }

  function setupEventsWorkflow() {
    const view = byId("airshowsView");
    if (!view || view.querySelector("[data-workflow-event-nav]")) return;
    const storyField = byId("airshowStoryEvent")?.closest(".field");
    const topBar = view.querySelector(":scope > .bar");
    if (storyField && topBar) {
      storyField.classList.add("workflow-event-picker");
      topBar.append(storyField);
    }
    const nav = document.createElement("div");
    nav.className = "workflow-event-nav";
    nav.dataset.workflowEventNav = "true";
    nav.setAttribute("role", "group");
    nav.setAttribute("aria-label", "Event sections");
    [
      ["photos", "Photos"],
      ["presentation", "Presentation"],
      ["segments", "Segments"]
    ].forEach(([value, label]) => {
      const button = makeButton(label, "workflow-event-tab", {"data-event-section": value, "aria-pressed": "false"});
      nav.append(button);
    });
    view.insertBefore(nav, view.querySelector(":scope > .airshow-management-section"));
    nav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-event-section]");
      if (button) setEventSection(button.dataset.eventSection);
    });
    const sections = [...view.querySelectorAll(":scope > .airshow-management-section")];
    sections.forEach((section, index) => {
      const key = index === 0 ? "segments" : index === 1 ? "presentation" : "photos";
      section.dataset.workflowEventSection = key;
      section.id = section.id || `airshow-workflow-${key}`;
      nav.querySelector(`[data-event-section="${key}"]`)?.setAttribute("aria-controls", section.id);
    });
    const dates = view.querySelector("[aria-labelledby='allAirshowDatesHeading']");
    if (dates && !dates.closest("details")) {
      const details = document.createElement("details");
      details.className = "workflow-secondary-disclosure";
      details.open = false;
      const summary = document.createElement("summary");
      summary.textContent = "Find unassigned photos by date";
      details.append(summary);
      dates.parentNode.insertBefore(details, dates);
      details.append(dates);
      const overview=byId("bulkEventSummary"); if(overview) dates.prepend(overview);
    }
    const select = byId("airshowStoryEvent");
    select?.addEventListener("change", () => { workflow.eventPhotoLimit=24; syncEventScope(); });
    const photoSection=document.createElement("section"); photoSection.id="workflowEventPhotos"; photoSection.dataset.workflowEventSection="photos"; photoSection.className="airshow-management-section";
    nav.after(photoSection);
    nav.querySelector('[data-event-section="photos"]')?.setAttribute("aria-controls", "workflowEventPhotos airshow-workflow-photos");
    photoSection.addEventListener("click",event => {const open=event.target.closest("[data-event-photo-open]"); if(open && typeof openLibraryEditor === "function")openLibraryEditor(open.dataset.eventPhotoOpen,open);if(event.target.closest("[data-event-photos-more]")){workflow.eventPhotoLimit+=24;syncEventScope();}});
    setEventSection("photos");
    syncEventScope();
    observeEventLists();
  }

  function setEventSection(section) {
    workflow.eventSection = ["photos", "presentation", "segments"].includes(section) ? section : "photos";
    const view = byId("airshowsView");
    view?.querySelectorAll("[data-event-section]").forEach((button) => {
      const active = button.dataset.eventSection === workflow.eventSection;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    view?.querySelectorAll("[data-workflow-event-section]").forEach((section) => {
      const visible = section.dataset.workflowEventSection === workflow.eventSection;
      section.hidden = !visible;
      section.setAttribute("aria-hidden", visible ? "false" : "true");
    });
    const dates = view?.querySelector("[aria-labelledby='allAirshowDatesHeading']")?.closest("details");
    if (dates) dates.hidden = workflow.eventSection !== "photos";
    syncEventScope();
  }

  function syncEventScope() {
    const selector = byId("airshowStoryEvent");
    const selected = selector?.value || "";
    const selectedName = selected && typeof state !== "undefined" ? (state.data?.airshowEvents?.find(e=>e.id===selected)?.name || "") : "";
    const view = byId("airshowsView");
    if (view) {
      view.dataset.workflowEvent = selected;
      view.dataset.workflowEventName = selectedName;
    }
    const photoSection=byId("workflowEventPhotos");
    if(photoSection && typeof state !== "undefined" && state.data) {
      const photos=(state.data.masterPhotos || []).filter(p=>p.eventId===selected);
      const esc=typeof escapeHtml === "function" ? escapeHtml : value=>String(value);
      photoSection.innerHTML=`<div class="bar"><h3>Event photos</h3><span class="subtle">${photos.length} assigned</span></div><div class="workflow-event-grid">${photos.slice(0,workflow.eventPhotoLimit).map(p=>`<button class="library-image" type="button" data-event-photo-open="${esc(p.id)}" aria-label="Edit ${esc(p.path)}"><img loading="lazy" src="${thumbUrl(p.sourceAssetPath)}" alt="${esc(masterSubjectLabel(p))}"></button>`).join("")}</div>${!photos.length?'<p class="subtle">No photos assigned. Select photos in the Photo library and choose Assign event.</p>':''}${photos.length>workflow.eventPhotoLimit?'<button class="btn ghost" type="button" data-event-photos-more>Show more photos</button>':''}`;
    }
    ["airshowHeroList", "airshowMissingImageList", "bulkEventList"].forEach((id) => {
      const list = byId(id);
      if (!list) return;
      list.querySelectorAll(".airshow-hero-card, .group-hero-card, .bulk-event-date-card").forEach((card) => {
        const heading = card.querySelector("h3")?.textContent?.trim() || "";
        card.dataset.workflowEventName = heading;
        // Presentation is event-scoped; the other photo tools intentionally
        // retain their complete date/event queues for cross-event review.
        if ((card.classList.contains("airshow-hero-card") || id === "airshowHeroList")) {
          card.hidden = workflow.eventSection === "presentation" && Boolean(selectedName) && heading !== selectedName;
        }
      });
    });
  }

  function observeEventLists() {
    if (workflow.eventObserver) return;
    const targets = [byId("airshowHeroList"), byId("airshowMissingImageList"), byId("bulkEventList")].filter(Boolean);
    if (!targets.length || typeof MutationObserver === "undefined") return;
    workflow.eventObserver = new MutationObserver(syncEventScope);
    targets.forEach((target) => workflow.eventObserver.observe(target, {childList: true, subtree: true}));
  }

  function setupBuildWorkflow() {
    const view = byId("buildView");
    if (!view || view.querySelector("[data-workflow-build-disclosure]")) return;
    const settings = view.querySelector(".build-settings");
    if (settings && !settings.closest("details")) {
      const details = document.createElement("details");
      details.className = "workflow-secondary-disclosure";
      details.dataset.workflowBuildDisclosure = "settings";
      const summary = document.createElement("summary");
      summary.textContent = "Image build settings";
      details.append(summary);
      settings.parentNode.insertBefore(details, settings);
      details.append(settings);
    }
    const log = byId("buildLog");
    if (log && !log.closest("details")) {
      const details = document.createElement("details");
      details.className = "workflow-secondary-disclosure workflow-build-log";
      details.dataset.workflowBuildDisclosure = "log";
      const summary = document.createElement("summary");
      summary.textContent = "Build log";
      details.append(summary);
      log.parentNode.insertBefore(details, log);
      details.append(log);
    }
    if (!byId("workflowBuildTools")) {
      const tools=document.createElement("details");tools.id="workflowBuildTools";tools.className="workflow-secondary-disclosure";tools.innerHTML='<summary>Backup and maintenance</summary><div class="card-actions"></div>';
      for(const id of ["backupDatabaseBtn","clearBuildCacheBtn"]) {const button=byId(id);if(button)tools.lastElementChild.append(button);}
      view.append(tools);
    }
    const orphans = view.querySelector(".orphan-section");
    if (orphans && !orphans.closest("details")) {
      const details = document.createElement("details");
      details.className = "workflow-secondary-disclosure";
      details.dataset.workflowBuildDisclosure = "orphans";
      const summary = document.createElement("summary");
      summary.textContent = "Find and clean orphaned generated files";
      details.append(summary);
      orphans.parentNode.insertBefore(details, orphans);
      details.append(orphans);
    }
  }

  function initializeManagerWorkflows() {
    if (workflow.initialized) return;
    workflow.initialized = true;
    setupWorkspaceTitle();
    setupAttachWorkflow();
    setupCatalogWorkflows();
    setupEventsWorkflow();
    setupBuildWorkflow();
  }

  function renderManagerWorkflows() {
    if (!workflow.initialized) initializeManagerWorkflows();
    setAttachStage(workflow.attachStage);
    syncEventScope();
  }

  global.initializeManagerWorkflows = initializeManagerWorkflows;
  global.renderManagerWorkflows = renderManagerWorkflows;
})(window);
