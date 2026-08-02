"use strict";

const {
  attachFlowExtensions,
  attachNodeExtensions,
  attachNativeFlowContextCard,
  attachNativeProjectOverview,
  getAgentBootstrap,
  getChangedContexts,
  getContextCard,
  getFlowProjection,
  resolveContextRef,
} = require("./graph-service");

const NATIVE_CORE_EXTENSION_METHODS = Object.freeze([
  "getScanStatus",
  "attachProjectOverviewExtensions",
  "attachNodeExtensions",
  "attachFlowExtensions",
  "attachFlowContextCard",
  "getNonApplicationFlowProjection",
  "getNonApplicationFlowContextCard",
  "getEphemeralChangedContexts",
  "getFormattedContextCard",
  "resolveUnsupportedContextRef",
]);

function assertNativeCoreExtensionAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("Native core extensions require an adapter object.");
  for (const method of NATIVE_CORE_EXTENSION_METHODS) {
    if (typeof adapter[method] !== "function") throw new TypeError(`Native core extension adapter is missing ${method}().`);
  }
  return adapter;
}

// These functions decorate or present a graph already assembled by Rust.
// They never scan source, build graph topology, allocate graph versions, read
// SQLite, or answer the application-scope native query contract.
function createNativeCoreExtensionAdapter() {
  return assertNativeCoreExtensionAdapter(Object.freeze({
    getScanStatus: (graph, options = {}) => getAgentBootstrap(graph, options),
    attachProjectOverviewExtensions: (graph, coreView) => attachNativeProjectOverview(graph, coreView),
    attachNodeExtensions: (graph, detail) => attachNodeExtensions(graph, detail),
    attachFlowExtensions: (graph, lens) => attachFlowExtensions(graph, lens),
    attachFlowContextCard: (graph, card, lens) => attachNativeFlowContextCard(graph, card, lens),
    getNonApplicationFlowProjection: (graph, flowId, scope, options = {}) => getFlowProjection(graph, flowId, scope, options),
    getNonApplicationFlowContextCard: (graph, flowId, format, scope, options = {}) => getFlowContextCard(graph, flowId, format, scope, options),
    getEphemeralChangedContexts: (graph, options = {}) => getChangedContexts(graph, options),
    getFormattedContextCard: (graph, id, format) => getContextCard(graph, id, format),
    resolveUnsupportedContextRef: (graph, contextRef) => resolveContextRef(graph, contextRef),
  }));
}

module.exports = {
  NATIVE_CORE_EXTENSION_METHODS,
  assertNativeCoreExtensionAdapter,
  createNativeCoreExtensionAdapter,
};
