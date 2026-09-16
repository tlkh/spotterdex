/* Explicit recovery, form baselines and optimistic save tokens. */
let managerRecoveryInitialized = false;
let managerRecoveryReady = false;
let managerRestoringForms = false;

function managerDraftsChanged() {
  if (!managerRecoveryReady) return;
  SpotterDexDrafts.notifyManagerDraftChange(state);
}

function initializeManagerRecovery() {
  if (managerRecoveryInitialized || !state.data?.project) return;
  managerRecoveryInitialized = true;
  const finish = () => { managerRecoveryReady=true; renderActiveView(); restoreManagerForms(); renderManagerUnsaved(); };
  SpotterDexDrafts.configure({state,onRestore:finish,onDiscard:finish,onChange:renderManagerUnsaved});
  const recovery=SpotterDexDrafts.initializeManagerDraftRecovery(state);
  managerRecoveryReady=!recovery.available;
  if(!recovery.storageAvailable) {$("managerStorageNotice").hidden=false;$("managerStorageNotice").textContent="Local draft recovery is unavailable in this browser. Keep this tab open until your work is saved.";}
  renderManagerUnsaved();
  document.addEventListener("input",captureManagerFormInput);
  document.addEventListener("change",captureManagerFormInput);
}

function renderManagerUnsaved() {
  if (!managerRecoveryInitialized) return;
  const items=SpotterDexDrafts.unsavedItems(state);
  $("managerUnsavedButton").hidden=!items.length;
  $("managerUnsavedButton").textContent=`Unsaved work (${items.length})`;
  const container=$("managerUnsavedList");
  container.innerHTML=items.map(item=>`<div class="manager-draft-item"><button class="btn ghost" type="button" data-manager-open-draft="${escapeHtml(item.id)}" data-manager-draft-kind="${escapeHtml(item.kind)}">${escapeHtml(item.label)}</button><button class="btn ghost" type="button" data-manager-discard-draft="${escapeHtml(item.id)}" data-manager-draft-kind="${escapeHtml(item.kind)}" aria-label="Discard ${escapeHtml(item.label)}">Discard</button></div>`).join("");
}

function managerFormResource(form) {
  if(form.dataset.entryEdit) return `entry:${form.dataset.entryEdit}`;
  if(form.dataset.locationEdit) return `location:${form.dataset.locationEdit}`;
  if(form.dataset.aircraftSettingsRow) return `aircraft:${form.dataset.aircraftSettingsRow}`;
  if(form.dataset.unitLogoRow) return `unit:${state.data?.squadronGroups?.find(g=>g.key===form.dataset.unitLogoRow)?.unitId || ""}`;
  return "";
}

function prepareManagerForms(root=document) {
  root.querySelectorAll('[data-entry-edit], [data-location-edit], [data-inline-create], [data-aircraft-settings-row], [data-unit-logo-row], .workflow-create-form').forEach(form=> {
    const resource=managerFormResource(form);
    const key=resource || (form.dataset.inlineCreate ? `create:${form.dataset.inlineCreate}` : `create:${form.querySelector('input[id]')?.id || "record"}`);
    form.dataset.draftKey=key;
    if(!form.dataset.revision) form.dataset.revision=state.__managerDraftForms?.[key]?.meta?.revision || state.data?.revisions?.[resource] || "";
    if(!form.__draftBaseline) form.__draftBaseline=SpotterDexDrafts.readFormValues(form);
  });
}

function restoreManagerForms() {
  if(!managerRecoveryInitialized) return;
  managerRestoringForms=true;
  try {prepareManagerForms(); SpotterDexDrafts.restoreForms(document,state);} finally {managerRestoringForms=false;}
}

