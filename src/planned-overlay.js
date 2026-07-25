"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { parseContextRef } = require("./context-card");
const { listContinuationCheckpoints, readContinuationCheckpointStore } = require("./continuation-checkpoint");
const { portableText } = require("./handoff-workspace");

const PLANNED_OVERLAY_SCHEMA = "flopeek-planned-overlay/v1";
const PLANNED_OVERLAY_STORE_SCHEMA = "flopeek-planned-overlays/v1";
const PLANNED_OVERLAY_STORE_RELATIVE_PATH = ".flopeek/delivery/planned-overlays.json";
const PLAN_REF_SCHEMA = "flopeek-plan-ref/v1";
const MAX_OVERLAYS = 10_000;
const MAX_NODES = 200;
const MAX_EDGES = 500;
const MAX_TEXT_ITEMS = 100;
const PLANNED_NODE_KINDS = new Set(["endpoint", "service", "module", "function", "database", "queue", "external", "test", "boundary", "other"]);
const PLANNED_RELATIONSHIPS = new Set(["planned_after", "planned_to_call", "planned_to_use", "planned_to_extend", "planned_to_replace", "planned_to_publish", "planned_to_subscribe", "planned_to_verify"]);
const CREATED_BY_KINDS = new Set(["human", "agent", "tool"]);

class PlannedOverlayError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "PlannedOverlayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function onlyKnownKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function safeText(value, name, options = {}) {
  try {
    return portableText(value, name, options);
  } catch (error) {
    throw new PlannedOverlayError(error.code || "unsafe-planned-overlay-text", error.message, error.statusCode || 400);
  }
}

function safeId(value, name) {
  const normalized = safeText(value, name, { required: true, maximum: 160 });
  if (!/^[a-z][a-z0-9._:-]*$/u.test(normalized)) throw new PlannedOverlayError("invalid-id", `${name} must start with a lowercase letter and contain only lowercase letters, digits, dots, underscores, colons, or hyphens.`);
  return normalized;
}

function validPortableText(value, options = {}) {
  try { return portableText(value, "stored planned-overlay text", options) === value; } catch { return false; }
}

function validId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9._:-]*$/u.test(value) && validPortableText(value, { required: true, maximum: 160 });
}

function normalizeTextList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TEXT_ITEMS) throw new PlannedOverlayError("invalid-text-list", `${name} must contain at most ${MAX_TEXT_ITEMS} items.`);
  return value.map((item, index) => safeText(item, `${name}[${index}]`, { required: true, maximum: 1_200 }));
}

function normalizeCandidatePath(value) {
  if (value === undefined || value === null) return null;
  const candidatePath = safeText(value, "candidatePath", { required: true, maximum: 1_200 }).replaceAll("\\", "/");
  if (path.posix.isAbsolute(candidatePath) || path.win32.isAbsolute(candidatePath) || candidatePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new PlannedOverlayError("invalid-candidate-path", "candidatePath must be a portable repository-relative path.");
  return candidatePath;
}

function createPlanRef(projectId, checkpointId, plannedNodeId, overlayVersion) {
  if (typeof projectId !== "string" || !projectId) throw new PlannedOverlayError("invalid-project-id", "Plan Ref projectId must be a non-empty string.");
  const checkpoint = safeId(checkpointId, "checkpointId");
  const node = safeId(plannedNodeId, "plannedNodeId");
  if (!Number.isSafeInteger(overlayVersion) || overlayVersion < 1) throw new PlannedOverlayError("invalid-overlay-version", "Plan Ref overlayVersion must be a positive integer.");
  return `fpp://local/${encodeURIComponent(projectId)}/${encodeURIComponent(checkpoint)}/${encodeURIComponent(node)}@${overlayVersion}`;
}

function parsePlanRef(value) {
  if (typeof value !== "string" || !value) throw new PlannedOverlayError("invalid-plan-ref", "Plan Ref must be a non-empty string.");
  let url;
  try { url = new URL(value); } catch { throw new PlannedOverlayError("invalid-plan-ref", "Plan Ref must be a valid fpp://local URL."); }
  if (url.protocol !== "fpp:" || url.hostname !== "local" || url.search || url.hash) throw new PlannedOverlayError("invalid-plan-ref", "Plan Ref must use fpp://local without query or fragment components.");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length !== 3) throw new PlannedOverlayError("invalid-plan-ref", "Plan Ref must identify project, checkpoint, and planned node.");
  const suffix = segments[2].match(/^(.*)@(\d+)$/u);
  if (!suffix) throw new PlannedOverlayError("invalid-plan-ref", "Plan Ref must end with @<overlay-version>.");
  const [, plannedNodeId, versionText] = suffix;
  const overlayVersion = Number(versionText);
  if (!Number.isSafeInteger(overlayVersion) || overlayVersion < 1) throw new PlannedOverlayError("invalid-plan-ref", "Plan Ref overlayVersion must be a positive integer.");
  return {
    schemaVersion: PLAN_REF_SCHEMA,
    planRef: createPlanRef(segments[0], segments[1], plannedNodeId, overlayVersion),
    projectId: segments[0],
    checkpointId: safeId(segments[1], "checkpointId"),
    plannedNodeId: safeId(plannedNodeId, "plannedNodeId"),
    overlayVersion,
  };
}

