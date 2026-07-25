"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createContextRef, parseContextRef } = require("./context-card");
const { sourceBasis } = require("./durable-brief");
const { atomicWriteJson } = require("./graph-cache");
const { runtimeEvidenceSummary } = require("./runtime-evidence");

const HANDOFF_WORKSPACE_SCHEMA = "flowpeek-handoff-workspace/v1";
const HANDOFF_WORKSPACES_SCHEMA = "flowpeek-handoff-workspaces/v1";
const HANDOFF_NOTE_SCHEMA = "flowpeek-handoff-note/v1";
const HANDOFF_NOTES_SCHEMA = "flowpeek-handoff-notes/v1";
const HANDOFF_EXPORT_SCHEMA = "flowpeek-handoff-export/v1";
const HANDOFF_MARKDOWN_SCHEMA = "flowpeek-handoff-markdown/v1";
const HANDOFF_IMPORT_SCHEMA = "flowpeek-handoff-import/v1";
const HANDOFF_IMPORTS_SCHEMA = "flowpeek-handoff-imports/v1";
const HANDOFF_WORKSPACES_RELATIVE_PATH = ".flowpeek/handoff/workspaces.json";
const HANDOFF_NOTES_RELATIVE_PATH = ".flowpeek/handoff/notes.json";
const HANDOFF_IMPORTS_RELATIVE_PATH = ".flowpeek/handoff/imports.json";
const HANDOFF_IMPORT_ARTIFACTS_RELATIVE_PATH = ".flowpeek/handoff/imports";
const NOTE_SUBJECT_KINDS = new Set(["project", "feature", "flow", "node", "decision", "risk", "question", "general"]);
const TEXT_SECTIONS = Object.freeze({
  owners: 40,
  risks: 80,
  decisions: 80,
  knownLimitations: 80,
  unresolvedQuestions: 80,
});

class HandoffWorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HandoffWorkspaceError";
    this.code = code;
    this.statusCode = 400;
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

