"use strict";

const path = require("node:path");
const { selectCoreMode } = require("./core-mode");
const { canonicalRealpath } = require("./canonical-path");
const { CORE_CLIENT_SCHEMA, assertCoreClient } = require("./core-client");
const { createJsCoreClient } = require("./js-core-client");
const { createNativeCoreClient } = require("./native-core-client");
const { createNativeIncrementalSession } = require("./native-incremental-coordinator");
const { NativeProtocolClient } = require("./native-protocol-client");
const { createShadowCoreClient } = require("./shadow-core-client");
const { loadBundledNativeRolloutEvidence, probeVerifiedNativeRuntime } = require("./native-rollout-evidence");

const CORE_MODES = new Set(["js", "shadow", "native", "native-experimental"]);
const FLOPEEK_PACKAGE_ROOT = path.resolve(__dirname, "..");

function createVerifiedNativeProtocolClient(verifiedRuntime, packageRoot, ProtocolClient = NativeProtocolClient) {
  if (verifiedRuntime?.available !== true || typeof verifiedRuntime.binary !== "string" || !verifiedRuntime.binary) {
    throw new Error("Rollout-approved native activation requires an exact verified binary path.");
  }
  return new ProtocolClient({
    command: verifiedRuntime.binary,
    args: [],
    cwd: packageRoot,
  });
}

