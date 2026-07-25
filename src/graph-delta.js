"use strict";

function memberSummary(node) {
  return { id: node.id, label: node.label, type: node.type, kind: node.kind, path: node.path };
}

function graphEdgeKey(edge) {
  return `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
}

function graphEdgeSummary(edge, nodesById) {
  return {
    type: edge.type,
    confidence: edge.confidence,
    source: memberSummary(nodesById.get(edge.source)),
    target: memberSummary(nodesById.get(edge.target)),
  };
}

function getGraphDelta(previousGraph, graph, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  if (!previousGraph) {
    return {
      available: false,
      limitation: "No previous graph is available for comparison.",
    };
  }
  const previousNodes = new Map(previousGraph.nodes.map((node) => [node.id, node]));
  const currentNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previousGraph.edges.map((edge) => [graphEdgeKey(edge), edge]));
  const currentEdges = new Map(graph.edges.map((edge) => [graphEdgeKey(edge), edge]));
  const addedNodeIds = [...currentNodes.keys()].filter((id) => !previousNodes.has(id)).sort();
  const removedNodeIds = [...previousNodes.keys()].filter((id) => !currentNodes.has(id)).sort();
  const addedEdgeKeys = [...currentEdges.keys()].filter((key) => !previousEdges.has(key)).sort();
  const removedEdgeKeys = [...previousEdges.keys()].filter((key) => !currentEdges.has(key)).sort();
  return {
    available: true,
    compared: {
      projectId: graph.project?.projectId || null,
      previousGraphVersion: previousGraph.state?.graphVersion ?? null,
      graphVersion: graph.state?.graphVersion ?? null,
      previousGeneratedAt: previousGraph.generatedAt,
      generatedAt: graph.generatedAt,
    },
    summary: {
      addedNodes: addedNodeIds.length,
      removedNodes: removedNodeIds.length,
      addedEdges: addedEdgeKeys.length,
      removedEdges: removedEdgeKeys.length,
    },
    addedNodes: addedNodeIds.slice(0, limit).map((id) => memberSummary(currentNodes.get(id))),
    removedNodes: removedNodeIds.slice(0, limit).map((id) => memberSummary(previousNodes.get(id))),
    addedEdges: addedEdgeKeys.slice(0, limit).map((key) => graphEdgeSummary(currentEdges.get(key), currentNodes)),
    removedEdges: removedEdgeKeys.slice(0, limit).map((key) => graphEdgeSummary(previousEdges.get(key), previousNodes)),
    truncated: addedNodeIds.length > limit || removedNodeIds.length > limit || addedEdgeKeys.length > limit || removedEdgeKeys.length > limit,
    limitation: "This compares only Flopeek graph topology. Unchanged IDs can still have source edits, and this is not a source diff, Git diff, or runtime behavior diff.",
  };
}

module.exports = { getGraphDelta };
