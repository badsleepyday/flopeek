"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { invalidateArtifactCache } = require("./artifact-cache");
const { scanRepositoryBounded } = require("./bounded-scan");
const { readGraphCacheResult, summarizeCacheResult } = require("./graph-cache");
const { resolveProjectIdentity } = require("./project-identity");
const { readGitMetadata } = require("./git-metadata");
const { createRepositoryScanner, writeGraphCache } = require("./scanner");
const { readRepositoryScope } = require("./scope");
const { advanceSessionGraph } = require("./session-graph-state");

const SCAN_OUTCOME_SCHEMA = "flowpeek-scan-outcome/v1";

function hasBounds(options) {
  return options.timeBudgetMs !== null && options.timeBudgetMs !== undefined
    || options.maxFiles !== null && options.maxFiles !== undefined
    || options.maxBytes !== null && options.maxBytes !== undefined;
}

function hasPackageScope(options) {
  return typeof options.packagePath === "string" && Boolean(options.packagePath.trim());
}

function disabledCacheState(root, reason = "cache-disabled") {
  return {
    status: "disabled",
    reason,
    path: path.join(root, ".flowpeek", "graph.json"),
    diagnostics: [],
    contract: null,
    migrated: false,
    graphVersion: null,
    state: null,
    delta: null,
  };
}

function attachedHeadFreshness(graph, root) {
  if (!graph?.state?.sourceRevision) return { status: "unavailable", reason: "scanned-source-revision-unavailable", scannedRevision: null, attachedHeadRevision: null };
  const git = readGitMetadata(root);
  if (git.availability !== "available" || !git.revision) {
    return { status: "unavailable", reason: git.reason || "attached-head-unavailable", scannedRevision: graph.state.sourceRevision, attachedHeadRevision: null };
  }
  return graph.state.sourceRevision === git.revision
    ? { status: "matched", reason: "scanned-source-revision-matches-attached-head", scannedRevision: graph.state.sourceRevision, attachedHeadRevision: git.revision }
    : { status: "mismatched", reason: "scanned-source-revision-differs-from-attached-head", scannedRevision: graph.state.sourceRevision, attachedHeadRevision: git.revision };
}

function graphIdentity(graph, source, freshness, root) {
  return graph ? {
    available: true,
    source,
    freshness,
    projectId: graph.project.projectId,
    graphVersion: graph.state.graphVersion,
    sourceFingerprint: graph.state.sourceFingerprint,
    scopedSourceFreshness: {
      status: freshness,
      reason: freshness === "current" ? "complete-scan-covers-the-configured-source-scope" : freshness === "stale-unverified" ? "active-graph-is-a-last-complete-fallback" : "no-complete-source-graph-available",
    },
    attachedHeadFreshness: attachedHeadFreshness(graph, root),
  } : {
    available: false,
    source: "none",
    freshness: "unavailable",
    projectId: null,
    graphVersion: null,
    sourceFingerprint: null,
    scopedSourceFreshness: { status: "unavailable", reason: "no-complete-source-graph-available" },
    attachedHeadFreshness: { status: "unavailable", reason: "no-complete-source-graph-available", scannedRevision: null, attachedHeadRevision: null },
  };
}

function discoverySummary(result) {
  const discovery = result?.discovery;
  if (!discovery) return null;
  return {
    schemaVersion: discovery.schemaVersion,
    status: discovery.status,
    reasons: discovery.reasons,
    limits: discovery.limits,
    durationMs: discovery.durationMs,
    inventory: discovery.inventory,
    decision: discovery.decision,
    selection: discovery.selection,
  };
}

