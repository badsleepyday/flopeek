const state = { graph: null, workspace: null, scanOutcome: null, candidateRepositoryCheck: null, selectedId: null, selectedPlannedNodeId: null, focusId: null, mode: "overview", scope: "application", level: "feature", continueMode: false, plannedOverlays: null, plannedOverlayId: null, cy: null, cyRenderer: null, renderViewKey: null, renderer: "canvas", rendererMetrics: null, searchTimer: null, statusTimer: null, liveReloading: false, liveReloadQueued: false, events: null, liveNewFiles: [], liveNewFileCount: 0, liveNewFilesTruncated: false, liveDelta: null, liveContexts: null, contextResolution: null, flowLens: null, flowComparison: null, projectHome: null, productProof: null, benchmark: null, benchmarking: false, initialFlowOpened: false };
const $ = (selector) => document.querySelector(selector);
const colorByType = { endpoint: "#7632ba", command: "#146c94", schedule: "#9a4d00", route: "#3856c9", controller: "#3856c9", service: "#0b7a67", class: "#0b7a67", function: "#1371a4", repository: "#b45b1a", database: "#9b6611", queue: "#a43470", external: "#586578", feature: "#3457d5", module: "#61708b", config: "#7282a1", declaration: "#7282a1" };
const modeTitles = { overview: "Feature overview", requests: "Entry map", dependencies: "Direct dependencies" };

function mapTitle(view) {
  if (view.mode !== "overview") return modeTitles[view.mode];
  return ({ domain: "Domain overview", feature: "Feature overview", component: "Component overview", symbol: "Symbol overview" })[view.level] || modeTitles.overview;
}

function activeProjectMetadata() {
  const activeWorkspaceProject = state.workspace?.projects?.find((project) => project.active);
  const graphProject = state.graph?.project || {};
  const name = String(activeWorkspaceProject?.serviceLabel || graphProject.name || "").trim();
  return {
    name: name || "Untitled project",
    repositoryName: String(graphProject.name || "").trim() || null,
  };
}

function renderProjectIdentity() {
  const project = activeProjectMetadata();
  $("#viewer-project-title").textContent = project.name;
  document.title = `${project.name} · Flopeek`;
}

function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function toast(message) { const node = $("#toast-template").content.firstElementChild.cloneNode(true); node.textContent = message; document.body.append(node); setTimeout(() => node.remove(), 2600); }

function showcaseParameters() {
  const query = new URLSearchParams(window.location.search);
  return { id: query.get("showcase"), flowId: query.get("flow") };
}

async function copyText(value, message) {
  await navigator.clipboard.writeText(value);
  toast(message);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed.");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function activeViewQuery() {
  const query = new URLSearchParams({ mode: state.mode, scope: state.scope, level: state.level });
  if (state.focusId) query.set("focus", state.focusId);
  return query;
}

function currentPackageSelection() {
  return state.scanOutcome?.discovery?.selection || state.graph?.aiContext?.packageSelection || null;
}

function renderPackageScope() {
  const badge = $("#package-scope-badge");
  const boundary = $("#package-scope-boundary");
  if (!badge || !boundary) return;
  const selection = currentPackageSelection();
  if (selection?.status !== "selected") {
    badge.hidden = true;
    badge.textContent = "";
    badge.title = "";
    badge.removeAttribute("aria-describedby");
    boundary.hidden = true;
    boundary.textContent = "";
    return;
  }
  badge.hidden = false;
  badge.textContent = `Package: ${selection.path}`;
  badge.setAttribute("aria-describedby", "package-scope-boundary");
  boundary.hidden = false;
  boundary.textContent = "Session only · repository cache unchanged";
  badge.title = [
    "Static package subtree only.",
    "This does not prove workspace membership, dependency ownership, build activation, or runtime topology.",
    "The scan uses an ephemeral session graph and does not replace the repository-wide cache.",
  ].join("\n");
}

async function loadWorkspace() {
  const health = await request("/api/health");
  if (health.mode !== "workspace-hub") return;
  state.workspace = await request("/api/workspace");
  const picker = $("#workspace-project-picker");
  const select = $("#workspace-project-select");
  picker.hidden = false;
  $("#workspace-name").textContent = state.workspace.workspaceId;
  select.innerHTML = state.workspace.projects.map((project) => `<option value="${escapeHtml(project.projectId)}" ${project.active ? "selected" : ""}>${escapeHtml(project.serviceLabel)} · ${escapeHtml(project.name)}</option>`).join("");
  $("#scan-form label").textContent = "Activate project";
  $("#scan-form button").textContent = "Add to workspace";
}

async function loadView() {
  $("#status").textContent = "Scanning technical structure...";
  [state.graph, state.scanOutcome, state.plannedOverlays] = await Promise.all([
    request(`/api/view?${activeViewQuery().toString()}`),
    request("/api/scan-status"),
    request("/api/planned-overlays"),
  ]);
  $("#status").textContent = "";
  $("#root-input").value = state.graph.project.root;
  $("#project-name").textContent = state.graph.project.name;
  renderProjectIdentity();
  renderPackageScope();
  $("#project-id-badge").textContent = state.graph.project.projectId ? state.graph.project.projectId.slice(0, 20) : "identity unavailable";
  $("#graph-version-badge").textContent = Number.isInteger(state.graph.aiContext?.graphState?.graphVersion) ? `v${state.graph.aiContext.graphState.graphVersion}` : "unversioned";
  $("#branch-badge").textContent = state.graph.project.git.branch;
  $("#revision-badge").textContent = state.graph.project.git.revision ? `@ ${state.graph.project.git.revision.slice(0, 12)}` : "";
  $("#stats").textContent = `${state.graph.stats.scannedFiles} files · ${state.graph.stats.classes} classes · ${state.graph.stats.functions} functions · ${state.graph.stats.calls || 0} direct calls · ${state.graph.stats.services} services · ${state.graph.stats.endpoints} HTTP entries · ${state.graph.stats.commandEntries || 0} command entries · ${state.graph.stats.scheduledEntries || 0} scheduled entries · ${state.graph.stats.tests} tests`;
  renderScanOutcome(state.scanOutcome);
  $("#mode-filter").value = state.mode;
  $("#scope-filter").value = state.scope;
  $("#level-filter").value = state.graph.view.level || state.level;
  $("#level-filter").disabled = state.mode === "dependencies";
  renderContinueControls();
  renderSidebar();
  renderGraph();
  if (!state.selectedId && !state.flowLens && !state.initialFlowOpened) {
    state.initialFlowOpened = true;
    const firstFlow = state.graph.flows?.[0];
    if (firstFlow) {
      await openFlowLens(firstFlow.id);
    } else {
      await openProjectHome(state.projectHome?.conceptSearch?.concept || "");
    }
  }
}

function selectedPlannedOverlay() {
  if (!state.continueMode || !state.plannedOverlayId) return null;
  return state.plannedOverlays?.records?.find((overlay) => overlay.id === state.plannedOverlayId) || null;
}

function renderContinueControls() {
  const enabled = Boolean(state.continueMode);
  const select = $("#planned-overlay-filter");
  const records = state.plannedOverlays?.status === "available" ? state.plannedOverlays.records || [] : [];
  if (state.plannedOverlayId && !records.some((record) => record.id === state.plannedOverlayId)) {
    state.plannedOverlayId = null;
    state.selectedPlannedNodeId = null;
  }
  select.innerHTML = `<option value="">${records.length ? "Choose a planned overlay" : "No local planned overlays"}</option>${records.map((overlay) => `<option value="${escapeHtml(overlay.id)}" ${overlay.id === state.plannedOverlayId ? "selected" : ""}>${escapeHtml(overlay.id)} · ${escapeHtml(overlay.checkpointFreshnessStatus)}</option>`).join("")}`;
  select.disabled = !enabled || !records.length;
  $("#continue-mode").checked = enabled;
  const status = $("#continue-mode-status");
  status.textContent = enabled ? "On" : "Off";
  status.dataset.status = enabled ? "on" : "off";
  const overlay = selectedPlannedOverlay();
  $("#continue-mode-note").textContent = !enabled
    ? "Off: this map contains only current static technical evidence."
    : !records.length
      ? "No local planned overlay is available. Planning metadata remains separate from source evidence."
      : !overlay
        ? "Choose one overlay. Planned nodes remain delivery-plan metadata, not source facts."
        : `${overlay.nodes.length} planned nodes · ${overlay.edges.length} planned relationships · checkpoint anchors ${overlay.checkpointFreshnessStatus}.`;
}

function renderScanOutcome(outcome, phase = null) {
  const badge = $("#scan-status-badge");
  const cancel = $("#cancel-scan");
  if (!badge) return;
  if (state.candidateRepositoryCheck) {
    badge.className = "scan-status-badge candidate";
    badge.textContent = "Checking new repository · current map remains active";
    badge.title = [
      "Candidate repository check in progress.",
      `Current map: ${state.graph?.project?.name || "active repository"}.`,
      "Cancel is unavailable until the candidate is accepted.",
    ].join("\n");
    if (cancel) cancel.hidden = true;
    return;
  }
  const status = outcome?.status || "idle";
  const freshness = outcome?.activeGraph?.freshness || "unavailable";
  const displayPhase = phase || outcome?.progress?.phase || "";
  badge.className = "scan-status-badge";
  if (status === "running") {
    badge.classList.add("running");
    badge.textContent = displayPhase ? `Scanning · ${displayPhase.replaceAll("-", " ")}` : "Scanning";
  } else if (status === "complete" && freshness === "current") {
    badge.classList.add("current");
    badge.textContent = "Scan current";
  } else if (outcome?.activeGraph?.available) {
    badge.classList.add("stale");
    badge.textContent = "Cached graph · source unverified";
  } else if (status === "failed") {
    badge.classList.add("failed");
    badge.textContent = "Scan failed";
  } else {
    badge.textContent = "Scan status unavailable";
  }
  const bounds = outcome?.bounds || {};
  const selection = outcome?.discovery?.selection || outcome?.progress?.selection || currentPackageSelection();
  const limits = [
    Number.isFinite(bounds.timeBudgetMs) ? `${bounds.timeBudgetMs} ms` : null,
    Number.isFinite(bounds.maxFiles) ? `${bounds.maxFiles} files` : null,
    Number.isFinite(bounds.maxBytes) ? `${bounds.maxBytes} bytes` : null,
  ].filter(Boolean).join(" · ");
  badge.title = [
    `Status: ${status}`,
    `Freshness: ${freshness}`,
    outcome?.activeGraph?.source ? `Graph source: ${outcome.activeGraph.source}` : null,
    outcome?.reason ? `Reason: ${outcome.reason}` : null,
    limits ? `Bounds: ${limits}` : "Bounds: none",
    selection?.status === "selected" ? `Static package scope: ${selection.path}` : null,
  ].filter(Boolean).join("\n");
  if (cancel) cancel.hidden = !(status === "running" && outcome?.mode === "bounded-full-analysis");
}

function setCandidateRepositoryCheck(requestedRoot = null) {
  state.candidateRepositoryCheck = requestedRoot;
  const submit = $("#scan-form button[type=submit]");
  if (submit) submit.disabled = Boolean(requestedRoot);
  renderScanOutcome(state.scanOutcome);
}

function showStatus(message) {
  clearTimeout(state.statusTimer);
  $("#status").textContent = message;
  state.statusTimer = setTimeout(() => {
    if ($("#status").textContent === message) $("#status").textContent = "";
  }, 2600);
}

async function reloadLiveView(options = {}) {
  if (state.liveReloading) {
    state.liveReloadQueued = true;
    return;
  }
  state.liveReloading = true;
  const selectedId = state.selectedId;
  const selectedFlowId = state.flowLens?.flow?.id || null;
  const comparedFlow = state.flowComparison ? {
    id: state.flowComparison.comparison?.flow?.id || state.flowComparison.flowId,
    fromVersion: state.flowComparison.fromGraphVersion,
    toVersion: state.flowComparison.toGraphVersion,
  } : null;
  try {
    await loadView();
    if (selectedFlowId) {
      let lens = null;
      try {
        lens = await request(`/api/flow-lens?flow=${encodeURIComponent(selectedFlowId)}&scope=${encodeURIComponent(state.scope === "all" ? "all" : "application")}`);
      } catch {
        state.flowLens = null;
        toast("The selected Flow Lens entry no longer exists in the refreshed graph.");
      }
      if (lens) {
        state.flowLens = lens;
        renderFlowLensInspector(lens);
      }
    } else if (comparedFlow?.id) {
      try {
        const comparison = await request(`/api/flow-comparison?flow=${encodeURIComponent(comparedFlow.id)}&fromVersion=${encodeURIComponent(comparedFlow.fromVersion)}&toVersion=${encodeURIComponent(comparedFlow.toVersion)}`);
        if (comparison.available) {
          state.flowComparison = comparison;
          renderFlowComparisonInspector(comparison);
        } else {
          state.flowComparison = null;
          toast("The retained Flow Lens comparison is no longer available.");
        }
      } catch {
        state.flowComparison = null;
      }
    } else if (selectedId && state.graph.nodes.some((node) => node.id === selectedId)) await selectNode(selectedId);
    else if (selectedId) {
      state.selectedId = null;
      if (state.mode === "dependencies") {
        state.focusId = null;
        state.mode = "overview";
        await loadView();
      }
      renderAgentContext();
    }
    const message = options.addedFileId
      ? "New source node detected and opened."
      : options.addedFileCount > 1
        ? `${options.addedFileCount} new source nodes are ready to review.`
        : "Graph updated from repository changes.";
    showStatus(message);
  } catch (error) {
    toast(`Live update failed: ${error.message}`);
  } finally {
    state.liveReloading = false;
    if (state.liveReloadQueued) {
      state.liveReloadQueued = false;
      reloadLiveView();
    }
  }
}

function connectLiveUpdates() {
  if (!window.EventSource) return;
  state.events = new EventSource("/api/events");
  state.events.addEventListener("ready", (event) => {
    try {
      const ready = JSON.parse(event.data);
      if (ready.scanOutcome) {
        state.scanOutcome = ready.scanOutcome;
        renderScanOutcome(ready.scanOutcome);
      }
    } catch {}
  });
  state.events.addEventListener("scan-status", (event) => {
    try {
      const update = JSON.parse(event.data);
      state.scanOutcome = update;
      renderScanOutcome(update, update.phase);
      if (["partial-by-budget", "cancelled", "failed"].includes(update.status) && update.activeGraph?.available) {
        toast("Scan did not complete. Flopeek kept the last complete graph and marks it source-unverified.");
      }
    } catch {}
  });
  state.events.addEventListener("graph", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (update.generatedAt === state.graph?.generatedAt) return;
      const addedFiles = update.reason === "filesystem"
        ? (update.addedFiles || update.addedFileIds?.map((id) => ({ id, label: id.replace(/^file:/, ""), path: id.replace(/^file:/, ""), type: "file" })) || [])
        : [];
      const addedFileCount = update.reason === "filesystem" ? Number(update.addedFileCount || addedFiles.length) : 0;
      if (addedFiles.length) {
        state.liveNewFiles = addedFiles;
        state.liveNewFileCount = addedFileCount;
        state.liveNewFilesTruncated = Boolean(update.addedFilesTruncated);
      }
      state.liveDelta = update.deltaIdentity ? { ...update.deltaIdentity, summary: update.delta || null } : null;
      state.liveContexts = update.changedContexts?.available ? update.changedContexts : null;
      const addedFileId = addedFileCount === 1 ? addedFiles[0]?.id : null;
      if (addedFileId) {
        state.mode = "dependencies";
        state.scope = "all";
        state.focusId = addedFileId;
        state.selectedId = addedFileId;
      }
      reloadLiveView({ addedFileId, addedFileCount });
    } catch {
      reloadLiveView();
    }
  });
  state.events.addEventListener("graph-error", (event) => {
    try { toast(`Live scan failed: ${JSON.parse(event.data).message}`); } catch { toast("Live scan failed."); }
  });
  state.events.addEventListener("planned-overlay", async () => {
    try {
      state.plannedOverlays = await request("/api/planned-overlays");
      renderContinueControls();
      if (state.continueMode) renderGraph();
    } catch (error) {
      toast(`Planned overlay refresh failed: ${error.message}`);
    }
  });
  state.events.addEventListener("plan-reconciliation", () => {
    if (state.continueMode && state.selectedPlannedNodeId) selectPlannedNode(state.selectedPlannedNodeId).catch((error) => toast(`Plan-reconciliation refresh failed: ${error.message}`));
  });
}

function renderSidebar() {
  const flowList = $("#flow-list");
  const flowItems = state.graph.flows;
  const catalog = state.graph.flowCatalog || { total: flowItems.length, returned: flowItems.length, omittedFlowIds: [], truncated: false, warning: null };
  const entryCount = (state.graph.stats.endpoints || 0) + (state.graph.stats.commandEntries || 0) + (state.graph.stats.scheduledEntries || 0);
  $("#flow-summary").textContent = catalog.truncated
    ? `${catalog.returned} of ${catalog.total} Flow Lenses shown. ${catalog.warning || "Some items are omitted."}`
    : `${catalog.returned} Flow Lenses for ${entryCount} detected static entries.`;
  flowList.innerHTML = flowItems.length
    ? flowItems.map((flow) => `<button class="flow-button${state.flowLens?.flow?.id === flow.id ? " selected-flow" : ""}" data-flow="${escapeHtml(flow.id)}" title="${escapeHtml(flow.title)}">${escapeHtml(flow.title)}</button>`).join("")
    : `<section class="empty-flow-state"><strong>No supported static entry point detected.</strong><p>This does not mean the application has no behavior. Flopeek still has its bounded technical map.</p><div class="button-row"><button data-empty-flow-action="overview">Explore features</button><button data-empty-flow-action="search">Find code</button></div></section>`;
  flowList.querySelectorAll("[data-flow]").forEach((button) => button.addEventListener("click", () => openFlowLens(button.dataset.flow)));
  flowList.querySelectorAll("[data-empty-flow-action]").forEach((button) => button.addEventListener("click", async () => {
    if (button.dataset.emptyFlowAction === "search") {
      $("#search").focus();
      return;
    }
    state.selectedId = null;
    state.flowLens = null;
    state.focusId = null;
    state.mode = "overview";
    await loadView();
  }));
  $("#clear-focus").hidden = !state.focusId;
  renderLiveUpdates();
  renderCoverageSummary();
}

