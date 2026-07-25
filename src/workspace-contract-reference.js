"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { registryRoot } = require("./serve-workspace");

const WORKSPACE_CONTRACT_REFERENCE_SCHEMA = "flopeek-workspace-contract-reference/v1";
const WORKSPACE_CONTRACT_STORE_SCHEMA = "flopeek-workspace-contract-references/v1";
const MAX_RECORDS = 1_000;
const UNSAFE_TEXT_PATTERNS = [
  /(?:\b[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/|\/(?:Users|home|mnt\/[A-Za-z])\/)/i,
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:password|passwd|api[_-]?key|access[_-]?token|authorization|secret)\s*[:=]\s*\S+)/i,
  /```|(?:^|[;{}])\s*(?:const|let|var|function|class|import|export)\s+[\w{*]|=>\s*[{(]?/,
];

class WorkspaceContractReferenceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceContractReferenceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function contractStorePath(workspaceId, options = {}) {
  const safe = Buffer.from(workspaceId, "utf8").toString("base64url");
  return path.join(registryRoot(options), `${safe}.contracts.json`);
}

function safeText(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new WorkspaceContractReferenceError("invalid-text", `${label} must be text.`);
  // Reject untrusted text before whitespace normalization so a multi-line source
  // fragment cannot be collapsed into a seemingly harmless single-line value.
  if (/[\r\n\u0000\u2028\u2029]/.test(value)) throw new WorkspaceContractReferenceError("invalid-text", `${label} must be one non-empty line of at most ${maximum} characters.`);
  if (UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(value))) throw new WorkspaceContractReferenceError("unsafe-text", `${label} must not contain credentials, source declarations, or machine paths.`);
  const text = value.trim().replace(/\s+/g, " ");
  if ((!allowEmpty && !text) || text.length > maximum) throw new WorkspaceContractReferenceError("invalid-text", `${label} must be one non-empty line of at most ${maximum} characters.`);
  if (UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(text))) throw new WorkspaceContractReferenceError("unsafe-text", `${label} must not contain credentials, source declarations, or machine paths.`);
  return text;
}

function validSnapshot(value) {
  return exactKeys(value, ["projectId", "flowId", "graphVersion", "contextRef", "title", "method", "route"])
    && typeof value.projectId === "string" && value.projectId
    && typeof value.flowId === "string" && value.flowId
    && Number.isInteger(value.graphVersion) && value.graphVersion >= 0
    && typeof value.contextRef === "string" && value.contextRef.startsWith("fp://local/")
    && typeof value.title === "string" && value.title
    && (value.method === null || typeof value.method === "string")
    && (value.route === null || typeof value.route === "string");
}

function validRecord(value, workspaceId) {
  return exactKeys(value, ["schemaVersion", "id", "operationId", "workspaceId", "kind", "source", "target", "summary", "declaredBy", "declaredAt"])
    && value.schemaVersion === WORKSPACE_CONTRACT_REFERENCE_SCHEMA
    && typeof value.id === "string" && value.id
    && typeof value.operationId === "string" && value.operationId
    && value.workspaceId === workspaceId
    && value.kind === "http-contract"
    && validSnapshot(value.source)
    && validSnapshot(value.target)
    && value.source.projectId !== value.target.projectId
    && typeof value.summary === "string" && value.summary
    && typeof value.declaredBy === "string" && value.declaredBy
    && typeof value.declaredAt === "string" && !Number.isNaN(Date.parse(value.declaredAt));
}

function emptyStore(workspaceId) {
  return { schemaVersion: WORKSPACE_CONTRACT_STORE_SCHEMA, workspaceId, records: [] };
}

function readWorkspaceContractReferences(workspaceId, options = {}) {
  const target = contractStorePath(workspaceId, options);
  if (!fs.existsSync(target)) return { status: "available", store: emptyStore(workspaceId), records: [], path: target };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!exactKeys(store, ["schemaVersion", "workspaceId", "records"]) || store.schemaVersion !== WORKSPACE_CONTRACT_STORE_SCHEMA || store.workspaceId !== workspaceId || !Array.isArray(store.records) || store.records.length > MAX_RECORDS || store.records.some((record) => !validRecord(record, workspaceId))) {
      return { status: "unavailable", reason: "Workspace contract-reference store has an unsupported or unsafe schema and was not reused.", path: target };
    }
    return { status: "available", store, records: store.records, path: target };
  } catch (error) {
    return { status: "unavailable", reason: `Workspace contract-reference store is unreadable (${error.message}).`, path: target };
  }
}

function comparable(record) {
  return JSON.stringify({
    workspaceId: record.workspaceId,
    kind: record.kind,
    source: record.source,
    target: record.target,
    summary: record.summary,
    declaredBy: record.declaredBy,
  });
}

function saveWorkspaceContractReference(workspaceId, input, options = {}) {
  if (!workspaceId || typeof workspaceId !== "string") throw new WorkspaceContractReferenceError("invalid-workspace", "A workspace ID is required.");
  const read = readWorkspaceContractReferences(workspaceId, options);
  if (read.status !== "available") throw new WorkspaceContractReferenceError("unavailable-store", read.reason, 409);
  if (!isObject(input) || !exactKeys(input, ["operationId", "source", "target", "summary", "declaredBy"])) throw new WorkspaceContractReferenceError("invalid-input", "Contract references require only operationId, source, target, summary, and declaredBy.");
  const record = {
    schemaVersion: WORKSPACE_CONTRACT_REFERENCE_SCHEMA,
    id: `workspace-contract:${crypto.randomUUID()}`,
    operationId: safeText(input.operationId, "operationId", 240),
    workspaceId,
    kind: "http-contract",
    source: input.source,
    target: input.target,
    summary: safeText(input.summary, "summary", 2_000),
    declaredBy: safeText(input.declaredBy, "declaredBy", 240),
    declaredAt: new Date().toISOString(),
  };
  if (!validRecord(record, workspaceId)) throw new WorkspaceContractReferenceError("invalid-reference", "Contract reference snapshots are invalid or do not span two different projects.");
  const existing = read.records.find((candidate) => candidate.operationId === record.operationId);
  if (existing) {
    if (comparable(existing) !== comparable(record)) throw new WorkspaceContractReferenceError("operation-conflict", "operationId already belongs to a different contract reference.", 409);
    return { created: false, record: existing, records: read.records };
  }
  if (read.records.length >= MAX_RECORDS) throw new WorkspaceContractReferenceError("record-limit", `Workspace contract references are limited to ${MAX_RECORDS}; no record was dropped.`, 409);
  const records = [...read.records, record];
  fs.mkdirSync(path.dirname(read.path), { recursive: true });
  atomicWriteJson(read.path, { schemaVersion: WORKSPACE_CONTRACT_STORE_SCHEMA, workspaceId, records });
  return { created: true, record, records };
}

function resolveWorkspaceContractReferences(records, resolveSnapshot) {
  return records.map((record) => {
    const source = resolveSnapshot(record.source);
    const target = resolveSnapshot(record.target);
    const status = source.status === "current" && target.status === "current"
      ? "current"
      : source.status === "unavailable" || target.status === "unavailable"
        ? "unavailable"
        : "stale";
    return {
      ...record,
      status,
      sourceResolution: source,
      targetResolution: target,
      limitation: "This is an explicit human-authored workspace contract reference. It is not a graph edge, runtime trace, or automatic cross-project flow.",
    };
  });
}

module.exports = {
  WORKSPACE_CONTRACT_REFERENCE_SCHEMA,
  WORKSPACE_CONTRACT_STORE_SCHEMA,
  WorkspaceContractReferenceError,
  contractStorePath,
  readWorkspaceContractReferences,
  resolveWorkspaceContractReferences,
  saveWorkspaceContractReference,
};
