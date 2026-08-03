"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CORE_CLIENT_SCHEMA, assertCoreClient } = require("./core-client");
const { assertNativeCoreExtensionAdapter, createNativeCoreExtensionAdapter } = require("./native-core-extension-adapter");
const { resolveProjectIdentity } = require("./project-identity");
const { readRepositoryScope } = require("./scope");
const { canonicalRealpath } = require("./canonical-path");
let loadedStructuralFacts = null;
function structuralFacts() {
  loadedStructuralFacts ||= require("./structural-fact-adapter-host");
  return loadedStructuralFacts;
}

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

async function optionalNativeFlowQuery(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code === "missing-flow") return null;
    throw error;
  }
}

function nativeCancellationError() {
  const error = new Error("Native core scan was cancelled.");
  error.name = "AbortError";
  error.code = "FLOPEEK_NATIVE_SCAN_CANCELLED";
  return error;
}

function nativeGraphHandle(result) {
  const handle = result?.graphHandle;
  if (!handle || handle.schemaVersion !== "flopeek-native-graph-handle/v1"
    || typeof handle.projectId !== "string" || !handle.projectId
    || typeof handle.factsDigest !== "string" || !handle.factsDigest
    || handle.persistence !== "sqlite") {
    throw new TypeError("Native persistent lifecycle returned an invalid graph handle.");
  }
  return handle;
}

function nativeSessionGraphHandle(result) {
  const handle = result?.graphHandle;
  if (!handle || handle.schemaVersion !== "flopeek-native-session-graph-handle/v1"
    || typeof handle.projectId !== "string" || !handle.projectId
    || typeof handle.factsDigest !== "string" || !handle.factsDigest
    || handle.persistence !== "session-memory" || !Number.isSafeInteger(handle.publicGraphVersion)) {
    throw new TypeError("Native cache-disabled lifecycle returned an invalid session graph handle.");
  }
  return handle;
}

function isNativeGraphHandleOnly(graph) {
  return graph?.analysis?.graphState?.transport === "handle-only";
}

function nativeHandleOnlyGraph(result, validateHandle = nativeGraphHandle) {
  const envelope = result?.publicGraphEnvelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Native handle-only lifecycle returned no public graph envelope.");
  }
  for (const field of ["nodes", "edges", "flows", "diagnosticFlows"]) {
    if (Object.hasOwn(envelope, field)) {
      throw new Error("Native handle-only lifecycle must not transfer public graph collections.");
    }
  }
  const graph = {
    ...envelope,
    analysis: {
      ...(envelope.analysis || {}),
      graphState: {
        ...(envelope.analysis?.graphState || {}),
        transport: "handle-only",
        limitation: result?.publicGraphTransport?.limitation
          || "Public graph collections remain in the native SQLite session.",
      },
    },
  };
  validateHandle(result);
  return graph;
}

function requireMaterializedNativeGraph(graph, operation) {
  if (!isNativeGraphHandleOnly(graph)) return;
  throw new Error(`${operation}() requires a materialized public graph. Rescan without nativeGraphHandle to use JavaScript extension or export surfaces.`);
}

function nativeFlowMetadataGraph(graph, lens) {
  if (!isNativeGraphHandleOnly(graph)) return graph;
  const nodes = [...new Map((lens?.steps || [])
    .map((step) => step?.node)
    .filter((node) => node?.id)
    .map((node) => [node.id, node])).values()];
  const edges = [...new Map((lens?.steps || []).flatMap((step) => [
    step?.transition,
    ...(Array.isArray(step?.alternativeIncomingTransitions) ? step.alternativeIncomingTransitions : []),
  ]).filter((edge) => edge?.sourceId && edge?.targetId && edge?.type).map((edge) => [edge.id, {
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    type: edge.type,
    confidence: edge.confidence,
    evidence: edge.evidence,
  }])).values()];
  // This facade is strictly bounded to the selected Flow Lens. It gives local
  // audit metadata enough static evidence without recreating a repository graph.
  return { ...graph, nodes, edges, flows: lens?.flow ? [lens.flow] : [], diagnosticFlows: lens?.flow ? [lens.flow] : [] };
}