function renderLiveUpdates() {
  const container = $("#live-updates");
  const files = state.liveNewFiles;
  const delta = state.liveDelta;
  const contexts = state.liveContexts;
  if (!files.length && !delta && !contexts) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const count = state.liveNewFileCount || files.length;
  const title = `${count} new source node${count === 1 ? "" : "s"}`;
  const more = state.liveNewFilesTruncated || count > files.length ? `<p class="live-update-more">Showing ${files.length} of ${count}. Refine or search to inspect the rest.</p>` : "";
  const deltaSummary = delta
    ? `<div class="live-delta"><h2>Graph version v${escapeHtml(delta.fromGraphVersion)} → v${escapeHtml(delta.toGraphVersion)}</h2><p>${delta.sourceChanged && !delta.topologyChanged ? "Source changed without a static topology change." : delta.topologyChanged ? "Static graph relationships changed." : "Graph state changed."}</p>${delta.summary ? `<small>${escapeHtml(delta.summary.addedNodes || 0)} added nodes · ${escapeHtml(delta.summary.removedNodes || 0)} removed nodes · ${escapeHtml(delta.summary.changedNodes || 0)} changed nodes</small>` : ""}</div>`
    : "";
  const contextNodes = contexts?.nodes || [];
  const contextFlows = contexts?.flows || [];
  const changedFlows = contextFlows.length
    ? `<div class="live-context-section"><h2>Affected flows</h2><div class="live-update-list">${contextFlows.map((flow) => flow.availability === "current"
      ? `<div class="live-flow-actions"><button class="live-update-button" data-live-flow="${escapeHtml(flow.id)}"><strong>${escapeHtml(flow.title)}</strong><small>${escapeHtml(flow.status)} static change${flow.changedStepIds?.length ? ` · ${escapeHtml(flow.changedStepIds.length)} displayed step${flow.changedStepIds.length === 1 ? "" : "s"} affected` : ""}</small></button>${flow.flowComparisonAvailable ? `<button class="live-compare-button" data-compare-flow="${escapeHtml(flow.id)}" data-compare-from="${escapeHtml(contexts.fromGraphVersion)}" data-compare-to="${escapeHtml(contexts.toGraphVersion)}">Compare v${escapeHtml(contexts.fromGraphVersion)} to v${escapeHtml(contexts.toGraphVersion)}</button>` : ""}</div>`
      : `<div class="live-flow-actions"><div class="live-context-item"><strong>${escapeHtml(flow.title || flow.id)}</strong><small>${escapeHtml(flow.status)} historical flow · ${escapeHtml(flow.availability)}</small></div>${flow.flowComparisonAvailable ? `<button class="live-compare-button" data-compare-flow="${escapeHtml(flow.id)}" data-compare-from="${escapeHtml(contexts.fromGraphVersion)}" data-compare-to="${escapeHtml(contexts.toGraphVersion)}">Compare v${escapeHtml(contexts.fromGraphVersion)} to v${escapeHtml(contexts.toGraphVersion)}</button>` : ""}</div>`).join("")}</div></div>`
    : "";
  const changedNodes = contextNodes.length
    ? `<div class="live-context-section"><h2>Affected technical context</h2><div class="live-update-list">${contextNodes.map((node) => node.availability === "current"
      ? `<button class="live-update-button" data-live-node="${escapeHtml(node.id)}"><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.status)} · ${escapeHtml(node.path || node.id)}</small></button>`
      : `<div class="live-context-item"><strong>${escapeHtml(node.label || node.id)}</strong><small>${escapeHtml(node.status)} historical node · ${escapeHtml(node.availability)}</small></div>`).join("")}</div></div>`
    : "";
  container.hidden = false;
  container.innerHTML = `<div class="heading-row"><h2>Live change</h2><button class="text-button" data-dismiss-live>Dismiss</button></div>${deltaSummary}${changedFlows}${changedNodes}${files.length ? `<div class="live-context-section"><h2>${title}</h2><div class="live-update-list">${files.map((file) => `<button class="live-update-button" data-live-node="${escapeHtml(file.id)}"><strong>${escapeHtml(file.label)}</strong><small>${escapeHtml(file.path)}</small></button>`).join("")}</div>${more}</div>` : ""}`;
  container.querySelector("[data-dismiss-live]").addEventListener("click", () => {
    state.liveNewFiles = [];
    state.liveNewFileCount = 0;
    state.liveNewFilesTruncated = false;
    state.liveDelta = null;
    state.liveContexts = null;
    renderLiveUpdates();
  });
  container.querySelectorAll("[data-live-node]").forEach((button) => button.addEventListener("click", () => openDependency(button.dataset.liveNode)));
  container.querySelectorAll("[data-live-flow]").forEach((button) => button.addEventListener("click", () => openFlowLens(button.dataset.liveFlow)));
  container.querySelectorAll("[data-compare-flow]").forEach((button) => button.addEventListener("click", () => openFlowComparison(button.dataset.compareFlow, button.dataset.compareFrom, button.dataset.compareTo)));
}

function renderCoverageSummary() {
  const container = $("#analysis-coverage");
  const coverage = state.graph.aiContext?.coverage;
  const registry = state.graph.aiContext?.adapterCapabilities;
  const summary = coverage?.summary;
  if (!summary) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const incomplete = Number(summary.inventoryOnlyFiles || 0) + Number(summary.parseFailedFiles || 0);
  const parsed = Number(summary.parsedFiles || 0);
  const status = summary.parseFailedFiles
    ? `${summary.parseFailedFiles} file${summary.parseFailedFiles === 1 ? "" : "s"} could not be parsed; inspect its node evidence before relying on this map.`
    : incomplete
      ? `${incomplete} file${incomplete === 1 ? " is" : "s are"} inventory-only and have no inferred dependencies.`
      : "All scanned source files were structurally parsed.";
  const languages = (coverage.byLanguage || [])
    .filter((language) => language.files > 0)
    .sort((left, right) => left.language.localeCompare(right.language))
    .slice(0, 8)
    .map((language) => `<li><strong>${escapeHtml(language.language)}</strong><span>${language.parsed}/${language.files} parsed${language.parseFailed ? ` · ${language.parseFailed} failed` : ""}${language.inventoryOnly ? ` · ${language.inventoryOnly} inventory` : ""}</span></li>`)
    .join("");
  const registrySummary = registry?.adapters?.length
    ? `<p class="muted">${escapeHtml(String(registry.adapters.length))} registered static adapters describe general support. The counts below are this repository's parse coverage; neither is runtime behavior.</p>`
    : "";
  container.hidden = false;
  const scope = state.graph.aiContext?.repositoryScope;
  const scopeSummary = scope
    ? `<div class="detail-section"><h3>Repository scope</h3><p>${escapeHtml(scope.source === "config" ? "Configured" : "Default rules")} · ${escapeHtml(scope.counts.application)} application · ${escapeHtml(scope.counts.test)} test · ${escapeHtml(scope.counts.fixture)} fixture · ${escapeHtml(scope.counts.generated)} generated · ${escapeHtml(scope.counts.excluded)} excluded</p><p>Default flows include application entries only. Choose Everything (diagnostic) to inspect tests, fixtures, and generated source.</p></div>`
    : "";
  const cache = state.graph.aiContext?.cache;
  const cacheState = state.graph.aiContext?.cacheState;
  const graphState = state.graph.aiContext?.graphState;
  const cacheSummary = cache
    ? `<div class="detail-section"><h3>Graph state</h3><p>Schema v${escapeHtml(cache.graphSchemaVersion)} · graph v${escapeHtml(graphState?.graphVersion ?? "unversioned")} · ${escapeHtml(cacheState?.status || "memory")} · validated reads and writes · atomic local replacement</p><p>${escapeHtml(graphState?.status === "current" ? "No material static graph change since the last persisted version." : cache.limitation)}</p></div>`
    : "";
  const derivedCache = state.graph.aiContext?.derivedCache;
  const latestCacheEvent = derivedCache?.latestEvents?.[0];
  const derivedCacheSummary = derivedCache
    ? `<div class="detail-section"><h3>Derived context cache</h3><p>${escapeHtml(derivedCache.totalArtifacts)} artifacts · ${escapeHtml(derivedCache.counts.hits)} hits · ${escapeHtml(derivedCache.counts.misses)} misses · ${escapeHtml(derivedCache.counts.invalidated)} invalidated · ${escapeHtml(derivedCache.counts.retainedUnaffected)} retained unaffected</p><p>Graph v${escapeHtml(derivedCache.graphVersion)} · source ${escapeHtml(derivedCache.sourceBasis?.kind || "unavailable")} · stale reuse: ${escapeHtml(derivedCache.policy?.staleReuse || "unknown")}${latestCacheEvent ? ` · latest: ${escapeHtml(latestCacheEvent.status)} (${escapeHtml(latestCacheEvent.reason)})` : ""}</p>${derivedCache.eventCatalog?.truncated ? `<p class="warning">${escapeHtml(derivedCache.eventCatalog.warning)}</p>` : ""}</div>`
    : "";
  container.innerHTML = `<h2>Parser coverage</h2><p class="coverage-count">${parsed}/${summary.scannedFiles} files structurally parsed</p>${registrySummary}<p>${escapeHtml(status)}</p>${languages ? `<ul class="coverage-languages">${languages}</ul>` : ""}${scopeSummary}${cacheSummary}${derivedCacheSummary}`;
}

function homeBadges(item) {
  return `<div class="home-badges"><span>${escapeHtml(item?.status || "available")}</span><span>${escapeHtml(item?.evidenceClass || "unclassified")}</span><span>${escapeHtml(item?.freshnessStatus || "unavailable")}</span></div>`;
}

function homeEvidenceButton(ref, label = "Open source evidence") {
  return ref ? `<button class="home-evidence" data-home-ref="${escapeHtml(ref)}">${escapeHtml(label)}</button>` : "";
}

function homeStatementCard(title, item) {
  const text = item?.status === "available" ? item.text : item?.reason || "Unavailable.";
  return `<section class="home-card"><h3>${escapeHtml(title)}</h3>${homeBadges(item)}<p>${escapeHtml(text)}</p>${homeEvidenceButton(item?.evidenceRefs?.[0])}</section>`;
}

async function openProjectHome(concept = "") {
  const query = concept ? `?concept=${encodeURIComponent(concept)}` : "";
  state.projectHome = await request(`/api/project-home${query}`);
  state.selectedId = null;
  state.flowLens = null;
  const home = state.projectHome;
  const critical = home.criticalFlows.items.map((item) => `<li>${escapeHtml(item.selection.text)}${homeEvidenceButton(item.flow.contextRef, item.flow.title)}</li>`).join("") || "<li>No human-selected critical flows.</li>";
  const changed = home.recentlyChangedFlows.items.map((item) => `<li>${escapeHtml(item.status)} · ${escapeHtml(item.title)}${homeEvidenceButton(item.contextRef)}</li>`).join("") || `<li>${escapeHtml(home.recentlyChangedFlows.reason || "No recently changed flows.")}</li>`;
  const starting = home.recommendedStartingPoints.items.map((item) => `<li>${escapeHtml(item.text)}${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ""}${homeEvidenceButton(item.evidenceRefs?.[0])}</li>`).join("") || "<li>No starting point is available.</li>";
  const questions = home.unresolvedQuestions.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("") || "<li>No unresolved question has been recorded.</li>";
  const features = home.featureMap.items.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><br><small>${escapeHtml(item.nodeCount)} nodes · ${escapeHtml(item.endpointCount)} endpoints · ${escapeHtml(item.evidenceClass)}</small>${homeEvidenceButton(item.evidenceRefs[0])}${item.evidenceRefCatalog.truncated ? `<small>${escapeHtml(item.evidenceRefCatalog.reason)}</small>` : ""}</li>`).join("");
  const featureOmission = home.featureMap.catalog?.truncated ? `<p class="muted">${escapeHtml(home.featureMap.catalog.reason)} Omitted: ${escapeHtml(home.featureMap.catalog.omittedIds.join(", "))}</p>` : "";
  const concepts = home.conceptIndex.concepts.map((item) => `<option value="${escapeHtml(item.concept)}"${home.conceptSearch?.concept === item.concept ? " selected" : ""}>${escapeHtml(item.concept)} (${escapeHtml(item.total)})</option>`).join("");
  const conceptMatches = home.conceptSearch?.results || [];
  const visibleConceptMatches = conceptMatches.slice(0, 8);
  const conceptResults = visibleConceptMatches.map((item) => `<li><strong>${escapeHtml(item.label)}</strong><br><small>${escapeHtml(item.reasons.join(" · "))}</small>${homeEvidenceButton(item.contextRef)}</li>`).join("") || `<li>${escapeHtml(home.conceptSearch?.status === "abstained" ? home.conceptSearch.reason : "Select a concept to see exact deterministic matches.")}</li>`;
  const conceptOmission = conceptMatches.length > visibleConceptMatches.length ? `<p class="muted">Showing ${escapeHtml(visibleConceptMatches.length)} of ${escapeHtml(conceptMatches.length)} exact matches. The Project Home API returns the complete deterministic result set.</p>` : "";
  const trust = home.trustBoundaries.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const readiness = home.handoffReadiness;
  $("#inspector").innerHTML = `<div class="node-kicker">project home · graph v${escapeHtml(home.graphVersion)}</div><h2 class="node-title">Understand this project</h2>${homeStatementCard("Project purpose", home.purpose)}${homeStatementCard("Architecture overview", home.architectureOverview)}<section class="home-card"><h3>Where should I start?</h3>${homeBadges(home.recommendedStartingPoints)}<ul class="home-list">${starting}</ul>${home.recommendedStartingPoints.catalog.truncated ? `<p>${escapeHtml(home.recommendedStartingPoints.catalog.reason)} Omitted: ${escapeHtml(home.recommendedStartingPoints.catalog.omittedIds.join(", "))}</p>` : ""}</section><section class="home-card"><h3>Critical and recently changed flows</h3>${homeBadges(home.criticalFlows)}<ul class="home-list">${critical}${changed}</ul></section><section class="home-card"><h3>Handoff readiness</h3><p><strong>${escapeHtml(readiness.percentage)}%</strong> documentation completeness · ${escapeHtml(readiness.complete)}/${escapeHtml(readiness.total)} fields</p><p>${escapeHtml(readiness.limitation)}</p><ul class="home-list">${questions}</ul></section><section class="home-card"><h3>Concept search</h3><p>${escapeHtml(home.conceptIndex.policy)}</p><select id="home-concept" class="home-concept-select"><option value="">Choose a concept</option>${concepts}</select><ul class="home-list">${conceptResults}</ul>${conceptOmission}</section><details class="home-card"><summary>Feature and domain map (${escapeHtml(home.featureMap.total)})</summary><ul class="home-list">${features}</ul>${featureOmission}</details><details class="home-card"><summary>Parser coverage and trust boundaries</summary>${homeBadges(home.parserCoverage)}<p>${escapeHtml(home.parserCoverage.summary?.parsedFiles || 0)}/${escapeHtml(home.parserCoverage.summary?.scannedFiles || 0)} files structurally parsed.</p><ul class="home-list">${trust}</ul></details>`;
  if (home.sourceAvailability?.status === "unavailable") $(".node-title").insertAdjacentHTML("afterend", `<section class="home-card"><h3>Source availability</h3><p><strong>Unavailable</strong> · ${escapeHtml(home.sourceAvailability.reason)}</p></section>`);
  if (home.reReviewImpact?.status === "available") $(".node-title").insertAdjacentHTML("afterend", `<section class="home-card"><h3>Re-review impact</h3><p>${escapeHtml(home.reReviewImpact.reason)}</p><p><strong>${escapeHtml(home.reReviewImpact.counts.stale || 0)}</strong> stale · <strong>${escapeHtml(home.reReviewImpact.counts.detached || 0)}</strong> detached · <strong>${escapeHtml(home.reReviewImpact.counts.unavailable || 0)}</strong> unavailable</p><p class="muted">Human verification remains historical metadata; it does not prove runtime behavior.</p></section>`);
  $("#home-concept").addEventListener("change", (event) => openProjectHome(event.target.value).catch((error) => toast(error.message)));
  $("#inspector").querySelectorAll("[data-home-ref]").forEach((button) => button.addEventListener("click", () => {
    $("#context-ref-input").value = button.dataset.homeRef;
    resolveContextFromInput().catch((error) => toast(error.message));
  }));
}

async function applyInitialViewerRoute() {
  const showcase = showcaseParameters();
  if (showcase.id) {
    document.body.classList.add("showcase-active");
    const guide = $("#showcase-guide");
    const escapedRoot = String(state.graph.project.root).replaceAll('"', '\\"');
    const applyCommand = `flopeek showcase apply "${escapedRoot}"`;
    const resetCommand = `flopeek showcase reset "${escapedRoot}"`;
    guide.hidden = false;
    $("#copy-showcase-apply").addEventListener("click", () => copyText(applyCommand, "Showcase apply command copied.").catch((error) => toast(error.message)));
    $("#copy-showcase-reset").addEventListener("click", () => copyText(resetCommand, "Showcase reset command copied.").catch((error) => toast(error.message)));
  }
  if (!showcase.flowId) return;
  if (!state.graph.flows.some((flow) => flow.id === showcase.flowId)) {
    toast("The requested static flow is not available in this graph version.");
    return;
  }
  await openFlowLens(showcase.flowId);
}

function proofPercent(value) {
  return value === null || value === undefined ? "Unavailable" : `${(Number(value) * 100).toFixed(1)}%`;
}

function renderProductProof(report) {
  state.productProof = report;
  state.selectedId = null;
  state.flowLens = null;
  const metrics = report.headlineMetrics;
  const current = report.currentRepository;
  const relationship = report.auditedRelationshipEvidence;
  const orientation = metrics.orientationRetrieval;
  const orientationEvidence = report.orientationRetrievalEvidence;
  const orientationBaseline = orientationEvidence.baseline.summary;
  const orientationFlopeek = orientationEvidence.flopeek.summary;
  const performanceRows = report.incrementalPerformanceEvidence.rows.map((row) => `<tr><td>${escapeHtml(row.repository)}</td><td>${escapeHtml(row.sourceFiles.toLocaleString())}</td><td>${escapeHtml(formatMilliseconds(row.fullMedianMs))}</td><td>${escapeHtml(formatMilliseconds(row.incrementalMedianMs))}</td><td><strong>${escapeHtml(row.speedup.toFixed(2))}&times;</strong></td></tr>`).join("");
  const features = report.capabilityShowcase.map((feature) => `<details class="proof-feature"><summary><strong>${escapeHtml(feature.title)}</strong><span>${escapeHtml(feature.status)}</span></summary><p>${escapeHtml(feature.outcome)}</p><p class="muted">Proof: ${escapeHtml(feature.proof.join(" · "))}</p><p class="muted">Boundary: ${escapeHtml(feature.boundary)}</p></details>`).join("");
  const local = report.localBenchmark.status === "available"
    ? `<section class="proof-local-result"><strong>${escapeHtml(report.localBenchmark.result.speedupVsFull.toFixed(2))}&times; local speedup</strong><p>${escapeHtml(report.localBenchmark.result.sourceFiles)} source files · ${escapeHtml(report.localBenchmark.result.parsedFiles)} structurally parsed · ${escapeHtml(report.localBenchmark.result.iterations)} samples each.</p></section>`
    : `<p>${escapeHtml(report.localBenchmark.reason)}</p>`;
  $("#inspector").innerHTML = `<div class="node-kicker">public proof &middot; bounded evidence</div><h2 class="node-title">${escapeHtml(report.title)}</h2><p>${escapeHtml(report.summary)}</p><div class="proof-metric-grid"><section class="proof-metric"><span>Audited relationships</span><strong>${escapeHtml(metrics.auditedTruePositives)}/${escapeHtml(metrics.auditedRelationships)}</strong><small>${escapeHtml(metrics.auditedRepositories)} pinned repositories</small></section><section class="proof-metric"><span>Bounded precision / recall</span><strong>${escapeHtml(proofPercent(metrics.boundedPrecision))} / ${escapeHtml(proofPercent(metrics.boundedRecall))}</strong><small>${escapeHtml(metrics.auditedScopes)} exact audited scopes</small></section><section class="proof-metric"><span>Measured incremental range</span><strong>${escapeHtml(metrics.measuredIncrementalSpeedup.minimum.toFixed(2))}&times;–${escapeHtml(metrics.measuredIncrementalSpeedup.maximum.toFixed(2))}&times;</strong><small>${escapeHtml(metrics.measuredIncrementalSpeedup.repositories)} pinned monorepos</small></section><section class="proof-metric"><span>This repository</span><strong>${escapeHtml(current.nodes.toLocaleString())} nodes</strong><small>${escapeHtml(current.sourceFiles)} files · ${escapeHtml(proofPercent(current.structuralParseRatio))} structurally parsed</small></section></div><section class="proof-boundary"><strong>Proof, with boundaries</strong><p>${escapeHtml(report.claimBoundary.statement)} ${escapeHtml(relationship.limitation)}</p></section><section class="home-card"><h3>Published incremental benchmark</h3><div class="proof-table-wrap"><table class="proof-table"><thead><tr><th>Repository</th><th>Files</th><th>Full</th><th>Incremental</th><th>Speedup</th></tr></thead><tbody>${performanceRows}</tbody></table></div><p class="muted">${escapeHtml(report.incrementalPerformanceEvidence.limitation)}</p></section><section class="home-card"><h3>Why it is useful</h3>${features}</section><section class="home-card"><h3>Run proof on this repository</h3>${local}<button id="run-proof-benchmark">${report.localBenchmark.status === "available" ? "Run local proof again" : "Run local proof benchmark"}</button><p class="muted">Reproduce from CLI: ${escapeHtml(report.reproducibility.local[0])}</p></section>`;
  $("#inspector .proof-metric-grid").insertAdjacentHTML("beforeend", `<section class="proof-metric"><span>Orientation fixture</span><strong>${escapeHtml(orientation.matchedFlowSteps)}/${escapeHtml(orientation.expectedFlowSteps)} static steps</strong><small>${escapeHtml(orientation.cases)} pinned deterministic cases</small></section>`);
  $("#inspector .proof-boundary").insertAdjacentHTML("afterend", `<section class="home-card"><h3>Repository orientation retrieval</h3><div class="proof-table-wrap"><table class="proof-table"><thead><tr><th>Metric</th><th>Direct repository</th><th>Flopeek</th></tr></thead><tbody><tr><td>Correct targets</td><td>${escapeHtml(orientationBaseline.correctTargetRetrieval.matched)}/${escapeHtml(orientationBaseline.correctTargetRetrieval.expected)}</td><td>${escapeHtml(orientationFlopeek.correctTargetRetrieval.matched)}/${escapeHtml(orientationFlopeek.correctTargetRetrieval.expected)}</td></tr><tr><td>Ordered static steps</td><td>Unavailable</td><td>${escapeHtml(orientationFlopeek.flowSteps.matchedInExpectedOrder)}/${escapeHtml(orientationFlopeek.flowSteps.expected)}</td></tr><tr><td>Related tests</td><td>${escapeHtml(orientationBaseline.relatedTests.matched)}/${escapeHtml(orientationBaseline.relatedTests.expected)}</td><td>${escapeHtml(orientationFlopeek.relatedTests.matched)}/${escapeHtml(orientationFlopeek.relatedTests.expected)}</td></tr><tr><td>Stale Context Refs</td><td>Unavailable</td><td>${escapeHtml(orientationFlopeek.staleContextDetection.detected)}/${escapeHtml(orientationFlopeek.staleContextDetection.requested)}</td></tr><tr><td>Bounded context</td><td>${escapeHtml(orientationBaseline.context.filesInspected)} files / ${escapeHtml(orientationBaseline.context.estimatedTokens)} estimated tokens</td><td>${escapeHtml(orientationFlopeek.context.filesInspected)} files / ${escapeHtml(orientationFlopeek.context.estimatedTokens)} estimated tokens</td></tr><tr><td>Captured cold time</td><td>${escapeHtml(formatMilliseconds(orientationBaseline.timing.coldTimeToUsefulContextMilliseconds))}</td><td>${escapeHtml(formatMilliseconds(orientationFlopeek.timing.coldTimeToUsefulContextMilliseconds))}</td></tr></tbody></table></div><p class="muted">${escapeHtml(orientationEvidence.limitation)}</p></section>`);
  const orientationRows = [...$("#inspector").querySelectorAll(".proof-table tbody tr")];
  const coldRow = orientationRows.find((row) => row.firstElementChild?.textContent === "Captured cold time");
  if (coldRow) {
    coldRow.firstElementChild.textContent = "Preparation + retrieval";
    coldRow.insertAdjacentHTML("afterend", `<tr><td>Warm bounded retrieval</td><td>${escapeHtml(formatMilliseconds(orientationBaseline.timing.caseRetrievalMilliseconds))}</td><td>${escapeHtml(formatMilliseconds(orientationFlopeek.timing.caseRetrievalMilliseconds))}</td></tr><tr><td>Separate stale-ref validation</td><td>${escapeHtml(formatMilliseconds(orientationBaseline.timing.separateValidationMilliseconds))}</td><td>${escapeHtml(formatMilliseconds(orientationFlopeek.timing.separateValidationMilliseconds))}</td></tr><tr><td>Process startup/module load</td><td>Unavailable</td><td>Unavailable</td></tr>`);
  }
  $("#run-proof-benchmark").addEventListener("click", () => runProductProofBenchmark());
}

async function openProductProof() {
  renderProductProof(await request("/api/product-proof"));
}

async function runProductProofBenchmark() {
  const button = $("#run-proof-benchmark");
  button.disabled = true;
  button.textContent = "Running full and incremental scans...";
  try {
    const report = await request("/api/product-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ iterations: 3 }) });
    renderProductProof(report);
    showStatus(`Public proof refreshed with a ${Number(report.localBenchmark.result.speedupVsFull).toFixed(2)}× local incremental/full comparison.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Retry local proof benchmark";
    toast(error.message);
  }
}

