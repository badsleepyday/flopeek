const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { atomicWriteJson, readGraphCacheResult, validateGraphForCache, writeGraphCache: writeValidatedGraphCache } = require("./graph-cache");
const { createAdjacentFlowComparisons } = require("./flow-comparison");

const GRAPH_STATE_SCHEMA = "flopeek-graph-state/v1";
const GRAPH_DELTA_SCHEMA = "flopeek-delta/v1";
const STATE_RELATIVE_PATH = ".flopeek/state.json";
const DELTAS_RELATIVE_PATH = ".flopeek/deltas";
const DEFAULT_DELTA_HISTORY_LIMIT = 8;
const DEFAULT_DELTA_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
const DELTA_PRUNE_JOURNAL_SCHEMA = "flopeek-graph-delta-prune-journal/v1";

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
    if (!isStateRecord(value)) return { status: "invalid", path: target, state: null, diagnostics: [{ code: "invalid-state-record", message: "Graph state metadata does not match flopeek-graph-state/v1.", path: null }] };
    if (expectedProjectId && value.projectId !== expectedProjectId) return { status: "invalid", path: target, state: null, diagnostics: [{ code: "wrong-state-project-id", message: "Graph state metadata belongs to a different Flopeek project identity.", path: "projectId" }] };
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

