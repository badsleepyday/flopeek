"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseContextRef } = require("./context-card");
const { atomicWriteJson } = require("./graph-cache");

const AGENT_EVIDENCE_TRACE_SCHEMA = "flopeek-agent-evidence-trace/v1";
const AGENT_EVIDENCE_TRACE_STORE_SCHEMA = "flopeek-agent-evidence-traces/v1";
const AGENT_EVIDENCE_TRACE_LIST_SCHEMA = "flopeek-agent-evidence-trace-list/v1";
const AGENT_EVIDENCE_TRACES_RELATIVE_PATH = ".flopeek/agent-evidence-traces.json";
const ACTION_TYPES = new Set(["inspect", "plan", "edit", "refactor", "test", "verify", "document", "other"]);
const VERIFICATION_STATUSES = new Set(["not-run", "passed", "failed", "partial", "unknown"]);
const RESOLUTION_STATUSES = new Set(["current", "stale", "historical"]);

class AgentEvidenceTraceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentEvidenceTraceError";
    this.code = code;
  }
}

function tracePath(root) {
  return path.join(root, AGENT_EVIDENCE_TRACES_RELATIVE_PATH);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function boundedText(value, name, { required = true, maximum = 2_000 } = {}) {
  if (value === undefined || value === null || typeof value !== "string") {
    if (required) throw new AgentEvidenceTraceError("missing-field", `${name} is required and must be a string.`);
    return null;
  }
  const normalized = value.trim();
  if (required && !normalized) throw new AgentEvidenceTraceError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new AgentEvidenceTraceError("field-too-long", `${name} must be at most ${maximum} characters.`);
  return normalized || null;
}

function isSafeRelativePath(candidate) {
  if (typeof candidate !== "string" || !candidate || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate) || candidate.includes("\0")) return false;
  const slashPath = candidate.replaceAll("\\", "/");
  const segments = slashPath.split("/");
  return !segments.some((segment) => segment === "..") && !["", "."].includes(path.posix.normalize(slashPath));
}

function changedPaths(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new AgentEvidenceTraceError("invalid-changed-paths", "changedPaths must be an array with at most 100 repository-relative paths.");
  const normalized = value.map((item, index) => {
    const candidate = boundedText(item, `changedPaths[${index}]`, { maximum: 2_048 }).replaceAll("\\", "/");
    const segments = candidate.split("/");
    if (!isSafeRelativePath(candidate) || segments.some((segment) => segment === "..")) {
      throw new AgentEvidenceTraceError("unsafe-changed-path", `changedPaths[${index}] must stay within the repository.`);
    }
    const result = path.posix.normalize(candidate).replace(/^\.\//, "");
    if (!result || result === ".") throw new AgentEvidenceTraceError("invalid-changed-path", `changedPaths[${index}] must identify a repository file.`);
    return result;
  });
  return [...new Set(normalized)].sort();
}

function normalizeInput(input) {
  const actionType = boundedText(input?.actionType, "actionType", { maximum: 40 }).toLowerCase();
  if (!ACTION_TYPES.has(actionType)) throw new AgentEvidenceTraceError("invalid-action-type", `actionType must be one of: ${[...ACTION_TYPES].join(", ")}.`);
  const verificationStatus = boundedText(input?.verificationStatus, "verificationStatus", { maximum: 40 }).toLowerCase();
  if (!VERIFICATION_STATUSES.has(verificationStatus)) throw new AgentEvidenceTraceError("invalid-verification-status", `verificationStatus must be one of: ${[...VERIFICATION_STATUSES].join(", ")}.`);
  return {
    operationId: boundedText(input?.operationId, "operationId", { maximum: 240 }),
    contextRef: boundedText(input?.contextRef, "contextRef", { maximum: 8_192 }),
    actionType,
    actionSummary: boundedText(input?.actionSummary, "actionSummary", { maximum: 2_000 }),
    changedPaths: changedPaths(input?.changedPaths),
    verificationStatus,
    verificationSummary: boundedText(input?.verificationSummary, "verificationSummary", { maximum: 2_000 }),
    actor: boundedText(input?.actor, "actor", { maximum: 240 }),
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === AGENT_EVIDENCE_TRACE_SCHEMA
    && typeof value.id === "string" && value.id
    && typeof value.operationId === "string" && value.operationId
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && value.knowledgeClass === "agent-declared"
    && typeof value.project?.projectId === "string" && value.project.projectId
    && Number.isSafeInteger(value.project.evidenceGraphVersion) && value.project.evidenceGraphVersion >= 0
    && Number.isSafeInteger(value.project.recordedGraphVersion) && value.project.recordedGraphVersion >= 0
    && (value.project.sourceRevision === null || typeof value.project.sourceRevision === "string")
    && typeof value.context?.ref === "string" && value.context.ref
    && ["node", "flow"].includes(value.context.kind)
    && typeof value.context.id === "string" && value.context.id
    && RESOLUTION_STATUSES.has(value.context.resolutionStatus)
    && ACTION_TYPES.has(value.action?.type) && typeof value.action.summary === "string" && value.action.summary
    && Array.isArray(value.changedPaths) && value.changedPaths.length <= 100 && value.changedPaths.every(isSafeRelativePath)
    && VERIFICATION_STATUSES.has(value.verification?.status) && typeof value.verification.summary === "string" && value.verification.summary
    && typeof value.actor === "string" && value.actor
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && Array.isArray(value.limitations) && value.limitations.every((item) => typeof item === "string");
}

function emptyStore(projectId) {
  return { schemaVersion: AGENT_EVIDENCE_TRACE_STORE_SCHEMA, projectId, records: [] };
}

function readAgentEvidenceTraceStore(root, projectId) {
  const target = tracePath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const recordIds = Array.isArray(store?.records) ? store.records.map((record) => record.id) : [];
    const operationIds = Array.isArray(store?.records) ? store.records.map((record) => record.operationId) : [];
    if (!store || typeof store !== "object" || Array.isArray(store) || store.schemaVersion !== AGENT_EVIDENCE_TRACE_STORE_SCHEMA || store.projectId !== projectId || !Array.isArray(store.records) || !store.records.every(isRecord) || new Set(recordIds).size !== recordIds.length || new Set(operationIds).size !== operationIds.length) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-agent-evidence-trace-store", message: "Agent evidence trace metadata does not match flopeek-agent-evidence-traces/v1." }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-agent-evidence-trace-json", message: `Agent evidence trace metadata is not valid JSON (${error.message}).` }] };
  }
}

