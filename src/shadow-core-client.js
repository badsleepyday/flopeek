"use strict";

const path = require("node:path");
const { CORE_CLIENT_METHODS, CORE_CLIENT_SCHEMA, assertCoreClient } = require("./core-client");
const { createJsCoreClient } = require("./js-core-client");
const {
  publicGraphContext,
  submitStructuralFactBatch,
} = require("./structural-fact-adapter-host");

const STRUCTURAL_NODE_KINDS = new Set(["file", "symbol", "endpoint", "integration", "external", "command", "schedule"]);
const STRUCTURAL_EDGE_TYPES = new Set(["contains", "declares", "handles", "imports", "initializes", "calls", "queries", "queues", "requests", "uses", "declares-command-target", "schedules"]);

class ShadowComparisonError extends Error {
  constructor(message, comparison) {
    super(message);
    this.name = "ShadowComparisonError";
    this.code = "shadow-mismatch";
    this.comparison = comparison;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function structuralProjectionFromJs(graph) {
  const nodes = graph.nodes
    .filter((node) => STRUCTURAL_NODE_KINDS.has(node.kind))
    .map((node) => ({ id: node.id, kind: node.kind, nodeType: node.type, path: node.path }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => STRUCTURAL_EDGE_TYPES.has(edge.type) && ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target, type: edge.type }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return { nodes, edges };
}

function nodeMetadataProjection(graph) {
  return graph.nodes
    .filter((node) => ["file", "symbol", "endpoint", "integration", "external", "command", "schedule"].includes(node.kind))
    .map((node) => {
      const { id, kind: _kind, type: _type, path: _path, manualDescription: _manualDescription, ...metadata } = node;
      return { id, metadata };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function edgeMetadataProjection(graph) {
  return graph.edges
    .filter((edge) => STRUCTURAL_EDGE_TYPES.has(edge.type))
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      metadata: { confidence: edge.confidence, evidence: edge.evidence },
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function firstMismatch(expected, actual, field) {
  const count = Math.max(expected.length, actual.length);
  for (let index = 0; index < count; index += 1) {
    if (stableJson(expected[index]) !== stableJson(actual[index])) {
      return { field, index, expected: expected[index] ?? null, actual: actual[index] ?? null };
    }
  }
  return null;
}

function compareStructuralProjection(graph, nativeProjection) {
  const expected = structuralProjectionFromJs(graph);
  const actual = {
    nodes: [...(nativeProjection?.nodes || [])]
      .map((node) => ({ id: node.id, kind: node.kind, nodeType: node.nodeType, path: node.path }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...(nativeProjection?.edges || [])]
      .map((edge) => ({ source: edge.source, target: edge.target, type: edge.type }))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
  };
  const canonicalJson = stableJson({ edges: expected.edges, nodes: expected.nodes });
  const expectedNodeMetadata = nodeMetadataProjection(graph);
  const actualNodeMetadata = [...(nativeProjection?.nodes || [])]
    .filter((node) => ["file", "symbol", "endpoint", "integration", "external", "command", "schedule"].includes(node.kind))
    .map((node) => {
      const { manualDescription: _manualDescription, ...metadata } = node.metadata || {};
      return { id: node.id, metadata };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedEdgeMetadata = edgeMetadataProjection(graph);
  const actualEdgeMetadata = [...(nativeProjection?.edges || [])]
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      metadata: { confidence: edge.confidence, evidence: edge.evidence },
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const mismatch = firstMismatch(expected.nodes, actual.nodes, "nodes")
    || firstMismatch(expected.edges, actual.edges, "edges")
    || firstMismatch(expectedNodeMetadata, actualNodeMetadata, "nodeMetadata")
    || firstMismatch(expectedEdgeMetadata, actualEdgeMetadata, "edgeMetadata")
    || (nativeProjection?.canonicalJson === canonicalJson ? null : { field: "canonicalJson", expected: canonicalJson, actual: nativeProjection?.canonicalJson ?? null });
  return {
    schemaVersion: "flopeek-shadow-structural-comparison/v1",
    mode: "structural-subset",
    status: mismatch ? "mismatch" : "exact-match",
    expected: { nodeCount: expected.nodes.length, edgeCount: expected.edges.length },
    actual: { nodeCount: actual.nodes.length, edgeCount: actual.edges.length },
    mismatch,
    limitation: "This compares only the native structural shadow subset. It is not flopeek-core-compatibility/v1 graph, lifecycle, Context Ref, or query parity.",
  };
}

function createShadowCoreClient(options = {}) {
  const javascript = assertCoreClient(options.javascript || createJsCoreClient());
  const native = options.native;
  if (!native || typeof native.start !== "function" || typeof native.request !== "function") {
    throw new TypeError("Shadow core client requires a started-capable native protocol client.");
  }
  const persistStructuralGraph = options.persistStructuralGraph === true;
  let lastComparison = null;
  let lastStoreReceipt = null;
  const batchesByGraph = new WeakMap();
  const rootsByGraph = new WeakMap();
  const storeReceiptsByGraph = new WeakMap();
  const methods = Object.fromEntries(CORE_CLIENT_METHODS.map((method) => [method, javascript[method].bind(javascript)]));
  methods.scan = async (root, optionsForScan = {}) => {
    await native.start();
    const { graph, batch } = await submitStructuralFactBatch(native, root, { scanner: optionsForScan });
    const nativeProjection = await native.request("assembleStructuralGraph", batch);
    const comparison = compareStructuralProjection(graph, nativeProjection);
    lastComparison = comparison;
    if (comparison.status !== "exact-match") {
      throw new ShadowComparisonError(`Native structural shadow mismatch at ${comparison.mismatch.field}[${comparison.mismatch.index}].`, comparison);
    }
    if (persistStructuralGraph) {
      lastStoreReceipt = await native.request("persistStructuralGraph", {
        ...batch,
        projectRoot: path.resolve(root),
      });
    } else {
      lastStoreReceipt = null;
    }
    // The structural batch is prepared before the JavaScript oracle assembles
    // its public graph, so its initial flowContext version is the scanner's
    // pre-promotion value (normally zero). Native query parity must use the
    // exact public version returned by that assembly; otherwise a valid
    // current Context Ref is misclassified as targeting a future graph.
    //
    // Replace the pre-assembly publicGraphContext with the exact oracle
    // envelope as well. Native authoritative lifecycle creates its own
    // versioned state; shadow mode must instead compare and query the public
    // JavaScript graph that was actually returned to its caller.
    const queryBatch = {
      ...batch,
      flowContext: { ...batch.flowContext, graphVersion: graph.state.graphVersion },
      publicGraphContext: publicGraphContext(graph),
    };
    batchesByGraph.set(graph, queryBatch);
    rootsByGraph.set(graph, path.resolve(root));
    if (lastStoreReceipt) storeReceiptsByGraph.set(graph, lastStoreReceipt);
    return graph;
  };
  methods.getLastCompleteGraph = javascript.getLastCompleteGraph.bind(javascript);
  methods.materializeGraph = javascript.materializeGraph.bind(javascript);
  // Shadow refresh uses the same bridge as a scan while carrying the changed
  // path hint through to the fact adapter. Native lifecycle ownership is
  // intentionally tested by NativeCoreClient; this client remains an oracle
  // comparison surface until every public query has a native counterpart.
  methods.refresh = async (root, optionsForRefresh = {}) => methods.scan(root, optionsForRefresh);
  return assertCoreClient(Object.freeze({
    schemaVersion: CORE_CLIENT_SCHEMA,
    implementation: "shadow",
    ...methods,
    getLastShadowComparison: () => lastComparison,
    getLastNativeStoreReceipt: () => lastStoreReceipt,
    getNativeRelatedTests: async (graph, id) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("getRelatedTests", { batch, nodeId: id });
    },
    getNativeFlows: async (graph) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("assembleNativeFlows", { batch });
    },
    createNativeContextRef: async (graph, kind, contextId) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("createContextRef", { batch, kind, contextId });
    },
    getNativeFlowLensCore: async (graph, flowId, maxSteps = 12) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("getNativeFlowLensCore", { batch, flowId, maxSteps });
    },
    getNativeNodeContextCard: async (graph, nodeId) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("getNativeNodeContextCard", { batch, nodeId });
    },
    getNativeFlowContextCard: async (graph, flowId, maxSteps = 12) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("getNativeFlowContextCard", { batch, flowId, maxSteps });
    },
    resolveNativeContextRef: async (graph, contextRef) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("resolveNativeContextRef", {
        batch,
        contextRef,
        projectRoot: rootsByGraph.get(graph),
      });
    },
    getNativeStructuralDelta: async (previousGraph, graph) => {
      const previousBatch = batchesByGraph.get(previousGraph);
      const batch = batchesByGraph.get(graph);
      const previousReceipt = storeReceiptsByGraph.get(previousGraph);
      const receipt = storeReceiptsByGraph.get(graph);
      if (!previousBatch || !batch || !previousReceipt || !receipt) throw new TypeError("Native structural delta requires two persisted graphs returned by this ShadowCoreClient.scan().");
      if (rootsByGraph.get(previousGraph) !== rootsByGraph.get(graph)) throw new TypeError("Native structural delta requires graphs from the same project root.");
      await native.start();
      return native.request("getNativeStructuralDelta", {
        projectRoot: rootsByGraph.get(graph),
        projectId: batch.projectId,
        fromGraphVersion: previousReceipt.graphVersion,
        toGraphVersion: receipt.graphVersion,
      });
    },
    getNativePublicGraphSnapshot: async (graph) => {
      const batch = batchesByGraph.get(graph);
      const receipt = storeReceiptsByGraph.get(graph);
      if (!batch || !receipt) throw new TypeError("Native public graph snapshot requires a persisted graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("getNativePublicGraphSnapshot", {
        projectRoot: rootsByGraph.get(graph),
        projectId: batch.projectId,
        graphVersion: receipt.graphVersion,
        // Structural graph versions deliberately exclude observational
        // envelope fields such as state.updatedAt. Send the current envelope
        // only for this current-graph read; retained snapshots remain backed
        // by their persisted payload.
        publicGraphContext: batch.publicGraphContext,
      });
    },
    getNativeEphemeralPublicGraph: async (graph) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native public graph requires a graph returned by this ShadowCoreClient.scan().");
      await native.start();
      return native.request("assembleNativePublicGraph", { batch });
    },
    getNativePublicGraphDelta: async (previousGraph, graph) => {
      const previousBatch = batchesByGraph.get(previousGraph);
      const batch = batchesByGraph.get(graph);
      const previousReceipt = storeReceiptsByGraph.get(previousGraph);
      const receipt = storeReceiptsByGraph.get(graph);
      if (!previousBatch || !batch || !previousReceipt || !receipt) throw new TypeError("Native public graph delta requires two persisted graphs returned by this ShadowCoreClient.scan().");
      if (rootsByGraph.get(previousGraph) !== rootsByGraph.get(graph)) throw new TypeError("Native public graph delta requires graphs from the same project root.");
      await native.start();
      return native.request("getNativePublicGraphDelta", {
        projectRoot: rootsByGraph.get(graph),
        projectId: batch.projectId,
        fromGraphVersion: previousReceipt.graphVersion,
        toGraphVersion: receipt.graphVersion,
      });
    },
    getNativeChangeImpact: async (graph, changedPaths, optionsForImpact = {}) => {
      const batch = batchesByGraph.get(graph);
      if (!batch) throw new TypeError("Native query shadow requires a graph returned by this ShadowCoreClient.scan().");
      const previousBatch = optionsForImpact.previousGraph ? batchesByGraph.get(optionsForImpact.previousGraph) : null;
      if (optionsForImpact.previousGraph && !previousBatch) throw new TypeError("Native historical impact requires a previous graph returned by this ShadowCoreClient.scan().");
      const previousStoreReceipt = optionsForImpact.useStoredPreviousGraph && optionsForImpact.previousGraph
        ? storeReceiptsByGraph.get(optionsForImpact.previousGraph)
        : null;
      if (optionsForImpact.useStoredPreviousGraph && !previousStoreReceipt) throw new TypeError("Native stored historical impact requires a persisted previous graph.");
      if (previousStoreReceipt && rootsByGraph.get(graph) !== rootsByGraph.get(optionsForImpact.previousGraph)) throw new TypeError("Native stored historical impact requires graphs from the same project root.");
      await native.start();
      return native.request("getChangeImpact", {
        batch,
        ...(previousStoreReceipt ? { projectRoot: rootsByGraph.get(graph), previousGraphVersion: previousStoreReceipt.graphVersion } : previousBatch ? { previousBatch } : {}),
        changedPaths: Array.isArray(changedPaths) ? changedPaths : [changedPaths],
        maxDepth: optionsForImpact.maxDepth,
      });
    },
    close: async () => native.close?.(),
  }));
}

module.exports = {
  ShadowComparisonError,
  compareStructuralProjection,
  createShadowCoreClient,
  structuralProjectionFromJs,
  nodeMetadataProjection,
  edgeMetadataProjection,
};
