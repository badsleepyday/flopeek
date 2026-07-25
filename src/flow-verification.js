const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");

const FLOW_VERIFICATION_SCHEMA = "flowpeek-flow-verification/v1";
const FLOW_VERIFICATION_STORE_SCHEMA = "flowpeek-flow-verifications/v1";
const FLOW_VERIFICATIONS_RELATIVE_PATH = ".flowpeek/flow-verifications.json";
const RISK_LEVELS = new Set(["low", "medium", "high", "critical", "unknown"]);

class FlowVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FlowVerificationError";
    this.code = code;
  }
}

function verificationPath(root) {
  return path.join(root, FLOW_VERIFICATIONS_RELATIVE_PATH);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function text(value, name, { required = false, maximum = 2_000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new FlowVerificationError("missing-field", `${name} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new FlowVerificationError("invalid-field", `${name} must be a string.`);
  const normalized = value.trim();
  if (required && !normalized) throw new FlowVerificationError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new FlowVerificationError("field-too-long", `${name} must be at most ${maximum} characters.`);
  return normalized || null;
}

function questions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new FlowVerificationError("invalid-questions", "questions must be an array with at most 20 items.");
  return value.map((item, index) => text(item, `questions[${index}]`, { maximum: 800 })).filter(Boolean);
}

function sourcePaths(lens) {
  return [...new Set((lens.steps || []).map((step) => step.node?.path).filter(Boolean))].sort();
}

function technicalFingerprint(lens) {
  return fingerprint({
    flow: { id: lens.flow.id, entryId: lens.flow.entryId, title: lens.flow.title },
    steps: (lens.steps || []).map((step) => ({
      id: step.id,
      depth: step.depth,
      role: step.role,
      node: { type: step.node?.type || null, kind: step.node?.kind || null, path: step.node?.path || null },
      transition: step.transition ? { id: step.transition.id, sourceId: step.transition.sourceId, targetId: step.transition.targetId, type: step.transition.type } : null,
      alternatives: (step.alternativeIncomingTransitions || []).map((transition) => transition.id).sort(),
      boundary: step.staticBoundary || null,
    })),
    truncation: {
      displayTruncated: Boolean(lens.truncation?.displayTruncated),
      sourceTraversalMayBeTruncated: Boolean(lens.truncation?.sourceTraversalMayBeTruncated),
      missingTransitionEvidence: [...(lens.truncation?.missingTransitionEvidence || [])].sort(),
    },
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === FLOW_VERIFICATION_SCHEMA
    && typeof value.id === "string" && value.id
    && typeof value.flowId === "string" && value.flowId
    && typeof value.flowContextRef === "string" && value.flowContextRef
    && typeof value.title === "string" && value.title
    && typeof value.description === "string" && value.description
    && (value.owner === null || typeof value.owner === "string")
    && RISK_LEVELS.has(value.risk)
    && Array.isArray(value.questions) && value.questions.every((question) => typeof question === "string")
    && typeof value.verifiedBy === "string" && value.verifiedBy
    && typeof value.verifiedAt === "string" && !Number.isNaN(Date.parse(value.verifiedAt))
    && Number.isSafeInteger(value.sourceGraphVersion) && value.sourceGraphVersion >= 0
    && typeof value.technicalFingerprint === "string" && value.technicalFingerprint.startsWith("sha256:")
    && Array.isArray(value.sourcePaths) && value.sourcePaths.every((item) => typeof item === "string")
    && (value.supersedes === null || typeof value.supersedes === "string");
}

function emptyStore(projectId) {
  return { schemaVersion: FLOW_VERIFICATION_STORE_SCHEMA, projectId, records: [] };
}

function readFlowVerificationStore(root, projectId) {
  const target = verificationPath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!store || typeof store !== "object" || Array.isArray(store) || store.schemaVersion !== FLOW_VERIFICATION_STORE_SCHEMA || store.projectId !== projectId || !Array.isArray(store.records) || !store.records.every(isRecord)) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-verification-store", message: "Flow verification metadata does not match flowpeek-flow-verifications/v1." }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-verification-json", message: `Flow verification metadata is not valid JSON (${error.message}).` }] };
  }
}

function latestRecord(store, flowId) {
  const superseded = new Set(store.records.map((record) => record.supersedes).filter(Boolean));
  return store.records
    .filter((record) => record.flowId === flowId && !superseded.has(record.id))
    .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt) || right.id.localeCompare(left.id))[0] || null;
}

function recordHistory(store, flowId) {
  const superseded = new Set(store.records.map((record) => record.supersedes).filter(Boolean));
  return store.records
    .filter((record) => record.flowId === flowId)
    .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt) || right.id.localeCompare(left.id))
    .map((record) => ({ ...record, lifecycleStatus: superseded.has(record.id) ? "superseded" : "active" }));
}

function createRecord(graph, lens, input, store, options = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new FlowVerificationError("missing-graph-identity", "A flow verification requires graph identity.");
  if (!lens?.flow?.id || !lens?.flow?.contextRef) throw new FlowVerificationError("missing-flow", "A flow verification requires a current Flow Lens.");
  const risk = String(input.risk || "unknown").trim().toLowerCase();
  if (!RISK_LEVELS.has(risk)) throw new FlowVerificationError("invalid-risk", "risk must be low, medium, high, critical, or unknown.");
  const previous = latestRecord(store, lens.flow.id);
  const now = options.now || new Date().toISOString();
  const id = options.id || `flow-verification:${crypto.randomUUID()}`;
  return {
    schemaVersion: FLOW_VERIFICATION_SCHEMA,
    id,
    flowId: lens.flow.id,
    flowContextRef: lens.flow.contextRef,
    title: text(input.title, "title", { required: true, maximum: 240 }),
    description: text(input.description, "description", { required: true, maximum: 4_000 }),
    owner: text(input.owner, "owner", { maximum: 240 }),
    risk,
    questions: questions(input.questions),
    verifiedBy: text(input.verifiedBy, "verifiedBy", { required: true, maximum: 240 }),
    verifiedAt: now,
    sourceGraphVersion: graph.state.graphVersion,
    technicalFingerprint: technicalFingerprint(lens),
    sourcePaths: sourcePaths(lens),
    supersedes: previous?.id || null,
  };
}

function saveFlowVerification(root, graph, lens, input, options = {}) {
  const read = readFlowVerificationStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new FlowVerificationError("invalid-verification-store", read.diagnostics[0].message);
  const store = read.store || emptyStore(graph.project.projectId);
  const record = createRecord(graph, lens, input || {}, store, options);
  const next = { ...store, records: [...store.records, record] };
  atomicWriteJson(verificationPath(root), next);
  return { record, store: next, path: verificationPath(root) };
}

function changeReason(delta, record) {
  const changedPaths = new Set(delta.changedPaths || []);
  const changedPath = record.sourcePaths.find((sourcePath) => changedPaths.has(sourcePath));
  if (changedPath) return `A source file participating in this verified flow changed: ${changedPath}.`;
  const changedFlow = [delta.flows?.added, delta.flows?.changed, delta.flows?.removed].flat().find((flow) => flow.id === record.flowId);
  if (changedFlow) return "The detected static flow changed in a retained adjacent graph delta.";
  const affectedFlow = (delta.affectedContexts?.flows || []).find((item) => item.flow?.id === record.flowId);
  if (affectedFlow) return "The flow was affected by a retained adjacent graph delta.";
  return null;
}

function resolveFlowVerification(root, graph, lens, options = {}) {
  const read = readFlowVerificationStore(root, graph.project.projectId);
  if (read.status === "invalid") {
    return { schemaVersion: "flowpeek-flow-verification-resolution/v1", status: "unavailable", record: null, history: [], sourceGraphVersion: null, currentGraphVersion: graph.state.graphVersion, reason: read.diagnostics[0].message, diagnostics: read.diagnostics };
  }
  const record = latestRecord(read.store, lens.flow.id);
  const history = recordHistory(read.store, lens.flow.id);
  const base = {
    schemaVersion: "flowpeek-flow-verification-resolution/v1",
    record,
    history,
    sourceGraphVersion: record?.sourceGraphVersion ?? null,
    currentGraphVersion: graph.state.graphVersion,
    diagnostics: [],
  };
  if (!record) return { ...base, status: "unverified", reason: "No flow-level human verification record exists." };
  if (record.sourceGraphVersion === graph.state.graphVersion) {
    return technicalFingerprint(lens) === record.technicalFingerprint
      ? { ...base, status: "current", reason: "The verification matches the current static graph version." }
      : { ...base, status: "stale", reason: "The current Flow Lens no longer matches the static evidence fingerprint captured at verification." };
  }
  if (record.sourceGraphVersion > graph.state.graphVersion) return { ...base, status: "indeterminate", reason: "The verification references a graph version newer than the current local graph." };
  for (let version = record.sourceGraphVersion + 1; version <= graph.state.graphVersion; version += 1) {
    const delta = options.readDelta?.(version - 1, version) || null;
    if (!delta) return { ...base, status: "indeterminate", reason: "The retained adjacent delta history is incomplete, so Flowpeek cannot prove whether this verification remains compatible." };
    const reason = changeReason(delta, record);
    if (reason) return { ...base, status: "stale", reason };
  }
  return technicalFingerprint(lens) === record.technicalFingerprint
    ? { ...base, status: "compatible", reason: "Later graph versions have retained complete adjacent delta evidence with no change to this flow or its participating source paths." }
    : { ...base, status: "stale", reason: "The current Flow Lens no longer matches the static evidence fingerprint captured at verification." };
}

function resolveDetachedFlowVerification(root, graph, flowId) {
  const read = readFlowVerificationStore(root, graph.project.projectId);
  if (read.status === "invalid") {
    return { schemaVersion: "flowpeek-flow-verification-resolution/v1", status: "unavailable", record: null, history: [], sourceGraphVersion: null, currentGraphVersion: graph.state.graphVersion, reason: read.diagnostics[0].message, diagnostics: read.diagnostics };
  }
  const record = latestRecord(read.store, flowId);
  const history = recordHistory(read.store, flowId);
  return record
    ? { schemaVersion: "flowpeek-flow-verification-resolution/v1", status: "detached", record, history, sourceGraphVersion: record.sourceGraphVersion, currentGraphVersion: graph.state.graphVersion, reason: "The verified flow is not present in the current static graph.", diagnostics: [] }
    : { schemaVersion: "flowpeek-flow-verification-resolution/v1", status: "unverified", record: null, history: [], sourceGraphVersion: null, currentGraphVersion: graph.state.graphVersion, reason: "No flow-level human verification record exists.", diagnostics: [] };
}

function getFlowVerificationHistory(root, graph, flowId) {
  const read = readFlowVerificationStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-flow-verification-history/v1", status: "unavailable", flowId, records: [], diagnostics: read.diagnostics };
  return { schemaVersion: "flowpeek-flow-verification-history/v1", status: "available", flowId, records: recordHistory(read.store, flowId), diagnostics: [] };
}

module.exports = {
  FLOW_VERIFICATION_SCHEMA,
  FLOW_VERIFICATION_STORE_SCHEMA,
  FLOW_VERIFICATIONS_RELATIVE_PATH,
  FlowVerificationError,
  createRecord,
  getFlowVerificationHistory,
  readFlowVerificationStore,
  resolveDetachedFlowVerification,
  resolveFlowVerification,
  saveFlowVerification,
  technicalFingerprint,
  verificationPath,
};