// A failed native bootstrap may use JavaScript only before native has promoted
// any graph for this client. Once SQLite is authoritative, falling back to a
// JavaScript scan would create two current stores; callers must instead use
// the coordinator's native last-complete recovery path.
function createNativeFallbackCoreClient(native, javascript) {
  const nativeCore = assertCoreClient(native);
  const javascriptCore = assertCoreClient(javascript);
  const fallbackGraphs = new WeakSet();
  const authorityByRoot = new Map();
  const fallbackByRoot = new Map();
  let observedRoot = null;
  const authorityKey = (root) => {
    try {
      return canonicalRealpath(root);
    } catch {
      return path.resolve(String(root));
    }
  };
  const authorityState = (key) => authorityByRoot.get(key) || "javascript";
  const rememberGraph = (graph, fallback, key) => {
    if (graph && typeof graph === "object") {
      if (fallback) fallbackGraphs.add(graph);
      else authorityByRoot.set(key, "native-authoritative");
    }
    return graph;
  };
  const activateJavascriptFallback = async (method, root, args, key, reason) => {
    authorityByRoot.set(key, "javascript");
    fallbackByRoot.set(key, reason);
    return rememberGraph(await javascriptCore[method](root, ...args), true, key);
  };
  const authorityUnknownError = (root, trigger, recovery = null) => {
    const error = new Error(`Native graph authority is unknown for ${path.resolve(String(root))}; JavaScript fallback is blocked until SQLite last-complete recovery succeeds.`);
    error.code = "native-authority-unknown";
    error.triggerCode = trigger?.code || null;
    error.cause = trigger;
    if (recovery) error.recoveryError = recovery;
    return error;
  };
  const recoverAfterMutationFailure = async (root, key, baseline, trigger) => {
    authorityByRoot.set(key, "native-authority-unknown");
    try {
      const recovered = await nativeCore.getLastCompleteGraph(root);
      if (recovered) {
        authorityByRoot.set(key, "native-authoritative");
        fallbackByRoot.delete(key);
        return rememberGraph(recovered, false, key);
      }
      if (baseline) throw authorityUnknownError(root, trigger);
      authorityByRoot.set(key, "javascript");
      return null;
    } catch (recoveryError) {
      authorityByRoot.set(key, "native-authority-unknown");
      if (recoveryError?.code === "native-authority-unknown") throw recoveryError;
      throw authorityUnknownError(root, trigger, recoveryError);
    }
  };
  const scanWithFallback = (method) => async (root, ...args) => {
    const key = authorityKey(root);
    observedRoot = key;
    if (fallbackByRoot.has(key)) {
      return rememberGraph(await javascriptCore[method](root, ...args), true, key);
    }
    let baseline = null;
    try {
      baseline = await nativeCore.getLastCompleteGraph(root);
      if (baseline) authorityByRoot.set(key, "native-authoritative");
    } catch (error) {
      if (["native-authoritative", "native-authority-unknown"].includes(authorityState(key))) {
        authorityByRoot.set(key, "native-authority-unknown");
        throw authorityUnknownError(root, error);
      }
      return activateJavascriptFallback(method, root, args, key, "native-bootstrap-failed-before-authority");
    }
    try {
      const graph = await nativeCore[method](root, ...args);
      fallbackByRoot.delete(key);
      return rememberGraph(graph, false, key);
    } catch (error) {
      if (error?.nativeAuthorityMutation === true) {
        const recovered = await recoverAfterMutationFailure(root, key, baseline, error);
        if (recovered) return recovered;
        return activateJavascriptFallback(method, root, args, key, "native-mutation-failed-before-promotion");
      }
      if (["native-authoritative", "native-authority-unknown"].includes(authorityState(key))) throw error;
      return activateJavascriptFallback(method, root, args, key, "native-bootstrap-failed-before-authority");
    }
  };
  const query = (method) => async (graph, ...args) => {
    const core = fallbackGraphs.has(graph) ? javascriptCore : nativeCore;
    return core[method](graph, ...args);
  };
  return Object.freeze({
    schemaVersion: CORE_CLIENT_SCHEMA,
    get implementation() { return observedRoot && fallbackByRoot.has(observedRoot) ? "javascript" : nativeCore.implementation; },
    // Preserve native capability metadata through the rollback boundary so
    // product orchestration can select the native bounded lifecycle without
    // mistaking this explicit fallback wrapper for a JavaScript core.
    get sourceAuthority() { return observedRoot && fallbackByRoot.has(observedRoot) ? null : nativeCore.sourceAuthority; },
    get parserHost() { return observedRoot && fallbackByRoot.has(observedRoot) ? null : nativeCore.parserHost; },
    get factEnvelopeHost() { return observedRoot && fallbackByRoot.has(observedRoot) ? null : nativeCore.factEnvelopeHost; },
    get authorityState() { return observedRoot ? authorityState(observedRoot) : "javascript"; },
    get fallback() {
      const reason = observedRoot ? fallbackByRoot.get(observedRoot) : null;
      return reason
        ? Object.freeze({ active: true, reason })
        : Object.freeze({ active: false, reason: null });
    },
    scan: scanWithFallback("scan"),
    refresh: scanWithFallback("refresh"),
    getLastCompleteGraph: async (root, ...args) => {
      const key = authorityKey(root);
      observedRoot = key;
      if (fallbackByRoot.has(key)) return javascriptCore.getLastCompleteGraph(root, ...args);
      try {
        const graph = await nativeCore.getLastCompleteGraph(root, ...args);
        if (graph) authorityByRoot.set(key, "native-authoritative");
        else if (authorityState(key) === "native-authority-unknown") authorityByRoot.set(key, "javascript");
        return graph;
      } catch (error) {
        if (authorityState(key) === "native-authority-unknown") throw authorityUnknownError(root, error);
        throw error;
      }
    },
    materializeGraph: query("materializeGraph"),
    getScanStatus: query("getScanStatus"),
    getProjectOverview: query("getProjectOverview"),
    findNodes: query("findNodes"),
    getNode: query("getNode"),
    getRequestFlows: query("getRequestFlows"),
    getEntryFlows: query("getEntryFlows"),
    getFlowProjection: query("getFlowProjection"),
    getFlowContextCard: query("getFlowContextCard"),
    getChangeImpact: query("getChangeImpact"),
    getGraphDelta: query("getGraphDelta"),
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
  return createSurfaceCoreRuntime(options).core;
}

// Selection is an intentional preflight decision; it cannot know whether a
// native process will fail before its first authoritative promotion. Surface
// hosts must therefore materialize this record after each scan. Otherwise a
// requested native-experimental scan that actually used JavaScript fallback
// would be presented as native, which defeats the visible-rollback contract.
function observeCoreRuntime(selection, core) {
  const fallback = core?.fallback;
  const nativeActive = core?.implementation === "native-experimental" && !fallback?.active;
  if (!nativeActive && !fallback?.active) return selection;
  const observed = {
    ...selection,
    execution: Object.freeze({
      selectedImplementation: nativeActive ? "native" : "javascript",
      sourceAuthority: nativeActive ? core.sourceAuthority || null : null,
      parserHost: nativeActive ? core.parserHost || null : null,
      factEnvelopeHost: nativeActive ? core.factEnvelopeHost || null : null,
      fallback: fallback || Object.freeze({ active: false, reason: null }),
    }),
  };
  if (fallback?.active) {
    observed.policySelectedImplementation = selection.selectedImplementation;
    observed.selectedImplementation = "javascript";
    observed.sourceAuthority = null;
    observed.fallback = Object.freeze({
      ...(selection.fallback || {}),
      ...fallback,
    });
  }
  return Object.freeze(observed);
}

// Keep activation and its machine-readable decision together so CLI, MCP,
// server, workspace hosts, and ScanCoordinator can expose the same fallback
// rather than silently reporting a JavaScript scan as a requested native one.
function createSurfaceCoreRuntime(options = {}) {
  const mode = options.coreMode == null
    ? (CORE_MODES.has(options.mode) ? options.mode : undefined)
    : options.coreMode;
  let bundledEvidence = null;
  let verifiedRuntime = null;
  const packageRoot = path.resolve(options.packageRoot || FLOPEEK_PACKAGE_ROOT);
  if (mode === "native") {
    bundledEvidence = loadBundledNativeRolloutEvidence(packageRoot);
    verifiedRuntime = probeVerifiedNativeRuntime(packageRoot, {
      expectedBinaries: bundledEvidence?.complete
        ? bundledEvidence.packet.binding.binaries
        : null,
    });
  }
  const rolloutEvidence = options.rolloutEvidence ?? bundledEvidence?.evidence;
  const approvedVerifiedRuntime = bundledEvidence?.complete === true
    && verifiedRuntime?.available === true;
  const verifiedNative = approvedVerifiedRuntime
    ? createVerifiedNativeProtocolClient(verifiedRuntime, packageRoot)
    : null;
  const nativeAvailable = mode === "native"
    ? approvedVerifiedRuntime
    : options.enableNativeCore === true
      || Boolean(options.nativeCore)
      || Boolean(options.native)
      || mode === "native-experimental";
  const selection = selectCoreMode({
    mode,
    rolloutEvidence,
    nativeAvailable,
  });
  const core = createConfiguredCoreClient({
    ...options,
    mode,
    rolloutEvidence,
    enableNativeCore: nativeAvailable,
    // A rollout-approved automatic activation must execute the exact artifact
    // that probeVerifiedNativeRuntime hashed and matched to the packet. The
    // experimental resolver remains the only path that may honor
    // FLOPEEK_NATIVE_CORE.
    native: mode === "native" ? verifiedNative : options.native,
    nativeCore: mode === "native" ? undefined : options.nativeCore,
  });
  return Object.freeze({ core, selection: Object.freeze({
    ...selection,
    ...(bundledEvidence ? { rolloutEvidence: {
      schemaVersion: bundledEvidence.packet.schemaVersion,
      status: bundledEvidence.packet.status,
      boundPackageVersion: bundledEvidence.packet.binding.packageVersion,
    } } : {}),
    ...(verifiedRuntime ? { nativeRuntime: verifiedRuntime } : {}),
  }) });
}

module.exports = {
  FLOPEEK_PACKAGE_ROOT,
  createConfiguredCoreClient,
  createNativeFallbackCoreClient,
  createVerifiedNativeProtocolClient,
  createSurfaceCoreClient,
  createSurfaceCoreRuntime,
  observeCoreRuntime,
};