function graphLabel(node) {
  if (node.kind === "summary") return `${node.label}\n${node.memberCount} source node${node.memberCount === 1 ? "" : "s"}`;
  const role = node.kind === "endpoint" ? "HTTP entry" : node.kind === "command" ? "Declared package command" : node.kind === "schedule" ? "Declared static schedule" : node.type;
  const evidence = node.analysis?.status === "inventory-only" ? "inventory only" : "static evidence";
  return `${node.label}\n${role} · ${evidence}`;
}

function contextRefTarget(contextRef, factualNodeIds, anchors) {
  try {
    const parts = new URL(contextRef).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const contextId = parts[2]?.replace(/@\d+$/u, "") || null;
    if (parts[1] === "node" && contextId && factualNodeIds.has(contextId)) return contextId;
    const anchorId = `plan-anchor:${encodeURIComponent(contextRef)}`;
    if (!anchors.has(anchorId)) anchors.set(anchorId, { data: { id: anchorId, label: `Current context anchor\n${parts[1] || "unknown"}`, type: "context-anchor", kind: "context-anchor", contextRef, anchor: true, planned: false, color: "#536782" } });
    return anchorId;
  } catch {
    const anchorId = `plan-anchor:${encodeURIComponent(contextRef)}`;
    if (!anchors.has(anchorId)) anchors.set(anchorId, { data: { id: anchorId, label: "Current context anchor", type: "context-anchor", kind: "context-anchor", contextRef, anchor: true, planned: false, color: "#536782" } });
    return anchorId;
  }
}

function continuationElements() {
  const overlay = selectedPlannedOverlay();
  if (!overlay) return { nodes: [], edges: [], plannedNodes: 0, plannedEdges: 0, anchorNodes: 0 };
  const factualNodeIds = new Set(state.graph.nodes.map((node) => node.id));
  const anchors = new Map();
  const plannedId = (id) => `planned:${overlay.id}:${id}`;
  const endpoint = (value) => value.kind === "planned-node" ? plannedId(value.plannedNodeId) : contextRefTarget(value.contextRef, factualNodeIds, anchors);
  const nodes = overlay.nodes.map((node) => ({ data: { id: plannedId(node.id), label: `PLANNED\n${node.title}`, type: "planned", kind: node.kind, planned: true, plannedNodeId: node.id, overlayId: overlay.id, planRef: node.planRef, checkpointId: overlay.checkpointId, checkpointFreshnessStatus: overlay.checkpointFreshnessStatus, color: "#7956b2" } }));
  const edges = overlay.edges.map((edge, index) => ({ data: { id: `planned-edge:${overlay.id}:${index}`, source: endpoint(edge.source), target: endpoint(edge.target), type: "planned", planned: true, label: edge.relationship.replaceAll("_", " "), relationship: edge.relationship, overlayId: overlay.id } }));
  return { nodes: [...anchors.values(), ...nodes], edges, plannedNodes: nodes.length, plannedEdges: edges.length, anchorNodes: anchors.size };
}

function graphElements() {
  const continuation = continuationElements();
  return {
    elements: [
      ...state.graph.nodes.map((node) => ({ data: { id: node.id, label: graphLabel(node), type: node.type, kind: node.kind, layer: node.layer, planned: false, analysisStatus: node.analysis?.status || "parsed", evidenceClass: node.evidenceClass || "parser-fact", color: colorByType[node.type] || colorByType.feature } })),
      ...state.graph.edges.map((edge, index) => ({ data: { id: edge.id || `${edge.source}-${edge.target}-${index}`, source: edge.source, target: edge.target, type: edge.type, label: edge.count > 1 ? `${edge.type} · ${edge.count}` : edge.type, count: edge.count || 1, planned: false } })),
      ...continuation.nodes,
      ...continuation.edges,
    ],
    continuation,
  };
}

function elementId(element) { return element.data.id; }

function newNodePosition(element, elements, cy, index) {
  const id = elementId(element);
  const relation = elements.find((candidate) => candidate.data.source === id || candidate.data.target === id);
  const neighborId = relation?.data.source === id ? relation.data.target : relation?.data.source;
  const neighbor = neighborId ? cy.getElementById(neighborId) : null;
  const origin = neighbor?.length ? neighbor.position() : { x: cy.width() / 2, y: cy.height() / 2 };
  const angle = (index % 6) * (Math.PI / 3);
  const distance = 164 + Math.floor(index / 6) * 54;
  return { x: origin.x + Math.cos(angle) * distance, y: origin.y + Math.sin(angle) * distance };
}

function synchronizeCytoscape(cy, elements, style) {
  const next = new Map(elements.map((element) => [elementId(element), element]));
  const removed = cy.elements().filter((element) => !next.has(element.id()));
  const additions = [];
  cy.batch(() => {
    if (removed.length) cy.remove(removed);
    for (const element of elements) {
      const current = cy.getElementById(elementId(element));
      if (current.length) current.data(element.data);
      else additions.push(element);
    }
  });
  const nodes = additions.filter((element) => !element.data.source).map((element, index) => ({ ...element, position: newNodePosition(element, elements, cy, index) }));
  const edges = additions.filter((element) => element.data.source);
  if (nodes.length) cy.add(nodes.map((element) => ({ ...element, group: "nodes" })));
  if (edges.length) cy.add(edges.map((element) => ({ ...element, group: "edges" })));
  if (style?.length && cy.style()?.fromJson) cy.style().fromJson(style).update();
  return { addedNodes: additions.filter((element) => !element.data.source).length, addedEdges: additions.filter((element) => element.data.source).length, removed: removed.length };
}

function viewRenderKey(view, continuation) {
  return [
    view.mode,
    view.scope,
    view.level,
    view.focusId || "",
    state.continueMode ? state.plannedOverlayId || "continue-without-overlay" : "technical-only",
    continuation.plannedNodes,
    continuation.anchorNodes,
  ].join("\u0000");
}

function focusRenderedView(cy, view, renderedNodeCount) {
  if (renderedNodeCount <= 20) {
    cy.fit(undefined, 64);
    // A two-node projection otherwise expands to the renderer's maximum zoom,
    // turning a compact orientation map into two oversized cards. This limits
    // only the automatic fit; people can still zoom in deliberately.
    cy.zoom(Math.min(cy.zoom(), 1.08));
    cy.center(cy.nodes());
    return;
  }
  const focus = view.focusId ? cy.getElementById(view.focusId) : cy.nodes().first();
  cy.zoom(0.78);
  if (focus.length) cy.center(focus);
}

function renderGraph() {
  const container = $("#graph");
  const { nodes, edges, view } = state.graph;
  const graphRender = graphElements();
  const continuation = graphRender.continuation;
  const nextRenderViewKey = viewRenderKey(view, continuation);
  const renderedNodeCount = nodes.length + continuation.plannedNodes + continuation.anchorNodes;
  $("#view-title").textContent = state.continueMode ? "Continue mode" : mapTitle(view);
  container.setAttribute("aria-label", state.continueMode
    ? "Technical flow graph with an explicitly selected delivery plan overlay. Planned nodes are not found in source."
    : "Static technical flow graph. Planned delivery metadata is not shown.");
  const rendererNote = state.renderer === "webgl" ? " · WebGL preview: experimental" : "";
  const catalog = state.graph.display?.catalog;
  const omission = catalog?.truncated ? ` · ${catalog.nodes.omitted + catalog.edges.omitted + catalog.edges.omittedBecauseNodeBound} omitted by display bounds` : "";
  $("#graph-note").textContent = view.emptyState || `${nodes.length} visible nodes · ${edges.length} visible relationships · ${view.sourceNodeCount} source nodes represented${omission}${rendererNote}`;
  if (state.continueMode) {
    const anchorNote = continuation.anchorNodes ? ` · ${continuation.anchorNodes} context anchors` : "";
    $("#graph-note").textContent = `${nodes.length} technical nodes · ${edges.length} factual relationships · ${continuation.plannedNodes} planned nodes · ${continuation.plannedEdges} planned relationships${anchorNote}${rendererNote}`;
  }
  if (!renderedNodeCount) {
    if (state.cy) { state.cy.destroy(); state.cy = null; state.cyRenderer = null; }
    state.renderViewKey = null;
    container.innerHTML = `<div class="empty-canvas"><strong>Choose a node to inspect dependencies</strong><span>${escapeHtml(view.emptyState || "No nodes match this view.")}</span></div>`;
    return;
  }
  if (!window.cytoscape || !window.cytoscapeDagre) {
    container.innerHTML = "<div class='empty-canvas'><strong>Graph library failed to load</strong><span>Reload the local viewer to load Cytoscape.js.</span></div>";
    return;
  }
  window.cytoscape.use(window.cytoscapeDagre);
  const startedAt = performance.now();
  const edgeCurveStyle = state.renderer === "webgl" ? "bezier" : "taxi";
  const renderOptions = {
    container,
    elements: graphRender.elements,
    minZoom: 0.35,
    maxZoom: 2.4,
    wheelSensitivity: 0.18,
    boxSelectionEnabled: false,
    renderer: state.renderer === "webgl" ? { name: "canvas", webgl: true } : { name: "canvas" },
    style: [
      { selector: "node", style: { "background-color": "#ffffff", "border-width": 2, "border-color": "data(color)", "shape": "round-rectangle", "width": 188, "height": 66, "label": "data(label)", "color": "#172033", "font-family": "Inter, system-ui, sans-serif", "font-size": 12, "font-weight": 700, "text-wrap": "wrap", "text-max-width": 156, "text-valign": "center", "text-halign": "center", "padding": 8, "overlay-opacity": 0 } },
      { selector: "node[kind = 'summary']", style: { "background-color": "#f2f5ff", "border-color": "#3457d5", "border-style": "double", "border-width": 4 } },
      { selector: "node[analysisStatus = 'inventory-only']", style: { "border-style": "dotted", "border-width": 3, "background-color": "#f8fafc" } },
      { selector: "node[type = 'endpoint']", style: { "background-color": "#fbf4ff", "shape": "round-rectangle" } },
      { selector: "node[type = 'command']", style: { "background-color": "#eff9fc", "shape": "round-rectangle" } },
      { selector: "node[type = 'schedule']", style: { "background-color": "#fff6e9", "shape": "round-rectangle" } },
      { selector: "node[type = 'database']", style: { "background-color": "#fff9ed", "shape": "barrel" } },
      { selector: "node[type = 'external']", style: { "background-color": "#f5f7fa", "shape": "hexagon" } },
      { selector: "node[type = 'context-anchor']", style: { "background-color": "#f4f7fb", "border-style": "dotted", "border-color": "#536782", "shape": "diamond", "width": 154, "height": 58, "font-size": 10, "font-weight": 700 } },
      { selector: "node[type = 'planned']", style: { "background-color": "#fbf8ff", "border-color": "#7956b2", "border-style": "dashed", "border-width": 3, "shape": "ellipse", "width": 196, "height": 78, "font-size": 12, "font-weight": 800, "opacity": 0.9 } },
      { selector: "edge", style: { "width": 1.2, "line-color": "#aebbd0", "target-arrow-color": "#aebbd0", "target-arrow-shape": "triangle", "arrow-scale": 0.8, "curve-style": edgeCurveStyle, "taxi-direction": "horizontal", "taxi-turn": "45%", "taxi-turn-min-distance": 24, "opacity": 0.38, "overlay-opacity": 0 } },
      { selector: "edge[type = 'planned']", style: { "width": 2.2, "line-style": "dashed", "line-color": "#7956b2", "target-arrow-color": "#7956b2", "target-arrow-shape": "triangle", "label": "data(label)", "font-size": 10, "font-weight": 700, "color": "#59398a", "text-background-color": "#fbf8ff", "text-background-opacity": 0.96, "text-background-padding": 3, "opacity": 0.92 } },
      { selector: ".selected", style: { "border-color": "#172033", "border-width": 5, "background-color": "#e7edff", "underlay-color": "#3457d5", "underlay-opacity": 0.12, "underlay-padding": 9 } },
      { selector: ".incoming-node", style: { "border-color": "#16827a", "background-color": "#eefaf7" } },
      { selector: ".outgoing-node", style: { "border-color": "#7046b5", "background-color": "#f7f2ff" } },
      { selector: ".related", style: { "label": "data(label)", "font-family": "Inter, system-ui, sans-serif", "font-size": 10, "font-weight": 700, "color": "#26324a", "text-rotation": "autorotate", "text-background-color": "#ffffff", "text-background-opacity": 0.94, "text-background-padding": 3, "text-border-color": "#dfe5ef", "text-border-width": 1, "text-border-opacity": 1, "width": 3, "opacity": 1, "z-index": 10 } },
      { selector: ".incoming-edge", style: { "line-color": "#16827a", "target-arrow-color": "#16827a" } },
      { selector: ".outgoing-edge", style: { "line-color": "#7046b5", "target-arrow-color": "#7046b5" } },
      { selector: ".dimmed", style: { "opacity": 0.09, "text-opacity": 0 } },
    ],
    layout: { name: "dagre", rankDir: "LR", rankSep: 78, nodeSep: 44, edgeSep: 20, padding: 52, animate: false, fit: false },
  };
  const recreate = !state.cy || state.cyRenderer !== state.renderer;
  const viewChanged = state.renderViewKey !== null && state.renderViewKey !== nextRenderViewKey;
  if (recreate && state.cy) { state.cy.destroy(); state.cy = null; }
  try {
    if (recreate) {
      state.cy = window.cytoscape(renderOptions);
      state.cyRenderer = state.renderer;
      focusRenderedView(state.cy, view, renderedNodeCount);
    } else {
      synchronizeCytoscape(state.cy, graphRender.elements, renderOptions.style);
      // Preserve the user's viewport for a live refresh of the same bounded
      // view. A mode/level/focus transition is a different map, however, and
      // must receive a layout plus a visible focus rather than inheriting an
      // unrelated viewport from the previous projection.
      if (viewChanged) {
        state.cy.layout(renderOptions.layout).run();
        focusRenderedView(state.cy, view, renderedNodeCount);
      }
    }
  } catch (error) {
    if (state.renderer !== "webgl") throw error;
    state.renderer = "canvas";
    $("#renderer-mode").value = "canvas";
    state.cy = window.cytoscape({ ...renderOptions, renderer: { name: "canvas" } });
    state.cyRenderer = "canvas";
    toast(`WebGL preview is unavailable here; Canvas remains active. ${error.message}`);
  }
  state.renderViewKey = nextRenderViewKey;
  state.rendererMetrics = {
    schemaVersion: "flopeek-renderer-observation/v1",
    renderer: state.renderer,
    nodes: nodes.length,
    edges: edges.length,
    initializationMs: Number((performance.now() - startedAt).toFixed(2)),
    evidenceClass: "local-observation",
    limitation: "One local viewer construction measurement. It is not a cross-device benchmark, first-paint measurement, or readability proof.",
  };
  if (recreate) state.cy.on("tap", "node", (event) => {
    const data = event.target.data();
    if (data.planned) selectPlannedNode(data.plannedNodeId).catch((error) => toast(`Planned node could not open: ${error.message}`));
    else if (data.anchor) renderPlannedAnchorInspector(data.contextRef);
    else selectNode(event.target.id());
  });
  if (recreate) state.cy.on("mouseover", "node", (event) => highlightNode(event.target.id()));
  if (recreate) state.cy.on("mouseout", "node", () => {
    const overlay = selectedPlannedOverlay();
    const plannedId = overlay && state.selectedPlannedNodeId ? `planned:${overlay.id}:${state.selectedPlannedNodeId}` : null;
    highlightNode(state.selectedId || plannedId);
  });
  if (state.selectedId && state.graph.nodes.some((node) => node.id === state.selectedId)) highlightNode(state.selectedId);
  else if (state.selectedPlannedNodeId && selectedPlannedOverlay()) highlightNode(`planned:${state.plannedOverlayId}:${state.selectedPlannedNodeId}`);
}

