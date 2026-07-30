"use strict";

// v5 adds graph-delta retrieval to the shared authority boundary. Product
// surfaces must not read JavaScript delta files when Rust/SQLite owns the
// current graph.
const CORE_CLIENT_SCHEMA = "flopeek-core-client/v5";

const CORE_CLIENT_METHODS = Object.freeze([
  "scan",
  "refresh",
  "getLastCompleteGraph",
  "getScanStatus",
  "getProjectOverview",
  "findNodes",
  "getNode",
  "getRequestFlows",
  "getEntryFlows",
  "getFlowProjection",
  "getFlowContextCard",
  "getChangeImpact",
  "getGraphDelta",
  "getChangedContexts",
  "getRelatedTests",
  "getContextCard",
  "resolveContextRef",
  "close",
]);

function assertCoreClient(client) {
  if (!client || client.schemaVersion !== CORE_CLIENT_SCHEMA) {
    throw new TypeError(`Core client must declare ${CORE_CLIENT_SCHEMA}.`);
  }
  for (const method of CORE_CLIENT_METHODS) {
    if (typeof client[method] !== "function") throw new TypeError(`Core client is missing ${method}().`);
  }
  return client;
}

module.exports = {
  CORE_CLIENT_METHODS,
  CORE_CLIENT_SCHEMA,
  assertCoreClient,
};
