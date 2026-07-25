"use strict";

const { createGraphDelta, materialFingerprint } = require("./graph-state");

const SESSION_GRAPH_STATE_SCHEMA = "flowpeek-session-graph-state/v1";

function advanceSessionGraph(graph, previousGraph = null, options = {}) {
  const fingerprint = materialFingerprint(graph);
  const unchanged = Boolean(previousGraph?.state?.materialFingerprint === fingerprint);
  const graphVersion = unchanged ? previousGraph.state.graphVersion : (previousGraph?.state?.graphVersion || 0) + 1;
  graph.state = {
    ...graph.state,
    graphVersion,
    materialFingerprint: fingerprint,
    updatedAt: new Date().toISOString(),
    status: unchanged ? "session-current" : "session-advanced",
  };
  const delta = previousGraph && graphVersion > previousGraph.state.graphVersion
    ? createGraphDelta(previousGraph, graph, {
      reason: options.reason || "session-refresh",
      changedPaths: options.changedPaths || graph.analysis?.refresh?.changedPaths || [],
    })
    : null;
  graph.analysis.graphState = {
    schemaVersion: SESSION_GRAPH_STATE_SCHEMA,
    status: unchanged ? "unchanged" : "advanced",
    persistence: "disabled",
    graphVersion,
    materialFingerprint: graph.state.materialFingerprint,
    sourceFingerprint: graph.state.sourceFingerprint,
    sourceRevision: graph.state.sourceRevision,
    updatedAt: graph.state.updatedAt,
    statePath: null,
    latestDelta: delta ? {
      fromGraphVersion: delta.fromGraphVersion,
      toGraphVersion: delta.toGraphVersion,
      sourceChanged: delta.sourceChanged,
      topologyChanged: delta.topologyChanged,
    } : null,
    limitation: "Session graph versions and deltas exist only in this Flowpeek process. They are not durable history and cannot be resolved by another scanner session.",
  };
  graph.analysis.latestDelta = delta;
  return graph;
}

module.exports = {
  SESSION_GRAPH_STATE_SCHEMA,
  advanceSessionGraph,
};