async function measureRenderer(renderer = state.renderer) {
  if (!["canvas", "webgl"].includes(renderer)) throw new Error("Renderer must be canvas or webgl.");
  const previousRenderer = state.renderer;
  state.renderer = renderer;
  $("#renderer-mode").value = renderer;
  const startedAt = performance.now();
  renderGraph();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fitStartedAt = performance.now();
  state.cy?.fit(undefined, 42);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const focusStartedAt = performance.now();
  const focus = state.selectedId || state.graph?.view?.focusId || state.graph?.nodes?.[0]?.id || null;
  if (focus) highlightNode(focus);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const frameTimes = [];
  await new Promise((resolve) => {
    const sample = (timestamp) => {
      frameTimes.push(timestamp);
      if (frameTimes.length >= 5) return resolve();
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const frameIntervals = frameTimes.slice(1).map((timestamp, index) => Number((timestamp - frameTimes[index]).toFixed(2)));
  const memory = performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)
    ? { status: "available", usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize }
    : { status: "unavailable", reason: "browser-memory-api-unavailable" };
  const result = {
    ...(state.rendererMetrics || {}),
    requestedRenderer: renderer,
    renderer: state.renderer,
    initializationAndFirstPaintMs: Number((performance.now() - startedAt).toFixed(2)),
    fitMs: Number((focusStartedAt - fitStartedAt).toFixed(2)),
    focusMs: Number((performance.now() - focusStartedAt).toFixed(2)),
    stableFrame: { sampledFrames: frameIntervals.length, intervalsMs: frameIntervals, maxIntervalMs: Math.max(...frameIntervals) },
    memory,
    selectedContextPreserved: !state.selectedId || Boolean(state.cy?.getElementById(state.selectedId)?.length),
  };
  if (previousRenderer !== state.renderer) {
    state.renderer = previousRenderer;
    $("#renderer-mode").value = previousRenderer;
    renderGraph();
  }
  return result;
}

async function measureRendererPair() {
  const button = $("#measure-renderer");
  button.disabled = true;
  button.textContent = "Measuring…";
  try {
    const observations = [];
    for (const renderer of ["canvas", "webgl"]) observations.push(await measureRenderer(renderer));
    const summary = {
      schemaVersion: "flopeek-renderer-observation/v1",
      evidenceClass: "local-observation",
      projection: { nodes: observations[0]?.nodes ?? 0, edges: observations[0]?.edges ?? 0 },
      observations,
      crossDevice: { status: "unavailable", reason: "one-local-browser-session" },
      limitation: "This is a local bounded-map observation, not a cross-device benchmark, readability result, or default-renderer approval.",
    };
    state.rendererBenchmark = summary;
    const preview = observations.find((item) => item.requestedRenderer === "webgl");
    $("#inspector").innerHTML = `<div class="node-kicker">local renderer observation · not a release decision</div><h2 class="node-title">Canvas and WebGL preview</h2><div class="detail-section first-section"><h3>Bounded projection</h3><p>${escapeHtml(summary.projection.nodes)} nodes · ${escapeHtml(summary.projection.edges)} relationships</p></div><div class="detail-section"><h3>Canvas</h3><p>${escapeHtml(observations[0].initializationAndFirstPaintMs)} ms construction/paint · ${escapeHtml(observations[0].fitMs)} ms fit · ${escapeHtml(observations[0].focusMs)} ms focus</p></div><div class="detail-section"><h3>WebGL preview</h3><p>Requested WebGL; active renderer: ${escapeHtml(preview.renderer)} · ${escapeHtml(preview.initializationAndFirstPaintMs)} ms construction/paint · ${escapeHtml(preview.fitMs)} ms fit · ${escapeHtml(preview.focusMs)} ms focus</p><p>${escapeHtml(preview.memory.status === "available" ? `${preview.memory.usedJSHeapSize} bytes JS heap observed` : "Memory measurement unavailable in this browser.")}</p></div><div class="detail-section"><h3>Evidence boundary</h3><p>${escapeHtml(summary.limitation)} Cross-device evidence: unavailable (one local browser session).</p></div>`;
    toast("Local Canvas/WebGL observation recorded; Canvas remains the supported default.");
    return summary;
  } finally {
    button.disabled = false;
    button.textContent = "Measure";
  }
}

window.flopeekRendererBenchmark = { measure: measureRenderer, measurePair: measureRendererPair, current: () => state.rendererMetrics };

function plannedNodeContext(overlay, node) {
  return {
    schemaVersion: "flopeek-viewer-planned-node-context/v1",
    evidenceClass: "delivery-plan",
    planRef: node.planRef,
    overlay: { id: overlay.id, checkpointId: overlay.checkpointId, overlayVersion: overlay.overlayVersion, checkpointFreshnessStatus: overlay.checkpointFreshnessStatus },
    plannedNode: { id: node.id, kind: node.kind, title: node.title, responsibility: node.responsibility, acceptanceCriteria: node.acceptanceCriteria, anchors: node.anchors, candidatePath: node.candidatePath },
    limitation: "Planned context is local delivery-plan metadata. It is not found in source, a factual graph relationship, implementation proof, test proof, or runtime evidence.",
  };
}

function renderPlannedAnchorInspector(contextRef) {
  $("#inspector").innerHTML = `<div class="node-kicker">current context anchor · static reference</div><h2 class="node-title">Planned edge anchor</h2><div class="detail-section first-section"><h3>What this means</h3><p>This display-only anchor represents a selected technical Context Ref needed by the plan. It is not a source node and does not add a factual relationship.</p></div><div class="detail-section"><h3>Context Ref</h3><div class="node-path">${escapeHtml(contextRef)}</div><div class="button-row"><button id="copy-planned-anchor">Copy Context Ref</button><button id="open-planned-anchor">Open current technical context</button></div></div>`;
  $("#copy-planned-anchor").addEventListener("click", () => copyText(contextRef, "Context Ref copied."));
  $("#open-planned-anchor").addEventListener("click", async () => {
    $("#context-ref-input").value = contextRef;
    await resolveContextFromInput();
  });
}

function reconciliationId() {
  const suffix = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `reconciliation.viewer-${suffix}`.toLowerCase();
}

function reconciliationRecordList(records) {
  if (!records.length) return "<p class='muted'>No reconciliation has been recorded for this exact Plan Ref.</p>";
  return `<div class="reconciliation-records">${records.map((record) => `<div class="reconciliation-record"><strong>${escapeHtml(record.outcome)}</strong><span>${escapeHtml(record.actorKind)} · ${escapeHtml(record.actor)} · ${escapeHtml(record.createdAt)}</span><small>${escapeHtml(record.actualContextStatuses?.map((item) => item.status).join(", ") || "no actual Context Ref")}</small></div>`).join("")}</div>`;
}

function continuationComparisonCard(comparison, planRef) {
  if (comparison.status !== "available") return `<p class="muted">Baseline/Planned/Current comparison is unavailable. Missing retained evidence is not treated as missing implementation.</p>`;
  const plan = comparison.plans.find((item) => item.planRef === planRef);
  if (!plan) return `<p class="muted">This Plan Ref is not present in the selected comparison. No replacement plan is inferred.</p>`;
  return `<div class="continuation-comparison status-${escapeHtml(plan.status)}"><div class="continuation-comparison-heading"><strong>${escapeHtml(plan.status)}</strong><span>deterministic</span></div><div class="continuation-comparison-grid"><div><small>Baseline</small><span>${escapeHtml(comparison.baseline.freshnessStatus)}</span></div><div><small>Planned</small><span>${escapeHtml(comparison.planned.checkpointFreshnessStatus)}</span></div><div><small>Current</small><span>graph v${escapeHtml(comparison.current.graphVersion)}</span></div></div>${plan.latestReconciliation ? `<p class="muted">Latest reconciliation: ${escapeHtml(plan.latestReconciliation.outcome)} by ${escapeHtml(plan.latestReconciliation.actorKind)}.</p>` : "<p class=\"muted\">No reconciliation is recorded for this exact Plan Ref.</p>"}<p class="muted">${escapeHtml(plan.limitation)}</p></div>`;
}

function checkpointDivergenceCard(divergence) {
  const paths = divergence.changedPaths?.items || [];
  return `<div class="continuation-comparison status-${escapeHtml(divergence.status)}"><div class="continuation-comparison-heading"><strong>${escapeHtml(divergence.status)}</strong><span>read-only local Git/source check</span></div><p class="muted">${escapeHtml(divergence.diagnostics?.[0]?.message || "No divergence diagnostic is available.")}</p>${paths.length ? `<p class="muted">Changed paths: ${escapeHtml(paths.join(", "))}${divergence.changedPaths.truncated ? " …" : ""}</p>` : ""}<p class="muted">${escapeHtml(divergence.limitation)}</p></div>`;
}

async function selectPlannedNode(plannedNodeId) {
  const overlay = selectedPlannedOverlay();
  const node = overlay?.nodes.find((item) => item.id === plannedNodeId);
  if (!overlay || !node) return toast("The selected planned node is no longer available.");
  state.selectedId = null;
  state.selectedPlannedNodeId = plannedNodeId;
  const acceptance = node.acceptanceCriteria.length ? `<ul class="rule-list">${node.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p class='muted'>No acceptance criteria recorded.</p>";
  const anchors = node.anchors.length ? `<div class="connection-list">${node.anchors.map((anchor) => `<button class="connection-button" data-planned-anchor="${escapeHtml(anchor)}"><span>${escapeHtml(anchor)}</span><span class="connection-kind">context</span></button>`).join("")}</div>` : "<p class='muted'>No technical Context Ref anchor recorded.</p>";
  $("#inspector").innerHTML = `<div class="node-kicker">delivery plan · not found in source</div><h2 class="node-title">${escapeHtml(node.title)}</h2><div class="verification-status status-${escapeHtml(overlay.checkpointFreshnessStatus === "current" ? "current" : "stale")}"><strong>${escapeHtml(overlay.checkpointFreshnessStatus)} checkpoint anchors</strong><span>Planned ${escapeHtml(node.kind)} · overlay ${escapeHtml(overlay.id)}</span></div><div class="detail-section"><h3>Plan Ref</h3><div class="node-path">${escapeHtml(node.planRef)}</div><div class="button-row"><button id="copy-plan-ref">Copy Plan Ref</button><button id="copy-planned-context">Copy bounded plan context</button></div></div><div class="detail-section"><h3>Responsibility</h3><p>${escapeHtml(node.responsibility || "No responsibility recorded.")}</p>${node.candidatePath ? `<div class="node-path">Candidate path: ${escapeHtml(node.candidatePath)}</div>` : ""}</div><div class="detail-section"><h3>Acceptance criteria</h3>${acceptance}</div><div class="detail-section"><h3>Technical anchors</h3>${anchors}</div><div class="detail-section"><h3>Reconciliations</h3><div id="planned-reconciliations"><p class="muted">Loading local delivery assertions...</p></div></div><div class="detail-section"><h3>Record human reconciliation</h3><p class="muted">This records a local human delivery assertion. It cannot change source, parser facts, Flow Lens, impact, test proof, runtime evidence, or approval authority.</p><form id="record-plan-reconciliation" class="reconciliation-form"><label>Outcome<select name="outcome"><option value="confirmed-implemented">Confirmed implemented</option><option value="partially-implemented">Partially implemented</option><option value="implemented-differently">Implemented differently</option><option value="not-the-same">Not the same entity</option><option value="superseded">Superseded</option><option value="unresolved">Unresolved</option></select></label><label>Reviewer identity<input name="actor" required maxlength="240" value="local viewer"></label><label>Current actual Context Refs<textarea name="actualContextRefs" placeholder="fp://local/.../node/...@version\nfp://local/.../flow/...@version"></textarea></label><label>Evidence references (optional, one per line)<textarea name="evidenceReferences" placeholder="manual-review | review:123 | human-observation"></textarea></label><button type="submit">Record reconciliation</button></form></div><div class="detail-section"><h3>Evidence boundary</h3><p>Delivery-plan metadata is visible only because Continue mode is on. It does not create a source node, static call, impact result, Flow Lens step, parser-coverage fact, implementation result, or runtime observation.</p></div>`;
  const anchorSection = [...$("#inspector").querySelectorAll(".detail-section")].find((section) => section.querySelector("h3")?.textContent === "Technical anchors");
  anchorSection?.insertAdjacentHTML("afterend", "<div class=\"detail-section\"><h3>Baseline / Planned / Current</h3><div id=\"continuation-comparison\"><p class=\"muted\">Loading deterministic comparison...</p></div></div>");
  anchorSection?.insertAdjacentHTML("afterend", "<div class=\"detail-section\"><h3>Baseline divergence</h3><div id=\"checkpoint-divergence\"><p class=\"muted\">Loading read-only local Git/source check...</p></div></div>");
  $("#copy-plan-ref").addEventListener("click", () => copyText(node.planRef, "Plan Ref copied."));
  $("#copy-planned-context").addEventListener("click", () => copyText(JSON.stringify(plannedNodeContext(overlay, node), null, 2), "Bounded plan context copied."));
  $("#inspector").querySelectorAll("[data-planned-anchor]").forEach((button) => button.addEventListener("click", () => renderPlannedAnchorInspector(button.dataset.plannedAnchor)));
  $("#record-plan-reconciliation").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actualContextRefs = String(form.get("actualContextRefs") || "").split("\n").map((item) => item.trim()).filter(Boolean);
    const evidenceReferences = String(form.get("evidenceReferences") || "").split("\n").map((item) => item.trim()).filter(Boolean).map((item) => {
      const [kind, reference, evidenceClass] = item.split("|").map((part) => part.trim());
      return { kind, reference, evidenceClass };
    });
    const id = reconciliationId();
    try {
      const result = await request("/api/plan-reconciliations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: `viewer:${id}`, id, planRef: node.planRef, actualContextRefs, outcome: form.get("outcome"), actor: form.get("actor"), actorKind: "human", evidenceReferences }) });
      toast(`${result.created ? "Recorded" : "Reused"} ${result.reconciliation.outcome}.`);
      await selectPlannedNode(plannedNodeId);
    } catch (error) {
      toast(`Reconciliation was not recorded: ${error.message}`);
    }
  });
  try {
    const divergence = await request(`/api/checkpoint-divergence?checkpointId=${encodeURIComponent(overlay.checkpointId)}`);
    const container = $("#checkpoint-divergence");
    if (container) container.innerHTML = checkpointDivergenceCard(divergence);
  } catch (error) {
    const container = $("#checkpoint-divergence");
    if (container) container.innerHTML = `<p class="muted">Divergence is unavailable: ${escapeHtml(error.message)}.</p>`;
  }
  try {
    const comparison = await request(`/api/continuation-comparison?checkpointId=${encodeURIComponent(overlay.checkpointId)}&overlayId=${encodeURIComponent(overlay.id)}`);
    const container = $("#continuation-comparison");
    if (container) container.innerHTML = continuationComparisonCard(comparison, node.planRef);
  } catch (error) {
    const container = $("#continuation-comparison");
    if (container) container.innerHTML = `<p class="muted">Comparison is unavailable: ${escapeHtml(error.message)}. Missing retained evidence is not missing implementation.</p>`;
  }
  try {
    const reconciliations = await request(`/api/plan-reconciliations?planRef=${encodeURIComponent(node.planRef)}`);
    const container = $("#planned-reconciliations");
    if (container) container.innerHTML = reconciliationRecordList(reconciliations.records);
  } catch (error) {
    const container = $("#planned-reconciliations");
    if (container) container.innerHTML = `<p class="muted">Reconciliations are unavailable: ${escapeHtml(error.message)}</p>`;
  }
  highlightNode(`planned:${overlay.id}:${node.id}`);
}

function highlightNode(id) {
  if (!state.cy) return;
  state.cy.elements().removeClass("selected related incoming-node outgoing-node incoming-edge outgoing-edge dimmed");
  if (!id) return;
  const node = state.cy.getElementById(id);
  if (!node.length) return;
  const neighborhood = node.closedNeighborhood();
  state.cy.elements().not(neighborhood).addClass("dimmed");
  node.addClass("selected");
  node.incomers("node").addClass("incoming-node");
  node.outgoers("node").addClass("outgoing-node");
  node.incomers("edge").addClass("related incoming-edge");
  node.outgoers("edge").addClass("related outgoing-edge");
}

function renderAgentContext() {
  const context = state.graph.aiContext;
  $("#inspector").innerHTML = `<div class="node-kicker">${escapeHtml(context.mode)} · ${escapeHtml(context.scope)}</div><h2 class="node-title">AI-readable context</h2><div class="detail-section first-section"><h3>Projection meaning</h3><p>${escapeHtml(context.projection.meaning)}</p></div><div class="detail-section"><h3>Evidence policy</h3><p>${escapeHtml(context.evidencePolicy.rawFacts)}</p></div><div class="detail-section"><h3>Rules for AI agents</h3><ul class="rule-list">${context.interpretationRules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul></div><div class="detail-section"><button id="copy-agent-context">Copy agent context JSON</button></div>`;
  $("#copy-agent-context").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
    toast("Agent context copied.");
  });
}

function formatMilliseconds(value) {
  const rounded = Number(value || 0);
  return rounded >= 1_000 ? `${(rounded / 1_000).toFixed(2)} s` : `${rounded.toFixed(2)} ms`;
}

function benchmarkLanguageCoverage(result) {
  const languages = result.parserCoverage?.byLanguage || [];
  // Parser coverage uses source-file extensions as language keys (for example,
  // `rs`). Keep this display mapping explicit so the UI never mistakes parsed
  // Rust files for an unsupported language.
  const rust = languages.find((language) => language.language === "rs" || language.language === "rust");
  if (!rust) return "Rust was not detected in this benchmarked repository.";
  if (rust.inventoryOnly || rust.parseFailed) return `Rust: ${rust.parsed}/${rust.files} files structurally parsed; inspect the parser-coverage panel before relying on Rust relationships.`;
  return `Rust: ${rust.parsed}/${rust.files} files structurally parsed. This is syntax coverage, not runtime or complete dispatch coverage.`;
}

function benchmarkChart(result) {
  const full = Number(result.fullRescanMs?.median || 0);
  const incremental = Number(result.incrementalRescanMs?.median || 0);
  const maximum = Math.max(full, incremental, 1);
  const left = 96;
  const width = 178;
  const barWidth = (value) => Math.max(2, Math.round((value / maximum) * width));
  const tick = (value, x) => `<line x1="${x}" x2="${x}" y1="20" y2="132" class="benchmark-grid"/><text x="${x}" y="151" text-anchor="middle" class="benchmark-tick">${escapeHtml(formatMilliseconds(value))}</text>`;
  return `<svg class="benchmark-chart" viewBox="0 0 296 164" role="img" aria-label="Median local scan time: full reparse ${formatMilliseconds(full)}; incremental rescan ${formatMilliseconds(incremental)}."><title>Full reparse compared with incremental rescan</title><desc>Horizontal bars compare median local CPU time. Lower values are faster.</desc>${tick(0, left)}${tick(maximum / 2, left + width / 2)}${tick(maximum, left + width)}<text x="0" y="54" class="benchmark-label">Full reparse</text><rect x="${left}" y="35" width="${barWidth(full)}" height="22" rx="4" class="benchmark-bar-full"/><text x="${left + barWidth(full) + 6}" y="51" class="benchmark-value">${escapeHtml(formatMilliseconds(full))}</text><text x="0" y="104" class="benchmark-label">Incremental</text><rect x="${left}" y="85" width="${barWidth(incremental)}" height="22" rx="4" class="benchmark-bar-incremental"/><text x="${left + barWidth(incremental) + 6}" y="101" class="benchmark-value">${escapeHtml(formatMilliseconds(incremental))}</text><text x="${left}" y="17" class="benchmark-axis">Median local CPU time · lower is faster</text></svg>`;
}

function renderBenchmarkInspector(result) {
  const fullSamples = (result.fullRescanMs?.samples || []).map(formatMilliseconds).join(" · ");
  const incrementalSamples = (result.incrementalRescanMs?.samples || []).map(formatMilliseconds).join(" · ");
  const speedup = Number(result.speedupVsFull || 0).toFixed(2);
  const selectedPath = result.selectedPath || "No supported source path selected.";
  $("#inspector").innerHTML = `<div class="node-kicker">local benchmark · static analysis</div><h2 class="node-title">Incremental scan comparison</h2><div class="benchmark-speedup"><strong>${speedup}× faster</strong><span>median incremental versus full reparse</span></div>${benchmarkChart(result)}<div class="detail-section first-section"><h3>Benchmark scope</h3><p>${escapeHtml(result.sourceFiles)} source files · ${escapeHtml(result.parsedFiles)} structurally parsed · ${escapeHtml(result.iterations)} samples each</p><div class="node-path">${escapeHtml(selectedPath)}</div></div><div class="detail-section"><h3>Sample medians</h3><p>Full: ${escapeHtml(fullSamples)}<br>Incremental: ${escapeHtml(incrementalSamples)}</p></div><div class="detail-section"><h3>Language evidence</h3><p>${escapeHtml(benchmarkLanguageCoverage(result))}</p></div><div class="detail-section"><h3>Interpretation boundary</h3><p>${escapeHtml(result.interpretation)}</p></div><div class="detail-section"><button id="rerun-benchmark">Run benchmark again</button></div>`;
  $("#rerun-benchmark").addEventListener("click", () => runBenchmark());
}

async function runBenchmark() {
  if (state.benchmarking) return;
  state.benchmarking = true;
  const button = $("#run-benchmark");
  button.disabled = true;
  button.textContent = "Benchmarking…";
  $("#status").textContent = "Benchmarking full and incremental scans…";
  try {
    state.benchmark = await request("/api/benchmark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ iterations: 3 }) });
    state.selectedId = null;
    renderBenchmarkInspector(state.benchmark);
    showStatus(`Benchmark complete: ${Number(state.benchmark.speedupVsFull).toFixed(2)}× faster incremental scan.`);
  } catch (error) {
    toast(`Benchmark failed: ${error.message}`);
  } finally {
    state.benchmarking = false;
    button.disabled = false;
    button.textContent = "Benchmark";
  }
}

function renderSummaryInspector(node) {
  const level = node.hierarchy?.level || state.graph?.view?.level || "feature";
  const nextLevel = ({ domain: "feature", feature: "component", component: "symbol" })[level] || null;
  const types = Object.entries(node.typeCounts || {}).map(([type, count]) => `<span class="method-chip">${escapeHtml(type)} · ${count}</span>`).join("");
  const members = node.members?.length
    ? `<div class="connection-list">${node.members.map((member) => `<button class="connection-button" data-member="${escapeHtml(member.id)}"><span>${escapeHtml(member.label)}</span><span class="connection-kind">${escapeHtml(member.type)}</span></button>`).join("")}</div>`
    : "<p class='muted'>No member preview is available.</p>";
  $("#inspector").innerHTML = `<div class="node-kicker">feature summary · derived</div><h2 class="node-title">${escapeHtml(node.label)}</h2><div class="detail-section first-section"><h3>What this node means</h3><p>This is a visual aggregation of ${node.memberCount} source nodes. It is not a file, a runtime service, or an execution step.</p></div><div class="detail-section"><h3>Member types</h3><div class="method-chips">${types}</div></div><div class="detail-section"><h3>Member preview</h3>${members}</div><div class="detail-section"><h3>Evidence boundary</h3><p>Each aggregated edge is derived from stored parser facts. Open a member to inspect its exact source evidence.</p></div>`;
  $("#inspector").querySelectorAll("[data-member]").forEach((button) => button.addEventListener("click", () => openDependency(button.dataset.member)));
  if (nextLevel) {
    $("#inspector .first-section").insertAdjacentHTML("beforeend", `<button id="drill-semantic-level">Explore ${escapeHtml(nextLevel)}s</button>`);
    $("#drill-semantic-level").addEventListener("click", async () => {
      state.level = nextLevel;
      state.focusId = node.id;
      state.selectedId = null;
      state.flowLens = null;
      await loadView();
    });
  }
}

function connectionList(items) {
  return items.length ? `<div class="connection-list">${items.map((item) => `<button class="connection-button" data-select="${escapeHtml(item.node.id)}"><span>${escapeHtml(item.node.label)}</span><span class="connection-kind">${escapeHtml(item.type)}</span></button>`).join("")}</div>` : "<p class='muted'>None detected.</p>";
}

function humanizeRole(value) {
  return String(value || "technical-component").replaceAll("-", " ");
}

function transitionLabel(transition) {
  if (!transition) return "Entry point";
  const location = transition.evidence?.range ? `${transition.evidence.file}:${transition.evidence.range.start.line}` : transition.evidence?.file || "parser evidence";
  return `${transition.type} · ${location}`;
}

function verificationStatusLabel(status) {
  return String(status || "unverified").replaceAll("-", " ");
}

function semanticSuggestionSection(lens) {
  const suggestion = lens.semanticSuggestion;
  if (!suggestion) return "";
  if (suggestion.status === "abstained") {
    return `<div class="detail-section semantic-suggestion abstained"><h3>Deterministic semantic suggestion</h3><p><strong>Abstained:</strong> ${escapeHtml(suggestion.abstention.reason)}</p><p class="muted">Missing evidence: ${escapeHtml(suggestion.abstention.missingEvidence.join(", ") || "unspecified")}. No verification fields were changed.</p></div>`;
  }
  const candidate = suggestion.candidate;
  const reasons = suggestion.reasons.map((reason) => `<li>${escapeHtml(reason.message)}</li>`).join("");
  return `<div class="detail-section semantic-suggestion suggested"><h3>Deterministic semantic suggestion</h3><div class="verification-status status-compatible"><strong>${escapeHtml(suggestion.confidence.level)} confidence · ${escapeHtml(suggestion.confidence.score)}</strong><span>${escapeHtml(candidate.title)}</span></div><p>${escapeHtml(candidate.technicalPurpose)}</p><p class="muted">Role: ${escapeHtml(candidate.role)} · grouping: ${escapeHtml(candidate.grouping.label)} · ${escapeHtml(suggestion.evidenceRefs.length)} evidence reference${suggestion.evidenceRefs.length === 1 ? "" : "s"}.</p><ul class="rule-list">${reasons}</ul><p class="muted">This is derived static guidance, not human verification.</p><button id="use-flow-suggestion">Use in verification draft</button></div>`;
}

function agentSemanticProposalSection(lens) {
  const proposal = lens.agentSemanticProposal;
  if (!proposal || proposal.status === "missing") return "";
  if (proposal.status !== "current" || !proposal.record) {
    return `<div class="detail-section agent-semantic-proposal stale"><h3>Agent/provider proposal</h3><div class="verification-status status-stale"><strong>${escapeHtml(proposal.status)}</strong><span>${escapeHtml(proposal.reason || "The proposal is not current.")}</span></div><p class="muted">Stale provider metadata is retained for audit but cannot prefill verification.</p></div>`;
  }
  const record = proposal.record;
  const candidate = record.candidate;
  return `<div class="detail-section agent-semantic-proposal current"><h3>Agent/provider proposal · unverified</h3><div class="verification-status status-compatible"><strong>${escapeHtml(record.provider)}</strong><span>${escapeHtml(candidate.title)}</span></div><p>${escapeHtml(candidate.technicalPurpose)}</p><p class="muted">Proposed by ${escapeHtml(record.proposedBy)} for graph v${escapeHtml(record.project.graphVersion)} · role: ${escapeHtml(candidate.role)} · grouping: ${escapeHtml(candidate.grouping.label)} · risk: ${escapeHtml(candidate.risk)}.</p><p class="muted">${escapeHtml(record.rationale)} This proposal can override a draft only; it cannot override parser facts or create verification.</p><div class="button-row"><button id="use-agent-proposal-review">Review or revise proposal</button><button id="use-agent-proposal-verification">Prepare current verification</button></div></div>`;
}

function traceHistorySection(traces, prefix) {
  if (!traces) return "";
  if (traces.status !== "available") return `<div class="detail-section trace-history"><h3>Agent evidence trace</h3><p class="muted">${escapeHtml(traces.limitation || "Trace metadata is unavailable.")}</p></div>`;
  const records = traces.records || [];
  if (!records.length) return `<div class="detail-section trace-history"><h3>Agent evidence trace</h3><p class="muted">No agent evidence trace is linked to this current Context Ref.</p></div>`;
  const cards = records.map((record) => `<div class="trace-record" data-trace-record data-actor="${escapeHtml(record.actor).toLowerCase()}" data-status="${escapeHtml(record.verification.status).toLowerCase()}" data-paths="${escapeHtml(record.changedPaths.join(" ")).toLowerCase()}"><strong>${escapeHtml(record.action.type)} · ${escapeHtml(record.verification.status)}</strong><span>${escapeHtml(record.action.summary)}</span><small>${escapeHtml(record.actor)} · ${escapeHtml(record.createdAt)} · ${escapeHtml(record.changedPaths.length)} changed path${record.changedPaths.length === 1 ? "" : "s"}</small>${record.changedPaths.length ? `<small>${escapeHtml(record.changedPaths.join(", "))}</small>` : ""}</div>`).join("");
  return `<div class="detail-section trace-history"><h3>Agent evidence trace</h3><p class="muted">Agent-declared metadata only; it is not human verification or test proof.</p><div class="trace-filters"><input id="${prefix}-trace-actor" maxlength="240" placeholder="Filter actor"><select id="${prefix}-trace-status"><option value="">Any verification status</option>${["not-run", "passed", "failed", "partial", "unknown"].map((status) => `<option value="${status}">${status}</option>`).join("")}</select><input id="${prefix}-trace-path" maxlength="240" placeholder="Filter changed path"></div><div id="${prefix}-trace-records" class="trace-records">${cards}</div></div>`;
}

function bindTraceFilters(prefix) {
  const actor = $(`#${prefix}-trace-actor`);
  const status = $(`#${prefix}-trace-status`);
  const changedPath = $(`#${prefix}-trace-path`);
  if (!actor || !status || !changedPath) return;
  const filter = () => {
    const actorQuery = actor.value.trim().toLowerCase();
    const statusQuery = status.value.trim().toLowerCase();
    const pathQuery = changedPath.value.trim().toLowerCase();
    $(`#${prefix}-trace-records`).querySelectorAll("[data-trace-record]").forEach((record) => {
      const visible = (!actorQuery || record.dataset.actor.includes(actorQuery))
        && (!statusQuery || record.dataset.status === statusQuery)
        && (!pathQuery || record.dataset.paths.includes(pathQuery));
      record.hidden = !visible;
    });
  };
  [actor, status, changedPath].forEach((control) => control.addEventListener("input", filter));
  status.addEventListener("change", filter);
}

function semanticFeedbackSection(lens) {
  const feedback = lens.semanticFeedback;
  const suggestion = lens.semanticSuggestion;
  if (!feedback || !suggestion) return "";
  const record = feedback.record;
  const history = (feedback.history || []).map((item) => `<div><strong>${escapeHtml(item.decision)}${item.lifecycleStatus === "superseded" ? " · superseded" : ""}</strong><span>${escapeHtml(item.reviewedBy)} · ${escapeHtml(item.createdAt)}</span>${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ""}</div>`).join("");
  const traceOptions = (lens.agentEvidenceTraces?.records || []).filter((trace) => trace.context.ref === lens.flow.contextRef).map((trace) => `<option value="${escapeHtml(trace.operationId)}">${escapeHtml(trace.action.type)} · ${escapeHtml(trace.verification.status)} · ${escapeHtml(trace.createdAt)}</option>`).join("");
  if (feedback.status === "unavailable") return `<div class="detail-section semantic-feedback"><h3>Semantic suggestion feedback</h3><p class="muted">${escapeHtml(feedback.reason)}</p></div>`;
  const candidate = suggestion.candidate || { title: "", technicalPurpose: "", role: "", grouping: { key: "", label: "" } };
  const decisionOptions = suggestion.status === "abstained"
    ? `<option value="abstained">Confirm abstention</option>`
    : `<option value="accepted">Accept suggestion</option><option value="edited">Edit suggestion</option><option value="rejected">Reject suggestion</option>`;
  return `<div class="detail-section semantic-feedback"><h3>Semantic suggestion feedback</h3><div class="verification-status status-${escapeHtml(feedback.status)}"><strong>${escapeHtml(feedback.status)}</strong><span>${escapeHtml(feedback.reason || "No feedback status reason is available.")}</span></div>${record ? `<p class="muted verification-meta">Latest decision: ${escapeHtml(record.decision)} by ${escapeHtml(record.reviewedBy)} at ${escapeHtml(record.createdAt)}. It is feedback only, not human verification.</p>` : ""}<p class="muted">Saving adds an immutable local review record. It never changes parser facts or creates human verification.</p><label class="field-label" for="semantic-feedback-decision">Decision</label><select id="semantic-feedback-decision">${decisionOptions}</select><label class="field-label" for="semantic-feedback-reason">Reason${suggestion.status === "suggested" ? " (required for edit or reject)" : ""}</label><textarea id="semantic-feedback-reason" maxlength="2000" placeholder="Concise review outcome only; never include source content or private reasoning."></textarea><div id="semantic-feedback-edited-fields" hidden><label class="field-label" for="semantic-feedback-title">Edited title</label><input id="semantic-feedback-title" maxlength="240" value="${escapeHtml(candidate.title)}"><label class="field-label" for="semantic-feedback-purpose">Edited technical purpose</label><textarea id="semantic-feedback-purpose" maxlength="4000">${escapeHtml(candidate.technicalPurpose)}</textarea><label class="field-label" for="semantic-feedback-role">Edited role</label><input id="semantic-feedback-role" maxlength="120" value="${escapeHtml(candidate.role)}"><label class="field-label" for="semantic-feedback-group-key">Edited grouping key</label><input id="semantic-feedback-group-key" maxlength="120" value="${escapeHtml(candidate.grouping.key)}"><label class="field-label" for="semantic-feedback-group-label">Edited grouping label</label><input id="semantic-feedback-group-label" maxlength="240" value="${escapeHtml(candidate.grouping.label)}"></div><label class="field-label" for="semantic-feedback-trace">Optional linked agent trace</label><select id="semantic-feedback-trace"><option value="">No trace link</option>${traceOptions}</select><label class="field-label" for="semantic-feedback-by">Reviewed by</label><input id="semantic-feedback-by" maxlength="240" placeholder="Required reviewer"><button class="save-description" id="save-semantic-feedback">Save feedback</button>${history ? `<h4 class="verification-history-title">Feedback history</h4><div class="verification-history">${history}</div>` : ""}</div>`;
}

function flowVerificationSection(lens) {
  const verification = lens.verification || { status: "unverified", record: null, history: [], reason: "No flow-level human verification record exists." };
  const record = verification.record || {};
  const isReplacement = Boolean(record.id);
  const questions = (record.questions || []).join("\n");
  const history = (verification.history || []).length
    ? `<div class="verification-history">${verification.history.map((item) => `<div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.lifecycleStatus || "active")} · ${escapeHtml(item.verifiedBy)} · graph v${escapeHtml(item.sourceGraphVersion)} · ${escapeHtml(item.verifiedAt)}</small></div>`).join("")}</div>`
    : "";
  return `<div class="detail-section"><h3>Human verification</h3><div class="verification-status status-${escapeHtml(verification.status)}"><strong>${escapeHtml(verificationStatusLabel(verification.status))}</strong><span>${escapeHtml(verification.reason || "No verification status reason is available.")}</span></div>${record.id ? `<p class="muted verification-meta">Verified by ${escapeHtml(record.verifiedBy)} at ${escapeHtml(record.verifiedAt)} against graph v${escapeHtml(record.sourceGraphVersion)}.</p>` : ""}<p class="muted">This local record does not modify parser facts. Saving creates a new immutable record${isReplacement ? " that supersedes the displayed one" : ""}.</p><label class="field-label" for="flow-verification-title">Verified title</label><input id="flow-verification-title" maxlength="240" value="${escapeHtml(record.title || lens.flow.title)}"><label class="field-label" for="flow-verification-description">Verified description</label><textarea id="flow-verification-description" maxlength="4000" placeholder="Describe the confirmed purpose and important constraints...">${escapeHtml(record.description || "")}</textarea><label class="field-label" for="flow-verification-owner">Owner</label><input id="flow-verification-owner" maxlength="240" value="${escapeHtml(record.owner || "")}" placeholder="Optional team or person"><label class="field-label" for="flow-verification-risk">Risk</label><select id="flow-verification-risk">${["unknown", "low", "medium", "high", "critical"].map((risk) => `<option value="${risk}"${(record.risk || "unknown") === risk ? " selected" : ""}>${risk}</option>`).join("")}</select><label class="field-label" for="flow-verification-questions">Unresolved questions</label><textarea id="flow-verification-questions" maxlength="16000" placeholder="One question per line">${escapeHtml(questions)}</textarea><label class="field-label" for="flow-verification-by">Verified by</label><input id="flow-verification-by" maxlength="240" value="${escapeHtml(record.verifiedBy || "")}" placeholder="Required human verifier"><button class="save-description" id="save-flow-verification">${isReplacement ? "Create superseding verification" : "Verify this flow"}</button>${history ? `<h4 class="verification-history-title">Verification history</h4>${history}` : ""}</div>`;
}

function flowInterfaceSection(lens) {
  const contract = lens.flowInterface;
  if (!contract) return "";
  const boundary = contract.boundary;
  const handler = boundary.handler.status === "available" ? boundary.handler.id : boundary.handler.reason;
  const task = boundary.task?.status === "available" ? boundary.task.id : boundary.task?.reason || null;
  const commandLabel = boundary.command?.scriptName ? `npm run ${boundary.command.scriptName}` : null;
  const scheduleLabel = boundary.schedule?.taskName ? `node-cron → ${boundary.schedule.taskName}` : null;
  const boundaryLabel = boundary.method || commandLabel || scheduleLabel || boundary.kind;
  const boundaryDetail = boundary.route || (boundary.command ? `${boundary.command.runner || "runner"} → ${boundary.command.targetPath || "declared target"}` : boundary.schedule ? `${boundary.schedule.expression || "literal schedule"} → ${boundary.schedule.targetPath || "declared task"}` : "Detected flow entry");
  const commandDetail = boundary.command ? `<p class="muted">Manifest: ${escapeHtml(boundary.command.manifest || "unknown")} · declared target: ${escapeHtml(boundary.command.targetPath || "unknown")}</p>` : "";
  const scheduleDetail = boundary.schedule ? `<p class="muted">Adapter: ${escapeHtml(boundary.schedule.adapter || "unknown")} · declared task: ${escapeHtml(boundary.schedule.targetPath || "unknown")}</p>` : "";
  const runs = lens.testRuns?.runs || [];
  const runCards = runs.length ? runs.map((run) => `<div class="trace-record"><strong>${escapeHtml(run.status)} · ${escapeHtml(run.runId)}</strong><span>${escapeHtml(run.status === "running" ? `Current static step: ${run.currentStepId || "between reported steps"}` : run.status === "failed" ? `Stopped at static step: ${run.stoppedAtStepId || "runner-level failure"}` : run.lastEventType)}</span><small>Graph v${escapeHtml(run.graphVersion)} · ${escapeHtml(run.updatedAt)} · ${escapeHtml(run.events.length)} event${run.events.length === 1 ? "" : "s"}</small></div>`).join("") : `<p class="muted">No runner-adapter events are recorded for this flow.</p>`;
  const formatFields = (fields) => fields?.length ? `<ul class="rule-list">${fields.map((field) => `<li><code>${escapeHtml(field.name)}</code>: ${escapeHtml(field.type)}${field.required ? "" : " · optional"}</li>`).join("")}</ul>` : "";
  const requestDetail = contract.request.status === "available"
    ? `<div class="contract-unavailable"><strong>Request payload · parser fact · ${escapeHtml(contract.request.adapter)}</strong>${formatFields(contract.request.fields)}</div>`
    : `<div class="contract-unavailable"><strong>Request payload · ${escapeHtml(contract.request.status)}</strong><span>${escapeHtml(contract.request.reason)}</span></div>`;
  const responseDetail = contract.responses.status === "available"
    ? `<div class="contract-unavailable"><strong>Expected responses · parser fact · ${escapeHtml(contract.responses.adapter)}</strong>${contract.responses.variants.map((variant) => `<p><code>${escapeHtml(variant.status)}</code>${formatFields(variant.fields)}</p>`).join("")}</div>`
    : `<div class="contract-unavailable"><strong>Expected responses · ${escapeHtml(contract.responses.status)}</strong><span>${escapeHtml(contract.responses.reason)}</span></div>`;
  return `<div class="detail-section flow-interface"><h3>Interface contract &amp; QA evidence</h3><div class="verification-status status-compatible"><strong>${escapeHtml(boundaryLabel)}</strong><span>${escapeHtml(boundaryDetail)}</span></div>${commandDetail}${scheduleDetail}<p class="muted">${escapeHtml(boundary.schedule ? "Task target" : "Handler")}: ${escapeHtml(boundary.schedule ? task || "unavailable" : handler)}</p>${requestDetail}${responseDetail}<h4 class="verification-history-title">Test/QA run evidence</h4><div class="trace-records">${runCards}</div><p class="muted">${escapeHtml(contract.execution.limitation)}</p></div>`;
}

async function openDeliveryLedger() {
  const [ledger, workflows] = await Promise.all([request("/api/work-records?limit=50"), request("/api/workflows")]);
  state.selectedId = null;
  state.flowLens = null;
  const rows = ledger.records.map((record) => {
    const window = record.plan.plannedStart || record.plan.plannedEnd
      ? `${record.plan.plannedStart || "Unscheduled"} → ${record.plan.plannedEnd || "Unscheduled"}`
      : "Unscheduled";
    const freshness = record.staleContextCount ? ` · ${record.staleContextCount} stale Context Ref${record.staleContextCount === 1 ? "" : "s"}` : " · Context Refs current";
    return `<li><strong>${escapeHtml(record.title)}</strong><span>${escapeHtml(record.kind)} · plan r${record.planRevision} · ${escapeHtml(window)}</span><span>${record.contextRefs.length} Context Ref${record.contextRefs.length === 1 ? "" : "s"} · ${record.dependencies.length} dependencies${escapeHtml(freshness)}</span></li>`;
  }).join("");
  $("#inspector").innerHTML = `<div class="node-kicker">LOCAL DELIVERY METADATA</div><h2 class="node-title">Work ledger</h2><div class="detail-section first-section"><h3>${ledger.totalMatched} planned records · ${ledger.events.length} recent actual events</h3><p>${escapeHtml(ledger.limitation)}</p></div><div class="detail-section"><h3>Available methods</h3><p>${workflows.workflows.map((workflow) => escapeHtml(workflow.title)).join(" · ") || "No workflow definitions available."}</p></div><div class="detail-section"><h3>Planned work</h3>${rows ? `<ul class="work-ledger-list">${rows}</ul>` : "<p>No local work records yet. Agents and trusted local tools may create evidence-linked records; Flopeek does not infer them from code.</p>"}</div><div class="detail-section"><h3>Actual evidence boundary</h3><p>Actual events are append-only local observations. A workflow state or reference does not prove source execution, CI success, approval authority, or runtime behavior.</p></div>`;
}

function workspaceContractSection(lens) {
  if (!state.workspace) return "";
  const records = (state.workspace.contractReferences?.records || []).filter((record) => (record.source.projectId === lens.project.projectId && record.source.flowId === lens.flow.id) || (record.target.projectId === lens.project.projectId && record.target.flowId === lens.flow.id));
  const cards = records.length
    ? `<div class="trace-records">${records.map((record) => {
      const outgoing = record.source.projectId === lens.project.projectId && record.source.flowId === lens.flow.id;
      const other = outgoing ? record.target : record.source;
      const otherResolution = outgoing ? record.targetResolution : record.sourceResolution;
      return `<div class="trace-record"><strong>${escapeHtml(record.status)} · ${outgoing ? "to" : "from"} ${escapeHtml(other.title)}</strong><span>${escapeHtml(record.summary)}</span><small>${escapeHtml(record.declaredBy)} · ${escapeHtml(record.declaredAt)} · ${escapeHtml(other.projectId)} · ${escapeHtml(otherResolution.status)}</small></div>`;
    }).join("")}</div>`
    : `<p class="muted">No explicit cross-project contract reference is attached to this Flow Lens.</p>`;
  const targets = state.workspace.projects.filter((project) => project.projectId !== lens.project.projectId);
  if (!targets.length) return `<div class="detail-section workspace-contracts"><h3>Cross-project contract references</h3>${cards}<p class="muted">Activate another project in this workspace before declaring a reference.</p></div>`;
  return `<div class="detail-section workspace-contracts"><h3>Cross-project contract references</h3>${cards}<p class="muted">A reference is human-authored and version-bound. It is never inferred as a graph edge or runtime request.</p><label class="field-label" for="workspace-contract-project">Target project</label><select id="workspace-contract-project">${targets.map((project) => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.serviceLabel)} · ${escapeHtml(project.name)}</option>`).join("")}</select><label class="field-label" for="workspace-contract-flow">Target Flow Lens</label><select id="workspace-contract-flow"><option>Loading current target flows…</option></select><p id="workspace-contract-catalog-warning" class="muted"></p><div class="button-row"><button id="workspace-contract-previous-page" disabled>Previous Flow Lens page</button><button id="workspace-contract-next-page" disabled>Next Flow Lens page</button></div><label class="field-label" for="workspace-contract-summary">Declared relationship</label><textarea id="workspace-contract-summary" maxlength="2000" placeholder="Concise human-authored contract relationship; no source, logs, credentials, or machine paths."></textarea><label class="field-label" for="workspace-contract-by">Declared by</label><input id="workspace-contract-by" maxlength="240" placeholder="Required human author"><button id="save-workspace-contract">Declare explicit contract reference</button></div>`;
}

function bindWorkspaceContractSection(inspector, lens) {
  const project = inspector.querySelector("#workspace-contract-project");
  const flow = inspector.querySelector("#workspace-contract-flow");
  if (!project || !flow) return;
  const warning = inspector.querySelector("#workspace-contract-catalog-warning");
  const previous = inspector.querySelector("#workspace-contract-previous-page");
  const next = inspector.querySelector("#workspace-contract-next-page");
  let catalog = null;
  const loadCatalog = async (offset = 0) => {
    flow.disabled = true;
    previous.disabled = true;
    next.disabled = true;
    try {
      catalog = await request(`/api/workspace/contracts/catalog?projectId=${encodeURIComponent(project.value)}&limit=200&offset=${encodeURIComponent(offset)}`);
      flow.innerHTML = catalog.flows.length ? catalog.flows.map((candidate) => `<option value="${escapeHtml(candidate.id)}" data-graph-version="${escapeHtml(candidate.graphVersion)}" data-context-ref="${escapeHtml(candidate.contextRef)}">${escapeHtml(candidate.title)}</option>`).join("") : "<option value=''>No current Flow Lens is available</option>";
      warning.textContent = catalog.warning || `${catalog.returned}/${catalog.total} current Flow Lenses available for explicit selection.`;
      flow.disabled = !catalog.flows.length;
      previous.disabled = catalog.previousOffset === null;
      next.disabled = catalog.nextOffset === null;
    } catch (error) {
      flow.innerHTML = "<option value=''>Target flows unavailable</option>";
      warning.textContent = error.message;
      catalog = null;
    }
  };
  project.addEventListener("change", () => loadCatalog(0).catch((error) => toast(error.message)));
  previous.addEventListener("click", () => {
    if (catalog?.previousOffset !== null) loadCatalog(catalog.previousOffset).catch((error) => toast(error.message));
  });
  next.addEventListener("click", () => {
    if (catalog?.nextOffset !== null) loadCatalog(catalog.nextOffset).catch((error) => toast(error.message));
  });
  inspector.querySelector("#save-workspace-contract")?.addEventListener("click", async () => {
    const selected = flow.selectedOptions[0];
    const summary = inspector.querySelector("#workspace-contract-summary").value.trim();
    const declaredBy = inspector.querySelector("#workspace-contract-by").value.trim();
    if (!selected?.value || !summary || !declaredBy) return toast("Target Flow Lens, relationship, and human author are required.");
    const button = inspector.querySelector("#save-workspace-contract");
    button.disabled = true;
    try {
      const result = await request("/api/workspace/contracts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: `viewer-workspace-contract:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${lens.flow.id}`}`,
          source: { projectId: lens.project.projectId, flowId: lens.flow.id, expectedGraphVersion: lens.project.graphVersion, expectedFlowContextRef: lens.flow.contextRef },
          target: { projectId: project.value, flowId: selected.value, expectedGraphVersion: Number(selected.dataset.graphVersion), expectedFlowContextRef: selected.dataset.contextRef },
          summary,
          declaredBy,
        }),
      });
      state.workspace = result.workspace;
      toast("Explicit cross-project contract reference saved locally.");
      renderFlowLensInspector(lens);
    } catch (error) { toast(`Unable to save contract reference: ${error.message}`); button.disabled = false; }
  });
  loadCatalog().catch((error) => { warning.textContent = error.message; });
}