function changedPathProvenance(root, previousGraph, options = {}) {
  if (Array.isArray(options.changedPaths)) return { status: "available", source: "caller-provided", reason: null, paths: normaliseChangedPaths(null, options.changedPaths) };
  const revision = previousGraph?.state?.sourceRevision;
  if (!revision) return { status: "unavailable", source: null, reason: previousGraph ? "previous-source-revision-unavailable" : "no-previous-persistent-graph", paths: [] };
  try {
    const changed = execFileSync("git", ["-C", root, "diff", "--name-only", "--diff-filter=ACMRD", revision], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((value) => value.trim().replaceAll("\\", "/"))
      .filter(Boolean);
    const untracked = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((value) => value.trim().replaceAll("\\", "/"))
      .filter(Boolean);
    const paths = [...new Set([...changed, ...untracked])]
      .filter((value) => value !== ".flopeek" && !value.startsWith(".flopeek/"))
      .sort();
    return { status: "available", source: "git-revision-diff", reason: null, paths };
  } catch {
    return { status: "unavailable", source: null, reason: "git-path-provenance-unavailable", paths: [] };
  }
}

function affectedNodes(graph, changedPaths, changedNodeIds, limit) {
  const changedPathSet = new Set(changedPaths);
  const candidates = (Array.isArray(graph.nodes) ? graph.nodes : []).filter((node) => changedNodeIds.has(node.id) || (node.path && changedPathSet.has(node.path)));
  const unique = [...new Map(candidates.map((node) => [node.id, node])).values()].sort((left, right) => left.id.localeCompare(right.id));
  return { nodes: unique.slice(0, limit).map(nodeSummary), truncated: unique.length > limit };
}

function affectedContextNodes(nodes, affected, limit) {
  const byId = new Map();
  for (const node of nodes.added) byId.set(node.id, { status: "added", changeScope: "topology", node });
  for (const node of nodes.changed) byId.set(node.id, { status: "changed", changeScope: "node-structure", node });
  for (const node of nodes.removed) byId.set(node.id, { status: "removed", changeScope: "topology", node });
  for (const node of affected.nodes) {
    if (!byId.has(node.id)) byId.set(node.id, {
      status: "source-changed",
      changeScope: node.kind === "file" ? "file-content-only" : "node-content-only",
      node,
    });
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
    changedPathProvenance: options.changedPathProvenance || { status: "available", source: Array.isArray(options.changedPaths) ? "caller-provided" : "scanner-refresh", reason: null },
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

function deltaPruneJournalPath(root) { return path.join(deltasPath(root), ".prune-journal.json"); }
function deltaPruneStagingPath(root) { return path.join(deltasPath(root), ".prune-staging"); }

function cleanEmptyDirectory(target) {
  try { if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target); } catch {}
}

function readDeltaPruneJournal(root) {
  const target = deltaPruneJournalPath(root);
  if (!fs.existsSync(target)) return { status: "missing", journal: null, diagnostics: [] };
  try {
    const journal = JSON.parse(fs.readFileSync(target, "utf8"));
    const valid = journal?.schemaVersion === DELTA_PRUNE_JOURNAL_SCHEMA
      && ["prepared", "committed"].includes(journal.status)
      && Array.isArray(journal.files)
      && journal.files.every((name) => typeof name === "string" && /^(\d+)-(\d+)\.json$/.test(name));
    if (!valid) throw new Error("invalid prune journal shape");
    return { status: "valid", journal, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", journal: null, diagnostics: [{ code: "invalid-delta-prune-journal", message: error.message }] };
  }
}

function recoverGraphDeltaPrune(root) {
  const read = readDeltaPruneJournal(root);
  if (read.status === "missing") return { status: "none", diagnostics: [] };
  if (read.status === "invalid") return { status: "unavailable", diagnostics: read.diagnostics };
  const staging = deltaPruneStagingPath(root);
  const directory = deltasPath(root);
  const diagnostics = [];
  for (const name of read.journal.files) {
    const staged = path.join(staging, name);
    const original = path.join(directory, name);
    try {
      if (read.journal.status === "prepared" && fs.existsSync(staged) && !fs.existsSync(original)) fs.renameSync(staged, original);
      if (read.journal.status === "committed" && fs.existsSync(staged)) fs.unlinkSync(staged);
    } catch (error) {
      diagnostics.push({ code: "delta-prune-recovery-failed", relativePath: `${DELTAS_RELATIVE_PATH}/${name}`, message: error.message });
    }
  }
  if (diagnostics.length) return { status: "partial", diagnostics };
  try { fs.unlinkSync(deltaPruneJournalPath(root)); } catch (error) { return { status: "partial", diagnostics: [{ code: "delta-prune-journal-cleanup-failed", message: error.message }] }; }
  cleanEmptyDirectory(staging);
  return { status: read.journal.status === "prepared" ? "rolled-back" : "completed", diagnostics: [] };
}

function deltaEntries(root) {
  const directory = deltasPath(root);
  if (!fs.existsSync(directory)) return { entries: [], unknownFiles: [] };
  const entries = [];
  const unknownFiles = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(\d+)-(\d+)\.json$/.exec(entry.name);
    const target = path.join(directory, entry.name);
    if (!match) {
      unknownFiles.push({ relativePath: `${DELTAS_RELATIVE_PATH}/${entry.name}`, bytes: fs.lstatSync(target).size });
      continue;
    }
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) {
      unknownFiles.push({ relativePath: `${DELTAS_RELATIVE_PATH}/${entry.name}`, bytes: fs.lstatSync(target).size });
      continue;
    }
    try {
      const delta = JSON.parse(fs.readFileSync(target, "utf8"));
      if (delta?.schemaVersion !== GRAPH_DELTA_SCHEMA || delta.fromGraphVersion !== from || delta.toGraphVersion !== to) throw new Error("delta identity mismatch");
      entries.push({ path: target, relativePath: `${DELTAS_RELATIVE_PATH}/${entry.name}`, fromGraphVersion: from, toGraphVersion: to, bytes: fs.lstatSync(target).size });
    } catch {
      unknownFiles.push({ relativePath: `${DELTAS_RELATIVE_PATH}/${entry.name}`, bytes: fs.lstatSync(target).size });
    }
  }
  entries.sort((left, right) => right.toGraphVersion - left.toGraphVersion || right.fromGraphVersion - left.fromGraphVersion || left.relativePath.localeCompare(right.relativePath));
  return { entries, unknownFiles };
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function deltaRetentionPlan(root, options = {}) {
  const keepDeltas = positiveInteger(options.keepDeltas, DEFAULT_DELTA_HISTORY_LIMIT, 10_000);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_DELTA_HISTORY_MAX_BYTES, 1024 * 1024 * 1024);
  const { entries, unknownFiles } = deltaEntries(root);
  const retained = [];
  const prunable = [];
  let retainedBytes = 0;
  for (const entry of entries) {
    const isLatest = retained.length === 0;
    const withinCount = retained.length < keepDeltas;
    const withinBytes = retainedBytes + entry.bytes <= maxBytes;
    if (isLatest || (withinCount && withinBytes)) {
      retained.push({ ...entry, protected: isLatest, protectionReason: isLatest ? "latest-adjacent-delta" : "within-version-and-byte-retention" });
      retainedBytes += entry.bytes;
    } else {
      prunable.push({ ...entry, protected: false, protectionReason: null });
    }
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    keepDeltas,
    maxBytes,
    total: { files: entries.length, bytes: totalBytes },
    retained,
    prunable,
    unknownFiles,
    retentionExceededByProtectedLatest: Boolean(retained[0] && retained[0].bytes > maxBytes),
  };
}

function listGraphDeltaHistory(root, options = {}) {
  const plan = deltaRetentionPlan(root, options);
  return {
    schemaVersion: "flopeek-graph-delta-history/v1",
    status: "available",
    policy: {
      mode: "manual-dry-run-first",
      defaultKeepDeltas: DEFAULT_DELTA_HISTORY_LIMIT,
      defaultMaxBytes: DEFAULT_DELTA_HISTORY_MAX_BYTES,
      keepDeltas: plan.keepDeltas,
      maxBytes: plan.maxBytes,
      latestAdjacentDelta: "always-retained",
      unknownFiles: "protected-unclassified",
    },
    storage: plan.total,
    retained: plan.retained.map(({ path, ...entry }) => entry),
    reclaimable: plan.prunable.map(({ path, ...entry }) => entry),
    unknownFiles: plan.unknownFiles,
    retentionExceededByProtectedLatest: plan.retentionExceededByProtectedLatest,
    limitation: "History retention preserves only bounded adjacent static deltas. Pruning never reconstructs old Context Cards, runtime history, or source snapshots.",
  };
}

function writeGraphDelta(root, delta) {
  if (!delta || delta.schemaVersion !== GRAPH_DELTA_SCHEMA || !Number.isInteger(delta.fromGraphVersion) || !Number.isInteger(delta.toGraphVersion) || delta.toGraphVersion <= delta.fromGraphVersion) {
    throw new GraphStateError("invalid-delta", "Refusing to persist an invalid or non-advancing graph delta.");
  }
  const result = atomicWriteJson(deltaPath(root, delta.fromGraphVersion, delta.toGraphVersion), delta);
  return { ...result, delta };
}

function pruneGraphDeltas(root, options = {}) {
  const dryRun = options.dryRun !== false;
  const recovery = dryRun ? { status: "not-run", diagnostics: [] } : recoverGraphDeltaPrune(root);
  if (recovery.status === "unavailable" || recovery.status === "partial") {
    return { schemaVersion: "flopeek-graph-delta-history-prune/v1", status: "unavailable", dryRun, pruned: [], retained: [], reclaimedBytes: 0, diagnostics: recovery.diagnostics, limitation: "A previous delta prune requires explicit recovery before another history mutation can proceed." };
  }
  const plan = deltaRetentionPlan(root, options);
  const pruned = plan.prunable.map((entry) => ({ relativePath: entry.relativePath, fromGraphVersion: entry.fromGraphVersion, toGraphVersion: entry.toGraphVersion, bytes: entry.bytes }));
  const diagnostics = [];
  if (!dryRun) {
    const directory = deltasPath(root);
    const staging = deltaPruneStagingPath(root);
    const names = plan.prunable.map((entry) => path.basename(entry.path));
    fs.mkdirSync(staging, { recursive: true });
    atomicWriteJson(deltaPruneJournalPath(root), { schemaVersion: DELTA_PRUNE_JOURNAL_SCHEMA, status: "prepared", files: names });
    for (const entry of plan.prunable) {
      try {
        fs.renameSync(entry.path, path.join(staging, path.basename(entry.path)));
      } catch (error) {
        diagnostics.push({ code: "delta-prune-stage-failed", relativePath: entry.relativePath, message: error.message });
      }
    }
    if (diagnostics.length) {
      const rollback = recoverGraphDeltaPrune(root);
      diagnostics.push(...rollback.diagnostics);
    } else {
      atomicWriteJson(deltaPruneJournalPath(root), { schemaVersion: DELTA_PRUNE_JOURNAL_SCHEMA, status: "committed", files: names });
      for (const entry of plan.prunable) {
        try { fs.unlinkSync(path.join(staging, path.basename(entry.path))); }
        catch (error) { diagnostics.push({ code: "delta-prune-finalize-failed", relativePath: entry.relativePath, message: error.message }); }
      }
      if (!diagnostics.length) {
        fs.unlinkSync(deltaPruneJournalPath(root));
        cleanEmptyDirectory(staging);
      }
    }
  }
  return {
    schemaVersion: "flopeek-graph-delta-history-prune/v1",
    status: diagnostics.length ? "partial" : "available",
    dryRun,
    policy: { keepDeltas: plan.keepDeltas, maxBytes: plan.maxBytes, latestAdjacentDelta: "always-retained", unknownFiles: "protected-unclassified" },
    pruned,
    retained: plan.retained.map(({ path, ...entry }) => entry),
    unknownFiles: plan.unknownFiles,
    reclaimedBytes: dryRun ? plan.prunable.reduce((sum, entry) => sum + entry.bytes, 0) : pruned.filter((entry) => !diagnostics.some((item) => item.relativePath === entry.relativePath)).reduce((sum, entry) => sum + entry.bytes, 0),
    retentionExceededByProtectedLatest: plan.retentionExceededByProtectedLatest,
    diagnostics,
    recovery,
    limitation: "Pruning is explicit and dry-run-first. It stages only validated delta filenames under a journal before final deletion, preserves the latest adjacent delta, and does not modify the current graph, state, project identity, verification, delivery, runtime, or unknown files.",
  };
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
  const candidates = deltaEntries(root).entries.filter((entry) => graphVersion === null || entry.toGraphVersion === graphVersion);
  return candidates.length ? readGraphDelta(root, candidates[0].fromGraphVersion, candidates[0].toGraphVersion) : null;
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
  const provenance = changedPathProvenance(root, previousGraph, options);
  const delta = previousGraph && graphVersion > graphVersionOf(previousGraph)
    ? createGraphDelta(previousGraph, graph, { ...options, changedPaths: provenance.paths, changedPathProvenance: { status: provenance.status, source: provenance.source, reason: provenance.reason } })
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
  DEFAULT_DELTA_HISTORY_LIMIT,
  DEFAULT_DELTA_HISTORY_MAX_BYTES,
  DELTA_PRUNE_JOURNAL_SCHEMA,
  deltasPath,
  graphStateSummary,
  materialFingerprint,
  persistGraphState,
  listGraphDeltaHistory,
  pruneGraphDeltas,
  readGraphDelta,
  readGraphStateResult,
  readLatestGraphDelta,
  recoverGraphDeltaPrune,
  statePath,
};