function captureManagerFormInput(event) {
  if(!managerRecoveryReady || managerRestoringForms) return;
  const field=event.target;
  if(field.id==="writeUpMarkdown") {
    const type=$("writeUpType").value,id=$("writeUpEntity").value,key=`writeup:${type}:${id}`;
    const stored=writeUpEntities(type).find(e=>e.id===id)?.writeUp || "";
    if(field.value===stored) delete state.__managerDraftForms?.[key];
    else SpotterDexDrafts.captureForm(key,{markdown:field.value},{resource:"writeup",entityType:type,entityId:id,label:`Write-up · ${writeUpEntities(type).find(e=>e.id===id)?.name || id}`,revision:field.dataset.revision},state);
    managerDraftsChanged();return;
  }
  prepareManagerForms();
  const form=field.closest("[data-draft-key]");
  if(!form) return;
  const key=form.dataset.draftKey, values=SpotterDexDrafts.readFormValues(form);
  if(JSON.stringify(values)===JSON.stringify(form.__draftBaseline)) delete state.__managerDraftForms?.[key];
  else SpotterDexDrafts.captureForm(key,values,{resource:"form",view:state.activeTab,label:form.querySelector('h2,h3')?.textContent || key,revision:form.dataset.revision},state);
  managerDraftsChanged();
}

function managerPhotoId(reference) {
  if(reference.photoId) return reference.photoId;
  const entry=entryByTargetKey(reference.entryPath);
  return entry?.photos?.find(p=>Number(p.index)===Number(reference.index))?.photoId || "";
}

function prepareManagerMutation(path,body) {
  if(!body || !state.data?.revisions) return body;
  const resources=[];
  if(["/api/update-master-photo","/api/update-photo"].includes(path)) resources.push(`photo:${managerPhotoId(body)}`);
  if(["/api/bulk-update-photos","/api/bulk-airshow"].includes(path)) for(const ref of body.photos || []) resources.push(`photo:${managerPhotoId(ref)}`);
  if(path==="/api/update-entry") resources.push(`entry:${body.entryPath}`);
  if(path==="/api/update-pin" || path==="/api/set-pin-hero") resources.push(`location:${body.locationId || body.pinId}`);
  if(path==="/api/update-aircraft-settings" || path==="/api/set-aircraft-hero") resources.push(`aircraft:${body.aircraftId}`);
  if(path==="/api/update-unit-logo") resources.push(`unit:${body.unitId}`);
  if(path==="/api/set-squadron-hero") resources.push(`unit:${state.data.squadronGroups.find(g=>g.name===body.squadronName && g.country===body.country)?.unitId}`);
  if(path==="/api/set-airshow-hero") resources.push(`event:${state.data.airshowEvents.find(e=>e.name===body.eventName)?.id}`);
  if(path==="/api/save-event-story") resources.push(`story:${body.eventId}`);
  if(path==="/api/update-write-up") resources.push(`writeup:${body.entityType}:${body.entityId}`);
  if(!resources.length) return body;
  const expected={};
  for(const resource of resources) {
    let revision=state.data.revisions[resource];
    if(resource.startsWith("photo:") && path==="/api/update-master-photo") revision=state.masterDrafts.get(body.photoId)?.photo?._revision || revision;
    if(resource.startsWith("story:")) revision=state.airshowStoryDraft?._revision || revision;
    const formDraft=state.__managerDraftForms?.[resource];
    revision=formDraft?.meta?.revision || revision;
    const form=document.querySelector(`[data-draft-key="${CSS.escape(resource)}"]`);
    revision=form?.dataset.revision || revision;
    if(resource.startsWith("writeup:")) revision=formDraft?.meta?.revision || $("writeUpMarkdown").dataset.revision || revision;
    expected[resource]=revision || "missing-editor-revision";
  }
  return {...body,expectedRevisions:{...expected,...body.expectedRevisions}};
}

