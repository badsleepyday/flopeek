"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { parseContextRef } = require("./context-card");
const { sourceBasis } = require("./durable-brief");
const { readDeliveryStore } = require("./delivery-graph");
const { listHandoffWorkspaces, portableText } = require("./handoff-workspace");

const CONTINUATION_CHECKPOINT_SCHEMA = "flowpeek-continuation-checkpoint/v1";
const CONTINUATION_CHECKPOINT_STORE_SCHEMA = "flowpeek-continuation-checkpoints/v1";
const CONTINUATION_CHECKPOINT_STORE_RELATIVE_PATH = ".flowpeek/delivery/continuation-checkpoints.json";
const MAX_CHECKPOINTS = 10_000;
const MAX_WORK_RECORDS = 200;
const MAX_CONTEXT_REFS = 100;
const MAX_TEXT_ITEMS = 100;
const CREATED_BY_KINDS = new Set(["human", "agent", "tool"]);

class ContinuationCheckpointError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ContinuationCheckpointError";
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
    throw new ContinuationCheckpointError(error.code || "unsafe-checkpoint-text", error.message, error.statusCode || 400);
  }
}

function safeId(value, name) {
  const normalized = safeText(value, name, { required: true, maximum: 160 });
  if (!/^[a-z][a-z0-9._:-]*$/u.test(normalized)) throw new ContinuationCheckpointError("invalid-id", `${name} must start with a lowercase letter and contain only lowercase letters, digits, dots, underscores, colons, or hyphens.`);
  return normalized;
}

function validPortableText(value, options = {}) {
  try {
    return portableText(value, "stored checkpoint text", options) === value;
  } catch {
    return false;
  }
}

function validId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9._:-]*$/u.test(value) && validPortableText(value, { required: true, maximum: 160 });
}

function isoTime(value, name) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ContinuationCheckpointError("invalid-time", `${name} must be an ISO-compatible timestamp.`);
  return new Date(value).toISOString();
}

function sourceBaseline(graph) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new ContinuationCheckpointError("missing-graph-identity", "A continuation checkpoint requires a current project identity and graph version.");
  const basis = sourceBasis(graph);
  if (!basis.value || !basis.sourceFingerprint) throw new ContinuationCheckpointError("baseline-unavailable", "The current graph has no usable Git revision or source fingerprint for a continuation checkpoint.");
  const git = graph.project.git || {};
  return {
    kind: basis.kind,
    value: basis.value,
    gitRevision: basis.gitRevision || null,
    branch: typeof git.branch === "string" && git.branch ? git.branch : null,
    dirty: typeof git.dirty === "boolean" ? git.dirty : null,
    sourceFingerprint: basis.sourceFingerprint,
    graphVersion: graph.state.graphVersion,
  };
}

function normalizeExpectedGraphVersion(value, graph) {
  if (!Number.isSafeInteger(value)) throw new ContinuationCheckpointError("invalid-expected-graph-version", "expectedGraphVersion must be an integer.");
  if (value !== graph.state.graphVersion) throw new ContinuationCheckpointError("stale-graph-version", `Current graph version is ${graph.state.graphVersion}, not ${value}.`, 409);
  return value;
}

function normalizeIdList(value, name, maximum = MAX_WORK_RECORDS) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new ContinuationCheckpointError("invalid-id-list", `${name} must contain at most ${maximum} IDs.`);
  return [...new Set(value.map((item, index) => safeId(item, `${name}[${index}]`)))].sort();
}

function normalizeTextList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TEXT_ITEMS) throw new ContinuationCheckpointError("invalid-text-list", `${name} must contain at most ${MAX_TEXT_ITEMS} items.`);
  return value.map((item, index) => safeText(item, `${name}[${index}]`, { required: true, maximum: 1_200 }));
}

