"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseContextRef } = require("./context-card");
const { atomicWriteJson } = require("./graph-cache");

const RUNTIME_EVIDENCE_SCHEMA = "flowpeek-runtime-evidence/v1";
const RUNTIME_EVIDENCE_STORE_SCHEMA = "flowpeek-runtime-evidence-store/v1";
const RUNTIME_EVIDENCE_RELATIVE_PATH = ".flowpeek/runtime-evidence/records.json";
const MAX_RETAINED_RECORDS = 100;
const MAX_RETAINED_MANIFESTS = 500;
const KINDS = new Set(["request-observation", "test-result", "deployment-observation", "manual-observation"]);
const OUTCOMES = new Set(["succeeded", "failed", "unknown"]);

class RuntimeEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeEvidenceError";
    this.code = code;
    this.statusCode = 400;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key]) ]));
}

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function onlyKnownKeys(value, allowed) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function sourceBasis(graph) {
  const revision = graph.state?.sourceRevision || null;
  const sourceFingerprint = graph.state?.sourceFingerprint || null;
  if (revision && graph.project?.git?.dirty === false) return { kind: "git-revision", value: revision, gitRevision: revision, sourceFingerprint };
  if (sourceFingerprint) return { kind: "working-tree-fingerprint", value: sourceFingerprint, gitRevision: revision, sourceFingerprint };
  return { kind: "unavailable", value: null, gitRevision: revision, sourceFingerprint: null };
}

