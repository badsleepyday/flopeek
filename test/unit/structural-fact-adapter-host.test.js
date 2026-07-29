"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPublicGraphEnvelope, createRepositoryScanner, structuralEntryFacts } = require("../../src/scanner");
const {
  STRUCTURAL_FACT_BATCH_SCHEMA,
  STRUCTURAL_FACT_PATCH_SCHEMA,
  assertNoSourceBodies,
  createStructuralFactBatch,
  createStructuralFactPatch,
  createStructuralFactBatchFromPrepared,
  prepareStructuralFactBatch,
} = require("../../src/structural-fact-adapter-host");

const ROOT = path.resolve(__dirname, "..", "..");
const CORE_BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "js-core-baseline.json"), "utf8"));

test("StructuralFactBatch projects parser records without source bodies", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const graph = scanner.scan();
  const batch = createStructuralFactBatch(graph, scanner.snapshotRecords());
  assert.equal(batch.schemaVersion, STRUCTURAL_FACT_BATCH_SCHEMA);
  assert.equal(Object.hasOwn(batch, "nodeMetadata"), false);
  assert.equal(batch.projectId, graph.project.projectId);
  assert.equal(batch.flowContext.graphVersion, graph.state.graphVersion);
  assert.equal(batch.lifecycleContext.sourceFingerprint, graph.state.sourceFingerprint);
  assert.equal(batch.lifecycleContext.sourceRevision, graph.state.sourceRevision || null);
  assert.equal(batch.lifecycleContext.refresh.mode, graph.analysis.refresh.mode);
  assert.deepEqual(batch.lifecycleContext.refresh.changedPaths, [...(graph.analysis.refresh.changedPaths || [])].sort());
  assert.equal(batch.records.length, graph.stats.scannedFiles);
  assert.deepEqual([...batch.records].map((record) => record.recordOrder).sort((left, right) => left - right), Array.from({ length: batch.records.length }, (_, index) => index));
  assert.ok(batch.records.every((record) => typeof record.fileNodeType === "string" && record.fileNodeType));
  assert.ok(batch.records.every((record) => record.fileMetadata && typeof record.fileMetadata.label === "string"));
  assert.deepEqual(batch.publicGraphContext.stats, graph.stats);
  assert.ok(batch.factsDigest.startsWith("sha256:"));
  assert.equal(Object.hasOwn(batch, "canonicalTopologyOrder"), false, "Rust canonicalization must not receive a JavaScript graph order.");
  assert.equal(Object.hasOwn(batch, "flowTraversalOrder"), false, "Native traversal ordering must be derived from StructuralFactBatch facts, never a JavaScript graph order.");
  assertNoSourceBodies(batch.records);
  assertNoSourceBodies(batch.lifecycleContext);
  assert.deepEqual(batch.records.map((record) => record.relativePath), [...batch.records.map((record) => record.relativePath)].sort());
  const orderRoutes = batch.records.find((record) => record.relativePath === "src/orders/orders.routes.ts");
  assert.ok(orderRoutes?.result.resolvedImports?.some((resolved) => resolved.targetPath === "src/orders/orders.service.ts"));
});

test("StructuralFactBatch sends only native-consumed record facts after JavaScript resolves imports", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const batch = createStructuralFactBatch(scanner.scan(), scanner.snapshotRecords());
  const allowed = [
    "calls",
    "endpoints",
    "externalImports",
    "frameworkCommands",
    "integrations",
    "imports",
    "requests",
    "resolvedImports",
    "resolvedPackages",
    "runtimeActions",
    "schedules",
    "symbols",
  ].sort();
  for (const record of batch.records) {
    assert.deepEqual(Object.keys(record.result).sort(), allowed, record.relativePath);
    assert.ok(record.result.imports.every((item) => Object.keys(item).every((key) => ["specifier", "standard", "evidence"].includes(key))), `${record.relativePath} import wire facts must carry only traversal and edge-evidence fields`);
  }
  const service = batch.records.find((record) => record.relativePath === "src/orders/orders.service.ts");
  const call = service?.result.calls.find((item) => item.name === "validateOrder");
  assert.deepEqual({
    name: call?.name,
    source: call?.source,
    imported: call?.imported,
    evidence: call?.evidence?.file,
  }, {
    name: "validateOrder",
    source: { type: "class", name: "OrdersService" },
    imported: { specifier: "./validation", exportedName: "validateOrder" },
    evidence: "src/orders/orders.service.ts",
  });
});

