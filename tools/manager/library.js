/* Shared canonical-photo grid and focused editor. */
let libraryEditorId = "";
let libraryEditorOpener = null;
let librarySourceKey = "";
let librarySourceActive = false;
let libraryEditorEventId = "";
const libraryFilters = {aircraft: "", unit: "", location: "", event: "", missing: ""};

function libraryPhotoMatches(photo) {
  if (!masterPhotoMatchesSearch(photo, $("masterSearch").value.trim().toLowerCase())) return false;
  const subjects = photo.subjects || [];
  if (libraryFilters.aircraft && !subjects.some(s => s.aircraftId === libraryFilters.aircraft)) return false;
  if (libraryFilters.unit && !subjects.some(s => s.unitId === libraryFilters.unit)) return false;
  if (libraryFilters.location && photo.locationId !== libraryFilters.location) return false;
  if (libraryFilters.event && photo.eventId !== libraryFilters.event) return false;
  if (libraryFilters.missing === "caption" && photo.caption?.trim()) return false;
  if (libraryFilters.missing === "date" && (photo.exifDate || photo.date)) return false;
  if (libraryFilters.missing === "source" && photo.exists) return false;
  if (librarySourceActive && librarySourceKey) {
    const entry = entryByTargetKey(librarySourceKey);
    if (!entry) return false;
    if (entry.sourceScope === "location") return !subjects.length && photo.locationId === entry.pinId;
    if (entry.sourceScope === "squadron-target") return subjects.some(s => !s.aircraftId && s.unitName === entry.squadronName && s.country === entry.country);
    return subjects.some(s => s.entryPath === (entry.entryPath || entry.targetKey));
  }
  return true;
}

function filteredLibraryPhotos() { return (state.data?.masterPhotos || []).filter(libraryPhotoMatches); }

