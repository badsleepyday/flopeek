"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson, readGraphCacheResult } = require("./graph-cache");

const ARTIFACT_CACHE_SCHEMA = "flopeek-derived-artifact/v1";
const ARTIFACT_CACHE_REGISTRY_SCHEMA = "flopeek-derived-artifact-registry/v1";
const ARTIFACT_CACHE_AUDIT_SCHEMA = "flopeek-derived-cache-audit/v1";
const CACHE_HYGIENE_SCHEMA = "flopeek-cache-hygiene/v1";
const ARTIFACT_CACHE_REGISTRY_RELATIVE_PATH = ".flopeek/cache/artifacts.json";
const ARTIFACT_CACHE_DIRECTORY_RELATIVE_PATH = ".flopeek/cache/artifacts";
const MAX_AUDIT_EVENTS = 1000;
const VALID_TYPES = new Set(["context-packet", "flow-projection", "semantic-suggestion", "impact-index", "feature-summary"]);

class ArtifactCacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactCacheError";
    this.code = code;
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

function registryPath(root) {
  return path.join(root, ARTIFACT_CACHE_REGISTRY_RELATIVE_PATH);
}

function emptyRegistry(projectId = null) {
  return { schemaVersion: ARTIFACT_CACHE_REGISTRY_SCHEMA, projectId, records: [], events: [], eventsOmitted: 0 };
}

function safeRelativePath(value) {
  return typeof value === "string" && value && !path.isAbsolute(value) && !value.replaceAll("\\", "/").split("/").includes("..");
}

function validRecord(record) {
  return record?.schemaVersion === ARTIFACT_CACHE_SCHEMA
    && typeof record.id === "string" && record.id
    && VALID_TYPES.has(record.type)
    && typeof record.keyHash === "string" && record.keyHash.startsWith("sha256:")
    && typeof record.projectIdentity?.projectId === "string" && record.projectIdentity.projectId
    && Number.isSafeInteger(record.graphVersion)
    && typeof record.sourceFingerprint === "string" && record.sourceFingerprint.startsWith("sha256:")
    && Array.isArray(record.dependencyPaths) && record.dependencyPaths.every((item) => item === "*" || safeRelativePath(item))
    && typeof record.valueHash === "string" && record.valueHash.startsWith("sha256:")
    && typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
    && safeRelativePath(record.artifact.relativePath);
}

function validEvent(event) {
  return event && typeof event === "object" && typeof event.id === "string" && event.id
    && ["hit", "miss", "invalidated", "retained-unaffected", "pruned"].includes(event.status)
    && typeof event.type === "string" && VALID_TYPES.has(event.type)
    && typeof event.keyHash === "string" && event.keyHash.startsWith("sha256:")
    && typeof event.reason === "string" && event.reason
    && Number.isSafeInteger(event.graphVersion)
    && typeof event.createdAt === "string" && !Number.isNaN(Date.parse(event.createdAt));
}