function recordId(projectId, operationId) {
  const digest = crypto.createHash("sha256").update(`${projectId}\n${operationId}`).digest("hex").slice(0, 32);
  return `agent-evidence:${digest}`;
}

function saveAgentEvidenceTrace(root, graph, input, options = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new AgentEvidenceTraceError("missing-graph-identity", "Agent evidence requires a project ID and graph version.");
  const normalized = normalizeInput(input || {});
  let parsed;
  try {
    parsed = parseContextRef(normalized.contextRef);
  } catch (error) {
    throw new AgentEvidenceTraceError(error.code || "invalid-context-ref", error.message);
  }
  if (parsed.projectId !== graph.project.projectId) throw new AgentEvidenceTraceError("wrong-project-id", "Context Ref belongs to a different Flopeek project.");
  if (!["node", "flow"].includes(parsed.kind)) throw new AgentEvidenceTraceError("unsupported-context-kind", "Agent evidence currently supports node and flow Context Refs.");
  if (parsed.graphVersion > graph.state.graphVersion) throw new AgentEvidenceTraceError("future-graph-version", "Context Ref targets a graph version newer than the current local graph.");
  const read = readAgentEvidenceTraceStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new AgentEvidenceTraceError("invalid-agent-evidence-trace-store", read.diagnostics[0].message);
  const store = read.store || emptyStore(graph.project.projectId);
  const inputFingerprint = fingerprint(normalized);
  const existing = store.records.find((record) => record.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new AgentEvidenceTraceError("operation-id-conflict", "operationId already belongs to a different immutable agent evidence record.");
    return { schemaVersion: "flopeek-agent-evidence-trace-result/v1", created: false, record: existing, path: tracePath(root), limitation: "The existing immutable record was returned for this idempotent operationId." };
  }

  const resolutionStatus = options.resolution?.status;
  if (!RESOLUTION_STATUSES.has(resolutionStatus)) throw new AgentEvidenceTraceError("unresolved-context-ref", "New agent evidence must reference a Context Ref resolved by Flopeek as current, stale, or retained historical evidence.");

  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new AgentEvidenceTraceError("invalid-created-at", "Agent evidence createdAt must be an ISO-compatible timestamp.");
  const record = {
    schemaVersion: AGENT_EVIDENCE_TRACE_SCHEMA,
    id: recordId(graph.project.projectId, normalized.operationId),
    operationId: normalized.operationId,
    inputFingerprint,
    knowledgeClass: "agent-declared",
    project: {
      projectId: graph.project.projectId,
      evidenceGraphVersion: parsed.graphVersion,
      recordedGraphVersion: graph.state.graphVersion,
      sourceRevision: graph.state.sourceRevision || null,
    },
    context: { ref: normalized.contextRef, kind: parsed.kind, id: parsed.contextId, resolutionStatus },
    action: { type: normalized.actionType, summary: normalized.actionSummary },
    changedPaths: normalized.changedPaths,
    verification: { status: normalized.verificationStatus, summary: normalized.verificationSummary },
    actor: normalized.actor,
    createdAt,
    limitations: [
      "This record is an agent-declared audit trace, not private model reasoning, human verification, or proof that the action or checks were correct.",
      "Free-text fields must contain concise outcomes only. Callers must not submit prompts, private reasoning, source contents, raw command output, credentials, or runtime traces.",
    ],
  };
  const next = { ...store, records: [...store.records, record] };
  atomicWriteJson(tracePath(root), next);
  return { schemaVersion: "flopeek-agent-evidence-trace-result/v1", created: true, record, path: tracePath(root), limitation: "The record is append-only and can be superseded only by a new operationId, never overwritten." };
}