function renderLibraryFilters() {
  const photos = state.data?.masterPhotos || [];
  const fields = {
    aircraft: photos.flatMap(p => (p.subjects || []).filter(s => s.aircraftId).map(s => [s.aircraftId, s.aircraftType])),
    unit: photos.flatMap(p => (p.subjects || []).map(s => [s.unitId, s.unitName])),
    location: photos.map(p => [p.locationId, p.location]),
    event: photos.filter(p => p.eventId).map(p => [p.eventId, p.airshow])
  };
  for (const [key, pairs] of Object.entries(fields)) {
    const select = $("libraryFilter-" + key);
    const options = [...new Map(pairs.filter(([id]) => id)).entries()].sort((a,b) => a[1].localeCompare(b[1]));
    select.innerHTML = `<option value="">All ${key === "aircraft" ? "aircraft" : key + "s"}</option>` + options.map(([id,name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
    select.value = libraryFilters[key];
  }
}

function renderLibraryCard(photo, missing = false) {
  const values = {...masterValues(photo), ...state.masterDrafts.get(photo.id)?.changes};
  const selected = state.bulkEdit.master.has(photo.id);
  const label = photo.path || photo.id;
  const flags = [missing ? "Record removed · draft retained" : "", !photo.exists ? "Missing source" : "", !values.caption?.trim() ? "No caption" : "", !(photo.exifDate || values.date) ? "No date" : "", state.masterDrafts.has(photo.id) ? "Unsaved" : ""].filter(Boolean);
  return `<article class="library-card${selected ? " selected" : ""}" data-library-card="${escapeHtml(photo.id)}">
    <button class="library-image" type="button" data-library-open="${escapeHtml(photo.id)}" aria-label="Edit ${escapeHtml(label)}">${photo.exists && photo.sourceAssetPath ? `<img src="${thumbUrl(photo.sourceAssetPath)}" alt="${escapeHtml(masterSubjectLabel(photo))}" loading="lazy">` : '<span class="missing">Image unavailable</span>'}</button>
    <div class="library-card-info"><strong>${escapeHtml(masterSubjectLabel(photo))}</strong><span>${escapeHtml(photo.exifDate || values.date || "Date missing")} · ${escapeHtml(photo.location || "Location missing")}</span><span class="library-filename">${escapeHtml(label)}</span>
    ${flags.length ? `<span class="library-flags">${escapeHtml(flags.join(" · "))}</span>` : ""}
    ${missing ? "" : `<label class="library-select"><input type="checkbox" data-bulk-select-mode="master" data-bulk-select-key="${escapeHtml(photo.id)}" aria-label="Select ${escapeHtml(label)}"${selected ? " checked" : ""}> Select</label>`}</div></article>`;
}

function renderLibraryGrid() {
  if (!state.data) return;
  librarySourceActive = state.activeTab === "source-photos";
  const shared = $("libraryWorkspace");
  const target = state.activeTab === "source-photos" ? $("sourceLibraryHost") : $("masterView");
  if (shared.parentElement !== target) target.appendChild(shared);
  $("sourceLibraryLegacy").hidden = true;
  renderLibraryFilters();
  if (!$("masterBulkEditor").querySelector("[data-bulk-editor]")) renderBulkEditor("master", "masterBulkEditor");
  const all = state.data.masterPhotos || [];
  const photos = filteredLibraryPhotos();
  const pages = Math.max(1, Math.ceil(photos.length / state.masterPageSize));
  state.masterPage = Math.min(Math.max(1, state.masterPage), pages);
  const start = (state.masterPage - 1) * state.masterPageSize;
  const missing = [...state.masterDrafts.values()].filter(d => !all.some(p => p.id === d.photo.id));
  $("masterSummary").textContent = `${photos.length} matching · ${all.length} photos total`;
  $("masterList").innerHTML = missing.map(d => renderLibraryCard(d.photo, true)).join("") + (photos.length ? photos.slice(start, start + state.masterPageSize).map(p => renderLibraryCard(p)).join("") : '<div class="empty">No matching photos. <button class="btn ghost" type="button" data-library-clear>Clear filters</button></div>');
  $("masterPagination").innerHTML = photos.length ? `<button class="btn ghost" type="button" data-master-page="${state.masterPage-1}"${state.masterPage===1?' disabled':''}>Previous</button><span>${start+1}–${Math.min(start+state.masterPageSize,photos.length)} of ${photos.length}</span><button class="btn ghost" type="button" data-master-page="${state.masterPage+1}"${state.masterPage===pages?' disabled':''}>Next</button>` : "";
  updateBulkEditorStatus("master");
  syncLibrarySelection();
  if (libraryEditorId && $("libraryEditor").open) renderLibraryEditor();
}

function syncLibrarySelection() {
  const toolbar = $("librarySelectionToolbar");
  if (!toolbar) return;
  toolbar.hidden = state.bulkEdit.master.size === 0;
  $("libraryBulkDetails").hidden = toolbar.hidden;
  document.querySelectorAll("[data-library-card]").forEach(card => card.classList.toggle("selected", state.bulkEdit.master.has(card.dataset.libraryCard)));
}

function librarySubjectMarkup(photo, values) {
  const subjects = values.subjects || photo.subjects || [];
  const targets = (state.data.entries || []).filter(e => ["aircraft","squadron"].includes(e.sourceScope));
  const unique = [...new Map(targets.map(e => [e.entryPath || e.targetKey,e])).values()];
  return `<details class="library-subjects"><summary>Subjects · ${subjects.length || "Location only"}</summary><p class="subtle">Each aircraft/unit pair must exist in the catalog. Choose one primary subject, or remove all for a location-only photo.</p><div id="librarySubjectRows">${subjects.map((s,index) => `<div class="library-subject-row"><label><span class="subtle">Subject ${index+1}</span><select data-library-subject="${index}" aria-label="Subject ${index+1}">${unique.map(e => `<option value="${escapeHtml(e.entryPath || e.targetKey)}"${(e.entryPath || e.targetKey)===s.entryPath?' selected':''}>${escapeHtml(entryOptionLabel(e))}</option>`).join("")}</select></label><label><input type="radio" name="libraryPrimary" data-library-primary="${index}"${s.isPrimary?' checked':''}> Primary</label><button class="btn ghost" type="button" data-library-remove-subject="${index}" aria-label="Remove subject ${index+1}">Remove</button></div>`).join("")}</div><button class="btn ghost" type="button" id="libraryAddSubject"${unique.length?'':' disabled'}>Add subject</button></details>`;
}

function renderLibraryEditor() {
  const photo = (state.data.masterPhotos || []).find(p => p.id === libraryEditorId) || state.masterDrafts.get(libraryEditorId)?.photo;
  if (!photo) { $("libraryEditor").close(); return; }
  const active = document.activeElement;
  const focusId = $("libraryEditor").contains(active) ? active.id : "";
  const caret = focusId && typeof active.selectionStart === "number" ? [active.selectionStart,active.selectionEnd] : null;
  const missing = !(state.data.masterPhotos || []).some(p => p.id === photo.id);
  state.masterExpanded.add(photo.id);
  $("libraryEditorTitle").textContent = photo.path || photo.id;
  $("libraryEditorBody").innerHTML = renderMasterRow(photo, missing);
  const row = $("libraryEditorBody").querySelector("[data-master-row]");
  const img = row.querySelector("img");
  if (img) img.src = rawAssetUrl(photo.sourceAssetPath);
  row.querySelector(".master-heading-actions")?.remove();
  const fields = row.querySelector(".master-fields");
  const values = {...masterValues(photo), ...state.masterDrafts.get(photo.id)?.changes};
  fields.insertAdjacentHTML("afterend", librarySubjectMarkup(photo, values));
  const advanced = document.createElement("details"); advanced.className = "library-advanced";
  advanced.innerHTML = '<summary>Additional details</summary><div class="form-grid"></div>';
  for (const key of ["title","livery"]) fields.querySelector(`[data-master-field="${key}"]`)?.closest(".field") && advanced.lastElementChild.appendChild(fields.querySelector(`[data-master-field="${key}"]`).closest(".field"));
  fields.after(advanced);
  const collection = libraryEditorCollection(); const index = collection.findIndex(p=>p.id===photo.id);
  $("libraryPrevious").disabled = index<=0;
  $("libraryNext").disabled = index<0 || index>=collection.length-1;
  $("libraryEditorPosition").textContent = index<0 ? "Outside current filter" : `${index+1} of ${collection.length}`;
  updateMasterStatus(photo.id);
  if (focusId && $(focusId)) { $(focusId).focus({preventScroll:true}); if(caret) $(focusId).setSelectionRange(...caret); }
}

function libraryEditorCollection() { return libraryEditorEventId ? (state.data.masterPhotos || []).filter(p=>p.eventId===libraryEditorEventId) : filteredLibraryPhotos(); }

function openLibraryEditor(id, opener = document.activeElement) {
  libraryEditorOpener = opener;
  libraryEditorEventId = state.activeTab === "airshows" ? $("airshowStoryEvent").value : "";
  libraryEditorId = id;
  renderLibraryEditor();
  if (!$("libraryEditor").open) $("libraryEditor").showModal();
  $("libraryEditorClose").focus();
}

function changeLibrarySubjects(mutator) {
  const photo = state.data.masterPhotos.find(p => p.id === libraryEditorId);
  if (!photo || state.masterSaveStates.get(photo.id)?.status === "saving") return;
  const draft = state.masterDrafts.get(photo.id) || {photo:structuredClone(photo),changes:{}};
  const subjects = structuredClone(draft.changes.subjects || photo.subjects || []);
  mutator(subjects);
  draft.changes.subjects = subjects;
  state.masterDrafts.set(photo.id,draft);
  renderLibraryEditor();
  managerDraftsChanged();
  $("libraryEditorBody").querySelector(".library-subjects").open = true;
}

function librarySubjectFromEntry(key) {
  const e=entryByTargetKey(key);
  return {aircraftId:e?.aircraftId || "",unitId:e?.unitId || "",entryPath:key,aircraftType:e?.aircraftType||"",unitName:e?.squadronName||"",isPrimary:false};
}

function initializeLibrary() {
  $("masterList").classList.add("library-grid");
  $("masterList").addEventListener("click", event => {
    const button=event.target.closest("[data-library-open]");
    if(button) openLibraryEditor(button.dataset.libraryOpen,button);
    if(event.target.closest("[data-library-clear]")) { for(const key in libraryFilters) libraryFilters[key]=""; librarySourceKey=""; $("sourcePhotoSelect").value=""; $("masterSearch").value=""; $("libraryFilter-missing").value=""; renderLibraryGrid(); }
  });
  for(const key in libraryFilters) $("libraryFilter-"+key).addEventListener("change",e=> {libraryFilters[key]=e.target.value;state.masterPage=1;renderLibraryGrid();});
  $("libraryClearSelection").addEventListener("click",()=>{clearBulkSelection("master");renderLibraryGrid();});
  $("librarySelectPage").addEventListener("click",()=>selectAllBulkVisible("master"));
  $("libraryEditSelection").addEventListener("click",()=> {$("libraryBulkDetails").open=true;$("masterBulkEditor").scrollIntoView({block:"nearest"});});
  $("libraryAssignEvent").addEventListener("click",()=> {$("libraryBulkDetails").open=true;const box=$("masterBulkEditor").querySelector('[data-bulk-apply-field="airshow"]');box.checked=true;updateBulkEditorStatus("master");$("masterBulkEditor").querySelector('[data-bulk-field="airshow"]').focus();});
  $("libraryEditorClose").addEventListener("click",()=>$("libraryEditor").close());
  $("libraryEditor").addEventListener("close",()=> {const previousId=libraryEditorId;libraryEditorId=""; if(["master","source-photos"].includes(state.activeTab))renderLibraryGrid(); const opener=libraryEditorOpener; const card=document.querySelector(`[data-library-open="${CSS.escape(previousId)}"]`); (opener?.isConnected?opener:card || document.querySelector(".manager-nav .tab.active"))?.focus();});
  for(const [id,step] of [["libraryPrevious",-1],["libraryNext",1]]) $(id).addEventListener("click",()=> {const collection=libraryEditorCollection();const index=collection.findIndex(p=>p.id===libraryEditorId);if(collection[index+step]) {libraryEditorId=collection[index+step].id;renderLibraryEditor();}});
  $("libraryEditorBody").addEventListener("input",e=> {const field=e.target.closest("[data-master-field]");if(field) updateMasterDraft(libraryEditorId,field.dataset.masterField,field.value);});
  $("libraryEditorBody").addEventListener("change",e=> {
    const field=e.target.closest("[data-master-field]");if(field) updateMasterDraft(libraryEditorId,field.dataset.masterField,field.value);
    if(e.target.matches("[data-library-subject]")) changeLibrarySubjects(s=> {const index=Number(e.target.dataset.librarySubject);s[index]={...librarySubjectFromEntry(e.target.value),isPrimary:s[index].isPrimary};});
    if(e.target.matches("[data-library-primary]")) changeLibrarySubjects(s=>s.forEach((item,i)=>item.isPrimary=i===Number(e.target.dataset.libraryPrimary)));
  });
  $("libraryEditorBody").addEventListener("click",e=> {
    if(e.target.closest("[data-master-save]")) saveMasterPhoto(libraryEditorId).catch(err=>toast(err.message));
    if(e.target.closest("[data-master-discard]")) {discardMasterDraft(libraryEditorId);renderLibraryEditor();}
    if(e.target.closest("[data-master-detach]")) detachMasterPhoto(libraryEditorId).catch(err=>toast(err.message));
    const remove=e.target.closest("[data-library-remove-subject]");if(remove) changeLibrarySubjects(s=> {s.splice(Number(remove.dataset.libraryRemoveSubject),1);if(s.length&&!s.some(x=>x.isPrimary))s[0].isPrimary=true;});
    if(e.target.closest("#libraryAddSubject")) changeLibrarySubjects(s=> {const target=(state.data.entries||[]).find(e=>["aircraft","squadron"].includes(e.sourceScope)&&!s.some(x=>x.entryPath===(e.entryPath||e.targetKey)));if(target)s.push({...librarySubjectFromEntry(target.entryPath||target.targetKey),isPrimary:!s.length});});
  });
}
