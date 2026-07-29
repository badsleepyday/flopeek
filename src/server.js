const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { assignWorkflow, availableGraphDelta, createContinuationCheckpoint, createPlannedOverlay, createWorkRecord, exportHandoffWorkspace, findNodes, getAgentBootstrap, getAgentEvidenceTraces, getAgentSemanticProposal, getArtifactCacheAudit, getCacheHygiene, getChangeImpact, getChangedContexts, getCheckpointDivergence, getContextCard, getContinuationCheckpoint, getContinuationComparison, getContinuationContext, getDurableBrief, getEntryFlows, getFlowComparison, getFlowProjection, getFlowSuggestion, getFlowVerification, getFlowVerificationHistory, getGraphDelta, getHandoffContext, getHandoffQuality, getHandoffWorkspace, getNodeDetails, getPlanReconciliation, getPlannedOverlay, getProductProof, getProjectHome, getRelatedImplementations, getRuntimeEvidence, getSemanticReviewQueue, getSemanticSuggestionFeedback, getTestRuns, getTrustAnalytics, getVerifiedSemanticMemory, getWorkDependencyStatus, getWorkRecordWorkflow, getWorkTimeline, importHandoffWorkspace, latestAvailableGraphDelta, listContinuationCheckpoints, listDurableBriefManifests, listHandoffWorkspaces, listImportedHandoffs, listPlanReconciliations, listPlannedOverlays, listSemanticSuggestionFeedback, listWorkRecords, listWorkflows, materializeDurableBrief, projectView, recordAgentEvidenceTrace, recordAgentSemanticProposal, recordPlanReconciliation, recordRuntimeEvidence, recordSemanticSuggestionFeedback, recordTestRunEvent, recordWorkEvent, resolveContextRef, resolvePlanRef, saveHandoffNote, saveHandoffWorkspace, saveWorkflow, transitionWorkRecord, updateWorkPlan, verifyFlow } = require("./graph-service");
const { listWorkDependencyStatuses } = require("./graph-service");
const { getActiveBranchGitEvidence, getGitContextContinuity } = require("./graph-service");
const { benchmarkRepository } = require("./benchmark");
const { compareGitSnapshots, createGitSnapshot } = require("./history");
const { graphToMermaid, saveDescription } = require("./scanner");
const { readGraphCacheResult, summarizeCacheResult } = require("./graph-cache");
const { createScanCoordinator } = require("./scan-coordinator");
const { listServeWorkspace, registerServeWorkspace, unregisterServeWorkspace } = require("./serve-workspace");
const { parseFlowLensMaxStepsQuery } = require("./flow-lens-options");
const { createSurfaceCoreRuntime } = require("./core-runtime");

const PUBLIC_DIRECTORY = path.join(__dirname, "..", "public");
const VENDOR_ASSETS = new Map([
  ["/vendor/cytoscape.min.js", path.join(__dirname, "..", "node_modules", "cytoscape", "dist", "cytoscape.min.js")],
  ["/vendor/cytoscape-dagre.js", path.join(__dirname, "..", "node_modules", "cytoscape-dagre", "dist", "cytoscape-dagre.js")],
]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const MAX_REQUEST_BODY_BYTES = 1_000_000;
const WATCH_IGNORED_DIRECTORIES = new Set([".flopeek", ".flowpeek", ".git", ".next", ".nuxt", ".project-flow", ".turbo", "build", "coverage", "dist", "node_modules", "out", "target", "vendor"]);
function send(response, statusCode, body, contentType = "application/json; charset=utf-8") {
  response.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      reject(requestError(413, "Request body is too large."));
      return;
    }
    const chunks = [];
    let length = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_REQUEST_BODY_BYTES) return fail(requestError(413, "Request body is too large."));
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = body ? JSON.parse(body) : {};
        settled = true;
        resolve(parsed);
      } catch {
        fail(requestError(400, "Request body must be JSON."));
      }
    });
    request.on("error", fail);
  });
}

function staticFilePath(urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.split("/").filter(Boolean).join(path.sep);
  const filePath = path.resolve(PUBLIC_DIRECTORY, relative);
  const relativeToPublic = path.relative(PUBLIC_DIRECTORY, filePath);
  return !relativeToPublic.startsWith("..") && !path.isAbsolute(relativeToPublic) ? filePath : null;
}

function isTrustedMutation(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && Number(url.port) === request.socket.localPort;
  } catch {
    return false;
  }
}

function shouldRefreshForChange(filename) {
  if (!filename) return true;
  const normalized = String(filename).replaceAll("\\", "/");
  if (normalized === ".flopeek/config.json") return true;
  return !normalized.split("/").some((segment) => WATCH_IGNORED_DIRECTORIES.has(segment));
}

function watchRepository(root, onChange, fileSystem = fs) {
  const configPath = path.join(root, ".flopeek", "config.json");
  const onConfigChange = (current, previous) => {
    if (!current?.nlink && !previous?.nlink) return;
    onChange(".flopeek/config.json");
  };
  fileSystem.watchFile(configPath, { interval: 200, persistent: false }, onConfigChange);
  let watcher = null;
  try {
    watcher = fileSystem.watch(root, { recursive: true }, (_eventType, filename) => {
      const changedPath = filename ? String(filename) : null;
      if (shouldRefreshForChange(changedPath)) onChange(changedPath);
    });
    watcher.on("error", () => {});
  } catch {}
  return () => {
    watcher?.close();
    fileSystem.unwatchFile(configPath, onConfigChange);
  };
}