async function prepareRustNativeBatch(native, inputRoot, options = {}) {
  const root = canonicalRealpath(inputRoot);
  const request = (changedPaths) => native.request("nativeJsStructuralFacts", {
    projectRoot: root,
    ...(Array.isArray(changedPaths) ? { changedPaths } : {}),
    ...(options.ephemeral === true ? { ephemeral: true, sessionProjectId: options.sessionProjectId } : {}),
  });
  let response;
  try {
    response = await request(options.changedPaths);
  } catch (error) {
    // A config, directory, or unsupported file event invalidates the session's
    // candidate set. Reconcile explicitly; never retain a partial set merely
    // to preserve an incremental fast path.
    if (error?.code !== "native-session-reconcile-required") throw error;
    response = await request(null);
  }
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

function reuseRustNativeBatch(previous) {
  const batch = previous?.batch;
  if (!batch || !Array.isArray(batch.records)) {
    throw new Error("Rust native no-op refresh requires the previous complete structural fact batch.");
  }
  return {
    batch,
    response: null,
    prepared: {
      root: null,
      sourceRecords: batch.records.map((record) => ({
        relativePath: record.relativePath,
        sourceHash: record.sourceHash,
        sourceScope: record.sourceScope,
        language: record.language,
      })),
      graphContext: previous.graphContext || null,
      refresh: {
        strategy: "incremental-content-analysis",
        mode: "incremental",
        analyzedFiles: 0,
        reusedFiles: batch.records.length,
        removedFiles: 0,
        changedPaths: [],
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
  const native = options.native
    || require("./native-incremental-coordinator").createNativeIncrementalSession(null, options.nativeOptions);
  if (!native || typeof native.start !== "function" || typeof native.request !== "function") {
    throw new TypeError("Native core client requires a JSONL native protocol session.");
  }
  const batches = new WeakMap();
  const roots = new WeakMap();
  const materializedGraphs = new WeakMap();
  const cacheDisabledProjectIds = new Map();
  const scanners = new Map();
  const nativeSourceStates = new Map();
  const persistentBatches = new WeakMap();
  // The JavaScript-source compatibility path still uses the native
  // cache-disabled lifecycle. Retain its prior public graph for the same
  // versioned reuse-envelope contract as strict Rust sessions; this is
  // process-local and never creates repository metadata.
  const ephemeralBatches = new WeakMap();
  const sourceAuthority = options.sourceAuthority === "rust" ? "rust" : "javascript-parser-host";
  const cacheDisabledProjectId = (root) => {
    const canonicalRoot = canonicalRealpath(root);
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
      // `nativeGraphHandle` changes only the response transport. It must not
      // fork the underlying Rust source session or prevent an explicit later
      // compatibility snapshot from recognizing its preceding graph handle.
      .filter(([key, value]) => key !== "onProfile" && key !== "changedPaths" && key !== "nativeGraphHandle" && typeof value !== "function")
      .sort(([left], [right]) => left.localeCompare(right)));
    return `${cacheDisabled ? "session" : "persistent"}:${canonicalRealpath(root)}:${JSON.stringify(optionsForKey)}`;
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
    if (batch.schemaVersion === "flopeek-native-session-graph-handle/v1") {
      return native.request(method, { ...params, sessionGraph: batch });
    }
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
      if (batch.schemaVersion === "flopeek-native-graph-handle/v1") {
        const current = await native.request("getNativeCurrentPublicGraph", {
          projectRoot: root,
          projectId: batch.projectId,
        });
        let restored;
        try {
          restored = nativeGraphHandle(current);
        } catch {
          throw error;
        }
        batches.set(graph, restored);
        return native.request(method, {
          ...params,
          projectRoot: root,
          projectId: restored.projectId,
          factsDigest: restored.factsDigest,
        });
      }
      return native.request(method, { ...params, batch });
    }
  };
  const extensionAdapterMethods = Object.freeze([
    "local-view-metadata",
    "local-flow-card-metadata",
    "non-application-flow-projection",
    "non-application-flow-context-card",
    "ephemeral-changed-contexts",
    "formatted-context-card",
    "unsupported-context-ref",
  ]);

  const scan = async (root, scanOptions = {}) => {
    let persistentMutationStarted = false;
    try {
      const profile = typeof scanOptions.onProfile === "function" ? scanOptions.onProfile : null;
      const report = (phase, started, extra = {}) => profile?.({ phase, milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000, ...extra });
      const scanStarted = process.hrtime.bigint();
      const cacheDisabled = scanOptions.persistIdentity === false;
      const key = scannerKey(root, scanOptions, cacheDisabled);
      let scanner = sourceAuthority === "rust" ? null : scanners.get(key);
      const scannerReused = sourceAuthority === "rust" ? nativeSourceStates.has(key) : Boolean(scanner);
      if (sourceAuthority !== "rust" && !scanner) {
        scanner = require("./scanner").createRepositoryScanner(root, {
        ...scanOptions,
        persistIdentity: !cacheDisabled,
        ...(cacheDisabled ? { sessionProjectId: cacheDisabledProjectId(root) } : {}),
        });
        scanners.set(key, scanner);
      }
      const authorityRoot = scanner?.root || canonicalRealpath(root);
      const previous = sourceAuthority === "rust"
        ? nativeSourceStates.get(key)
        : cacheDisabled
          ? ephemeralBatches.get(scanner)
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
      // A Rust-owned no-cache scan keeps the complete source-to-graph path in
      // the native session.  Besides enforcing the no-SQLite contract, this
      // avoids sending a full batch Rust -> Node -> Rust just to build a graph.
      const directRustBounded = sourceAuthority === "rust" && scanOptions.nativeBounded === true;
      const directRustPersistent = sourceAuthority === "rust" && !cacheDisabled && !directRustBounded;
      const directRustEphemeral = sourceAuthority === "rust" && cacheDisabled && !directRustBounded;
      const nativeGraphHandleOnly = (directRustPersistent || directRustEphemeral) && scanOptions.nativeGraphHandle === true;
      let directEphemeralResult = null;
      const preparation = directRustBounded
        ? await (async () => {
          await nativeStartPromise;
          throwIfNativeScanCancelled(scanOptions.signal);
          directEphemeralResult = await requestNativeWithSignal(native, scanOptions.signal, "refreshNativeProject", {
            projectRoot: authorityRoot,
            sessionProjectId: scanOptions.sessionProjectId || cacheDisabledProjectId(authorityRoot),
            ...(typeof scanOptions.packagePath === "string" && scanOptions.packagePath.trim()
              ? { packagePath: scanOptions.packagePath.trim() }
              : {}),
            limits: {
              ...(Number.isSafeInteger(scanOptions.maxFiles) ? { maxFiles: scanOptions.maxFiles } : {}),
              ...(Number.isSafeInteger(scanOptions.maxBytes) ? { maxBytes: scanOptions.maxBytes } : {}),
              ...(Number.isSafeInteger(scanOptions.timeBudgetMs) ? { budgetMs: scanOptions.timeBudgetMs } : {}),
            },
          });
          if (!directEphemeralResult?.batch || typeof directEphemeralResult.batch !== "object") {
            throw new Error("Native bounded source scan returned no structural fact batch.");
          }
          return {
            batch: directEphemeralResult.batch,
            prepared: { sourceRecords: directEphemeralResult.batch.records || [], graphContext: null },
            preparedFacts: null,
            publicEnvelope: null,
          };
        })()
        : directRustPersistent
        ? await (async () => {
          await nativeStartPromise;
          throwIfNativeScanCancelled(scanOptions.signal);
          const request = (changedPaths) => {
            persistentMutationStarted = true;
            return requestNativeWithSignal(native, scanOptions.signal, "refreshNativePersistentProject", {
              projectRoot: authorityRoot,
              ...(Array.isArray(changedPaths) ? { changedPaths } : {}),
              retainPublicSnapshot: true,
              ...(nativeGraphHandleOnly ? { returnPublicGraph: false } : {}),
            });
          };
          try {
            directEphemeralResult = await request(scanOptions.changedPaths);
          } catch (error) {
            if (error?.code === "native-source-adapter-unavailable") {
              const separator = typeof error.message === "string" ? error.message.lastIndexOf(":") : -1;
              error.unsupportedPaths = separator >= 0
                ? error.message.slice(separator + 1).replace(/\.$/, "").split(",").map((value) => value.trim()).filter(Boolean)
                : [];
            }
            if (error?.code !== "native-session-reconcile-required") throw error;
            directEphemeralResult = await request(null);
          }
          const handle = nativeGraphHandle(directEphemeralResult);
          return {
            batch: handle,
            prepared: {
              sourceRecords: [],
              graphContext: null,
              refresh: directEphemeralResult.sourceRefresh || null,
            },
            preparedFacts: null,
            publicEnvelope: null,
          };
        })()
        : directRustEphemeral
        ? await (async () => {
          await nativeStartPromise;
          throwIfNativeScanCancelled(scanOptions.signal);
          const directParams = {
            projectRoot: authorityRoot,
            sessionProjectId: cacheDisabledProjectId(authorityRoot),
            ...(Array.isArray(scanOptions.changedPaths) ? { changedPaths: scanOptions.changedPaths } : {}),
            ...(nativeGraphHandleOnly ? { returnPublicGraph: false } : {}),
          };
          try {
            directEphemeralResult = await requestNativeWithSignal(native, scanOptions.signal, "refreshNativeJsSessionGraph", directParams);
          } catch (error) {
            if (error?.code !== "native-session-reconcile-required") throw error;
            directEphemeralResult = await requestNativeWithSignal(native, scanOptions.signal, "refreshNativeJsSessionGraph", {
              projectRoot: authorityRoot,
              sessionProjectId: cacheDisabledProjectId(authorityRoot),
            });
          }
          const handle = nativeSessionGraphHandle(directEphemeralResult);
          return {
            batch: handle,
            prepared: { sourceRecords: [], graphContext: null },
            preparedFacts: null,
            publicEnvelope: null,
          };
          })()
        : sourceAuthority === "rust"
          ? previous && Array.isArray(scanOptions.changedPaths) && scanOptions.changedPaths.length === 0
            ? reuseRustNativeBatch(previous)
            : await prepareRustNativeBatch(native, authorityRoot, { previous, changedPaths: scanOptions.changedPaths })
          : structuralFacts().prepareStructuralFactBatch(scanner, scanOptions.changedPaths, {
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
      const nativeStartStats = sessionAlreadyRunning ? null : native.getLastStartStats?.();
      report("native-core-session-start", sessionStarted, {
        alreadyRunning: sessionAlreadyRunning,
        overlappedWithFactPreparation: !sessionAlreadyRunning,
        // The elapsed phase can include Rust source preparation because both
        // run concurrently. Keep the actual process protocol readiness
        // separate so cold-start telemetry remains attributable.
        processSpawnMs: nativeStartStats?.spawnedMilliseconds ?? null,
        processReadyMs: nativeStartStats?.readyMilliseconds ?? null,
        healthRequestId: nativeStartStats?.healthRequestId ?? null,
      });
      const lifecycleStarted = process.hrtime.bigint();
      let result;
      let usedFactPatch = false;
      if (directEphemeralResult) {
        result = directEphemeralResult;
      } else if (cacheDisabled) {
        if (!batch) throw new Error("Cache-disabled native lifecycle requires a complete fact batch.");
        result = await requestNativeWithSignal(native, scanOptions.signal, "refreshNativeSessionGraph", batch);
      } else {
        const patch = previous
          ? sourceAuthority === "rust"
            ? structuralFacts().createStructuralFactPatch(previous.batch, batch)
            : structuralFacts().createStructuralFactPatchFromPrepared(previous.batch, publicEnvelope, prepared, preparedFacts, {
              graphContextUnchanged: previous.graphContext === prepared.graphContext,
            })
          : null;
        if (patch) {
          try {
            usedFactPatch = true;
            persistentMutationStarted = true;
            result = await requestNativeWithSignal(native, scanOptions.signal, "persistNativePublicGraphPatch", { ...patch, projectRoot: authorityRoot });
            batch = structuralFacts().materializeStructuralFactPatch(previous.batch, patch, result?.factsDigest);
          } catch (error) {
            // A cache miss is safe and expected after a cache clear, native
            // upgrade, or another process promotes a different graph.  Only
            // these compatibility misses may retry with the complete JS fact
            // batch; malformed patches remain loud failures.
            if (!["structural-fact-patch-miss", "unsupported-structural-fact-patch", "unknown-method"].includes(error?.code)) throw error;
            usedFactPatch = false;
            profile?.({ phase: "native-core-fact-patch-fallback", milliseconds: 0, reason: error.code });
            batch = structuralFacts().createStructuralFactBatchFromPrepared(publicEnvelope, prepared, preparedFacts);
            persistentMutationStarted = true;
            result = await requestNativeWithSignal(native, scanOptions.signal, "persistNativePublicGraph", { ...batch, projectRoot: authorityRoot });
          }
        } else {
          if (!batch) batch = structuralFacts().createStructuralFactBatchFromPrepared(publicEnvelope, prepared, preparedFacts);
          persistentMutationStarted = true;
          result = await requestNativeWithSignal(native, scanOptions.signal, "persistNativePublicGraph", { ...batch, projectRoot: authorityRoot });
        }
      }
      const lifecycleMilliseconds = Number(process.hrtime.bigint() - lifecycleStarted) / 1_000_000;
      // A handle-only graph intentionally has no public collections. Treat the
      // absence of `nodes` as a defensive marker too, so a future envelope
      // schema cannot accidentally be used as the base of a JS-side patch.
      const previousIsHandleOnly = directRustPersistent && previous?.graph
        && (isNativeGraphHandleOnly(previous.graph) || !Array.isArray(previous.graph.nodes));
      if (!result?.graph && result?.publicGraphReuse && previous?.graph && !previousIsHandleOnly) {
        result = {
          ...result,
          graph: materializeReusedPublicGraph(previous.graph, result.publicGraphReuse),
        };
        profile?.({ phase: "native-core-public-graph-reuse", milliseconds: 0, transport: "envelope" });
      }
      if (!result?.graph && result?.publicGraphPatch && previous?.graph && !previousIsHandleOnly) {
        const patchStats = publicGraphPatchStats(result.publicGraphPatch);
        result = {
          ...result,
          graph: materializePatchedPublicGraph(previous.graph, result.publicGraphPatch),
        };
        profile?.({ phase: "native-core-public-graph-patch", milliseconds: 0, transport: "collections", ...patchStats });
      }
      if (nativeGraphHandleOnly) {
        result = { ...result, graph: nativeHandleOnlyGraph(result, directRustEphemeral ? nativeSessionGraphHandle : nativeGraphHandle) };
        profile?.({ phase: "native-core-public-graph-handle", milliseconds: 0, transport: "handle-only" });
      } else if (!result?.graph && previousIsHandleOnly) {
        // Switching back from the explicit query-only mode is the one case
        // where Node intentionally asks for a complete compatibility snapshot.
        const handle = nativeGraphHandle(result);
        const snapshot = await requestNativeWithSignal(native, scanOptions.signal, "getNativeCurrentPublicGraph", {
          projectRoot: authorityRoot,
          projectId: handle.projectId,
        });
        if (!snapshot?.graph) throw new Error("Native core could not restore the requested public graph snapshot.");
        result = { ...result, graph: snapshot.graph };
        profile?.({ phase: "native-core-public-graph-snapshot", milliseconds: 0, transport: "explicit-compatibility-snapshot" });
      }
      // A declared empty changed-path set is a real session no-op. Rust keeps
      // the graph payload, while this boundary owns the precise event-driven
      // refresh telemetry exposed to product surfaces.
      if (sourceAuthority === "rust" && preparation.response === null && result?.graph?.analysis) {
        result.graph.analysis.refresh = prepared.refresh;
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
      if (directRustBounded && result.graph?.analysis) {
        result.graph.analysis.nativeBoundedDiscovery = result.boundedDiscovery || null;
      }
      const queryBatch = directRustPersistent
        ? nativeGraphHandle(result)
        : batch?.schemaVersion === "flopeek-native-session-graph-handle/v1"
          ? batch
          : structuralFacts().withNativePublicGraphVersion(batch, result.publicGraphVersion);
      batches.set(result.graph, queryBatch);
      roots.set(result.graph, cacheDisabled ? null : authorityRoot);
      const state = { batch: queryBatch, graphContext: prepared.graphContext, graph: result.graph };
      if (sourceAuthority === "rust") nativeSourceStates.set(key, state);
      else if (cacheDisabled) ephemeralBatches.set(scanner, state);
      else if (!cacheDisabled) persistentBatches.set(scanner, state);
      report("native-core-scan-total", scanStarted, { cacheDisabled, scannerReused });
      return result.graph;
    } catch (cause) {
      if (!persistentMutationStarted) throw cause;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.nativeAuthorityMutation = true;
      error.nativeAuthorityRoot = canonicalRealpath(root);
      throw error;
    }
    };

  const getNativeFlowContextCard = async (graph, flowId, format = "json", scope = "application", queryOptions = {}) => {
    if (scope !== "application") return extensions.getNonApplicationFlowContextCard(graph, flowId, format, scope, queryOptions);
    const maxSteps = queryOptions.maxSteps;
    const coreCard = await optionalNativeFlowQuery(() => requestNativeQuery("getNativeFlowContextCard", graph, { flowId, maxSteps }));
    if (!coreCard) return null;
    const lens = await requestNativeQuery("getNativeFlowLensCore", graph, { flowId, maxSteps });
    const metadataGraph = nativeFlowMetadataGraph(graph, lens);
    const card = extensions.attachFlowContextCard(metadataGraph, coreCard, extensions.attachFlowExtensions(metadataGraph, lens));
    return require("./context-card").createContextPacket(card, format);
  };

  return assertCoreClient(Object.freeze({
    schemaVersion: CORE_CLIENT_SCHEMA,
    implementation: "native-experimental",
    backendAuthority: "rust-sqlite",
    sourceAuthority,
    parserHost: sourceAuthority === "rust" ? "rust-tree-sitter-source/v19" : "javascript-structural-fact-batch/v1",
    factEnvelopeHost: sourceAuthority === "rust" ? "rust-native-structural-batch/v1" : "javascript-structural-fact-batch/v1",
    extensionAdapterMethods,
    scan,
    refresh: async (root, refreshOptions = {}) => {
      const { changedPaths = null, ...scanOptions } = refreshOptions;
      return scan(root, { ...scanOptions, changedPaths });
    },
    getLastCompleteGraph: async (root) => {
      const durableRoot = canonicalRealpath(root);
      // Authority recovery is a bounded control-plane read, not a retry of
      // the timed-out mutation. Give cold process startup and the SQLite read
      // their own deadline while preserving fail-closed behavior if either
      // operation cannot establish the last-complete graph.
      const recoveryOptions = { timeoutMs: native.recoveryTimeoutMs };
      await native.start(recoveryOptions);
      let result;
      try {
        result = await native.request("getNativeCurrentPublicGraph", {
          projectRoot: durableRoot,
          projectId: durableProjectId(durableRoot),
        }, recoveryOptions);
      } catch (error) {
        // A repository with no promoted SQLite graph has no last-complete
        // authority yet. Preserve the CoreClient null contract; transport,
        // store-open, and integrity failures remain loud.
        if (error?.code === "missing-native-graph") return null;
        throw error;
      }
      if (!result?.graph) return null;
      let graphHandle;
      try {
        graphHandle = nativeGraphHandle(result);
      } catch {
        return null;
      }
      batches.set(result.graph, graphHandle);
      roots.set(result.graph, durableRoot);
      return result.graph;
    },
    materializeGraph: async (graph) => {
      if (!isNativeGraphHandleOnly(graph)) return graph;
      let pending = materializedGraphs.get(graph);
      if (!pending) {
        pending = (async () => {
          const handle = requireBatch(graph);
          const root = roots.get(graph);
          const result = await native.request("materializeNativeGraph", root
            ? { projectRoot: root, graphHandle: handle }
            : { sessionGraph: handle });
          const materialized = result?.graph;
          if (result?.schemaVersion !== "flopeek-native-materialized-graph/v1"
            || !materialized || !Array.isArray(materialized.nodes)
            || !Array.isArray(materialized.edges) || !Array.isArray(materialized.flows)
            || materialized.project?.projectId !== handle.projectId
            || materialized.state?.graphVersion !== handle.publicGraphVersion
            || materialized.analysis?.graphState?.materialFingerprint !== handle.factsDigest) {
            throw new Error("Native core returned a materialized graph that does not match its verified handle.");
          }
          // The handle-only envelope is the exact public lifecycle response
          // already owned by Node. Native supplies only the verified heavy
          // collections; retain the original scan telemetry and state fields.
          const compatible = {
            ...graph,
            nodes: materialized.nodes,
            edges: materialized.edges,
            flows: materialized.flows,
            diagnosticFlows: materialized.diagnosticFlows,
          };
          compatible.analysis = {
            ...compatible.analysis,
            graphState: {
              ...compatible.analysis?.graphState,
              transport: "materialized",
            },
          };
          batches.set(compatible, handle);
          roots.set(compatible, root || null);
          return compatible;
        })();
        materializedGraphs.set(graph, pending);
      }
      try {
        return await pending;
      } catch (error) {
        materializedGraphs.delete(graph);
        throw error;
      }
    },
    getScanStatus: async (graph, queryOptions = {}) => requestNativeQuery("getNativeScanStatus", graph, {
      scanOutcome: queryOption(queryOptions, "scanOutcome"),
      project: queryOption(queryOptions, "project"),
    }),
    getProjectOverview: async (graph, queryOptions = {}) => {
      const coreView = await requestNativeQuery("getNativeProjectOverviewCore", graph, {
        mode: queryOption(queryOptions, "mode"),
        scope: queryOption(queryOptions, "scope"),
        level: queryOption(queryOptions, "level"),
        focus: queryOption(queryOptions, "focus"),
        maxNodes: queryOption(queryOptions, "maxNodes"),
        maxEdges: queryOption(queryOptions, "maxEdges"),
      });
      return extensions.attachProjectOverviewExtensions(graph, coreView);
    },
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
      const lens = await optionalNativeFlowQuery(() => requestNativeQuery("getNativeFlowLensCore", graph, {
        flowId,
        maxSteps: queryOptions.maxSteps,
      }));
      if (!lens) return null;
      return extensions.attachFlowExtensions(nativeFlowMetadataGraph(graph, lens), lens);
    },
    getFlowContextCard: getNativeFlowContextCard,
    getChangeImpact: async (graph, changedPaths, queryOptions = {}) => {
      const impact = await requestNativeQuery("getChangeImpact", graph, {
        changedPaths: Array.isArray(changedPaths) ? changedPaths : [changedPaths],
        maxDepth: safeIntegerOption(queryOptions, "maxDepth"),
        previousGraphVersion: safeIntegerOption(queryOptions, "previousGraphVersion"),
      });
      // JSONL omits JavaScript `undefined`, but the in-process CoreClient
      // contract historically exposes this optional field even when a result
      // is not truncated. Restore it at the adapter boundary.
      if (!Object.hasOwn(impact, "truncated")) impact.truncated = undefined;
      return impact;
    },
    getGraphDelta: async (graph, queryOptions = {}) => {
      const root = roots.get(graph);
      if (!root) return graph.analysis?.latestDelta || null;
      const handle = requireBatch(graph);
      const toGraphVersion = safeIntegerOption(queryOptions, "toVersion")
        ?? graph.state.graphVersion;
      const fromGraphVersion = safeIntegerOption(queryOptions, "fromVersion")
        ?? toGraphVersion - 1;
      if (fromGraphVersion < 1 || toGraphVersion <= fromGraphVersion) return null;
      return native.request("getNativePublicGraphDelta", {
        projectRoot: root,
        projectId: handle.projectId,
        fromGraphVersion,
        toGraphVersion,
      });
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
    ...(options.experimentalIdentityV2 === true ? {
      getNodeIdentity: async (graph, nodeIdOrUid) => requestNativeQuery(
        "getNodeIdentity",
        graph,
        String(nodeIdOrUid || "").startsWith("n_")
          ? { nodeUid: nodeIdOrUid, experimentalIdentityV2: true }
          : { nodeId: nodeIdOrUid, experimentalIdentityV2: true },
      ),
      searchNodeIdentities: async (graph, query, limit = 20) => requestNativeQuery(
        "searchNodeIdentities",
        graph,
        { query, limit, experimentalIdentityV2: true },
      ),
      createContextRefV2: async (graph, nodeId) => requestNativeQuery("createContextRefV2", graph, {
        kind: "node",
        contextId: nodeId,
        experimentalIdentityV2: true,
      }),
    } : {}),
    getContextCard: async (graph, id, format = "json") => {
      if (format !== "json" || (!isNativeGraphHandleOnly(graph) && !graph.nodes.some((node) => node.id === id))) {
        return extensions.getFormattedContextCard(graph, id, format);
      }
      const card = await requestNativeQuery("getNativeNodeContextCard", graph, { nodeId: id });
      return require("./context-card").createContextPacket(card, format);
    },
    resolveContextRef: async (graph, contextRef) => {
      const root = roots.get(graph);
      if (!root) return extensions.resolveUnsupportedContextRef(graph, contextRef);
      let parsed;
      try {
        parsed = require("./context-card").parseContextRef(contextRef);
      } catch {
        return extensions.resolveUnsupportedContextRef(graph, contextRef);
      }
      // Diagnostic-only Flow Context Refs need the legacy all-scope projection
      // until that native scope has its public extension adapter.
      if (parsed.kind === "flow" && !isNativeGraphHandleOnly(graph)
        && !graph.flows.some((flow) => flow.id === parsed.contextId)) {
        return extensions.resolveUnsupportedContextRef(graph, contextRef);
      }
      const resolution = await requestNativeQuery("resolveNativeContextRef", graph, {
        contextRef,
      });
      if (!resolution.card || parsed.kind !== "flow" || !["current", "stale"].includes(resolution.status)) return resolution;
      const packet = await getNativeFlowContextCard(graph, parsed.contextId);
      if (!packet?.card) return resolution;
      return { ...resolution, resolvedRef: packet.card.contextRef, card: packet.card };
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
