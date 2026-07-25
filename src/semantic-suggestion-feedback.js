"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { readAgentEvidenceTraceStore } = require("./agent-evidence-trace");

const SEMANTIC_SUGGESTION_FEEDBACK_SCHEMA = "flopeek-semantic-suggestion-feedback/v1";
const SEMANTIC_SUGGESTION_FEEDBACK_STORE_SCHEMA = "flopeek-semantic-suggestion-feedbacks/v1";
const SEMANTIC_SUGGESTION_FEEDBACK_LIST_SCHEMA = "flopeek-semantic-suggestion-feedback-list/v1";
const SEMANTIC_SUGGESTION_FEEDBACK_RESOLUTION_SCHEMA = "flopeek-semantic-suggestion-feedback-resolution/v1";
const SEMANTIC_SUGGESTION_LABEL_SCHEMA = "flopeek-semantic-suggestion-labels/v1";
const SEMANTIC_SUGGESTION_FEEDBACKS_RELATIVE_PATH = ".flopeek/semantic-suggestion-feedback.json";
const DECISIONS = new Set(["accepted", "edited", "rejected", "abstained"]);

class SemanticSuggestionFeedbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SemanticSuggestionFeedbackError";
    this.code = code;
  }
}

function feedbackPath(root) {
  return path.join(root, SEMANTIC_SUGGESTION_FEEDBACKS_RELATIVE_PATH);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function text(value, name, { required = true, maximum = 2_000 } = {}) {
  if (value === undefined || value === null || typeof value !== "string") {
    if (required) throw new SemanticSuggestionFeedbackError("missing-field", `${name} is required and must be a string.`);
    return null;
  }
  const normalized = value.trim();
  if (required && !normalized) throw new SemanticSuggestionFeedbackError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new SemanticSuggestionFeedbackError("field-too-long", `${name} must be at most ${maximum} characters.`);
  return normalized || null;
}

function optionalText(value, name, maximum) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, { maximum });
}

function candidate(value, name = "editedCandidate") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SemanticSuggestionFeedbackError("invalid-edited-candidate", `${name} must be an object.`);
  const title = text(value.title, `${name}.title`, { maximum: 240 });
  const technicalPurpose = text(value.technicalPurpose, `${name}.technicalPurpose`, { maximum: 4_000 });
  const role = text(value.role, `${name}.role`, { maximum: 120 });
  const grouping = value.grouping;
  if (!grouping || typeof grouping !== "object" || Array.isArray(grouping)) throw new SemanticSuggestionFeedbackError("invalid-edited-candidate", `${name}.grouping is required.`);
  return {
    title,
    technicalPurpose,
    role,
    grouping: {
      key: text(grouping.key, `${name}.grouping.key`, { maximum: 120 }),
      label: text(grouping.label, `${name}.grouping.label`, { maximum: 240 }),
    },
  };
}

function safeSuggestionSnapshot(suggestion) {
  return {
    id: suggestion.id,
    schemaVersion: suggestion.schemaVersion,
    status: suggestion.status,
    flow: {
      id: suggestion.flow.id,
      contextRef: suggestion.flow.contextRef,
      graphVersion: suggestion.flow.graphVersion,
    },
    candidate: suggestion.candidate ? {
      title: suggestion.candidate.title,
      technicalPurpose: suggestion.candidate.technicalPurpose,
      role: suggestion.candidate.role,
      grouping: { ...suggestion.candidate.grouping },
    } : null,
    confidence: { ...suggestion.confidence },
    evidenceRefs: (suggestion.evidenceRefs || []).map((item) => ({ kind: item.kind, ref: item.ref, label: item.label || null })),
    abstention: suggestion.abstention ? {
      code: suggestion.abstention.code,
      reason: suggestion.abstention.reason,
      missingEvidence: [...(suggestion.abstention.missingEvidence || [])],
    } : null,
  };
}

function suggestionFingerprint(suggestion) {
  return fingerprint(safeSuggestionSnapshot(suggestion));
}