function collapseInspectorSection(section, { id, title, meta }) {
  if (!section) return null;
  const details = document.createElement("details");
  details.id = id;
  details.className = [...section.classList].filter((name) => name !== "detail-section" && name !== "first-section").concat(["detail-section", "disclosure"]).join(" ");
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  heading.textContent = title;
  const hint = document.createElement("small");
  hint.textContent = meta;
  summary.append(heading, hint);
  const body = document.createElement("div");
  body.className = "disclosure-body";
  while (section.firstChild) body.appendChild(section.firstChild);
  details.append(summary, body);
  section.replaceWith(details);
  return details;
}

function focusedSuggestionSection(lens) {
  const suggestion = lens.semanticSuggestion;
  if (!suggestion) return null;
  const section = document.createElement("section");
  section.className = `flow-understanding semantic-suggestion ${suggestion.status}`;
  if (suggestion.status === "abstained") {
    section.innerHTML = `<div class="section-kicker">Suggested understanding</div><h3>Flopeek abstained</h3><p>${escapeHtml(suggestion.abstention.reason)}</p><p class="muted">Missing evidence: ${escapeHtml(suggestion.abstention.missingEvidence.join(", ") || "unspecified")}. This is an honest limit, not a failed verification.</p><button id="open-semantic-review">Review this abstention</button>`;
    return section;
  }
  const candidate = suggestion.candidate;
  const reasons = suggestion.reasons.map((reason) => `<li>${escapeHtml(reason.message)}</li>`).join("");
  section.innerHTML = `<div class="section-kicker">Suggested understanding</div><div class="suggestion-heading"><h3>${escapeHtml(candidate.title)}</h3><span class="suggestion-confidence">${escapeHtml(suggestion.confidence.level)} confidence</span></div><p class="suggestion-purpose">${escapeHtml(candidate.technicalPurpose)}</p><p class="muted">${escapeHtml(humanizeRole(candidate.role))} &middot; ${escapeHtml(candidate.grouping.label)} &middot; based on ${escapeHtml(suggestion.evidenceRefs.length)} evidence reference${suggestion.evidenceRefs.length === 1 ? "" : "s"}.</p><div class="suggestion-actions"><button id="open-semantic-review">Review suggestion</button><button class="text-button" id="use-flow-suggestion">Use in verification draft</button></div><details class="suggestion-explanation"><summary>Why this suggestion?</summary><ul class="rule-list">${reasons}</ul><p class="muted">Derived static guidance only; it is not human verification.</p></details>`;
  return section;
}