function normalizeContextRefs(graph, value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CONTEXT_REFS) throw new ContinuationCheckpointError("invalid-context-refs", `selectedContextRefs must contain between 1 and ${MAX_CONTEXT_REFS} Context Refs.`);
  const refs = value.map((contextRef, index) => {
    let parsed;
    try { parsed = parseContextRef(contextRef); } catch (error) { throw new ContinuationCheckpointError("invalid-context-ref", `selectedContextRefs[${index}] is invalid: ${error.message}`); }
    if (parsed.projectId !== graph.project.projectId) throw new ContinuationCheckpointError("wrong-project-id", "A continuation checkpoint may reference only Context Refs from its current Flowpeek project.");
    if (parsed.graphVersion !== graph.state.graphVersion) throw new ContinuationCheckpointError("stale-context-ref", "Every selected Context Ref must target the current graph version when a checkpoint is created.", 409);
    return { contextRef: parsed.contextRef, kind: parsed.kind, contextId: parsed.contextId, graphVersion: parsed.graphVersion };
  });
  return [...new Map(refs.map((item) => [item.contextRef, item])).values()].sort((left, right) => left.contextRef.localeCompare(right.contextRef));
}

function normalizeCreatedByKind(value) {
  const kind = safeId(value, "createdByKind");
  if (!CREATED_BY_KINDS.has(kind)) throw new ContinuationCheckpointError("invalid-created-by-kind", `createdByKind must be one of: ${[...CREATED_BY_KINDS].join(", ")}.`);
  return kind;
}

function emptyStore(projectId) {
  return { schemaVersion: CONTINUATION_CHECKPOINT_STORE_SCHEMA, projectId, records: [] };
}

function storePath(root) {
  return path.join(root, CONTINUATION_CHECKPOINT_STORE_RELATIVE_PATH);
}

function validBaseline(value) {
  return onlyKnownKeys(value, ["kind", "value", "gitRevision", "branch", "dirty", "sourceFingerprint", "graphVersion"])
    && ["git-revision", "working-tree-fingerprint"].includes(value.kind)
    && typeof value.value === "string" && value.value
    && (value.gitRevision === null || typeof value.gitRevision === "string")
    && (value.branch === null || typeof value.branch === "string")
    && (value.dirty === null || typeof value.dirty === "boolean")
    && typeof value.sourceFingerprint === "string" && value.sourceFingerprint.startsWith("sha256:")
    && Number.isSafeInteger(value.graphVersion) && value.graphVersion >= 0;
}

function validContextRef(value, projectId) {
  return onlyKnownKeys(value, ["contextRef", "kind", "contextId", "graphVersion"])
    && typeof value.contextRef === "string"
    && typeof value.kind === "string"
    && typeof value.contextId === "string"
    && Number.isSafeInteger(value.graphVersion)
    && (() => { try { const parsed = parseContextRef(value.contextRef); return parsed.projectId === projectId && parsed.graphVersion === value.graphVersion && parsed.kind === value.kind && parsed.contextId === value.contextId; } catch { return false; } })();
}

function validTextList(value) {
  return Array.isArray(value) && value.length <= MAX_TEXT_ITEMS && value.every((item) => validPortableText(item, { required: true, maximum: 1_200 }));
}

function validIdList(value, maximum = MAX_WORK_RECORDS) {
  return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length && value.every(validId);
}

function validPolicy(value) {
  return onlyKnownKeys(value, ["sourceBodies", "rawLogs", "credentials", "machinePaths", "privateReasoning"])
    && value.sourceBodies === "excluded"
    && value.rawLogs === "excluded"
    && value.credentials === "excluded"
    && value.machinePaths === "excluded"
    && value.privateReasoning === "excluded";
}