function validateSuggestion(suggestion) {
  if (!suggestion || suggestion.schemaVersion !== "flopeek-semantic-flow-suggestion/v1" || !suggestion.flow?.id || !suggestion.flow?.contextRef || !Number.isSafeInteger(suggestion.flow.graphVersion)) {
    throw new SemanticSuggestionFeedbackError("invalid-suggestion", "Semantic feedback requires a current Flopeek semantic suggestion.");
  }
  if (!new Set(["suggested", "abstained"]).has(suggestion.status)) throw new SemanticSuggestionFeedbackError("invalid-suggestion", "Semantic feedback requires a suggested or abstained result.");
}

function normalizeInput(input, suggestion) {
  const decision = text(input?.decision, "decision", { maximum: 40 }).toLowerCase();
  if (!DECISIONS.has(decision)) throw new SemanticSuggestionFeedbackError("invalid-decision", `decision must be one of: ${[...DECISIONS].join(", ")}.`);
  if (suggestion.status === "suggested" && !["accepted", "edited", "rejected"].includes(decision)) throw new SemanticSuggestionFeedbackError("incompatible-decision", "A suggested result may be accepted, edited, or rejected.");
  if (suggestion.status === "abstained" && decision !== "abstained") throw new SemanticSuggestionFeedbackError("incompatible-decision", "An abstained result may only receive an abstained feedback decision.");
  const reason = optionalText(input?.reason, "reason", 2_000);
  if (["edited", "rejected", "abstained"].includes(decision) && !reason) throw new SemanticSuggestionFeedbackError("missing-reason", `${decision} feedback requires a concise reason.`);
  const editedCandidate = input?.editedCandidate === undefined || input?.editedCandidate === null ? null : candidate(input.editedCandidate);
  if (decision === "edited" && !editedCandidate) throw new SemanticSuggestionFeedbackError("missing-edited-candidate", "Edited feedback requires a complete editedCandidate.");
  if (decision !== "edited" && editedCandidate) throw new SemanticSuggestionFeedbackError("unexpected-edited-candidate", "editedCandidate is only allowed for edited feedback.");
  return {
    operationId: text(input?.operationId, "operationId", { maximum: 240 }),
    decision,
    reason,
    editedCandidate,
    reviewedBy: text(input?.reviewedBy, "reviewedBy", { maximum: 240 }),
    traceOperationId: optionalText(input?.traceOperationId, "traceOperationId", 240),
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === SEMANTIC_SUGGESTION_FEEDBACK_SCHEMA
    && value.labelSchemaVersion === SEMANTIC_SUGGESTION_LABEL_SCHEMA
    && typeof value.id === "string" && value.id
    && typeof value.operationId === "string" && value.operationId
    && typeof value.inputFingerprint === "string" && value.inputFingerprint.startsWith("sha256:")
    && value.knowledgeClass === "human-feedback"
    && typeof value.project?.projectId === "string" && value.project.projectId
    && Number.isSafeInteger(value.project.sourceGraphVersion) && value.project.sourceGraphVersion >= 0
    && (value.project.sourceRevision === null || typeof value.project.sourceRevision === "string")
    && typeof value.suggestion?.id === "string" && value.suggestion.id
    && typeof value.suggestion.fingerprint === "string" && value.suggestion.fingerprint.startsWith("sha256:")
    && value.suggestion.snapshot?.flow?.id && value.suggestion.snapshot?.flow?.contextRef
    && DECISIONS.has(value.decision)
    && (value.reason === null || typeof value.reason === "string")
    && (value.editedCandidate === null || Boolean(value.editedCandidate?.title && value.editedCandidate?.technicalPurpose && value.editedCandidate?.role && value.editedCandidate?.grouping?.key && value.editedCandidate?.grouping?.label))
    && typeof value.reviewedBy === "string" && value.reviewedBy
    && (value.traceLink === null || (typeof value.traceLink.operationId === "string" && typeof value.traceLink.recordId === "string" && typeof value.traceLink.verificationStatus === "string"))
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && (value.supersedes === null || typeof value.supersedes === "string")
    && Array.isArray(value.limitations) && value.limitations.every((item) => typeof item === "string");
}

function emptyStore(projectId) {
  return { schemaVersion: SEMANTIC_SUGGESTION_FEEDBACK_STORE_SCHEMA, projectId, records: [] };
}

function readSemanticSuggestionFeedbackStore(root, projectId) {
  const target = feedbackPath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const ids = Array.isArray(store?.records) ? store.records.map((record) => record.id) : [];
    const operationIds = Array.isArray(store?.records) ? store.records.map((record) => record.operationId) : [];
    if (!store || typeof store !== "object" || Array.isArray(store) || store.schemaVersion !== SEMANTIC_SUGGESTION_FEEDBACK_STORE_SCHEMA || store.projectId !== projectId || !Array.isArray(store.records) || !store.records.every(isRecord) || new Set(ids).size !== ids.length || new Set(operationIds).size !== operationIds.length) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-semantic-feedback-store", message: "Semantic suggestion feedback metadata does not match flopeek-semantic-suggestion-feedbacks/v1." }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-semantic-feedback-json", message: `Semantic suggestion feedback metadata is not valid JSON (${error.message}).` }] };
  }
}