function managerMutationSucceeded(path,body,result,draftSnapshot = "{}") {
  const submittedDrafts=JSON.parse(draftSnapshot || "{}");
  if(!managerRecoveryInitialized) return;
  if(result.revisions) {
    Object.assign(state.data.revisions || {},result.revisions);
    for(const [resource,revision] of Object.entries(result.revisions)) {
      if(JSON.stringify(state.__managerDraftForms?.[resource])===JSON.stringify(submittedDrafts[resource])) delete state.__managerDraftForms?.[resource];
      else if(state.__managerDraftForms?.[resource]) state.__managerDraftForms[resource].meta.revision=revision;
      const form=document.querySelector(`[data-draft-key="${CSS.escape(resource)}"]`);
      if(form) {form.dataset.revision=revision;if(!state.__managerDraftForms?.[resource])form.__draftBaseline=SpotterDexDrafts.readFormValues(form);}
    }
  }
  const createKey=({"/api/create-entry":"source","/api/create-pin":"location","/api/create-event":"event"})[path];
  if(createKey) {
    delete state.__managerDraftForms?.[`create:${createKey}`];
    const dialog=document.querySelector(".workflow-create-dialog[open]");
    const form=dialog?.querySelector("[data-draft-key]");
    if(form) {delete state.__managerDraftForms?.[form.dataset.draftKey];form.__draftBaseline=SpotterDexDrafts.readFormValues(form);dialog.close();}
  }
  managerDraftsChanged();
}

function restoreManagerWriteUp() {
  if(!managerRecoveryInitialized) return;
  const type=$("writeUpType").value,id=$("writeUpEntity").value,key=`writeup:${type}:${id}`;
  $("writeUpMarkdown").dataset.revision=state.__managerDraftForms?.[key]?.meta?.revision || state.data?.revisions?.[key] || "";
  SpotterDexDrafts.restoreWriteUp($("writeUpMarkdown"),state,type,id);
}

function saveManagerStoryDraft() {
  if(!managerRecoveryReady) return;
  SpotterDexDrafts.captureStory(state);managerDraftsChanged();
}

function navigateManagerDraft(item) {
  $("managerUnsavedDialog").close();
  if(item.kind==="master") {setTab("master");openLibraryEditor(item.id);}
  else if(item.kind==="captions") setTab("bulk-captions");
  else if(item.kind==="writeup") {const [,type,...ids]=item.id.split(":");setTab("writeups");$("writeUpType").value=type;renderWriteUpEditor(ids.join(":"));}
  else if(item.kind==="airshow-story") {setTab("airshows");loadAirshowStoryDraft(item.id);renderAirshowStoryManager();}
  else {
    const draft=state.__managerDraftForms?.[item.id];setTab(draft?.meta?.view || "master");
    if(item.id.startsWith("entry:")) openEntryEditor(item.id.slice(6));
    if(item.id.startsWith("location:")) openLocationEditor(item.id.slice(9));
    if(item.id.startsWith("create:")) document.querySelector(`[data-workflow-open-create="${state.activeTab}View"]`)?.click();
  }
}

function initializeManagerRecoveryControls() {
  $("managerUnsavedButton").addEventListener("click",()=> {renderManagerUnsaved();$("managerUnsavedDialog").showModal();});
  $("managerUnsavedClose").addEventListener("click",()=>$("managerUnsavedDialog").close());
  $("managerUnsavedDialog").addEventListener("close",()=>$("managerUnsavedButton").focus());
  $("managerUnsavedList").addEventListener("click",event=> {
    const open=event.target.closest("[data-manager-open-draft]");if(open) navigateManagerDraft({kind:open.dataset.managerDraftKind,id:open.dataset.managerOpenDraft});
    const discard=event.target.closest("[data-manager-discard-draft]");if(!discard)return;
    const id=discard.dataset.managerDiscardDraft,kind=discard.dataset.managerDraftKind;
    if(!window.confirm("Discard this unsaved draft? Saved catalog data stays unchanged."))return;
    if(kind==="master") state.masterDrafts.delete(id);
    else if(kind==="captions") {if(!resetBulkCaptionQueue())return;}
    else if(kind==="airshow-story") {delete state.__managerAirshowStoryDrafts?.[id];if(state.airshowStoryEventId===id)loadAirshowStoryDraft(id,true);}
    else {
      const form=document.querySelector(`[data-draft-key="${CSS.escape(id)}"]`);
      if(form?.__draftBaseline) SpotterDexDrafts.applyFormValues(form,form.__draftBaseline);
      delete state.__managerDraftForms?.[id];
      form?.removeAttribute("data-revision");
    }
    renderActiveView();managerDraftsChanged();
  });
}