function applyFlowLensFocus(inspector, lens) {
  const technicalSection = inspector.querySelector(".flow-lens-steps")?.closest(".detail-section");
  const contextSection = inspector.querySelector("#copy-flow-context-ref")?.closest(".detail-section");
  const suggestionSection = inspector.querySelector(".semantic-suggestion");
  const feedbackSection = inspector.querySelector(".semantic-feedback");
  const agentProposalSection = inspector.querySelector(".agent-semantic-proposal");
  const traceSection = inspector.querySelector(".trace-history");
  const verificationSection = inspector.querySelector("#save-flow-verification")?.closest(".detail-section");
  const interfaceSection = inspector.querySelector(".flow-interface");
  const workspaceContracts = inspector.querySelector(".workspace-contracts");
  const limitsSection = [...inspector.querySelectorAll(".detail-section")].find((section) => section.querySelector("h3")?.textContent === "Interpretation limits");
  const exportSection = inspector.querySelector("#copy-flow-lens")?.closest(".detail-section");
  inspector.querySelector(".first-section")?.remove();
  const focusedSuggestion = focusedSuggestionSection(lens);
  if (suggestionSection && focusedSuggestion) suggestionSection.replaceWith(focusedSuggestion);
  if (technicalSection && focusedSuggestion) technicalSection.before(focusedSuggestion);
  if (focusedSuggestion && agentProposalSection) focusedSuggestion.after(agentProposalSection);
  if (technicalSection && contextSection) technicalSection.after(contextSection);
  collapseInspectorSection(contextSection, { id: "flow-context-panel", title: "Flow Context Card", meta: "Copy or hand off" });
  const feedback = lens.semanticFeedback;
  collapseInspectorSection(feedbackSection, { id: "semantic-feedback-panel", title: "Review suggestion", meta: feedback?.record ? `${feedback.record.decision} by ${feedback.record.reviewedBy}` : "Optional" });
  const traces = lens.agentEvidenceTraces;
  collapseInspectorSection(traceSection, { id: "flow-audit-panel", title: "Audit trail", meta: traces?.records?.length ? `${traces.records.length} linked trace${traces.records.length === 1 ? "" : "s"}` : "No linked trace" });
  collapseInspectorSection(verificationSection, { id: "flow-verification-panel", title: "Verify flow", meta: lens.verification?.status === "unverified" ? "Advanced · not verified" : verificationStatusLabel(lens.verification?.status) });
  collapseInspectorSection(interfaceSection, { id: "flow-interface-panel", title: "Contract & QA", meta: lens.testRuns?.runs?.length ? `${lens.testRuns.runs.length} recent run${lens.testRuns.runs.length === 1 ? "" : "s"}` : "Payload schema unavailable" });
  collapseInspectorSection(workspaceContracts, { id: "workspace-contract-panel", title: "Cross-project contracts", meta: state.workspace?.contractReferences?.records?.length ? `${state.workspace.contractReferences.records.length} declared` : "None declared" });
  collapseInspectorSection(limitsSection, { id: "flow-limits-panel", title: "Interpretation limits", meta: "Static-analysis scope" });
  collapseInspectorSection(exportSection, { id: "flow-export-panel", title: "Export Flow Lens", meta: "JSON" });
}

