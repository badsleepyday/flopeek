"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { parseContextRef } = require("./context-card");
const { parsePlanRef, resolvePlanRef } = require("./planned-overlay");
const { portableText } = require("./handoff-workspace");

const PLAN_RECONCILIATION_SCHEMA = "flowpeek-plan-reconciliation/v1";
const PLAN_RECONCILIATION_STORE_SCHEMA = "flowpeek-plan-reconciliations/v1";
const PLAN_RECONCILIATION_STORE_RELATIVE_PATH = ".flowpeek/delivery/reconciliations.json";
const MAX_RECONCILIATIONS = 10_000;
const MAX_CONTEXT_REFS = 100;
const MAX_EVIDENCE_REFERENCES = 100;
const OUTCOMES = new Set(["confirmed-implemented", "partially-implemented", "implemented-differently", "not-the-same", "superseded", "unresolved"]);
const POSITIVE_OUTCOMES = new Set(["confirmed-implemented", "partially-implemented", "implemented-differently"]);
const ACTOR_KINDS = new Set(["human", "agent", "tool"]);

class PlanReconciliationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "PlanReconciliationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
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
    throw new PlanReconciliationError(error.code || "unsafe-plan-reconciliation-text", error.message, error.statusCode || 400);
  }
}

function safeId(value, name) {
  const normalized = safeText(value, name, { required: true, maximum: 160 });
  if (!/^[a-z][a-z0-9._:-]*$/u.test(normalized)) throw new PlanReconciliationError("invalid-id", `${name} must start with a lowercase letter and contain only lowercase letters, digits, dots, underscores, colons, or hyphens.`);
  return normalized;
}

function validPortableText(value, options = {}) {
  try { return portableText(value, "stored plan-reconciliation text", options) === value; } catch { return false; }
}

function validId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9._:-]*$/u.test(value) && validPortableText(value, { required: true, maximum: 160 });
}

function storePath(root) {
  return path.join(root, PLAN_RECONCILIATION_STORE_RELATIVE_PATH);
}

function emptyStore(projectId) {
  return { schemaVersion: PLAN_RECONCILIATION_STORE_SCHEMA, projectId, records: [] };
}

function resolveTechnicalContext(graph, value) {
  let parsed;
  try { parsed = parseContextRef(value); } catch (error) { return { status: "unresolved", requestedRef: value, resolvedRef: null, reason: error.message, code: error.code || "invalid-context-ref" }; }
  if (parsed.projectId !== graph.project.projectId) return { status: "unresolved", requestedRef: value, resolvedRef: null, reason: "Context Ref belongs to a different Flowpeek project.", code: "wrong-project-id" };
  if (parsed.graphVersion > graph.state.graphVersion) return { status: "unresolved", requestedRef: value, resolvedRef: null, reason: "Context Ref targets a graph version newer than the local graph.", code: "future-graph-version" };
  const present = parsed.kind === "node"
    ? graph.nodes.some((node) => node.id === parsed.contextId)
    : parsed.kind === "flow"
      ? graph.flows.some((flow) => flow.id === parsed.contextId)
      : false;
  if (!present) return { status: "unresolved", requestedRef: value, resolvedRef: null, reason: "The referenced technical context is not present in the current graph.", code: "context-not-found" };
  if (parsed.graphVersion === graph.state.graphVersion) return { status: "current", requestedRef: value, resolvedRef: value, reason: null, code: null };
  return { status: "stale", requestedRef: value, resolvedRef: null, reason: "The referenced technical context is present but its graph version is older than the current graph.", code: "stale-graph-version" };
}

function normalizePlanRef(root, graph, value) {
  let parsed;
  try { parsed = parsePlanRef(value); } catch (error) { throw new PlanReconciliationError(error.code || "invalid-plan-ref", error.message, error.statusCode || 400); }
  if (parsed.projectId !== graph.project.projectId) throw new PlanReconciliationError("wrong-project-id", "planRef must belong to the current Flowpeek project.");
  const resolution = resolvePlanRef(root, graph, parsed.planRef);
  if (!["current", "stale", "future"].includes(resolution.status)) throw new PlanReconciliationError("unavailable-plan-ref", "planRef must resolve to one retained planned node before reconciliation can be recorded.", 409);
  return parsed.planRef;
}