function listAgentEvidenceTraces(root, graph, options = {}) {
  const read = readAgentEvidenceTraceStore(root, graph.project.projectId);
  const limitValue = Number(options.limit ?? 20);
  const limit = Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 100 ? limitValue : 20;
  const base = { schemaVersion: AGENT_EVIDENCE_TRACE_LIST_SCHEMA, projectId: graph.project.projectId, diagnostics: read.diagnostics };
  if (read.status === "invalid") return { ...base, status: "unavailable", totalMatched: 0, returned: 0, truncated: false, records: [], limitation: read.diagnostics[0].message };
  const contextRef = typeof options.contextRef === "string" && options.contextRef.trim() ? options.contextRef.trim() : null;
  const contextId = typeof options.contextId === "string" && options.contextId.trim() ? options.contextId.trim() : null;
  const operationId = typeof options.operationId === "string" && options.operationId.trim() ? options.operationId.trim() : null;
  const matches = read.store.records
    .filter((record) => !contextRef || record.context.ref === contextRef)
    .filter((record) => !contextId || record.context.id === contextId)
    .filter((record) => !operationId || record.operationId === operationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return {
    ...base,
    status: "available",
    totalMatched: matches.length,
    returned: Math.min(matches.length, limit),
    truncated: matches.length > limit,
    records: matches.slice(0, limit),
    limitation: "Records are agent-declared metadata linked to static Context Refs, not human verification or runtime proof. Summary fields are for concise outcomes only and must not contain private reasoning or sensitive/source content.",
  };
}

function agentEvidenceTracePolicy(root, graph) {
  const listed = listAgentEvidenceTraces(root, graph, { limit: 5 });
  return {
    schemaVersion: "flopeek-agent-evidence-trace-policy/v1",
    status: listed.status,
    storeSchemaVersion: AGENT_EVIDENCE_TRACE_STORE_SCHEMA,
    recordTool: "record_agent_evidence_trace",
    readTool: "get_agent_evidence_traces",
    requiredFields: ["operationId", "contextRef", "actionType", "actionSummary", "verificationStatus", "verificationSummary", "actor"],
    totalRecords: listed.totalMatched,
    recentRecords: listed.records.map((record) => ({
      id: record.id,
      operationId: record.operationId,
      contextRef: record.context.ref,
      actionType: record.action.type,
      changedPathCount: record.changedPaths.length,
      verificationStatus: record.verification.status,
      actor: record.actor,
      createdAt: record.createdAt,
    })),
    diagnostics: listed.diagnostics,
    limitation: "The tool appends declared audit metadata only. It cannot write repository source or create human verification, and callers must not put private reasoning or sensitive/source content in summary fields.",
  };
}

module.exports = {
  ACTION_TYPES,
  AGENT_EVIDENCE_TRACE_LIST_SCHEMA,
  AGENT_EVIDENCE_TRACE_SCHEMA,
  AGENT_EVIDENCE_TRACE_STORE_SCHEMA,
  AGENT_EVIDENCE_TRACES_RELATIVE_PATH,
  AgentEvidenceTraceError,
  VERIFICATION_STATUSES,
  agentEvidenceTracePolicy,
  listAgentEvidenceTraces,
  normalizeInput,
  readAgentEvidenceTraceStore,
  saveAgentEvidenceTrace,
  tracePath,
};
