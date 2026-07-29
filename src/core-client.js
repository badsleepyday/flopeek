"use strict";

// v3 adds an explicit last-complete read so a native coordinator can recover
// from SQLite without reaching into the legacy JSON graph cache.
const CORE_CLIENT_SCHEMA = "flopeek-core-client/v3";

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