function validRecord(value, projectId) {
  return onlyKnownKeys(value, ["schemaVersion", "id", "operationId", "inputFingerprint", "projectIdentity", "baseline", "handoffWorkspaceId", "workRecordIds", "completedWorkRecordIds", "remainingWorkRecordIds", "selectedContextRefs", "constraints", "acceptanceCriteria", "unresolvedQuestions", "createdBy", "createdByKind", "createdAt", "supersedes", "evidenceClass", "policy"])
    && value.schemaVersion === CONTINUATION_CHECKPOINT_SCHEMA
    && validId(value.id)
    && validPortableText(value.operationId, { required: true, maximum: 240 })
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && onlyKnownKeys(value.projectIdentity, ["projectId"]) && value.projectIdentity.projectId === projectId
    && validBaseline(value.baseline)
    && (value.handoffWorkspaceId === null || validId(value.handoffWorkspaceId))
    && validIdList(value.workRecordIds)
    && validIdList(value.completedWorkRecordIds)
    && validIdList(value.remainingWorkRecordIds)
    && value.completedWorkRecordIds.every((id) => value.workRecordIds.includes(id))
    && value.remainingWorkRecordIds.every((id) => value.workRecordIds.includes(id))
    && !value.completedWorkRecordIds.some((id) => value.remainingWorkRecordIds.includes(id))
    && Array.isArray(value.selectedContextRefs) && value.selectedContextRefs.length >= 1 && value.selectedContextRefs.length <= MAX_CONTEXT_REFS && value.selectedContextRefs.every((item) => validContextRef(item, projectId))
    && validTextList(value.constraints)
    && validTextList(value.acceptanceCriteria)
    && validTextList(value.unresolvedQuestions)
    && validPortableText(value.createdBy, { required: true, maximum: 240 })
    && CREATED_BY_KINDS.has(value.createdByKind)
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && (value.supersedes === null || validId(value.supersedes))
    && value.evidenceClass === "delivery-plan"
    && validPolicy(value.policy);
}

function readContinuationCheckpointStore(root, projectId) {
  const target = storePath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const ids = Array.isArray(store?.records) ? store.records.map((record) => record.id) : [];
    const operationIds = Array.isArray(store?.records) ? store.records.map((record) => record.operationId) : [];
    const supersededIds = Array.isArray(store?.records) ? store.records.map((record) => record.supersedes).filter(Boolean) : [];
    const valid = onlyKnownKeys(store, ["schemaVersion", "projectId", "records"])
      && store.schemaVersion === CONTINUATION_CHECKPOINT_STORE_SCHEMA
      && store.projectId === projectId
      && Array.isArray(store.records) && store.records.length <= MAX_CHECKPOINTS
      && store.records.every((record) => validRecord(record, projectId))
      && new Set(ids).size === ids.length
      && new Set(operationIds).size === operationIds.length
      && new Set(supersededIds).size === supersededIds.length
      && store.records.every((record) => record.supersedes === null || (record.supersedes !== record.id && ids.includes(record.supersedes)));
    if (!valid) return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-continuation-checkpoint-store", message: "Continuation checkpoint storage does not match flowpeek-continuation-checkpoints/v1." }] };
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-continuation-checkpoint-json", message: `Continuation checkpoint storage is not valid JSON (${error.message}).` }] };
  }
}

function validateWorkRecords(root, graph, workRecordIds) {
  const delivery = readDeliveryStore(root, graph.project.projectId);
  if (delivery.status === "invalid") throw new ContinuationCheckpointError("invalid-delivery-store", delivery.diagnostics[0].message);
  const known = new Set(delivery.store.records.map((record) => record.id));
  for (const id of workRecordIds) if (!known.has(id)) throw new ContinuationCheckpointError("unknown-work-record", `workRecordIds references unknown Work record ${id}.`, 404);
}

function validateHandoffWorkspace(root, graph, handoffWorkspaceId) {
  if (handoffWorkspaceId === undefined || handoffWorkspaceId === null) return null;
  const id = safeId(handoffWorkspaceId, "handoffWorkspaceId");
  const workspaces = listHandoffWorkspaces(root, graph);
  if (workspaces.status !== "available") throw new ContinuationCheckpointError("handoff-workspace-unavailable", "The local Handoff Workspace store is unavailable.");
  if (!workspaces.records.some((record) => record.id === id)) throw new ContinuationCheckpointError("unknown-handoff-workspace", `handoffWorkspaceId ${id} does not exist.`, 404);
  return id;
}

