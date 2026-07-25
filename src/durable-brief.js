"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { runtimeEvidenceSummary } = require("./runtime-evidence");
const { createContextRef, parseContextRef } = require("./context-card");
const { getFlowProjection } = require("./flow-lens");
const { readGraphDelta } = require("./graph-state");
const { resolveFlowVerification } = require("./flow-verification");
const { createSemanticFlowSuggestion } = require("./semantic-flow-suggestion");
const { resolveSemanticSuggestionFeedback } = require("./semantic-suggestion-feedback");

const DURABLE_BRIEF_SCHEMA = "flopeek-brief/v1";
const DURABLE_BRIEF_PACKET_SCHEMA = "flopeek-brief-packet/v1";
const DURABLE_BRIEF_MANIFEST_SCHEMA = "flopeek-brief-manifest/v1";
const DURABLE_BRIEF_MANIFESTS_SCHEMA = "flopeek-brief-manifests/v1";
const BRIEF_MANIFESTS_RELATIVE_PATH = ".flopeek/briefs/manifests.json";
const BRIEF_ARTIFACTS_RELATIVE_PATH = ".flopeek/briefs/artifacts";
const BRIEF_KINDS = new Set(["project", "feature", "flow", "node"]);

class DurableBriefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DurableBriefError";
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function relativePortablePath(value) {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.replaceAll("\\", "/");
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//") || normalized.startsWith("/")) return null;
  return normalized;
}

function sourceBasis(graph) {
  const revision = graph.state?.sourceRevision || null;
  const fingerprint = graph.state?.sourceFingerprint || null;
  const dirty = graph.project?.git?.dirty;
  if (revision && dirty === false) return { kind: "git-revision", value: revision, gitRevision: revision, sourceFingerprint: fingerprint };
  if (fingerprint) return { kind: "working-tree-fingerprint", value: fingerprint, gitRevision: revision, sourceFingerprint: fingerprint };
  return { kind: "unavailable", value: null, gitRevision: revision, sourceFingerprint: null };
}

function provenance(graph, evidenceClass = "deterministic-inference") {
  const basis = sourceBasis(graph);
  return {
    projectIdentity: { projectId: graph.project.projectId },
    sourceBasis: basis,
    graphVersion: graph.state.graphVersion,
    evidenceClass,
    freshnessStatus: basis.value ? "current" : "unavailable",
    createdAt: graph.generatedAt,
  };
}

function portableNode(node) {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    type: node.type,
    path: relativePortablePath(node.path),
    parser: node.analysis?.parser || "unknown",
    parserStatus: node.analysis?.status || "unknown",
    confidence: node.analysis?.confidence || "unknown",
    evidence: node.evidence || null,
  };
}

function featureKey(node) {
  return node.feature || node.domain || "project";
}

function featureMembers(graph, requestedId) {
  const key = String(requestedId || "").replace(/^feature:/, "");
  const members = graph.nodes.filter((node) => featureKey(node) === key || node.feature === key || node.domain === key);
  return { key, members };
}

function relatedFlows(graph, nodeIds) {
  const ids = new Set(nodeIds);
  return (graph.flows || []).filter((flow) => (flow.steps || []).some((step) => ids.has(step.id)));
}

function bounded(items, limit) {
  return {
    items: items.slice(0, limit),
    total: items.length,
    omitted: Math.max(items.length - limit, 0),
    truncationReason: items.length > limit ? `Brief contract retains at most ${limit} items in this section.` : null,
  };
}

function evidenceSections({ graph, parserFacts, deterministicInference, humanNotes = [], verificationRecords = [] }) {
  return {
    parserFacts: { evidenceClass: "static-parser-fact", ...parserFacts },
    deterministicInference: { evidenceClass: "deterministic-inference", ...deterministicInference },
    humanNotes: {
      evidenceClass: "human-authored",
      items: humanNotes,
      contentPolicy: "Free-form legacy note bodies are excluded from durable Briefs until the sanitized append-only note contract is available.",
    },
    verificationRecords: { evidenceClass: "human-verified", items: verificationRecords },
    runtimeEvidence: { ...runtimeEvidenceSummary(graph.project.root, graph), items: [] },
  };
}

