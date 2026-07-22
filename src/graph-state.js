const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson, readGraphCacheResult, validateGraphForCache, writeGraphCache: writeValidatedGraphCache } = require("./graph-cache");
const { createAdjacentFlowComparisons } = require("./flow-comparison");

const GRAPH_STATE_SCHEMA = "flowpeek-graph-state/v1";
const GRAPH_DELTA_SCHEMA = "flowpeek-delta/v1";
const STATE_RELATIVE_PATH = ".flowpeek/state.json";
const DELTAS_RELATIVE_PATH = ".flowpeek/deltas";
const MAX_DELTA_HISTORY = 40;

class GraphStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GraphStateError";
    this.code = code;
  }
}

function statePath(root) {
  return path.join(root, STATE_RELATIVE_PATH);
}

function deltasPath(root) {
  return path.join(root, DELTAS_RELATIVE_PATH);
}

function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

function isStateRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === GRAPH_STATE_SCHEMA
    && typeof value.projectId === "string" && value.projectId
    && Number.isInteger(value.graphVersion) && value.graphVersion >= 0
    && (value.materialFingerprint === null || typeof value.materialFingerprint === "string")
    && (value.sourceFingerprint === null || typeof value.sourceFingerprint === "string")
    && (value.sourceRevision === null || typeof value.sourceRevision === "string")
    && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));
}

function readGraphStateResult(root, expectedProjectId = null) {
  const target = statePath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, state: null, diagnostics: [] };
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!isStateRecord(value)) return { status: "invalid", path: target, state: null, diagnostics: [{ code: "invalid-state-record", message: "Graph state metadata does not match flowpeek-graph-state/v1.", path: null }] };
    if (expectedProjectId && value.projectId !== expectedProjectId) return { status: "invalid", path: target, state: null, diagnostics: [{ code: "wrong-state-project-id", message: "Graph state metadata belongs to a different Flowpeek project identity.", path: "projectId" }] };
    return { status: "valid", path: target, state: value, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, state: null, diagnostics: [{ code: "invalid-state-json", message: `Graph state metadata is not valid JSON (${error.message}).`, path: null }] };
  }
}

function materialPayload(graph) {
  const analysis = { ...(graph.analysis || {}) };
  delete analysis.refresh;
  delete analysis.cacheState;
  delete analysis.graphState;
  delete analysis.latestDelta;
  return {
    schemaVersion: graph.schemaVersion,
    project: {
      projectId: graph.project?.projectId || null,
    },
    state: {
      sourceFingerprint: graph.state?.sourceFingerprint || null,
      sourceRevision: graph.state?.sourceRevision || null,
    },
    analysis,
    stats: graph.stats,
    nodes: graph.nodes,
    edges: graph.edges,
    flows: graph.flows,
    diagnosticFlows: graph.diagnosticFlows,
  };
}

function materialFingerprint(graph) {
  return hash(canonicalString(materialPayload(graph)));
}

function graphVersionOf(graph) {
  return Number.isInteger(graph?.state?.graphVersion) ? graph.state.graphVersion : 0;
}

function nodeSummary(node) {
  return { id: node.id, label: node.label, type: node.type, kind: node.kind, path: node.path || null };
}

