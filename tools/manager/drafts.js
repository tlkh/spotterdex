/*
 * Durable, local-only draft recovery for the manager.
 *
 * This file intentionally has no dependency on app.js globals.  app.js should
 * call SpotterDexDrafts.configure({state, ...}) after its state object exists
 * and call restore()/capture* hooks around renders and edits.  Keeping storage
 * here means a reload never silently saves a draft to the catalog.
 */
(function attachDraftStore(global) {
  "use strict";

  const STORAGE_PREFIX = "spotterdex.manager.drafts.v1:";
  const SCHEMA_VERSION = 1;
  let options = {};
  let repository = "unknown";
  let storage = null;
  let loaded = false;
  let savedSnapshot = null;
  let dirty = false;
  let saveTimer = null;
  let storageAvailable = true;

  const fallbackStorage = {
    getItem() { return null; },
    setItem() { throw new Error("localStorage unavailable"); },
    removeItem() {}
  };

  function safeStorage(candidate) {
    if (!candidate) return fallbackStorage;
    try {
      const probe = `${STORAGE_PREFIX}probe`;
      candidate.setItem(probe, "1");
      candidate.removeItem(probe);
      return candidate;
    } catch (_) {
      storageAvailable = false;
      return fallbackStorage;
    }
  }

  function repositoryId(state, explicit) {
    if (explicit) return String(explicit);
    const project = state?.data?.project || state?.project || {};
    const root = String(project.root || project.path || "").trim();
    const database = String(project.databasePath || "").trim();
    if (root && database) return `${root}::${database}`;
    return database || root || String(project.name || "unknown");
  }

  function keyFor(repo) {
    return `${STORAGE_PREFIX}${encodeURIComponent(repo)}`;
  }

  function clone(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  function setState(next) {
    options = next || {};
    const state = options.state;
    repository = repositoryId(state, options.repository);
    let candidate = options.storage;
    if (!candidate) {
      try { candidate = global.localStorage; } catch (_) { candidate = null; }
    }
    storage = safeStorage(candidate);
    loaded = false;
    savedSnapshot = null;
    dirty = false;
    return store;
  }

  function readStored() {
    if (loaded) return savedSnapshot;
    loaded = true;
    try {
      const raw = storage.getItem(keyFor(repository));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || parsed.repository !== repository) return null;
      savedSnapshot = parsed;
      return savedSnapshot;
    } catch (_) {
      // Corrupt or denied storage must never prevent the manager loading.
      return null;
    }
  }

  function normalizeCaptionState(captions) {
    if (!captions || typeof captions !== "object") return null;
    const next = clone(captions) || {};
    next.queue = Array.isArray(next.queue) ? next.queue : null;
    next.results = next.results && typeof next.results === "object" ? next.results : {};
    next.running = false;
    next.stopRequested = false;
    for (const result of Object.values(next.results)) {
      if (!result || typeof result !== "object") continue;
      if (result.status === "generating") {
        result.status = "error";
        result.message = "Caption generation was interrupted. Retry this item when ready.";
      } else if (result.status === "saving") {
        result.status = "proposed";
        result.message = "Save completion is unknown after reload. Verify the catalog before accepting again.";
      }
    }
    return next;
  }

  function applySnapshot(state, saved) {
    if (!state) return {restored: false, reason: "missing-state"};
    if (!saved) return {restored: false};
    let restoredCount = 0;
    if (state.masterDrafts && typeof state.masterDrafts.set === "function" && Array.isArray(saved.master)) {
      for (const item of saved.master) {
        if (!item || !item.id || !item.draft) continue;
        state.masterDrafts.set(String(item.id), clone(item.draft));
        restoredCount += 1;
      }
    }
    const captionState = normalizeCaptionState(saved.captions);
    if (captionState && state.bulkCaptions) {
      Object.assign(state.bulkCaptions, captionState);
      restoredCount += captionState.queue?.length || Object.keys(captionState.results).length ? 1 : 0;
    }
    const stories = saved.airshowStories || {};
    state.__managerAirshowStoryDrafts = clone(stories) || {};
    const legacyStory = saved.airshowStory;
    const story = stories[String(state.airshowStoryEventId || "")]
      || (Object.keys(stories).length === 1 ? stories[Object.keys(stories)[0]] : null)
      || legacyStory;
    if (story && state) {
      if (story.eventId) state.airshowStoryEventId = String(story.eventId);
      state.airshowStoryDraft = clone(story.draft);
      state.airshowStoryDirty = Boolean(story.dirty && state.airshowStoryDraft);
      restoredCount += state.airshowStoryDirty ? 1 : 0;
    }
    if (saved.forms && typeof saved.forms === "object") {
      state.__managerDraftForms = clone(saved.forms) || {};
      restoredCount += Object.keys(state.__managerDraftForms).length;
    }
    dirty = restoredCount > 0;
    return {restored: restoredCount > 0, count: restoredCount};
  }

  function restore(state = options.state) {
    if (!state) return {restored: false, reason: "missing-state"};
    if (!storage) {
      repository = repositoryId(state, options.repository);
      let candidate = options.storage;
      if (!candidate) { try { candidate = global.localStorage; } catch (_) { candidate = null; } }
      storage = safeStorage(candidate);
    }
    return applySnapshot(state, readStored());
  }

  function readFormValues(form) {
    if (!form) return {};
    const values = {};
    form.querySelectorAll("input, select, textarea").forEach((field) => {
      if (!field.name && !field.id) return;
      const name = field.name || field.id;
      if (field.type === "radio") { if (field.checked) values[name] = field.value; }
      else if (field.type === "checkbox") values[name] = field.checked;
      else values[name] = field.value;
    });
    return values;
  }

  function applyFormValues(form, values) {
    if (!form || !values || typeof values !== "object") return;
    form.querySelectorAll("input, select, textarea").forEach((field) => {
      const name = field.name || field.id;
      if (!name || !(name in values)) return;
      if (field.type === "radio") field.checked = field.value === values[name];
      else if (field.type === "checkbox") field.checked = Boolean(values[name]);
      else field.value = values[name] ?? "";
    });
  }

  function captureForm(formOrKey, values, meta = {}, stateArg = options.state) {
    const key = typeof formOrKey === "string"
      ? formOrKey
      : formOrKey?.dataset?.draftKey || formOrKey?.id;
    if (!key) return false;
    const payload = values && typeof values === "object" && !values.target
      ? clone(values)
      : readFormValues(formOrKey);
    if (!payload) return false;
    const state = stateArg;
    if (!state) return false;
    state.__managerDraftForms = state.__managerDraftForms || {};
    state.__managerDraftForms[String(key)] = {values: payload, meta: clone(meta) || {}};
    dirty = true;
    schedulePersist();
    return true;
  }

  function restoreForms(root = global.document, state = options.state) {
    const forms = state?.__managerDraftForms;
    if (!forms || !root?.querySelectorAll) return 0;
    let count = 0;
    root.querySelectorAll("form[data-draft-key], [data-draft-key]").forEach((form) => {
      const item = forms[form.dataset.draftKey];
      if (item) { applyFormValues(form, item.values); count += 1; }
    });
    return count;
  }

  function restoreWriteUp(element, state, entityType, entityId) {
    const item = state?.__managerDraftForms?.[`writeup:${String(entityType)}:${String(entityId)}`];
    if (!item || !element) return false;
    element.value = item.values?.markdown ?? "";
    return true;
  }

  function captureMaster(state, photoId, draft) {
    if (!state?.masterDrafts || photoId == null || !draft) return false;
    state.masterDrafts.set(String(photoId), clone(draft));
    dirty = true;
    schedulePersist();
    return true;
  }

  function captureCaptions(state = options.state) {
    if (!state?.bulkCaptions) return false;
    dirty = true;
    schedulePersist();
    return true;
  }

  function captureCaptionProposal(state, key, caption) {
    if (!state?.bulkCaptions?.results || key == null) return false;
    const result = state.bulkCaptions.results[key];
    if (!result || !["proposed", "saving"].includes(result.status)) return false;
    result.caption = String(caption ?? "");
    if (result.status === "saving") result.status = "proposed";
    result.message = "";
    return captureCaptions(state);
  }

  function captureStory(state = options.state) {
    if (!state) return false;
    state.__managerAirshowStoryDrafts = state.__managerAirshowStoryDrafts || {};
    const eventId = String(state.airshowStoryEventId || "");
    if (eventId && state.airshowStoryDraft && state.airshowStoryDirty) {
      state.__managerAirshowStoryDrafts[eventId] = {
        eventId,
        draft: clone(state.airshowStoryDraft),
        dirty: Boolean(state.airshowStoryDirty)
      };
    }
    dirty = true;
    schedulePersist();
    return true;
  }

  function captureWriteUp(state, entityType, entityId, markdown) {
    if (!state || !entityType || !entityId) return false;
    return captureForm(`writeup:${String(entityType)}:${String(entityId)}`, {markdown: String(markdown ?? "")}, {
      resource: "writeup", entityType: String(entityType), entityId: String(entityId)
    }, state);
  }

  function clearMaster(state = options.state, photoId) {
    if (!state?.masterDrafts || photoId == null) return;
    state.masterDrafts.delete(String(photoId));
    schedulePersist(state);
  }

  function clearForm(state = options.state, key) {
    if (!state?.__managerDraftForms || !key) return;
    delete state.__managerDraftForms[String(key)];
    schedulePersist(state);
  }

  function serializableState(state = options.state) {
    const master = state?.masterDrafts && typeof state.masterDrafts.entries === "function"
      ? [...state.masterDrafts.entries()].map(([id, draft]) => ({id, draft: clone(draft)}))
      : [];
    const captions = state?.bulkCaptions ? clone(state.bulkCaptions) : null;
    const airshowStories = clone(state?.__managerAirshowStoryDrafts || {});
    const eventId = String(state?.airshowStoryEventId || "");
    if (eventId && state?.airshowStoryDraft && state.airshowStoryDirty) {
      airshowStories[eventId] = {eventId, draft: clone(state.airshowStoryDraft), dirty: Boolean(state.airshowStoryDirty)};
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      repository,
      updatedAt: new Date().toISOString(),
      master,
      captions,
      airshowStories,
      forms: clone(state?.__managerDraftForms || {})
    };
  }

  function persist(state = options.state) {
    if (!state) return false;
    try {
      const snapshot = serializableState(state);
      if (!unsavedCount(state)) storage.removeItem(keyFor(repository));
      else storage.setItem(keyFor(repository), JSON.stringify(snapshot));
      dirty = false;
      return true;
    } catch (_) {
      // Quota/security errors are deliberately non-fatal. Keep in-memory drafts.
      return false;
    }
  }

  function initializeManagerDraftRecovery(state = options.state) {
    if (state && options.state !== state) setState({...options, state});
    const saved = readStored();
    if (!saved || !state) return {available: false, storageAvailable};

    const count = (saved.master?.length || 0) + Object.keys(saved.forms || {}).length
      + Object.keys(saved.airshowStories || {}).length + (saved.airshowStory ? 1 : 0)
      + (saved.captions?.queue?.length ? 1 : 0);
    if (!count) return {available: false, storageAvailable};
    const show = () => {
      const doc = global.document;
      if (!doc?.createElement) return;
      let dialog = doc.getElementById("managerDraftRecoveryDialog");
      if (!dialog) {
        dialog = doc.createElement("dialog");
        dialog.id = "managerDraftRecoveryDialog";
        dialog.setAttribute("aria-labelledby", "managerDraftRecoveryTitle");
        dialog.innerHTML = `<form method="dialog"><h2 id="managerDraftRecoveryTitle">Recover unsaved manager work?</h2><p id="managerDraftRecoverySummary"></p><div class="card-actions"><button value="discard" id="managerDraftDiscardBtn" type="submit">Discard drafts</button><button value="restore" id="managerDraftRestoreBtn" class="btn secondary" type="submit">Restore drafts</button></div></form>`;
        dialog.className = "manager-recovery-dialog";
        dialog.addEventListener("cancel", event => event.preventDefault());
        doc.body.appendChild(dialog);
        dialog.addEventListener("close", () => {
          if (dialog.returnValue === "restore") {
            applySnapshot(state, saved);

            options.onRestore?.(state);
          } else if (dialog.returnValue === "discard") {
            try { storage.removeItem(keyFor(repository)); } catch (_) { /* ignored */ }
            options.onDiscard?.(state);
          }
        });
      }
      const summary = dialog.querySelector("#managerDraftRecoverySummary");
      if (summary) summary.textContent = `${count} saved draft group${count === 1 ? " is" : "s are"} available for this repository. Restore them into the editor or discard them.`;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else if (global.confirm?.("Restore saved manager drafts?")) { applySnapshot(state, saved); options.onRestore?.(state); }
    };
    show();
    return {available: true, count, storageAvailable};
  }

  function notifyManagerDraftChange(state = options.state) {
    dirty = true;
    schedulePersist(state);
    options.onChange?.(unsavedCount(state), state);
    return unsavedCount(state);
  }

  function unsavedItems(state = options.state) {
    if (!state) return [];
    const items = [];
    if (state.masterDrafts && typeof state.masterDrafts.keys === "function") {
      for (const id of state.masterDrafts.keys()) items.push({kind: "master", id: String(id), label: `Photo ${id}`});
    }
    for (const [key, item] of Object.entries(state.__managerDraftForms || {})) {
      const meta = item?.meta || {};
      items.push({kind: meta.resource || "form", id: key, label: meta.label || key});
    }
    for (const [id, item] of Object.entries(state.__managerAirshowStoryDrafts || {})) {
      if (item?.dirty) items.push({kind: "airshow-story", id, label: `Event ${id} segments`});
    }
    if (state.bulkCaptions && (state.bulkCaptions.queue || Object.keys(state.bulkCaptions.results || {}).length)) {
      items.push({kind: "captions", id: "bulk-captions", label: "Caption review queue"});
    }
    return items;
  }

  function renderUnsavedIndicator(container, navigate, state = options.state) {
    if (!container) return 0;
    const items = unsavedItems(state);
    container.textContent = "";
    if (!items.length) { container.hidden = true; return 0; }
    container.hidden = false;
    const count = global.document?.createElement ? global.document.createElement("span") : null;
    if (!count) return items.length;
    count.className = "manager-unsaved-indicator";
    count.setAttribute("role", "status");
    count.textContent = `${items.length} unsaved draft${items.length === 1 ? "" : "s"}`;
    items.slice(0, 8).forEach((item) => {
      const button = global.document.createElement("button");
      button.type = "button";
      button.className = "btn ghost manager-unsaved-link";
      button.dataset.draftKind = item.kind;
      button.dataset.draftId = item.id;
      button.textContent = item.label;
      button.addEventListener("click", () => navigate?.(item));
      count.appendChild(button);
    });
    container.appendChild(count);
    return items.length;
  }

  function schedulePersist(state = options.state) {
    if (saveTimer) global.clearTimeout(saveTimer);
    saveTimer = global.setTimeout(() => { saveTimer = null; persist(state); }, 120);
  }

  function clear(state = options.state, key = null) {
    try {
      if (key) storage.removeItem(key);
      else storage.removeItem(keyFor(repository));
    } catch (_) { /* ignored */ }
    if (state) {
      state.masterDrafts?.clear?.();
      if (state.bulkCaptions) { state.bulkCaptions.queue = null; state.bulkCaptions.results = {}; }
      state.airshowStoryDraft = null;
      state.airshowStoryDirty = false;
      state.__managerAirshowStoryDrafts = {};
      state.__managerDraftForms = {};
    }
    dirty = false;
  }

  function unsavedCount(state = options.state) {
    if (!state) return 0;
    let count = state.masterDrafts?.size || 0;
    count += new Set([...Object.keys(state.__managerAirshowStoryDrafts || {}).filter(id => state.__managerAirshowStoryDrafts[id]?.dirty), ...(state.airshowStoryDirty ? [state.airshowStoryEventId] : [])]).size;
    if (state.bulkCaptions && (state.bulkCaptions.queue || Object.values(state.bulkCaptions.results || {}).some((item) => ["proposed", "error", "generating", "saving"].includes(item?.status)))) count += 1;
    count += Object.keys(state.__managerDraftForms || {}).length;
    return count;
  }

  function beforeUnload(event) {
    if (!dirty && unsavedCount() === 0) return undefined;
    if (saveTimer) { global.clearTimeout(saveTimer); saveTimer = null; }
    persist();
    event.preventDefault();
    event.returnValue = "";
    return "";
  }

  function bind() {
    if (!global.addEventListener || bind.bound) return;
    bind.bound = true;
    global.addEventListener("beforeunload", beforeUnload);
    global.addEventListener("pagehide", () => { if (dirty) persist(); });
  }

  const store = {
    configure: setState,
    init: setState,
    initializeManagerDraftRecovery,
    restore,
    restoreForms,
    restoreWriteUp,
    captureForm,
    captureMaster,
    captureCaptions,
    captureCaptionProposal,
    captureStory,
    captureWriteUp,
    clearMaster,
    clearForm,
    persist,
    schedulePersist,
    clear,
    beforeUnload,
    notifyManagerDraftChange,
    unsavedItems,
    renderUnsavedIndicator,
    unsavedCount,
    get repository() { return repository; },
    get dirty() { return dirty; },
    readFormValues,
    applyFormValues
  };
  global.SpotterDexDrafts = store;
  // Named hooks make integration from app.js explicit and avoid monkey-patching
  // the app's render/save functions.
  global.beforeManagerRender = function beforeManagerRender(context) {
    if (context?.state && (options.state !== context.state || repositoryId(context.state, context.repository) !== repository)) {
      setState({...options, ...context});
    }
    return store;
  };
  global.afterManagerRender = function afterManagerRender(context) {
    const state = context?.state || options.state;
    restoreForms(context?.root || global.document, state);
    return store;
  };
  bind();
})(typeof window !== "undefined" ? window : globalThis);
