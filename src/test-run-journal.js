"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");

const TEST_RUN_EVENT_SCHEMA = "flopeek-test-run-event/v1";
const TEST_RUN_STORE_SCHEMA = "flopeek-test-run-events/v1";
const TEST_RUN_EVENTS_RELATIVE_PATH = ".flopeek/test-runs/events.json";
const EVENT_TYPES = new Set(["run-started", "step-started", "step-passed", "step-failed", "run-passed", "run-failed", "run-cancelled"]);
const TERMINAL_TYPES = new Set(["step-failed", "run-passed", "run-failed", "run-cancelled"]);
const STEP_TYPES = new Set(["step-started", "step-passed", "step-failed"]);
const MAX_EVENTS = 10_000;

class TestRunJournalError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "TestRunJournalError";
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

function text(value, name, { required = true, maximum = 1200 } = {}) {
  if (value === undefined || value === null || typeof value !== "string") {
    if (required) throw new TestRunJournalError("missing-field", `${name} is required and must be a string.`);
    return null;
  }
  if (/[\r\n\u0000]/.test(value)) throw new TestRunJournalError("unsafe-test-run-text", `${name} must be concise single-line metadata, not source or raw logs.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (required && !normalized) throw new TestRunJournalError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new TestRunJournalError("field-too-long", `${name} must be at most ${maximum} characters.`);
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S{12,}|\b(?:password|api[_-]?key|token|secret)\s*[:=]\s*\S+)/i.test(normalized)) throw new TestRunJournalError("unsafe-test-run-text", `${name} contains credential-like data.`);
  if (/(?:\b[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/|\/(?:Users|home|mnt\/[A-Za-z])\/)/i.test(normalized)) throw new TestRunJournalError("unsafe-test-run-text", `${name} contains a machine-specific path.`);
  if (/```|(?:^|[;{}])\s*(?:const|let|var|function|class|import|export)\s+[\w{*]|=>\s*[{(]?/.test(normalized)) throw new TestRunJournalError("unsafe-test-run-text", `${name} contains source-like data.`);
  return normalized || null;
}

function onlyKnownKeys(value, allowed) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value) {
  return onlyKnownKeys(value, ["schemaVersion", "id", "operationId", "inputFingerprint", "projectId", "graphVersion", "flowId", "flowContextRef", "runId", "sequence", "eventType", "stepId", "summary", "runner", "actor", "observedAt", "durationMs", "evidenceClass", "policy"])
    && value.schemaVersion === TEST_RUN_EVENT_SCHEMA
    && typeof value.id === "string" && value.id
    && typeof value.operationId === "string" && value.operationId
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && typeof value.projectId === "string" && value.projectId
    && Number.isSafeInteger(value.graphVersion)
    && typeof value.flowId === "string" && value.flowId
    && typeof value.flowContextRef === "string" && value.flowContextRef
    && typeof value.runId === "string" && value.runId
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && EVENT_TYPES.has(value.eventType)
    && (value.stepId === null || typeof value.stepId === "string")
    && typeof value.summary === "string" && value.summary
    && typeof value.runner === "string" && value.runner
    && typeof value.actor === "string" && value.actor
    && typeof value.observedAt === "string" && !Number.isNaN(Date.parse(value.observedAt))
    && (value.durationMs === null || Number.isSafeInteger(value.durationMs))
    && value.evidenceClass === "runtime-evidence"
    && onlyKnownKeys(value.policy, ["optIn", "executesCommands", "sourceBodies", "rawLogs", "credentials", "machinePaths"])
    && value.policy.optIn === true && value.policy.executesCommands === false;
}

function storePath(root) {
  return path.join(root, TEST_RUN_EVENTS_RELATIVE_PATH);
}

function readTestRunStore(root, projectId) {
  const target = storePath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: { schemaVersion: TEST_RUN_STORE_SCHEMA, projectId, events: [] }, diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const operations = Array.isArray(store?.events) ? store.events.map((event) => event.operationId) : [];
    if (!onlyKnownKeys(store, ["schemaVersion", "projectId", "events"]) || store.schemaVersion !== TEST_RUN_STORE_SCHEMA || store.projectId !== projectId || !Array.isArray(store.events) || !store.events.every(isRecord) || new Set(operations).size !== operations.length) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-test-run-store", message: "Test-run journal does not match flopeek-test-run-events/v1." }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-test-run-json", message: `Test-run journal is not valid JSON (${error.message}).` }] };
  }
}

