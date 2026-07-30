"use strict";

const NATIVE_SURFACE_CONTRACT_SCHEMA = "flopeek-native-surface-contract/v1";
const HANDLE_SAFE = "native-handle-safe";
const MATERIALIZED = "requires-materialized-graph";
const BOUNDED = "bounded-native-projection";
const UNSUPPORTED = "unsupported-in-handle-mode";

const MCP_HANDLE_SAFE = new Set([
  "cancel_scan",
  "find_nodes",
  "get_agent_bootstrap",
  "get_agent_context",
  "get_context_card",
  "get_graph_delta",
  "get_change_impact",
  "get_node",
  "get_direct_dependencies",
  "get_related_tests",
  "get_scan_status",
  "refresh_graph",
  "resolve_context_ref",
]);

const MCP_BOUNDED = new Set([
  "get_entry_flows",
  "get_flow_context_card",
  "get_flow_projection",
  "get_project_overview",
  "get_request_flows",
  "get_view_projection",
]);

const SERVER_HANDLE_SAFE = new Set([
  "GET /api/agent-bootstrap",
  "GET /api/agent-context",
  "GET /api/context-card",
  "GET /api/context/resolve",
  "GET /api/delta",
  "GET /api/entry-flows",
  "GET /api/flow-context-card",
  "GET /api/flow-lens",
  "GET /api/impact",
  "GET /api/node",
  "GET /api/scan-status",
  "GET /api/search",
  "GET /api/view",
]);

function mcpSurfaceCategory(name) {
  if (MCP_HANDLE_SAFE.has(name)) return HANDLE_SAFE;
  if (MCP_BOUNDED.has(name)) return BOUNDED;
  return MATERIALIZED;
}

function serverSurfaceCategory(method, pathname) {
  return SERVER_HANDLE_SAFE.has(`${method} ${pathname}`) ? HANDLE_SAFE : MATERIALIZED;
}

module.exports = {
  BOUNDED,
  HANDLE_SAFE,
  MATERIALIZED,
  MCP_BOUNDED,
  MCP_HANDLE_SAFE,
  NATIVE_SURFACE_CONTRACT_SCHEMA,
  SERVER_HANDLE_SAFE,
  UNSUPPORTED,
  mcpSurfaceCategory,
  serverSurfaceCategory,
};
