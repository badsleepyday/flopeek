"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { stableJson } = require("./core-compatibility");
const { createPublicGraphEnvelope, createRepositoryScanner, readDescriptions, structuralEntryFacts, structuralFileFacts, structuralImportFacts } = require("./scanner");

const STRUCTURAL_FACT_BATCH_SCHEMA = "flopeek-structural-fact-batch/v1";
const STRUCTURAL_FACT_PATCH_SCHEMA = "flopeek-structural-fact-patch/v1";
const SOURCE_BODY_KEYS = new Set(["content", "contents", "rawsource", "sourcebody", "sourcetext", "text"]);
const PREPARED_FACTS_CACHE = new WeakMap();

// StructuralFactBatch is a parser-to-native protocol, not a serialized parser
// cache. Keep its record payload deliberately narrower than `record.result`:
// every field here is consumed by Rust graph assembly or copied verbatim into
// public node metadata. `imports` retains only source-order specifiers because
// the native traversal contract uses that order; resolution and edge evidence
// are separately represented by resolvedImports/resolvedPackages/
// externalImports and record-local evidence. This avoids sending the same parser
// evidence twice without making JavaScript graph topology an input to native
// assembly.
function pickFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value, field))
    .map((field) => [field, value[field]]));
}

function projectArray(value, fields) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => pickFields(item, fields))
    .filter(Boolean);
}

function projectSymbol(symbol) {
  const projected = pickFields(symbol, ["type", "name", "methods", "evidence", "confidence"]);
  if (!projected) return null;
  const identity = pickFields(symbol.identity, ["qualifiedName", "signature", "discriminator"]);
  const lexicalOwner = pickFields(symbol.identity?.lexicalOwner, ["type", "name"]);
  if (identity) {
    if (lexicalOwner) identity.lexicalOwner = lexicalOwner;
    projected.identity = identity;
  }
  return projected;
}

function projectCall(call) {
  const projected = pickFields(call, ["name", "evidence"]);
  if (!projected) return null;
  const source = pickFields(call.source, ["type", "name"]);
  const imported = pickFields(call.imported, ["specifier", "exportedName"]);
  if (source) projected.source = source;
  if (imported) projected.imported = imported;
  return projected;
}

function projectRuntimeAction(action) {
  const projected = pickFields(action, ["instance", "type", "evidence"]);
  if (!projected) return null;
  const source = pickFields(action.source, ["type", "name"]);
  if (source) projected.source = source;
  return projected;
}

function projectStructuralResult(result, importFacts) {
  const raw = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  return {
    // `methods` remains whole because it is public symbol metadata, rather
    // than a graph-assembly-only parser detail.
    symbols: Array.isArray(raw.symbols) ? raw.symbols.map(projectSymbol).filter(Boolean) : [],
    identitySymbols: Array.isArray(raw.identitySymbols) ? raw.identitySymbols.map(projectSymbol).filter(Boolean) : [],
    imports: projectArray(raw.imports, ["specifier", "standard", "evidence"]),
    integrations: projectArray(raw.integrations, ["type", "instance", "label", "evidence", "package"]),
    endpoints: projectArray(raw.endpoints, ["method", "route", "handlerName", "handlerType", "detectedResponsibility", "evidence", "confidence", "contract"]),
    frameworkCommands: projectArray(raw.frameworkCommands, ["adapter", "commandName", "targetName", "targetType", "path"]),
    schedules: projectArray(raw.schedules, ["taskName", "evidence"]),
    calls: Array.isArray(raw.calls) ? raw.calls.map(projectCall).filter(Boolean) : [],
    runtimeActions: Array.isArray(raw.runtimeActions) ? raw.runtimeActions.map(projectRuntimeAction).filter(Boolean) : [],
    requests: projectArray(raw.requests, ["method", "route", "evidence"]),
    resolvedImports: importFacts.resolvedImports,
    resolvedPackages: importFacts.resolvedPackages,
    externalImports: importFacts.externalImports,
  };
}

function preparedFactsKey(prepared) {
  return stableJson({
    records: prepared.sourceRecords.map((record) => ({ relativePath: record.relativePath, sourceHash: record.sourceHash })),
    graphContext: prepared.graphContext,
    repositoryScope: prepared.repositoryScope,
    excludedPaths: prepared.excludedPaths,
  });
}