function storePath(root) {
  return path.join(root, PLANNED_OVERLAY_STORE_RELATIVE_PATH);
}

function emptyStore(projectId) {
  return { schemaVersion: PLANNED_OVERLAY_STORE_SCHEMA, projectId, records: [] };
}

function normalizeContextRef(graph, value, allowedContextRefs, name) {
  let parsed;
  try { parsed = parseContextRef(value); } catch (error) { throw new PlannedOverlayError("invalid-context-ref", `${name} must be a technical Context Ref: ${error.message}`); }
  if (parsed.projectId !== graph.project.projectId) throw new PlannedOverlayError("wrong-project-id", `${name} must belong to the current Flopeek project.`);
  if (!allowedContextRefs.has(parsed.contextRef)) throw new PlannedOverlayError("unselected-checkpoint-context", `${name} must be one of the checkpoint-selected Context Refs.`, 409);
  return parsed.contextRef;
}

function normalizeNode(graph, value, allowedContextRefs, index) {
  if (!onlyKnownKeys(value, ["id", "kind", "title", "responsibility", "acceptanceCriteria", "anchors", "candidatePath"])) throw new PlannedOverlayError("unknown-planned-node-field", `nodes[${index}] contains an unknown field.`);
  const kind = safeText(value.kind, `nodes[${index}].kind`, { required: true, maximum: 80 });
  if (!PLANNED_NODE_KINDS.has(kind)) throw new PlannedOverlayError("invalid-planned-node-kind", `nodes[${index}].kind is not a supported planned-node kind.`);
  if (!Array.isArray(value.anchors) || !value.anchors.length || value.anchors.length > MAX_TEXT_ITEMS) throw new PlannedOverlayError("invalid-planned-anchors", `nodes[${index}].anchors must contain one or more checkpoint-selected Context Refs.`);
  const anchors = [...new Set(value.anchors.map((contextRef, anchorIndex) => normalizeContextRef(graph, contextRef, allowedContextRefs, `nodes[${index}].anchors[${anchorIndex}]`)))].sort();
  return {
    id: safeId(value.id, `nodes[${index}].id`),
    kind,
    title: safeText(value.title, `nodes[${index}].title`, { required: true, maximum: 240 }),
    responsibility: value.responsibility === undefined || value.responsibility === null ? null : safeText(value.responsibility, `nodes[${index}].responsibility`, { required: true, maximum: 1_200 }),
    acceptanceCriteria: normalizeTextList(value.acceptanceCriteria, `nodes[${index}].acceptanceCriteria`),
    anchors,
    candidatePath: normalizeCandidatePath(value.candidatePath),
  };
}

function normalizeEndpoint(graph, value, nodeIds, allowedContextRefs, name) {
  if (!onlyKnownKeys(value, ["kind", "plannedNodeId", "contextRef"])) throw new PlannedOverlayError("unknown-planned-endpoint-field", `${name} contains an unknown field.`);
  if (value.kind === "planned-node") {
    const plannedNodeId = safeId(value.plannedNodeId, `${name}.plannedNodeId`);
    if (value.contextRef !== undefined || !nodeIds.has(plannedNodeId)) throw new PlannedOverlayError("invalid-planned-endpoint", `${name} must reference a planned node in this overlay.`);
    return { kind: "planned-node", plannedNodeId };
  }
  if (value.kind === "context-ref") {
    if (value.plannedNodeId !== undefined) throw new PlannedOverlayError("invalid-planned-endpoint", `${name} must contain one endpoint identity.`);
    return { kind: "context-ref", contextRef: normalizeContextRef(graph, value.contextRef, allowedContextRefs, `${name}.contextRef`) };
  }
  throw new PlannedOverlayError("invalid-planned-endpoint", `${name}.kind must be planned-node or context-ref.`);
}