function portableText(value, name, { required = false, maximum = 2000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HandoffWorkspaceError("missing-field", `${name} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new HandoffWorkspaceError("invalid-field", `${name} must be a string.`);
  if (/[\r\n]/.test(value)) throw new HandoffWorkspaceError("unsafe-source-body-like-text", `${name} must be a concise single-line statement, not a source or log body.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (required && !normalized) throw new HandoffWorkspaceError("missing-field", `${name} is required.`);
  if (normalized.length > maximum) throw new HandoffWorkspaceError("field-too-long", `${name} must be at most ${maximum} characters.`);
  if (!normalized) return null;
  const unsafePatterns = [
    { code: "machine-path", pattern: /(?:\b[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/|\/(?:Users|home|mnt\/[A-Za-z])\/)/i },
    { code: "credential-like-text", pattern: /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+)/i },
    { code: "source-body-like-text", pattern: /```|\u0000|(?:^|[;{}])\s*(?:const|let|var|function|class|import|export)\s+[\w{*]|=>\s*[{(]?/ },
  ];
  const unsafe = unsafePatterns.find((item) => item.pattern.test(normalized));
  if (unsafe) throw new HandoffWorkspaceError(`unsafe-${unsafe.code}`, `${name} contains ${unsafe.code.replaceAll("-", " ")} that cannot be stored in a portable handoff.`);
  return normalized;
}

function textList(value, name, maximumItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) throw new HandoffWorkspaceError("invalid-list", `${name} must be an array with at most ${maximumItems} items.`);
  return value.map((item, index) => portableText(item, `${name}[${index}]`, { required: true }));
}

function idList(value, name, maximumItems = 100) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) throw new HandoffWorkspaceError("invalid-list", `${name} must be an array with at most ${maximumItems} IDs.`);
  return [...new Set(value.map((item, index) => portableText(item, `${name}[${index}]`, { required: true, maximum: 8192 })))];
}

function portableRepositoryPath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) return null;
  return normalized;
}

function storePath(root, relativePath) {
  return path.join(root, relativePath);
}

function validWorkspaceRecord(record) {
  return record?.schemaVersion === HANDOFF_WORKSPACE_SCHEMA
    && typeof record.id === "string" && record.id
    && typeof record.operationId === "string" && record.operationId
    && typeof record.inputFingerprint === "string" && record.inputFingerprint.startsWith("sha256:")
    && typeof record.projectIdentity?.projectId === "string" && record.projectIdentity.projectId
    && Number.isSafeInteger(record.graphVersion)
    && record.evidenceClass === "human-authored"
    && typeof record.author === "string" && record.author
    && typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
    && (record.supersedes === null || typeof record.supersedes === "string")
    && record.content && typeof record.content === "object"
    && Array.isArray(record.content.criticalFlows)
    && Array.isArray(record.content.owners)
    && Array.isArray(record.content.risks)
    && Array.isArray(record.content.decisions)
    && Array.isArray(record.content.knownLimitations)
    && Array.isArray(record.content.unresolvedQuestions)
    && Array.isArray(record.content.relatedTests)
    && Array.isArray(record.content.recommendedStartingPoints);
}

function validNoteRecord(record) {
  return record?.schemaVersion === HANDOFF_NOTE_SCHEMA
    && typeof record.id === "string" && record.id
    && typeof record.operationId === "string" && record.operationId
    && typeof record.inputFingerprint === "string" && record.inputFingerprint.startsWith("sha256:")
    && typeof record.workspaceId === "string" && record.workspaceId
    && typeof record.projectIdentity?.projectId === "string" && record.projectIdentity.projectId
    && Number.isSafeInteger(record.graphVersion)
    && record.evidenceClass === "human-authored"
    && NOTE_SUBJECT_KINDS.has(record.subject?.kind)
    && (record.subject.id === null || typeof record.subject.id === "string")
    && typeof record.body === "string" && record.body
    && typeof record.author === "string" && record.author
    && typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
    && (record.supersedes === null || typeof record.supersedes === "string");
}

function validImportRecord(record) {
  return record?.schemaVersion === HANDOFF_IMPORT_SCHEMA
    && typeof record.id === "string" && record.id
    && typeof record.contentHash === "string" && record.contentHash.startsWith("sha256:")
    && typeof record.originProjectIdentity?.projectId === "string" && record.originProjectIdentity.projectId
    && typeof record.localProjectIdentity?.projectId === "string" && record.localProjectIdentity.projectId
    && typeof record.importedAt === "string" && !Number.isNaN(Date.parse(record.importedAt))
    && record.access === "read-only"
    && record.trust === "foreign-unverified"
    && record.verificationStatus === "not-adopted"
    && typeof record.artifact?.relativePath === "string"
    && !path.isAbsolute(record.artifact.relativePath)
    && !record.artifact.relativePath.split(/[\\/]/).includes("..");
}

function recordValidator(schemaVersion) {
  if (schemaVersion === HANDOFF_WORKSPACES_SCHEMA) return validWorkspaceRecord;
  if (schemaVersion === HANDOFF_NOTES_SCHEMA) return validNoteRecord;
  if (schemaVersion === HANDOFF_IMPORTS_SCHEMA) return validImportRecord;
  return () => false;
}

function readStore(root, relativePath, schemaVersion, projectId) {
  const target = storePath(root, relativePath);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: { schemaVersion, projectId, records: [] }, diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    const ids = Array.isArray(store?.records) ? store.records.map((record) => record.id) : [];
    const operationIds = schemaVersion === HANDOFF_IMPORTS_SCHEMA || !Array.isArray(store?.records) ? [] : store.records.map((record) => record.operationId);
    if (!store || typeof store !== "object" || Array.isArray(store) || store.schemaVersion !== schemaVersion || store.projectId !== projectId || !Array.isArray(store.records)
      || !store.records.every(recordValidator(schemaVersion)) || new Set(ids).size !== ids.length || (operationIds.length && new Set(operationIds).size !== operationIds.length)) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-handoff-store", message: `Handoff store does not match ${schemaVersion}.` }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-handoff-json", message: `Handoff store is not valid JSON (${error.message}).` }] };
  }
}

function currentRecord(records) {
  const superseded = new Set(records.map((record) => record.supersedes).filter(Boolean));
  return records.filter((record) => !superseded.has(record.id)).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0] || null;
}

function lifecycleRecords(records) {
  const superseded = new Set(records.map((record) => record.supersedes).filter(Boolean));
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .map((record) => ({ ...record, lifecycleStatus: superseded.has(record.id) ? "superseded" : "active" }));
}

function statement(text, section, author, graph, createdAt, refs = []) {
  if (!text) return { status: "unavailable", section, evidenceClass: "human-authored", graphVersion: graph.state.graphVersion, reason: "No human-authored statement has been recorded." };
  const base = { status: "available", section, text, evidenceClass: "human-authored", graphVersion: graph.state.graphVersion, evidenceRefs: refs, author, createdAt };
  return { ...base, id: `handoff-statement:${fingerprint(base).slice(7, 39)}` };
}

function flowSelections(graph, ids, author, createdAt) {
  const flows = new Map((graph.flows || []).map((flow) => [flow.id, flow]));
  return ids.map((id, index) => {
    const flow = flows.get(id);
    if (!flow) throw new HandoffWorkspaceError("flow-not-found", `criticalFlowIds[${index}] does not identify a current application flow.`);
    const ref = createContextRef(graph.project.projectId, "flow", flow.id, graph.state.graphVersion);
    return {
      flow: { id: flow.id, title: flow.title, entryId: flow.entryId, contextRef: ref, evidenceClass: "static-parser-fact", graphVersion: graph.state.graphVersion },
      selection: statement(`Selected as a critical flow: ${flow.title}.`, "criticalFlows", author, graph, createdAt, [ref]),
    };
  });
}

function testSelections(graph, ids, author, createdAt) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return ids.map((id, index) => {
    const node = nodes.get(id);
    if (!node || (node.type !== "test" && node.kind !== "test")) throw new HandoffWorkspaceError("test-not-found", `relatedTestIds[${index}] does not identify a current test node.`);
    const ref = createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion);
    return {
      test: { id: node.id, label: node.label, path: portableRepositoryPath(node.path), contextRef: ref, evidenceClass: "static-parser-fact", graphVersion: graph.state.graphVersion },
      selection: statement(`Selected as a related test: ${node.label}.`, "relatedTests", author, graph, createdAt, [ref]),
    };
  });
}

function startingPointSelections(graph, refs, author, createdAt) {
  return refs.map((ref, index) => {
    let parsed;
    try { parsed = parseContextRef(ref); } catch (error) { throw new HandoffWorkspaceError(error.code || "invalid-context-ref", `recommendedStartingPointRefs[${index}] is invalid: ${error.message}`); }
    if (parsed.projectId !== graph.project.projectId) throw new HandoffWorkspaceError("wrong-project-id", `recommendedStartingPointRefs[${index}] belongs to another project.`);
    if (parsed.graphVersion > graph.state.graphVersion) throw new HandoffWorkspaceError("future-graph-version", `recommendedStartingPointRefs[${index}] targets a future graph version.`);
    if (!new Set(["node", "flow", "brief"]).has(parsed.kind)) throw new HandoffWorkspaceError("unsupported-context-kind", `recommendedStartingPointRefs[${index}] must reference a node, flow, or Brief.`);
    return statement(`Recommended starting point: ${parsed.kind} ${parsed.contextId}.`, "recommendedStartingPoints", author, graph, createdAt, [ref]);
  });
}

function conceptTagSelections(graph, value, author, createdAt) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new HandoffWorkspaceError("invalid-concept-tags", "conceptTags must be an array with at most 100 subjects.");
  const subjectRefs = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["subjectRef", "tags"].includes(key))) throw new HandoffWorkspaceError("invalid-concept-tag", `conceptTags[${index}] must contain only subjectRef and tags.`);
    const subjectRef = portableText(item.subjectRef, `conceptTags[${index}].subjectRef`, { required: true, maximum: 8192 });
    if (subjectRefs.has(subjectRef)) throw new HandoffWorkspaceError("duplicate-concept-tag-subject", `conceptTags[${index}].subjectRef is repeated.`);
    subjectRefs.add(subjectRef);
    let parsed;
    try { parsed = parseContextRef(subjectRef); } catch (error) { throw new HandoffWorkspaceError(error.code || "invalid-context-ref", `conceptTags[${index}].subjectRef is invalid: ${error.message}`); }
    if (parsed.projectId !== graph.project.projectId || !new Set(["node", "flow"]).has(parsed.kind) || parsed.graphVersion > graph.state.graphVersion) throw new HandoffWorkspaceError("invalid-concept-tag-subject", `conceptTags[${index}].subjectRef must be a current-project node or flow ref.`);
    const tags = textList(item.tags, `conceptTags[${index}].tags`, 20).map((tag) => tag.toLocaleLowerCase("en-US"));
    if (!tags.length) throw new HandoffWorkspaceError("missing-concept-tags", `conceptTags[${index}].tags must contain at least one tag.`);
    return { subjectRef, tags: [...new Set(tags)].sort(), evidenceClass: "human-authored", selection: statement(`Human concept tags: ${[...new Set(tags)].sort().join(", ")}.`, "conceptTags", author, graph, createdAt, [subjectRef]) };
  });
}

function normalizeWorkspaceInput(input) {
  const normalized = {
    operationId: portableText(input?.operationId, "operationId", { required: true, maximum: 240 }),
    author: portableText(input?.author, "author", { required: true, maximum: 240 }),
    purpose: portableText(input?.purpose, "purpose", { maximum: 4000 }),
    architectureSummary: portableText(input?.architectureSummary, "architectureSummary", { maximum: 4000 }),
    criticalFlowIds: idList(input?.criticalFlowIds, "criticalFlowIds"),
    relatedTestIds: idList(input?.relatedTestIds, "relatedTestIds"),
    recommendedStartingPointRefs: idList(input?.recommendedStartingPointRefs, "recommendedStartingPointRefs"),
    conceptTags: input?.conceptTags,
  };
  for (const [section, maximum] of Object.entries(TEXT_SECTIONS)) normalized[section] = textList(input?.[section], section, maximum);
  return normalized;
}

function saveHandoffWorkspace(root, graph, input, options = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new HandoffWorkspaceError("missing-graph-identity", "A handoff workspace requires project identity and graph version.");
  const normalized = normalizeWorkspaceInput(input || {});
  const read = readStore(root, HANDOFF_WORKSPACES_RELATIVE_PATH, HANDOFF_WORKSPACES_SCHEMA, graph.project.projectId);
  if (read.status === "invalid") throw new HandoffWorkspaceError("invalid-handoff-store", read.diagnostics[0].message);
  const inputFingerprint = fingerprint(normalized);
  const existing = read.store.records.find((record) => record.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new HandoffWorkspaceError("operation-id-conflict", "operationId already belongs to another immutable handoff workspace version.");
    return { schemaVersion: "flowpeek-handoff-workspace-result/v1", created: false, workspace: existing };
  }
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new HandoffWorkspaceError("invalid-created-at", "createdAt must be an ISO-compatible timestamp.");
  const previous = currentRecord(read.store.records);
  const recordBase = {
    schemaVersion: HANDOFF_WORKSPACE_SCHEMA,
    operationId: normalized.operationId,
    inputFingerprint,
    projectIdentity: { projectId: graph.project.projectId },
    sourceBasis: sourceBasis(graph),
    graphVersion: graph.state.graphVersion,
    evidenceClass: "human-authored",
    freshnessStatusAtCreation: sourceBasis(graph).value ? "current" : "unavailable",
    author: normalized.author,
    createdAt,
    supersedes: previous?.id || null,
    access: "local-editable-by-version",
    content: {
      purpose: statement(normalized.purpose, "purpose", normalized.author, graph, createdAt),
      architectureSummary: statement(normalized.architectureSummary, "architectureSummary", normalized.author, graph, createdAt),
      criticalFlows: flowSelections(graph, normalized.criticalFlowIds, normalized.author, createdAt),
      owners: normalized.owners.map((item) => statement(item, "owners", normalized.author, graph, createdAt)),
      risks: normalized.risks.map((item) => statement(item, "risks", normalized.author, graph, createdAt)),
      decisions: normalized.decisions.map((item) => statement(item, "decisions", normalized.author, graph, createdAt)),
      knownLimitations: normalized.knownLimitations.map((item) => statement(item, "knownLimitations", normalized.author, graph, createdAt)),
      unresolvedQuestions: normalized.unresolvedQuestions.map((item) => statement(item, "unresolvedQuestions", normalized.author, graph, createdAt)),
      relatedTests: testSelections(graph, normalized.relatedTestIds, normalized.author, createdAt),
      recommendedStartingPoints: startingPointSelections(graph, normalized.recommendedStartingPointRefs, normalized.author, createdAt),
      conceptTags: conceptTagSelections(graph, normalized.conceptTags, normalized.author, createdAt),
      runtimeEvidence: runtimeEvidenceSummary(root, graph),
    },
    policy: {
      portable: true,
      appendOnlyVersions: true,
      excluded: ["source-file bodies", "credentials", "secrets", "machine-specific absolute paths", "shell access", "private model reasoning"],
    },
  };
  const record = { ...recordBase, id: `handoff-workspace:${fingerprint(recordBase).slice(7, 39)}` };
  atomicWriteJson(read.path, { ...read.store, records: [...read.store.records, record] });
  return { schemaVersion: "flowpeek-handoff-workspace-result/v1", created: true, workspace: record };
}

function workspaceFreshness(workspace, graph) {
  if (workspace.projectIdentity?.projectId !== graph.project.projectId) return "unavailable";
  if (!workspace.sourceBasis?.sourceFingerprint || !graph.state.sourceFingerprint) return "unavailable";
  if (workspace.sourceBasis.sourceFingerprint !== graph.state.sourceFingerprint || workspace.graphVersion !== graph.state.graphVersion) return "stale";
  return "current";
}

function listHandoffWorkspaces(root, graph) {
  const read = readStore(root, HANDOFF_WORKSPACES_RELATIVE_PATH, HANDOFF_WORKSPACES_SCHEMA, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-handoff-workspace-list/v1", status: "unavailable", current: null, records: [], diagnostics: read.diagnostics };
  const records = lifecycleRecords(read.store.records).map((record) => ({ ...record, freshnessStatus: workspaceFreshness(record, graph) }));
  return { schemaVersion: "flowpeek-handoff-workspace-list/v1", status: "available", current: records.find((record) => record.lifecycleStatus === "active") || null, total: records.length, records, diagnostics: [] };
}

function normalizeNoteInput(input) {
  const subjectKind = portableText(input?.subjectKind || "general", "subjectKind", { required: true, maximum: 40 }).toLowerCase();
  if (!NOTE_SUBJECT_KINDS.has(subjectKind)) throw new HandoffWorkspaceError("invalid-subject-kind", `subjectKind must be one of: ${[...NOTE_SUBJECT_KINDS].join(", ")}.`);
  return {
    operationId: portableText(input?.operationId, "operationId", { required: true, maximum: 240 }),
    workspaceId: portableText(input?.workspaceId, "workspaceId", { maximum: 240 }),
    subjectKind,
    subjectId: portableText(input?.subjectId, "subjectId", { maximum: 8192 }),
    body: portableText(input?.body, "body", { required: true, maximum: 4000 }),
    author: portableText(input?.author, "author", { required: true, maximum: 240 }),
    supersedesNoteId: portableText(input?.supersedesNoteId, "supersedesNoteId", { maximum: 240 }),
  };
}

function saveHandoffNote(root, graph, input, options = {}) {
  const normalized = normalizeNoteInput(input || {});
  const workspaces = listHandoffWorkspaces(root, graph);
  if (workspaces.status !== "available") throw new HandoffWorkspaceError("workspace-unavailable", "The local handoff workspace store is unavailable.");
  const workspace = normalized.workspaceId ? workspaces.records.find((record) => record.id === normalized.workspaceId) : workspaces.current;
  if (!workspace) throw new HandoffWorkspaceError("workspace-not-found", "A current or matching local handoff workspace is required before adding a note.");
  const read = readStore(root, HANDOFF_NOTES_RELATIVE_PATH, HANDOFF_NOTES_SCHEMA, graph.project.projectId);
  if (read.status === "invalid") throw new HandoffWorkspaceError("invalid-handoff-note-store", read.diagnostics[0].message);
  const inputFingerprint = fingerprint({ ...normalized, workspaceId: workspace.id });
  const existing = read.store.records.find((record) => record.operationId === normalized.operationId);
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw new HandoffWorkspaceError("operation-id-conflict", "operationId already belongs to another immutable handoff note.");
    return { schemaVersion: "flowpeek-handoff-note-result/v1", created: false, note: existing };
  }
  const superseded = normalized.supersedesNoteId ? read.store.records.find((record) => record.id === normalized.supersedesNoteId) : null;
  if (normalized.supersedesNoteId && !superseded) throw new HandoffWorkspaceError("superseded-note-not-found", "supersedesNoteId does not identify a retained local note.");
  if (superseded && (superseded.workspaceId !== workspace.id || superseded.subject.kind !== normalized.subjectKind || superseded.subject.id !== normalized.subjectId)) {
    throw new HandoffWorkspaceError("supersession-subject-mismatch", "A note may supersede only a note for the same workspace and subject.");
  }
  if (superseded && read.store.records.some((record) => record.supersedes === superseded.id)) throw new HandoffWorkspaceError("note-already-superseded", "supersedesNoteId already has a retained successor; append a successor to the active note instead.");
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new HandoffWorkspaceError("invalid-created-at", "createdAt must be an ISO-compatible timestamp.");
  const base = {
    schemaVersion: HANDOFF_NOTE_SCHEMA,
    operationId: normalized.operationId,
    inputFingerprint,
    workspaceId: workspace.id,
    projectIdentity: { projectId: graph.project.projectId },
    sourceBasis: sourceBasis(graph),
    graphVersion: graph.state.graphVersion,
    evidenceClass: "human-authored",
    subject: { kind: normalized.subjectKind, id: normalized.subjectId },
    body: normalized.body,
    author: normalized.author,
    createdAt,
    supersedes: superseded?.id || null,
  };
  const note = { ...base, id: `handoff-note:${fingerprint(base).slice(7, 39)}` };
  atomicWriteJson(read.path, { ...read.store, records: [...read.store.records, note] });
  return { schemaVersion: "flowpeek-handoff-note-result/v1", created: true, note };
}

function listHandoffNotes(root, graph, workspaceId = null) {
  const read = readStore(root, HANDOFF_NOTES_RELATIVE_PATH, HANDOFF_NOTES_SCHEMA, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-handoff-note-list/v1", status: "unavailable", records: [], diagnostics: read.diagnostics };
  const records = lifecycleRecords(read.store.records.filter((record) => !workspaceId || record.workspaceId === workspaceId));
  return { schemaVersion: "flowpeek-handoff-note-list/v1", status: "available", total: records.length, records, diagnostics: [] };
}

function assertKnownKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HandoffWorkspaceError("invalid-handoff-export-shape", `${name} must be an object.`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new HandoffWorkspaceError("unknown-handoff-export-field", `${name}.${unknown} is not allowed by the portable handoff schema.`);
}

function validatePortableRef(ref, projectId, name) {
  let parsed;
  try { parsed = parseContextRef(ref); } catch (error) { throw new HandoffWorkspaceError(error.code || "invalid-context-ref", `${name} is invalid: ${error.message}`); }
  if (parsed.projectId !== projectId) throw new HandoffWorkspaceError("wrong-project-id", `${name} does not match the exported project identity.`);
}

function validateStatementShape(item, projectId, name) {
  assertKnownKeys(item, ["status", "section", "text", "evidenceClass", "graphVersion", "evidenceRefs", "author", "createdAt", "id", "reason"], name);
  if (item.status === "available") {
    portableText(item.text, `${name}.text`, { required: true, maximum: 4000 });
    if (!Array.isArray(item.evidenceRefs)) throw new HandoffWorkspaceError("invalid-evidence-refs", `${name}.evidenceRefs must be an array.`);
    item.evidenceRefs.forEach((ref, index) => validatePortableRef(ref, projectId, `${name}.evidenceRefs[${index}]`));
  } else if (item.status !== "unavailable") throw new HandoffWorkspaceError("invalid-statement-status", `${name}.status must be available or unavailable.`);
}

function validateStrictExportShape(packet) {
  assertKnownKeys(packet, ["schemaVersion", "format", "access", "projectIdentity", "sourceBasis", "graphVersion", "evidenceClass", "workspace", "notes", "policy", "integrity"], "export");
  assertKnownKeys(packet.projectIdentity, ["projectId"], "export.projectIdentity");
  assertKnownKeys(packet.sourceBasis, ["kind", "value", "gitRevision", "sourceFingerprint"], "export.sourceBasis");
  assertKnownKeys(packet.policy, ["foreignImportAccess", "verificationOnImport"], "export.policy");
  assertKnownKeys(packet.integrity, ["algorithm", "contentHash"], "export.integrity");
  const workspace = packet.workspace;
  assertKnownKeys(workspace, ["schemaVersion", "operationId", "inputFingerprint", "projectIdentity", "sourceBasis", "graphVersion", "evidenceClass", "freshnessStatusAtCreation", "author", "createdAt", "supersedes", "access", "content", "policy", "id", "lifecycleStatus", "freshnessStatus"], "export.workspace");
  assertKnownKeys(workspace.projectIdentity, ["projectId"], "export.workspace.projectIdentity");
  assertKnownKeys(workspace.sourceBasis, ["kind", "value", "gitRevision", "sourceFingerprint"], "export.workspace.sourceBasis");
  assertKnownKeys(workspace.policy, ["portable", "appendOnlyVersions", "excluded"], "export.workspace.policy");
  assertKnownKeys(workspace.content, ["purpose", "architectureSummary", "criticalFlows", "owners", "risks", "decisions", "knownLimitations", "unresolvedQuestions", "relatedTests", "recommendedStartingPoints", "conceptTags", "runtimeEvidence"], "export.workspace.content");
  const projectId = packet.projectIdentity.projectId;
  if (workspace.projectIdentity.projectId !== projectId || workspace.graphVersion !== packet.graphVersion) throw new HandoffWorkspaceError("handoff-export-identity-mismatch", "Workspace identity or graph version does not match the export envelope.");
  validateStatementShape(workspace.content.purpose, projectId, "export.workspace.content.purpose");
  validateStatementShape(workspace.content.architectureSummary, projectId, "export.workspace.content.architectureSummary");
  for (const key of ["owners", "risks", "decisions", "knownLimitations", "unresolvedQuestions", "recommendedStartingPoints"]) {
    if (!Array.isArray(workspace.content[key])) throw new HandoffWorkspaceError("invalid-handoff-export-shape", `export.workspace.content.${key} must be an array.`);
    workspace.content[key].forEach((item, index) => validateStatementShape(item, projectId, `export.workspace.content.${key}[${index}]`));
  }
  if (!Array.isArray(workspace.content.criticalFlows) || !Array.isArray(workspace.content.relatedTests)) throw new HandoffWorkspaceError("invalid-handoff-export-shape", "Critical flows and related tests must be arrays.");
  workspace.content.criticalFlows.forEach((item, index) => {
    assertKnownKeys(item, ["flow", "selection"], `export.workspace.content.criticalFlows[${index}]`);
    assertKnownKeys(item.flow, ["id", "title", "entryId", "contextRef", "evidenceClass", "graphVersion"], `export.workspace.content.criticalFlows[${index}].flow`);
    validatePortableRef(item.flow.contextRef, projectId, `export.workspace.content.criticalFlows[${index}].flow.contextRef`);
    validateStatementShape(item.selection, projectId, `export.workspace.content.criticalFlows[${index}].selection`);
  });
  workspace.content.relatedTests.forEach((item, index) => {
    assertKnownKeys(item, ["test", "selection"], `export.workspace.content.relatedTests[${index}]`);
    assertKnownKeys(item.test, ["id", "label", "path", "contextRef", "evidenceClass", "graphVersion"], `export.workspace.content.relatedTests[${index}].test`);
    validatePortableRef(item.test.contextRef, projectId, `export.workspace.content.relatedTests[${index}].test.contextRef`);
    validateStatementShape(item.selection, projectId, `export.workspace.content.relatedTests[${index}].selection`);
  });
  if (workspace.content.conceptTags !== undefined && !Array.isArray(workspace.content.conceptTags)) throw new HandoffWorkspaceError("invalid-handoff-export-shape", "export.workspace.content.conceptTags must be an array.");
  (workspace.content.conceptTags || []).forEach((item, index) => {
    assertKnownKeys(item, ["subjectRef", "tags", "evidenceClass", "selection"], `export.workspace.content.conceptTags[${index}]`);
    validatePortableRef(item.subjectRef, projectId, `export.workspace.content.conceptTags[${index}].subjectRef`);
    if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")) throw new HandoffWorkspaceError("invalid-concept-tags", `export.workspace.content.conceptTags[${index}].tags must be strings.`);
    validateStatementShape(item.selection, projectId, `export.workspace.content.conceptTags[${index}].selection`);
  });
  assertKnownKeys(workspace.content.runtimeEvidence, ["status", "evidenceClass", "graphVersion", "reason", "current", "stale", "retained", "expiredManifests", "retention", "limitation"], "export.workspace.content.runtimeEvidence");
  if (workspace.content.runtimeEvidence.retention) assertKnownKeys(workspace.content.runtimeEvidence.retention, ["maxRecords", "maxManifests", "manifestsRetained"], "export.workspace.content.runtimeEvidence.retention");
  packet.notes.forEach((note, index) => {
    assertKnownKeys(note, ["schemaVersion", "operationId", "inputFingerprint", "workspaceId", "projectIdentity", "sourceBasis", "graphVersion", "evidenceClass", "subject", "body", "author", "createdAt", "supersedes", "id", "lifecycleStatus"], `export.notes[${index}]`);
    assertKnownKeys(note.projectIdentity, ["projectId"], `export.notes[${index}].projectIdentity`);
    assertKnownKeys(note.sourceBasis, ["kind", "value", "gitRevision", "sourceFingerprint"], `export.notes[${index}].sourceBasis`);
    assertKnownKeys(note.subject, ["kind", "id"], `export.notes[${index}].subject`);
    if (note.projectIdentity.projectId !== projectId || note.workspaceId !== workspace.id) throw new HandoffWorkspaceError("handoff-export-note-identity-mismatch", `export.notes[${index}] does not belong to the exported project and workspace.`);
    portableText(note.body, `export.notes[${index}].body`, { required: true, maximum: 4000 });
  });
}

function validateExport(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet) || packet.schemaVersion !== HANDOFF_EXPORT_SCHEMA || packet.format !== "json") throw new HandoffWorkspaceError("invalid-handoff-export", "Import must contain a flowpeek-handoff-export/v1 JSON packet.");
  if (packet.workspace?.schemaVersion !== HANDOFF_WORKSPACE_SCHEMA || !Array.isArray(packet.notes) || packet.notes.some((note) => note.schemaVersion !== HANDOFF_NOTE_SCHEMA)) throw new HandoffWorkspaceError("invalid-handoff-export-content", "Exported workspace or notes do not match the portable handoff schemas.");
  if (packet.access !== "portable-export" || packet.integrity?.algorithm !== "sha256") throw new HandoffWorkspaceError("invalid-handoff-export-integrity", "Export access or integrity metadata is invalid.");
  validateStrictExportShape(packet);
  const { integrity, ...unsigned } = packet;
  if (integrity.contentHash !== fingerprint(unsigned)) throw new HandoffWorkspaceError("handoff-export-hash-mismatch", "Export content hash does not match the portable payload.");
  const serialized = JSON.stringify(unsigned);
  portableText(serialized, "handoff export", { required: true, maximum: 2_000_000 });
  return packet;
}

function handoffMarkdown(packet) {
  const sections = packet.workspace.content;
  const renderStatement = (item) => item?.status === "available"
    ? `- ${item.text} _(class: ${item.evidenceClass}; graph: ${item.graphVersion}; refs: ${(item.evidenceRefs || []).join(", ") || "none"})_`
    : `- Unavailable: ${item?.reason || "not recorded"}`;
  const lines = [
    `# Project handoff: ${packet.projectIdentity.projectId}`,
    "",
    `- Workspace: \`${packet.workspace.id}\``,
    `- Graph version: ${packet.workspace.graphVersion}`,
    `- Source basis: ${packet.workspace.sourceBasis.kind} \`${packet.workspace.sourceBasis.value || "unavailable"}\``,
    `- Access: ${packet.access}`,
    "",
    "## Purpose",
    "",
    renderStatement(sections.purpose),
    "",
    "## Architecture summary",
    "",
    renderStatement(sections.architectureSummary),
  ];
  for (const [title, key] of [["Owners", "owners"], ["Risks", "risks"], ["Important decisions", "decisions"], ["Known limitations", "knownLimitations"], ["Unresolved questions", "unresolvedQuestions"], ["Recommended starting points", "recommendedStartingPoints"]]) {
    lines.push("", `## ${title}`, "", ...(sections[key].length ? sections[key].map(renderStatement) : ["- None recorded."]));
  }
  lines.push("", "## Critical flows", "", ...(sections.criticalFlows.length ? sections.criticalFlows.map((item) => renderStatement(item.selection)) : ["- None recorded."]));
  lines.push("", "## Related tests", "", ...(sections.relatedTests.length ? sections.relatedTests.map((item) => renderStatement(item.selection)) : ["- None recorded."]));
  lines.push("", "## Notes", "", ...(packet.notes.length ? packet.notes.map((note) => `- ${note.body} _(author: ${note.author}; graph: ${note.graphVersion}; class: ${note.evidenceClass}; status: ${note.lifecycleStatus})_`) : ["- None recorded."]));
  lines.push("", `<!-- flowpeek-handoff-json-base64:${Buffer.from(JSON.stringify(packet), "utf8").toString("base64")} -->`);
  return lines.join("\n");
}

function exportHandoffWorkspace(root, graph, options = {}) {
  const listed = listHandoffWorkspaces(root, graph);
  if (listed.status !== "available") throw new HandoffWorkspaceError("workspace-unavailable", listed.diagnostics[0]?.message || "Handoff workspace store is unavailable.");
  const workspace = options.workspaceId ? listed.records.find((record) => record.id === options.workspaceId) : listed.current;
  if (!workspace) throw new HandoffWorkspaceError("workspace-not-found", "No matching local handoff workspace exists.");
  const notes = listHandoffNotes(root, graph, workspace.id);
  if (notes.status !== "available") throw new HandoffWorkspaceError("notes-unavailable", notes.diagnostics[0]?.message || "Handoff notes are unavailable.");
  const unsigned = {
    schemaVersion: HANDOFF_EXPORT_SCHEMA,
    format: "json",
    access: "portable-export",
    projectIdentity: workspace.projectIdentity,
    sourceBasis: workspace.sourceBasis,
    graphVersion: workspace.graphVersion,
    evidenceClass: workspace.evidenceClass,
    workspace,
    notes: notes.records,
    policy: { foreignImportAccess: "read-only", verificationOnImport: "foreign-unverified" },
  };
  const packet = { ...unsigned, integrity: { algorithm: "sha256", contentHash: fingerprint(unsigned) } };
  if ((options.format || "json") === "json") return packet;
  if (options.format !== "markdown") throw new HandoffWorkspaceError("unsupported-format", "Handoff export format must be json or markdown.");
  return { schemaVersion: HANDOFF_MARKDOWN_SCHEMA, format: "markdown", workspaceId: workspace.id, markdown: handoffMarkdown(packet) };
}

function decodeImport(input) {
  if (typeof input === "string") {
    const match = input.match(/<!-- flowpeek-handoff-json-base64:([A-Za-z0-9+/=]+) -->/);
    if (!match) throw new HandoffWorkspaceError("invalid-handoff-markdown", "Markdown import does not contain an embedded portable Flowpeek handoff packet.");
    try { return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")); } catch (error) { throw new HandoffWorkspaceError("invalid-handoff-markdown-payload", `Embedded Markdown payload is invalid (${error.message}).`); }
  }
  if (input?.schemaVersion === HANDOFF_MARKDOWN_SCHEMA && typeof input.markdown === "string") return decodeImport(input.markdown);
  return input;
}

function importHandoffWorkspace(root, graph, input, options = {}) {
  const packet = validateExport(decodeImport(input));
  const read = readStore(root, HANDOFF_IMPORTS_RELATIVE_PATH, HANDOFF_IMPORTS_SCHEMA, graph.project.projectId);
  if (read.status === "invalid") throw new HandoffWorkspaceError("invalid-handoff-import-store", read.diagnostics[0].message);
  const contentHash = packet.integrity.contentHash;
  const existing = read.store.records.find((record) => record.contentHash === contentHash);
  if (existing) return { schemaVersion: "flowpeek-handoff-import-result/v1", created: false, import: existing };
  const artifactRelativePath = `${HANDOFF_IMPORT_ARTIFACTS_RELATIVE_PATH}/${contentHash.slice(7)}.json`;
  const createdAt = options.now || new Date().toISOString();
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new HandoffWorkspaceError("invalid-imported-at", "importedAt must be an ISO-compatible timestamp.");
  const record = {
    schemaVersion: HANDOFF_IMPORT_SCHEMA,
    id: `handoff-import:${contentHash.slice(7, 39)}`,
    contentHash,
    originProjectIdentity: packet.projectIdentity,
    localProjectIdentity: { projectId: graph.project.projectId },
    projectIdentityMatch: packet.projectIdentity.projectId === graph.project.projectId,
    originGraphVersion: packet.graphVersion,
    importedAt: createdAt,
    access: "read-only",
    trust: "foreign-unverified",
    verificationStatus: "not-adopted",
    artifact: { relativePath: artifactRelativePath },
  };
  atomicWriteJson(path.join(root, artifactRelativePath), packet);
  atomicWriteJson(read.path, { ...read.store, records: [...read.store.records, record] });
  return { schemaVersion: "flowpeek-handoff-import-result/v1", created: true, import: record };
}

function listImportedHandoffs(root, graph) {
  const read = readStore(root, HANDOFF_IMPORTS_RELATIVE_PATH, HANDOFF_IMPORTS_SCHEMA, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: "flowpeek-handoff-import-list/v1", status: "unavailable", records: [], diagnostics: read.diagnostics };
  const records = read.store.records.map((record) => ({ ...record, artifactStatus: fs.existsSync(path.join(root, record.artifact.relativePath)) ? "retained" : "expired" }));
  return { schemaVersion: "flowpeek-handoff-import-list/v1", status: "available", total: records.length, records, diagnostics: [] };
}

module.exports = {
  HANDOFF_EXPORT_SCHEMA,
  HANDOFF_IMPORTS_RELATIVE_PATH,
  HANDOFF_IMPORTS_SCHEMA,
  HANDOFF_MARKDOWN_SCHEMA,
  HANDOFF_NOTES_RELATIVE_PATH,
  HANDOFF_NOTES_SCHEMA,
  HANDOFF_NOTE_SCHEMA,
  HANDOFF_WORKSPACES_RELATIVE_PATH,
  HANDOFF_WORKSPACES_SCHEMA,
  HANDOFF_WORKSPACE_SCHEMA,
  HandoffWorkspaceError,
  exportHandoffWorkspace,
  importHandoffWorkspace,
  listHandoffNotes,
  listHandoffWorkspaces,
  listImportedHandoffs,
  portableText,
  saveHandoffNote,
  saveHandoffWorkspace,
};