function readArtifactCacheRegistry(root, projectId = null) {
  const target = registryPath(root);
  if (!fs.existsSync(target)) return { status: "missing", path: target, registry: emptyRegistry(projectId), diagnostics: [] };
  try {
    const registry = JSON.parse(fs.readFileSync(target, "utf8"));
    if (registry?.schemaVersion !== ARTIFACT_CACHE_REGISTRY_SCHEMA || (projectId && registry.projectId !== projectId) || typeof registry.projectId !== "string" || !registry.projectId || !Array.isArray(registry.records) || !registry.records.every(validRecord) || !Array.isArray(registry.events) || !registry.events.every(validEvent) || !Number.isSafeInteger(registry.eventsOmitted) || registry.eventsOmitted < 0) {
      return { status: "invalid", path: target, registry: null, diagnostics: [{ code: "invalid-artifact-cache-registry", message: "Derived artifact cache registry is invalid and will not be reused or overwritten." }] };
    }
    return { status: "valid", path: target, registry, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", path: target, registry: null, diagnostics: [{ code: "invalid-artifact-cache-json", message: `Derived artifact cache registry is not valid JSON (${error.message}).` }] };
  }
}

function event(type, keyHash, graphVersion, status, reason, recordId = null, now = null) {
  const createdAt = now || new Date().toISOString();
  const base = { type, keyHash, graphVersion, status, reason, recordId, createdAt };
  return { ...base, id: `cache-event:${fingerprint(base).slice(7, 39)}` };
}

function appendEvent(read, nextEvent, records = null) {
  const registry = read.registry;
  const allEvents = [...registry.events, nextEvent];
  const newlyOmitted = Math.max(allEvents.length - MAX_AUDIT_EVENTS, 0);
  const events = allEvents.slice(-MAX_AUDIT_EVENTS);
  atomicWriteJson(read.path, { ...registry, records: records || registry.records, events, eventsOmitted: registry.eventsOmitted + newlyOmitted });
}

function latestRecord(registry, type, keyHash) {
  return registry.records.filter((record) => record.type === type && record.keyHash === keyHash)
    .sort((left, right) => right.graphVersion - left.graphVersion || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0] || null;
}

function readArtifact(root, record) {
  const target = path.join(root, record.artifact.relativePath);
  if (!fs.existsSync(target)) return { status: "expired", value: null, reason: "artifact-file-expired" };
  try {
    const artifact = JSON.parse(fs.readFileSync(target, "utf8"));
    if (artifact?.schemaVersion !== ARTIFACT_CACHE_SCHEMA || artifact.recordId !== record.id || fingerprint(artifact.value) !== record.valueHash) return { status: "invalid", value: null, reason: "artifact-integrity-mismatch" };
    return { status: "valid", value: artifact.value, reason: null };
  } catch {
    return { status: "invalid", value: null, reason: "artifact-json-invalid" };
  }
}

function normalizeDependencies(values) {
  const dependencies = [...new Set((values || []).map((item) => item === "*" ? "*" : String(item).replaceAll("\\", "/")).filter((item) => item === "*" || safeRelativePath(item)))].sort();
  return dependencies.length ? dependencies : ["*"];
}

function getOrCreateArtifact(root, graph, type, key, compute, options = {}) {
  if (!VALID_TYPES.has(type)) throw new ArtifactCacheError("invalid-artifact-type", `Unknown derived artifact type: ${type}`);
  if (graph.analysis?.cacheState?.status === "disabled") return { value: compute(), cache: { status: "disabled", reason: "cache-disabled", recordId: null, artifactStatus: "unavailable" } };
  const read = readArtifactCacheRegistry(root, graph.project.projectId);
  if (read.status === "invalid") return { value: compute(), cache: { status: "unavailable", reason: read.diagnostics[0].code, recordId: null, artifactStatus: "unavailable" } };
  const keyHash = fingerprint(key);
  const record = latestRecord(read.registry, type, keyHash);
  if (record && record.graphVersion === graph.state.graphVersion && record.sourceFingerprint === graph.state.sourceFingerprint) {
    const artifact = readArtifact(root, record);
    if (artifact.status === "valid") {
      appendEvent(read, event(type, keyHash, graph.state.graphVersion, "hit", "exact-current-source-basis", record.id, options.now));
      return { value: artifact.value, cache: { status: "hit", reason: "exact-current-source-basis", recordId: record.id, artifactStatus: "retained" } };
    }
  }
  const missReason = !record ? "no-matching-logical-artifact"
    : record.graphVersion !== graph.state.graphVersion ? "graph-version-changed"
      : record.sourceFingerprint !== graph.state.sourceFingerprint ? "source-fingerprint-changed"
        : readArtifact(root, record).reason;
  const value = compute();
  const dependencyPaths = normalizeDependencies(typeof options.dependencyPaths === "function" ? options.dependencyPaths(value) : options.dependencyPaths);
  const valueHash = fingerprint(value);
  const basis = require("./durable-brief").sourceBasis(graph);
  const recordBase = {
    schemaVersion: ARTIFACT_CACHE_SCHEMA,
    type,
    keyHash,
    projectIdentity: { projectId: graph.project.projectId },
    sourceBasis: basis,
    graphVersion: graph.state.graphVersion,
    sourceFingerprint: graph.state.sourceFingerprint,
    dependencyPaths,
    dependencyMode: "paths-plus-topology",
    versionBound: true,
    valueHash,
    createdAt: options.now || new Date().toISOString(),
  };
  const id = `derived-artifact:${fingerprint(recordBase).slice(7, 39)}`;
  const artifactRelativePath = `${ARTIFACT_CACHE_DIRECTORY_RELATIVE_PATH}/${type}/${id.slice("derived-artifact:".length)}.json`;
  const nextRecord = { ...recordBase, id, artifact: { relativePath: artifactRelativePath } };
  atomicWriteJson(path.join(root, artifactRelativePath), { schemaVersion: ARTIFACT_CACHE_SCHEMA, recordId: id, value });
  const records = read.registry.records.some((item) => item.id === id) ? read.registry.records : [...read.registry.records, nextRecord];
  appendEvent(read, event(type, keyHash, graph.state.graphVersion, "miss", missReason, id, options.now), records);
  return { value, cache: { status: "miss", reason: missReason, recordId: id, artifactStatus: "retained" } };
}

function invalidateArtifactCache(root, graph, changedPaths = [], options = {}) {
  const read = readArtifactCacheRegistry(root, graph.project.projectId);
  if (read.status === "invalid") return { status: "unavailable", events: [], diagnostics: read.diagnostics };
  const paths = new Set((changedPaths || []).map((item) => String(item).replaceAll("\\", "/")));
  const latestByKey = new Map();
  for (const record of read.registry.records) {
    const key = `${record.type}\u0000${record.keyHash}`;
    const previous = latestByKey.get(key);
    if (!previous || record.graphVersion > previous.graphVersion || record.createdAt > previous.createdAt) latestByKey.set(key, record);
  }
  const events = [];
  for (const record of latestByKey.values()) {
    if (record.graphVersion >= graph.state.graphVersion) continue;
    const pathAffected = record.dependencyPaths.includes("*") || record.dependencyPaths.some((item) => paths.has(item));
    const affected = Boolean(options.topologyChanged) || pathAffected;
    const status = affected ? "invalidated" : "retained-unaffected";
    const reason = options.topologyChanged ? "graph-topology-changed"
      : pathAffected ? "changed-path-intersects-dependencies" : "changed-paths-do-not-intersect-dependencies";
    events.push(event(record.type, record.keyHash, graph.state.graphVersion, status, reason, record.id, options.now));
  }
  if (events.length) {
    const allEvents = [...read.registry.events, ...events];
    const newlyOmitted = Math.max(allEvents.length - MAX_AUDIT_EVENTS, 0);
    const registryEvents = allEvents.slice(-MAX_AUDIT_EVENTS);
    atomicWriteJson(read.path, { ...read.registry, events: registryEvents, eventsOmitted: read.registry.eventsOmitted + newlyOmitted });
  }
  return { status: "available", events, diagnostics: [] };
}

function listArtifactCacheAudit(root, graph) {
  const read = readArtifactCacheRegistry(root, graph.project.projectId);
  if (read.status === "invalid") return { schemaVersion: ARTIFACT_CACHE_AUDIT_SCHEMA, status: "unavailable", records: [], events: [], diagnostics: read.diagnostics };
  const records = read.registry.records.map((record) => {
    const artifactStatus = fs.existsSync(path.join(root, record.artifact.relativePath)) ? "retained" : "expired";
    const freshnessStatus = record.graphVersion === graph.state.graphVersion && record.sourceFingerprint === graph.state.sourceFingerprint ? "current" : "stale";
    return { ...record, artifactStatus, freshnessStatus };
  });
  const counts = { hits: read.registry.events.filter((item) => item.status === "hit").length, misses: read.registry.events.filter((item) => item.status === "miss").length, invalidated: read.registry.events.filter((item) => item.status === "invalidated").length, retainedUnaffected: read.registry.events.filter((item) => item.status === "retained-unaffected").length, pruned: read.registry.events.filter((item) => item.status === "pruned").length };
  return {
    schemaVersion: ARTIFACT_CACHE_AUDIT_SCHEMA,
    status: "available",
    projectIdentity: { projectId: graph.project.projectId },
    sourceBasis: require("./durable-brief").sourceBasis(graph),
    graphVersion: graph.state.graphVersion,
    counts,
    totalArtifacts: records.length,
    records,
    events: [...read.registry.events].reverse(),
    eventCatalog: {
      total: read.registry.eventsOmitted + read.registry.events.length,
      returned: read.registry.events.length,
      omitted: read.registry.eventsOmitted,
      truncated: read.registry.eventsOmitted > 0,
      warning: read.registry.eventsOmitted > 0 ? "Older derived-cache audit events were omitted by bounded retention; artifact manifests remain available." : null,
    },
    diagnostics: [],
    policy: { staleReuse: "never-silent", exactHitRequires: ["projectId", "graphVersion", "sourceFingerprint", "artifact-integrity"], invalidation: "dependency-paths-plus-conservative-topology" },
  };
}

function relativeCachePath(root, target) {
  const value = path.relative(root, target).replaceAll("\\", "/");
  return value && !value.startsWith("../") && value !== ".." ? value : null;
}

function collectCacheFiles(root, target = path.join(root, ".flopeek")) {
  const result = { files: 0, bytes: 0, paths: [] };
  if (!fs.existsSync(target)) return result;
  const visit = (current) => {
    const entry = fs.lstatSync(current);
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      for (const child of fs.readdirSync(current)) visit(path.join(current, child));
      return;
    }
    if (!entry.isFile()) return;
    const relativePath = relativeCachePath(root, current);
    if (!relativePath) return;
    result.files += 1;
    result.bytes += entry.size;
    result.paths.push({ relativePath, bytes: entry.size });
  };
  visit(target);
  return result;
}

