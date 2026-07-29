"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CORE_CLIENT_SCHEMA, assertCoreClient } = require("./core-client");
const { createContextPacket, parseContextRef } = require("./context-card");
const { createFlowContextCard } = require("./flow-context-card");
const { assertNativeCoreExtensionAdapter, createNativeCoreExtensionAdapter } = require("./native-core-extension-adapter");
const { createNativeIncrementalSession } = require("./native-incremental-coordinator");
const { resolveProjectIdentity } = require("./project-identity");
const { createRepositoryScanner } = require("./scanner");
const { readRepositoryScope } = require("./scope");
const {
  createStructuralFactBatchFromPrepared,
  createStructuralFactPatch,
  createStructuralFactPatchFromPrepared,
  materializeStructuralFactPatch,
  prepareStructuralFactBatch,
  withNativePublicGraphVersion,
} = require("./structural-fact-adapter-host");

function queryOption(options, ...names) {
  for (const name of names) {
    const value = typeof options?.get === "function" ? options.get(name) : options?.[name];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

function safeIntegerOption(options, ...names) {
  const value = queryOption(options, ...names);
  if (Number.isSafeInteger(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nativeCancellationError() {
  const error = new Error("Native core scan was cancelled.");
  error.name = "AbortError";
  error.code = "FLOPEEK_NATIVE_SCAN_CANCELLED";
  return error;
}

async function prepareRustNativeBatch(native, inputRoot, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const response = await native.request("nativeJsStructuralFacts", { projectRoot: root });
  if (response?.schemaVersion !== "flopeek-native-source-facts/v1" || !Array.isArray(response.records)
    || !response.nativeEnvelope || typeof response.nativeEnvelope !== "object" || Array.isArray(response.nativeEnvelope)) {
    throw new TypeError("Rust source authority returned an invalid native StructuralFactBatch envelope.");
  }
  const unsupportedPaths = Array.isArray(response.unsupportedPaths) ? response.unsupportedPaths : [];
  if (unsupportedPaths.length) {
    const error = new Error(`Rust source authority has no promoted adapter for: ${unsupportedPaths.join(", ")}.`);
    error.code = "native-source-adapter-unavailable";
    error.unsupportedPaths = unsupportedPaths;
    throw error;
  }
  const batch = response.nativeEnvelope;
  if (batch.schemaVersion !== "flopeek-structural-fact-batch/v1" || !Array.isArray(batch.records)
    || batch.records.length !== response.candidateFiles || typeof batch.factsDigest !== "string") {
    throw new TypeError("Rust source authority returned an incomplete native StructuralFactBatch.");
  }
  const first = options.previous == null;
  const changedPaths = [...new Set([
    ...(Array.isArray(response.changedPaths) ? response.changedPaths : []),
    ...(Array.isArray(response.removedPaths) ? response.removedPaths : []),
  ])].sort();
  const sourceRecords = batch.records.map((record) => ({
    relativePath: record.relativePath,
    sourceHash: record.sourceHash,
    sourceScope: record.sourceScope,
    language: record.language,
  }));
  return {
    batch,
    response,
    prepared: {
      root,
      sourceRecords,
      graphContext: null,
      refresh: {
        strategy: "incremental-content-analysis",
        mode: first ? "initial" : "incremental",
        analyzedFiles: first ? sourceRecords.length : Math.min(sourceRecords.length, Number(response.parsedFiles) || 0),
        reusedFiles: Math.max(0, sourceRecords.length - (Number(response.parsedFiles) || 0)),
        removedFiles: Array.isArray(response.removedPaths) ? response.removedPaths.length : 0,
        changedPaths: first ? [] : changedPaths,
      },
    },
    preparedFacts: null,
    publicEnvelope: null,
  };
}

function throwIfNativeScanCancelled(signal) {
  if (signal?.aborted) throw nativeCancellationError();
}

async function requestNativeWithSignal(native, signal, method, params) {
  throwIfNativeScanCancelled(signal);
  if (!signal) return native.request(method, params);
  let onAbort;
  const cancelled = new Promise((resolve, reject) => {
    onAbort = () => {
      // The protocol process owns the SQLite transaction. Stopping it is the
      // only safe mid-request cancellation path; a transaction either rolls
      // back or has already committed a complete graph.
      Promise.resolve(native.abort?.("Native core scan was cancelled."))
        .catch(() => {})
        .finally(() => reject(nativeCancellationError()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([native.request(method, params), cancelled]);
  } catch (error) {
    if (signal.aborted) throw nativeCancellationError();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function materializeReusedPublicGraph(previousGraph, reuse) {
  const envelope = reuse?.schemaVersion === "flopeek-native-public-graph-reuse/v1"
    ? reuse.envelope
    : null;
  if (!previousGraph || !envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Native public graph reuse requires the previous graph and a versioned envelope.");
  }
  for (const key of ["nodes", "edges", "flows", "diagnosticFlows"]) {
    if (Object.hasOwn(envelope, key)) {
      throw new Error(`Native public graph reuse envelope must not contain ${key}.`);
    }
    if (!Array.isArray(previousGraph[key])) {
      throw new Error(`Native public graph reuse requires previous graph.${key}.`);
    }
  }
  // The Rust protocol has proved that parser facts are structurally identical.
  // Reuse only the four immutable graph collections; the envelope replaces
  // state, analysis, stats, and every observational/versioned field.
  return {
    ...previousGraph,
    ...envelope,
    nodes: previousGraph.nodes,
    edges: previousGraph.edges,
    flows: previousGraph.flows,
    diagnosticFlows: previousGraph.diagnosticFlows,
  };
}

function publicGraphCollectionKey(field, value) {
  if (field !== "edges") {
    if (typeof value?.id !== "string" || !value.id) throw new Error(`Native public graph patch requires ${field} entries with an id.`);
    return `id:${value.id}`;
  }
  if (![value?.source, value?.target, value?.type].every((part) => typeof part === "string")) {
    throw new Error("Native public graph patch requires edge source, target, and type.");
  }
  return JSON.stringify([value.source, value.target, value.type]);
}

function materializePatchedPublicGraph(previousGraph, patch) {
  const envelope = patch?.schemaVersion === "flopeek-native-public-graph-patch/v1"
    ? patch.envelope
    : null;
  const collections = patch?.schemaVersion === "flopeek-native-public-graph-patch/v1"
    ? patch.collections
    : null;
  if (!previousGraph || !envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || !collections || typeof collections !== "object" || Array.isArray(collections)) {
    throw new Error("Native public graph patch requires a versioned envelope and collections.");
  }
  const materialized = { ...envelope };
  for (const field of ["nodes", "edges", "flows", "diagnosticFlows"]) {
    if (Object.hasOwn(envelope, field) || !Array.isArray(previousGraph[field])) {
      throw new Error(`Native public graph patch has an invalid ${field} envelope.`);
    }
    const update = collections[field];
    if (!update || typeof update !== "object" || Array.isArray(update)
      || !Array.isArray(update.remove) || !Array.isArray(update.upsert) || !Array.isArray(update.insert)
      || !(update.order === null || update.order === undefined || Array.isArray(update.order))) {
      throw new Error(`Native public graph patch has an invalid ${field} collection.`);
    }
    const entries = new Map();
    const sequence = [];
    for (const entry of previousGraph[field]) {
      const key = publicGraphCollectionKey(field, entry);
      if (entries.has(key)) throw new Error(`Native public graph patch found duplicate previous ${field} keys.`);
      entries.set(key, entry);
      sequence.push(key);
    }
    const previousKeys = new Set(entries.keys());
    for (const key of update.remove) {
      if (typeof key !== "string" || !entries.delete(key)) throw new Error(`Native public graph patch removes an unknown ${field} entry.`);
    }
    const retained = sequence.filter((key) => entries.has(key));
    for (const entry of update.upsert) {
      const key = publicGraphCollectionKey(field, entry);
      entries.set(key, entry);
    }
    if (Array.isArray(update.order)) {
      if (new Set(update.order).size !== update.order.length
        || update.order.some((key) => typeof key !== "string" || !entries.has(key))
        || update.order.length !== entries.size) {
        throw new Error(`Native public graph patch has an invalid ${field} order.`);
      }
      materialized[field] = update.order.map((key) => entries.get(key));
    } else {
      const inserted = new Set();
      for (const item of update.insert) {
        if (!item || typeof item.key !== "string" || !Number.isSafeInteger(item.index)
          || item.index < 0 || inserted.has(item.key)
          || previousKeys.has(item.key) || !entries.has(item.key)) {
          throw new Error(`Native public graph patch has an invalid ${field} insert.`);
        }
        inserted.add(item.key);
      }
      if ([...entries.keys()].some((key) => !previousKeys.has(key) && !inserted.has(key))) {
        throw new Error(`Native public graph patch changes ${field} membership without an insert.`);
      }
      for (const item of [...update.insert].sort((left, right) => left.index - right.index)) {
        if (item.index > retained.length) throw new Error(`Native public graph patch has an out-of-range ${field} insert.`);
        retained.splice(item.index, 0, item.key);
      }
      materialized[field] = retained.map((key) => entries.get(key));
    }
  }
  return materialized;
}

function publicGraphPatchStats(patch) {
  const collections = patch?.collections;
  if (!collections || typeof collections !== "object") return { upserts: 0, removals: 0, orderEntries: 0 };
  return ["nodes", "edges", "flows", "diagnosticFlows"].reduce((stats, field) => {
    const collection = collections[field];
    stats.upserts += Array.isArray(collection?.upsert) ? collection.upsert.length : 0;
    stats.removals += Array.isArray(collection?.remove) ? collection.remove.length : 0;
    stats.orderEntries += Array.isArray(collection?.order) ? collection.order.length : 0;
    return stats;
  }, { upserts: 0, removals: 0, orderEntries: 0 });
}

// Rust+SQLite is the only graph/query authority in this client. Strict source
// authority uses Rust inventory, tree-sitter parsing, import resolution,
// entry discovery, and complete StructuralFactBatch envelope construction.
// A JsCoreClient is never constructed or accepted here.
function createNativeCoreClient(options = {}) {
  if (Object.hasOwn(options, "javascript")) {
    throw new TypeError("NativeCoreClient does not accept a JavaScript core authority; configure rollout fallback outside the native backend.");
  }
  const extensions = assertNativeCoreExtensionAdapter(options.extensions || createNativeCoreExtensionAdapter());
  const native = options.native || createNativeIncrementalSession(null, options.nativeOptions);
  if (!native || typeof native.start !== "function" || typeof native.request !== "function") {
    throw new TypeError("Native core client requires a JSONL native protocol session.");
  }
  const batches = new WeakMap();
  const roots = new WeakMap();
  const cacheDisabledProjectIds = new Map();
  const scanners = new Map();
  const nativeSourceStates = new Map();
  const persistentBatches = new WeakMap();
  const sourceAuthority = options.sourceAuthority === "rust" ? "rust" : "javascript-parser-host";
  const cacheDisabledProjectId = (root) => {
    const canonicalRoot = fs.realpathSync(root);
    let projectId = cacheDisabledProjectIds.get(canonicalRoot);
    if (!projectId) {
      projectId = `session:${options.sessionId || randomUUID()}`;
      cacheDisabledProjectIds.set(canonicalRoot, projectId);
    }
    return projectId;
  };
  const durableProjectId = (root) => {
    const configuredProjectId = readRepositoryScope(root).projectId;
    return resolveProjectIdentity(root, configuredProjectId, { persist: false }).projectId;
  };
  const scannerKey = (root, scanOptions, cacheDisabled) => {
    const optionsForKey = Object.fromEntries(Object.entries(scanOptions)
      .filter(([key, value]) => key !== "onProfile" && key !== "changedPaths" && typeof value !== "function")
      .sort(([left], [right]) => left.localeCompare(right)));
    return `${cacheDisabled ? "session" : "persistent"}:${fs.realpathSync(root)}:${JSON.stringify(optionsForKey)}`;
  };
  const requireBatch = (graph) => {
    const batch = batches.get(graph);
    if (!batch) throw new TypeError("Native query requires a graph returned by this NativeCoreClient.scan().");
    return batch;
  };
  // Persistent native queries refer to the verified SQLite-attached fact cache
  // instead of re-sending a complete StructuralFactBatch through JSONL.  The
  // native side verifies that the current SQLite pointer still has this exact
  // digest before it hydrates the process-local cache.  An old graph or a
  // concurrent promotion deliberately falls back to the complete batch: that
  // preserves historical-query semantics while keeping cache reuse an
  // internal transport optimization only.
  const requestNativeQuery = async (method, graph, params = {}) => {
    const batch = requireBatch(graph);
    const root = roots.get(graph);
    if (!root || typeof batch.projectId !== "string" || typeof batch.factsDigest !== "string") {
      return native.request(method, { ...params, batch });
    }
    try {
      return await native.request(method, {
        ...params,
        projectRoot: root,
        projectId: batch.projectId,
        factsDigest: batch.factsDigest,
      });
    } catch (error) {
      if (error?.code !== "native-query-fact-cache-miss") throw error;
      return native.request(method, { ...params, batch });
    }
  };
  const extensionAdapterMethods = Object.freeze([
    "getScanStatus",
    "getProjectOverview",
    "non-application-flow-projection",
    "ephemeral-changed-contexts",
    "formatted-context-card",
    "unsupported-context-ref",
  ]);

  const scan = async (root, scanOptions = {}) => {
      const profile = typeof scanOptions.onProfile === "function" ? scanOptions.onProfile : null;
      const report = (phase, started, extra = {}) => profile?.({ phase, milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000, ...extra });
      const scanStarted = process.hrtime.bigint();
      const cacheDisabled = scanOptions.persistIdentity === false;
      if (sourceAuthority === "rust" && cacheDisabled) {
        const error = new Error("Rust source authority does not yet support an ephemeral cache-disabled lifecycle.");
        error.code = "native-source-cache-disabled-unavailable";
        throw error;
      }
      const key = scannerKey(root, scanOptions, cacheDisabled);
      let scanner = sourceAuthority === "rust" ? null : scanners.get(key);
      const scannerReused = sourceAuthority === "rust" ? nativeSourceStates.has(key) : Boolean(scanner);
      if (sourceAuthority !== "rust" && !scanner) {
        scanner = createRepositoryScanner(root, {
        ...scanOptions,
        persistIdentity: !cacheDisabled,
        ...(cacheDisabled ? { sessionProjectId: cacheDisabledProjectId(root) } : {}),
        });
        scanners.set(key, scanner);
      }
      const authorityRoot = scanner?.root || fs.realpathSync(root);
      const previous = cacheDisabled
        ? null
        : sourceAuthority === "rust"
          ? nativeSourceStates.get(key)
          : persistentBatches.get(scanner);
      // Process startup has no dependency on parser facts. Start it before
      // JavaScript prepares the StructuralFactBatch so cold launch latency is
      // overlapped with source analysis rather than added after it. Requests
      // still await this promise below, preserving the JSONL lifecycle order.
      const sessionStarted = process.hrtime.bigint();
      const sessionAlreadyRunning = Boolean(native.child && !native.closed);
      const nativeStartPromise = native.start();
      // If preparation throws before the await below, retain a rejection
      // observer so a startup failure never becomes an unhandled rejection.
      void nativeStartPromise.catch(() => {});
      const preparationStarted = process.hrtime.bigint();
      const preparation = sourceAuthority === "rust"
        ? await prepareRustNativeBatch(native, authorityRoot, { previous })
        : prepareStructuralFactBatch(scanner, scanOptions.changedPaths, {
          onProfile: profile,
          buildBatch: cacheDisabled || !previous,
        });
      const { prepared, preparedFacts, publicEnvelope } = preparation;
      let batch = preparation.batch;
      report("native-core-fact-batch", preparationStarted, {
        scannerReused,
        records: prepared.sourceRecords.length,
        materialized: Boolean(batch),
      });
      await nativeStartPromise;
      throwIfNativeScanCancelled(scanOptions.signal);
      report("native-core-session-start", sessionStarted, {
        alreadyRunning: sessionAlreadyRunning,
        overlappedWithFactPreparation: !sessionAlreadyRunning,
      });
      const lifecycleStarted = process.hrtime.bigint();
      let result;
      let usedFactPatch = false;
      if (cacheDisabled) {
        if (!batch) throw new Error("Cache-disabled native lifecycle requires a complete fact batch.");
        result = await requestNativeWithSignal(native, scanOptions.signal, "refreshNativeSessionGraph", batch);
      } else {
        const patch = previous
          ? sourceAuthority === "rust"
            ? createStructuralFactPatch(previous.batch, batch)
            : createStructuralFactPatchFromPrepared(previous.batch, publicEnvelope, prepared, preparedFacts, {
              graphContextUnchanged: previous.graphContext === prepared.graphContext,
            })
          : null;
        if (patch) {
          try {
            usedFactPatch = true;
            result = await requestNativeWithSignal(native, scanOptions.signal, "persistNativePublicGraphPatch", { ...patch, projectRoot: authorityRoot });
            batch = materializeStructuralFactPatch(previous.batch, patch, result?.factsDigest);
          } catch (error) {
            // A cache miss is safe and expected after a cache clear, native
            // upgrade, or another process promotes a different graph.  Only
            // these compatibility misses may retry with the complete JS fact
            // batch; malformed patches remain loud failures.
            if (!["structural-fact-patch-miss", "unsupported-structural-fact-patch", "unknown-method"].includes(error?.code)) throw error;
            usedFactPatch = false;
            profile?.({ phase: "native-core-fact-patch-fallback", milliseconds: 0, reason: error.code });
            batch = createStructuralFactBatchFromPrepared(publicEnvelope, prepared, preparedFacts);
            result = await requestNativeWithSignal(native, scanOptions.signal, "persistNativePublicGraph", { ...batch, projectRoot: authorityRoot });
          }
        } else {
          if (!batch) batch = createStructuralFactBatchFromPrepared(publicEnvelope, prepared, preparedFacts);
          result = await requestNativeWithSignal(native, scanOptions.signal, "persistNativePublicGraph", { ...batch, projectRoot: authorityRoot });
        }
      }
      const lifecycleMilliseconds = Number(process.hrtime.bigint() - lifecycleStarted) / 1_000_000;
      if (!result?.graph && result?.publicGraphReuse && previous?.graph) {
        result = {
          ...result,
          graph: materializeReusedPublicGraph(previous.graph, result.publicGraphReuse),
        };
        profile?.({ phase: "native-core-public-graph-reuse", milliseconds: 0, transport: "envelope" });
      }
      if (!result?.graph && result?.publicGraphPatch && previous?.graph) {
        const patchStats = publicGraphPatchStats(result.publicGraphPatch);
        result = {
          ...result,
          graph: materializePatchedPublicGraph(previous.graph, result.publicGraphPatch),
        };
        profile?.({ phase: "native-core-public-graph-patch", milliseconds: 0, transport: "collections", ...patchStats });
      }
      profile?.({ phase: "native-core-lifecycle", milliseconds: lifecycleMilliseconds, cacheDisabled, factPatch: usedFactPatch });
      const responseStats = typeof native.getLastResponseStats === "function" ? native.getLastResponseStats() : null;
      if (responseStats) {
        profile?.({
          phase: "native-core-jsonl-request",
          milliseconds: responseStats.requestWriteMilliseconds,
          requestBytes: responseStats.requestBytes,
          writeBlocked: responseStats.requestWriteBlocked,
          cacheDisabled,
          factPatch: usedFactPatch,
        });
        profile?.({
          phase: "native-core-jsonl-response",
          milliseconds: responseStats.parseMilliseconds,
          responseBytes: responseStats.responseBytes,
          cacheDisabled,
        });
        profile?.({
          phase: "native-core-jsonl-round-trip",
          milliseconds: responseStats.roundTripMilliseconds,
          cacheDisabled,
        });
      }
      const lifecycleProfile = result?.receipt?.profile || result?.profile;
      if (lifecycleProfile?.schemaVersion === "flopeek-native-lifecycle-profile/v1"
        || lifecycleProfile?.schemaVersion === "flopeek-native-session-lifecycle-profile/v1") {
        profile?.({
          phase: "native-core-lifecycle-profile",
          milliseconds: lifecycleProfile.totalMs,
          cacheDisabled,
          ...lifecycleProfile,
        });
        // The Rust lifecycle profile stops before the protocol response is
        // encoded, flushed, transferred, and decoded by Node. Keep that
        // residual explicit rather than mislabelling it as SQLite time.
        const nativeLifecycleMilliseconds = lifecycleProfile.nativePatchLifecycleTotalMs
          ?? lifecycleProfile.nativePublicLifecycleTotalMs
          ?? lifecycleProfile.totalMs;
        profile?.({
          phase: "native-core-lifecycle-transport-residual",
          milliseconds: Math.max(0, lifecycleMilliseconds - nativeLifecycleMilliseconds),
          cacheDisabled,
        });
      }
      const expectedSchema = cacheDisabled
        ? "flopeek-native-session-lifecycle/v1"
        : "flopeek-native-public-lifecycle/v1";
      if (result?.schemaVersion !== expectedSchema || !result.graph || !Number.isSafeInteger(result.publicGraphVersion)) {
        throw new Error("Native core returned an invalid public lifecycle result.");
      }
      if (cacheDisabled) {
        result.graph.analysis.cacheState = {
          status: "disabled",
          path: path.join(authorityRoot, ".flopeek", "graph.json"),
          diagnostics: [],
          contract: null,
          migrated: false,
        };
      }
      batches.set(result.graph, withNativePublicGraphVersion(batch, result.publicGraphVersion));
      roots.set(result.graph, cacheDisabled ? null : authorityRoot);
      if (!cacheDisabled) {
        const state = { batch, graphContext: prepared.graphContext, graph: result.graph };
        if (sourceAuthority === "rust") nativeSourceStates.set(key, state);
        else persistentBatches.set(scanner, state);
      }
      report("native-core-scan-total", scanStarted, { cacheDisabled, scannerReused });
      return result.graph;
    };

  return assertCoreClient(Object.freeze({
    schemaVersion: CORE_CLIENT_SCHEMA,
    implementation: "native-experimental",
    backendAuthority: "rust-sqlite",
    sourceAuthority,
    parserHost: sourceAuthority === "rust" ? "rust-tree-sitter-js-ts/v13" : "javascript-structural-fact-batch/v1",
    factEnvelopeHost: sourceAuthority === "rust" ? "rust-native-structural-batch/v1" : "javascript-structural-fact-batch/v1",
    extensionAdapterMethods,
    scan,
    refresh: async (root, refreshOptions = {}) => {
      const { changedPaths = null, ...scanOptions } = refreshOptions;
      return scan(root, { ...scanOptions, changedPaths });
    },
    getLastCompleteGraph: async (root) => {
      const durableRoot = fs.realpathSync(root);
      await native.start();
      const result = await native.request("getNativeCurrentPublicGraph", {
        projectRoot: durableRoot,
        projectId: durableProjectId(durableRoot),
      });
      if (!result?.graph || !result?.batch) return null;
      batches.set(result.graph, result.batch);
      roots.set(result.graph, durableRoot);
      return result.graph;
    },
    getScanStatus: (graph, queryOptions = {}) => extensions.getScanStatus(graph, queryOptions),
    getProjectOverview: (graph, queryOptions = {}) => extensions.getProjectOverview(graph, queryOptions),
    findNodes: async (graph, queryOptions = {}) => requestNativeQuery("findNodes", graph, {
      query: queryOption(queryOptions, "q", "query") || "",
      scope: queryOption(queryOptions, "scope"),
    }),
    getNode: async (graph, id) => {
      const detail = await requestNativeQuery("getNodeDetails", graph, { nodeId: id });
      return extensions.attachNodeExtensions(graph, detail);
    },
    getRequestFlows: async (graph, endpoint = "", scope = "application") => requestNativeQuery("getRequestFlows", graph, {
      entry: endpoint,
      scope,
    }),
    getEntryFlows: async (graph, query = "", scope = "application") => requestNativeQuery("getEntryFlows", graph, {
      entry: query,
      scope,
    }),
    getFlowProjection: async (graph, flowId, scope = "application", queryOptions = {}) => {
      if (scope !== "application") return extensions.getNonApplicationFlowProjection(graph, flowId, scope, queryOptions);
      const lens = await requestNativeQuery("getNativeFlowLensCore", graph, {
        flowId,
        maxSteps: queryOptions.maxSteps,
      });
      return extensions.attachFlowExtensions(graph, lens);
    },
    getChangeImpact: async (graph, changedPaths, queryOptions = {}) => {
      const impact = await requestNativeQuery("getChangeImpact", graph, {
        changedPaths: Array.isArray(changedPaths) ? changedPaths : [changedPaths],
        maxDepth: safeIntegerOption(queryOptions, "maxDepth"),
      });
      // JSONL omits JavaScript `undefined`, but the in-process CoreClient
      // contract historically exposes this optional field even when a result
      // is not truncated. Restore it at the adapter boundary.
      if (!Object.hasOwn(impact, "truncated")) impact.truncated = undefined;
      return impact;
    },
    getChangedContexts: async (graph, queryOptions = {}) => {
      const root = roots.get(graph);
      if (!root) return extensions.getEphemeralChangedContexts(graph, queryOptions);
      const requestedToVersion = safeIntegerOption(queryOptions, "toVersion");
      const requestedFromVersion = safeIntegerOption(queryOptions, "fromVersion");
      const toGraphVersion = Number.isSafeInteger(requestedToVersion)
        ? requestedToVersion
        : graph.state.graphVersion;
      const fromGraphVersion = Number.isSafeInteger(requestedFromVersion)
        ? requestedFromVersion
        : toGraphVersion - 1;
      return native.request("getNativeChangedContexts", {
        projectRoot: root,
        projectId: requireBatch(graph).projectId,
        fromGraphVersion,
        toGraphVersion,
      });
    },
    getRelatedTests: async (graph, id) => requestNativeQuery("getRelatedTests", graph, { nodeId: id }),
    getContextCard: async (graph, id, format = "json") => {
      if (format !== "json" || !graph.nodes.some((node) => node.id === id)) {
        return extensions.getFormattedContextCard(graph, id, format);
      }
      const card = await requestNativeQuery("getNativeNodeContextCard", graph, { nodeId: id });
      return createContextPacket(card, format);
    },
    resolveContextRef: async (graph, contextRef) => {
      const root = roots.get(graph);
      if (!root) return extensions.resolveUnsupportedContextRef(graph, contextRef);
      let parsed;
      try {
        parsed = parseContextRef(contextRef);
      } catch {
        return extensions.resolveUnsupportedContextRef(graph, contextRef);
      }
      // Diagnostic-only Flow Context Refs need the legacy all-scope projection
      // until that native scope has its public extension adapter.
      if (parsed.kind === "flow" && !graph.flows.some((flow) => flow.id === parsed.contextId)) {
        return extensions.resolveUnsupportedContextRef(graph, contextRef);
      }
      const resolution = await requestNativeQuery("resolveNativeContextRef", graph, {
        contextRef,
      });
      if (!resolution.card || parsed.kind !== "flow" || !["current", "stale"].includes(resolution.status)) return resolution;
      const lens = await requestNativeQuery("getNativeFlowLensCore", graph, {
        flowId: parsed.contextId,
      });
      const extendedLens = extensions.attachFlowExtensions(graph, lens);
      return { ...resolution, resolvedRef: extendedLens.flow.contextRef, card: createFlowContextCard(graph, extendedLens) };
    },
    getNativeFlowLensCore: async (graph, flowId, maxSteps = 12) => requestNativeQuery("getNativeFlowLensCore", graph, { flowId, maxSteps }),
    getNativeNodeContextCard: async (graph, nodeId) => requestNativeQuery("getNativeNodeContextCard", graph, { nodeId }),
    cancel: async () => native.abort?.("Native core scan was cancelled."),
    close: async () => {
      scanners.clear();
      return native.close?.();
    },
  }));
}

module.exports = {
  createNativeCoreClient,
  materializePatchedPublicGraph,
};