function baseBrief(graph, kind, contextId, title, sections, omissions = []) {
  const base = {
    schemaVersion: DURABLE_BRIEF_SCHEMA,
    kind,
    contextId,
    title,
    ...provenance(graph),
    briefPolicy: {
      derivedEvidenceCeiling: "deterministic-inference",
      rule: "A derived Brief never raises the evidence class of any source statement. Every section retains its own evidence class.",
      portable: true,
      excluded: ["source-file bodies", "credentials", "secrets", "machine-specific absolute paths", "shell access", "private model reasoning"],
    },
    sections,
    omissions,
  };
  const contentHash = hash(base);
  const briefId = `brief:${kind}:${encodeURIComponent(contextId)}@${graph.state.graphVersion}:${contentHash.slice(-12)}`;
  return {
    ...base,
    briefId,
    briefRef: createContextRef(graph.project.projectId, "brief", briefId, graph.state.graphVersion),
    integrity: { algorithm: "sha256", contentHash },
  };
}

function projectBrief(graph) {
  const features = [...new Map(graph.nodes.map((node) => [featureKey(node), featureKey(node)])).values()].sort();
  const featureItems = features.map((key) => {
    const members = graph.nodes.filter((node) => featureKey(node) === key);
    return { id: `feature:${key}`, key, nodeCount: members.length, endpointCount: members.filter((node) => node.kind === "endpoint").length };
  });
  const flowItems = (graph.flows || []).map((flow) => ({ id: flow.id, title: flow.title, entryId: flow.entryId }));
  const featureResult = bounded(featureItems, 80);
  const flowResult = bounded(flowItems, 120);
  return baseBrief(graph, "project", graph.project.projectId, graph.project.name, evidenceSections({ graph,
    parserFacts: {
      stats: { ...graph.stats },
      coverage: graph.analysis?.coverage?.summary || null,
      adapterRegistry: graph.analysis?.adapterCapabilities?.schemaVersion || null,
    },
    deterministicInference: { features: featureResult.items, flows: flowResult.items },
  }), [featureResult.truncationReason, flowResult.truncationReason].filter(Boolean));
}

function createFeatureBrief(graph, id) {
  const { key, members } = featureMembers(graph, id);
  if (!members.length) throw new DurableBriefError("feature-not-found", `Feature not found: ${id}`);
  const memberResult = bounded(members.sort((left, right) => left.id.localeCompare(right.id)).map(portableNode), 80);
  const flows = relatedFlows(graph, members.map((node) => node.id));
  const flowResult = bounded(flows.map((flow) => ({ id: flow.id, title: flow.title, entryId: flow.entryId })), 80);
  const legacyNotes = members.filter((node) => typeof node.manualDescription === "string" && node.manualDescription.trim()).map((node) => ({
    subjectId: node.id,
    status: "present-but-body-excluded",
    author: null,
    graphVersion: graph.state.graphVersion,
  }));
  return baseBrief(graph, "feature", key, key.split("/").join(" · "), evidenceSections({ graph,
    parserFacts: { nodes: memberResult.items, totalNodes: memberResult.total },
    deterministicInference: { relatedFlows: flowResult.items, totalRelatedFlows: flowResult.total },
    humanNotes: legacyNotes,
  }), [memberResult.truncationReason, flowResult.truncationReason].filter(Boolean));
}

function verificationSummary(verification) {
  const record = verification?.record;
  if (!record) return [];
  return [{
    recordId: record.id,
    status: verification.status,
    verifiedBy: record.verifiedBy,
    verifiedAt: record.verifiedAt,
    sourceGraphVersion: record.sourceGraphVersion,
    risk: record.risk,
  }];
}

