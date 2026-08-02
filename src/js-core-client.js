"use strict";

const { CORE_CLIENT_SCHEMA, assertCoreClient } = require("./core-client");
const { createRepositoryScanner } = require("./scanner");
const { canonicalRealpath } = require("./canonical-path");
const {
  findNodes,
  getAgentBootstrap,
  getChangeImpact,
  getChangedContexts,
  getContextCard,
  getEntryFlows,
  getFlowContextCard,
  getFlowProjection,
  getGraphDelta: calculateGraphDelta,
  availableGraphDelta,
  latestAvailableGraphDelta,
  getNodeDetails,
  getRelatedTests,
  getRequestFlows,
  projectView,
  resolveContextRef,
} = require("./graph-service");

function createJsCoreClient() {
  const scanners = new Map();
  const scannerKey = (root, scanOptions) => {
    const optionsForKey = Object.fromEntries(Object.entries(scanOptions)
      .filter(([key, value]) => key !== "changedPaths" && typeof value !== "function")
      .sort(([left], [right]) => left.localeCompare(right)));
    return `${canonicalRealpath(root)}:${JSON.stringify(optionsForKey)}`;
  };
  const scan = (root, options = {}) => {
    const { changedPaths = null, ...scannerOptions } = options;
    const key = scannerKey(root, scannerOptions);
    let scanner = scanners.get(key);
    if (!scanner) {
      scanner = createRepositoryScanner(root, scannerOptions);
      scanners.set(key, scanner);
    }
    return scanner.scan(changedPaths);
  };
  return assertCoreClient(Object.freeze({
    schemaVersion: CORE_CLIENT_SCHEMA,
    implementation: "javascript",
    scan,
    refresh: scan,
    getLastCompleteGraph: async () => null,
    materializeGraph: async (graph) => graph,
    getScanStatus: (graph, options = {}) => getAgentBootstrap(graph, options),
    getProjectOverview: (graph, options = {}) => projectView(graph, options),
    findNodes: (graph, options = {}) => findNodes(graph, options),
    getNode: (graph, id) => getNodeDetails(graph, id),
    getRequestFlows: (graph, endpoint = "", scope = "application") => getRequestFlows(graph, endpoint, scope),
    getEntryFlows: (graph, query = "", scope = "application") => getEntryFlows(graph, query, scope),
    getFlowProjection: (graph, flowId, scope = "application", options = {}) => getFlowProjection(graph, flowId, scope, options),
    getFlowContextCard: (graph, flowId, format = "json", scope = "application", options = {}) => getFlowContextCard(graph, flowId, format, scope, options),
    getChangeImpact: (graph, changedPaths, options = {}) => getChangeImpact(graph, changedPaths, options),
    getGraphDelta: (graph, options = {}) => {
      const fromVersion = Number.isSafeInteger(options.fromVersion) ? options.fromVersion : undefined;
      const toVersion = Number.isSafeInteger(options.toVersion) ? options.toVersion : undefined;
      const retained = fromVersion !== undefined && toVersion !== undefined
        ? availableGraphDelta(graph, fromVersion, toVersion)
        : latestAvailableGraphDelta(graph);
      if (retained) return retained;
      return options.previousGraph ? calculateGraphDelta(options.previousGraph, graph, options) : null;
    },
    getChangedContexts: (graph, options = {}) => getChangedContexts(graph, options),
    getRelatedTests: (graph, id) => getRelatedTests(graph, id),
    getContextCard: (graph, id, format = "json") => getContextCard(graph, id, format),
    resolveContextRef: (graph, contextRef) => resolveContextRef(graph, contextRef),
    close: async () => scanners.clear(),
  }));
}

module.exports = {
  createJsCoreClient,
};
