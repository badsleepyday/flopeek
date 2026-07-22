"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { DeliveryGraphError, recordWorkEvent, readDeliveryStore } = require("./delivery-graph");

const WORKFLOW_SCHEMA = "flowpeek-workflow/v1";
const WORKFLOW_STORE_SCHEMA = "flowpeek-workflows/v1";
const WORKFLOW_STORE_RELATIVE_PATH = ".flowpeek/delivery/workflows.json";
const MAX_WORKFLOWS = 100;
const BUILTIN_DEPENDENCY_READY_STATES = Object.freeze({
  "agile-default": new Set(["released", "observing"]),
  "waterfall-default": new Set(["release", "observing"]),
});
const BUILTIN_IMPLEMENTATION_ENTRY_STATES = Object.freeze({
  "agile-default": "implementing",
  "waterfall-default": "implementation",
});

const BUILTIN_WORKFLOWS = Object.freeze([
  {
    schemaVersion: WORKFLOW_SCHEMA,
    id: "agile-default",
    title: "Agile",
    initialState: "backlog",
    states: ["backlog", "planned", "implementing", "verifying", "reviewing", "released", "observing"],
    transitions: [
      { from: "backlog", to: "planned", requiredEvidence: [], roles: [] },
      { from: "planned", to: "implementing", requiredEvidence: ["current-context"], roles: [] },
      { from: "implementing", to: "verifying", requiredEvidence: ["current-context", "implementation-graph", "change-impact"], roles: [] },
      { from: "verifying", to: "reviewing", requiredEvidence: ["test-result", "current-context"], roles: [] },
      { from: "reviewing", to: "released", requiredEvidence: ["human-approval", "release-evidence"], roles: [] },
      { from: "released", to: "observing", requiredEvidence: ["release-evidence"], roles: [] },
    ],
  },
  {
    schemaVersion: WORKFLOW_SCHEMA,
    id: "waterfall-default",
    title: "Waterfall",
    initialState: "requirements",
    states: ["requirements", "design", "implementation", "verification", "release", "observing"],
    transitions: [
      { from: "requirements", to: "design", requiredEvidence: ["current-context"], roles: [] },
      { from: "design", to: "implementation", requiredEvidence: ["decision"], roles: [] },
      { from: "implementation", to: "verification", requiredEvidence: ["current-context", "implementation-graph", "change-impact"], roles: [] },
      { from: "verification", to: "release", requiredEvidence: ["test-result", "human-approval", "release-evidence"], roles: [] },
      { from: "release", to: "observing", requiredEvidence: ["release-evidence"], roles: [] },
    ],
  },
]);

class WorkflowEngineError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function onlyKnownKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function safeId(value, name) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]*$/u.test(value)) throw new WorkflowEngineError("invalid-id", `${name} must start with a lowercase letter and contain only lowercase letters, digits, dots, underscores, colons, or hyphens.`);
  return value;
}

function safeText(value, name, maximum = 240) {
  if (typeof value !== "string" || !value.trim()) throw new WorkflowEngineError("missing-field", `${name} is required.`);
  if (value.includes(String.fromCharCode(0)) || /[\r\n]/u.test(value) || value.trim().length > maximum) throw new WorkflowEngineError("invalid-field", `${name} must be concise single-line metadata.`);
  return value.trim().replace(/\s+/gu, " ");
}

function workflowPath(root) {
  return path.join(root, WORKFLOW_STORE_RELATIVE_PATH);
}

function validTransition(value, states) {
  return onlyKnownKeys(value, ["from", "to", "requiredEvidence", "roles"])
    && typeof value.from === "string" && states.includes(value.from)
    && typeof value.to === "string" && states.includes(value.to)
    && value.from !== value.to
    && Array.isArray(value.requiredEvidence) && value.requiredEvidence.every((item) => typeof item === "string" && /^[a-z][a-z0-9-]*$/u.test(item))
    && new Set(value.requiredEvidence).size === value.requiredEvidence.length
    && Array.isArray(value.roles) && value.roles.every((item) => typeof item === "string" && item.trim());
}

function validWorkflow(value) {
  return onlyKnownKeys(value, ["schemaVersion", "id", "title", "initialState", "states", "transitions"])
    && value.schemaVersion === WORKFLOW_SCHEMA
    && typeof value.id === "string" && /^[a-z][a-z0-9._:-]*$/u.test(value.id)
    && typeof value.title === "string" && value.title
    && typeof value.initialState === "string"
    && Array.isArray(value.states) && value.states.length >= 2 && value.states.length <= 30 && value.states.every((state) => typeof state === "string" && /^[a-z][a-z0-9-]*$/u.test(state))
    && new Set(value.states).size === value.states.length
    && value.states.includes(value.initialState)
    && Array.isArray(value.transitions) && value.transitions.length && value.transitions.every((transition) => validTransition(transition, value.states));
}