function renderFlowLensInspector(lens) {
  const liveFlow = state.liveContexts?.flows?.find((flow) => flow.id === lens.flow.id) || null;
  const changedStepIds = new Set(liveFlow?.changedStepIds || []);
  const boundaries = lens.staticBoundaries.length
    ? `<div class="connection-list">${lens.staticBoundaries.map((boundary) => `<button class="connection-button" data-flow-step="${escapeHtml(boundary.node.id)}"><span>${escapeHtml(boundary.node.label)}</span><span class="connection-kind">${escapeHtml(boundary.category)} boundary</span></button>`).join("")}</div>`
    : "<p class='muted'>No supported static persistence, queue, or external boundary appears in the displayed steps.</p>";
  const steps = lens.steps.map((step) => {
    const alternatives = step.alternativeIncomingTransitions.length ? `<p class="muted">${step.alternativeIncomingTransitions.length} alternative static predecessor${step.alternativeIncomingTransitions.length === 1 ? "" : "s"} retained.</p>` : "";
    const branch = step.branch ? `<p class="muted">Static fan-out: ${step.branch.transitions.length + step.branch.omittedTargets} next step${step.branch.transitions.length + step.branch.omittedTargets === 1 ? "" : "s"}${step.branch.omittedTargets ? `; ${step.branch.omittedTargets} omitted from this lens.` : "."}</p>` : "";
    return `<button class="flow-lens-step" data-flow-step="${escapeHtml(step.id)}"><span class="flow-lens-index">${escapeHtml(step.index)}</span><span><strong>${escapeHtml(step.node.label)}</strong><small>${escapeHtml(humanizeRole(step.role))} · ${escapeHtml(transitionLabel(step.transition))}</small></span></button>${alternatives}${branch}`;
  }).join("");
  const truncation = lens.truncation.displayTruncated || lens.truncation.sourceTraversalMayBeTruncated || lens.truncation.missingTransitionEvidence.length
    ? `<div class="detail-section"><h3>Projection bounds</h3><p>${escapeHtml(`${lens.truncation.displayedSteps}/${lens.truncation.sourceFlowSteps} static steps displayed.`)}${lens.truncation.sourceTraversalMayBeTruncated ? " The source traversal may have reached its maximum bound." : ""}${lens.truncation.missingTransitionEvidence.length ? ` ${lens.truncation.missingTransitionEvidence.length} displayed step${lens.truncation.missingTransitionEvidence.length === 1 ? " has" : "s have"} no adjacent-depth transition evidence.` : ""}</p></div>`
    : "";
  const resolutionNote = state.contextResolution?.requestedRef === lens.flow.contextRef || state.contextResolution?.resolvedRef === lens.flow.contextRef
    ? `<p><strong>Resolution:</strong> ${escapeHtml(state.contextResolution.status)}${state.contextResolution.reason ? ` — ${escapeHtml(state.contextResolution.reason)}` : ""}</p>`
    : "";
  const workspaceContracts = workspaceContractSection(lens);
  state.selectedId = null;
  $("#inspector").innerHTML = `<div class="node-kicker">Flow Lens · ${escapeHtml(lens.flow.entry?.kind || "static-entry")} · derived static evidence</div><h2 class="node-title">${escapeHtml(lens.flow.title)}</h2><div class="node-path">Graph v${escapeHtml(lens.project.graphVersion)} · ${escapeHtml(lens.flow.id)}</div><div class="detail-section first-section"><h3>How to read this flow</h3><p>${escapeHtml(lens.limitations[0])}</p></div><div class="detail-section"><h3>Flow Context Card</h3><p>Portable, versioned static flow evidence for people and agents. It contains no source contents or runtime claims.</p>${resolutionNote}<div class="button-row"><button id="copy-flow-context-ref">Copy reference</button><button id="copy-flow-context-json">Copy JSON</button><button id="copy-flow-context-markdown">Copy Markdown</button></div><div class="node-path">${escapeHtml(lens.flow.contextRef)}</div></div><div class="detail-section"><h3>Technical steps</h3><div class="flow-lens-steps">${steps}</div></div><div class="detail-section"><h3>Static boundaries</h3>${boundaries}</div>${truncation}${semanticSuggestionSection(lens)}${agentSemanticProposalSection(lens)}${semanticFeedbackSection(lens)}${traceHistorySection(lens.agentEvidenceTraces, "flow")}${flowVerificationSection(lens)}${flowInterfaceSection(lens)}${workspaceContracts}<div class="detail-section"><h3>Interpretation limits</h3><ul class="rule-list">${lens.limitations.slice(1).map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></div><div class="detail-section"><button id="copy-flow-lens">Copy Flow Lens JSON</button></div>`;
  const inspector = $("#inspector");
  if (lens.truncation.displayTruncated && lens.truncation.displayedSteps < 24) {
    inspector.querySelector(".flow-lens-steps").closest(".detail-section").insertAdjacentHTML("afterend", `<div class="detail-section"><button id="expand-flow-evidence">Show next evidence steps</button><p class="muted">Expands this bounded static projection to at most 24 steps; source traversal may still be truncated.</p></div>`);
    inspector.querySelector("#expand-flow-evidence").addEventListener("click", () => openFlowLens(lens.flow.id, 24));
  }
  applyFlowLensFocus(inspector, lens);
  bindWorkspaceContractSection(inspector, lens);
  if (liveFlow) {
    const changedCount = changedStepIds.size;
    const stepsSection = inspector.querySelector(".flow-lens-steps").closest(".detail-section");
    stepsSection.insertAdjacentHTML("beforebegin", `<div class="detail-section"><h3>Live graph change</h3><p>${escapeHtml(`v${state.liveContexts.fromGraphVersion} → v${state.liveContexts.toGraphVersion}: ${liveFlow.status} static flow evidence.`)}${changedCount ? ` ${escapeHtml(changedCount)} displayed step${changedCount === 1 ? " is" : "s are"} marked Changed.` : ""} This is an adjacent static delta, not runtime execution evidence.</p>${liveFlow.flowComparisonAvailable ? `<button id="compare-live-flow">Compare before and current Flow Lens</button>` : ""}</div>`);
    inspector.querySelectorAll("[data-flow-step]").forEach((button) => {
      if (!changedStepIds.has(button.dataset.flowStep)) return;
      button.classList.add("changed-step");
      button.setAttribute("aria-label", `${button.textContent.trim()}, changed in the live graph delta`);
      const marker = document.createElement("em");
      marker.textContent = "Changed";
      button.querySelector("strong")?.append(" ", marker);
    });
    inspector.querySelector("#compare-live-flow")?.addEventListener("click", () => openFlowComparison(liveFlow.id, state.liveContexts.fromGraphVersion, state.liveContexts.toGraphVersion));
  }
  inspector.querySelectorAll("[data-flow-step]").forEach((button) => button.addEventListener("click", () => openDependency(button.dataset.flowStep)));
  $("#copy-flow-context-ref").addEventListener("click", async () => {
    await navigator.clipboard.writeText(lens.flow.contextRef);
    toast("Flow Context reference copied.");
  });
  $("#copy-flow-context-json").addEventListener("click", async () => {
    const packet = await request(`/api/flow-context-card?flow=${encodeURIComponent(lens.flow.id)}&scope=${encodeURIComponent(state.scope === "all" ? "all" : "application")}&maxSteps=${encodeURIComponent(lens.truncation.requestedMaxSteps)}`);
    await navigator.clipboard.writeText(JSON.stringify(packet, null, 2));
    toast("Flow Context Card JSON copied.");
  });
  $("#copy-flow-context-markdown").addEventListener("click", async () => {
    const packet = await request(`/api/flow-context-card?flow=${encodeURIComponent(lens.flow.id)}&format=markdown&scope=${encodeURIComponent(state.scope === "all" ? "all" : "application")}&maxSteps=${encodeURIComponent(lens.truncation.requestedMaxSteps)}`);
    await navigator.clipboard.writeText(packet.markdown);
    toast("Flow Context Card Markdown copied.");
  });
  $("#copy-flow-lens").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(lens, null, 2));
    toast("Flow Lens JSON copied.");
  });
  $("#use-flow-suggestion")?.addEventListener("click", () => {
    const candidate = lens.semanticSuggestion?.candidate;
    if (!candidate) return;
    const verificationPanel = $("#flow-verification-panel");
    if (verificationPanel) verificationPanel.open = true;
    $("#flow-verification-title").value = candidate.title;
    $("#flow-verification-description").value = candidate.technicalPurpose;
    $("#flow-verification-title")?.focus();
    toast("Suggestion copied into the unsaved verification draft.");
  });
  $("#open-semantic-review")?.addEventListener("click", () => {
    const feedbackPanel = $("#semantic-feedback-panel");
    if (feedbackPanel) feedbackPanel.open = true;
    $("#semantic-feedback-decision")?.focus();
  });
  const applyAgentProposalToVerification = () => {
    const candidate = lens.agentSemanticProposal?.status === "current" ? lens.agentSemanticProposal.record?.candidate : null;
    if (!candidate) return;
    const verificationPanel = $("#flow-verification-panel");
    if (verificationPanel) verificationPanel.open = true;
    $("#flow-verification-title").value = candidate.title;
    $("#flow-verification-description").value = candidate.technicalPurpose;
    $("#flow-verification-owner").value = candidate.owner || "";
    $("#flow-verification-risk").value = candidate.risk || "unknown";
    $("#flow-verification-questions").value = (candidate.questions || []).join("\n");
    $("#flow-verification-title").focus();
    toast("Current agent proposal copied into an unsaved human verification draft.");
  };
  $("#use-agent-proposal-verification")?.addEventListener("click", applyAgentProposalToVerification);
  $("#use-agent-proposal-review")?.addEventListener("click", () => {
    const candidate = lens.agentSemanticProposal?.status === "current" ? lens.agentSemanticProposal.record?.candidate : null;
    if (!candidate) return;
    const feedbackPanel = $("#semantic-feedback-panel");
    if (feedbackPanel) feedbackPanel.open = true;
    $("#semantic-feedback-decision").value = "edited";
    $("#semantic-feedback-decision").dispatchEvent(new Event("change"));
    $("#semantic-feedback-title").value = candidate.title;
    $("#semantic-feedback-purpose").value = candidate.technicalPurpose;
    $("#semantic-feedback-role").value = candidate.role;
    $("#semantic-feedback-group-key").value = candidate.grouping.key;
    $("#semantic-feedback-group-label").value = candidate.grouping.label;
    $("#semantic-feedback-reason").focus();
    toast("Agent proposal copied into a human-editable review. Saving still requires a reviewer.");
  });
  bindTraceFilters("flow");
  const feedbackDecision = $("#semantic-feedback-decision");
  const editedFeedbackFields = $("#semantic-feedback-edited-fields");
  const updateFeedbackFields = () => { if (editedFeedbackFields) editedFeedbackFields.hidden = feedbackDecision?.value !== "edited"; };
  feedbackDecision?.addEventListener("change", updateFeedbackFields);
  updateFeedbackFields();
  $("#save-semantic-feedback")?.addEventListener("click", async () => {
    const button = $("#save-semantic-feedback");
    button.disabled = true;
    try {
      const decision = feedbackDecision.value;
      const payload = {
        flowId: lens.flow.id,
        scope: state.scope === "all" ? "all" : "application",
        operationId: `viewer-semantic-feedback:${globalThis.crypto?.randomUUID?.() || Date.now()}`,
        decision,
        reason: $("#semantic-feedback-reason").value,
        reviewedBy: $("#semantic-feedback-by").value,
        traceOperationId: $("#semantic-feedback-trace").value || undefined,
      };
      if (decision === "edited") {
        payload.editedCandidate = {
          title: $("#semantic-feedback-title").value,
          technicalPurpose: $("#semantic-feedback-purpose").value,
          role: $("#semantic-feedback-role").value,
          grouping: { key: $("#semantic-feedback-group-key").value, label: $("#semantic-feedback-group-label").value },
        };
      }
      await request("/api/semantic-suggestion-feedbacks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const refreshedLens = await request(`/api/flow-lens?flow=${encodeURIComponent(lens.flow.id)}&scope=${encodeURIComponent(state.scope === "all" ? "all" : "application")}`);
      state.flowLens = refreshedLens;
      renderFlowLensInspector(refreshedLens);
      toast("Semantic suggestion feedback saved locally.");
    } catch (error) {
      toast(`Unable to save semantic feedback: ${error.message}`);
      button.disabled = false;
    }
  });
  $("#save-flow-verification").addEventListener("click", async () => {
    const button = $("#save-flow-verification");
    button.disabled = true;
    try {
      await request("/api/flow-verifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flowId: lens.flow.id,
          scope: state.scope === "all" ? "all" : "application",
          expectedGraphVersion: lens.project.graphVersion,
          expectedFlowContextRef: lens.flow.contextRef,
          title: $("#flow-verification-title").value,
          description: $("#flow-verification-description").value,
          owner: $("#flow-verification-owner").value,
          risk: $("#flow-verification-risk").value,
          questions: $("#flow-verification-questions").value.split("\n").map((value) => value.trim()).filter(Boolean),
          verifiedBy: $("#flow-verification-by").value,
        }),
      });
      const refreshedLens = await request(`/api/flow-lens?flow=${encodeURIComponent(lens.flow.id)}&scope=${encodeURIComponent(state.scope === "all" ? "all" : "application")}`);
      state.flowLens = refreshedLens;
      renderFlowLensInspector(refreshedLens);
      toast("Flow verification saved locally.");
    } catch (error) {
      toast(`Unable to save flow verification: ${error.message}`);
      button.disabled = false;
    }
  });
}

async function renderRawInspector(id) {
  const [{ node, incoming, outgoing, relatedTests, agentEvidenceTraces }, contextPacket] = await Promise.all([
    request(`/api/node?id=${encodeURIComponent(id)}`),
    request(`/api/context-card?id=${encodeURIComponent(id)}`),
  ]);
  const contextCard = contextPacket.card;
  const evidence = node.evidence?.range ? `${node.evidence.file}:${node.evidence.range.start.line}` : node.evidence?.file || node.path || "not available";
  $("#inspector").innerHTML = `<div class="node-kicker">${escapeHtml(node.type)} · ${escapeHtml(node.feature || node.domain)}</div><h2 class="node-title">${escapeHtml(node.label)}</h2>${node.path ? `<div class="node-path">${escapeHtml(node.path)}</div>` : ""}<div class="detail-section first-section"><h3>Detected technical responsibility</h3><p>${escapeHtml(node.detectedResponsibility)}</p></div>${node.methods?.length ? `<div class="detail-section"><h3>Detected methods</h3><div class="method-chips">${node.methods.map((method) => `<span class="method-chip">${escapeHtml(method)}()</span>`).join("")}</div></div>` : ""}<div class="detail-section"><h3>Incoming connections</h3>${connectionList(incoming)}</div><div class="detail-section"><h3>Outgoing connections</h3>${connectionList(outgoing)}</div><div class="detail-section"><h3>Related tests</h3>${connectionList(relatedTests)}</div>${traceHistorySection(agentEvidenceTraces, "node")}<div class="detail-section"><h3>Human-verified description</h3><textarea id="description-input" placeholder="Describe why this component exists, in your own words...">${escapeHtml(node.manualDescription || "")}</textarea><button class="save-description" id="save-description">Save description</button></div><div class="detail-section"><h3>Analysis evidence</h3><p>Parser: ${escapeHtml(node.analysis?.parser || "unknown")}<br>Confidence: ${escapeHtml(node.analysis?.confidence || "unknown")}<br>Source: ${escapeHtml(evidence)}</p></div>`;
  const resolutionNote = state.contextResolution?.requestedRef === contextCard.contextRef || state.contextResolution?.resolvedRef === contextCard.contextRef
    ? `<p><strong>Resolution:</strong> ${escapeHtml(state.contextResolution.status)}${state.contextResolution.reason ? ` — ${escapeHtml(state.contextResolution.reason)}` : ""}</p>`
    : "";
  const contextSection = document.createElement("div");
  contextSection.className = "detail-section";
  contextSection.innerHTML = `<h3>Context Card</h3><p>Static, versioned handoff for people and agents. It does not include source contents or runtime claims.</p>${resolutionNote}<div class="button-row"><button id="copy-context-ref">Copy reference</button><button id="copy-context-json">Copy JSON</button><button id="copy-context-markdown">Copy Markdown</button></div><div class="node-path">${escapeHtml(contextCard.contextRef)}</div>`;
  $("#inspector").querySelector(".first-section").after(contextSection);
  if (node.kind === "file") {
    const conventionSection = document.createElement("div");
    conventionSection.className = "detail-section";
    conventionSection.innerHTML = `<h3>Repeated static conventions</h3><p>Optional exact-token search across same-extension source files. It does not read source into this view or prove UI behavior, runtime wiring, or semantic equivalence.</p><button id="find-related-implementations">Find repeated static conventions</button><div id="related-implementations-results" class="muted" aria-live="polite"></div>`;
    contextSection.after(conventionSection);
    $("#find-related-implementations").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const results = $("#related-implementations-results");
      button.disabled = true;
      results.textContent = "Searching bounded static evidence…";
      try {
        const related = await request(`/api/related-implementations?contextRef=${encodeURIComponent(contextCard.contextRef)}`);
        const entries = related.candidates.length
          ? `<ul>${related.candidates.map((candidate) => `<li><button data-related-implementation="${escapeHtml(candidate.nodeId)}">${escapeHtml(candidate.path)}</button><br><small>${escapeHtml(`${candidate.matchedTokenCount} exact shared tokens: ${candidate.matchedTokens.join(", ")}`)}</small></li>`).join("")}</ul>`
          : "<p>No same-extension file met the two exact-token threshold.</p>";
        results.innerHTML = `${entries}<p class="muted">${escapeHtml(related.limitation)}</p>`;
        results.querySelectorAll("[data-related-implementation]").forEach((candidate) => candidate.addEventListener("click", () => openDependency(candidate.dataset.relatedImplementation)));
      } catch (error) {
        results.textContent = `Unable to find static conventions: ${error.message}`;
      } finally { button.disabled = false; }
    });
  }
  $("#inspector").querySelectorAll("[data-select]").forEach((button) => button.addEventListener("click", () => openDependency(button.dataset.select)));
  bindTraceFilters("node");
  $("#copy-context-ref").addEventListener("click", async () => {
    await navigator.clipboard.writeText(contextCard.contextRef);
    toast("Context reference copied.");
  });
  $("#copy-context-json").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(contextPacket, null, 2));
    toast("Context Card JSON copied.");
  });
  $("#copy-context-markdown").addEventListener("click", async () => {
    const packet = await request(`/api/context-card?id=${encodeURIComponent(id)}&format=markdown`);
    await navigator.clipboard.writeText(packet.markdown);
    toast("Context Card Markdown copied.");
  });
  $("#save-description").addEventListener("click", async () => {
    const description = $("#description-input").value;
    await request("/api/descriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, description }) });
    toast("Description saved to .flopeek.");
  });
}

async function selectNode(id) {
  state.flowComparison = null;
  state.flowLens = null;
  state.selectedId = id;
  highlightNode(id);
  const node = state.graph.nodes.find((candidate) => candidate.id === id);
  if (!node) {
    await renderRawInspector(id);
    return;
  }
  if (node.kind === "summary") renderSummaryInspector(node);
  else await renderRawInspector(id);
}

function evidenceLocation(evidence) {
  if (!evidence?.file) return "Source evidence unavailable";
  const line = evidence.range?.start?.line;
  return `${evidence.file}${line ? `:${line}` : ""}`;
}