function normalizeActualContextRefs(graph, value, outcome, actorKind) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_REFS) throw new PlanReconciliationError("invalid-actual-context-refs", `actualContextRefs must contain at most ${MAX_CONTEXT_REFS} Context Refs.`);
  const refs = [...new Set(value.map((item, index) => safeText(item, `actualContextRefs[${index}]`, { required: true, maximum: 8_192 })))].sort();
  const resolutions = refs.map((contextRef) => {
    let parsed;
    try { parsed = parseContextRef(contextRef); } catch (error) { throw new PlanReconciliationError(error.code || "invalid-context-ref", `actualContextRefs must contain technical Context Refs: ${error.message}`); }
    if (parsed.projectId !== graph.project.projectId) throw new PlanReconciliationError("wrong-project-id", "actualContextRefs must belong to the current Flowpeek project.");
    return resolveTechnicalContext(graph, parsed.contextRef);
  });
  if (POSITIVE_OUTCOMES.has(outcome)) {
    if (actorKind !== "human") throw new PlanReconciliationError("positive-outcome-requires-human", "Positive implementation outcomes require human-authored reconciliation; agent and tool records remain proposals.", 409);
    if (!refs.length) throw new PlanReconciliationError("positive-outcome-requires-actual-context", "Positive implementation outcomes require one or more current actual Context Refs.", 409);
    const nonCurrent = resolutions.find((resolution) => resolution.status !== "current");
    if (nonCurrent) throw new PlanReconciliationError("actual-context-not-current", `Positive implementation outcomes require current actual Context Refs; one reference resolved as ${nonCurrent.status}.`, 409);
  }
  return refs;
}

function normalizeEvidenceReferences(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFERENCES) throw new PlanReconciliationError("invalid-evidence-references", `evidenceReferences must contain at most ${MAX_EVIDENCE_REFERENCES} references.`);
  const records = value.map((item, index) => {
    if (!onlyKnownKeys(item, ["kind", "reference", "evidenceClass"])) throw new PlanReconciliationError("unknown-evidence-reference-field", `evidenceReferences[${index}] contains an unknown field.`);
    return {
      kind: safeText(item.kind, `evidenceReferences[${index}].kind`, { required: true, maximum: 80 }),
      reference: safeText(item.reference, `evidenceReferences[${index}].reference`, { required: true, maximum: 800 }),
      evidenceClass: safeText(item.evidenceClass, `evidenceReferences[${index}].evidenceClass`, { required: true, maximum: 80 }),
    };
  });
  const unique = new Map(records.map((item) => [JSON.stringify(canonicalize(item)), item]));
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeInput(root, graph, input, store) {
  if (!onlyKnownKeys(input, ["operationId", "id", "planRef", "actualContextRefs", "outcome", "actor", "actorKind", "evidenceReferences", "supersedes"])) throw new PlanReconciliationError("unknown-plan-reconciliation-field", "Plan reconciliations accept only documented fields.");
  const outcome = safeText(input.outcome, "outcome", { required: true, maximum: 80 });
  if (!OUTCOMES.has(outcome)) throw new PlanReconciliationError("invalid-reconciliation-outcome", "outcome must be a documented reconciliation outcome.");
  const actorKind = safeId(input.actorKind, "actorKind");
  if (!ACTOR_KINDS.has(actorKind)) throw new PlanReconciliationError("invalid-actor-kind", "actorKind must be human, agent, or tool.");
  const planRef = normalizePlanRef(root, graph, safeText(input.planRef, "planRef", { required: true, maximum: 8_192 }));
  const actualContextRefs = normalizeActualContextRefs(graph, input.actualContextRefs, outcome, actorKind);
  const supersedes = input.supersedes === undefined || input.supersedes === null ? null : safeId(input.supersedes, "supersedes");
  if (supersedes) {
    const prior = store.records.find((record) => record.id === supersedes);
    if (!prior) throw new PlanReconciliationError("unknown-superseded-reconciliation", `supersedes ${supersedes} does not exist.`, 404);
    if (prior.planRef !== planRef) throw new PlanReconciliationError("cross-plan-supersession", "supersedes must reference a reconciliation for the same exact Plan Ref.", 409);
  }
  return {
    id: safeId(input.id, "id"),
    operationId: safeText(input.operationId, "operationId", { required: true, maximum: 240 }),
    projectIdentity: { projectId: graph.project.projectId },
    planRef,
    actualContextRefs,
    outcome,
    actor: safeText(input.actor, "actor", { required: true, maximum: 240 }),
    actorKind,
    evidenceReferences: normalizeEvidenceReferences(input.evidenceReferences),
    supersedes,
  };
}