function normalizeInput(root, graph, input, store) {
  if (!onlyKnownKeys(input, ["operationId", "id", "expectedGraphVersion", "handoffWorkspaceId", "workRecordIds", "completedWorkRecordIds", "remainingWorkRecordIds", "selectedContextRefs", "constraints", "acceptanceCriteria", "unresolvedQuestions", "createdBy", "createdByKind", "supersedes"])) throw new ContinuationCheckpointError("unknown-checkpoint-field", "Continuation checkpoints accept only documented fields.");
  normalizeExpectedGraphVersion(input.expectedGraphVersion, graph);
  const workRecordIds = normalizeIdList(input.workRecordIds, "workRecordIds");
  const completedWorkRecordIds = normalizeIdList(input.completedWorkRecordIds, "completedWorkRecordIds");
  const remainingWorkRecordIds = normalizeIdList(input.remainingWorkRecordIds, "remainingWorkRecordIds");
  if (!completedWorkRecordIds.every((id) => workRecordIds.includes(id)) || !remainingWorkRecordIds.every((id) => workRecordIds.includes(id))) throw new ContinuationCheckpointError("work-record-membership", "Completed and remaining work-record IDs must be included in workRecordIds.");
  if (completedWorkRecordIds.some((id) => remainingWorkRecordIds.includes(id))) throw new ContinuationCheckpointError("overlapping-work-record-state", "Completed and remaining work-record IDs must be disjoint.");
  validateWorkRecords(root, graph, workRecordIds);
  const id = safeId(input.id, "id");
  const supersedes = input.supersedes === undefined || input.supersedes === null ? null : safeId(input.supersedes, "supersedes");
  if (supersedes === id) throw new ContinuationCheckpointError("self-supersedes", "A continuation checkpoint cannot supersede itself.");
  if (supersedes) {
    if (!store.records.some((record) => record.id === supersedes)) throw new ContinuationCheckpointError("unknown-superseded-checkpoint", `supersedes references unknown checkpoint ${supersedes}.`, 404);
    if (store.records.some((record) => record.supersedes === supersedes)) throw new ContinuationCheckpointError("checkpoint-already-superseded", `Checkpoint ${supersedes} already has a retained successor.`, 409);
  }
  return {
    id,
    operationId: safeText(input.operationId, "operationId", { required: true, maximum: 240 }),
    projectIdentity: { projectId: graph.project.projectId },
    baseline: sourceBaseline(graph),
    handoffWorkspaceId: validateHandoffWorkspace(root, graph, input.handoffWorkspaceId),
    workRecordIds,
    completedWorkRecordIds,
    remainingWorkRecordIds,
    selectedContextRefs: normalizeContextRefs(graph, input.selectedContextRefs),
    constraints: normalizeTextList(input.constraints, "constraints"),
    acceptanceCriteria: normalizeTextList(input.acceptanceCriteria, "acceptanceCriteria"),
    unresolvedQuestions: normalizeTextList(input.unresolvedQuestions, "unresolvedQuestions"),
    createdBy: safeText(input.createdBy, "createdBy", { required: true, maximum: 240 }),
    createdByKind: normalizeCreatedByKind(input.createdByKind),
    supersedes,
  };
}