function normalizeEdges(graph, value, nodeIds, allowedContextRefs) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EDGES) throw new PlannedOverlayError("invalid-planned-edges", `edges must contain at most ${MAX_EDGES} relationships.`);
  const edges = value.map((edge, index) => {
    if (!onlyKnownKeys(edge, ["relationship", "source", "target"])) throw new PlannedOverlayError("unknown-planned-edge-field", `edges[${index}] contains an unknown field.`);
    const relationship = safeText(edge.relationship, `edges[${index}].relationship`, { required: true, maximum: 80 });
    if (!PLANNED_RELATIONSHIPS.has(relationship)) throw new PlannedOverlayError("invalid-planned-relationship", `edges[${index}].relationship must be an explicitly planned relationship, never a factual graph edge.`);
    const source = normalizeEndpoint(graph, edge.source, nodeIds, allowedContextRefs, `edges[${index}].source`);
    const target = normalizeEndpoint(graph, edge.target, nodeIds, allowedContextRefs, `edges[${index}].target`);
    if (source.kind !== "planned-node" && target.kind !== "planned-node") throw new PlannedOverlayError("unanchored-planned-edge", `edges[${index}] must contain at least one planned node.`);
    return { relationship, source, target };
  });
  const keyed = new Map(edges.map((edge) => [JSON.stringify(canonicalize(edge)), edge]));
  return [...keyed.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function checkpointForCreate(root, graph, checkpointId) {
  const checkpoints = readContinuationCheckpointStore(root, graph.project.projectId);
  if (checkpoints.status === "invalid") throw new PlannedOverlayError("invalid-continuation-checkpoint-store", checkpoints.diagnostics[0].message);
  const checkpoint = checkpoints.store.records.find((record) => record.id === checkpointId);
  if (!checkpoint) throw new PlannedOverlayError("unknown-continuation-checkpoint", `checkpointId ${checkpointId} does not exist.`, 404);
  return checkpoint;
}

function normalizeInput(root, graph, input, store) {
  if (!onlyKnownKeys(input, ["operationId", "id", "expectedGraphVersion", "checkpointId", "nodes", "edges", "createdBy", "createdByKind"])) throw new PlannedOverlayError("unknown-planned-overlay-field", "Planned overlays accept only documented fields.");
  if (!Number.isSafeInteger(input.expectedGraphVersion)) throw new PlannedOverlayError("invalid-expected-graph-version", "expectedGraphVersion must be an integer.");
  if (input.expectedGraphVersion !== graph.state.graphVersion) throw new PlannedOverlayError("stale-graph-version", `Current graph version is ${graph.state.graphVersion}, not ${input.expectedGraphVersion}.`, 409);
  const checkpointId = safeId(input.checkpointId, "checkpointId");
  const checkpoint = checkpointForCreate(root, graph, checkpointId);
  const allowedContextRefs = new Set(checkpoint.selectedContextRefs.map((item) => item.contextRef));
  if (!Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > MAX_NODES) throw new PlannedOverlayError("invalid-planned-nodes", `nodes must contain between 1 and ${MAX_NODES} planned nodes.`);
  const nodes = input.nodes.map((node, index) => normalizeNode(graph, node, allowedContextRefs, index)).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new PlannedOverlayError("duplicate-planned-node-id", "Each planned node ID must be unique within one overlay.");
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = normalizeEdges(graph, input.edges, nodeIds, allowedContextRefs);
  return {
    id: safeId(input.id, "id"),
    operationId: safeText(input.operationId, "operationId", { required: true, maximum: 240 }),
    projectIdentity: { projectId: graph.project.projectId },
    checkpointId,
    nodes,
    edges,
    createdBy: safeText(input.createdBy, "createdBy", { required: true, maximum: 240 }),
    createdByKind: (() => { const kind = safeId(input.createdByKind, "createdByKind"); if (!CREATED_BY_KINDS.has(kind)) throw new PlannedOverlayError("invalid-created-by-kind", "createdByKind must be human, agent, or tool."); return kind; })(),
    overlayVersion: Math.max(0, ...store.records.filter((record) => record.checkpointId === checkpointId).map((record) => record.overlayVersion)) + 1,
  };
}

function validContextRef(value, projectId) {
  try { return typeof value === "string" && parseContextRef(value).projectId === projectId; } catch { return false; }
}

function validCandidatePath(value) {
  if (value === null) return true;
  if (!validPortableText(value, { required: true, maximum: 1_200 })) return false;
  const normalized = value.replaceAll("\\", "/");
  return !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(normalized) && !normalized.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function validTextList(value) {
  return Array.isArray(value) && value.length <= MAX_TEXT_ITEMS && value.every((item) => validPortableText(item, { required: true, maximum: 1_200 }));
}

function validNode(value, projectId) {
  return onlyKnownKeys(value, ["id", "kind", "title", "responsibility", "acceptanceCriteria", "anchors", "candidatePath"])
    && validId(value.id)
    && PLANNED_NODE_KINDS.has(value.kind)
    && validPortableText(value.title, { required: true, maximum: 240 })
    && (value.responsibility === null || validPortableText(value.responsibility, { required: true, maximum: 1_200 }))
    && validTextList(value.acceptanceCriteria)
    && Array.isArray(value.anchors) && value.anchors.length >= 1 && value.anchors.length <= MAX_TEXT_ITEMS && value.anchors.every((contextRef) => validContextRef(contextRef, projectId))
    && validCandidatePath(value.candidatePath);
}

function validEndpoint(value, nodeIds, projectId) {
  return onlyKnownKeys(value, ["kind", "plannedNodeId", "contextRef"])
    && (value.kind === "planned-node" ? validId(value.plannedNodeId) && nodeIds.has(value.plannedNodeId) && value.contextRef === undefined : value.kind === "context-ref" ? value.plannedNodeId === undefined && validContextRef(value.contextRef, projectId) : false);
}

function validRecord(value, projectId) {
  if (!onlyKnownKeys(value, ["schemaVersion", "id", "operationId", "inputFingerprint", "projectIdentity", "checkpointId", "overlayVersion", "nodes", "edges", "createdBy", "createdByKind", "createdAt", "evidenceClass", "policy"])) return false;
  const nodeIds = new Set(Array.isArray(value.nodes) ? value.nodes.map((node) => node.id) : []);
  return value.schemaVersion === PLANNED_OVERLAY_SCHEMA
    && validId(value.id)
    && validPortableText(value.operationId, { required: true, maximum: 240 })
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && onlyKnownKeys(value.projectIdentity, ["projectId"]) && value.projectIdentity.projectId === projectId
    && validId(value.checkpointId)
    && Number.isSafeInteger(value.overlayVersion) && value.overlayVersion >= 1
    && Array.isArray(value.nodes) && value.nodes.length >= 1 && value.nodes.length <= MAX_NODES && value.nodes.every((node) => validNode(node, projectId)) && nodeIds.size === value.nodes.length
    && Array.isArray(value.edges) && value.edges.length <= MAX_EDGES && value.edges.every((edge) => onlyKnownKeys(edge, ["relationship", "source", "target"]) && PLANNED_RELATIONSHIPS.has(edge.relationship) && validEndpoint(edge.source, nodeIds, projectId) && validEndpoint(edge.target, nodeIds, projectId) && (edge.source.kind === "planned-node" || edge.target.kind === "planned-node"))
    && validPortableText(value.createdBy, { required: true, maximum: 240 })
    && CREATED_BY_KINDS.has(value.createdByKind)
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && value.evidenceClass === "delivery-plan"
    && onlyKnownKeys(value.policy, ["sourceBodies", "rawLogs", "credentials", "machinePaths", "privateReasoning"])
    && Object.values(value.policy).every((item) => item === "excluded");
}

function recordAnchorsWithinCheckpoint(record, checkpoint) {
  if (!checkpoint) return false;
  const selected = new Set(checkpoint.selectedContextRefs.map((item) => item.contextRef));
  const endpointSelected = (endpoint) => endpoint.kind !== "context-ref" || selected.has(endpoint.contextRef);
  return record.nodes.every((node) => node.anchors.every((contextRef) => selected.has(contextRef)))
    && record.edges.every((edge) => endpointSelected(edge.source) && endpointSelected(edge.target));
}

function readPlannedOverlayStore(root, projectId) {
  const target = storePath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const records = Array.isArray(store?.records) ? store.records : [];
    const ids = records.map((record) => record.id);
    const operationIds = records.map((record) => record.operationId);
    const versions = records.map((record) => `${record.checkpointId}@${record.overlayVersion}`);
    const checkpoints = readContinuationCheckpointStore(root, projectId);
    const checkpointById = checkpoints.status === "valid" ? new Map(checkpoints.store.records.map((checkpoint) => [checkpoint.id, checkpoint])) : new Map();
    const valid = onlyKnownKeys(store, ["schemaVersion", "projectId", "records"])
      && store.schemaVersion === PLANNED_OVERLAY_STORE_SCHEMA
      && store.projectId === projectId
      && records.length <= MAX_OVERLAYS
      && records.every((record) => validRecord(record, projectId))
      && checkpoints.status !== "invalid"
      && records.every((record) => recordAnchorsWithinCheckpoint(record, checkpointById.get(record.checkpointId)))
      && new Set(ids).size === ids.length
      && new Set(operationIds).size === operationIds.length
      && new Set(versions).size === versions.length;
    if (!valid) return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-planned-overlay-store", message: "Planned overlay storage does not match flopeek-planned-overlays/v1." }] };
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-planned-overlay-json", message: `Planned overlay storage is not valid JSON (${error.message}).` }] };
  }
}

function createPlannedOverlay(root, graph, input, options = {}) {
  const read = readPlannedOverlayStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new PlannedOverlayError("invalid-planned-overlay-store", read.diagnostics[0].message);
  const normalized = normalizeInput(root, graph, input || {}, read.store);
  const inputFingerprint = fingerprint({ ...normalized, overlayVersion: undefined });
  const existingOperation = read.store.records.find((record) => record.operationId === normalized.operationId);
  if (existingOperation) {
    if (existingOperation.inputFingerprint !== inputFingerprint) throw new PlannedOverlayError("operation-id-conflict", "operationId already belongs to another planned overlay.", 409);
    return { schemaVersion: "flopeek-planned-overlay-create-result/v1", created: false, overlay: existingOperation };
  }
  if (read.store.records.some((record) => record.id === normalized.id)) throw new PlannedOverlayError("planned-overlay-exists", `Planned overlay ${normalized.id} already exists.`, 409);
  if (read.store.records.length >= MAX_OVERLAYS) throw new PlannedOverlayError("planned-overlay-store-full", `Planned overlay storage reached its explicit ${MAX_OVERLAYS}-record limit.`, 507);
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new PlannedOverlayError("invalid-time", "createdAt must be an ISO-compatible timestamp.");
  const overlay = {
    schemaVersion: PLANNED_OVERLAY_SCHEMA,
    ...normalized,
    inputFingerprint,
    createdAt: new Date(createdAt).toISOString(),
    evidenceClass: "delivery-plan",
    policy: { sourceBodies: "excluded", rawLogs: "excluded", credentials: "excluded", machinePaths: "excluded", privateReasoning: "excluded" },
  };
  atomicWriteJson(read.path, { ...read.store, records: [...read.store.records, overlay] });
  return { schemaVersion: "flopeek-planned-overlay-create-result/v1", created: true, overlay };
}

function overlayCheckpointStatus(root, graph, checkpointId) {
  const checkpoints = listContinuationCheckpoints(root, graph);
  if (checkpoints.status !== "available") return "unavailable";
  return checkpoints.records.find((record) => record.id === checkpointId)?.freshnessStatus || "unavailable";
}

function projectOverlay(root, graph, record) {
  const checkpointFreshnessStatus = overlayCheckpointStatus(root, graph, record.checkpointId);
  return {
    ...record,
    checkpointFreshnessStatus,
    nodes: record.nodes.map((node) => ({
      ...node,
      planRef: createPlanRef(graph.project.projectId, record.checkpointId, node.id, record.overlayVersion),
    })),
  };
}

function listPlannedOverlays(root, graph) {
  const read = readPlannedOverlayStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flopeek-planned-overlay-list/v1", status: "unavailable", project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion }, records: [], diagnostics: read.diagnostics };
  return {
    schemaVersion: "flopeek-planned-overlay-list/v1",
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    storage: { relativePath: PLANNED_OVERLAY_STORE_RELATIVE_PATH, status: read.status },
    records: [...read.store.records].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).map((record) => projectOverlay(root, graph, record)),
    diagnostics: [],
    limitation: "Planned overlays are immutable delivery-plan metadata. They do not create source nodes or factual edges, alter Flow Lens or impact, prove implementation or runtime behavior, or reconcile a plan with later source.",
  };
}