function latestRecord(store, flowId) {
  const superseded = new Set(store.records.map((record) => record.supersedes).filter(Boolean));
  return store.records
    .filter((record) => record.suggestion.snapshot.flow.id === flowId && !superseded.has(record.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0] || null;
}

function recordHistory(store, flowId) {
  const superseded = new Set(store.records.map((record) => record.supersedes).filter(Boolean));
  return store.records
    .filter((record) => record.suggestion.snapshot.flow.id === flowId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .map((record) => ({ ...record, lifecycleStatus: superseded.has(record.id) ? "superseded" : "active" }));
}

function recordId(projectId, operationId) {
  const digest = crypto.createHash("sha256").update(`${projectId}\n${operationId}`).digest("hex").slice(0, 32);
  return `semantic-feedback:${digest}`;
}

function traceLink(root, graph, operationId, contextRef) {
  if (!operationId) return null;
  const trace = readAgentEvidenceTraceStore(root, graph.project.projectId);
  if (trace.status === "invalid") throw new SemanticSuggestionFeedbackError("invalid-agent-evidence-trace-store", trace.diagnostics[0].message);
  const record = trace.store.records.find((item) => item.operationId === operationId);
  if (!record) throw new SemanticSuggestionFeedbackError("trace-not-found", "traceOperationId does not identify a local agent evidence trace.");
  if (record.context.ref !== contextRef) throw new SemanticSuggestionFeedbackError("trace-context-mismatch", "The linked agent trace must use the same Flow Context Ref as the reviewed suggestion.");
  return { operationId: record.operationId, recordId: record.id, verificationStatus: record.verification.status };
}

function saveSemanticSuggestionFeedback(root, graph, suggestion, input, options = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new SemanticSuggestionFeedbackError("missing-graph-identity", "Semantic feedback requires a project ID and graph version.");
  validateSuggestion(suggestion);
  const normalized = normalizeInput(input || {}, suggestion);
  const read = readSemanticSuggestionFeedbackStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new SemanticSuggestionFeedbackError("invalid-semantic-feedback-store", read.diagnostics[0].message);
  const store = read.store || emptyStore(graph.project.projectId);
  const inputFingerprint = fingerprint(normalized);
  const existing = store.records.find((record) => record.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new SemanticSuggestionFeedbackError("operation-id-conflict", "operationId already belongs to a different immutable semantic feedback record.");
    return { schemaVersion: "flopeek-semantic-suggestion-feedback-result/v1", created: false, record: existing, path: feedbackPath(root), limitation: "The existing immutable feedback record was returned for this idempotent operationId." };
  }
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new SemanticSuggestionFeedbackError("invalid-created-at", "Semantic feedback createdAt must be an ISO-compatible timestamp.");
  const snapshot = safeSuggestionSnapshot(suggestion);
  const record = {
    schemaVersion: SEMANTIC_SUGGESTION_FEEDBACK_SCHEMA,
    labelSchemaVersion: SEMANTIC_SUGGESTION_LABEL_SCHEMA,
    id: recordId(graph.project.projectId, normalized.operationId),
    operationId: normalized.operationId,
    inputFingerprint,
    knowledgeClass: "human-feedback",
    project: { projectId: graph.project.projectId, sourceGraphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    suggestion: { id: suggestion.id, fingerprint: suggestionFingerprint(suggestion), snapshot },
    decision: normalized.decision,
    reason: normalized.reason,
    editedCandidate: normalized.editedCandidate,
    reviewedBy: normalized.reviewedBy,
    traceLink: traceLink(root, graph, normalized.traceOperationId, suggestion.flow.contextRef),
    createdAt,
    supersedes: latestRecord(store, suggestion.flow.id)?.id || null,
    limitations: [
      "This is human feedback about a deterministic suggestion, not human verification of a business flow, runtime behavior, or test success.",
      "Reasons are concise review outcomes only. Do not submit source contents, credentials, prompts, private reasoning, or raw command logs.",
    ],
  };
  const next = { ...store, records: [...store.records, record] };
  atomicWriteJson(feedbackPath(root), next);
  return { schemaVersion: "flopeek-semantic-suggestion-feedback-result/v1", created: true, record, path: feedbackPath(root), limitation: "Feedback is append-only. A later review creates a superseding record rather than overwriting this one." };
}

function listSemanticSuggestionFeedback(root, graph, options = {}) {
  const read = readSemanticSuggestionFeedbackStore(root, graph.project.projectId);
  const limitValue = Number(options.limit ?? 20);
  const limit = Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 100 ? limitValue : 20;
  const base = { schemaVersion: SEMANTIC_SUGGESTION_FEEDBACK_LIST_SCHEMA, projectId: graph.project.projectId, diagnostics: read.diagnostics };
  if (read.status === "invalid") return { ...base, status: "unavailable", totalMatched: 0, returned: 0, truncated: false, records: [], limitation: read.diagnostics[0].message };
  const flowId = optionalText(options.flowId, "flowId", 4_096);
  const contextRef = optionalText(options.contextRef, "contextRef", 8_192);
  const decision = optionalText(options.decision, "decision", 40)?.toLowerCase() || null;
  const traceOperationId = optionalText(options.traceOperationId, "traceOperationId", 240);
  if (decision && !DECISIONS.has(decision)) throw new SemanticSuggestionFeedbackError("invalid-decision", `decision must be one of: ${[...DECISIONS].join(", ")}.`);
  const matches = read.store.records
    .filter((record) => !flowId || record.suggestion.snapshot.flow.id === flowId)
    .filter((record) => !contextRef || record.suggestion.snapshot.flow.contextRef === contextRef)
    .filter((record) => !decision || record.decision === decision)
    .filter((record) => !traceOperationId || record.traceLink?.operationId === traceOperationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return {
    ...base,
    status: "available",
    totalMatched: matches.length,
    returned: Math.min(matches.length, limit),
    truncated: matches.length > limit,
    records: matches.slice(0, limit),
    limitation: "Feedback records are local human labels for static suggestions. They do not verify business intent, runtime behavior, test success, or model quality.",
  };
}

function feedbackMetrics(records) {
  const decisions = Object.fromEntries([...DECISIONS].map((decision) => [decision, 0]));
  const traces = { linked: 0, byVerificationStatus: {} };
  for (const record of records) {
    decisions[record.decision] += 1;
    if (record.traceLink) {
      traces.linked += 1;
      traces.byVerificationStatus[record.traceLink.verificationStatus] = (traces.byVerificationStatus[record.traceLink.verificationStatus] || 0) + 1;
    }
  }
  const total = records.length;
  return {
    total,
    decisions,
    acceptedRate: decisions.accepted / Math.max(total, 1),
    editedRate: decisions.edited / Math.max(total, 1),
    rejectedRate: decisions.rejected / Math.max(total, 1),
    abstainedRate: decisions.abstained / Math.max(total, 1),
    traceLinked: traces.linked,
    traceLinkedRate: traces.linked / Math.max(total, 1),
    traceVerificationStatuses: traces.byVerificationStatus,
  };
}

function resolveSemanticSuggestionFeedback(root, graph, suggestion) {
  validateSuggestion(suggestion);
  const read = readSemanticSuggestionFeedbackStore(root, graph.project.projectId);
  const base = {
    schemaVersion: SEMANTIC_SUGGESTION_FEEDBACK_RESOLUTION_SCHEMA,
    flowId: suggestion.flow.id,
    suggestionId: suggestion.id,
    currentSuggestionFingerprint: suggestionFingerprint(suggestion),
    sourceGraphVersion: suggestion.flow.graphVersion,
    diagnostics: read.diagnostics,
  };
  if (read.status === "invalid") return { ...base, status: "unavailable", record: null, history: [], reason: read.diagnostics[0].message };
  const record = latestRecord(read.store, suggestion.flow.id);
  const history = recordHistory(read.store, suggestion.flow.id);
  if (!record) return { ...base, status: "unreviewed", record: null, history, reason: "No human feedback exists for this flow's semantic suggestion." };
  if (record.suggestion.id === suggestion.id && record.suggestion.fingerprint === base.currentSuggestionFingerprint) {
    return { ...base, status: "current", record, history, reason: "The latest feedback reviews this exact current deterministic suggestion." };
  }
  return { ...base, status: "stale", record, history, reason: "The latest feedback belongs to an earlier semantic suggestion or graph version and must not be applied automatically." };
}

function semanticSuggestionFeedbackPolicy(root, graph) {
  const listed = listSemanticSuggestionFeedback(root, graph, { limit: 5 });
  const metrics = listed.status === "available" ? feedbackMetrics(listed.records) : feedbackMetrics([]);
  return {
    schemaVersion: "flopeek-semantic-suggestion-feedback-policy/v1",
    status: listed.status,
    storeSchemaVersion: SEMANTIC_SUGGESTION_FEEDBACK_STORE_SCHEMA,
    labelSchemaVersion: SEMANTIC_SUGGESTION_LABEL_SCHEMA,
    decisions: [...DECISIONS],
    recordTool: "record_semantic_suggestion_feedback",
    readTool: "get_semantic_suggestion_feedback",
    totalRecords: listed.totalMatched,
    recentMetrics: metrics,
    recentRecords: listed.records.map((record) => ({ id: record.id, flowId: record.suggestion.snapshot.flow.id, decision: record.decision, traceLinked: Boolean(record.traceLink), reviewedBy: record.reviewedBy, createdAt: record.createdAt })),
    diagnostics: listed.diagnostics,
    limitation: "Feedback is local human labeling for deterministic suggestions only. It never creates human verification and is not a calibrated model-quality dataset until real reviewed data is collected and held out.",
  };
}

module.exports = {
  DECISIONS,
  SEMANTIC_SUGGESTION_FEEDBACK_LIST_SCHEMA,
  SEMANTIC_SUGGESTION_FEEDBACK_RESOLUTION_SCHEMA,
  SEMANTIC_SUGGESTION_FEEDBACK_SCHEMA,
  SEMANTIC_SUGGESTION_FEEDBACK_STORE_SCHEMA,
  SEMANTIC_SUGGESTION_FEEDBACKS_RELATIVE_PATH,
  SEMANTIC_SUGGESTION_LABEL_SCHEMA,
  SemanticSuggestionFeedbackError,
  feedbackMetrics,
  feedbackPath,
  listSemanticSuggestionFeedback,
  readSemanticSuggestionFeedbackStore,
  resolveSemanticSuggestionFeedback,
  saveSemanticSuggestionFeedback,
  semanticSuggestionFeedbackPolicy,
  suggestionFingerprint,
};