function edgeKey(edge) {
  return `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
}

function edgeSummary(edge) {
  return { source: edge.source, target: edge.target, type: edge.type, confidence: edge.confidence || null };
}

function flowSummary(flow) {
  return {
    id: flow.id,
    title: flow.title,
    entryId: flow.entryId,
    entry: flow.entry || null,
    steps: (flow.steps || []).map((step) => ({ id: step.id, depth: step.depth })),
  };
}

function comparedItems(previous, current, keyFor, summarize, limit) {
  const previousByKey = new Map((previous || []).map((value) => [keyFor(value), value]));
  const currentByKey = new Map((current || []).map((value) => [keyFor(value), value]));
  const addedKeys = [...currentByKey.keys()].filter((key) => !previousByKey.has(key)).sort();
  const removedKeys = [...previousByKey.keys()].filter((key) => !currentByKey.has(key)).sort();
  const changedKeys = [...currentByKey.keys()]
    .filter((key) => previousByKey.has(key) && canonicalString(previousByKey.get(key)) !== canonicalString(currentByKey.get(key)))
    .sort();
  return {
    added: addedKeys.slice(0, limit).map((key) => summarize(currentByKey.get(key))),
    removed: removedKeys.slice(0, limit).map((key) => summarize(previousByKey.get(key))),
    changed: changedKeys.slice(0, limit).map((key) => summarize(currentByKey.get(key))),
    total: { added: addedKeys.length, removed: removedKeys.length, changed: changedKeys.length },
    truncated: addedKeys.length > limit || removedKeys.length > limit || changedKeys.length > limit,
  };
}

function normaliseChangedPaths(graph, paths) {
  const values = Array.isArray(paths) ? paths : graph.analysis?.refresh?.changedPaths || [];
  return [...new Set(values.map((value) => String(value || "").replaceAll("\\", "/").trim()).filter(Boolean))].sort();
}

function affectedNodes(graph, changedPaths, changedNodeIds, limit) {
  const changedPathSet = new Set(changedPaths);
  const candidates = (Array.isArray(graph.nodes) ? graph.nodes : []).filter((node) => changedNodeIds.has(node.id) || (node.path && changedPathSet.has(node.path)));
  const unique = [...new Map(candidates.map((node) => [node.id, node])).values()].sort((left, right) => left.id.localeCompare(right.id));
  return { nodes: unique.slice(0, limit).map(nodeSummary), truncated: unique.length > limit };
}

function affectedContextNodes(nodes, affected, limit) {
  const byId = new Map();
  for (const node of nodes.added) byId.set(node.id, { status: "added", node });
  for (const node of nodes.changed) byId.set(node.id, { status: "changed", node });
  for (const node of nodes.removed) byId.set(node.id, { status: "removed", node });
  for (const node of affected.nodes) {
    if (!byId.has(node.id)) byId.set(node.id, { status: "source-changed", node });
  }
  const values = [...byId.values()].sort((left, right) => left.node.id.localeCompare(right.node.id));
  return { items: values.slice(0, limit), truncated: values.length > limit || affected.truncated };
}

function affectedContextFlows(graph, flows, contextNodes, changedPaths, limit) {
  const statusById = new Map();
  for (const flow of flows.added) statusById.set(flow.id, { status: "added", flow });
  for (const flow of flows.changed) statusById.set(flow.id, { status: "changed", flow });
  for (const flow of flows.removed) statusById.set(flow.id, { status: "removed", flow });
  const changedNodeIds = new Set(contextNodes.items.map((item) => item.node.id));
  const changedPathSet = new Set(changedPaths);
  const currentNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const flow of graph.flows || []) {
    const changedStepIds = (flow.steps || [])
      .filter((step) => changedNodeIds.has(step.id) || changedPathSet.has(currentNodes.get(step.id)?.path))
      .map((step) => step.id);
    if (changedStepIds.length && !statusById.has(flow.id)) statusById.set(flow.id, { status: "affected", flow: flowSummary(flow), changedStepIds });
    else if (changedStepIds.length) statusById.get(flow.id).changedStepIds = changedStepIds;
  }
  const values = [...statusById.values()]
    .map((item) => ({ ...item, changedStepIds: item.changedStepIds || [] }))
    .sort((left, right) => left.flow.id.localeCompare(right.flow.id));
  return { items: values.slice(0, limit), truncated: values.length > limit || flows.truncated };
}

function createGraphDelta(previousGraph, graph, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const nodes = comparedItems(previousGraph.nodes, graph.nodes, (node) => node.id, nodeSummary, limit);
  const edges = comparedItems(previousGraph.edges, graph.edges, edgeKey, edgeSummary, limit);
  const flows = comparedItems(previousGraph.flows, graph.flows, (flow) => flow.id, flowSummary, limit);
  const changedPaths = normaliseChangedPaths(graph, options.changedPaths);
  const changedNodeIds = new Set([...nodes.added, ...nodes.changed].map((node) => node.id));
  const affected = affectedNodes(graph, changedPaths, changedNodeIds, limit);
  const contextNodes = affectedContextNodes(nodes, affected, limit);
  const contextFlows = affectedContextFlows(graph, flows, contextNodes, changedPaths, limit);
  const flowComparisons = createAdjacentFlowComparisons(previousGraph, graph, contextFlows);
  // A node's source evidence can change without changing the static map. Topology
  // is intentionally limited to memberships and relationships, while `nodes.changed`
  // preserves metadata changes for inspection.
  const topologyChanged = nodes.total.added + nodes.total.removed + edges.total.added + edges.total.removed + flows.total.added + flows.total.removed > 0;
  const coverageChanged = canonicalString(previousGraph.analysis?.coverage || null) !== canonicalString(graph.analysis?.coverage || null);
  return {
    schemaVersion: GRAPH_DELTA_SCHEMA,
    projectId: graph.project.projectId,
    fromGraphVersion: graphVersionOf(previousGraph),
    toGraphVersion: graphVersionOf(graph),
    reason: options.reason || "refresh",
    generatedAt: graph.state.updatedAt,
    changedPaths,
    refresh: {
      mode: graph.analysis?.refresh?.mode || "unknown",
      analyzedFiles: graph.analysis?.refresh?.analyzedFiles || 0,
      reusedFiles: graph.analysis?.refresh?.reusedFiles || 0,
      removedFiles: graph.analysis?.refresh?.removedFiles || 0,
    },
    sourceChanged: graph.state.sourceFingerprint !== previousGraph.state?.sourceFingerprint || graph.state.sourceRevision !== previousGraph.state?.sourceRevision,
    topologyChanged,
    nodes: { added: nodes.added, removed: nodes.removed, changed: nodes.changed },
    edges: { added: edges.added, removed: edges.removed, changed: edges.changed },
    flows: { added: flows.added, removed: flows.removed, changed: flows.changed },
    affectedNodes: affected.nodes,
    affectedContexts: {
      nodes: contextNodes.items,
      flows: contextFlows.items,
      truncated: contextNodes.truncated || contextFlows.truncated,
    },
    flowComparisons,
    coverageChanged,
    truncated: nodes.truncated || edges.truncated || flows.truncated || affected.truncated || contextNodes.truncated || contextFlows.truncated || flowComparisons.truncated,
    summary: {
      addedNodes: nodes.total.added,
      removedNodes: nodes.total.removed,
      changedNodes: nodes.total.changed,
      addedEdges: edges.total.added,
      removedEdges: edges.total.removed,
      changedEdges: edges.total.changed,
      addedFlows: flows.total.added,
      removedFlows: flows.total.removed,
      changedFlows: flows.total.changed,
      affectedNodes: affected.nodes.length,
      affectedContexts: contextNodes.items.length + contextFlows.items.length,
      flowComparisons: flowComparisons.items.length,
    },
    limitation: "Affected contexts and bounded Flow Lens comparisons identify supported static entry evidence from one adjacent delta. They do not prove command invocation, runtime execution, control flow, business behavior, or a full historical Context Card.",
  };
}

function deltaPath(root, fromGraphVersion, toGraphVersion) {
  return path.join(deltasPath(root), `${fromGraphVersion}-${toGraphVersion}.json`);
}

function writeGraphDelta(root, delta) {
  if (!delta || delta.schemaVersion !== GRAPH_DELTA_SCHEMA || !Number.isInteger(delta.fromGraphVersion) || !Number.isInteger(delta.toGraphVersion) || delta.toGraphVersion <= delta.fromGraphVersion) {
    throw new GraphStateError("invalid-delta", "Refusing to persist an invalid or non-advancing graph delta.");
  }
  const result = atomicWriteJson(deltaPath(root, delta.fromGraphVersion, delta.toGraphVersion), delta);
  pruneGraphDeltas(root);
  return { ...result, delta };
}

function pruneGraphDeltas(root, limit = MAX_DELTA_HISTORY) {
  const directory = deltasPath(root);
  if (!fs.existsSync(directory)) return;
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const stem = entry.name.slice(0, -5);
      const parts = stem.split("-");
      if (parts.length !== 2 || !parts.every((part) => /^[0-9]+$/.test(part))) return null;
      return { path: path.join(directory, entry.name), from: Number(parts[0]), to: Number(parts[1]) };
    })
    .filter(Boolean)
    .sort((left, right) => right.to - left.to || right.from - left.from);
  for (const entry of entries.slice(Math.max(limit, 0))) fs.rmSync(entry.path, { force: true });
}

function readGraphDelta(root, fromGraphVersion, toGraphVersion) {
  if (!Number.isInteger(fromGraphVersion) || !Number.isInteger(toGraphVersion)) return null;
  const target = deltaPath(root, fromGraphVersion, toGraphVersion);
  if (!fs.existsSync(target)) return null;
  try {
    const delta = JSON.parse(fs.readFileSync(target, "utf8"));
    return delta?.schemaVersion === GRAPH_DELTA_SCHEMA ? delta : null;
  } catch {
    return null;
  }
}

function readLatestGraphDelta(root, graphVersion = null) {
  const directory = deltasPath(root);
  if (!fs.existsSync(directory)) return null;
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const parts = entry.name.slice(0, -5).split("-");
      return parts.length === 2 && parts.every((part) => /^[0-9]+$/.test(part)) ? { from: Number(parts[0]), to: Number(parts[1]) } : null;
    })
    .filter((entry) => entry && (graphVersion === null || entry.to === graphVersion))
    .sort((left, right) => right.to - left.to || right.from - left.from);
  return candidates.length ? readGraphDelta(root, candidates[0].from, candidates[0].to) : null;
}

function graphStateSummary(graph, stateRecord, stateStatus, delta) {
  return {
    schemaVersion: GRAPH_STATE_SCHEMA,
    status: stateStatus,
    graphVersion: graph.state.graphVersion,
    materialFingerprint: graph.state.materialFingerprint,
    sourceFingerprint: graph.state.sourceFingerprint,
    sourceRevision: graph.state.sourceRevision,
    updatedAt: graph.state.updatedAt,
    statePath: statePath(graph.project.root),
    latestDelta: delta ? { fromGraphVersion: delta.fromGraphVersion, toGraphVersion: delta.toGraphVersion, sourceChanged: delta.sourceChanged, topologyChanged: delta.topologyChanged } : null,
    limitation: "graphVersion identifies a material static graph state. It is not a runtime trace, source diff, or Context Card reference by itself.",
  };
}

function persistGraphState(root, graph, options = {}) {
  if (!graph?.project?.projectId || !graph?.state) throw new GraphStateError("missing-graph-identity", "Graph state persistence requires a projectId and initial graph state.");
  validateGraphForCache(root, graph, { expectedProjectId: graph.project.projectId });
  const previousStateResult = readGraphStateResult(root, graph.project.projectId);
  const previousCacheResult = readGraphCacheResult(root, { expectedProjectId: graph.project.projectId });
  const previousGraph = previousCacheResult.status === "valid" ? previousCacheResult.graph : null;
  const fallbackState = previousGraph?.state && graphVersionOf(previousGraph) > 0 ? {
    schemaVersion: GRAPH_STATE_SCHEMA,
    projectId: previousGraph.project.projectId,
    graphVersion: previousGraph.state.graphVersion,
    materialFingerprint: previousGraph.state.materialFingerprint,
    sourceFingerprint: previousGraph.state.sourceFingerprint,
    sourceRevision: previousGraph.state.sourceRevision,
    updatedAt: previousGraph.state.updatedAt,
  } : null;
  const previousState = previousStateResult.status === "valid" ? previousStateResult.state : fallbackState;
  const fingerprint = materialFingerprint(graph);
  const unchanged = Boolean(previousState?.materialFingerprint && previousState.materialFingerprint === fingerprint);
  const graphVersion = unchanged ? previousState.graphVersion : Math.max(previousState?.graphVersion || 0, 0) + 1;
  graph.state = {
    graphVersion,
    materialFingerprint: fingerprint,
    sourceFingerprint: graph.state.sourceFingerprint,
    sourceRevision: graph.state.sourceRevision,
    updatedAt: new Date().toISOString(),
    status: unchanged ? "current" : "advanced",
  };
  const delta = previousGraph && graphVersion > graphVersionOf(previousGraph)
    ? createGraphDelta(previousGraph, graph, options)
    : null;
  const stateRecord = {
    schemaVersion: GRAPH_STATE_SCHEMA,
    projectId: graph.project.projectId,
    graphVersion: graph.state.graphVersion,
    materialFingerprint: graph.state.materialFingerprint,
    sourceFingerprint: graph.state.sourceFingerprint,
    sourceRevision: graph.state.sourceRevision,
    updatedAt: graph.state.updatedAt,
  };
  const latestDelta = delta || readLatestGraphDelta(root, graph.state.graphVersion);
  graph.analysis.graphState = graphStateSummary(graph, stateRecord, unchanged ? "unchanged" : "advanced", latestDelta);
  graph.analysis.latestDelta = latestDelta;
  const cacheResult = writeValidatedGraphCache(root, graph, { ...options, expectedProjectId: graph.project.projectId });
  atomicWriteJson(statePath(root), stateRecord);
  if (delta) writeGraphDelta(root, delta);
  return { cacheResult, graphState: graph.analysis.graphState, delta: latestDelta, previousCache: previousCacheResult.status, previousState: previousStateResult.status };
}

module.exports = {
  DELTAS_RELATIVE_PATH,
  GRAPH_DELTA_SCHEMA,
  GRAPH_STATE_SCHEMA,
  GraphStateError,
  createGraphDelta,
  deltasPath,
  graphStateSummary,
  materialFingerprint,
  persistGraphState,
  readGraphDelta,
  readGraphStateResult,
  readLatestGraphDelta,
  statePath,
};
