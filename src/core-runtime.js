"use strict";

const { selectCoreMode } = require("./core-mode");
const { CORE_CLIENT_SCHEMA, assertCoreClient } = require("./core-client");
const { createJsCoreClient } = require("./js-core-client");
const { createNativeCoreClient } = require("./native-core-client");
const { createNativeIncrementalSession } = require("./native-incremental-coordinator");
const { createShadowCoreClient } = require("./shadow-core-client");

const CORE_MODES = new Set(["js", "shadow", "native"]);

// A failed native bootstrap may use JavaScript only before native has promoted
// any graph for this client. Once SQLite is authoritative, falling back to a
// JavaScript scan would create two current stores; callers must instead use
// the coordinator's native last-complete recovery path.
function createNativeFallbackCoreClient(native, javascript) {
  const nativeCore = assertCoreClient(native);
  const javascriptCore = assertCoreClient(javascript);
  const fallbackGraphs = new WeakSet();
  let nativeAuthoritative = false;
  let javascriptFallback = false;
  const rememberGraph = (graph, fallback) => {
    if (graph && typeof graph === "object") {
      if (fallback) fallbackGraphs.add(graph);
      else nativeAuthoritative = true;
    }
    return graph;
  };
  const scanWithFallback = (method) => async (...args) => {
    if (javascriptFallback) return rememberGraph(await javascriptCore[method](...args), true);
    try {
      return rememberGraph(await nativeCore[method](...args), false);
    } catch (error) {
      if (nativeAuthoritative) throw error;
      javascriptFallback = true;
      return rememberGraph(await javascriptCore[method](...args), true);
    }
  };
  const query = (method) => async (graph, ...args) => {
    const core = fallbackGraphs.has(graph) ? javascriptCore : nativeCore;
    return core[method](graph, ...args);
  };
  return Object.freeze({
    schemaVersion: CORE_CLIENT_SCHEMA,
    get implementation() { return javascriptFallback ? "javascript" : nativeCore.implementation; },
    get fallback() {
      return javascriptFallback
        ? Object.freeze({ active: true, reason: "native-bootstrap-failed-before-authority" })
        : Object.freeze({ active: false, reason: null });
    },
    scan: scanWithFallback("scan"),
    refresh: scanWithFallback("refresh"),
    getLastCompleteGraph: (...args) => (nativeAuthoritative ? nativeCore : javascriptCore).getLastCompleteGraph(...args),
    getScanStatus: query("getScanStatus"),
    getProjectOverview: query("getProjectOverview"),
    findNodes: query("findNodes"),
    getNode: query("getNode"),
    getRequestFlows: query("getRequestFlows"),
    getEntryFlows: query("getEntryFlows"),
    getFlowProjection: query("getFlowProjection"),
    getChangeImpact: query("getChangeImpact"),
    getChangedContexts: query("getChangedContexts"),
    getRelatedTests: query("getRelatedTests"),
    getContextCard: query("getContextCard"),
    resolveContextRef: query("resolveContextRef"),
    close: async () => {
      await nativeCore.close();
      await javascriptCore.close();
    },
  });
}

// Surface hosts use this one activation boundary. Native remains unavailable
// unless a trusted host explicitly enables it *and* the complete rollout gate
// passes; an environment request alone can never promote it.
function createConfiguredCoreClient(options = {}) {
  const selection = selectCoreMode({
    mode: options.mode,
    rolloutEvidence: options.rolloutEvidence,
    nativeAvailable: options.enableNativeCore === true || Boolean(options.nativeCore),
  });
  if (options.strictNative === true && selection.selectedImplementation !== "native") {
    const error = new Error(`Strict native core is unavailable: ${selection.fallback?.reason || "native mode was not selected"}.`);
    error.code = "strict-native-unavailable";
    error.gateReasons = selection.gate.reasons;
    throw error;
  }
  if (selection.nativeShadow) {
    const javascript = options.javascript || createJsCoreClient();
    const native = options.native || createNativeIncrementalSession(null, options.nativeOptions);
    return createShadowCoreClient({
      javascript,
      native,
      persistStructuralGraph: options.persistStructuralGraph,
    });
  }
  if (selection.selectedImplementation === "native") {
    const native = assertCoreClient(options.nativeCore || createNativeCoreClient({
      native: options.native,
      nativeOptions: options.nativeOptions,
      extensions: options.nativeExtensions,
      sourceAuthority: "rust",
    }));
    if (options.strictNative === true) return native;
    const javascript = options.javascript || createJsCoreClient();
    return createNativeFallbackCoreClient(native, javascript);
  }
  return options.javascript || createJsCoreClient();
}

// CLI and viewer hosts already use `mode` for presentation/query semantics.
// Keep their core selection separate, while retaining `mode: "shadow"` for
// direct programmatic callers during the experimental migration.
function createSurfaceCoreClient(options = {}) {
  const mode = options.coreMode == null
    ? (CORE_MODES.has(options.mode) ? options.mode : undefined)
    : options.coreMode;
  return createConfiguredCoreClient({ ...options, mode });
}

module.exports = { createConfiguredCoreClient, createNativeFallbackCoreClient, createSurfaceCoreClient };
