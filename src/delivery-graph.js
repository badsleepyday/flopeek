"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { parseContextRef } = require("./context-card");

const DELIVERY_STORE_SCHEMA = "flowpeek-delivery-work-records/v1";
const WORK_RECORD_SCHEMA = "flowpeek-work-record/v1";
const WORK_EVENT_SCHEMA = "flowpeek-work-event/v1";
const DELIVERY_STORE_RELATIVE_PATH = ".flowpeek/delivery/work-records.json";
const WORK_KINDS = new Set(["objective", "requirement", "decision", "task", "checkpoint", "approval", "test-result", "review", "release", "observation", "incident"]);
const EVENT_TYPES = new Set(["record-created", "plan-updated", "evidence-recorded", "workflow-assigned", "workflow-transition", "approval-recorded", "release-recorded", "observation-recorded", "note-recorded"]);
const MAX_RECORDS = 10_000;
const MAX_EVENTS = 20_000;

class DeliveryGraphError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
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
  const { required = true, maximum = 800 } = options;
  if (value === undefined || value === null) {
    if (required) throw new DeliveryGraphError("missing-field", `${name} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new DeliveryGraphError("invalid-field", `${name} must be a string.`);
  if (value.includes(String.fromCharCode(0)) || /[\r\n]/u.test(value)) throw new DeliveryGraphError("unsafe-delivery-text", `${name} must be concise single-line metadata.`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (required && !normalized) throw new DeliveryGraphError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new DeliveryGraphError("field-too-long", `${name} must be at most ${maximum} characters.`);
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S{12,}|\b(?:password|api[_-]?key|token|secret)\s*[:=]\s*\S+)/iu.test(normalized)) throw new DeliveryGraphError("unsafe-delivery-text", `${name} contains credential-like data.`);
  if (/(?:\b[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/|\/(?:Users|home|mnt\/[A-Za-z])\/)/iu.test(normalized)) throw new DeliveryGraphError("unsafe-delivery-text", `${name} contains a machine-specific path.`);
  return normalized || null;
}

function safeId(value, name) {
  const normalized = safeText(value, name, { maximum: 120 });
  if (!/^[a-z][a-z0-9._:-]*$/u.test(normalized)) throw new DeliveryGraphError("invalid-id", `${name} must start with a lowercase letter and contain only lowercase letters, digits, dots, underscores, colons, or hyphens.`);
  return normalized;
}

function isoTime(value, name, { required = true } = {}) {
  const normalized = safeText(value, name, { required, maximum: 80 });
  if (normalized === null) return null;
  if (Number.isNaN(Date.parse(normalized))) throw new DeliveryGraphError("invalid-time", `${name} must be an ISO-compatible timestamp.`);
  return new Date(normalized).toISOString();
}

function normalizeContextRefs(projectId, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new DeliveryGraphError("invalid-context-refs", "contextRefs must contain at most 100 Context Ref strings.");
  const refs = value.map((contextRef) => {
    let parsed;
    try { parsed = parseContextRef(contextRef); } catch (error) { throw new DeliveryGraphError("invalid-context-ref", error.message); }
    if (parsed.projectId !== projectId) throw new DeliveryGraphError("wrong-project-id", "A work record may reference only Context Refs from its current Flowpeek project.");
    return { contextRef: parsed.contextRef, kind: parsed.kind, contextId: parsed.contextId, graphVersion: parsed.graphVersion };
  });
  const distinct = new Map(refs.map((item) => [item.contextRef, item]));
  return [...distinct.values()].sort((left, right) => left.contextRef.localeCompare(right.contextRef));
}

function normalizeDependencies(value, recordId = null) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new DeliveryGraphError("invalid-dependencies", "dependencies must contain at most 200 work-record IDs.");
  const ids = [...new Set(value.map((item) => safeId(item, "dependency")))].sort();
  if (recordId && ids.includes(recordId)) throw new DeliveryGraphError("self-dependency", "A work record cannot depend on itself.");
  return ids;
}

function dependencyCycle(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  function visit(id) {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visited.add(id);
    const record = byId.get(id);
    if (!record) return null;
    visiting.add(id);
    path.push(id);
    for (const dependency of record.dependencies) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    return null;
  }
  for (const record of records) {
    const cycle = visit(record.id);
    if (cycle) return cycle;
  }
  return null;
}

function assertAcyclicDependencies(records) {
  const cycle = dependencyCycle(records);
  if (cycle) throw new DeliveryGraphError("circular-dependency", `Work dependencies must not form a cycle: ${cycle.join(" -> ")}.`, 409);
}

function normalizePlan(input) {
  const plannedStart = isoTime(input.plannedStart, "plannedStart", { required: false });
  const plannedEnd = isoTime(input.plannedEnd, "plannedEnd", { required: false });
  if (plannedStart && plannedEnd && plannedEnd < plannedStart) throw new DeliveryGraphError("invalid-plan-window", "plannedEnd must be after plannedStart.");
  return { plannedStart, plannedEnd };
}

function emptyStore(projectId) {
  return { schemaVersion: DELIVERY_STORE_SCHEMA, projectId, records: [], events: [] };
}

function storePath(root) {
  return path.join(root, DELIVERY_STORE_RELATIVE_PATH);
}

function validContextRef(value, projectId) {
  return onlyKnownKeys(value, ["contextRef", "kind", "contextId", "graphVersion"])
    && typeof value.contextRef === "string"
    && typeof value.kind === "string"
    && typeof value.contextId === "string"
    && Number.isSafeInteger(value.graphVersion)
    && (() => { try { return parseContextRef(value.contextRef).projectId === projectId; } catch { return false; } })();
}

function validRecord(value, projectId) {
  return onlyKnownKeys(value, ["schemaVersion", "id", "kind", "title", "owner", "dependencies", "contextRefs", "plan", "planRevision", "createdBy", "createdAt", "updatedAt"])
    && value.schemaVersion === WORK_RECORD_SCHEMA
    && typeof value.id === "string" && /^[a-z][a-z0-9._:-]*$/u.test(value.id)
    && WORK_KINDS.has(value.kind)
    && typeof value.title === "string" && value.title
    && (value.owner === null || typeof value.owner === "string")
    && Array.isArray(value.dependencies) && value.dependencies.every((item) => typeof item === "string")
    && Array.isArray(value.contextRefs) && value.contextRefs.every((item) => validContextRef(item, projectId))
    && onlyKnownKeys(value.plan, ["plannedStart", "plannedEnd"])
    && (value.plan.plannedStart === null || typeof value.plan.plannedStart === "string")
    && (value.plan.plannedEnd === null || typeof value.plan.plannedEnd === "string")
    && Number.isSafeInteger(value.planRevision) && value.planRevision >= 1
    && typeof value.createdBy === "string" && value.createdBy
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));
}

function validEvidence(value) {
  return onlyKnownKeys(value, ["kind", "reference", "evidenceClass"])
    && typeof value.kind === "string" && value.kind
    && typeof value.reference === "string" && value.reference
    && typeof value.evidenceClass === "string" && value.evidenceClass;
}

function validWorkflowEvent(value) {
  return value === null || (onlyKnownKeys(value, ["workflowId", "fromState", "toState"])
    && typeof value.workflowId === "string" && value.workflowId
    && (value.fromState === null || typeof value.fromState === "string")
    && typeof value.toState === "string" && value.toState);
}

function validEvent(value, projectId, recordIds) {
  return onlyKnownKeys(value, ["schemaVersion", "id", "operationId", "inputFingerprint", "recordId", "eventType", "summary", "actor", "observedAt", "evidence", "workflow", "policy"])
    && value.schemaVersion === WORK_EVENT_SCHEMA
    && typeof value.id === "string" && value.id
    && typeof value.operationId === "string" && value.operationId
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && recordIds.has(value.recordId)
    && EVENT_TYPES.has(value.eventType)
    && typeof value.summary === "string" && value.summary
    && typeof value.actor === "string" && value.actor
    && typeof value.observedAt === "string" && !Number.isNaN(Date.parse(value.observedAt))
    && Array.isArray(value.evidence) && value.evidence.every(validEvidence)
    && (value.workflow === undefined || validWorkflowEvent(value.workflow))
    && onlyKnownKeys(value.policy, ["sourceBodies", "rawLogs", "credentials", "privateReasoning"])
    && value.policy.sourceBodies === "excluded" && value.policy.rawLogs === "excluded" && value.policy.credentials === "excluded" && value.policy.privateReasoning === "excluded";
}

function readDeliveryStore(root, projectId) {
  const target = storePath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const recordIds = new Set(Array.isArray(store?.records) ? store.records.map((record) => record.id) : []);
    const operationIds = Array.isArray(store?.events) ? store.events.map((event) => event.operationId) : [];
    const valid = onlyKnownKeys(store, ["schemaVersion", "projectId", "records", "events"])
      && store.schemaVersion === DELIVERY_STORE_SCHEMA
      && store.projectId === projectId
      && Array.isArray(store.records) && store.records.length <= MAX_RECORDS && store.records.every((record) => validRecord(record, projectId))
      && recordIds.size === store.records.length
      && Array.isArray(store.events) && store.events.length <= MAX_EVENTS && store.events.every((event) => validEvent(event, projectId, recordIds))
      && new Set(operationIds).size === operationIds.length;
    if (!valid) return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-delivery-store", message: "Delivery work-record storage does not match flowpeek-delivery-work-records/v1." }] };
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-delivery-json", message: `Delivery work-record storage is not valid JSON (${error.message}).` }] };
  }
}

function appendEvent(store, input) {
  const normalized = {
    operationId: safeText(input.operationId, "operationId", { maximum: 240 }),
    recordId: safeId(input.recordId, "recordId"),
    eventType: safeText(input.eventType, "eventType", { maximum: 80 }),
    summary: safeText(input.summary, "summary", { maximum: 1200 }),
    actor: safeText(input.actor, "actor", { maximum: 240 }),
    observedAt: isoTime(input.observedAt, "observedAt"),
    evidence: (input.evidence || []).map((item) => ({ kind: safeText(item?.kind, "evidence.kind", { maximum: 80 }), reference: safeText(item?.reference, "evidence.reference", { maximum: 800 }), evidenceClass: safeText(item?.evidenceClass, "evidence.evidenceClass", { maximum: 80 }) })),
    workflow: input.workflow === undefined || input.workflow === null ? null : {
      workflowId: safeId(input.workflow.workflowId, "workflow.workflowId"),
      fromState: safeText(input.workflow.fromState, "workflow.fromState", { required: false, maximum: 80 }),
      toState: safeId(input.workflow.toState, "workflow.toState"),
    },
  };
  if (!EVENT_TYPES.has(normalized.eventType)) throw new DeliveryGraphError("invalid-event-type", `eventType must be one of: ${[...EVENT_TYPES].join(", ")}.`);
  if (["workflow-assigned", "workflow-transition"].includes(normalized.eventType) !== Boolean(normalized.workflow)) throw new DeliveryGraphError("invalid-workflow-event", "Workflow events require workflow metadata; non-workflow events must not include it.");
  if (!store.records.some((record) => record.id === normalized.recordId)) throw new DeliveryGraphError("unknown-work-record", "recordId does not exist.", 404);
  if (normalized.evidence.length > 100) throw new DeliveryGraphError("too-many-evidence-items", "An event may contain at most 100 evidence references.");
  const inputFingerprint = fingerprint(normalized);
  const existing = store.events.find((event) => event.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new DeliveryGraphError("operation-id-conflict", "operationId already belongs to another delivery event.", 409);
    return { created: false, event: existing, store };
  }
  if (store.events.length >= MAX_EVENTS) throw new DeliveryGraphError("delivery-event-store-full", `Delivery event storage reached its explicit ${MAX_EVENTS}-event limit.`, 507);
  const base = { schemaVersion: WORK_EVENT_SCHEMA, ...normalized, inputFingerprint, policy: { sourceBodies: "excluded", rawLogs: "excluded", credentials: "excluded", privateReasoning: "excluded" } };
  const event = { ...base, id: `work-event:${fingerprint(base).slice(7, 39)}` };
  return { created: true, event, store: { ...store, events: [...store.events, event] } };
}

function createWorkRecord(root, graph, input) {
  if (!onlyKnownKeys(input, ["operationId", "id", "kind", "title", "owner", "dependencies", "contextRefs", "plannedStart", "plannedEnd", "createdBy", "createdAt"])) throw new DeliveryGraphError("unknown-work-record-field", "Work records accept only documented fields.");
  const read = readDeliveryStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new DeliveryGraphError("invalid-delivery-store", read.diagnostics[0].message);
  const id = safeId(input.id, "id");
  const existing = read.store.records.find((record) => record.id === id);
  const now = isoTime(input.createdAt, "createdAt");
  const record = {
    schemaVersion: WORK_RECORD_SCHEMA,
    id,
    kind: safeText(input.kind, "kind", { maximum: 80 }),
    title: safeText(input.title, "title", { maximum: 240 }),
    owner: safeText(input.owner, "owner", { required: false, maximum: 240 }),
    dependencies: normalizeDependencies(input.dependencies, id),
    contextRefs: normalizeContextRefs(graph.project.projectId, input.contextRefs),
    plan: normalizePlan(input),
    planRevision: 1,
    createdBy: safeText(input.createdBy, "createdBy", { maximum: 240 }),
    createdAt: now,
    updatedAt: now,
  };
  if (!WORK_KINDS.has(record.kind)) throw new DeliveryGraphError("invalid-work-kind", `kind must be one of: ${[...WORK_KINDS].join(", ")}.`);
  const eventInput = {
    operationId: input.operationId,
    recordId: id,
    eventType: "record-created",
    summary: `Created ${record.kind} work record: ${record.title}`,
    actor: record.createdBy,
    observedAt: now,
    evidence: record.contextRefs.map((item) => ({ kind: "context-ref", reference: item.contextRef, evidenceClass: "static-context" })),
  };
  if (existing) {
    const replay = appendEvent(read.store, eventInput);
    if (fingerprint(existing) !== fingerprint(record)) throw new DeliveryGraphError("work-record-exists", `Work record ${id} already exists with different content.`, 409);
    return { schemaVersion: "flowpeek-work-record-create-result/v1", created: false, record: existing, event: replay.event };
  }
  if (read.store.records.length >= MAX_RECORDS) throw new DeliveryGraphError("delivery-record-store-full", `Delivery work-record storage reached its explicit ${MAX_RECORDS}-record limit.`, 507);
  assertAcyclicDependencies([...read.store.records, record]);
  const store = { ...read.store, records: [...read.store.records, record] };
  const result = appendEvent(store, eventInput);
  atomicWriteJson(read.path, result.store);
  return { schemaVersion: "flowpeek-work-record-create-result/v1", created: true, record, event: result.event };
}

function updateWorkPlan(root, graph, input) {
  if (!onlyKnownKeys(input, ["operationId", "recordId", "title", "owner", "dependencies", "contextRefs", "plannedStart", "plannedEnd", "actor", "observedAt"])) throw new DeliveryGraphError("unknown-work-plan-field", "Work-plan updates accept only documented fields.");
  const read = readDeliveryStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new DeliveryGraphError("invalid-delivery-store", read.diagnostics[0].message);
  const recordId = safeId(input.recordId, "recordId");
  const index = read.store.records.findIndex((record) => record.id === recordId);
  if (index < 0) throw new DeliveryGraphError("unknown-work-record", "recordId does not exist.", 404);
  const prior = read.store.records[index];
  const operationId = safeText(input.operationId, "operationId", { maximum: 240 });
  const replay = read.store.events.find((event) => event.operationId === operationId);
  if (replay) {
    if (replay.recordId !== recordId || replay.eventType !== "plan-updated") throw new DeliveryGraphError("operation-id-conflict", "operationId already belongs to another delivery event.", 409);
    return { schemaVersion: "flowpeek-work-plan-update-result/v1", updated: false, record: prior, event: replay };
  }
  const observedAt = isoTime(input.observedAt, "observedAt");
  const next = {
    ...prior,
    title: input.title === undefined ? prior.title : safeText(input.title, "title", { maximum: 240 }),
    owner: input.owner === undefined ? prior.owner : safeText(input.owner, "owner", { required: false, maximum: 240 }),
    dependencies: input.dependencies === undefined ? prior.dependencies : normalizeDependencies(input.dependencies, recordId),
    contextRefs: input.contextRefs === undefined ? prior.contextRefs : normalizeContextRefs(graph.project.projectId, input.contextRefs),
    plan: input.plannedStart === undefined && input.plannedEnd === undefined ? prior.plan : normalizePlan({ plannedStart: input.plannedStart === undefined ? prior.plan.plannedStart : input.plannedStart, plannedEnd: input.plannedEnd === undefined ? prior.plan.plannedEnd : input.plannedEnd }),
    planRevision: prior.planRevision + 1,
    updatedAt: observedAt,
  };
  const records = [...read.store.records];
  records[index] = next;
  assertAcyclicDependencies(records);
  const result = appendEvent({ ...read.store, records }, {
    operationId,
    recordId,
    eventType: "plan-updated",
    summary: `Updated plan revision ${next.planRevision} for ${next.title}`,
    actor: safeText(input.actor, "actor", { maximum: 240 }),
    observedAt,
    evidence: next.contextRefs.map((item) => ({ kind: "context-ref", reference: item.contextRef, evidenceClass: "static-context" })),
  });
  atomicWriteJson(read.path, result.store);
  return { schemaVersion: "flowpeek-work-plan-update-result/v1", updated: true, record: next, event: result.event };
}

function recordWorkEvent(root, graph, input) {
  if (!onlyKnownKeys(input, ["operationId", "recordId", "eventType", "summary", "actor", "observedAt", "evidence", "workflow"])) throw new DeliveryGraphError("unknown-work-event-field", "Work events accept only documented fields.");
  const read = readDeliveryStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new DeliveryGraphError("invalid-delivery-store", read.diagnostics[0].message);
  const result = appendEvent(read.store, input);
  if (result.created) atomicWriteJson(read.path, result.store);
  return { schemaVersion: "flowpeek-work-event-result/v1", created: result.created, event: result.event };
}

function workRecordView(graph, record) {
  const contextRefs = record.contextRefs.map((context) => ({ ...context, status: context.graphVersion === graph.state.graphVersion ? "current" : context.graphVersion < graph.state.graphVersion ? "stale" : "future" }));
  return { ...record, contextRefs, staleContextCount: contextRefs.filter((context) => context.status !== "current").length };
}

function listWorkRecords(root, graph, options = {}) {
  const read = readDeliveryStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-work-record-list/v1", status: "unavailable", records: [], events: [], diagnostics: read.diagnostics };
  const limit = Number.isSafeInteger(Number(options.limit)) ? Math.max(1, Math.min(Number(options.limit), 200)) : 50;
  const records = [...read.store.records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return {
    schemaVersion: "flowpeek-work-record-list/v1",
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    storage: { relativePath: DELIVERY_STORE_RELATIVE_PATH, status: read.status },
    totalMatched: records.length,
    returned: Math.min(records.length, limit),
    truncated: records.length > limit,
    records: records.slice(0, limit).map((record) => workRecordView(graph, record)),
    events: read.store.events.slice(-limit).reverse(),
    diagnostics: [],
    limitation: "Work plans and actual delivery events are locally recorded metadata. Context Ref freshness is compared only to the current local graph version; it does not alter parser facts, prove runtime behavior, or establish technical completion without referenced evidence.",
  };
}

function getWorkTimeline(root, graph, recordId = null) {
  const listed = listWorkRecords(root, graph, { limit: 200 });
  if (listed.status !== "available") return { schemaVersion: "flowpeek-work-timeline/v1", status: "unavailable", records: [], actualEvents: [], diagnostics: listed.diagnostics };
  const id = recordId === null ? null : safeId(recordId, "recordId");
  const records = id ? listed.records.filter((record) => record.id === id) : listed.records;
  if (id && !records.length) throw new DeliveryGraphError("unknown-work-record", "recordId does not exist.", 404);
  const ids = new Set(records.map((record) => record.id));
  const read = readDeliveryStore(root, graph.project.projectId);
  const actualEvents = read.store.events.filter((event) => ids.has(event.recordId)).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  return {
    schemaVersion: "flowpeek-work-timeline/v1",
    status: "available",
    project: listed.project,
    records: records.map((record) => {
      const view = workRecordView(graph, record);
      return { id: view.id, kind: view.kind, title: view.title, plan: view.plan, planRevision: view.planRevision, owner: view.owner, dependencies: view.dependencies, contextRefs: view.contextRefs, staleContextCount: view.staleContextCount };
    }),
    actualEvents,
    limitation: "Planned dates are editable delivery metadata. Actual events are append-only recorded observations and do not prove source execution, runtime order, or workflow approval by themselves.",
  };
}

module.exports = {
  DELIVERY_STORE_RELATIVE_PATH,
  DELIVERY_STORE_SCHEMA,
  EVENT_TYPES,
  MAX_EVENTS,
  MAX_RECORDS,
  WORK_EVENT_SCHEMA,
  WORK_KINDS,
  WORK_RECORD_SCHEMA,
  DeliveryGraphError,
  createWorkRecord,
  dependencyCycle,
  getWorkTimeline,
  listWorkRecords,
  readDeliveryStore,
  recordWorkEvent,
  updateWorkPlan,
};