function bytesFor(root, relativePath) {
  const target = path.join(root, relativePath);
  try { return fs.lstatSync(target).isFile() ? fs.lstatSync(target).size : 0; } catch { return 0; }
}

function cacheHygiene(root, graph = null) {
  const cached = graph ? null : readGraphCacheResult(root);
  const cachedGraph = cached?.status === "valid" ? cached.graph : null;
  const activeGraph = graph || cachedGraph;
  const expectedProjectId = activeGraph?.project?.projectId || null;
  const read = readArtifactCacheRegistry(root, expectedProjectId);
  const all = collectCacheFiles(root);
  const deltaHistory = require("./graph-state").listGraphDeltaHistory(root);
  const paths = {
    graph: ".flopeek/graph.json",
    state: ".flopeek/state.json",
    registry: ARTIFACT_CACHE_REGISTRY_RELATIVE_PATH,
  };
  const artifacts = read.status === "valid"
    ? read.registry.records.map((record) => ({ id: record.id, relativePath: record.artifact.relativePath, bytes: bytesFor(root, record.artifact.relativePath), freshnessStatus: graph && record.graphVersion === graph.state.graphVersion && record.sourceFingerprint === graph.state.sourceFingerprint ? "current" : "stale" }))
    : [];
  const knownBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
  const userMetadataPaths = [
    ".flopeek/flow-verifications.json",
    ".flopeek/semantic-suggestion-feedback.json",
    ".flopeek/runtime-evidence.json",
    ".flopeek/test-runs.json",
    ".flopeek/descriptions.json",
  ];
  const userMetadata = userMetadataPaths
    .map((relativePath) => ({ relativePath, bytes: bytesFor(root, relativePath) }))
    .filter((item) => item.bytes > 0);
  const userMetadataBytes = userMetadata.reduce((total, item) => total + item.bytes, 0);
  const categorizedBytes = bytesFor(root, paths.graph) + bytesFor(root, paths.state) + bytesFor(root, paths.registry) + knownBytes + deltaHistory.storage.bytes + userMetadataBytes;
  return {
    schemaVersion: CACHE_HYGIENE_SCHEMA,
    status: read.status === "invalid" ? "unavailable" : "available",
    projectIdentity: read.status === "valid" ? { projectId: read.registry.projectId } : expectedProjectId ? { projectId: expectedProjectId } : null,
    currentGraph: activeGraph ? { graphVersion: activeGraph.state.graphVersion, sourceFingerprint: activeGraph.state.sourceFingerprint } : null,
    storage: {
      total: { files: all.files, bytes: all.bytes },
      graph: { relativePath: paths.graph, bytes: bytesFor(root, paths.graph) },
      state: { relativePath: paths.state, bytes: bytesFor(root, paths.state) },
      registry: { relativePath: paths.registry, bytes: bytesFor(root, paths.registry) },
      deltaHistory: {
        files: deltaHistory.storage.files,
        bytes: deltaHistory.storage.bytes,
        reclaimableFiles: deltaHistory.reclaimable.length,
        reclaimableBytes: deltaHistory.reclaimable.reduce((total, item) => total + item.bytes, 0),
        protectedLatest: deltaHistory.retained.find((item) => item.protected) || null,
        unknownFiles: deltaHistory.unknownFiles.length,
      },
      derivedArtifacts: { records: artifacts.length, retainedFiles: artifacts.filter((item) => item.bytes > 0).length, bytes: knownBytes, staleRecords: artifacts.filter((item) => item.freshnessStatus === "stale").length },
      userMetadata: { files: userMetadata.length, bytes: userMetadataBytes, paths: userMetadata },
      unclassifiedBytes: Math.max(all.bytes - categorizedBytes, 0),
    },
    retention: {
      policy: "manual-dry-run-first",
      defaultKeepRecordsPerLogicalArtifact: 4,
      deltaHistory: deltaHistory.policy,
      destructiveScope: "Derived artifacts and validated graph delta history require separate explicit prune selections. Current graph/state/project identity, user metadata, handoff, delivery, runtime, and unknown files are retained.",
      staleReuse: "never-silent",
    },
    diagnostics: read.diagnostics,
    limitation: "Cache hygiene measures local Flopeek metadata only. It neither proves cross-version artifact reuse nor deletes user metadata or unclassified files.",
  };
}