async function showManagerConflict(path, body, conflict) {
  const resource=conflict.resource;
  const latest=await api("/api/state");
  const parts=resource.split(":"),id=parts.slice(1).join(":");
  let current, draft;
  if(parts[0]==="photo") {current=latest.masterPhotos.find(p=>p.id===id);draft=body.photo || body.fields;}
  else if(parts[0]==="writeup") {const type=parts[1],key=parts.slice(2).join(":");current=(type==="aircraft"?latest.aircraftCatalog:type==="squadron"?latest.squadronGroups:latest.airshowEvents).find(e=>(e.id||e.unitId)===key);current={writeUp:current?.writeUp || ""};draft={writeUp:body.writeUp};}
  else if(parts[0]==="story") {current=latest.airshowEvents.find(e=>e.id===id)?.story;draft={mode:body.mode,segments:body.segments};}
  else {current=parts[0]==="entry"?latest.entries.find(e=>e.entryPath===id):parts[0]==="location"?latest.pins.find(p=>p.id===id):parts[0]==="aircraft"?latest.aircraftCatalog.find(a=>a.id===id):latest.squadronGroups.find(u=>u.unitId===id);draft=state.__managerDraftForms?.[resource]?.values || body;}
  const dialog=$("managerConflictDialog"), output=$("managerConflictValues");
  const keys=Object.keys(draft || {}).filter(key=>!['expectedRevisions','expectedRevision','_requireRevision'].includes(key));
  const display=value=>typeof value==="object" ? JSON.stringify(value,null,2) : String(value ?? "—");
  output.innerHTML=keys.map(key=>`<section><h3>${escapeHtml(key.replace(/([A-Z])/g,' $1'))}</h3><div class="manager-compare"><div><strong>Saved now</strong><pre>${escapeHtml(display(current?.[key]))}</pre></div><div><strong>Your proposal</strong><pre>${escapeHtml(display(draft[key]))}</pre></div></div></section>`).join("");
  $("managerConflictKeep").disabled=!current || !latest.revisions?.[resource];
  $("managerConflictKeep").onclick=()=> {
    const revision=latest.revisions[resource];
    if(parts[0]==="photo" && state.masterDrafts.has(id)) {
      const draftPhoto=state.masterDrafts.get(id);draftPhoto.photo={...current,_revision:revision};
      const index=state.data.masterPhotos.findIndex(p=>p.id===id);if(index>=0) state.data.masterPhotos[index]={...current,_revision:revision};
      state.masterSaveStates.delete(id);
    }
    const formDraft=state.__managerDraftForms?.[resource];if(formDraft)formDraft.meta.revision=revision;
    const form=document.querySelector(`[data-draft-key="${CSS.escape(resource)}"]`);if(form)form.dataset.revision=revision;
    if(parts[0]==="writeup")$("writeUpMarkdown").dataset.revision=revision;
    if(parts[0]==="story" && state.airshowStoryDraft)state.airshowStoryDraft._revision=revision;
    state.data.revisions[resource]=revision;
    dialog.close();managerDraftsChanged();
    if(libraryEditorId)renderLibraryEditor();
    toast("Draft kept against the current record. Review it, then save explicitly.");
  };
  $("managerConflictClose").onclick=()=>dialog.close();
  if(!dialog.open)dialog.showModal();
}
