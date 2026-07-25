"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");

const AGENT_SEMANTIC_PROPOSAL_SCHEMA = "flowpeek-agent-semantic-proposal/v1";
const AGENT_SEMANTIC_PROPOSAL_STORE_SCHEMA = "flowpeek-agent-semantic-proposals/v1";
const AGENT_SEMANTIC_PROPOSALS_RELATIVE_PATH = ".flowpeek/agent-semantic-proposals.json";
const RISK_LEVELS = new Set(["low", "medium", "high", "critical", "unknown"]);

class AgentSemanticProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentSemanticProposalError";
    this.code = code;
  }
}

function text(value, name, { required = true, maximum = 2_000 } = {}) {
  if (value === undefined || value === null || typeof value !== "string") {
    if (required) throw new AgentSemanticProposalError("missing-field", `${name} is required and must be a string.`);
    return null;
  }
  const normalized = value.trim();
  if (required && !normalized) throw new AgentSemanticProposalError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new AgentSemanticProposalError("field-too-long", `${name} must be at most ${maximum} characters.`);
  return normalized || null;
}

function candidate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentSemanticProposalError("invalid-candidate", "candidate must be an object.");
  const grouping = input.grouping;
  if (!grouping || typeof grouping !== "object" || Array.isArray(grouping)) throw new AgentSemanticProposalError("invalid-candidate", "candidate.grouping is required.");
  const risk = String(input.risk || "unknown").trim().toLowerCase();
  if (!RISK_LEVELS.has(risk)) throw new AgentSemanticProposalError("invalid-risk", "candidate.risk must be low, medium, high, critical, or unknown.");
  if (input.questions !== undefined && (!Array.isArray(input.questions) || input.questions.length > 20)) throw new AgentSemanticProposalError("invalid-questions", "candidate.questions must contain at most 20 items.");
  return {
    title: text(input.title, "candidate.title", { maximum: 240 }),
    technicalPurpose: text(input.technicalPurpose, "candidate.technicalPurpose", { maximum: 4_000 }),
    role: text(input.role, "candidate.role", { maximum: 120 }),
    grouping: {
      key: text(grouping.key, "candidate.grouping.key", { maximum: 120 }),
      label: text(grouping.label, "candidate.grouping.label", { maximum: 240 }),
    },
    owner: text(input.owner, "candidate.owner", { required: false, maximum: 240 }),
    risk,
    questions: (input.questions || []).map((item, index) => text(item, `candidate.questions[${index}]`, { maximum: 800 })),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function proposalPath(root) {
  return path.join(root, AGENT_SEMANTIC_PROPOSALS_RELATIVE_PATH);
}

function onlyKnownKeys(value, allowed) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value) {
  return onlyKnownKeys(value, ["schemaVersion", "id", "operationId", "inputFingerprint", "knowledgeClass", "project", "flow", "sourceSuggestion", "candidate", "proposedBy", "provider", "rationale", "createdAt", "supersedes", "verificationStatus", "limitations"])
    && onlyKnownKeys(value.project, ["projectId", "graphVersion", "sourceRevision"])
    && onlyKnownKeys(value.flow, ["id", "contextRef"])
    && onlyKnownKeys(value.sourceSuggestion, ["id", "status", "fingerprint"])
    && onlyKnownKeys(value.candidate, ["title", "technicalPurpose", "role", "grouping", "owner", "risk", "questions"])
    && onlyKnownKeys(value.candidate.grouping, ["key", "label"])
    && value.schemaVersion === AGENT_SEMANTIC_PROPOSAL_SCHEMA
    && typeof value.id === "string" && value.id
    && typeof value.operationId === "string" && value.operationId
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && value.knowledgeClass === "agent-proposed"
    && typeof value.project?.projectId === "string" && value.project.projectId
    && Number.isSafeInteger(value.project.graphVersion)
    && (value.project.sourceRevision === null || typeof value.project.sourceRevision === "string")
    && typeof value.flow?.id === "string" && value.flow.id
    && typeof value.flow?.contextRef === "string" && value.flow.contextRef
    && (value.sourceSuggestion.id === null || typeof value.sourceSuggestion.id === "string")
    && typeof value.sourceSuggestion.status === "string"
    && (value.sourceSuggestion.fingerprint === null || (typeof value.sourceSuggestion.fingerprint === "string" && value.sourceSuggestion.fingerprint.startsWith("sha256:")))
    && Boolean(value.candidate?.title && value.candidate?.technicalPurpose && value.candidate?.role && value.candidate?.grouping?.key && value.candidate?.grouping?.label)
    && (value.candidate.owner === null || typeof value.candidate.owner === "string")
    && RISK_LEVELS.has(value.candidate.risk)
    && Array.isArray(value.candidate.questions) && value.candidate.questions.every((item) => typeof item === "string")
    && typeof value.proposedBy === "string" && value.proposedBy
    && typeof value.provider === "string" && value.provider
    && typeof value.rationale === "string" && value.rationale
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && (value.supersedes === null || typeof value.supersedes === "string")
    && value.verificationStatus === "unverified"
    && Array.isArray(value.limitations) && value.limitations.every((item) => typeof item === "string");
}

function emptyStore(projectId) {
  return { schemaVersion: AGENT_SEMANTIC_PROPOSAL_STORE_SCHEMA, projectId, records: [] };
}