function validPlanRef(value, projectId) {
  try { return typeof value === "string" && parsePlanRef(value).projectId === projectId; } catch { return false; }
}

function validContextRef(value, projectId) {
  try { return typeof value === "string" && parseContextRef(value).projectId === projectId; } catch { return false; }
}

function validEvidenceReferences(value) {
  return Array.isArray(value) && value.length <= MAX_EVIDENCE_REFERENCES && value.every((item) => onlyKnownKeys(item, ["kind", "reference", "evidenceClass"])
    && validPortableText(item.kind, { required: true, maximum: 80 })
    && validPortableText(item.reference, { required: true, maximum: 800 })
    && validPortableText(item.evidenceClass, { required: true, maximum: 80 }));
}

function validRecord(value, projectId) {
  return onlyKnownKeys(value, ["schemaVersion", "id", "operationId", "inputFingerprint", "projectIdentity", "planRef", "actualContextRefs", "outcome", "actor", "actorKind", "evidenceReferences", "supersedes", "createdAt", "evidenceClass", "knowledgeClass", "policy"])
    && value.schemaVersion === PLAN_RECONCILIATION_SCHEMA
    && validId(value.id)
    && validPortableText(value.operationId, { required: true, maximum: 240 })
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && onlyKnownKeys(value.projectIdentity, ["projectId"]) && value.projectIdentity.projectId === projectId
    && validPlanRef(value.planRef, projectId)
    && Array.isArray(value.actualContextRefs) && value.actualContextRefs.length <= MAX_CONTEXT_REFS && value.actualContextRefs.every((ref) => validContextRef(ref, projectId))
    && OUTCOMES.has(value.outcome)
    && validPortableText(value.actor, { required: true, maximum: 240 })
    && ACTOR_KINDS.has(value.actorKind)
    && validEvidenceReferences(value.evidenceReferences)
    && (value.supersedes === null || validId(value.supersedes))
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && value.evidenceClass === "delivery-reconciliation"
    && ["human-assertion", "agent-proposal", "tool-declaration"].includes(value.knowledgeClass)
    && onlyKnownKeys(value.policy, ["sourceBodies", "rawLogs", "credentials", "machinePaths", "privateReasoning"])
    && Object.values(value.policy).every((item) => item === "excluded");
}

function readPlanReconciliationStore(root, projectId) {
  const target = storePath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const records = Array.isArray(store?.records) ? store.records : [];
    const ids = records.map((record) => record.id);
    const operationIds = records.map((record) => record.operationId);
    const valid = onlyKnownKeys(store, ["schemaVersion", "projectId", "records"])
      && store.schemaVersion === PLAN_RECONCILIATION_STORE_SCHEMA
      && store.projectId === projectId
      && records.length <= MAX_RECONCILIATIONS
      && records.every((record) => validRecord(record, projectId))
      && new Set(ids).size === ids.length
      && new Set(operationIds).size === operationIds.length
      && records.every((record) => record.supersedes === null || records.some((candidate) => candidate.id === record.supersedes && candidate.planRef === record.planRef));
    if (!valid) return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-plan-reconciliation-store", message: "Plan-reconciliation storage does not match flowpeek-plan-reconciliations/v1." }] };
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-plan-reconciliation-json", message: `Plan-reconciliation storage is not valid JSON (${error.message}).` }] };
  }
}

