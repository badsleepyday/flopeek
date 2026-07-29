"use strict";

// v4 adds Flow Context Cards to the shared query boundary, so product surfaces
// do not bypass the selected core when rendering a bounded flow handoff.
const CORE_CLIENT_SCHEMA = "flopeek-core-client/v4";

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
