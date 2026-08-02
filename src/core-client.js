"use strict";

// v6 adds explicit graph materialization to the shared authority boundary.
// Handle-only product surfaces must ask the owning core for a verified public
// graph instead of reading graph.json or assuming Node still owns collections.
const CORE_CLIENT_SCHEMA = "flopeek-core-client/v6";

const CORE_CLIENT_METHODS = Object.freeze([
  "scan",
  "refresh",
  "getLastCompleteGraph",
  "materializeGraph",
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