function createFlowBrief(graph, id) {
  const lens = getFlowProjection(graph, id, "application");
  if (!lens) throw new DurableBriefError("flow-not-found", `Flow not found: ${id}`);
  const suggestion = createSemanticFlowSuggestion(graph, lens);
  const feedback = resolveSemanticSuggestionFeedback(graph.project.root, graph, suggestion);
  const verification = resolveFlowVerification(graph.project.root, graph, lens, { readDelta: (from, to) => readGraphDelta(graph.project.root, from, to) });
  const steps = lens.steps.map((step) => ({
    id: step.id,
    label: step.node.label,
    type: step.node.type,
    path: relativePortablePath(step.node.path),
    role: step.role,
    contextRef: step.contextRef,
    transition: step.transition,
    evidenceClass: "static-parser-fact",
  }));
  const feedbackItems = feedback.record ? [{
    recordId: feedback.record.id,
    decision: feedback.record.decision,
    reviewedBy: feedback.record.reviewedBy,
    createdAt: feedback.record.createdAt,
    status: feedback.status,
    noteBody: null,
  }] : [];
  return baseBrief(graph, "flow", lens.flow.id, lens.flow.title, evidenceSections({ graph,
    parserFacts: { entryId: lens.flow.entryId, handlerEvidence: lens.handlerEvidence, steps, truncation: lens.truncation },
    deterministicInference: {
      semanticSuggestion: suggestion.status === "suggested" ? { status: suggestion.status, candidate: suggestion.candidate, confidence: suggestion.confidence, evidenceRefs: suggestion.evidenceRefs } : { status: suggestion.status, abstention: suggestion.abstention },
      staticBoundaries: lens.staticBoundaries,
    },
    humanNotes: feedbackItems,
    verificationRecords: verificationSummary(verification),
  }), lens.limitations);
}

function createNodeBrief(graph, id) {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new DurableBriefError("node-not-found", `Node not found: ${id}`);
  const incoming = bounded(graph.edges.filter((edge) => edge.target === id).map((edge) => ({ ...edge, evidenceClass: "static-parser-fact" })), 40);
  const outgoing = bounded(graph.edges.filter((edge) => edge.source === id).map((edge) => ({ ...edge, evidenceClass: "static-parser-fact" })), 40);
  const flows = relatedFlows(graph, [id]);
  const legacyNotes = typeof node.manualDescription === "string" && node.manualDescription.trim() ? [{
    subjectId: node.id,
    status: "present-but-body-excluded",
    author: null,
    graphVersion: graph.state.graphVersion,
  }] : [];
  return baseBrief(graph, "node", id, node.label, evidenceSections({ graph,
    parserFacts: { node: portableNode(node), incoming: incoming.items, outgoing: outgoing.items },
    deterministicInference: { feature: featureKey(node), relatedFlows: flows.map((flow) => ({ id: flow.id, title: flow.title })) },
    humanNotes: legacyNotes,
  }), [incoming.truncationReason, outgoing.truncationReason].filter(Boolean));
}

function createDurableBrief(graph, kind, id = null) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new DurableBriefError("missing-graph-identity", "Durable Briefs require project identity and graph version.");
  if (!BRIEF_KINDS.has(kind)) throw new DurableBriefError("invalid-brief-kind", `Brief kind must be one of: ${[...BRIEF_KINDS].join(", ")}.`);
  if (kind === "project") return projectBrief(graph);
  if (typeof id !== "string" || !id) throw new DurableBriefError("missing-context-id", `${kind} Brief requires an id.`);
  if (kind === "feature") return createFeatureBrief(graph, id);
  if (kind === "flow") return createFlowBrief(graph, id);
  return createNodeBrief(graph, id);
}

function manifestsPath(root) {
  return path.join(root, BRIEF_MANIFESTS_RELATIVE_PATH);
}