function normalizeWorkflow(input) {
  if (!onlyKnownKeys(input, ["id", "title", "initialState", "states", "transitions"])) throw new WorkflowEngineError("unknown-workflow-field", "Workflow definitions accept only documented fields.");
  const workflow = {
    schemaVersion: WORKFLOW_SCHEMA,
    id: safeId(input.id, "id"),
    title: safeText(input.title, "title"),
    initialState: safeId(input.initialState, "initialState"),
    states: [...new Set((input.states || []).map((state) => safeId(state, "state")))],
    transitions: (input.transitions || []).map((transition) => ({
      from: safeId(transition?.from, "transition.from"),
      to: safeId(transition?.to, "transition.to"),
      requiredEvidence: [...new Set((transition?.requiredEvidence || []).map((item) => safeId(item, "transition.requiredEvidence")))],
      roles: [...new Set((transition?.roles || []).map((item) => safeText(item, "transition.roles", 120)))],
    })),
  };
  if (!validWorkflow(workflow)) throw new WorkflowEngineError("invalid-workflow", "Workflow definitions require unique states, a valid initial state, and valid transitions.");
  return workflow;
}

function readWorkflowStore(root) {
  const target = workflowPath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: { schemaVersion: WORKFLOW_STORE_SCHEMA, workflows: [] }, diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const valid = onlyKnownKeys(store, ["schemaVersion", "workflows"])
      && store.schemaVersion === WORKFLOW_STORE_SCHEMA
      && Array.isArray(store.workflows) && store.workflows.length <= MAX_WORKFLOWS
      && store.workflows.every(validWorkflow)
      && new Set(store.workflows.map((workflow) => workflow.id)).size === store.workflows.length;
    if (!valid) return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-workflow-store", message: "Workflow storage does not match flowpeek-workflows/v1." }] };
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-workflow-json", message: `Workflow storage is not valid JSON (${error.message}).` }] };
  }
}

function listWorkflows(root) {
  const read = readWorkflowStore(root);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-workflow-list/v1", status: "unavailable", workflows: [], diagnostics: read.diagnostics };
  return {
    schemaVersion: "flowpeek-workflow-list/v1",
    status: "available",
    workflows: [...BUILTIN_WORKFLOWS, ...read.store.workflows].map((workflow) => ({ ...workflow, source: BUILTIN_WORKFLOWS.some((item) => item.id === workflow.id) ? "builtin" : "local-custom" })),
    diagnostics: [],
    limitation: "Workflow templates define allowed local metadata transitions. They do not execute work, prove a code change, or replace external approval systems.",
  };
}

function getWorkflow(root, id) {
  const workflowId = safeId(id, "workflowId");
  const listed = listWorkflows(root);
  if (listed.status !== "available") throw new WorkflowEngineError("invalid-workflow-store", listed.diagnostics[0].message);
  const workflow = listed.workflows.find((item) => item.id === workflowId);
  if (!workflow) throw new WorkflowEngineError("unknown-workflow", `Workflow ${workflowId} does not exist.`, 404);
  return workflow;
}

function saveWorkflow(root, input) {
  const read = readWorkflowStore(root);
  if (read.status === "invalid") throw new WorkflowEngineError("invalid-workflow-store", read.diagnostics[0].message);
  const workflow = normalizeWorkflow(input || {});
  if (BUILTIN_WORKFLOWS.some((item) => item.id === workflow.id)) throw new WorkflowEngineError("builtin-workflow-immutable", "Built-in workflows cannot be replaced by local custom definitions.", 409);
  const index = read.store.workflows.findIndex((item) => item.id === workflow.id);
  if (index < 0 && read.store.workflows.length >= MAX_WORKFLOWS) throw new WorkflowEngineError("workflow-store-full", `Workflow storage reached its explicit ${MAX_WORKFLOWS}-workflow limit.`, 507);
  const workflows = [...read.store.workflows];
  if (index < 0) workflows.push(workflow); else workflows[index] = workflow;
  atomicWriteJson(read.path, { ...read.store, workflows: workflows.sort((left, right) => left.id.localeCompare(right.id)) });
  return { schemaVersion: "flowpeek-workflow-save-result/v1", workflow, created: index < 0 };
}

