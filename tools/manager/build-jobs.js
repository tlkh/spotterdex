/* Build observers can reconnect; only POST starts work. */
let managerBuildJobId = "";
let managerBuildCursor = 0;
let managerBuildTimer = null;
let managerBuildPolling = false;
let managerBuildCompletedId = "";
let managerBuildStarting = false;

function setManagerBuildBusy(busy) {
  $("buildBtn").disabled = busy;
  $("buildBtn2").disabled = busy;
}

async function pollManagerBuildJob() {
  if (managerBuildPolling || !managerBuildJobId) return;
  managerBuildPolling = true;
  clearTimeout(managerBuildTimer);
  let again = false;
  const observedId = managerBuildJobId;
  try {
    const payload = await api(`/api/build-jobs/${encodeURIComponent(managerBuildJobId)}?cursor=${managerBuildCursor}&limit=150`);
    if(observedId!==managerBuildJobId) {again=true;return;}
    const job = payload.job;
    if(payload.truncated) appendBuildLog("Earlier log lines were trimmed; showing retained progress.","stdout");
    for(const event of payload.events || []) {
      const item = event.payload || {};
      if(event.name === "log") appendBuildLog(item.line || "",item.stream || "stdout");
      if(event.name === "status") $("buildStatus").textContent=item.message || "Building local output…";
      if(event.name === "summary") renderBuildSummary(item);
    }
    managerBuildCursor=payload.nextCursor;
    const running=["queued","running"].includes(job.status);
    setManagerBuildBusy(running);
    $("buildStatus").dataset.status=running?"running":job.status==="succeeded"?"success":"error";
    if(!running) {
      $("buildStatus").textContent=job.status==="succeeded" ? "Local build succeeded. Review the output before publishing; nothing was deployed." : job.status==="interrupted" ? "Manager restarted during this build. Completion is unknown. Inspect local output before starting another build." : `Local build failed. ${job.error || "Review the log before trying again."}`;
      if(job.result?.summary) renderBuildSummary(job.result.summary);
      if(managerBuildCompletedId!==job.id) {managerBuildCompletedId=job.id;try {await loadState(true);} catch(_) {}}
    }
    again=running || payload.hasMore;
  } catch(error) {
    $("buildStatus").dataset.status="unknown";
    $("buildStatus").textContent="Build connection lost. Reconnecting to the same job; completion is unknown.";
    // Never re-submit a build when its observer disconnects.
    setManagerBuildBusy(true);
    again=true;
  } finally {
    managerBuildPolling=false;
    if(again) managerBuildTimer=setTimeout(pollManagerBuildJob,1500);
  }
}

async function connectManagerBuildJob(id) {
  if(managerBuildJobId!==id) {managerBuildJobId=id;managerBuildCursor=0;$("buildLog").textContent="";}
  await pollManagerBuildJob();
}

async function reconnectManagerBuild() {
  if(managerBuildStarting || managerBuildPolling) return;
  try {
    const payload=await api("/api/build-jobs");
    const id=payload.activeJobId || payload.jobs?.[0]?.id;
    if(id) await connectManagerBuildJob(id);
  } catch(error) {
    $("buildStatus").textContent="Could not check previous builds. Open Build & verify to retry.";
  }
}

async function startManagerBuild() {
  if(managerBuildStarting) return;
  managerBuildStarting=true;
  setManagerBuildBusy(true);
  setTab("build");
  state.orphans={scanned:false,ready:false,items:[],message:""};
  renderOrphans();
  $("buildSummary").innerHTML="";
  $("buildStatus").textContent="Starting local build…";
  try {
    const response=await api("/api/build-jobs",{buildSettings:collectBuildSettings()});
    await connectManagerBuildJob(response.jobId);
  } catch(error) {
    if(error.payload?.activeJob?.id) {await connectManagerBuildJob(error.payload.activeJob.id);return;}
    // A POST response may be lost after the job started. Resolve through the read-only registry.
    $("buildStatus").textContent="Build start could not be confirmed. Checking the build registry…";
    try {
      const status=await api("/api/build-jobs");
      if(status.activeJobId) {await connectManagerBuildJob(status.activeJobId);return;}
      setManagerBuildBusy(false);
      $("buildStatus").textContent=`Build start was not confirmed. ${error.message} Check previous output before retrying.`;
    } catch(_) {$("buildStatus").textContent="Build start is unknown. Reopen Build & verify after reconnecting; do not start another build yet.";}
  } finally {managerBuildStarting=false;}
}