function readAgentSemanticProposalStore(root, projectId) {
  const target = proposalPath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const operations = Array.isArray(store?.records) ? store.records.map((record) => record.operationId) : [];
    if (!onlyKnownKeys(store, ["schemaVersion", "projectId", "records"]) || store.schemaVersion !== AGENT_SEMANTIC_PROPOSAL_STORE_SCHEMA || store.projectId !== projectId || !Array.isArray(store.records) || !store.records.every(isRecord) || new Set(operations).size !== operations.length) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-agent-semantic-proposal-store", message: "Agent semantic proposal metadata does not match flowpeek-agent-semantic-proposals/v1." }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-agent-semantic-proposal-json", message: `Agent semantic proposal metadata is not valid JSON (${error.message}).` }] };
  }
}

function latest(store, flowId) {
  const superseded = new Set(store.records.map((record) => record.supersedes).filter(Boolean));
  return store.records.filter((record) => record.flow.id === flowId && !superseded.has(record.id)).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0] || null;
}

function history(store, flowId) {
  const superseded = new Set(store.records.map((record) => record.supersedes).filter(Boolean));
  return store.records.filter((record) => record.flow.id === flowId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).map((record) => ({ ...record, lifecycleStatus: superseded.has(record.id) ? "superseded" : "active" }));
}

function saveAgentSemanticProposal(root, graph, lens, suggestion, input = {}, options = {}) {
  if (!graph?.project?.projectId || !lens?.flow?.contextRef) throw new AgentSemanticProposalError("missing-current-flow", "A current Flow Lens is required.");
  const expectedFlowContextRef = text(input.expectedFlowContextRef, "expectedFlowContextRef", { maximum: 8_192 });
  if (expectedFlowContextRef !== lens.flow.contextRef) throw new AgentSemanticProposalError("stale-agent-proposal", "The proposal does not target the current Flow Context Ref. Refresh evidence before proposing semantics.");
  const normalized = {
    operationId: text(input.operationId, "operationId", { maximum: 240 }),
    expectedFlowContextRef,
    candidate: candidate(input.candidate),
    proposedBy: text(input.proposedBy, "proposedBy", { maximum: 240 }),
    provider: text(input.provider, "provider", { maximum: 240 }),
    rationale: text(input.rationale, "rationale", { maximum: 2_000 }),
  };
  const read = readAgentSemanticProposalStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new AgentSemanticProposalError("invalid-agent-semantic-proposal-store", read.diagnostics[0].message);
  const inputFingerprint = fingerprint(normalized);
  const existing = read.store.records.find((record) => record.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new AgentSemanticProposalError("operation-id-conflict", "operationId already belongs to a different immutable proposal.");
    return { schemaVersion: "flowpeek-agent-semantic-proposal-result/v1", created: false, record: existing };
  }
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new AgentSemanticProposalError("invalid-created-at", "createdAt must be an ISO-compatible timestamp.");
  const base = {
    schemaVersion: AGENT_SEMANTIC_PROPOSAL_SCHEMA,
    operationId: normalized.operationId,
    inputFingerprint,
    knowledgeClass: "agent-proposed",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    flow: { id: lens.flow.id, contextRef: lens.flow.contextRef },
    sourceSuggestion: { id: suggestion?.id || null, status: suggestion?.status || "unavailable", fingerprint: suggestion ? fingerprint(suggestion) : null },
    candidate: normalized.candidate,
    proposedBy: normalized.proposedBy,
    provider: normalized.provider,
    rationale: normalized.rationale,
    createdAt,
    supersedes: latest(read.store, lens.flow.id)?.id || null,
    verificationStatus: "unverified",
    limitations: [
      "This provider or agent proposal may override a draft label, but it never overrides parser facts, human feedback, or human verification.",
      "The proposal contains bounded metadata only and must not contain source bodies, prompts, private reasoning, credentials, or raw logs.",
    ],
  };
  const record = { ...base, id: `agent-semantic-proposal:${fingerprint(base).slice(7, 39)}` };
  atomicWriteJson(read.path, { ...read.store, records: [...read.store.records, record] });
  return { schemaVersion: "flowpeek-agent-semantic-proposal-result/v1", created: true, record };
}

function resolveAgentSemanticProposal(root, graph, lens) {
  const read = readAgentSemanticProposalStore(root, graph.project.projectId);
  const base = { schemaVersion: "flowpeek-agent-semantic-proposal-resolution/v1", flowId: lens.flow.id, currentFlowContextRef: lens.flow.contextRef, diagnostics: read.diagnostics };
  if (read.status === "invalid") return { ...base, status: "unavailable", record: null, history: [], reason: read.diagnostics[0].message };
  const record = latest(read.store, lens.flow.id);
  const records = history(read.store, lens.flow.id);
  if (!record) return { ...base, status: "missing", record: null, history: records, reason: "No agent or provider semantic proposal exists for this flow." };
  if (record.flow.contextRef === lens.flow.contextRef && record.project.graphVersion === graph.state.graphVersion) return { ...base, status: "current", record, history: records, reason: "The proposal targets the current Flow Context Ref and graph version." };
  return { ...base, status: "stale", record, history: records, reason: "The proposal targets an earlier Flow Context Ref or graph version and cannot prefill current verification automatically." };
}

module.exports = {
  AGENT_SEMANTIC_PROPOSALS_RELATIVE_PATH,
  AGENT_SEMANTIC_PROPOSAL_SCHEMA,
  AGENT_SEMANTIC_PROPOSAL_STORE_SCHEMA,
  AgentSemanticProposalError,
  readAgentSemanticProposalStore,
  resolveAgentSemanticProposal,
  saveAgentSemanticProposal,
};