function recordState(store, recordId) {
  const events = store.events.filter((event) => event.recordId === recordId && event.workflow).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  const latest = events.at(-1) || null;
  return latest ? { workflowId: latest.workflow.workflowId, state: latest.workflow.toState, event: latest } : null;
}

function dependencyContextSummary(record, graph) {
  const total = record.contextRefs.length;
  const stale = record.contextRefs.filter((context) => context.graphVersion !== graph.state.graphVersion).length;
  return { total, current: total - stale, stale };
}

function dependencyReadiness(workflowsById, store, graph, dependency) {
  const current = recordState(store, dependency.id);
  if (!current) return {
    id: dependency.id,
    kind: dependency.kind,
    title: dependency.title,
    status: "unknown",
    reason: "No workflow state is recorded for this dependency.",
    workflow: null,
    context: dependencyContextSummary(dependency, graph),
  };
  const workflow = workflowsById.get(current.workflowId);
  if (!workflow) return {
    id: dependency.id,
    kind: dependency.kind,
    title: dependency.title,
    status: "unknown",
    reason: "The dependency references a workflow that is unavailable locally.",
    workflow: { workflowId: current.workflowId, state: current.state, source: null },
    context: dependencyContextSummary(dependency, graph),
  };
  const readyStates = BUILTIN_DEPENDENCY_READY_STATES[workflow.id];
  const terminal = !workflow.transitions.some((transition) => transition.from === current.state);
  const ready = readyStates ? readyStates.has(current.state) : terminal;
  return {
    id: dependency.id,
    kind: dependency.kind,
    title: dependency.title,
    status: ready ? "ready" : readyStates ? "blocking" : "unknown",
    reason: ready
      ? readyStates
        ? "The dependency reached a built-in delivery-ready workflow state."
        : "The dependency reached a terminal custom workflow state."
      : readyStates
        ? "The dependency has not reached a built-in delivery-ready workflow state."
        : "A non-terminal custom workflow state has no automatic readiness interpretation.",
    workflow: { workflowId: workflow.id, title: workflow.title, state: current.state, source: workflow.source },
    context: dependencyContextSummary(dependency, graph),
  };
}

function dependencyStatusProjection(delivery, listed, graph, record) {
  const recordsById = new Map(delivery.store.records.map((item) => [item.id, item]));
  const workflowsById = new Map(listed.workflows.map((workflow) => [workflow.id, workflow]));
  const dependencies = record.dependencies.map((dependencyId) => {
    const dependency = recordsById.get(dependencyId);
    if (!dependency) return { id: dependencyId, kind: null, title: null, status: "unresolved", reason: "The declared dependency has no local work record.", workflow: null, context: { total: 0, current: 0, stale: 0 } };
    return dependencyReadiness(workflowsById, delivery.store, graph, dependency);
  });
  const summary = {
    total: dependencies.length,
    ready: dependencies.filter((item) => item.status === "ready").length,
    blocking: dependencies.filter((item) => item.status === "blocking").length,
    unresolved: dependencies.filter((item) => item.status === "unresolved").length,
    unknown: dependencies.filter((item) => item.status === "unknown").length,
    readyToStart: dependencies.every((item) => item.status === "ready"),
  };
  return {
    schemaVersion: "flowpeek-work-dependency-status/v1",
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    record: { id: record.id, kind: record.kind, title: record.title, dependencies: [...record.dependencies] },
    dependencies,
    summary,
    diagnostics: [],
    limitation: "Dependency readiness is derived only from declared local work-record dependencies and local workflow metadata. A ready state does not prove source implementation, tests, approval, release, runtime behavior, or external system state.",
  };
}

function getWorkDependencyStatus(root, graph, recordId) {
  const delivery = readDeliveryStore(root, graph.project.projectId);
  if (delivery.status === "invalid") return { schemaVersion: "flowpeek-work-dependency-status/v1", status: "unavailable", record: null, dependencies: [], summary: null, diagnostics: delivery.diagnostics, limitation: "Dependency readiness is unavailable because local delivery metadata is invalid." };
  const id = safeId(recordId, "recordId");
  const record = delivery.store.records.find((item) => item.id === id);
  if (!record) throw new WorkflowEngineError("unknown-work-record", "recordId does not exist.", 404);
  const listed = listWorkflows(root);
  if (listed.status !== "available") return { schemaVersion: "flowpeek-work-dependency-status/v1", status: "unavailable", record: { id: record.id, kind: record.kind, title: record.title }, dependencies: [], summary: null, diagnostics: listed.diagnostics, limitation: "Dependency readiness is unavailable because local workflow metadata is invalid." };
  return dependencyStatusProjection(delivery, listed, graph, record);
}