function resolvePlanRef(root, graph, value) {
  let parsed;
  try { parsed = parsePlanRef(value); } catch (error) {
    return {
      schemaVersion: "flopeek-plan-ref-resolution/v1",
      status: "unresolved",
      requestedRef: value,
      resolvedRef: null,
      plan: null,
      reason: error.message,
      code: error.code || "invalid-plan-ref",
    };
  }
  if (parsed.projectId !== graph.project.projectId) {
    return {
      schemaVersion: "flopeek-plan-ref-resolution/v1",
      status: "unresolved",
      requestedRef: value,
      resolvedRef: null,
      plan: null,
      reason: "Plan Ref belongs to a different Flopeek project.",
      code: "wrong-project-id",
    };
  }
  const listed = listPlannedOverlays(root, graph);
  if (listed.status !== "available") {
    return {
      schemaVersion: "flopeek-plan-ref-resolution/v1",
      status: "unavailable",
      requestedRef: value,
      resolvedRef: null,
      plan: null,
      diagnostics: listed.diagnostics,
      reason: "Planned-overlay storage is unavailable; no replacement plan is inferred.",
    };
  }
  const overlay = listed.records.find((record) => record.checkpointId === parsed.checkpointId && record.overlayVersion === parsed.overlayVersion);
  if (!overlay) {
    return {
      schemaVersion: "flopeek-plan-ref-resolution/v1",
      status: "unresolved",
      requestedRef: value,
      resolvedRef: null,
      plan: null,
      reason: "The exact planned-overlay version is not retained locally. Flopeek does not redirect Plan Refs to another overlay.",
      code: "planned-overlay-not-found",
    };
  }
  const node = overlay.nodes.find((candidate) => candidate.id === parsed.plannedNodeId);
  if (!node) {
    return {
      schemaVersion: "flopeek-plan-ref-resolution/v1",
      status: "unresolved",
      requestedRef: value,
      resolvedRef: null,
      plan: null,
      reason: "The exact planned node is not present in the retained overlay. Flopeek does not redirect Plan Refs to another node.",
      code: "planned-node-not-found",
    };
  }
  const status = overlay.checkpointFreshnessStatus === "current"
    ? "current"
    : overlay.checkpointFreshnessStatus === "future"
      ? "future"
      : "stale";
  return {
    schemaVersion: "flopeek-plan-ref-resolution/v1",
    status,
    requestedRef: value,
    resolvedRef: node.planRef,
    plan: {
      overlay: {
        id: overlay.id,
        checkpointId: overlay.checkpointId,
        overlayVersion: overlay.overlayVersion,
        createdAt: overlay.createdAt,
        checkpointFreshnessStatus: overlay.checkpointFreshnessStatus,
      },
      node,
    },
    reason: status === "current"
      ? "The exact planned node is retained and its checkpoint anchors are current."
      : status === "future"
        ? "The exact planned node is retained, but its checkpoint baseline is newer than the current graph. No current source or Context Ref replacement is inferred."
        : "The exact planned node is retained, but its checkpoint anchors are not current. No current source or Context Ref replacement is inferred.",
    limitation: listed.limitation,
  };
}

