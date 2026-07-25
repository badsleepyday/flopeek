const GRAPH_SCHEMA_VERSION = 5;

class GraphSchemaError extends Error {
  constructor(diagnostics) {
    super(`Invalid Flowpeek graph: ${diagnostics.map((diagnostic) => diagnostic.message).join(" ")}`);
    this.name = "GraphSchemaError";
    this.code = "FLOWPEEK_INVALID_GRAPH";
    this.diagnostics = diagnostics;
  }
}

function diagnostic(code, message, path = null) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function migrateGraph(graph) {
  if (!isObject(graph)) return { graph, migrated: false };
  if (graph.schemaVersion !== 4 && graph.schemaVersion !== GRAPH_SCHEMA_VERSION) return { graph, migrated: false };
  let migrated = false;
  const next = { ...graph };
  if (!Array.isArray(next.flows)) {
    next.flows = [];
    migrated = true;
  }
  if (!Array.isArray(next.diagnosticFlows)) {
    next.diagnosticFlows = [...next.flows];
    migrated = true;
  }
  if (next.schemaVersion === 4) {
    next.schemaVersion = GRAPH_SCHEMA_VERSION;
    next.state = {
      graphVersion: 0,
      materialFingerprint: null,
      sourceFingerprint: null,
      sourceRevision: next.project?.git?.revision || null,
      updatedAt: next.generatedAt,
      status: "migrated-unversioned",
    };
    migrated = true;
  }
  return { graph: next, migrated };
}

function validateGraph(graph, options = {}) {
  const diagnostics = [];
  if (!isObject(graph)) diagnostics.push(diagnostic("graph-not-object", "Graph payload must be an object."));
  if (diagnostics.length) throw new GraphSchemaError(diagnostics);
  if (graph.schemaVersion !== GRAPH_SCHEMA_VERSION) diagnostics.push(diagnostic("unsupported-schema-version", `Graph schemaVersion must be ${GRAPH_SCHEMA_VERSION}.`, "schemaVersion"));
  if (typeof graph.generatedAt !== "string" || Number.isNaN(Date.parse(graph.generatedAt))) diagnostics.push(diagnostic("invalid-generated-at", "Graph generatedAt must be an ISO-8601 timestamp.", "generatedAt"));
  if (!isObject(graph.project)) diagnostics.push(diagnostic("invalid-project", "Graph project must be an object.", "project"));
  else {
    if (typeof graph.project.root !== "string" || !graph.project.root) diagnostics.push(diagnostic("invalid-project-root", "Graph project.root must be a non-empty string.", "project.root"));
    if (typeof graph.project.name !== "string" || !graph.project.name) diagnostics.push(diagnostic("invalid-project-name", "Graph project.name must be a non-empty string.", "project.name"));
    if (typeof graph.project.projectId !== "string" || !graph.project.projectId) diagnostics.push(diagnostic("invalid-project-id", "Graph project.projectId must be a non-empty string.", "project.projectId"));
    if (options.expectedRoot && graph.project.root !== options.expectedRoot) diagnostics.push(diagnostic("wrong-project-root", "Graph cache belongs to a different repository root.", "project.root"));
    if (options.expectedProjectId && graph.project.projectId !== options.expectedProjectId) diagnostics.push(diagnostic("wrong-project-id", "Graph cache belongs to a different Flowpeek project identity.", "project.projectId"));
  }
  if (!isObject(graph.state)) diagnostics.push(diagnostic("invalid-graph-state", "Graph state must be an object.", "state"));
  else {
    if (!Number.isInteger(graph.state.graphVersion) || graph.state.graphVersion < 0) diagnostics.push(diagnostic("invalid-graph-version", "Graph state.graphVersion must be a non-negative integer.", "state.graphVersion"));
    if (graph.state.materialFingerprint !== null && (typeof graph.state.materialFingerprint !== "string" || !graph.state.materialFingerprint)) diagnostics.push(diagnostic("invalid-material-fingerprint", "Graph state.materialFingerprint must be a non-empty string or null.", "state.materialFingerprint"));
    if (graph.state.sourceFingerprint !== null && (typeof graph.state.sourceFingerprint !== "string" || !graph.state.sourceFingerprint)) diagnostics.push(diagnostic("invalid-source-fingerprint", "Graph state.sourceFingerprint must be a non-empty string or null.", "state.sourceFingerprint"));
    if (graph.state.sourceRevision !== null && typeof graph.state.sourceRevision !== "string") diagnostics.push(diagnostic("invalid-source-revision", "Graph state.sourceRevision must be a string or null.", "state.sourceRevision"));
    if (typeof graph.state.updatedAt !== "string" || Number.isNaN(Date.parse(graph.state.updatedAt))) diagnostics.push(diagnostic("invalid-state-updated-at", "Graph state.updatedAt must be an ISO-8601 timestamp.", "state.updatedAt"));
    if (typeof graph.state.status !== "string" || !graph.state.status) diagnostics.push(diagnostic("invalid-state-status", "Graph state.status must be a non-empty string.", "state.status"));
  }
  for (const field of ["analysis", "stats"]) {
    if (!isObject(graph[field])) diagnostics.push(diagnostic(`invalid-${field}`, `Graph ${field} must be an object.`, field));
  }
  for (const field of ["nodes", "edges", "flows", "diagnosticFlows"]) {
    if (!Array.isArray(graph[field])) diagnostics.push(diagnostic(`invalid-${field}`, `Graph ${field} must be an array.`, field));
  }
  if (Array.isArray(graph.nodes) && graph.nodes.some((node) => !isObject(node) || typeof node.id !== "string" || !node.id)) diagnostics.push(diagnostic("invalid-node", "Every graph node must have a non-empty string id.", "nodes"));
  if (Array.isArray(graph.edges) && graph.edges.some((edge) => !isObject(edge) || typeof edge.source !== "string" || typeof edge.target !== "string" || typeof edge.type !== "string")) diagnostics.push(diagnostic("invalid-edge", "Every graph edge must have string source, target, and type fields.", "edges"));
  if (diagnostics.length) throw new GraphSchemaError(diagnostics);
  return graph;
}

function parseGraphCache(text, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GraphSchemaError([diagnostic("invalid-json", `Graph cache is not valid JSON (${error.message}).`)]);
  }
  const migration = migrateGraph(parsed);
  validateGraph(migration.graph, options);
  return migration;
}

function graphContractSummary(graph) {
  return {
    schemaVersion: graph.schemaVersion,
    projectId: graph.project?.projectId || null,
    graphVersion: graph.state?.graphVersion ?? null,
    materialFingerprint: graph.state?.materialFingerprint || null,
    generatedAt: graph.generatedAt,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  };
}

module.exports = {
  GRAPH_SCHEMA_VERSION,
  GraphSchemaError,
  graphContractSummary,
  migrateGraph,
  parseGraphCache,
  validateGraph,
};