function listWorkDependencyStatuses(root, graph, options = {}) {
  const delivery = readDeliveryStore(root, graph.project.projectId);
  if (delivery.status === "invalid") return { schemaVersion: "flowpeek-work-dependency-status-list/v1", status: "unavailable", project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion }, statuses: [], diagnostics: delivery.diagnostics, limitation: "Dependency readiness is unavailable because local delivery metadata is invalid." };
  const listed = listWorkflows(root);
  if (listed.status !== "available") return { schemaVersion: "flowpeek-work-dependency-status-list/v1", status: "unavailable", project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion }, statuses: [], diagnostics: listed.diagnostics, limitation: "Dependency readiness is unavailable because local workflow metadata is invalid." };
  const limit = Number.isSafeInteger(Number(options.limit)) ? Math.max(1, Math.min(Number(options.limit), 200)) : 50;
  const records = [...delivery.store.records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return {
    schemaVersion: "flowpeek-work-dependency-status-list/v1",
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    totalMatched: records.length,
    returned: Math.min(records.length, limit),
    truncated: records.length > limit,
    statuses: records.slice(0, limit).map((record) => dependencyStatusProjection(delivery, listed, graph, record)),
    diagnostics: [],
    limitation: "Dependency readiness is a bounded local delivery-metadata projection. It does not prove source implementation, tests, approval, release, runtime behavior, or external system state.",
  };
}

function evidenceKinds(store, record, graph, suppliedEvidence) {
  const kinds = new Set();
  if (record.contextRefs.some((context) => context.graphVersion === graph.state.graphVersion)) kinds.add("current-context");
  for (const event of store.events.filter((item) => item.recordId === record.id)) for (const evidence of event.evidence) kinds.add(evidence.kind);
  for (const evidence of suppliedEvidence || []) kinds.add(evidence.kind);
  return kinds;
}

function validateTransition(workflow, current, targetState, actorRole, evidence) {
  if (current.workflowId !== workflow.id) throw new WorkflowEngineError("workflow-mismatch", "Work record is assigned to a different workflow.", 409);
  const transition = workflow.transitions.find((item) => item.from === current.state && item.to === targetState);
  if (!transition) throw new WorkflowEngineError("invalid-workflow-transition", `${workflow.title} does not allow ${current.state} to ${targetState}.`, 409);
  if (transition.roles.length && !transition.roles.includes(actorRole)) throw new WorkflowEngineError("workflow-role-denied", `Role ${actorRole} cannot perform this transition.`, 403);
  const missing = transition.requiredEvidence.filter((kind) => !evidence.has(kind));
  if (missing.length) throw new WorkflowEngineError("missing-transition-evidence", `Transition requires: ${missing.join(", ")}.`, 409);
  return transition;
}

function assignWorkflow(root, graph, input) {
  if (!onlyKnownKeys(input, ["operationId", "recordId", "workflowId", "actor", "observedAt"])) throw new WorkflowEngineError("unknown-workflow-assignment-field", "Workflow assignment accepts only documented fields.");
  const workflow = getWorkflow(root, input.workflowId);
  const delivery = readDeliveryStore(root, graph.project.projectId);
  if (delivery.status === "invalid") throw new WorkflowEngineError("invalid-delivery-store", delivery.diagnostics[0].message);
  const recordId = safeId(input.recordId, "recordId");
  const record = delivery.store.records.find((item) => item.id === recordId);
  if (!record) throw new WorkflowEngineError("unknown-work-record", "recordId does not exist.", 404);
  if (recordState(delivery.store, recordId)) throw new WorkflowEngineError("workflow-already-assigned", "Work record already has a workflow assignment.", 409);
  try {
    const result = recordWorkEvent(root, graph, {
      operationId: input.operationId,
      recordId,
      eventType: "workflow-assigned",
      summary: `Assigned ${workflow.title} at ${workflow.initialState}.`,
      actor: input.actor,
      observedAt: input.observedAt,
      evidence: [],
      workflow: { workflowId: workflow.id, fromState: null, toState: workflow.initialState },
    });
    return { schemaVersion: "flowpeek-workflow-assignment-result/v1", assigned: result.created, workflow, state: workflow.initialState, event: result.event };
  } catch (error) {
    if (error instanceof DeliveryGraphError) throw new WorkflowEngineError(error.code, error.message, error.statusCode);
    throw error;
  }
}