test("StructuralFactBatch carries only non-empty authored descriptions outside parser facts", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const graph = scanner.scan();
  const symbol = graph.nodes.find((node) => node.kind === "symbol");
  assert.ok(symbol);
  symbol.manualDescription = "Reviewed by a maintainer.";
  const batch = createStructuralFactBatch(graph, scanner.snapshotRecords());
  assert.deepEqual(batch.manualDescriptions, { [symbol.id]: "Reviewed by a maintainer." });
});

test("StructuralFactBatch factsDigest ignores operational refresh telemetry", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const graph = scanner.scan();
  const baseline = createStructuralFactBatch(graph, scanner.snapshotRecords());
  const refreshed = createStructuralFactBatch({
    ...graph,
    analysis: {
      ...graph.analysis,
      refresh: { ...graph.analysis.refresh, mode: "reconciled", analyzedFiles: 0, reusedFiles: graph.stats.scannedFiles, changedPaths: [] },
    },
  }, scanner.snapshotRecords());
  assert.equal(refreshed.factsDigest, baseline.factsDigest);
});

test("StructuralFactBatch patch carries a complete manifest but only changed record payloads", (context) => {
  const fixtureRoot = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-structural-fact-patch-"));
  fs.cpSync(fixtureRoot, root, { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const first = prepareStructuralFactBatch(scanner);
  const target = path.join(root, "src", "orders", "orders.service.ts");
  fs.appendFileSync(target, "\n");
  const second = prepareStructuralFactBatch(scanner, ["src/orders/orders.service.ts"]);
  const patch = createStructuralFactPatch(first.batch, second.batch);
  assert.equal(patch?.schemaVersion, STRUCTURAL_FACT_PATCH_SCHEMA);
  assert.equal(patch?.baseFactsDigest, first.batch.factsDigest);
  assert.equal(patch?.expectedFactsDigest, second.batch.factsDigest);
  assert.equal(patch?.manifest.length, second.batch.records.length);
  assert.deepEqual(patch?.changedRecords.map((record) => record.relativePath), ["src/orders/orders.service.ts"]);
  assert.equal(Object.hasOwn(patch?.batch || {}, "records"), false);
  assert.equal(Object.hasOwn(patch?.batch || {}, "factsDigest"), false);
  assertNoSourceBodies(patch.changedRecords);
});

test("prepared StructuralFactBatch reuses static facts without carrying refresh telemetry forward", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const first = prepareStructuralFactBatch(scanner);
  const second = prepareStructuralFactBatch(scanner);
  assert.equal(second.prepared.refresh.mode, "reconciled");
  assert.equal(second.batch.factsDigest, first.batch.factsDigest);
  assert.deepEqual(second.batch.records, first.batch.records);
  assert.deepEqual(second.batch.entryEdgeMetadata, first.batch.entryEdgeMetadata);
  assert.deepEqual(second.batch.manualDescriptions, first.batch.manualDescriptions);
});

test("prepared StructuralFactBatch reuses unchanged import facts only for a content-only refresh", (context) => {
  const fixtureRoot = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-incremental-import-facts-"));
  fs.cpSync(fixtureRoot, root, { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  prepareStructuralFactBatch(scanner);
  const servicePath = path.join(root, "src", "orders", "orders.service.ts");
  fs.writeFileSync(servicePath, fs.readFileSync(servicePath, "utf8")
    .replace(/import \{ validateOrder \} from "\.\/validation";\r?\n/, "")
    .replace(/    validateOrder\(\);\r?\n/, ""));

  const profile = [];
  const refreshed = prepareStructuralFactBatch(scanner, ["src/orders/orders.service.ts"], {
    onProfile: (event) => profile.push(event),
  });
  const importResolution = profile.find((event) => event.phase === "native-fact-import-resolution");
  assert.deepEqual(importResolution && {
    cache: importResolution.cache,
    recomputedFiles: importResolution.recomputedFiles,
    reusedFiles: importResolution.reusedFiles,
  }, {
    cache: "incremental",
    recomputedFiles: 1,
    reusedFiles: refreshed.prepared.sourceRecords.length - 1,
  });
  const entryAnalysis = profile.find((event) => event.phase === "native-fact-entry-analysis");
  assert.deepEqual(entryAnalysis && {
    cache: entryAnalysis.cache,
    recomputedFiles: entryAnalysis.recomputedFiles,
    reusedFiles: entryAnalysis.reusedFiles,
  }, {
    cache: "incremental",
    recomputedFiles: 0,
    reusedFiles: refreshed.prepared.sourceRecords.length,
  });
  assert.deepEqual(refreshed.batch, createStructuralFactBatchFromPrepared(refreshed.publicEnvelope, refreshed.prepared));
});

test("prepared StructuralFactBatch invalidates import reuse when resolver configuration changes", (context) => {
  const fixtureRoot = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-import-context-invalidation-"));
  fs.cpSync(fixtureRoot, root, { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  prepareStructuralFactBatch(scanner);
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.private = true;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const profile = [];
  const refreshed = prepareStructuralFactBatch(scanner, ["package.json"], {
    onProfile: (event) => profile.push(event),
  });
  const importResolution = profile.find((event) => event.phase === "native-fact-import-resolution");
  assert.equal(importResolution?.cache, "miss");
  assert.deepEqual(refreshed.batch, createStructuralFactBatchFromPrepared(refreshed.publicEnvelope, refreshed.prepared));
});

test("StructuralFactBatch derives import, file, entry, and edge facts from prepared state without graph edges or nodes", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const prepared = scanner.prepare();
  const graph = scanner.assemble(prepared);
  const legacy = createStructuralFactBatch(graph, scanner.snapshotRecords());
  const derived = createStructuralFactBatchFromPrepared(graph, prepared);
  assert.deepEqual(derived, legacy);
});

test("prepared import, file, entry, and edge facts match graph-derived facts across the compatibility corpus", () => {
  for (const fixture of CORE_BASELINE.cases) {
    const scanner = createRepositoryScanner(path.join(ROOT, fixture.fixture), { persistIdentity: false });
    const prepared = scanner.prepare();
    const graph = scanner.assemble(prepared);
    assert.deepEqual(
      createStructuralFactBatchFromPrepared(graph, prepared),
      createStructuralFactBatch(graph, scanner.snapshotRecords()),
      fixture.id,
    );
  }
});

test("prepared StructuralFactBatch does not read JavaScript graph topology", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const prepared = scanner.prepare();
  const graph = scanner.assemble(prepared);
  const envelopeOnly = { ...graph, nodes: [], edges: [], flows: [] };
  assert.deepEqual(
    createStructuralFactBatchFromPrepared(envelopeOnly, prepared),
    createStructuralFactBatchFromPrepared(graph, prepared),
  );
});

test("prepared StructuralFactBatch accepts a topology-free public envelope", () => {
  const root = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const prepared = scanner.prepare();
  const entryFacts = structuralEntryFacts(prepared.root, prepared.sourceRecords);
  const envelope = createPublicGraphEnvelope(prepared, entryFacts);
  const batch = createStructuralFactBatchFromPrepared(envelope, prepared, { entryFacts });
  assert.deepEqual(batch.publicGraphContext, {
    schemaVersion: envelope.schemaVersion,
    generatedAt: envelope.generatedAt,
    project: envelope.project,
    state: envelope.state,
    analysis: envelope.analysis,
    stats: envelope.stats,
  });
  assert.equal(Object.hasOwn(batch.publicGraphContext, "nodes"), false);
});

test("StructuralFactBatch rejects an attempted source body", () => {
  assert.throws(() => assertNoSourceBodies({ nested: { sourceBody: "export const secret = true;" } }), /not allowed/);
});

test("StructuralFactBatch exposes only narrow package-script manifest facts", () => {
  const root = path.join(ROOT, "test", "fixtures", "package-script-flow");
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const batch = createStructuralFactBatch(scanner.scan(), scanner.snapshotRecords());
  assert.deepEqual(batch.packageCommands, [{
    manifest: "package.json",
    scriptName: "serve",
    targetPath: "src/main.ts",
  }]);
  assertNoSourceBodies(batch.packageCommands);
});