function summarizeRun(events) {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  let currentStepId = null;
  let terminal = null;
  for (const event of ordered) {
    if (event.eventType === "step-started") currentStepId = event.stepId;
    if (event.eventType === "step-passed") currentStepId = null;
    if (TERMINAL_TYPES.has(event.eventType)) {
      terminal = event;
      if (event.eventType !== "run-passed") currentStepId = event.stepId || currentStepId;
      else currentStepId = null;
    }
  }
  const last = ordered.at(-1) || null;
  const outcome = terminal?.eventType === "run-passed" ? "passed" : terminal?.eventType === "run-cancelled" ? "cancelled" : terminal ? "failed" : "running";
  return {
    runId: last?.runId || null,
    flowId: last?.flowId || null,
    flowContextRef: last?.flowContextRef || null,
    graphVersion: last?.graphVersion ?? null,
    status: outcome,
    currentStepId,
    stoppedAtStepId: outcome === "failed" ? currentStepId : null,
    lastSequence: last?.sequence ?? -1,
    lastEventType: last?.eventType || null,
    startedAt: ordered[0]?.observedAt || null,
    updatedAt: last?.observedAt || null,
    events: ordered,
  };
}

function normalizeInput(graph, lens, input) {
  if (!onlyKnownKeys(input, ["operationId", "flowId", "expectedFlowContextRef", "runId", "sequence", "eventType", "stepId", "summary", "runner", "actor", "observedAt", "durationMs"])) throw new TestRunJournalError("unknown-test-run-field", "Test-run events accept only documented fields.");
  const expectedFlowContextRef = text(input.expectedFlowContextRef, "expectedFlowContextRef", { maximum: 8192 });
  if (expectedFlowContextRef !== lens.flow.contextRef) throw new TestRunJournalError("stale-test-run-context", "Test-run event targets an earlier Flow Context Ref.", 409);
  const eventType = text(input.eventType, "eventType", { maximum: 40 });
  if (!EVENT_TYPES.has(eventType)) throw new TestRunJournalError("invalid-event-type", `eventType must be one of: ${[...EVENT_TYPES].join(", ")}.`);
  const stepId = text(input.stepId, "stepId", { required: false, maximum: 4096 });
  if (STEP_TYPES.has(eventType) && !stepId) throw new TestRunJournalError("missing-step-id", `${eventType} requires stepId.`);
  if (stepId && !(lens.steps || []).some((step) => step.id === stepId)) throw new TestRunJournalError("unknown-flow-step", "stepId is not a current displayed static Flow Lens step.");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new TestRunJournalError("invalid-sequence", "sequence must be a non-negative integer.");
  if (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 86_400_000)) throw new TestRunJournalError("invalid-duration", "durationMs must be an integer from 0 to 86400000.");
  const observedAt = text(input.observedAt, "observedAt", { maximum: 80 });
  if (Number.isNaN(Date.parse(observedAt))) throw new TestRunJournalError("invalid-observed-at", "observedAt must be an ISO-compatible timestamp.");
  return {
    operationId: text(input.operationId, "operationId", { maximum: 240 }),
    flowId: lens.flow.id,
    expectedFlowContextRef,
    runId: text(input.runId, "runId", { maximum: 240 }),
    sequence: input.sequence,
    eventType,
    stepId,
    summary: text(input.summary, "summary", { maximum: 1200 }),
    runner: text(input.runner, "runner", { maximum: 240 }),
    actor: text(input.actor, "actor", { maximum: 240 }),
    observedAt,
    durationMs: input.durationMs ?? null,
  };
}

function validateTransition(events, normalized) {
  const run = summarizeRun(events);
  if (!events.length) {
    if (normalized.sequence !== 0 || normalized.eventType !== "run-started") throw new TestRunJournalError("invalid-run-start", "A run must begin with sequence 0 and eventType run-started.");
    return;
  }
  if (run.status !== "running") throw new TestRunJournalError("test-run-terminal", `Run is already ${run.status}; no later event is accepted.`, 409);
  if (normalized.sequence !== run.lastSequence + 1) throw new TestRunJournalError("invalid-sequence", `Next event sequence must be ${run.lastSequence + 1}.`);
  if (normalized.eventType === "run-started") throw new TestRunJournalError("duplicate-run-start", "run-started is allowed only as the first event.");
  if (normalized.eventType === "step-started" && run.currentStepId) throw new TestRunJournalError("step-already-running", `Step ${run.currentStepId} is still running.`);
  if (["step-passed", "step-failed"].includes(normalized.eventType) && run.currentStepId !== normalized.stepId) throw new TestRunJournalError("step-transition-mismatch", "A step may pass or fail only after the same step was started.");
  if (normalized.eventType === "run-passed" && run.currentStepId) throw new TestRunJournalError("step-still-running", `Step ${run.currentStepId} is still running.`);
}

