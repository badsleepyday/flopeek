"use strict";

const fs = require("node:fs");
const { CORE_CLIENT_SCHEMA, assertCoreClient } = require("./core-client");
const { createRepositoryScanner } = require("./scanner");
const {
  findNodes,
  getAgentBootstrap,
  getChangeImpact,
  getChangedContexts,
  getContextCard,
  getEntryFlows,
  getFlowContextCard,
  getFlowProjection,
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
    return `${fs.realpathSync(root)}:${JSON.stringify(optionsForKey)}`;
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
    getScanStatus: (graph, options = {}) => getAgentBootstrap(graph, options),
    getProjectOverview: (graph, options = {}) => projectView(graph, options),
    findNodes: (graph, options = {}) => findNodes(graph, options),
    getNode: (graph, id) => getNodeDetails(graph, id),
    getRequestFlows: (graph, endpoint = "", scope = "application") => getRequestFlows(graph, endpoint, scope),
    getEntryFlows: (graph, query = "", scope = "application") => getEntryFlows(graph, query, scope),
    getFlowProjection: (graph, flowId, scope = "application", options = {}) => getFlowProjection(graph, flowId, scope, options),
    getFlowContextCard: (graph, flowId, format = "json", scope = "application", options = {}) => getFlowContextCard(graph, flowId, format, scope, options),
    getChangeImpact: (graph, changedPaths, options = {}) => getChangeImpact(graph, changedPaths, options),
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