function createContinuationCheckpoint(root, graph, input, options = {}) {
  const read = readContinuationCheckpointStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new ContinuationCheckpointError("invalid-continuation-checkpoint-store", read.diagnostics[0].message);
  const normalized = normalizeInput(root, graph, input || {}, read.store);
  const inputFingerprint = fingerprint(normalized);
  const existingOperation = read.store.records.find((record) => record.operationId === normalized.operationId);
  if (existingOperation) {
    if (existingOperation.inputFingerprint !== inputFingerprint) throw new ContinuationCheckpointError("operation-id-conflict", "operationId already belongs to another continuation checkpoint.", 409);
    return { schemaVersion: "flowpeek-continuation-checkpoint-create-result/v1", created: false, checkpoint: existingOperation };
  }
  if (read.store.records.some((record) => record.id === normalized.id)) throw new ContinuationCheckpointError("checkpoint-exists", `Continuation checkpoint ${normalized.id} already exists.`, 409);
  if (read.store.records.length >= MAX_CHECKPOINTS) throw new ContinuationCheckpointError("checkpoint-store-full", `Continuation checkpoint storage reached its explicit ${MAX_CHECKPOINTS}-record limit.`, 507);
  const createdAt = options.now || new Date().toISOString();
  const checkpoint = {
    schemaVersion: CONTINUATION_CHECKPOINT_SCHEMA,
    ...normalized,
    inputFingerprint,
    createdAt: isoTime(createdAt, "createdAt"),
    evidenceClass: "delivery-plan",
    policy: { sourceBodies: "excluded", rawLogs: "excluded", credentials: "excluded", machinePaths: "excluded", privateReasoning: "excluded" },
  };
  atomicWriteJson(read.path, { ...read.store, records: [...read.store.records, checkpoint] });
  return { schemaVersion: "flowpeek-continuation-checkpoint-create-result/v1", created: true, checkpoint };
}

function freshness(graph, checkpoint) {
  if (checkpoint.projectIdentity.projectId !== graph.project.projectId) return "unavailable";
  if (checkpoint.baseline.graphVersion > graph.state.graphVersion) return "future";
  if (checkpoint.baseline.graphVersion === graph.state.graphVersion && checkpoint.baseline.sourceFingerprint === graph.state.sourceFingerprint) return "current";
  return "stale";
}

function lifecycleRecords(records) {
  const superseded = new Set(records.map((record) => record.supersedes).filter(Boolean));
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .map((record) => ({ ...record, lifecycleStatus: superseded.has(record.id) ? "superseded" : "active" }));
}

function listContinuationCheckpoints(root, graph) {
  const read = readContinuationCheckpointStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-continuation-checkpoint-list/v1", status: "unavailable", project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion }, records: [], diagnostics: read.diagnostics };
  const records = lifecycleRecords(read.store.records).map((record) => ({ ...record, freshnessStatus: freshness(graph, record) }));
  return {
    schemaVersion: "flowpeek-continuation-checkpoint-list/v1",
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    storage: { relativePath: CONTINUATION_CHECKPOINT_STORE_RELATIVE_PATH, status: read.status },
    records,
    diagnostics: [],
    limitation: "Continuation checkpoints record local delivery-plan metadata against one Git/source and graph baseline. They do not create source facts, prove implementation, verify tests, establish approval authority, or reconcile planned work with later code.",
  };
}

function getContinuationCheckpoint(root, graph, checkpointId) {
  const listed = listContinuationCheckpoints(root, graph);
  if (listed.status !== "available") return { schemaVersion: "flowpeek-continuation-checkpoint-get/v1", status: "unavailable", checkpoint: null, diagnostics: listed.diagnostics };
  const id = safeId(checkpointId, "checkpointId");
  const checkpoint = listed.records.find((record) => record.id === id);
  if (!checkpoint) throw new ContinuationCheckpointError("unknown-checkpoint", `Continuation checkpoint ${id} does not exist.`, 404);
  return { schemaVersion: "flowpeek-continuation-checkpoint-get/v1", status: "available", checkpoint, diagnostics: [], limitation: listed.limitation };
}

module.exports = {
  CONTINUATION_CHECKPOINT_SCHEMA,
  CONTINUATION_CHECKPOINT_STORE_RELATIVE_PATH,
  CONTINUATION_CHECKPOINT_STORE_SCHEMA,
  CREATED_BY_KINDS,
  ContinuationCheckpointError,
  MAX_CHECKPOINTS,
  createContinuationCheckpoint,
  getContinuationCheckpoint,
  listContinuationCheckpoints,
  readContinuationCheckpointStore,
  sourceBaseline,
};