function queueCandidate(candidate) {
  if (!candidate) return "No candidate (Flopeek abstained).";
  return `<strong>${escapeHtml(candidate.title)}</strong><span>${escapeHtml(candidate.role)} · ${escapeHtml(candidate.grouping?.label || "ungrouped")}</span>`;
}

function renderSemanticReviewQueue(queue) {
  state.selectedId = null;
  state.flowLens = null;
  state.flowComparison = null;
  const warning = queue.flowCatalog.truncated ? `<p class="verification-status status-stale"><strong>Flow discovery incomplete</strong><span>${escapeHtml(queue.flowCatalog.warning || "Some detected Flow Lenses are omitted.")}</span></p>` : "";
  const items = queue.items.map((item) => {
    const edited = item.feedback.editedCandidate;
    const proposed = item.agentProposal?.status === "current" ? item.agentProposal.candidate : null;
    const compare = edited || proposed ? `<div class="review-compare"><div><strong>Original suggestion</strong>${queueCandidate(item.suggestion.candidate)}</div><div><strong>${edited ? "Human edited" : "Agent/provider proposed"}</strong>${queueCandidate(edited || proposed)}</div></div>` : "";
    const source = item.sourceEvidence;
    const note = item.feedback.reason ? `Review note: ${item.feedback.reason}` : item.agentProposal?.status === "current" ? `${item.agentProposal.provider} proposal by ${item.agentProposal.proposedBy}: ${item.agentProposal.rationale}` : item.suggestion.candidate ? item.suggestion.candidate.technicalPurpose : "No semantic candidate was generated.";
    return `<article class="review-queue-item status-${escapeHtml(item.queueStatus)}"><header><input type="checkbox" data-review-select="${escapeHtml(item.flow.id)}" ${item.queueStatus !== "suggested" ? "disabled" : ""} aria-label="Select ${escapeHtml(item.flow.title)} for batch review"><div><h3>${escapeHtml(item.flow.title)}</h3><small>${escapeHtml(item.suggestion.confidence.level)} confidence · ${escapeHtml(item.suggestion.confidence.score)}</small></div><span>${escapeHtml(item.queueStatus)}</span></header>${compare}<p class="muted">${escapeHtml(note)}</p><div class="review-evidence"><button data-review-flow="${escapeHtml(item.flow.id)}">Review Flow Lens</button>${source.entry ? `<button data-review-evidence="${escapeHtml(source.entry.id)}" title="${escapeHtml(evidenceLocation(source.entry.evidence))}">Open ${escapeHtml(source.entry.kind)} evidence · ${escapeHtml(evidenceLocation(source.entry.evidence))}</button>` : ""}${source.handler ? `<button data-review-evidence="${escapeHtml(source.handler.id)}" title="${escapeHtml(evidenceLocation(source.handler.evidence))}">Open handler evidence · ${escapeHtml(evidenceLocation(source.handler.evidence))}</button>` : ""}</div></article>`;
  }).join("") || "<p class='muted'>No items match this review state.</p>";
  $("#inspector").innerHTML = `<div class="node-kicker">Semantic review queue · local human feedback</div><h2 class="node-title">Review suggestions</h2><div class="detail-section first-section review-queue"><p>${escapeHtml(`${queue.entryCount} detected static entries · ${queue.flowCatalog.total} discoverable Flow Lenses · ${queue.totalMatched} items in this filter.`)}</p>${warning}<p class="muted">Suggestion = deterministic derived label. Agent proposal = unverified override draft. Feedback = reviewer outcome. Verification and runtime behavior remain separate.</p><div class="review-queue-toolbar"><label>Filter <select id="review-queue-filter"><option value="suggested" ${queue.status === "suggested" ? "selected" : ""}>Suggested</option><option value="agent-proposed" ${queue.status === "agent-proposed" ? "selected" : ""}>Agent proposed</option><option value="edited" ${queue.status === "edited" ? "selected" : ""}>Edited</option><option value="rejected" ${queue.status === "rejected" ? "selected" : ""}>Rejected</option><option value="all" ${queue.status === "all" ? "selected" : ""}>All</option></select></label><label>Reviewer for batch accept <input id="review-queue-reviewer" maxlength="240" placeholder="Required for selected suggestions"></label><div class="review-queue-actions"><button id="review-queue-select-all">Select visible suggested</button><button id="review-queue-batch-accept">Accept selected</button></div></div>${items}</div>`;
  $("#review-queue-filter").addEventListener("change", (event) => openSemanticReviewQueue(event.target.value));
  $("#review-queue-select-all").addEventListener("click", () => $("#inspector").querySelectorAll("[data-review-select]:not(:disabled)").forEach((box) => { box.checked = true; }));
  $("#review-queue-batch-accept").addEventListener("click", async () => {
    const flowIds = [...$("#inspector").querySelectorAll("[data-review-select]:checked")].map((box) => box.dataset.reviewSelect);
    const reviewedBy = $("#review-queue-reviewer").value.trim();
    if (!flowIds.length) return toast("Select at least one suggested item.");
    if (!reviewedBy) return toast("Reviewer is required for batch feedback.");
    const button = $("#review-queue-batch-accept");
    button.disabled = true;
    try {
      await request("/api/semantic-suggestion-feedbacks/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: flowIds.map((flowId) => ({ flowId, scope: "application", operationId: `viewer-semantic-feedback-batch:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${flowId}`}`, decision: "accepted", reviewedBy })) }) });
      toast(`${flowIds.length} suggestion${flowIds.length === 1 ? "" : "s"} accepted as local feedback.`);
      await openSemanticReviewQueue(queue.status);
    } catch (error) { toast(`Unable to save batch feedback: ${error.message}`); button.disabled = false; }
  });
  $("#inspector").querySelectorAll("[data-review-flow]").forEach((button) => button.addEventListener("click", () => openFlowLens(button.dataset.reviewFlow)));
  $("#inspector").querySelectorAll("[data-review-evidence]").forEach((button) => button.addEventListener("click", () => openDependency(button.dataset.reviewEvidence)));
}

async function openSemanticReviewQueue(status = "suggested") {
  const queue = await request(`/api/semantic-review-queue?status=${encodeURIComponent(status)}`);
  renderSemanticReviewQueue(queue);
}

async function openFlowLens(flowId, maxSteps = 12) {
  state.flowComparison = null;
  state.flowLens = null;
  state.selectedId = null;
  state.mode = "dependencies";
  const lens = await request(`/api/flow-lens?flow=${encodeURIComponent(flowId)}&scope=${encodeURIComponent(state.scope === "all" ? "all" : "application")}&maxSteps=${encodeURIComponent(maxSteps)}`);
  state.focusId = lens.flow.entryId;
  state.flowLens = lens;
  await loadView();
  renderFlowLensInspector(lens);
}

function comparisonStepClass(stepId, side, changes) {
  if (side === "before" && changes.removedStepIds.includes(stepId)) return "removed";
  if (side === "current" && changes.addedStepIds.includes(stepId)) return "added";
  if (changes.transitionChangedStepIds.includes(stepId) || changes.nodeMetadataChangedStepIds.includes(stepId) || changes.movedStepIds.includes(stepId)) return "changed";
  if (changes.sourceChangedStepIds.includes(stepId)) return "source-changed";
  return "unchanged";
}

function comparisonStepLabel(stepId, side, changes) {
  if (side === "before" && changes.removedStepIds.includes(stepId)) return "Removed";
  if (side === "current" && changes.addedStepIds.includes(stepId)) return "Added";
  if (changes.transitionChangedStepIds.includes(stepId)) return "Static transition changed";
  if (changes.nodeMetadataChangedStepIds.includes(stepId)) return "Static metadata changed";
  if (changes.movedStepIds.includes(stepId)) return "Static position changed";
  if (changes.sourceChangedStepIds.includes(stepId)) return "Source changed";
  return "Unchanged";
}

function comparisonColumn(snapshot, side, changes) {
  if (!snapshot) return `<p class="muted">This flow was not present in this graph version.</p>`;
  const steps = snapshot.steps.map((step) => {
    const status = comparisonStepLabel(step.id, side, changes);
    const className = comparisonStepClass(step.id, side, changes);
    const content = `<span class="flow-lens-index">${escapeHtml(step.index)}</span><span><strong>${escapeHtml(step.node.label)}</strong><small>${escapeHtml(humanizeRole(step.role))} · ${escapeHtml(status)}</small></span>`;
    return side === "current"
      ? `<button class="comparison-step ${className}" data-comparison-current-step="${escapeHtml(step.id)}">${content}</button>`
      : `<div class="comparison-step ${className}" aria-label="Historical snapshot, ${escapeHtml(status)}">${content}</div>`;
  }).join("");
  const bounds = snapshot.truncation.displayTruncated || snapshot.truncation.sourceTraversalMayBeTruncated
    ? `<p class="muted">${escapeHtml(`${snapshot.truncation.displayedSteps}/${snapshot.truncation.sourceFlowSteps} static steps displayed.`)}</p>`
    : "";
  return `<div class="flow-comparison-steps">${steps}</div>${bounds}`;
}

function renderFlowComparisonInspector(result) {
  const comparison = result.comparison;
  if (!result.available || !comparison) {
    $("#inspector").innerHTML = `<div class="node-kicker">Flow comparison</div><h2 class="node-title">Comparison unavailable</h2><div class="detail-section first-section"><p>${escapeHtml(result.limitation)}</p></div>`;
    return;
  }
  const { changes } = comparison;
  const summary = [
    `${changes.addedStepIds.length} added`,
    `${changes.removedStepIds.length} removed`,
    `${changes.transitionChangedStepIds.length} transition changed`,
    `${changes.sourceChangedStepIds.length} source changed`,
  ].join(" · ");
  state.selectedId = null;
  state.flowLens = null;
  $("#inspector").innerHTML = `<div class="node-kicker">Flow comparison · bounded static evidence</div><h2 class="node-title">${escapeHtml(comparison.flow.title)}</h2><div class="node-path">v${escapeHtml(result.fromGraphVersion)} → v${escapeHtml(result.toGraphVersion)} · ${escapeHtml(comparison.flow.id)}</div><div class="detail-section first-section"><h3>How to read this comparison</h3><p>${escapeHtml(result.limitation)}</p><p class="muted">${escapeHtml(summary)}. ${changes.sourceChangedOnly ? "Only source evidence changed; the bounded static structure did not." : "Changes are derived from adjacent static graph snapshots."}</p></div><div class="flow-comparison-grid"><section class="flow-comparison-column"><h3>Before · v${escapeHtml(result.fromGraphVersion)}</h3>${comparisonColumn(comparison.before, "before", changes)}</section><section class="flow-comparison-column"><h3>Current · v${escapeHtml(result.toGraphVersion)}</h3>${comparisonColumn(comparison.current, "current", changes)}</section></div><div class="detail-section"><h3>Evidence boundary</h3><p>Current steps are interactive and open their current raw node evidence. The before side is a retained historical snapshot and is intentionally not resolved as a current node.</p></div><div class="detail-section"><div class="button-row">${comparison.current ? `<button id="open-current-flow">Open current Flow Lens</button>` : ""}<button id="copy-flow-comparison">Copy comparison JSON</button></div></div>`;
  const inspector = $("#inspector");
  inspector.querySelectorAll("[data-comparison-current-step]").forEach((button) => button.addEventListener("click", () => openDependency(button.dataset.comparisonCurrentStep)));
  inspector.querySelector("#open-current-flow")?.addEventListener("click", () => openFlowLens(comparison.flow.id));
  inspector.querySelector("#copy-flow-comparison").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    toast("Flow comparison JSON copied.");
  });
}

async function openFlowComparison(flowId, fromVersion, toVersion) {
  state.flowLens = null;
  state.selectedId = null;
  const comparison = await request(`/api/flow-comparison?flow=${encodeURIComponent(flowId)}&fromVersion=${encodeURIComponent(fromVersion)}&toVersion=${encodeURIComponent(toVersion)}`);
  if (!comparison.available) {
    toast(comparison.limitation);
    return;
  }
  state.flowComparison = comparison;
  renderFlowComparisonInspector(comparison);
}

async function openDependency(id) {
  state.flowComparison = null;
  state.flowLens = null;
  state.focusId = id;
  state.selectedId = id;
  state.mode = "dependencies";
  await loadView();
  await selectNode(id);
}

function renderSearchResults(results) {
  const container = $("#search-results");
  container.innerHTML = results.length ? results.map((node) => `<button class="search-result" data-result="${escapeHtml(node.id)}"><span>${escapeHtml(node.label)}</span><span>${escapeHtml(node.type)}</span></button>`).join("") : "";
  container.querySelectorAll("[data-result]").forEach((button) => button.addEventListener("click", () => openDependency(button.dataset.result)));
}

async function searchNodes() {
  const query = $("#search").value.trim();
  if (!query) { renderSearchResults([]); return; }
  const payload = await request(`/api/search?${new URLSearchParams({ q: query, scope: state.scope }).toString()}`);
  renderSearchResults(payload.results);
}

async function resolveContextFromInput() {
  const contextRef = $("#context-ref-input").value.trim();
  if (!contextRef) {
    $("#context-ref-status").textContent = "Paste a Flopeek Context Ref to resolve it.";
    return;
  }
  const resolution = await request(`/api/context/resolve?ref=${encodeURIComponent(contextRef)}`);
  state.contextResolution = resolution;
  $("#context-ref-status").textContent = `${resolution.status}: ${resolution.reason || "Context matches the current graph."}`;
  if ((resolution.status === "current" || resolution.status === "stale") && resolution.card?.node?.id) {
    await openDependency(resolution.card.node.id);
    toast(resolution.status === "stale" ? "Older Context Ref resolved to current evidence." : "Context Ref resolved.");
    return;
  }
  if ((resolution.status === "current" || resolution.status === "stale") && resolution.card?.flow?.id) {
    await openFlowLens(resolution.card.flow.id);
    toast(resolution.status === "stale" ? "Older Flow Context Ref resolved to current evidence." : "Flow Context Ref resolved.");
    return;
  }
  if (resolution.status === "successor-candidate") {
    toast("A successor candidate was found but was not opened automatically.");
    return;
  }
  toast(`Context Ref ${resolution.status}.`);
}

$("#scan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const requestedRoot = $("#root-input").value.trim();
  const checkingCandidate = Boolean(!state.workspace && requestedRoot && requestedRoot !== state.graph?.project?.root);
  try {
    if (checkingCandidate) {
      setCandidateRepositoryCheck(requestedRoot);
      $("#status").textContent = "Checking the new repository. The current map remains active until the check succeeds.";
    } else {
      $("#status").textContent = "Scanning repository...";
    }
    if (state.workspace) {
      await request("/api/workspace/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: requestedRoot }) });
      window.location.reload();
      return;
    }
    await request("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: requestedRoot }) });
    setCandidateRepositoryCheck(null);
    state.mode = "overview"; state.scope = "application"; state.focusId = null; state.selectedId = null; state.flowLens = null; state.benchmark = null; state.initialFlowOpened = false;
    await loadView(); toast(checkingCandidate ? "New repository map is active." : "Current repository graph generated.");
  } catch (error) {
    setCandidateRepositoryCheck(null);
    $("#status").textContent = "";
    if (error.payload?.scanOutcome) {
      state.scanOutcome = error.payload.scanOutcome;
      renderScanOutcome(state.scanOutcome);
      await loadView().catch(() => {});
    }
    toast(error.message);
  }
});
$("#cancel-scan").addEventListener("click", async () => {
  try {
    const result = await request("/api/scan/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    toast(result.accepted ? "Cancellation requested. The last complete graph will remain active." : "No cancellable bounded scan is running.");
  } catch (error) {
    toast(error.message);
  }
});

$("#workspace-project-select").addEventListener("change", async (event) => {
  try {
    event.target.disabled = true;
    await request("/api/workspace/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: event.target.value }) });
    window.location.reload();
  } catch (error) {
    event.target.disabled = false;
    toast(`Unable to switch project: ${error.message}`);
  }
});

$("#search").addEventListener("input", () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => searchNodes().catch((error) => toast(error.message)), 160); });
$("#resolve-context-ref").addEventListener("click", () => resolveContextFromInput().catch((error) => { $("#context-ref-status").textContent = error.message; toast(error.message); }));
$("#context-ref-input").addEventListener("keydown", (event) => { if (event.key === "Enter") resolveContextFromInput().catch((error) => { $("#context-ref-status").textContent = error.message; toast(error.message); }); });
$("#mode-filter").addEventListener("change", async (event) => { state.mode = event.target.value; state.selectedId = null; state.flowLens = null; if (state.mode !== "dependencies") state.focusId = null; await loadView(); });
$("#scope-filter").addEventListener("change", async (event) => { state.scope = event.target.value; state.selectedId = null; state.flowLens = null; await loadView(); });
$("#level-filter").addEventListener("change", async (event) => { state.level = event.target.value; state.focusId = null; state.selectedId = null; state.flowLens = null; if (state.mode === "dependencies") state.mode = "overview"; await loadView(); });
$("#continue-mode").addEventListener("change", (event) => {
  state.continueMode = event.target.checked;
  state.selectedPlannedNodeId = null;
  if (!state.continueMode) state.plannedOverlayId = null;
  renderContinueControls();
  renderGraph();
  if (!state.continueMode) openProjectHome().catch((error) => toast(error.message));
});
$("#planned-overlay-filter").addEventListener("change", (event) => {
  state.plannedOverlayId = event.target.value || null;
  state.selectedPlannedNodeId = null;
  renderContinueControls();
  renderGraph();
  const overlay = selectedPlannedOverlay();
  if (overlay) toast(`Showing planned overlay ${overlay.id}.`);
});
$("#clear-focus").addEventListener("click", async () => { state.focusId = null; state.selectedId = null; state.flowLens = null; state.mode = "overview"; await loadView(); });
$("#open-review-queue").addEventListener("click", () => openSemanticReviewQueue().catch((error) => toast(error.message)));
$("#open-primary-flow").addEventListener("click", () => {
  const firstFlow = state.graph?.flows?.[0];
  if (!firstFlow) {
    toast("No supported static Flow Lens is available in this graph version.");
    return;
  }
  openFlowLens(firstFlow.id).catch((error) => toast(error.message));
});
$("#open-project-home").addEventListener("click", () => openProjectHome().catch((error) => toast(error.message)));
$("#open-product-proof").addEventListener("click", () => openProductProof().catch((error) => toast(error.message)));
$("#open-delivery-ledger").addEventListener("click", () => openDeliveryLedger().catch((error) => toast(error.message)));
$("#fit-graph").addEventListener("click", () => { if (state.cy) state.cy.fit(undefined, 42); });
$("#renderer-mode").addEventListener("change", (event) => { state.renderer = event.target.value; renderGraph(); });
$("#measure-renderer").addEventListener("click", () => measureRendererPair().catch((error) => toast(`Renderer measurement failed: ${error.message}`)));
$("#run-benchmark").addEventListener("click", () => runBenchmark());
$("#export-mermaid").addEventListener("click", async () => { const { mermaid } = await request("/api/export/mermaid"); const blob = new Blob([mermaid], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "project-flow.mmd"; link.click(); URL.revokeObjectURL(link.href); });

loadWorkspace().then(loadView).then(applyInitialViewerRoute).then(connectLiveUpdates).catch((error) => { $("#status").textContent = error.message; });
