"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { discoverRepository } = require("./repository-discovery");

const BOUNDED_SCAN_SCHEMA = "flowpeek-bounded-scan-result/v1";

function safeFailure(error) {
  return {
    name: error?.name || "Error",
    code: typeof error?.code === "string" ? error.code : null,
    message: error?.message || "Repository scan failed.",
  };
}

function resultEnvelope(status, startedAt, discovery, details = {}) {
  const packageScoped = discovery?.selection?.status === "selected";
  return {
    schemaVersion: BOUNDED_SCAN_SCHEMA,
    status,
    generatedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    discovery,
    graph: details.graph || null,
    verification: details.verification || null,
    reason: details.reason || null,
    failure: details.failure || null,
    cachePromotion: {
      allowed: status === "complete" && !packageScoped,
      reason: packageScoped
        ? "Package-scoped scans use an ephemeral session graph and must not replace the repository-wide graph cache."
        : status === "complete"
        ? "Only a complete bounded scan may be promoted to the canonical graph cache."
        : "Incomplete, cancelled, or failed scan results must not replace the last complete graph cache.",
    },
    limitations: [
      "Worker termination prevents an incomplete analysis result from being returned or promoted. Fixture-only Windows, Linux, and macOS matrices observe Go/.NET helper cleanup; this remains static helper-process evidence, not target-runtime evidence.",
      "A bounded result without a graph is diagnostic evidence; it is not a partial technical graph.",
      "Analysis and verification share one immutable discovery plan; verification re-reads only planned directories and source/resolver-control candidates to reject source-set changes.",
      "The analyzed source set is bound to the discovery fingerprint and discarded when shared-plan verification differs.",
      "The inventory fingerprint records path, size, and modification-time metadata; it is not a cryptographic source-content hash.",
      ...(packageScoped ? ["Package-scoped analysis is a static selected subtree and does not prove workspace topology, dependency ownership, build activation, or runtime behavior."] : []),
    ],
  };
}

function runWorker(root, options, timeoutMs, signal) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, "bounded-scan-worker.js"), {
      workerData: {
        root,
        persistIdentity: options.persistIdentity !== false,
        analysisPlan: options.analysisPlan,
        sessionProjectId: options.sessionProjectId || null,
        analysisDelayMs: options.analysisDelayMs || 0,
      },
    });
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const terminate = (status, reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      worker.terminate().finally(() => resolve({ status, reason }));
    };
    const onAbort = () => terminate("cancelled", "abort-signal");
    worker.once("message", (message) => {
      if (message?.ok) finish({ status: "complete", graph: message.graph, verification: message.verification || null });
      else finish({ status: "failed", reason: "worker-reported-failure", failure: message?.error || { name: "Error", code: null, message: "Repository scan failed." } });
    });
    worker.once("error", (error) => finish({ status: "failed", reason: "worker-error", failure: safeFailure(error) }));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish({ status: "failed", reason: "worker-exit", failure: { name: "WorkerExitError", code: null, message: `Repository scan worker exited with code ${code}.` } });
    });
    if (signal) {
      if (signal.aborted) return terminate("cancelled", "abort-signal");
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs !== null) timer = setTimeout(() => terminate("partial-by-budget", "time-budget-exceeded-during-analysis"), timeoutMs);
  });
}

async function scanRepositoryBounded(inputRoot, options = {}) {
  const startedAt = Date.now();
  const notify = (phase, details = {}) => {
    if (typeof options.onProgress === "function") options.onProgress({ phase, ...details });
  };
  notify("discovery-started");
  const discovery = discoverRepository(inputRoot, {
    timeBudgetMs: options.timeBudgetMs,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    packagePath: options.packagePath,
    now: options.now,
    includeAnalysisPlan: true,
  });
  const packageScoped = discovery.selection?.status === "selected";
  notify("discovery-completed", { discovery: { status: discovery.status, inventory: discovery.inventory, reasons: discovery.reasons, selection: discovery.selection } });
  if (!discovery.decision.safeToStartFullScan) {
    const result = resultEnvelope("partial-by-budget", startedAt, discovery, { reason: discovery.reasons.join(",") || "discovery-bounded" });
    notify("terminal", { status: result.status, reason: result.reason });
    return result;
  }
  if (options.signal?.aborted) {
    const result = resultEnvelope("cancelled", startedAt, discovery, { reason: "abort-signal" });
    notify("terminal", { status: result.status, reason: result.reason });
    return result;
  }
  const elapsed = Date.now() - startedAt;
  const remaining = discovery.limits.timeBudgetMs === null ? null : discovery.limits.timeBudgetMs - elapsed;
  if (remaining !== null && remaining < 1) {
    const result = resultEnvelope("partial-by-budget", startedAt, discovery, { reason: "time-budget-exceeded-before-analysis" });
    notify("terminal", { status: result.status, reason: result.reason });
    return result;
  }
  notify("analysis-started", { remainingTimeBudgetMs: remaining, selection: discovery.selection });
  const workerOptions = {
    ...options,
    persistIdentity: packageScoped ? false : options.persistIdentity,
    sessionProjectId: packageScoped ? options.sessionProjectId || `session:${randomUUID()}` : options.sessionProjectId,
  };
  const workerResult = await runWorker(inputRoot, {
    ...workerOptions,
    analysisPlan: discovery.analysisPlan,
  }, remaining, options.signal || null);
  if (workerResult.graph?.analysis) workerResult.graph.analysis.packageSelection = discovery.selection;
  const result = resultEnvelope(workerResult.status, startedAt, discovery, workerResult);
  notify("terminal", { status: result.status, reason: result.reason });
  return result;
}

module.exports = {
  BOUNDED_SCAN_SCHEMA,
  scanRepositoryBounded,
};