function createScanCoordinator(inputRoot, options = {}) {
  const root = require("node:fs").realpathSync(inputRoot);
  const packageScoped = hasPackageScope(options);
  const cacheEnabled = options.cache !== false && !packageScoped;
  const bounded = hasBounds(options) || packageScoped;
  const sessionProjectId = cacheEnabled ? null : `session:${randomUUID()}`;
  let scanner = bounded ? null : createRepositoryScanner(root, {
    persistIdentity: cacheEnabled,
    sessionProjectId,
  });
  let graph = null;
  let previousGraph = null;
  let activeController = null;
  let outcome = {
    schemaVersion: SCAN_OUTCOME_SCHEMA,
    operationId: null,
    status: "idle",
    reason: null,
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    mode: bounded ? "bounded-full-analysis" : "incremental-session",
    bounds: {
      timeBudgetMs: options.timeBudgetMs ?? null,
      maxFiles: options.maxFiles ?? null,
      maxBytes: options.maxBytes ?? null,
      packagePath: packageScoped ? options.packagePath.trim() : null,
    },
    discovery: null,
    activeGraph: graphIdentity(null, "none", "unavailable", root),
    cachePromotion: { allowed: false, performed: false },
    limitations: [],
  };

  const publish = (phase, current) => {
    outcome = current;
    if (graph?.analysis) graph.analysis.scanOutcome = outcome;
    if (typeof options.onProgress === "function") options.onProgress({ phase, outcome });
  };

  const fallbackGraph = () => {
    if (graph) return { graph, source: "last-complete-memory" };
    if (!cacheEnabled) return { graph: null, source: "none" };
    const configuredProjectId = readRepositoryScope(root).projectId;
    const expectedProjectId = resolveProjectIdentity(root, configuredProjectId, { persist: false }).projectId;
    const cached = readGraphCacheResult(root, { expectedProjectId });
    return cached.status === "valid"
      ? { graph: cached.graph, source: "last-complete-cache" }
      : { graph: null, source: "none" };
  };

  const finalize = (operationId, startedAt, status, reason, active, details = {}) => {
    const completedAt = new Date().toISOString();
    outcome = {
      schemaVersion: SCAN_OUTCOME_SCHEMA,
      operationId,
      status,
      reason: reason || null,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      mode: bounded ? "bounded-full-analysis" : "incremental-session",
      bounds: {
        timeBudgetMs: options.timeBudgetMs ?? null,
        maxFiles: options.maxFiles ?? null,
        maxBytes: options.maxBytes ?? null,
        packagePath: packageScoped ? options.packagePath.trim() : null,
      },
      discovery: details.discovery || null,
      activeGraph: graphIdentity(active.graph, active.source, details.freshness || (status === "complete" ? "current" : "stale-unverified"), root),
      cachePromotion: {
        allowed: status === "complete" && cacheEnabled,
        performed: details.cachePromoted === true,
      },
      refresh: details.refresh || null,
      failure: details.failure || null,
      limitations: [
        "Only a complete scan may replace the canonical graph cache.",
        "A stale-unverified fallback is the last complete graph, not a partial reconstruction of the current source.",
        bounded
          ? "Bounded mode currently performs full planned analysis per refresh; incremental parser reuse is unavailable in this mode."
          : "Unbounded mode retains in-process parser facts but cannot enforce a hard analysis deadline.",
        packageScoped
          ? "Package-scoped scans keep an ephemeral session graph and do not replace the repository-wide graph cache."
          : "Repository-wide scans may use the configured local graph cache when cache is enabled.",
      ],
    };
    if (active.graph) active.graph.analysis.scanOutcome = outcome;
    publish("terminal", outcome);
    return outcome;
  };

  const refresh = async (changedPaths = null, reason = "scan", signal = null) => {
    if (activeController) {
      const error = new Error("A Flowpeek scan is already running for this coordinator.");
      error.code = "FLOWPEEK_SCAN_IN_PROGRESS";
      throw error;
    }
    const operationId = `scan:${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    activeController = controller;
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    publish("started", {
      ...outcome,
      operationId,
      status: "running",
      reason,
      startedAt,
      completedAt: null,
      durationMs: 0,
      progress: { phase: "started" },
    });
    previousGraph = graph;
    try {
      if (bounded) {
        const result = await scanRepositoryBounded(root, {
          timeBudgetMs: options.timeBudgetMs,
          maxFiles: options.maxFiles,
          maxBytes: options.maxBytes,
          analysisDelayMs: options.analysisDelayMs,
          packagePath: packageScoped ? options.packagePath.trim() : null,
          persistIdentity: cacheEnabled,
          sessionProjectId,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === "terminal") return;
            publish(progress.phase, {
              ...outcome,
              operationId,
              status: "running",
              reason,
              startedAt,
              progress,
            });
          },
        });
        if (result.status !== "complete") {
          const active = fallbackGraph();
          graph = active.graph;
          return {
            graph,
            previousGraph,
            boundedResult: result,
            outcome: finalize(operationId, startedAt, result.status, result.reason, active, {
              discovery: discoverySummary(result),
              failure: result.failure,
            }),
          };
        }
        graph = result.graph;
        graph.analysis.packageSelection = result.discovery.selection;
        if (cacheEnabled) {
          graph.analysis.cacheState = summarizeCacheResult(writeGraphCache(root, graph, { reason, changedPaths }));
        } else {
          advanceSessionGraph(graph, previousGraph, { reason, changedPaths });
          graph.analysis.cacheState = disabledCacheState(root, packageScoped ? "package-scoped-session" : "cache-disabled");
        }
        graph.analysis.derivedCacheInvalidation = cacheEnabled
          ? invalidateArtifactCache(root, graph, changedPaths || [], { topologyChanged: Boolean(graph.analysis.latestDelta?.topologyChanged) })
          : { status: "disabled", events: [], diagnostics: [] };
        result.graph = graph;
        const active = { graph, source: "fresh-complete" };
        return {
          graph,
          previousGraph,
          boundedResult: result,
          outcome: finalize(operationId, startedAt, "complete", null, active, {
            discovery: discoverySummary(result),
            cachePromoted: cacheEnabled,
            refresh: graph.analysis.refresh,
          }),
        };
      }

      graph = scanner.scan(changedPaths);
      const effectiveChangedPaths = Array.isArray(graph.analysis?.refresh?.changedPaths)
        ? graph.analysis.refresh.changedPaths
        : changedPaths;
      graph.analysis.cacheState = cacheEnabled
        ? summarizeCacheResult(writeGraphCache(root, graph, { reason, changedPaths: effectiveChangedPaths }))
        : disabledCacheState(root, "cache-disabled");
      graph.analysis.derivedCacheInvalidation = cacheEnabled
        ? invalidateArtifactCache(root, graph, effectiveChangedPaths || [], { topologyChanged: Boolean(graph.analysis.latestDelta?.topologyChanged) })
        : { status: "disabled", events: [], diagnostics: [] };
      const active = { graph, source: "fresh-complete" };
      return {
        graph,
        previousGraph,
        boundedResult: null,
        outcome: finalize(operationId, startedAt, "complete", null, active, {
          cachePromoted: cacheEnabled,
          refresh: graph.analysis.refresh,
        }),
      };
    } catch (error) {
      const active = fallbackGraph();
      graph = active.graph;
      return {
        graph,
        previousGraph,
        boundedResult: null,
        outcome: finalize(operationId, startedAt, "failed", error?.code || "scan-failed", active, {
          failure: {
            name: error?.name || "Error",
            code: typeof error?.code === "string" ? error.code : null,
            message: error?.message || "Repository scan failed.",
          },
        }),
      };
    } finally {
      if (signal) signal.removeEventListener("abort", forwardAbort);
      activeController = null;
    }
  };

  const cancel = () => {
    if (!activeController) return { accepted: false, reason: "no-scan-running", outcome };
    if (!bounded) return { accepted: false, reason: "unbounded-scan-is-not-interruptible", outcome };
    activeController.abort();
    return { accepted: true, reason: "abort-requested", operationId: outcome.operationId, outcome };
  };

  return {
    root,
    refresh,
    cancel,
    isRunning: () => Boolean(activeController),
    currentGraph: () => graph,
    previousGraph: () => previousGraph,
    currentOutcome: () => outcome,
    bounded,
    cacheEnabled,
  };
}

module.exports = {
  SCAN_OUTCOME_SCHEMA,
  createScanCoordinator,
  hasBounds,
};