function recordPlanReconciliation(root, graph, input, options = {}) {
  const read = readPlanReconciliationStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new PlanReconciliationError("invalid-plan-reconciliation-store", read.diagnostics[0].message);
  const normalized = normalizeInput(root, graph, input || {}, read.store);
  const inputFingerprint = fingerprint(normalized);
  const existingOperation = read.store.records.find((record) => record.operationId === normalized.operationId);
  if (existingOperation) {
    if (existingOperation.inputFingerprint !== inputFingerprint) throw new PlanReconciliationError("operation-id-conflict", "operationId already belongs to another plan reconciliation.", 409);
    return { schemaVersion: "flowpeek-plan-reconciliation-record-result/v1", created: false, reconciliation: existingOperation };
  }
  if (read.store.records.some((record) => record.id === normalized.id)) throw new PlanReconciliationError("plan-reconciliation-exists", `Plan reconciliation ${normalized.id} already exists.`, 409);
  if (read.store.records.length >= MAX_RECONCILIATIONS) throw new PlanReconciliationError("plan-reconciliation-store-full", `Plan-reconciliation storage reached its explicit ${MAX_RECONCILIATIONS}-record limit.`, 507);
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new PlanReconciliationError("invalid-time", "createdAt must be an ISO-compatible timestamp.");
  const reconciliation = {
    schemaVersion: PLAN_RECONCILIATION_SCHEMA,
    ...normalized,
    inputFingerprint,
    createdAt: new Date(createdAt).toISOString(),
    evidenceClass: "delivery-reconciliation",
    knowledgeClass: normalized.actorKind === "human" ? "human-assertion" : normalized.actorKind === "agent" ? "agent-proposal" : "tool-declaration",
    policy: { sourceBodies: "excluded", rawLogs: "excluded", credentials: "excluded", machinePaths: "excluded", privateReasoning: "excluded" },
  };
  atomicWriteJson(read.path, { ...read.store, records: [...read.store.records, reconciliation] });
  return { schemaVersion: "flowpeek-plan-reconciliation-record-result/v1", created: true, reconciliation };
}

function projectReconciliation(root, graph, record) {
  const planResolution = resolvePlanRef(root, graph, record.planRef);
  const actualContextStatuses = record.actualContextRefs.map((contextRef) => {
    const resolution = resolveTechnicalContext(graph, contextRef);
    return { contextRef, status: resolution.status, resolvedRef: resolution.resolvedRef || null, reason: resolution.reason || null, code: resolution.code || null };
  });
  return {
    ...record,
    planResolution: { status: planResolution.status, resolvedRef: planResolution.resolvedRef || null, reason: planResolution.reason || null, code: planResolution.code || null },
    actualContextStatuses,
    limitation: "This append-only delivery reconciliation records a human, agent, or tool assertion. It does not change parser facts, source nodes, factual edges, Flow Lens, impact, test proof, runtime evidence, or approval authority.",
  };
}

function listPlanReconciliations(root, graph, options = {}) {
  const read = readPlanReconciliationStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-plan-reconciliation-list/v1", status: "unavailable", project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion }, records: [], diagnostics: read.diagnostics };
  const planRef = options.planRef === undefined || options.planRef === null ? null : safeText(options.planRef, "planRef", { required: true, maximum: 8_192 });
  const records = read.store.records
    .filter((record) => !planRef || record.planRef === planRef)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .map((record) => projectReconciliation(root, graph, record));
  return {
    schemaVersion: "flowpeek-plan-reconciliation-list/v1",
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    storage: { relativePath: PLAN_RECONCILIATION_STORE_RELATIVE_PATH, status: read.status },
    records,
    diagnostics: [],
    limitation: "Reconciliations are append-only delivery metadata. A positive record requires current actual Context Refs and human authorship, but remains an assertion rather than parser, test, runtime, or approval proof.",
  };
}

function getPlanReconciliation(root, graph, reconciliationId) {
  const listed = listPlanReconciliations(root, graph);
  if (listed.status !== "available") return { schemaVersion: "flowpeek-plan-reconciliation-get/v1", status: "unavailable", reconciliation: null, diagnostics: listed.diagnostics };
  const id = safeId(reconciliationId, "reconciliationId");
  const reconciliation = listed.records.find((record) => record.id === id);
  if (!reconciliation) throw new PlanReconciliationError("unknown-plan-reconciliation", `Plan reconciliation ${id} does not exist.`, 404);
  return { schemaVersion: "flowpeek-plan-reconciliation-get/v1", status: "available", reconciliation, diagnostics: [], limitation: listed.limitation };
}

module.exports = {
  PLAN_RECONCILIATION_SCHEMA,
  PLAN_RECONCILIATION_STORE_SCHEMA,
  PLAN_RECONCILIATION_STORE_RELATIVE_PATH,
  PlanReconciliationError,
  getPlanReconciliation,
  listPlanReconciliations,
  readPlanReconciliationStore,
  recordPlanReconciliation,
};