function getPlannedOverlay(root, graph, overlayId) {
  const listed = listPlannedOverlays(root, graph);
  if (listed.status !== "available") return { schemaVersion: "flopeek-planned-overlay-get/v1", status: "unavailable", overlay: null, diagnostics: listed.diagnostics };
  const id = safeId(overlayId, "overlayId");
  const overlay = listed.records.find((record) => record.id === id);
  if (!overlay) throw new PlannedOverlayError("unknown-planned-overlay", `Planned overlay ${id} does not exist.`, 404);
  return { schemaVersion: "flopeek-planned-overlay-get/v1", status: "available", overlay, diagnostics: [], limitation: listed.limitation };
}

module.exports = {
  CREATED_BY_KINDS,
  MAX_EDGES,
  MAX_NODES,
  PLAN_REF_SCHEMA,
  PLANNED_NODE_KINDS,
  PLANNED_OVERLAY_SCHEMA,
  PLANNED_OVERLAY_STORE_RELATIVE_PATH,
  PLANNED_OVERLAY_STORE_SCHEMA,
  PLANNED_RELATIONSHIPS,
  PlannedOverlayError,
  createPlanRef,
  createPlannedOverlay,
  getPlannedOverlay,
  listPlannedOverlays,
  parsePlanRef,
  readPlannedOverlayStore,
  resolvePlanRef,
};