function conciseText(value, name, { required = false, maximum = 1200 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RuntimeEvidenceError("missing-field", `${name} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new RuntimeEvidenceError("invalid-field", `${name} must be a string.`);
  if (/[\r\n\u0000]/.test(value)) throw new RuntimeEvidenceError("unsafe-runtime-evidence-text", `${name} must be a concise single-line observation, not a source, log, or trace body.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (required && !normalized) throw new RuntimeEvidenceError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new RuntimeEvidenceError("field-too-long", `${name} must be at most ${maximum} characters.`);
  if (!normalized) return null;
  const unsafe = [
    /(?:\b[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/|\/(?:Users|home|mnt\/[A-Za-z])\/)/i,
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+)/i,
    /```|(?:^|[;{}])\s*(?:const|let|var|function|class|import|export)\s+[\w{*]|=>\s*[{(]?/,
  ].find((pattern) => pattern.test(normalized));
  if (unsafe) throw new RuntimeEvidenceError("unsafe-runtime-evidence-text", `${name} contains source-, credential-, or machine-specific text that cannot be stored.`);
  return normalized;
}

function integer(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RuntimeEvidenceError("invalid-number", `${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function parseSubject(ref, graph) {
  const value = conciseText(ref, "subjectRef", { required: true, maximum: 8192 });
  let parsed;
  try { parsed = parseContextRef(value); } catch (error) { throw new RuntimeEvidenceError(error.code || "invalid-context-ref", `subjectRef is invalid: ${error.message}`); }
  if (parsed.projectId !== graph.project.projectId) throw new RuntimeEvidenceError("wrong-project-id", "subjectRef belongs to another project.");
  if (!new Set(["node", "flow"]).has(parsed.kind)) throw new RuntimeEvidenceError("unsupported-context-kind", "subjectRef must reference a node or flow.");
  if (parsed.graphVersion > graph.state.graphVersion) throw new RuntimeEvidenceError("future-graph-version", "subjectRef targets a future graph version.");
  return value;
}

function normalizeInput(input, graph) {
  if (!onlyKnownKeys(input, ["operationId", "subjectRef", "kind", "outcome", "observedAt", "summary", "source", "statusCode", "durationMs"])) {
    throw new RuntimeEvidenceError("unknown-runtime-evidence-field", "Runtime evidence accepts only documented observation fields.");
  }
  const kind = conciseText(input?.kind, "kind", { required: true, maximum: 80 });
  const outcome = conciseText(input?.outcome, "outcome", { required: true, maximum: 40 });
  if (!KINDS.has(kind)) throw new RuntimeEvidenceError("invalid-runtime-evidence-kind", `kind must be one of: ${[...KINDS].join(", ")}.`);
  if (!OUTCOMES.has(outcome)) throw new RuntimeEvidenceError("invalid-runtime-evidence-outcome", `outcome must be one of: ${[...OUTCOMES].join(", ")}.`);
  const observedAt = conciseText(input?.observedAt, "observedAt", { required: true, maximum: 80 });
  if (Number.isNaN(Date.parse(observedAt))) throw new RuntimeEvidenceError("invalid-observed-at", "observedAt must be an ISO-compatible timestamp.");
  const statusCode = integer(input?.statusCode, "statusCode", { minimum: 100, maximum: 599 });
  const durationMs = integer(input?.durationMs, "durationMs", { minimum: 0, maximum: 86_400_000 });
  return {
    operationId: conciseText(input?.operationId, "operationId", { required: true, maximum: 240 }),
    subjectRef: parseSubject(input?.subjectRef, graph),
    kind,
    outcome,
    observedAt,
    summary: conciseText(input?.summary, "summary", { required: true, maximum: 1200 }),
    source: conciseText(input?.source, "source", { required: true, maximum: 240 }),
    statusCode,
    durationMs,
  };
}

function validRecord(record) {
  return onlyKnownKeys(record, ["schemaVersion", "operationId", "inputFingerprint", "projectIdentity", "sourceBasis", "graphVersion", "evidenceClass", "subjectRef", "kind", "outcome", "observedAt", "summary", "source", "statusCode", "durationMs", "createdAt", "policy", "id"])
    && onlyKnownKeys(record.projectIdentity, ["projectId"])
    && onlyKnownKeys(record.sourceBasis, ["kind", "value", "gitRevision", "sourceFingerprint"])
    && onlyKnownKeys(record.policy, ["optIn", "sourceBodies", "rawLogs", "credentials", "machinePaths"])
    && record?.schemaVersion === RUNTIME_EVIDENCE_SCHEMA
    && typeof record.id === "string" && record.id
    && typeof record.operationId === "string" && record.operationId
    && typeof record.inputFingerprint === "string" && record.inputFingerprint.startsWith("sha256:")
    && typeof record.projectIdentity?.projectId === "string" && record.projectIdentity.projectId
    && record.sourceBasis && typeof record.sourceBasis.sourceFingerprint === "string"
    && Number.isSafeInteger(record.graphVersion)
    && record.evidenceClass === "runtime-evidence"
    && typeof record.subjectRef === "string" && record.subjectRef.startsWith("fp://local/")
    && KINDS.has(record.kind)
    && OUTCOMES.has(record.outcome)
    && typeof record.observedAt === "string" && !Number.isNaN(Date.parse(record.observedAt))
    && typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
    && typeof record.summary === "string" && record.summary
    && typeof record.source === "string" && record.source
    && (record.statusCode === null || Number.isSafeInteger(record.statusCode))
    && (record.durationMs === null || Number.isSafeInteger(record.durationMs));
}

function validManifest(manifest) {
  return onlyKnownKeys(manifest, ["schemaVersion", "id", "projectIdentity", "sourceFingerprint", "graphVersion", "evidenceClass", "contentHash", "createdAt", "artifactStatus"])
    && onlyKnownKeys(manifest.projectIdentity, ["projectId"])
    && manifest?.schemaVersion === "flowpeek-runtime-evidence-manifest/v1"
    && typeof manifest.id === "string" && manifest.id
    && typeof manifest.projectIdentity?.projectId === "string" && manifest.projectIdentity.projectId
    && typeof manifest.sourceFingerprint === "string"
    && Number.isSafeInteger(manifest.graphVersion)
    && manifest.evidenceClass === "runtime-evidence"
    && typeof manifest.contentHash === "string" && manifest.contentHash.startsWith("sha256:")
    && typeof manifest.createdAt === "string" && !Number.isNaN(Date.parse(manifest.createdAt))
    && manifest.artifactStatus === "expired";
}

function readStore(root, projectId) {
  const target = path.join(root, RUNTIME_EVIDENCE_RELATIVE_PATH);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: { schemaVersion: RUNTIME_EVIDENCE_STORE_SCHEMA, projectId, records: [], manifests: [] }, diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!store || typeof store !== "object" || Array.isArray(store) || store.schemaVersion !== RUNTIME_EVIDENCE_STORE_SCHEMA || store.projectId !== projectId || !Array.isArray(store.records) || !Array.isArray(store.manifests)
      || !store.records.every(validRecord) || !store.manifests.every(validManifest)
      || new Set(store.records.map((item) => item.id)).size !== store.records.length || new Set(store.records.map((item) => item.operationId)).size !== store.records.length) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-runtime-evidence-store", message: "Runtime evidence store does not match its versioned schema." }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-runtime-evidence-json", message: `Runtime evidence store is not valid JSON (${error.message}).` }] };
  }
}

function freshness(record, graph) {
  if (record.projectIdentity?.projectId !== graph.project.projectId) return "unavailable";
  return record.graphVersion === graph.state.graphVersion && record.sourceBasis?.sourceFingerprint === graph.state.sourceFingerprint ? "current" : "stale";
}

function manifest(record, createdAt) {
  return {
    schemaVersion: "flowpeek-runtime-evidence-manifest/v1",
    id: record.id,
    projectIdentity: record.projectIdentity,
    sourceFingerprint: record.sourceBasis.sourceFingerprint,
    graphVersion: record.graphVersion,
    evidenceClass: "runtime-evidence",
    contentHash: fingerprint(record),
    createdAt,
    artifactStatus: "expired",
  };
}