function pruneArtifactCache(root, options = {}) {
  const keepRecords = Math.min(Math.max(Number(options.keepRecords) || 4, 1), 50);
  const dryRun = Boolean(options.dryRun);
  const read = readArtifactCacheRegistry(root);
  if (read.status === "invalid") return { schemaVersion: CACHE_HYGIENE_SCHEMA, status: "unavailable", dryRun, pruned: [], retained: [], diagnostics: read.diagnostics };
  if (read.status === "missing") return { schemaVersion: CACHE_HYGIENE_SCHEMA, status: "available", dryRun, pruned: [], retained: [], diagnostics: [], limitation: "No derived-artifact registry exists." };
  const grouped = new Map();
  for (const record of read.registry.records) {
    const key = `${record.type}\u0000${record.keyHash}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  const prune = [];
  const retained = [];
  for (const records of grouped.values()) {
    records.sort((left, right) => right.graphVersion - left.graphVersion || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    retained.push(...records.slice(0, keepRecords));
    prune.push(...records.slice(keepRecords));
  }
  const safeArtifactPrefix = `${ARTIFACT_CACHE_DIRECTORY_RELATIVE_PATH}/`;
  const candidates = prune.filter((record) => record.artifact.relativePath.replaceAll("\\", "/").startsWith(safeArtifactPrefix));
  const pruned = candidates.map((record) => ({ id: record.id, type: record.type, relativePath: record.artifact.relativePath, bytes: bytesFor(root, record.artifact.relativePath) }));
  if (!dryRun && candidates.length) {
    for (const record of candidates) {
      const target = path.join(root, record.artifact.relativePath);
      if (fs.existsSync(target) && fs.lstatSync(target).isFile()) fs.unlinkSync(target);
    }
    const records = read.registry.records.filter((record) => !candidates.some((candidate) => candidate.id === record.id));
    const events = candidates.map((record) => event(record.type, record.keyHash, record.graphVersion, "pruned", "manual-retention-prune", record.id, options.now));
    const allEvents = [...read.registry.events, ...events];
    const newlyOmitted = Math.max(allEvents.length - MAX_AUDIT_EVENTS, 0);
    atomicWriteJson(read.path, { ...read.registry, records, events: allEvents.slice(-MAX_AUDIT_EVENTS), eventsOmitted: read.registry.eventsOmitted + newlyOmitted });
  }
  return {
    schemaVersion: CACHE_HYGIENE_SCHEMA,
    status: "available",
    dryRun,
    keepRecordsPerLogicalArtifact: keepRecords,
    pruned,
    retained: retained.map((record) => ({ id: record.id, type: record.type, relativePath: record.artifact.relativePath })),
    reclaimedBytes: pruned.reduce((total, item) => total + item.bytes, 0),
    limitation: "Pruning removes only older registered derived artifacts. It does not remove graph history, graph deltas, context records, handoffs, or unregistered files.",
    diagnostics: [],
  };
}

module.exports = {
  ARTIFACT_CACHE_AUDIT_SCHEMA,
  CACHE_HYGIENE_SCHEMA,
  ARTIFACT_CACHE_DIRECTORY_RELATIVE_PATH,
  ARTIFACT_CACHE_REGISTRY_RELATIVE_PATH,
  ARTIFACT_CACHE_REGISTRY_SCHEMA,
  ARTIFACT_CACHE_SCHEMA,
  ArtifactCacheError,
  getOrCreateArtifact,
  invalidateArtifactCache,
  cacheHygiene,
  listArtifactCacheAudit,
  pruneArtifactCache,
  readArtifactCacheRegistry,
};