function recordFingerprints(prepared) {
  return new Map(prepared.sourceRecords.map((record) => [record.relativePath, stableJson({
    sourceHash: record.sourceHash,
    sourceScope: record.sourceScope,
    extension: record.extension,
    language: record.language,
  })]));
}

function incrementalImportReuse(cached, prepared) {
  // Import resolution is valid only while the resolver context and the whole
  // set of source paths are unchanged. Scanner preparation intentionally
  // replaces graphContext for manifests/configuration, Go/Rust package inputs,
  // additions, removals, and ambiguous changes, so its identity is a strict
  // invalidation boundary rather than a heuristic.
  if (!cached || cached.graphContext !== prepared.graphContext || !(cached.recordFingerprints instanceof Map)) return null;
  const current = recordFingerprints(prepared);
  if (current.size !== cached.recordFingerprints.size) return null;
  const changedRecords = [];
  for (const record of prepared.sourceRecords) {
    if (!cached.recordFingerprints.has(record.relativePath)) return null;
    if (cached.recordFingerprints.get(record.relativePath) !== current.get(record.relativePath)) changedRecords.push(record);
  }
  if (!cached.importFacts || !(cached.importFacts instanceof Map)) return null;
  return { changedRecords, current };
}

// Entry facts depend only on package-script targets and records that declare
// framework-command or scheduler evidence. Keep this narrow so uncertain
// changes always retain the complete derivation path.
function canReuseEntryFacts(cached, reusableImports) {
  if (!reusableImports || !cached?.preparedFacts?.entryFacts) return false;
  const packageTargets = new Set((cached.preparedFacts.entryFacts.packageCommands || [])
    .map((entry) => entry?.targetPath)
    .filter((value) => typeof value === "string" && value));
  return reusableImports.changedRecords.every((record) => {
    const result = record?.result || {};
    return !packageTargets.has(record?.relativePath)
      && !["frameworkCommands", "unsupportedFrameworkCommands", "schedules", "unsupportedSchedules"]
        .some((field) => Array.isArray(result[field]) && result[field].length > 0);
  });
}

function assertPortablePath(relativePath, field) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..")) {
    throw new TypeError(`${field} must be a portable repository-relative path.`);
  }
  return relativePath;
}