function emptyManifestStore(projectId) {
  return { schemaVersion: DURABLE_BRIEF_MANIFESTS_SCHEMA, projectId, records: [] };
}

function validManifest(record) {
  return record?.schemaVersion === DURABLE_BRIEF_MANIFEST_SCHEMA
    && typeof record.id === "string" && record.id
    && typeof record.briefId === "string" && record.briefId
    && BRIEF_KINDS.has(record.kind)
    && typeof record.contextId === "string" && record.contextId
    && typeof record.projectIdentity?.projectId === "string" && record.projectIdentity.projectId
    && Number.isSafeInteger(record.graphVersion)
    && typeof record.hash === "string" && record.hash.startsWith("sha256:")
    && typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
    && typeof record.artifact?.relativePath === "string";
}

function readBriefManifestStore(root, projectId) {
  const target = manifestsPath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, store: emptyManifestStore(projectId), diagnostics: [] };
  try {
    const store = JSON.parse(fs.readFileSync(target, "utf8"));
    if (store?.schemaVersion !== DURABLE_BRIEF_MANIFESTS_SCHEMA || store.projectId !== projectId || !Array.isArray(store.records) || !store.records.every(validManifest)) {
      return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-brief-manifest-store", message: "Brief manifest metadata does not match flopeek-brief-manifests/v1." }] };
    }
    return { status: "valid", path: target, store, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, store: null, diagnostics: [{ code: "invalid-brief-manifest-json", message: `Brief manifest metadata is not valid JSON (${error.message}).` }] };
  }
}

function manifestFreshness(record, graph) {
  if (record.projectIdentity.projectId !== graph.project.projectId) return "unavailable";
  if (!record.sourceBasis?.sourceFingerprint || !graph.state.sourceFingerprint) return "unavailable";
  if (record.sourceBasis?.sourceFingerprint !== graph.state.sourceFingerprint) return "stale";
  if (record.graphVersion !== graph.state.graphVersion) return "stale";
  return "current";
}

function materializeDurableBrief(root, graph, kind, id = null) {
  const brief = createDurableBrief(graph, kind, id);
  const read = readBriefManifestStore(root, graph.project.projectId);
  if (read.status === "invalid") throw new DurableBriefError("invalid-brief-manifest-store", read.diagnostics[0].message);
  const store = read.store || emptyManifestStore(graph.project.projectId);
  const existing = store.records.find((record) => record.briefId === brief.briefId && record.hash === brief.integrity.contentHash);
  if (existing) return { created: false, brief, manifest: { ...existing, freshnessStatus: manifestFreshness(existing, graph) } };
  const artifactName = `${brief.integrity.contentHash.slice(7)}.json`;
  const artifactRelativePath = `${BRIEF_ARTIFACTS_RELATIVE_PATH}/${artifactName}`;
  const manifest = {
    schemaVersion: DURABLE_BRIEF_MANIFEST_SCHEMA,
    id: `brief-manifest:${brief.integrity.contentHash.slice(7)}`,
    briefId: brief.briefId,
    kind: brief.kind,
    contextId: brief.contextId,
    projectIdentity: brief.projectIdentity,
    sourceBasis: brief.sourceBasis,
    graphVersion: brief.graphVersion,
    briefSchemaVersion: brief.schemaVersion,
    hash: brief.integrity.contentHash,
    evidenceClass: brief.evidenceClass,
    freshnessStatusAtCreation: brief.freshnessStatus,
    createdAt: brief.createdAt,
    artifact: { relativePath: artifactRelativePath, statusAtCreation: "retained" },
  };
  atomicWriteJson(path.join(root, artifactRelativePath), brief);
  atomicWriteJson(read.path, { ...store, records: [...store.records, manifest] });
  return { created: true, brief, manifest: { ...manifest, freshnessStatus: "current" } };
}