function transitionWorkRecord(root, graph, input) {
  if (!onlyKnownKeys(input, ["operationId", "recordId", "workflowId", "expectedState", "targetState", "actor", "actorRole", "observedAt", "evidence"])) throw new WorkflowEngineError("unknown-workflow-transition-field", "Workflow transitions accept only documented fields.");
  const workflow = getWorkflow(root, input.workflowId);
  const delivery = readDeliveryStore(root, graph.project.projectId);
  if (delivery.status === "invalid") throw new WorkflowEngineError("invalid-delivery-store", delivery.diagnostics[0].message);
  const recordId = safeId(input.recordId, "recordId");
  const record = delivery.store.records.find((item) => item.id === recordId);
  if (!record) throw new WorkflowEngineError("unknown-work-record", "recordId does not exist.", 404);
  const current = recordState(delivery.store, recordId);
  if (!current) throw new WorkflowEngineError("workflow-not-assigned", "Assign a workflow before transitioning this work record.", 409);
  const expectedState = safeId(input.expectedState, "expectedState");
  if (current.state !== expectedState) throw new WorkflowEngineError("stale-workflow-state", `Current state is ${current.state}, not ${expectedState}.`, 409);
  const targetState = safeId(input.targetState, "targetState");
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const kinds = evidenceKinds(delivery.store, record, graph, evidence);
  const actorRole = safeText(input.actorRole, "actorRole", 120);
  validateTransition(workflow, current, targetState, actorRole, kinds);
  if (BUILTIN_IMPLEMENTATION_ENTRY_STATES[workflow.id] === targetState) {
    const readiness = getWorkDependencyStatus(root, graph, recordId);
    if (readiness.status !== "available" || !readiness.summary.readyToStart) {
      const blocked = readiness.dependencies.filter((item) => item.status !== "ready").map((item) => `${item.id} (${item.status})`);
      throw new WorkflowEngineError("work-dependencies-blocked", `Implementation entry is blocked by declared dependencies: ${blocked.join(", ") || "dependency readiness is unavailable"}.`, 409);
    }
  }
  try {
    const result = recordWorkEvent(root, graph, {
      operationId: input.operationId,
      recordId,
      eventType: "workflow-transition",
      summary: `Transitioned ${workflow.title}: ${current.state} to ${targetState}.`,
      actor: input.actor,
      observedAt: input.observedAt,
      evidence,
      workflow: { workflowId: workflow.id, fromState: current.state, toState: targetState },
    });
    return { schemaVersion: "flowpeek-workflow-transition-result/v1", transitioned: result.created, workflow, fromState: current.state, toState: targetState, event: result.event, limitation: "A permitted transition records supplied evidence references. It does not independently validate target execution, external CI, deployment, or approval authority." };
  } catch (error) {
    if (error instanceof DeliveryGraphError) throw new WorkflowEngineError(error.code, error.message, error.statusCode);
    throw error;
  }
}

function getWorkRecordWorkflow(root, graph, recordId) {
  const delivery = readDeliveryStore(root, graph.project.projectId);
  if (delivery.status === "invalid") return { schemaVersion: "flowpeek-work-record-workflow/v1", status: "unavailable", record: null, workflow: null, state: null, diagnostics: delivery.diagnostics };
  const id = safeId(recordId, "recordId");
  const record = delivery.store.records.find((item) => item.id === id);
  if (!record) throw new WorkflowEngineError("unknown-work-record", "recordId does not exist.", 404);
  const state = recordState(delivery.store, id);
  const workflow = state ? getWorkflow(root, state.workflowId) : null;
  return { schemaVersion: "flowpeek-work-record-workflow/v1", status: "available", record, workflow, state: state ? { workflowId: state.workflowId, state: state.state, eventId: state.event.id, observedAt: state.event.observedAt } : null, limitation: "Workflow state is derived from append-only local events and remains separate from repository parser facts." };
}

module.exports = {
  BUILTIN_WORKFLOWS,
  MAX_WORKFLOWS,
  WORKFLOW_SCHEMA,
  WORKFLOW_STORE_RELATIVE_PATH,
  WORKFLOW_STORE_SCHEMA,
  WorkflowEngineError,
  assignWorkflow,
  getWorkDependencyStatus,
  getWorkRecordWorkflow,
  getWorkflow,
  listWorkflows,
  listWorkDependencyStatuses,
  readWorkflowStore,
  saveWorkflow,
  transitionWorkRecord,
};