function assertNoSourceBodies(value, field = "batch", depth = 0) {
  if (depth > 100) throw new TypeError(`${field} exceeds the structural-fact nesting limit.`);
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSourceBodies(item, `${field}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") throw new TypeError(`${field} must be JSON-compatible.`);
  for (const [key, nested] of Object.entries(value)) {
    if (SOURCE_BODY_KEYS.has(key.toLowerCase())) throw new TypeError(`${field}.${key} is not allowed in StructuralFactBatch/v1.`);
    if (key.toLowerCase() === "source") {
      const keys = nested && typeof nested === "object" && !Array.isArray(nested) ? Object.keys(nested).sort() : [];
      const validReference = nested === null || keys.length === 2 && keys[0] === "name" && keys[1] === "type"
        && typeof nested.name === "string" && typeof nested.type === "string" && nested.name.length <= 240 && nested.type.length <= 80;
      if (!validReference) throw new TypeError(`${field}.source must be a structural symbol reference, never source text.`);
    }
    assertNoSourceBodies(nested, `${field}.${key}`, depth + 1);
  }
}

function structuralEvidenceKey(evidence) {
  return stableJson(evidence || null);
}

function resolvedInternalImports(graph, record) {
  const nodesById = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const importsByEvidence = new Map();
  for (const imported of record.result?.imports || []) {
    const key = structuralEvidenceKey(imported.evidence);
    if (!importsByEvidence.has(key)) importsByEvidence.set(key, []);
    importsByEvidence.get(key).push(imported.specifier);
  }
  const resolved = [];
  for (const edge of graph?.edges || []) {
    if (edge.type !== "imports" || edge.source !== `file:${record.relativePath}`) continue;
    const target = nodesById.get(edge.target);
    if (target?.kind !== "file" || typeof target.path !== "string") continue;
    for (const specifier of importsByEvidence.get(structuralEvidenceKey(edge.evidence)) || []) {
      resolved.push({ specifier, targetPath: assertPortablePath(target.path, "resolved import targetPath") });
    }
  }
  return resolved.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.targetPath.localeCompare(right.targetPath));
}

function externalImports(graph, record) {
  const nodesById = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const importsByEvidence = new Map();
  for (const imported of record.result?.imports || []) {
    const key = structuralEvidenceKey(imported.evidence);
    if (!importsByEvidence.has(key)) importsByEvidence.set(key, []);
    importsByEvidence.get(key).push(imported.specifier);
  }
  const resolved = [];
  for (const edge of graph?.edges || []) {
    if (edge.type !== "uses" || edge.source !== `file:${record.relativePath}`) continue;
    const target = nodesById.get(edge.target);
    if (target?.kind !== "external" || typeof target.type !== "string") continue;
    const { id: _id, kind: _kind, type: _type, path: _path, manualDescription: _manualDescription, ...metadata } = target;
    for (const specifier of importsByEvidence.get(structuralEvidenceKey(edge.evidence)) || []) {
      resolved.push({ specifier, nodeType: target.type, metadata });
    }
  }
  return resolved.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.nodeType.localeCompare(right.nodeType));
}

function packageCommands(graph) {
  return (graph?.nodes || [])
    .filter((node) => node.kind === "command" && node.entryKind === "package-script")
    .map((node) => ({ manifest: node.manifest, scriptName: node.scriptName, targetPath: node.targetPath }))
    .filter((command) => typeof command.manifest === "string" && typeof command.scriptName === "string" && typeof command.targetPath === "string")
    .sort((left, right) => left.manifest.localeCompare(right.manifest) || left.scriptName.localeCompare(right.scriptName));
}

function fileMetadata(graph, record) {
  const node = (graph?.nodes || []).find((candidate) => candidate.kind === "file" && candidate.path === record.relativePath);
  if (!node) throw new TypeError(`StructuralFactBatch/v1 cannot find file classification for ${record.relativePath}.`);
  const { id: _id, kind: _kind, type: _type, path: _path, ...metadata } = node;
  return metadata;
}

function entryMetadata(graph) {
  return Object.fromEntries((graph?.nodes || [])
    .filter((node) => ["command", "schedule"].includes(node.kind))
    .map((node) => {
      const { id, kind: _kind, type: _type, path: _path, ...metadata } = node;
      return [id, metadata];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

function edgeMetadata(graph) {
  return Object.fromEntries((graph?.edges || [])
    .map((edge) => [`${edge.source}\u0000${edge.target}\u0000${edge.type}`, { confidence: edge.confidence, evidence: edge.evidence }])
    .sort(([left], [right]) => left.localeCompare(right)));
}

// Manifest/framework/scheduler adapters create entry edges outside a normal
// parser record. Keep only those exceptional facts as a keyed map; all other
// edge evidence is reconstructed in Rust from the record-local facts that
// create the corresponding edge.
function entryEdgeMetadata(graph) {
  return Object.fromEntries((graph?.edges || [])
    .filter((edge) => ["declares-command-target", "schedules"].includes(edge.type))
    .map((edge) => [`${edge.source}\u0000${edge.target}\u0000${edge.type}`, { confidence: edge.confidence, evidence: edge.evidence }])
    .sort(([left], [right]) => left.localeCompare(right)));
}

// Authored descriptions are public user data, not parser facts. Keep the
// bridge intentionally narrow: Rust derives node metadata itself and receives
// only non-empty overrides that cannot be reconstructed from syntax facts.
function manualDescriptions(graph) {
  return Object.fromEntries((graph?.nodes || [])
    .filter((node) => ["symbol", "endpoint", "integration"].includes(node.kind)
      && typeof node.manualDescription === "string" && node.manualDescription.trim())
    .map((node) => [node.id, node.manualDescription])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function structuralManualDescriptions(root, sourceRecords) {
  const descriptions = readDescriptions(root);
  const allowed = new Set();
  for (const record of sourceRecords) {
    for (const symbol of record.result?.symbols || []) {
      if (symbol?.type && symbol?.name) allowed.add(`symbol:${record.relativePath}:${symbol.type}:${symbol.name}`);
    }
    for (const endpoint of record.result?.endpoints || []) {
      if (endpoint?.method && endpoint?.route) allowed.add(`endpoint:${record.relativePath}:${endpoint.method}:${endpoint.route}`);
    }
    for (const integration of record.result?.integrations || []) {
      if (integration?.type && integration?.instance) allowed.add(`runtime:${record.relativePath}:${integration.type}:${integration.instance}`);
    }
  }
  return Object.fromEntries(Object.entries(descriptions)
    .filter(([id, value]) => allowed.has(id) && typeof value === "string" && value.trim())
    .sort(([left], [right]) => left.localeCompare(right)));
}

function flowContext(graph) {
  const graphVersion = graph?.state?.graphVersion;
  if (!Number.isSafeInteger(graphVersion) || graphVersion < 0) throw new TypeError("StructuralFactBatch/v1 requires a non-negative graph.state.graphVersion for native flow queries.");
  return {
    graphVersion,
    sourceRevision: typeof graph?.state?.sourceRevision === "string" ? graph.state.sourceRevision : null,
  };
}

function lifecycleContext(graph) {
  const refresh = graph?.analysis?.refresh || {};
  return {
    sourceFingerprint: typeof graph?.state?.sourceFingerprint === "string" ? graph.state.sourceFingerprint : null,
    sourceRevision: typeof graph?.state?.sourceRevision === "string" ? graph.state.sourceRevision : null,
    updatedAt: typeof graph?.state?.updatedAt === "string" ? graph.state.updatedAt : null,
    refresh: {
      ...refresh,
      mode: typeof refresh.mode === "string" ? refresh.mode : "unknown",
      analyzedFiles: Number.isSafeInteger(refresh.analyzedFiles) ? refresh.analyzedFiles : 0,
      reusedFiles: Number.isSafeInteger(refresh.reusedFiles) ? refresh.reusedFiles : 0,
      removedFiles: Number.isSafeInteger(refresh.removedFiles) ? refresh.removedFiles : 0,
      changedPaths: Array.isArray(refresh.changedPaths) ? refresh.changedPaths.filter((item) => typeof item === "string").sort() : [],
    },
    coverage: graph?.analysis?.coverage || null,
  };
}

// This context contains public graph envelope metadata, not graph topology or
// source bodies. Nodes, edges, and flows remain native-assembled. Keeping it
// separate makes the remaining JavaScript-owned envelope fields explicit while
// compatibility projection migrates in bounded slices.
function publicGraphContext(graph) {
  return {
    schemaVersion: graph?.schemaVersion || null,
    generatedAt: graph?.generatedAt || null,
    project: graph?.project || null,
    state: graph?.state || null,
    analysis: graph?.analysis || null,
    stats: graph?.stats || null,
  };
}

function flowEntries(graph) {
  const primary = graph?.analysis?.repositoryScope?.flowEntries || {};
  return {
    primary: { tests: primary.tests === true, fixtures: primary.fixtures === true },
    diagnostic: { tests: true, fixtures: true },
  };
}

function recordProjection(record, recordOrder, resolvedImports = [], resolvedPackages = [], externalImportFacts = [], fileNodeType = "file", fileMetadataFact = null) {
  if (!record || typeof record !== "object") throw new TypeError("Structural fact record must be an object.");
  const importFacts = {
    resolvedImports,
    resolvedPackages,
    externalImports: externalImportFacts,
  };
  const projected = {
    // Parser-record order is a structural-fact input. The scanner canonicalizes
    // records by relative path before graph construction; preserve that exact
    // phase input without sending a node or edge topology projection.
    recordOrder,
    relativePath: assertPortablePath(record.relativePath, "record.relativePath"),
    extension: typeof record.extension === "string" ? record.extension : "",
    language: typeof record.language === "string" ? record.language : "unknown",
    sourceScope: typeof record.sourceScope === "string" ? record.sourceScope : "application",
    fileNodeType,
    fileMetadata: fileMetadataFact,
    sourceHash: typeof record.sourceHash === "string" ? record.sourceHash : null,
    result: projectStructuralResult(record.result, importFacts),
  };
  if (!projected.sourceHash || !/^[a-f0-9]{64}$/iu.test(projected.sourceHash)) throw new TypeError(`record.sourceHash for ${projected.relativePath} must be a SHA-256 digest.`);
  assertNoSourceBodies(projected.result, `record(${projected.relativePath}).result`);
  return projected;
}

function structuralFactBatchEnvelope(graph, options = {}) {
  if (!graph?.project?.projectId || typeof graph.project.projectId !== "string") throw new TypeError("StructuralFactBatch/v1 requires a graph with a project identity.");
  const entryFacts = options.entryFacts && typeof options.entryFacts === "object" ? options.entryFacts : null;
  return JSON.parse(JSON.stringify({
    schemaVersion: STRUCTURAL_FACT_BATCH_SCHEMA,
    projectId: graph.project.projectId,
    packageCommands: entryFacts?.packageCommands || packageCommands(graph),
    entryMetadata: entryFacts?.entryMetadata || entryMetadata(graph),
    entryEdgeMetadata: entryFacts?.edgeMetadata || entryEdgeMetadata(graph),
    manualDescriptions: options.manualDescriptions || manualDescriptions(graph),
    flowContext: flowContext(graph),
    flowEntries: flowEntries(graph),
    lifecycleContext: lifecycleContext(graph),
    publicGraphContext: publicGraphContext(graph),
  }));
}

function finalizeStructuralFactBatch(base) {
  // JSONL is the protocol boundary. Normalize through JSON before hashing so
  // JavaScript-only `undefined` values cannot affect factsDigest and then be
  // silently omitted by JSON.stringify on the wire.
  const wireBase = JSON.parse(JSON.stringify(base));
  const digestBase = {
    ...wireBase,
    lifecycleContext: { ...wireBase.lifecycleContext },
    flowContext: { ...wireBase.flowContext },
  };
  // Refresh telemetry and graph update time are observational rather than
  // material. Including either would turn a no-op scan into a new native graph
  // version when one persistent scanner transitions initial -> reconciled.
  delete digestBase.lifecycleContext.updatedAt;
  delete digestBase.lifecycleContext.refresh;
  // Native owns graph-version allocation during authoritative promotion. A
  // caller's previous public version is context for Context Refs, not a change
  // to the structural fact set.
  delete digestBase.flowContext.graphVersion;
  // Envelope metadata is persisted beside a promoted structural projection,
  // but it is not a structural fact and must not create a native graph version
  // on an otherwise no-op scan (for example, cache diagnostics may change).
  delete digestBase.publicGraphContext;
  return {
    ...wireBase,
    factsDigest: `sha256:${crypto.createHash("sha256").update(stableJson(digestBase)).digest("hex")}`,
  };
}

function projectPreparedRecord(record, recordOrder, preparedFacts) {
  const derived = preparedFacts?.importFacts?.get(record.relativePath);
  const file = preparedFacts?.fileFacts?.get(record.relativePath);
  return recordProjection(
    record,
    recordOrder,
    derived?.resolvedImports || [],
    derived?.resolvedPackages || [],
    derived?.externalImports || [],
    file?.fileNodeType || "file",
    file?.fileMetadata || null,
  );
}

function createStructuralFactBatch(graph, records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("StructuralFactBatch/v1 requires scanner records.");
  const importFacts = options.importFacts instanceof Map ? options.importFacts : null;
  const fileFacts = options.fileFacts instanceof Map ? options.fileFacts : null;
  const fileNodeTypes = new Map((graph.nodes || [])
    .filter((node) => node.kind === "file" && typeof node.path === "string" && typeof node.type === "string")
    .map((node) => [node.path, node.type]));
  const projectedRecords = records
    .map((record, recordOrder) => {
      const derived = importFacts?.get(record.relativePath);
      const file = fileFacts?.get(record.relativePath);
      return recordProjection(record, recordOrder, derived?.resolvedImports || resolvedInternalImports(graph, record), derived?.resolvedPackages || [], derived?.externalImports || externalImports(graph, record), file?.fileNodeType || fileNodeTypes.get(record.relativePath) || "file", file?.fileMetadata || fileMetadata(graph, record));
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (!projectedRecords.every((record) => Number.isSafeInteger(record.recordOrder) && record.recordOrder >= 0)) throw new TypeError("StructuralFactBatch/v1 requires each parser record to retain canonical parser order.");
  return finalizeStructuralFactBatch({ ...structuralFactBatchEnvelope(graph, options), records: projectedRecords });
}

function withNativePublicGraphVersion(batch, publicGraphVersion) {
  if (!Number.isSafeInteger(publicGraphVersion) || publicGraphVersion < 1) throw new TypeError("Native public graph version must be a positive safe integer.");
  const versioned = {
    ...batch,
    flowContext: { ...batch.flowContext, graphVersion: publicGraphVersion },
    publicGraphContext: {
      ...batch.publicGraphContext,
      state: { ...batch.publicGraphContext?.state, graphVersion: publicGraphVersion, status: "native-pending-promotion" },
    },
  };
  if (!versioned.publicGraphContext?.state) throw new TypeError("StructuralFactBatch/v1 requires publicGraphContext.state for native lifecycle.");
  return versioned;
}

// A patch is a transport optimization only.  It never becomes a second fact
// authority: Rust reconstructs the complete batch from the current SQLite
// graph-attached cache, verifies every manifest header, and recomputes the
// normal StructuralFactBatch digest before it can promote a graph.  Keep the
// full previous batch in this process as well because native query methods
// still accept the exact public fact contract during this migration stage.
function createStructuralFactPatch(baseBatch, nextBatch, options = {}) {
  if (!baseBatch || !nextBatch || baseBatch.schemaVersion !== STRUCTURAL_FACT_BATCH_SCHEMA
    || nextBatch.schemaVersion !== STRUCTURAL_FACT_BATCH_SCHEMA
    || baseBatch.projectId !== nextBatch.projectId
    || typeof baseBatch.factsDigest !== "string" || typeof nextBatch.factsDigest !== "string"
    || !Array.isArray(baseBatch.records) || !Array.isArray(nextBatch.records)) return null;
  const previousByPath = new Map(baseBatch.records.map((record) => [record?.relativePath, record]));
  if (previousByPath.size !== baseBatch.records.length || [...previousByPath.keys()].some((path) => typeof path !== "string" || !path)) return null;
  const changedRecords = [];
  const manifest = [];
  for (const record of nextBatch.records) {
    if (!record || typeof record.relativePath !== "string" || !record.relativePath
      || typeof record.sourceHash !== "string" || typeof record.sourceScope !== "string"
      || !Number.isSafeInteger(record.recordOrder) || record.recordOrder < 0) return null;
    manifest.push({
      relativePath: record.relativePath,
      sourceHash: record.sourceHash,
      sourceScope: record.sourceScope,
      recordOrder: record.recordOrder,
    });
    const previous = previousByPath.get(record.relativePath);
    const sameHeader = previous?.sourceHash === record.sourceHash
      && previous?.sourceScope === record.sourceScope
      && previous?.recordOrder === record.recordOrder;
    // The scanner replaces graphContext for every resolver-affecting input.
    // With the same exact context and record header, parser and resolver facts
    // are deterministic, so avoid serializing every unchanged multi-megabyte
    // record merely to decide that it remains cacheable.  A context change,
    // addition, or deletion always takes the strict full-record comparison.
    const unchanged = options.graphContextUnchanged === true && sameHeader
      ? true
      : stableJson(previous) === stableJson(record);
    if (!unchanged) changedRecords.push(record);
  }
  if (new Set(manifest.map((record) => record.relativePath)).size !== manifest.length) return null;
  const batch = { ...nextBatch };
  delete batch.records;
  delete batch.factsDigest;
  return JSON.parse(JSON.stringify({
    schemaVersion: STRUCTURAL_FACT_PATCH_SCHEMA,
    projectId: nextBatch.projectId,
    baseFactsDigest: baseBatch.factsDigest,
    expectedFactsDigest: nextBatch.factsDigest,
    manifest,
    changedRecords,
    batch,
  }));
}

function createStructuralFactPatchFromPrepared(baseBatch, graph, prepared, preparedFacts, options = {}) {
  if (!baseBatch || baseBatch.schemaVersion !== STRUCTURAL_FACT_BATCH_SCHEMA
    || !Array.isArray(baseBatch.records) || baseBatch.projectId !== graph?.project?.projectId
    || typeof baseBatch.factsDigest !== "string" || !Array.isArray(prepared?.sourceRecords)) return null;
  const previousByPath = new Map(baseBatch.records.map((record) => [record?.relativePath, record]));
  if (previousByPath.size !== baseBatch.records.length || [...previousByPath.keys()].some((value) => typeof value !== "string" || !value)) return null;
  const manifest = [];
  const changedRecords = [];
  for (const [recordOrder, record] of prepared.sourceRecords.entries()) {
    const header = {
      relativePath: record?.relativePath,
      sourceHash: record?.sourceHash,
      sourceScope: record?.sourceScope,
      recordOrder,
    };
    if (typeof header.relativePath !== "string" || !header.relativePath || typeof header.sourceHash !== "string"
      || typeof header.sourceScope !== "string") return null;
    manifest.push(header);
    const previous = previousByPath.get(header.relativePath);
    const sameHeader = previous?.sourceHash === header.sourceHash
      && previous?.sourceScope === header.sourceScope
      && previous?.recordOrder === header.recordOrder;
    if (options.graphContextUnchanged === true && sameHeader) continue;
    const projected = projectPreparedRecord(record, recordOrder, preparedFacts);
    if (stableJson(previous) !== stableJson(projected)) changedRecords.push(projected);
  }
  if (new Set(manifest.map((record) => record.relativePath)).size !== manifest.length) return null;
  return {
    schemaVersion: STRUCTURAL_FACT_PATCH_SCHEMA,
    projectId: baseBatch.projectId,
    baseFactsDigest: baseBatch.factsDigest,
    manifest,
    changedRecords,
    batch: structuralFactBatchEnvelope(graph, { entryFacts: preparedFacts?.entryFacts, manualDescriptions: preparedFacts?.manualDescriptions }),
  };
}

function materializeStructuralFactPatch(baseBatch, patch, factsDigest) {
  if (!baseBatch || !patch || patch.schemaVersion !== STRUCTURAL_FACT_PATCH_SCHEMA
    || patch.baseFactsDigest !== baseBatch.factsDigest || patch.projectId !== baseBatch.projectId
    || typeof factsDigest !== "string" || !Array.isArray(baseBatch.records) || !Array.isArray(patch.manifest) || !Array.isArray(patch.changedRecords)) {
    throw new TypeError("Structural fact patch cannot materialize a verified batch.");
  }
  const previousByPath = new Map(baseBatch.records.map((record) => [record.relativePath, record]));
  const changedByPath = new Map(patch.changedRecords.map((record) => [record?.relativePath, record]));
  if (changedByPath.size !== patch.changedRecords.length) throw new TypeError("Structural fact patch repeats changed records.");
  const records = patch.manifest.map((header) => {
    const record = changedByPath.get(header?.relativePath) || previousByPath.get(header?.relativePath);
    if (!record || record.relativePath !== header.relativePath || record.sourceHash !== header.sourceHash
      || record.sourceScope !== header.sourceScope || record.recordOrder !== header.recordOrder) {
      throw new TypeError("Structural fact patch manifest does not match local records.");
    }
    return record;
  });
  if (new Set(records.map((record) => record.relativePath)).size !== records.length) throw new TypeError("Structural fact patch repeats manifest paths.");
  return { ...patch.batch, records, factsDigest };
}

function createStructuralFactBatchFromPrepared(graph, prepared, preparedFacts = null) {
  if (!prepared || typeof prepared.root !== "string" || !Array.isArray(prepared.sourceRecords) || !prepared.graphContext) {
    throw new TypeError("StructuralFactBatch/v1 prepared input requires scanner root, sourceRecords, and graphContext.");
  }
  const facts = preparedFacts || {
    importFacts: structuralImportFacts(prepared.sourceRecords, prepared.graphContext),
    entryFacts: structuralEntryFacts(prepared.root, prepared.sourceRecords),
    fileFacts: structuralFileFacts(prepared.root, prepared.sourceRecords),
    manualDescriptions: structuralManualDescriptions(prepared.root, prepared.sourceRecords),
  };
  const records = prepared.sourceRecords.map((record, recordOrder) => projectPreparedRecord(record, recordOrder, facts));
  return finalizeStructuralFactBatch({ ...structuralFactBatchEnvelope(graph, { entryFacts: facts.entryFacts, manualDescriptions: facts.manualDescriptions }), records });
}

function prepareStructuralFactBatch(scanner, changedPaths = null, options = {}) {
  if (!scanner || typeof scanner.prepare !== "function") throw new TypeError("Structural fact preparation requires a repository scanner.");
  const profile = typeof options.onProfile === "function" ? options.onProfile : null;
  const timed = (phase, action, extra = {}) => {
    const started = process.hrtime.bigint();
    const result = action();
    profile?.({ phase, milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000, ...extra });
    return result;
  };
  const prepared = scanner.prepare(changedPaths);
  const key = preparedFactsKey(prepared);
  const cached = PREPARED_FACTS_CACHE.get(scanner);
  let preparedFacts;
  if (cached?.key === key) {
    // Manual descriptions are human-authored side metadata and may change
    // without a source-file fingerprint change. Keep that narrow field fresh;
    // parser-derived facts remain valid for the same records/context.
    preparedFacts = {
      ...cached.preparedFacts,
      manualDescriptions: timed("native-fact-manual-descriptions", () => structuralManualDescriptions(prepared.root, prepared.sourceRecords), { cache: "reused" }),
    };
  } else {
    const reusableImports = incrementalImportReuse(cached, prepared);
    const importFacts = reusableImports
      ? timed("native-fact-import-resolution", () => {
        const facts = new Map(cached.importFacts);
        const changedFacts = structuralImportFacts(
          reusableImports.changedRecords,
          prepared.graphContext,
          { knownPaths: new Set(prepared.sourceRecords.map((record) => record.relativePath)), onProfile: profile },
        );
        for (const [relativePath, fact] of changedFacts) facts.set(relativePath, fact);
        return facts;
      }, {
        cache: "incremental",
        recomputedFiles: reusableImports.changedRecords.length,
        reusedFiles: prepared.sourceRecords.length - reusableImports.changedRecords.length,
      })
      : timed("native-fact-import-resolution", () => structuralImportFacts(prepared.sourceRecords, prepared.graphContext, { onProfile: profile }), { cache: "miss" });
    const reusableEntryFacts = canReuseEntryFacts(cached, reusableImports);
    const entryFacts = reusableEntryFacts
      ? timed("native-fact-entry-analysis", () => cached.preparedFacts.entryFacts, {
        cache: "incremental",
        recomputedFiles: 0,
        reusedFiles: prepared.sourceRecords.length,
      })
      : timed("native-fact-entry-analysis", () => structuralEntryFacts(prepared.root, prepared.sourceRecords), { cache: "miss" });
    preparedFacts = {
      importFacts,
      entryFacts,
      fileFacts: timed("native-fact-file-metadata", () => structuralFileFacts(prepared.root, prepared.sourceRecords), { cache: "miss" }),
      manualDescriptions: timed("native-fact-manual-descriptions", () => structuralManualDescriptions(prepared.root, prepared.sourceRecords), { cache: "miss" }),
    };
    PREPARED_FACTS_CACHE.set(scanner, {
      key,
      graphContext: prepared.graphContext,
      importFacts,
      recordFingerprints: reusableImports?.current || recordFingerprints(prepared),
      preparedFacts: { ...preparedFacts, manualDescriptions: null },
    });
  }
  const { entryFacts } = preparedFacts;
  const publicEnvelope = timed("native-fact-public-envelope", () => createPublicGraphEnvelope(prepared, entryFacts));
  const batch = options.buildBatch === false
    ? null
    : timed("native-fact-batch-serialization", () => createStructuralFactBatchFromPrepared(publicEnvelope, prepared, preparedFacts));
  return { prepared, batch, preparedFacts, publicEnvelope };
}

async function submitStructuralFactBatch(client, root, options = {}) {
  const scanner = createRepositoryScanner(root, options.scanner || {});
  const { prepared, batch, publicEnvelope } = prepareStructuralFactBatch(scanner, options.changedPaths);
  const receipt = await client.request("submitStructuralFacts", batch);
  // Native consumes the prepared envelope before JavaScript assembly. Shadow
  // mode still assembles JS afterwards as the compatibility oracle, but native
  // work itself is no longer blocked on an oracle topology build.
  const graph = scanner.assemble(prepared, publicEnvelope);
  return { graph, batch, prepared, receipt };
}

module.exports = {
  SOURCE_BODY_KEYS,
  STRUCTURAL_FACT_BATCH_SCHEMA,
  STRUCTURAL_FACT_PATCH_SCHEMA,
  assertNoSourceBodies,
  canReuseEntryFacts,
  createStructuralFactPatch,
  createStructuralFactPatchFromPrepared,
  createStructuralFactBatch,
  createStructuralFactBatchFromPrepared,
  finalizeStructuralFactBatch,
  structuralFactBatchEnvelope,
  materializeStructuralFactPatch,
  withNativePublicGraphVersion,
  externalImports,
  entryMetadata,
  edgeMetadata,
  entryEdgeMetadata,
  fileMetadata,
  flowContext,
  flowEntries,
  lifecycleContext,
  manualDescriptions,
  prepareStructuralFactBatch,
  structuralManualDescriptions,
  packageCommands,
  publicGraphContext,
  resolvedInternalImports,
  submitStructuralFactBatch,
};