function listDurableBriefManifests(root, graph, options = {}) {
  const read = readBriefManifestStore(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: DURABLE_BRIEF_MANIFESTS_SCHEMA, status: "unavailable", records: [], diagnostics: read.diagnostics };
  const kind = options.kind && BRIEF_KINDS.has(options.kind) ? options.kind : null;
  const contextId = typeof options.contextId === "string" && options.contextId ? options.contextId : null;
  const records = (read.store?.records || [])
    .filter((record) => !kind || record.kind === kind)
    .filter((record) => !contextId || record.contextId === contextId)
    .map((record) => {
      const artifactExists = fs.existsSync(path.join(root, record.artifact.relativePath));
      return {
        ...record,
        freshnessStatus: manifestFreshness(record, graph),
        artifactStatus: artifactExists ? "retained" : "expired",
        artifactReason: artifactExists ? null : "The artifact was evicted or removed; immutable manifest and provenance remain available.",
      };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  return { schemaVersion: DURABLE_BRIEF_MANIFESTS_SCHEMA, status: "available", total: records.length, records, diagnostics: read.diagnostics };
}

function parseBriefContextId(value) {
  const match = String(value || "").match(/^brief:([^:]+):(.+)@(\d+):([a-f0-9]{12})$/);
  if (!match) throw new DurableBriefError("invalid-brief-ref", "Brief Context Ref must encode a versioned Brief ID and content hash.");
  let contextId;
  try { contextId = decodeURIComponent(match[2]); } catch { throw new DurableBriefError("invalid-brief-ref", "Brief Context Ref contains invalid context encoding."); }
  return { briefId: value, kind: match[1], contextId, graphVersion: Number(match[3]), hashSuffix: match[4] };
}

function resolveDurableBriefRef(root, graph, contextRef) {
  let parsed;
  try {
    parsed = parseContextRef(contextRef);
  } catch (error) {
    return { status: "unresolved", requestedRef: contextRef, code: error.code || "invalid-context-ref", reason: error.message, brief: null, manifest: null };
  }
  if (parsed.kind !== "brief") return { status: "unresolved", requestedRef: contextRef, code: "unsupported-context-kind", reason: `Context kind '${parsed.kind}' is not a Brief.`, brief: null, manifest: null };
  if (parsed.projectId !== graph.project.projectId) return { status: "unavailable", requestedRef: contextRef, code: "wrong-project-id", reason: "Brief belongs to a different Flopeek project identity.", brief: null, manifest: null };
  if (parsed.graphVersion > graph.state.graphVersion) return { status: "unavailable", requestedRef: contextRef, code: "future-graph-version", reason: "Brief targets a graph version newer than the current graph.", brief: null, manifest: null };
  let identity;
  try {
    identity = parseBriefContextId(parsed.contextId);
  } catch (error) {
    return { status: "unresolved", requestedRef: contextRef, code: error.code, reason: error.message, brief: null, manifest: null };
  }
  if (!BRIEF_KINDS.has(identity.kind)) return { status: "unresolved", requestedRef: contextRef, code: "invalid-brief-kind", reason: `Unknown Brief kind '${identity.kind}'.`, brief: null, manifest: null };
  if (parsed.graphVersion === graph.state.graphVersion) {
    try {
      const brief = createDurableBrief(graph, identity.kind, identity.kind === "project" ? null : identity.contextId);
      if (brief.briefId === identity.briefId) return { status: "current", requestedRef: contextRef, resolvedRef: brief.briefRef, brief, manifest: null };
    } catch (error) {
      return { status: "unavailable", requestedRef: contextRef, code: error.code || "brief-unavailable", reason: error.message, brief: null, manifest: null };
    }
  }
  const listed = listDurableBriefManifests(root, graph, { kind: identity.kind, contextId: identity.contextId });
  const manifest = listed.records.find((record) => record.briefId === identity.briefId) || null;
  if (!manifest) return { status: "unavailable", requestedRef: contextRef, code: "brief-manifest-not-found", reason: "No immutable manifest was retained for this historical Brief version.", brief: null, manifest: null };
  if (manifest.artifactStatus === "expired") return { status: "expired", requestedRef: contextRef, code: "brief-artifact-expired", reason: manifest.artifactReason, brief: null, manifest };
  try {
    const brief = JSON.parse(fs.readFileSync(path.join(root, manifest.artifact.relativePath), "utf8"));
    return { status: "stale", requestedRef: contextRef, resolvedRef: null, reason: "A retained historical Brief artifact is available, but it is not current.", brief, manifest };
  } catch (error) {
    return { status: "unavailable", requestedRef: contextRef, code: "brief-artifact-invalid", reason: `Historical Brief artifact could not be read (${error.message}).`, brief: null, manifest };
  }
}

function markdownList(items, formatter) {
  return items.length ? items.map((item) => `- ${formatter(item)}`).join("\n") : "- None.";
}

function briefMarkdown(brief) {
  const facts = brief.sections.parserFacts;
  const inference = brief.sections.deterministicInference;
  return [
    `# ${brief.title}`,
    "",
    `- Brief: \`${brief.briefId}\``,
    `- Project: \`${brief.projectIdentity.projectId}\``,
    `- Source basis: ${brief.sourceBasis.kind} \`${brief.sourceBasis.value || "unavailable"}\``,
    `- Graph version: ${brief.graphVersion}`,
    `- Evidence class: ${brief.evidenceClass}`,
    `- Freshness: ${brief.freshnessStatus}`,
    "",
    "## Parser facts",
    "",
    `- Evidence class: ${facts.evidenceClass}`,
    `- Retained fields: ${Object.keys(facts).filter((key) => key !== "evidenceClass").join(", ") || "none"}`,
    "",
    "## Deterministic inference",
    "",
    `- Evidence class: ${inference.evidenceClass}`,
    `- Retained fields: ${Object.keys(inference).filter((key) => key !== "evidenceClass").join(", ") || "none"}`,
    "",
    "## Human notes",
    "",
    markdownList(brief.sections.humanNotes.items, (item) => `${item.status || "recorded"} for \`${item.subjectId || item.recordId || brief.contextId}\``),
    "",
    "## Verification records",
    "",
    markdownList(brief.sections.verificationRecords.items, (item) => `${item.status}: \`${item.recordId}\``),
    "",
    "## Runtime evidence",
    "",
    `- ${brief.sections.runtimeEvidence.status}: ${brief.sections.runtimeEvidence.reason}`,
    "",
    "## Omissions and policy",
    "",
    markdownList([...brief.omissions, ...brief.briefPolicy.excluded.map((item) => `Excluded: ${item}.`)], (item) => item),
  ].join("\n");
}

function createDurableBriefPacket(graph, kind, id = null, format = "json") {
  const brief = createDurableBrief(graph, kind, id);
  if (format === "json") return { schemaVersion: DURABLE_BRIEF_PACKET_SCHEMA, format, brief };
  if (format !== "markdown") throw new DurableBriefError("unsupported-brief-format", "Brief format must be json or markdown.");
  return { schemaVersion: DURABLE_BRIEF_PACKET_SCHEMA, format, briefId: brief.briefId, briefRef: brief.briefRef, markdown: briefMarkdown(brief) };
}

module.exports = {
  BRIEF_ARTIFACTS_RELATIVE_PATH,
  BRIEF_KINDS,
  BRIEF_MANIFESTS_RELATIVE_PATH,
  DURABLE_BRIEF_MANIFESTS_SCHEMA,
  DURABLE_BRIEF_MANIFEST_SCHEMA,
  DURABLE_BRIEF_PACKET_SCHEMA,
  DURABLE_BRIEF_SCHEMA,
  DurableBriefError,
  briefMarkdown,
  createDurableBrief,
  createDurableBriefPacket,
  listDurableBriefManifests,
  materializeDurableBrief,
  readBriefManifestStore,
  resolveDurableBriefRef,
  sourceBasis,
};
