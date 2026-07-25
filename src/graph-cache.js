const fs = require("node:fs");
const path = require("node:path");
const { GraphSchemaError, graphContractSummary, parseGraphCache, validateGraph } = require("./graph-schema");

const CACHE_RELATIVE_PATH = ".flopeek/graph.json";
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

class GraphCacheError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "GraphCacheError";
    this.code = code;
    this.cause = cause;
  }
}

function cachePath(root) {
  return path.join(root, CACHE_RELATIVE_PATH);
}

function wait(milliseconds) {
  if (!milliseconds) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function temporaryPath(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
}

function atomicWriteJson(target, value, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const configuredAttempts = Number(options.attempts);
  const configuredRetryDelay = Number(options.retryDelayMs);
  const attempts = Math.min(Math.max(Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 8, 1), 8);
  const retryDelayMs = Math.min(Math.max(Number.isFinite(configuredRetryDelay) && configuredRetryDelay >= 0 ? configuredRetryDelay : 25, 0), 250);
  const pause = options.wait || wait;
  const temp = temporaryPath(target);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    fileSystem.mkdirSync(path.dirname(target), { recursive: true });
    descriptor = fileSystem.openSync(temp, "w", 0o600);
    fileSystem.writeFileSync(descriptor, body, "utf8");
    if (typeof fileSystem.fsyncSync === "function") fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        (options.rename || fileSystem.renameSync)(temp, target);
        return { path: target, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (!TRANSIENT_RENAME_CODES.has(error.code) || attempt === attempts) break;
        pause(Math.min(retryDelayMs * attempt, 250));
      }
    }
    throw new GraphCacheError("cache-replace-failed", `Unable to replace graph cache after ${attempts} attempt${attempts === 1 ? "" : "s"}. The previous cache was preserved.`, lastError);
  } catch (error) {
    if (error instanceof GraphCacheError) throw error;
    throw new GraphCacheError("cache-write-failed", `Unable to write graph cache. ${error.message}`, error);
  } finally {
    if (descriptor !== undefined && descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
    try {
      if (fileSystem.existsSync(temp)) fileSystem.rmSync(temp, { force: true });
    } catch {}
  }
}

function validateGraphForCache(root, graph, options = {}) {
  const expectedRoot = fs.realpathSync(root);
  try {
    validateGraph(graph, { expectedRoot, expectedProjectId: options.expectedProjectId });
  } catch (error) {
    if (error instanceof GraphSchemaError) throw new GraphCacheError("invalid-graph", error.message, error);
    throw error;
  }
  return expectedRoot;
}

function writeGraphCache(root, graph, options = {}) {
  const expectedRoot = validateGraphForCache(root, graph, options);
  const result = atomicWriteJson(cachePath(expectedRoot), graph, options);
  return { status: "written", ...result, contract: graphContractSummary(graph) };
}

function readGraphCacheResult(root, options = {}) {
  let expectedRoot;
  try {
    expectedRoot = fs.realpathSync(root);
  } catch (error) {
    return { status: "unavailable", path: cachePath(root), diagnostics: [{ code: "repository-unavailable", message: `Repository root is unavailable (${error.message}).`, path: null }] };
  }
  const target = cachePath(expectedRoot);
  if (!fs.existsSync(target)) return { status: "missing", path: target, diagnostics: [] };
  let text;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    return { status: "invalid", path: target, diagnostics: [{ code: "cache-read-failed", message: `Unable to read graph cache (${error.message}).`, path: null }] };
  }
  try {
    const { graph, migrated } = parseGraphCache(text, { expectedRoot, expectedProjectId: options.expectedProjectId });
    return { status: "valid", path: target, graph, migrated, diagnostics: [], contract: graphContractSummary(graph) };
  } catch (error) {
    const diagnostics = error instanceof GraphSchemaError
      ? error.diagnostics
      : [{ code: "cache-unknown-error", message: error.message || "Unable to validate graph cache.", path: null }];
    return { status: "invalid", path: target, diagnostics };
  }
}

function readGraphCache(root, options = {}) {
  const result = readGraphCacheResult(root, options);
  return result.status === "valid" ? result.graph : null;
}

function summarizeCacheResult(result) {
  return {
    status: result.status,
    path: result.path,
    diagnostics: result.diagnostics || [],
    contract: result.contract || null,
    migrated: result.migrated === true,
    graphVersion: result.graphState?.graphVersion ?? result.contract?.graphVersion ?? null,
    state: result.graphState || null,
    delta: result.delta ? {
      fromGraphVersion: result.delta.fromGraphVersion,
      toGraphVersion: result.delta.toGraphVersion,
      sourceChanged: result.delta.sourceChanged,
      topologyChanged: result.delta.topologyChanged,
    } : null,
  };
}

module.exports = {
  CACHE_RELATIVE_PATH,
  GraphCacheError,
  atomicWriteJson,
  cachePath,
  readGraphCache,
  readGraphCacheResult,
  summarizeCacheResult,
  validateGraphForCache,
  writeGraphCache,
};