function writeSse(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function listenOnAvailablePort(server, requestedPort, options = {}) {
  if (requestedPort === 0) {
    await listenOnce(server, 0);
    return { requestedPort, port: server.address().port, fallback: false, attempts: 1 };
  }
  const allowFallback = options.portFallback !== false;
  const retryableBindErrors = new Set(["EADDRINUSE", "EACCES"]);
  const maximumAttempts = allowFallback ? Math.max(1, Math.min(Number(options.portSearchLimit) || 100, 1000)) : 1;
  for (let offset = 0; offset < maximumAttempts && requestedPort + offset <= 65535; offset += 1) {
    const port = requestedPort + offset;
    try {
      await listenOnce(server, port);
      return { requestedPort, port, fallback: port !== requestedPort, attempts: offset + 1 };
    } catch (error) {
      if (!allowFallback || !retryableBindErrors.has(error?.code) || offset + 1 >= maximumAttempts || port >= 65535) throw error;
    }
  }
  throw new Error(`No available loopback port was found from ${requestedPort}.`);
}

async function startServer(options) {
  let root = fs.realpathSync(options.root);
  const ownsCoreClient = !options.coreClient;
  const runtime = options.coreClient ? null : createSurfaceCoreRuntime(options);
  const core = options.coreClient || runtime.core;
  let closeCorePromise = null;
  const closeOwnedCore = () => {
    if (!ownsCoreClient) return Promise.resolve();
    if (!closeCorePromise) closeCorePromise = Promise.resolve(core.close?.());
    return closeCorePromise;
  };
  let coordinator = null;
  let graph = null;
  let previousGraph = null;
  let closeWatcher = () => {};
  let refreshTimer = null;
  let refreshInProgress = false;
  let refreshQueued = false;
  let pendingChangedPaths = new Set();
  let requiresReconciliation = false;
  let serveWorkspaceRegistration = null;
  let portBinding = null;
  const eventStreams = new Set();
  const broadcast = (event, payload) => {
    for (const response of eventStreams) {
      if (response.writableEnded) eventStreams.delete(response);
      else writeSse(response, event, payload);
    }
  };
  const createCoordinator = (targetRoot = root, coordinatorOptions = {}) => createScanCoordinator(targetRoot, {
    coreClient: coordinatorOptions.coreClient || core,
    coreRuntime: coordinatorOptions.coreRuntime || runtime?.selection || options.coreRuntime,
    cache: options.cache,
    timeBudgetMs: options.timeBudgetMs,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    analysisDelayMs: options.analysisDelayMs,
    packagePath: options.packagePath,
    onProgress: coordinatorOptions.broadcastProgress === false ? undefined : ({ phase, outcome: currentOutcome }) => {
      broadcast("scan-status", { phase, ...currentOutcome });
    },
  });
  coordinator = createCoordinator();
  const elapsedMilliseconds = (startedAt) => Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const broadcastGraphUpdate = async (reason, refreshStartedAt = null) => {
    const contextStartedAt = process.hrtime.bigint();
    const delta = previousGraph
      ? graph.analysis.latestDelta || getGraphDelta(previousGraph, graph, { limit: 20 })
      : getGraphDelta(null, graph, { limit: 20 });
    const changedContexts = delta.schemaVersion
      ? await core.getChangedContexts(graph, { fromVersion: delta.fromGraphVersion, toVersion: delta.toGraphVersion })
      : null;
    const changedContextMs = elapsedMilliseconds(contextStartedAt);
    const previousNodeIds = new Set(previousGraph?.nodes?.map((node) => node.id));
    const addedFiles = previousGraph
      ? graph.nodes
        .filter((node) => node.kind === "file" && !previousNodeIds.has(node.id))
        .sort((left, right) => left.path.localeCompare(right.path))
      : [];
    const visibleAddedFiles = addedFiles.slice(0, 100).map((node) => ({ id: node.id, label: node.label, path: node.path, type: node.type }));
    broadcast("graph", {
      generatedAt: graph.generatedAt,
      project: graph.project,
      graphState: graph.state,
      reason,
      stats: graph.stats,
      addedFileIds: visibleAddedFiles.map((node) => node.id),
      addedFiles: visibleAddedFiles,
      addedFileCount: addedFiles.length,
      addedFilesTruncated: addedFiles.length > visibleAddedFiles.length,
      delta: delta.summary || (delta.available ? delta.summary : null),
      deltaIdentity: delta.schemaVersion ? { fromGraphVersion: delta.fromGraphVersion, toGraphVersion: delta.toGraphVersion, sourceChanged: delta.sourceChanged, topologyChanged: delta.topologyChanged } : null,
      changedContexts,
      timing: refreshStartedAt ? { refreshToAffectedContextMs: elapsedMilliseconds(refreshStartedAt), changedContextProjectionMs: changedContextMs } : null,
    });
  };
  const refresh = async (reason = null, changedPaths = null) => {
    const refreshStartedAt = process.hrtime.bigint();
    const result = await coordinator.refresh(changedPaths, reason || "scan");
    previousGraph = result.previousGraph;
    graph = result.graph;
    if (!graph) {
      const failure = result.outcome.failure?.message || result.outcome.reason || "No complete graph is available.";
      throw new Error(`Flopeek scan ${result.outcome.status}: ${failure}`);
    }
    if (reason && result.outcome.status === "complete") await broadcastGraphUpdate(reason, refreshStartedAt);
    return graph;
  };
  const scanFailureMessage = (currentOutcome) => {
    const detail = currentOutcome.failure?.message || currentOutcome.reason || "The current source was not promoted.";
    return `Flopeek scan ${currentOutcome.status}: ${detail}`;
  };
  const sendManualScanResult = async (response, changedPaths = null) => {
    const refreshedGraph = await refresh("manual", changedPaths);
    const currentOutcome = coordinator.currentOutcome();
    if (currentOutcome.status !== "complete") {
      return send(response, 409, {
        error: scanFailureMessage(currentOutcome),
        scanOutcome: currentOutcome,
        activeGraph: currentOutcome.activeGraph,
      });
    }
    return send(response, 200, refreshedGraph);
  };
  const currentGraph = () => {
    if (!graph) throw new Error("No complete Flopeek graph is available.");
    return graph;
  };
  const scheduleRefresh = (changedPath = null) => {
    if (changedPath) pendingChangedPaths.add(changedPath);
    else requiresReconciliation = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (refreshInProgress) {
        refreshQueued = true;
        return;
      }
      refreshInProgress = true;
      const changedPaths = requiresReconciliation ? null : [...pendingChangedPaths];
      pendingChangedPaths = new Set();
      requiresReconciliation = false;
      try {
        await refresh("filesystem", changedPaths);
        if (coordinator.currentOutcome().failure?.code === "repository-changed-during-analysis") refreshQueued = true;
      } catch (error) {
        if (error?.code === "FLOPEEK_SCAN_IN_PROGRESS") refreshQueued = true;
        broadcast("graph-error", { message: error.message || "Unable to refresh graph." });
      } finally {
        refreshInProgress = false;
        if (refreshQueued) {
          refreshQueued = false;
          scheduleRefresh();
        }
      }
    }, 220);
  };
  const startWatching = () => {
    closeWatcher();
    closeWatcher = watchRepository(root, scheduleRefresh);
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return send(response, 200, {
          ok: true,
          instanceId: serveWorkspaceRegistration?.record.instanceId || null,
          workspaceId: serveWorkspaceRegistration?.record.workspaceId || null,
          projectId: graph?.project?.projectId || null,
          port: server.address()?.port || null,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/serve-workspace") {
        if (!serveWorkspaceRegistration) return send(response, 503, { error: "Serve workspace registration is unavailable." });
        return send(response, 200, listServeWorkspace(serveWorkspaceRegistration.record.workspaceId, { registryRoot: options.registryRoot }));
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        response.flushHeaders?.();
        eventStreams.add(response);
        const current = graph;
        writeSse(response, "ready", {
          generatedAt: current?.generatedAt || new Date().toISOString(),
          project: current?.project || null,
          graphState: current?.state || null,
          scanOutcome: coordinator.currentOutcome(),
        });
        request.on("close", () => eventStreams.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/scan-status") return send(response, 200, coordinator.currentOutcome());
      if (request.method === "GET" && url.pathname === "/api/graph") return send(response, 200, currentGraph());
      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        const current = currentGraph();
        return send(response, 200, { ...current.analysis, cacheState: summarizeCacheResult(readGraphCacheResult(root, { expectedProjectId: current.project.projectId })) });
      }
      if (request.method === "GET" && url.pathname === "/api/cache") {
        return send(response, 200, summarizeCacheResult(readGraphCacheResult(root, { expectedProjectId: currentGraph().project.projectId })));
      }
      if (request.method === "GET" && url.pathname === "/api/cache-artifacts") return send(response, 200, getArtifactCacheAudit(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/cache-hygiene") return send(response, 200, getCacheHygiene(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/trust-analytics") return send(response, 200, getTrustAnalytics(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/product-proof") return send(response, 200, getProductProof(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/project-home") return send(response, 200, getProjectHome(currentGraph(), { concept: url.searchParams.get("concept") }));
      if (request.method === "GET" && url.pathname === "/api/delta") {
        const from = url.searchParams.get("fromVersion");
        const to = url.searchParams.get("toVersion");
        const current = currentGraph();
        const delta = from !== null && to !== null
          ? availableGraphDelta(current, Number(from), Number(to))
          : latestAvailableGraphDelta(current);
        return delta ? send(response, 200, delta) : send(response, 404, { error: "No matching graph delta was found." });
      }
      if (request.method === "GET" && url.pathname === "/api/changed-contexts") {
        return send(response, 200, await core.getChangedContexts(currentGraph(), { fromVersion: url.searchParams.get("fromVersion"), toVersion: url.searchParams.get("toVersion") }));
      }
      if (request.method === "GET" && url.pathname === "/api/related-implementations") {
        const contextRef = url.searchParams.get("contextRef");
        if (!contextRef) throw requestError(400, "A contextRef query parameter is required.");
        return send(response, 200, getRelatedImplementations(currentGraph(), contextRef));
      }
      if (request.method === "GET" && url.pathname === "/api/flow-comparison") {
        const flowId = url.searchParams.get("flow");
        if (!flowId) throw requestError(400, "A flow query parameter is required.");
        return send(response, 200, getFlowComparison(currentGraph(), flowId, { fromVersion: url.searchParams.get("fromVersion"), toVersion: url.searchParams.get("toVersion") }));
      }
      if (request.method === "GET" && url.pathname === "/api/view") return send(response, 200, await core.getProjectOverview(currentGraph(), url.searchParams));
      if (request.method === "GET" && url.pathname === "/api/agent-bootstrap") return send(response, 200, await core.getScanStatus(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/agent-context") return send(response, 200, (await core.getProjectOverview(currentGraph(), url.searchParams)).aiContext);
      if (request.method === "POST" && url.pathname === "/api/handoff-context") {
        const body = await readBody(request);
        return send(response, 200, getHandoffContext(currentGraph(), body));
      }
      if (request.method === "POST" && url.pathname === "/api/handoff-quality") {
        const body = await readBody(request);
        return send(response, 200, getHandoffQuality(currentGraph(), body));
      }
      if (request.method === "GET" && url.pathname === "/api/runtime-evidence") return send(response, 200, getRuntimeEvidence(currentGraph(), { limit: Number(url.searchParams.get("limit") || 30) }));
      if (request.method === "GET" && url.pathname === "/api/test-runs") return send(response, 200, getTestRuns(currentGraph(), { flowId: url.searchParams.get("flowId"), status: url.searchParams.get("status"), limit: url.searchParams.get("limit") }));
      if (request.method === "GET" && url.pathname === "/api/workflows") return send(response, 200, listWorkflows(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/work-records") return send(response, 200, listWorkRecords(currentGraph(), { limit: url.searchParams.get("limit") }));
      if (request.method === "GET" && url.pathname === "/api/work-timeline") return send(response, 200, getWorkTimeline(currentGraph(), url.searchParams.get("recordId") || null));
      if (request.method === "GET" && url.pathname === "/api/work-dependency-status") {
        const recordId = url.searchParams.get("recordId");
        if (!recordId) throw requestError(400, "recordId is required.");
        return send(response, 200, getWorkDependencyStatus(currentGraph(), recordId));
      }
      if (request.method === "GET" && url.pathname === "/api/work-dependency-statuses") return send(response, 200, listWorkDependencyStatuses(currentGraph(), { limit: url.searchParams.get("limit") }));
      if (request.method === "GET" && url.pathname === "/api/continuation-checkpoints") return send(response, 200, listContinuationCheckpoints(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/continuation-checkpoint") {
        const checkpointId = url.searchParams.get("id");
        if (!checkpointId) throw requestError(400, "id is required.");
        return send(response, 200, getContinuationCheckpoint(currentGraph(), checkpointId));
      }
      if (request.method === "GET" && url.pathname === "/api/continuation-comparison") {
        const checkpointId = url.searchParams.get("checkpointId");
        const overlayId = url.searchParams.get("overlayId");
        return send(response, 200, getContinuationComparison(currentGraph(), { checkpointId, overlayId }));
      }
      if (request.method === "GET" && url.pathname === "/api/checkpoint-divergence") {
        const checkpointId = url.searchParams.get("checkpointId");
        if (!checkpointId) throw requestError(400, "checkpointId is required.");
        return send(response, 200, getCheckpointDivergence(currentGraph(), checkpointId));
      }
      if (request.method === "GET" && url.pathname === "/api/continuation-context") {
        const checkpointId = url.searchParams.get("checkpointId");
        if (!checkpointId) throw requestError(400, "checkpointId is required.");
        return send(response, 200, getContinuationContext(currentGraph(), { checkpointId, overlayId: url.searchParams.get("overlayId"), tokenBudget: url.searchParams.has("tokenBudget") ? Number(url.searchParams.get("tokenBudget")) : undefined }));
      }
      if (request.method === "GET" && url.pathname === "/api/planned-overlays") return send(response, 200, listPlannedOverlays(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/planned-overlay") {
        const overlayId = url.searchParams.get("id");
        if (!overlayId) throw requestError(400, "id is required.");
        return send(response, 200, getPlannedOverlay(currentGraph(), overlayId));
      }
      if (request.method === "GET" && url.pathname === "/api/plan/resolve") {
        const planRef = url.searchParams.get("ref");
        if (!planRef) throw requestError(400, "ref is required.");
        return send(response, 200, resolvePlanRef(currentGraph(), planRef));
      }
      if (request.method === "GET" && url.pathname === "/api/plan-reconciliations") return send(response, 200, listPlanReconciliations(currentGraph(), { planRef: url.searchParams.get("planRef") || null }));
      if (request.method === "GET" && url.pathname === "/api/plan-reconciliation") {
        const reconciliationId = url.searchParams.get("id");
        if (!reconciliationId) throw requestError(400, "id is required.");
        return send(response, 200, getPlanReconciliation(currentGraph(), reconciliationId));
      }
      if (request.method === "GET" && url.pathname === "/api/work-record-workflow") {
        const recordId = url.searchParams.get("recordId");
        if (!recordId) throw requestError(400, "recordId is required.");
        return send(response, 200, getWorkRecordWorkflow(currentGraph(), recordId));
      }
      if (request.method === "POST" && url.pathname === "/api/work-records") {
        if (!isTrustedMutation(request)) throw requestError(403, "Work-record writes must come from a trusted local client.");
        const result = createWorkRecord(currentGraph(), await readBody(request));
        broadcast("work-record", { recordId: result.record.id, eventType: result.event.eventType, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/work-plans") {
        if (!isTrustedMutation(request)) throw requestError(403, "Work-plan writes must come from a trusted local client.");
        const result = updateWorkPlan(currentGraph(), await readBody(request));
        broadcast("work-record", { recordId: result.record.id, eventType: result.event.eventType, updated: result.updated });
        return send(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/work-events") {
        if (!isTrustedMutation(request)) throw requestError(403, "Work-event writes must come from a trusted local client.");
        const result = recordWorkEvent(currentGraph(), await readBody(request));
        broadcast("work-event", { recordId: result.event.recordId, eventType: result.event.eventType, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/continuation-checkpoints") {
        if (!isTrustedMutation(request)) throw requestError(403, "Continuation checkpoint writes must come from a trusted local client.");
        const result = createContinuationCheckpoint(currentGraph(), await readBody(request));
        broadcast("continuation-checkpoint", { checkpointId: result.checkpoint.id, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/planned-overlays") {
        if (!isTrustedMutation(request)) throw requestError(403, "Planned-overlay writes must come from a trusted local client.");
        const result = createPlannedOverlay(currentGraph(), await readBody(request));
        broadcast("planned-overlay", { overlayId: result.overlay.id, checkpointId: result.overlay.checkpointId, overlayVersion: result.overlay.overlayVersion, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/plan-reconciliations") {
        if (!isTrustedMutation(request)) throw requestError(403, "Plan-reconciliation writes must come from a trusted local client.");
        const result = recordPlanReconciliation(currentGraph(), await readBody(request));
        broadcast("plan-reconciliation", { reconciliationId: result.reconciliation.id, planRef: result.reconciliation.planRef, outcome: result.reconciliation.outcome, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/workflows") {
        if (!isTrustedMutation(request)) throw requestError(403, "Workflow writes must come from a trusted local client.");
        const result = saveWorkflow(currentGraph(), await readBody(request));
        broadcast("workflow", { workflowId: result.workflow.id, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/workflow-assignments") {
        if (!isTrustedMutation(request)) throw requestError(403, "Workflow assignments must come from a trusted local client.");
        const result = assignWorkflow(currentGraph(), await readBody(request));
        broadcast("workflow", { recordId: result.event.recordId, workflowId: result.workflow.id, state: result.state, assigned: result.assigned });
        return send(response, result.assigned ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/workflow-transitions") {
        if (!isTrustedMutation(request)) throw requestError(403, "Workflow transitions must come from a trusted local client.");
        const result = transitionWorkRecord(currentGraph(), await readBody(request));
        broadcast("workflow", { recordId: result.event.recordId, workflowId: result.workflow.id, state: result.toState, transitioned: result.transitioned });
        return send(response, result.transitioned ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/runtime-evidence") {
        if (!isTrustedMutation(request)) throw requestError(403, "Runtime evidence writes must come from the local Flopeek viewer or trusted local caller.");
        return send(response, 201, recordRuntimeEvidence(currentGraph(), await readBody(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/test-run-events") {
        if (!isTrustedMutation(request)) throw requestError(403, "Test-run events must come from a trusted local runner adapter.");
        const body = await readBody(request);
        if (typeof body.flowId !== "string" || !body.flowId) return send(response, 400, { error: "flowId is required." });
        const result = recordTestRunEvent(currentGraph(), body.flowId, body, body.scope || "application");
        if (!result) return send(response, 404, { error: "Detected flow not found in the selected scope." });
        broadcast("test-run-event", { runId: result.run.runId, flowId: body.flowId, status: result.run.status, currentStepId: result.run.currentStepId, stoppedAtStepId: result.run.stoppedAtStepId });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/handoff-workspace") return send(response, 200, getHandoffWorkspace(currentGraph(), url.searchParams.get("workspaceId")));
      if (request.method === "GET" && url.pathname === "/api/handoff-workspaces") return send(response, 200, listHandoffWorkspaces(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/handoff-export") return send(response, 200, exportHandoffWorkspace(currentGraph(), { workspaceId: url.searchParams.get("workspaceId"), format: url.searchParams.get("format") || "json" }));
      if (request.method === "GET" && url.pathname === "/api/handoff-imports") return send(response, 200, listImportedHandoffs(currentGraph()));
      if (request.method === "GET" && url.pathname === "/api/agent-evidence-traces") {
        return send(response, 200, getAgentEvidenceTraces(currentGraph(), {
          contextRef: url.searchParams.get("contextRef"),
          contextId: url.searchParams.get("contextId"),
          operationId: url.searchParams.get("operationId"),
          limit: url.searchParams.get("limit") || undefined,
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/semantic-suggestion-feedback") {
        const feedback = getSemanticSuggestionFeedback(currentGraph(), url.searchParams.get("flow"), url.searchParams.get("scope") || "application");
        return feedback ? send(response, 200, feedback) : send(response, 404, { error: "Detected flow not found in the selected scope." });
      }
      if (request.method === "GET" && url.pathname === "/api/agent-semantic-proposal") {
        const proposal = getAgentSemanticProposal(currentGraph(), url.searchParams.get("flow"), url.searchParams.get("scope") || "application");
        return proposal ? send(response, 200, proposal) : send(response, 404, { error: "Detected flow not found in the selected scope." });
      }
      if (request.method === "GET" && url.pathname === "/api/semantic-suggestion-feedbacks") {
        return send(response, 200, listSemanticSuggestionFeedback(currentGraph(), {
          flowId: url.searchParams.get("flowId"),
          contextRef: url.searchParams.get("contextRef"),
          decision: url.searchParams.get("decision"),
          traceOperationId: url.searchParams.get("traceOperationId"),
          limit: url.searchParams.get("limit") || undefined,
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/semantic-review-queue") return send(response, 200, getSemanticReviewQueue(currentGraph(), { status: url.searchParams.get("status") || "suggested" }));
      if (request.method === "GET" && url.pathname === "/api/brief") return send(response, 200, getDurableBrief(currentGraph(), url.searchParams.get("kind") || "project", url.searchParams.get("id"), url.searchParams.get("format") || "json"));
      if (request.method === "GET" && url.pathname === "/api/brief-manifests") return send(response, 200, listDurableBriefManifests(currentGraph(), { kind: url.searchParams.get("kind"), contextId: url.searchParams.get("contextId") }));
      if (request.method === "GET" && url.pathname === "/api/search") return send(response, 200, await core.findNodes(currentGraph(), url.searchParams));
      if (request.method === "GET" && url.pathname === "/api/project") return send(response, 200, currentGraph().project);
      if (request.method === "GET" && url.pathname === "/api/flows") return send(response, 200, currentGraph().flows);
      if (request.method === "GET" && url.pathname === "/api/entry-flows") return send(response, 200, await core.getEntryFlows(currentGraph(), url.searchParams.get("query") || "", url.searchParams.get("scope") || "application"));
      if (request.method === "GET" && url.pathname === "/api/flow-lens") {
        const requestedMaxSteps = parseFlowLensMaxStepsQuery(url.searchParams.get("maxSteps"));
        const lens = await core.getFlowProjection(currentGraph(), url.searchParams.get("flow"), url.searchParams.get("scope") || "application", { maxSteps: requestedMaxSteps });
        return lens ? send(response, 200, lens) : send(response, 404, { error: "Detected flow not found in the selected scope." });
      }
      if (request.method === "GET" && url.pathname === "/api/flow-suggestion") {
        const suggestion = getFlowSuggestion(currentGraph(), url.searchParams.get("flow"), url.searchParams.get("scope") || "application");
        return suggestion ? send(response, 200, suggestion) : send(response, 404, { error: "Detected flow not found in the selected scope." });
      }
      if (request.method === "GET" && url.pathname === "/api/flow-context-card") {
        const requestedMaxSteps = parseFlowLensMaxStepsQuery(url.searchParams.get("maxSteps"));
        const card = await core.getFlowContextCard(currentGraph(), url.searchParams.get("flow"), url.searchParams.get("format") || "json", url.searchParams.get("scope") || "application", { maxSteps: requestedMaxSteps });
        return card ? send(response, 200, card) : send(response, 404, { error: "Detected flow not found in the selected scope." });
      }
      if (request.method === "GET" && url.pathname === "/api/flow-verification") {
        const verification = getFlowVerification(currentGraph(), url.searchParams.get("flow"), url.searchParams.get("scope") || "application");
        return verification ? send(response, 200, verification) : send(response, 404, { error: "Detected flow not found in the selected scope." });
      }
      if (request.method === "GET" && url.pathname === "/api/flow-verification-history") {
        const flowId = url.searchParams.get("flow");
        if (!flowId) throw requestError(400, "A flow query parameter is required.");
        return send(response, 200, getFlowVerificationHistory(currentGraph(), flowId));
      }
      if (request.method === "GET" && url.pathname === "/api/semantic-memory") {
        return send(response, 200, getVerifiedSemanticMemory(currentGraph(), { query: url.searchParams.get("query"), limit: url.searchParams.get("limit"), includeStale: url.searchParams.get("includeStale") }));
      }
      if (request.method === "POST" && url.pathname === "/api/benchmark") {
        if (!isTrustedMutation(request)) throw requestError(403, "Benchmark requests must come from the local Flopeek viewer.");
        const body = await readBody(request);
        const iterations = body.iterations === undefined ? 3 : Number(body.iterations);
        return send(response, 200, benchmarkRepository(root, { iterations }));
      }
      if (request.method === "POST" && url.pathname === "/api/product-proof") {
        if (!isTrustedMutation(request)) throw requestError(403, "Product proof benchmark requests must come from the local Flopeek viewer.");
        const body = await readBody(request);
        const iterations = body.iterations === undefined ? 3 : Number(body.iterations);
        return send(response, 200, getProductProof(currentGraph(), { localBenchmark: benchmarkRepository(root, { iterations }) }));
      }
      if (request.method === "GET" && url.pathname === "/api/history") return send(response, 200, compareGitSnapshots(root, { from: url.searchParams.get("from") || "HEAD~1", to: url.searchParams.get("to") || "HEAD" }));
      if (request.method === "GET" && url.pathname === "/api/active-branch-git-evidence") {
        const contextRef = url.searchParams.get("contextRef");
        if (!contextRef) throw requestError(400, "A contextRef query parameter is required.");
        return send(response, 200, getActiveBranchGitEvidence(currentGraph(), contextRef, { limit: url.searchParams.get("limit") }));
      }
      if (request.method === "GET" && url.pathname === "/api/git-context-continuity") {
        const contextRef = url.searchParams.get("contextRef");
        if (!contextRef) throw requestError(400, "A contextRef query parameter is required.");
        return send(response, 200, getGitContextContinuity(currentGraph(), contextRef, { from: url.searchParams.get("from") || "HEAD~1", to: url.searchParams.get("to") || "HEAD" }));
      }
      if (request.method === "GET" && url.pathname === "/api/impact") return send(response, 200, await core.getChangeImpact(currentGraph(), url.searchParams.getAll("path"), { maxDepth: url.searchParams.get("maxDepth"), previousGraph }));
      if (request.method === "GET" && url.pathname === "/api/export/mermaid") return send(response, 200, { mermaid: graphToMermaid(currentGraph()) });
      if (request.method === "GET" && url.pathname === "/api/context-card") {
        const card = await core.getContextCard(currentGraph(), url.searchParams.get("id"), url.searchParams.get("format") || "json");
        return card ? send(response, 200, card) : send(response, 404, { error: "Node not found." });
      }
      if (request.method === "GET" && url.pathname === "/api/context/resolve") {
        return send(response, 200, await core.resolveContextRef(currentGraph(), url.searchParams.get("ref")));
      }
      if (request.method === "GET" && url.pathname === "/api/node") {
        const detail = await core.getNode(currentGraph(), url.searchParams.get("id"));
        return detail ? send(response, 200, detail) : send(response, 404, { error: "Node not found." });
      }
      if (request.method === "POST" && url.pathname === "/api/scan") {
        if (!isTrustedMutation(request)) throw requestError(403, "Mutating requests must come from the local Flopeek viewer.");
        const body = await readBody(request);
        if (body.root) {
          if (coordinator.isRunning()) throw requestError(409, "Wait for or cancel the active bounded scan before switching repositories.");
          const requestedRoot = fs.realpathSync(String(body.root));
          if (!fs.statSync(requestedRoot).isDirectory()) throw new Error("Scan target must be a directory.");
          if (requestedRoot === root) return sendManualScanResult(response);
          const candidateCoordinator = createCoordinator(requestedRoot, { broadcastProgress: false });
          const candidate = await candidateCoordinator.refresh(null, "manual-root-switch");
          if (candidate.outcome.status !== "complete" || !candidate.graph) {
            return send(response, 409, {
              error: `Repository switch was not applied. ${scanFailureMessage(candidate.outcome)}`,
              scanOutcome: candidate.outcome,
              activeGraph: coordinator.currentOutcome().activeGraph,
            });
          }
          root = requestedRoot;
          coordinator = candidateCoordinator;
          graph = candidate.graph;
          previousGraph = null;
          pendingChangedPaths = new Set();
          requiresReconciliation = false;
          startWatching();
          if (serveWorkspaceRegistration) {
            serveWorkspaceRegistration = registerServeWorkspace(graph, {
              workspaceId: options.workspaceId,
              serviceLabel: options.serviceLabel,
              port: server.address().port,
              registryRoot: options.registryRoot,
              instanceId: serveWorkspaceRegistration.record.instanceId,
              startedAt: serveWorkspaceRegistration.record.startedAt,
            });
          }
          broadcast("scan-status", { phase: "terminal", ...coordinator.currentOutcome() });
          await broadcastGraphUpdate("manual-root-switch");
          return send(response, 200, graph);
        }
        return sendManualScanResult(response);
      }
      if (request.method === "POST" && url.pathname === "/api/scan/cancel") {
        if (!isTrustedMutation(request)) throw requestError(403, "Scan cancellation must come from the local Flopeek viewer or trusted local caller.");
        const result = coordinator.cancel();
        return send(response, result.accepted ? 202 : 409, result);
      }
      if (request.method === "POST" && url.pathname === "/api/snapshots") {
        if (!isTrustedMutation(request)) throw requestError(403, "Mutating requests must come from the local Flopeek viewer.");
        const body = await readBody(request);
        const result = createGitSnapshot(root, { ref: typeof body.ref === "string" ? body.ref : "HEAD", force: body.force === true });
        return send(response, 200, { created: result.created, path: result.path, commit: result.snapshot.commit, stats: result.snapshot.graph.stats });
      }
      if (request.method === "POST" && url.pathname === "/api/flow-verifications") {
        if (!isTrustedMutation(request)) throw requestError(403, "Mutating requests must come from the local Flopeek viewer.");
        const body = await readBody(request);
        if (typeof body.flowId !== "string" || !body.flowId) return send(response, 400, { error: "flowId is required." });
        if (!Number.isSafeInteger(body.expectedGraphVersion) || typeof body.expectedFlowContextRef !== "string" || !body.expectedFlowContextRef) return send(response, 400, { error: "expectedGraphVersion and expectedFlowContextRef are required to verify the latest reviewed state." });
        const verification = verifyFlow(currentGraph(), body.flowId, body, body.scope || "application");
        if (!verification) return send(response, 404, { error: "Detected flow not found in the selected scope." });
        broadcast("flow-verification", { flowId: body.flowId, verification });
        return send(response, 201, verification);
      }
      if (request.method === "POST" && url.pathname === "/api/agent-evidence-traces") {
        if (!isTrustedMutation(request)) throw requestError(403, "Agent evidence trace requests must come from a trusted local client.");
        const body = await readBody(request);
        const result = recordAgentEvidenceTrace(currentGraph(), body);
        broadcast("agent-evidence-trace", { id: result.record.id, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/semantic-suggestion-feedbacks") {
        if (!isTrustedMutation(request)) throw requestError(403, "Semantic suggestion feedback requests must come from a trusted local client.");
        const body = await readBody(request);
        if (typeof body.flowId !== "string" || !body.flowId) return send(response, 400, { error: "flowId is required." });
        const result = recordSemanticSuggestionFeedback(currentGraph(), body.flowId, body, body.scope || "application");
        if (!result) return send(response, 404, { error: "Detected flow not found in the selected scope." });
        broadcast("semantic-suggestion-feedback", { flowId: body.flowId, id: result.record.id, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/agent-semantic-proposals") {
        if (!isTrustedMutation(request)) throw requestError(403, "Agent semantic proposals must come from a trusted local client.");
        const body = await readBody(request);
        if (typeof body.flowId !== "string" || !body.flowId) return send(response, 400, { error: "flowId is required." });
        const result = recordAgentSemanticProposal(currentGraph(), body.flowId, body, body.scope || "application");
        if (!result) return send(response, 404, { error: "Detected flow not found in the selected scope." });
        broadcast("agent-semantic-proposal", { flowId: body.flowId, id: result.record.id, created: result.created });
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/semantic-suggestion-feedbacks/batch") {
        if (!isTrustedMutation(request)) throw requestError(403, "Semantic suggestion feedback requests must come from a trusted local client.");
        const body = await readBody(request);
        if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) return send(response, 400, { error: "items must contain between 1 and 100 review inputs." });
        const results = body.items.map((item) => {
          if (!item || typeof item.flowId !== "string" || !item.flowId) throw requestError(400, "Each batch item requires flowId.");
          const result = recordSemanticSuggestionFeedback(currentGraph(), item.flowId, item, item.scope || "application");
          if (!result) throw requestError(404, `Detected flow not found: ${item.flowId}`);
          return result;
        });
        broadcast("semantic-suggestion-feedback-batch", { count: results.length, flowIds: body.items.map((item) => item.flowId) });
        return send(response, 201, { schemaVersion: "flopeek-semantic-suggestion-feedback-batch-result/v1", results, limitation: "Batch feedback appends one immutable local human-feedback record per item. It does not create human verification." });
      }
      if (request.method === "POST" && url.pathname === "/api/briefs/materialize") {
        if (!isTrustedMutation(request)) throw requestError(403, "Brief materialization requests must come from a trusted local client.");
        const body = await readBody(request);
        if (typeof body.kind !== "string" || !body.kind) return send(response, 400, { error: "kind is required." });
        const result = materializeDurableBrief(currentGraph(), body.kind, body.id || null);
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/handoff-workspaces") {
        if (!isTrustedMutation(request)) throw requestError(403, "Handoff workspace writes must come from a trusted local client.");
        const result = saveHandoffWorkspace(currentGraph(), await readBody(request));
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/handoff-notes") {
        if (!isTrustedMutation(request)) throw requestError(403, "Handoff note writes must come from a trusted local client.");
        const result = saveHandoffNote(currentGraph(), await readBody(request));
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/handoff-imports") {
        if (!isTrustedMutation(request)) throw requestError(403, "Handoff imports must come from a trusted local client.");
        const body = await readBody(request);
        const result = importHandoffWorkspace(currentGraph(), body.packet || body);
        return send(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/descriptions") {
        if (!isTrustedMutation(request)) throw requestError(403, "Mutating requests must come from the local Flopeek viewer.");
        const body = await readBody(request);
        if (typeof body.id !== "string" || typeof body.description !== "string") return send(response, 400, { error: "id and description are required." });
        const activeGraph = currentGraph();
        const node = activeGraph.nodes.find((candidate) => candidate.id === body.id);
        if (!node) return send(response, 404, { error: "Node not found." });
        saveDescription(root, body.id, body.description);
        const refreshed = await refresh("description", []);
        const refreshedNode = refreshed.nodes.find((candidate) => candidate.id === body.id);
        return send(response, 200, { node: refreshedNode, graphState: refreshed.state, delta: refreshed.analysis.latestDelta || null });
      }
      if (request.method === "GET" && VENDOR_ASSETS.has(url.pathname)) {
        return send(response, 200, fs.readFileSync(VENDOR_ASSETS.get(url.pathname)), "text/javascript; charset=utf-8");
      }
      if (request.method === "GET") {
        const filePath = staticFilePath(url.pathname);
        if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(response, 404, "Not found", "text/plain; charset=utf-8");
        return send(response, 200, fs.readFileSync(filePath), MIME_TYPES[path.extname(filePath)] || "application/octet-stream");
      }
      return send(response, 405, { error: "Method not allowed." });
    } catch (error) {
      return send(response, error.statusCode || 400, { error: error.message || "Unexpected server error." });
    }
  });

  server.on("close", () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    closeWatcher();
    for (const response of eventStreams) response.end();
    eventStreams.clear();
    if (serveWorkspaceRegistration) unregisterServeWorkspace(serveWorkspaceRegistration.record.instanceId, { registryRoot: options.registryRoot });
    closeOwnedCore().catch(() => {});
  });

  portBinding = await listenOnAvailablePort(server, options.port, options);
  try {
    await refresh();
    if (options.registerServeWorkspace !== false) {
      serveWorkspaceRegistration = registerServeWorkspace(graph, {
        workspaceId: options.workspaceId,
        serviceLabel: options.serviceLabel,
        port: server.address().port,
        registryRoot: options.registryRoot,
      });
    }
    startWatching();
    await new Promise((resolve) => setImmediate(resolve));
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await closeOwnedCore();
    throw error;
  }
  return {
    server,
    root,
    port: server.address().port,
    getGraph: () => currentGraph(),
    getScanOutcome: () => coordinator.currentOutcome(),
    cancelScan: () => coordinator.cancel(),
    portBinding,
    project: graph.project,
    serveWorkspace: serveWorkspaceRegistration?.workspace || null,
    serveInstance: serveWorkspaceRegistration?.record || null,
    close: async () => {
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await closeOwnedCore();
    },
  };
}

module.exports = { findNodes, listenOnAvailablePort, projectView, startServer, watchRepository };