function saveTestRunEvent(root, graph, lens, input) {
  const normalized = normalizeInput(graph, lens, input || {});
  const read = readTestRunStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new TestRunJournalError("invalid-test-run-store", read.diagnostics[0].message);
  const inputFingerprint = fingerprint(normalized);
  const existing = read.store.events.find((event) => event.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new TestRunJournalError("operation-id-conflict", "operationId already belongs to another test-run event.");
    return { schemaVersion: "flopeek-test-run-event-result/v1", created: false, event: existing, run: summarizeRun(read.store.events.filter((event) => event.runId === existing.runId)) };
  }
  if (read.store.events.length >= MAX_EVENTS) throw new TestRunJournalError("test-run-store-full", `Test-run journal reached its explicit ${MAX_EVENTS}-event limit; archive or remove it before recording more events.`, 507);
  const runEvents = read.store.events.filter((event) => event.runId === normalized.runId);
  if (runEvents.some((event) => event.flowId !== lens.flow.id)) throw new TestRunJournalError("run-flow-mismatch", "runId already belongs to another flow.");
  validateTransition(runEvents, normalized);
  const base = {
    schemaVersion: TEST_RUN_EVENT_SCHEMA,
    operationId: normalized.operationId,
    inputFingerprint,
    projectId: graph.project.projectId,
    graphVersion: graph.state.graphVersion,
    flowId: lens.flow.id,
    flowContextRef: lens.flow.contextRef,
    runId: normalized.runId,
    sequence: normalized.sequence,
    eventType: normalized.eventType,
    stepId: normalized.stepId,
    summary: normalized.summary,
    runner: normalized.runner,
    actor: normalized.actor,
    observedAt: normalized.observedAt,
    durationMs: normalized.durationMs,
    evidenceClass: "runtime-evidence",
    policy: { optIn: true, executesCommands: false, sourceBodies: "excluded", rawLogs: "excluded", credentials: "excluded", machinePaths: "excluded" },
  };
  const event = { ...base, id: `test-run-event:${fingerprint(base).slice(7, 39)}` };
  atomicWriteJson(read.path, { ...read.store, events: [...read.store.events, event] });
  return { schemaVersion: "flopeek-test-run-event-result/v1", created: true, event, run: summarizeRun([...runEvents, event]) };
}

function listTestRuns(root, graph, options = {}) {
  const read = readTestRunStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flopeek-test-run-list/v1", status: "unavailable", runs: [], diagnostics: read.diagnostics };
  const grouped = new Map();
  for (const event of read.store.events) grouped.set(event.runId, [...(grouped.get(event.runId) || []), event]);
  let runs = [...grouped.values()].map(summarizeRun);
  if (options.flowId) runs = runs.filter((run) => run.flowId === options.flowId);
  if (options.status) runs = runs.filter((run) => run.status === options.status);
  runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId));
  const limit = Number.isSafeInteger(Number(options.limit)) ? Math.max(1, Math.min(Number(options.limit), 100)) : 20;
  return {
    schemaVersion: "flopeek-test-run-list/v1",
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    totalMatched: runs.length,
    returned: Math.min(runs.length, limit),
    truncated: runs.length > limit,
    runs: runs.slice(0, limit),
    diagnostics: [],
    limitation: "Runs are explicit adapter-reported events. Flopeek does not execute commands, capture raw logs, or claim that static step order is runtime order.",
  };
}

module.exports = {
  EVENT_TYPES,
  MAX_EVENTS,
  TEST_RUN_EVENTS_RELATIVE_PATH,
  TEST_RUN_EVENT_SCHEMA,
  TEST_RUN_STORE_SCHEMA,
  TestRunJournalError,
  listTestRuns,
  readTestRunStore,
  saveTestRunEvent,
  summarizeRun,
};