function saveRuntimeEvidence(root, graph, input, options = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new RuntimeEvidenceError("missing-graph-identity", "Runtime evidence requires project identity and graph version.");
  const normalized = normalizeInput(input || {}, graph);
  const read = readStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new RuntimeEvidenceError("invalid-runtime-evidence-store", read.diagnostics[0].message);
  const inputFingerprint = fingerprint(normalized);
  const existing = read.store.records.find((record) => record.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new RuntimeEvidenceError("operation-id-conflict", "operationId already belongs to different immutable runtime evidence.");
    return { schemaVersion: "flowpeek-runtime-evidence-result/v1", created: false, record: existing, retention: { maxRecords: MAX_RETAINED_RECORDS, manifestsRetained: read.store.manifests.length } };
  }
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new RuntimeEvidenceError("invalid-created-at", "createdAt must be an ISO-compatible timestamp.");
  const base = {
    schemaVersion: RUNTIME_EVIDENCE_SCHEMA,
    operationId: normalized.operationId,
    inputFingerprint,
    projectIdentity: { projectId: graph.project.projectId },
    sourceBasis: sourceBasis(graph),
    graphVersion: graph.state.graphVersion,
    evidenceClass: "runtime-evidence",
    ...normalized,
    createdAt,
    policy: { optIn: true, sourceBodies: "excluded", rawLogs: "excluded", credentials: "excluded", machinePaths: "excluded" },
  };
  const record = { ...base, id: `runtime-evidence:${fingerprint(base).slice(7, 39)}` };
  const all = [...read.store.records, record].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const expired = all.slice(0, Math.max(all.length - MAX_RETAINED_RECORDS, 0));
  const records = all.slice(expired.length);
  const manifests = [...read.store.manifests, ...expired.map((item) => manifest(item, createdAt))].slice(-MAX_RETAINED_MANIFESTS);
  atomicWriteJson(read.path, { ...read.store, records, manifests });
  return { schemaVersion: "flowpeek-runtime-evidence-result/v1", created: true, record, retention: { maxRecords: MAX_RETAINED_RECORDS, expiredThisWrite: expired.map((item) => item.id), manifestsRetained: manifests.length } };
}

function listRuntimeEvidence(root, graph, options = {}) {
  const read = readStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-runtime-evidence-list/v1", status: "unavailable", records: [], manifests: [], diagnostics: read.diagnostics };
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit, MAX_RETAINED_RECORDS)) : 30;
  const all = [...read.store.records].sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id));
  const records = all.slice(0, limit).map((record) => ({ ...record, freshnessStatus: freshness(record, graph) }));
  return {
    schemaVersion: "flowpeek-runtime-evidence-list/v1",
    status: "available",
    projectIdentity: { projectId: graph.project.projectId },
    graphVersion: graph.state.graphVersion,
    records,
    manifests: read.store.manifests.map((item) => ({ ...item, freshnessStatus: freshness(item, graph) })),
    catalog: { total: all.length, returned: records.length, omitted: Math.max(all.length - records.length, 0), truncated: all.length > records.length, omittedIds: all.slice(records.length).map((item) => item.id) },
    retention: { maxRecords: MAX_RETAINED_RECORDS, maxManifests: MAX_RETAINED_MANIFESTS, manifestsRetained: read.store.manifests.length },
    diagnostics: [],
  };
}

function runtimeEvidenceSummary(root, graph) {
  const listed = listRuntimeEvidence(root, graph, { limit: 30 });
  if (listed.status !== "available") return { status: "unavailable", evidenceClass: "runtime-evidence", graphVersion: graph.state.graphVersion, reason: listed.diagnostics[0]?.message || "Runtime evidence store is unavailable." };
  if (!listed.records.length) return { status: "unavailable", evidenceClass: "runtime-evidence", graphVersion: graph.state.graphVersion, reason: "No opt-in sanitized runtime evidence store has recorded evidence.", retention: listed.retention };
  return {
    status: "available",
    evidenceClass: "runtime-evidence",
    graphVersion: graph.state.graphVersion,
    current: listed.records.filter((item) => item.freshnessStatus === "current").length,
    stale: listed.records.filter((item) => item.freshnessStatus === "stale").length,
    retained: listed.catalog.total,
    expiredManifests: listed.manifests.length,
    retention: listed.retention,
    limitation: "Runtime evidence is caller-supplied sanitized observation metadata. It does not alter static graph facts or prove unrecorded behavior.",
  };
}

module.exports = { MAX_RETAINED_MANIFESTS, MAX_RETAINED_RECORDS, RUNTIME_EVIDENCE_SCHEMA, RUNTIME_EVIDENCE_STORE_SCHEMA, RuntimeEvidenceError, listRuntimeEvidence, runtimeEvidenceSummary, saveRuntimeEvidence };
