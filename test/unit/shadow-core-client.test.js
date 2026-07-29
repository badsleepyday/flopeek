"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeProtocolClient } = require("../../src/native-protocol-client");
const { compareStructuralProjection, createShadowCoreClient } = require("../../src/shadow-core-client");
const { createStructuralFactBatch } = require("../../src/structural-fact-adapter-host");
const { createRepositoryScanner } = require("../../src/scanner");
const { getRelatedTests } = require("../../src/graph-service");
const { getChangeImpact } = require("../../src/graph-service");
const { getChangedContexts } = require("../../src/graph-service");
const { resolveContextRef } = require("../../src/graph-service");
const { getFlowProjection } = require("../../src/flow-lens");
const { createNodeContextCard, resolveContextRef: resolveContextCardRef } = require("../../src/context-card");
const { createFlowContextCard } = require("../../src/flow-context-card");
const { getNodeDetails } = require("../../src/graph-service");
const { createContextRef } = require("../../src/context-card");
const { createGraphDelta } = require("../../src/graph-state");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");
const CORE_BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "js-core-baseline.json"), "utf8"));
const STRUCTURAL_NODE_KINDS = new Set(["file", "symbol", "endpoint", "integration", "external", "command", "schedule"]);

function nativeClient() {
  return new NativeProtocolClient({
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", MANIFEST, "--"],
    cwd: ROOT,
    requestTimeoutMs: 30_000,
  });
}

function nativePublicSnapshot(graph) {
  return {
    schemaVersion: graph.schemaVersion,
    generatedAt: graph.generatedAt,
    project: JSON.parse(JSON.stringify(graph.project)),
    state: JSON.parse(JSON.stringify(graph.state)),
    analysis: JSON.parse(JSON.stringify(graph.analysis)),
    stats: JSON.parse(JSON.stringify(graph.stats)),
    nodes: JSON.parse(JSON.stringify(graph.nodes)),
    edges: JSON.parse(JSON.stringify(graph.edges)),
    flows: JSON.parse(JSON.stringify(graph.flows)),
    diagnosticFlows: JSON.parse(JSON.stringify(graph.diagnosticFlows)),
  };
}

test("ShadowCoreClient returns the JS graph only after exact native structural comparison", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-shadow-core-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".flopeek"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "shadow-core-fixture" }), "utf8");
  fs.writeFileSync(path.join(root, ".flopeek", "descriptions.json"), JSON.stringify({
    "symbol:src/helpers.ts:function:helper": "Reviewed helper behavior.",
  }), "utf8");
  fs.writeFileSync(path.join(root, "src", "helpers.ts"), "export function helper() {}\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "orders.ts"), [
    "import { PrismaClient } from '@prisma/client';",
    "import { helper } from './helpers';",
    "const prisma = new PrismaClient();",
    "export function submit() { helper(); prisma.order.create({ data: {} }); }",
  ].join("\n"), "utf8");
  const client = createShadowCoreClient({
    native: nativeClient(),
    persistStructuralGraph: true,
  });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const graph = await client.scan(root);
  assert.equal(graph.project.name, "shadow-core-fixture");
  const firstStoreReceipt = client.getLastNativeStoreReceipt();
  assert.equal(firstStoreReceipt.schemaVersion, "flopeek-native-shadow-store-receipt/v1");
  assert.equal(firstStoreReceipt.stored, true);
  assert.equal(firstStoreReceipt.status, "promoted");
  assert.equal(firstStoreReceipt.graphVersion, 1);
  assert.match(firstStoreReceipt.projectionDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(firstStoreReceipt.factsDigest, /^sha256:[a-f0-9]{64}$/);
  const snapshot = await client.getNativePublicGraphSnapshot(graph);
  assert.equal(snapshot.schemaVersion, "flopeek-native-public-graph-snapshot/v1");
  assert.deepEqual(snapshot.graph, nativePublicSnapshot(graph));
  await client.scan(root);
  assert.equal(client.getLastNativeStoreReceipt().status, "reused");
  assert.equal(client.getLastNativeStoreReceipt().graphVersion, 1);
  assert.deepEqual(client.getLastShadowComparison(), {
    schemaVersion: "flopeek-shadow-structural-comparison/v1",
    mode: "structural-subset",
    status: "exact-match",
    expected: { nodeCount: 6, edgeCount: 9 },
    actual: { nodeCount: 6, edgeCount: 9 },
    mismatch: null,
    limitation: "This compares only the native structural shadow subset. It is not flopeek-core-compatibility/v1 graph, lifecycle, Context Ref, or query parity.",
  });
});

test("StructuralFactBatch persists a router entry fixture without query parameters changing its digest", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-canonical-router-"));
  fs.mkdirSync(path.join(root, "src", "orders"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "native-canonical-router-fixture" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "orders", "orders.routes.ts"), "import { OrdersService } from './orders.service';\nrouter.post('/orders', OrdersService.create);\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "orders", "orders.service.ts"), "export class OrdersService { static create() { return true; } }\n", "utf8");
  const client = nativeClient();
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scanner = createRepositoryScanner(root);
  const graph = scanner.scan();
  const batch = createStructuralFactBatch(graph, scanner.snapshotRecords());
  await client.start();
  await client.request("persistStructuralGraph", { ...batch, projectRoot: root });
});

test("all eleven JavaScript compatibility fixtures match the native structural shadow subset", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  const comparisons = [];
  for (const fixture of CORE_BASELINE.cases) {
    await client.scan(path.join(ROOT, fixture.fixture));
    comparisons.push({ id: fixture.id, status: client.getLastShadowComparison().status });
  }
  assert.equal(CORE_BASELINE.cases.length, 11);
  assert.deepEqual(comparisons, CORE_BASELINE.cases.map((fixture) => ({ id: fixture.id, status: "exact-match" })));
});

test("native public graph snapshots match the raw JavaScript contract across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient(), persistStructuralGraph: true });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    const snapshot = await client.getNativePublicGraphSnapshot(graph);
    assert.deepEqual(snapshot.graph, nativePublicSnapshot(graph), fixture.id);
  }
});

test("ephemeral native public graphs match JavaScript without SQLite persistence", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    const nativeGraph = await client.getNativeEphemeralPublicGraph(graph);
    assert.equal(nativeGraph.schemaVersion, "flopeek-native-public-graph/v1");
    assert.equal(nativeGraph.persistence, "ephemeral-jsonl-only");
    assert.deepEqual(nativeGraph.graph, nativePublicSnapshot(graph), fixture.id);
  }
});

test("native related-test query matches the JavaScript contract across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  const comparisons = [];
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    const candidates = graph.nodes
      .map((node) => ({ node, expected: getRelatedTests(graph, node.id) }))
      .filter((candidate) => candidate.expected?.relatedTests.length);
    const candidate = candidates[0] || { node: graph.nodes[0], expected: getRelatedTests(graph, graph.nodes[0].id) };
    const actual = await client.getNativeRelatedTests(graph, candidate.node.id);
    assert.deepEqual(actual, JSON.parse(JSON.stringify(candidate.expected)), fixture.id);
    comparisons.push({ id: fixture.id, relatedTestCount: candidate.expected.relatedTests.length });
  }
  assert.equal(comparisons.length, 11);
  assert.ok(comparisons.some((item) => item.relatedTestCount > 0));
});

test("native flow assembly matches JavaScript flow traversal across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    assert.deepEqual(await client.getNativeFlows(graph), graph.flows, fixture.id);
  }
});

test("native Context Ref construction matches JavaScript across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    const node = graph.nodes[0];
    assert.equal(await client.createNativeContextRef(graph, "node", node.id), createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion), fixture.id);
    for (const flow of graph.flows) {
      assert.equal(await client.createNativeContextRef(graph, "flow", flow.id), createContextRef(graph.project.projectId, "flow", flow.id, graph.state.graphVersion), `${fixture.id}:${flow.id}`);
    }
  }
});

test("native Flow Lens matches the raw JavaScript public projection across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    for (const flow of graph.flows) {
      const lens = getFlowProjection(graph, flow.id, "application", { maxSteps: 3 });
      assert.deepEqual(await client.getNativeFlowLensCore(graph, flow.id, 3), JSON.parse(JSON.stringify(lens)), `${fixture.id}:${flow.id}`);
    }
  }
});

test("native Node Context Cards match JavaScript across the structural compatibility universe", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    for (const node of graph.nodes.filter((candidate) => STRUCTURAL_NODE_KINDS.has(candidate.kind))) {
      const expected = JSON.parse(JSON.stringify(createNodeContextCard(graph, getNodeDetails(graph, node.id))));
      assert.deepEqual(await client.getNativeNodeContextCard(graph, node.id), expected, `${fixture.id}:${node.id}`);
    }
  }
});

test("native Flow Context Cards match JavaScript across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    for (const flow of graph.flows) {
      const lens = getFlowProjection(graph, flow.id, "application", { maxSteps: 3 });
      const expected = JSON.parse(JSON.stringify(createFlowContextCard(graph, lens)));
      assert.deepEqual(await client.getNativeFlowContextCard(graph, flow.id, 3), expected, `${fixture.id}:${flow.id}`);
    }
  }
});

test("native current node Context Ref resolution matches JavaScript across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    for (const node of graph.nodes.filter((candidate) => STRUCTURAL_NODE_KINDS.has(candidate.kind))) {
      const contextRef = createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion);
      assert.deepEqual(await client.resolveNativeContextRef(graph, contextRef), JSON.parse(JSON.stringify(resolveContextRef(graph, contextRef))), `${fixture.id}:${node.id}`);
    }
  }
});

test("native current flow Context Ref resolution matches the raw JavaScript core contract across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    for (const flow of graph.flows) {
      const contextRef = createContextRef(graph.project.projectId, "flow", flow.id, graph.state.graphVersion);
      const expected = resolveContextCardRef(graph, contextRef, {
        getFlowContextCard: (current, flowId) => {
          const projection = getFlowProjection(current, flowId, "application");
          return projection ? createFlowContextCard(current, projection) : null;
        },
      });
      assert.deepEqual(await client.resolveNativeContextRef(graph, contextRef), JSON.parse(JSON.stringify(expected)), `${fixture.id}:${flow.id}`);
    }
  }
});

test("native retained node Context Ref resolution matches JavaScript stale and historical states", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-context-history-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "native-context-history-fixture" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "orders.ts"), "import { normalize } from './normalize';\nexport function submit() { return normalize(); }\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "normalize.ts"), "export function normalize() { return true; }\n", "utf8");
  const client = nativeClient();
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.start();
  const scanner = createRepositoryScanner(root);
  const previousGraph = scanner.scan();
  const stableNode = previousGraph.nodes.find((node) => node.kind === "file" && node.path === "src/orders.ts");
  const removedNode = previousGraph.nodes.find((node) => node.kind === "file" && node.path === "src/normalize.ts");
  assert.ok(stableNode);
  assert.ok(removedNode);
  const staleRef = createContextRef(previousGraph.project.projectId, "node", stableNode.id, previousGraph.state.graphVersion);
  const historicalRef = createContextRef(previousGraph.project.projectId, "node", removedNode.id, previousGraph.state.graphVersion);

  const previousBatch = createStructuralFactBatch(previousGraph, scanner.snapshotRecords());
  await client.request("persistStructuralGraph", { ...previousBatch, projectRoot: root });
  fs.rmSync(path.join(root, "src", "normalize.ts"));
  const scannedCurrentGraph = scanner.scan(["src/normalize.ts"]);
  const graph = {
    ...scannedCurrentGraph,
    state: { ...scannedCurrentGraph.state, graphVersion: previousGraph.state.graphVersion + 1 },
  };
  const batch = createStructuralFactBatch(graph, scanner.snapshotRecords());
  await client.request("persistStructuralGraph", { ...batch, projectRoot: root });
  const delta = createGraphDelta(previousGraph, graph);
  const resolverOptions = {
    getNodeDetails,
    readDelta: (fromVersion, toVersion) => (
      fromVersion === previousGraph.state.graphVersion && toVersion === graph.state.graphVersion ? delta : null
    ),
    deltaHistory: () => ({ retained: [delta] }),
  };
  assert.deepEqual(
    await client.request("resolveNativeContextRef", { batch, projectRoot: root, contextRef: staleRef }),
    JSON.parse(JSON.stringify(resolveContextCardRef(graph, staleRef, resolverOptions))),
    "stale node Context Ref",
  );
  assert.deepEqual(
    await client.request("resolveNativeContextRef", { batch, projectRoot: root, contextRef: historicalRef }),
    JSON.parse(JSON.stringify(resolveContextCardRef(graph, historicalRef, resolverOptions))),
    "historical node Context Ref",
  );
  const graphWithDelta = {
    ...graph,
    analysis: { ...graph.analysis, latestDelta: delta },
  };
  assert.deepEqual(
    await client.request("getNativeChangedContexts", {
      projectRoot: root,
      projectId: batch.projectId,
      fromGraphVersion: previousGraph.state.graphVersion,
      toGraphVersion: graph.state.graphVersion,
    }),
    JSON.parse(JSON.stringify(getChangedContexts(graphWithDelta, {
      fromVersion: previousGraph.state.graphVersion,
      toVersion: graph.state.graphVersion,
    }))),
    "changed contexts",
  );
});

test("native retained flow Context Ref resolution matches the raw JavaScript core contract", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-flow-context-history-"));
  fs.mkdirSync(path.join(root, "src", "orders"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "native-flow-context-history-fixture" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "orders", "orders.routes.ts"), "import { OrdersService } from './orders.service';\nrouter.post('/orders', OrdersService.create);\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "orders", "orders.service.ts"), "export class OrdersService { static create() { return true; } }\n", "utf8");
  const client = nativeClient();
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const withVersion = (graph, graphVersion) => ({ ...graph, state: { ...graph.state, graphVersion } });
  const flowCard = (graph, flowId) => {
    const projection = getFlowProjection(graph, flowId, "application");
    return projection ? createFlowContextCard(graph, projection) : null;
  };
  await client.start();
  const scanner = createRepositoryScanner(root);
  const graph0 = scanner.scan();
  const flow = graph0.flows[0];
  assert.ok(flow, "fixture needs one entry flow");
  const batch0 = createStructuralFactBatch(graph0, scanner.snapshotRecords());
  await client.request("persistStructuralGraph", { ...batch0, projectRoot: root });

  fs.appendFileSync(path.join(root, "src", "orders", "orders.service.ts"), "// unchanged flow identity\n", "utf8");
  const graph1 = withVersion(scanner.scan(["src/orders/orders.service.ts"]), 1);
  const batch1 = createStructuralFactBatch(graph1, scanner.snapshotRecords());
  await client.request("persistStructuralGraph", { ...batch1, projectRoot: root });
  assert.ok(graph1.flows.some((candidate) => candidate.id === flow.id), "flow must remain present after a non-topology source change");
  const staleRef = createContextRef(graph0.project.projectId, "flow", flow.id, graph0.state.graphVersion);
  const staleDelta = createGraphDelta(graph0, graph1);
  const staleExpected = resolveContextCardRef(graph1, staleRef, {
    getFlowContextCard: flowCard,
    readDelta: (fromVersion, toVersion) => fromVersion === 0 && toVersion === 1 ? staleDelta : null,
    deltaHistory: () => ({ retained: [staleDelta] }),
  });
  assert.deepEqual(
    await client.request("resolveNativeContextRef", { batch: batch1, projectRoot: root, contextRef: staleRef }),
    JSON.parse(JSON.stringify(staleExpected)),
    "stale flow Context Ref",
  );

  fs.writeFileSync(path.join(root, "src", "orders", "orders.routes.ts"), "export const removedRoute = true;\n", "utf8");
  const graph2 = withVersion(scanner.scan(["src/orders/orders.routes.ts"]), 2);
  const batch2 = createStructuralFactBatch(graph2, scanner.snapshotRecords());
  await client.request("persistStructuralGraph", { ...batch2, projectRoot: root });
  assert.equal(graph2.flows.some((candidate) => candidate.id === flow.id), false, "flow must be removed with its entry route");
  const historicalRef = createContextRef(graph1.project.projectId, "flow", flow.id, graph1.state.graphVersion);
  const historicalDelta = createGraphDelta(graph1, graph2);
  const historicalExpected = resolveContextCardRef(graph2, historicalRef, {
    getFlowContextCard: flowCard,
    readDelta: (fromVersion, toVersion) => fromVersion === 1 && toVersion === 2 ? historicalDelta : null,
    deltaHistory: () => ({ retained: [historicalDelta] }),
  });
  assert.deepEqual(
    await client.request("resolveNativeContextRef", { batch: batch2, projectRoot: root, contextRef: historicalRef }),
    JSON.parse(JSON.stringify(historicalExpected)),
    "historical flow Context Ref",
  );
});

test("native change-impact query matches the JavaScript current-graph contract across the compatibility corpus", async (context) => {
  const client = createShadowCoreClient({ native: nativeClient() });
  context.after(() => client.close());
  for (const fixture of CORE_BASELINE.cases) {
    const graph = await client.scan(path.join(ROOT, fixture.fixture));
    const changedPath = graph.nodes.find((node) => node.kind === "file" && node.sourceScope !== "test")?.path;
    assert.ok(changedPath, `${fixture.id} needs an application file`);
    const expected = JSON.parse(JSON.stringify(getChangeImpact(graph, [changedPath], { maxDepth: 4 })));
    const actual = await client.getNativeChangeImpact(graph, [changedPath], { maxDepth: 4 });
    assert.deepEqual(actual, expected, fixture.id);
  }
});

test("native change-impact query matches JavaScript deleted-file recovery", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-historical-impact-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "native-historical-impact-fixture" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "orders.ts"), "import { normalize } from './normalize';\nexport function submit() { return normalize(); }\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "normalize.ts"), "export function normalize() { return true; }\n", "utf8");
  const client = createShadowCoreClient({ native: nativeClient(), persistStructuralGraph: true });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const previousGraph = await client.scan(root);
  fs.rmSync(path.join(root, "src", "normalize.ts"));
  const graph = await client.scan(root);
  const expected = JSON.parse(JSON.stringify(getChangeImpact(graph, ["src/normalize.ts"], { maxDepth: 4, previousGraph })));
  const actual = await client.getNativeChangeImpact(graph, ["src/normalize.ts"], { maxDepth: 4, previousGraph, useStoredPreviousGraph: true });
  const nativeDelta = await client.getNativeStructuralDelta(previousGraph, graph);
  const nativePublicDelta = await client.getNativePublicGraphDelta(previousGraph, graph);
  assert.deepEqual(actual, expected);
  assert.equal(actual.deletedPaths[0], "src/normalize.ts");
  assert.equal(actual.affectedNodes[0].relationship, "historical-dependent");
  assert.equal(nativeDelta.available, true);
  assert.equal(nativeDelta.delta.fromGraphVersion, previousGraph.state.graphVersion);
  assert.equal(nativeDelta.delta.toGraphVersion, graph.state.graphVersion);
  assert.equal(nativeDelta.delta.nodes.removed.some((node) => node.path === "src/normalize.ts"), true);
  const expectedDelta = JSON.parse(JSON.stringify(createGraphDelta(previousGraph, graph)));
  assert.deepEqual(nativeDelta.delta, expectedDelta);
  assert.deepEqual(nativePublicDelta, expectedDelta);
});

test("native getRelatedTests matches the JavaScript serialized query contract", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-related-tests-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "native-related-tests-fixture" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "orders.ts"), "export function submitOrder() {}\n", "utf8");
  fs.writeFileSync(path.join(root, "test", "orders.test.ts"), "import { submitOrder } from '../src/orders';\nsubmitOrder();\n", "utf8");
  const client = nativeClient();
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const scanner = createRepositoryScanner(root);
  const graph = scanner.scan();
  const batch = createStructuralFactBatch(graph, scanner.snapshotRecords());
  const nodeId = "file:src/orders.ts";
  const expected = JSON.parse(JSON.stringify(getRelatedTests(graph, nodeId)));
  await client.start();
  const actual = await client.request("getRelatedTests", { batch, nodeId });
  assert.deepEqual(actual, expected);
});

test("structural comparison reports the first exact mismatch", () => {
  const graph = { nodes: [{ id: "file:src/a.ts", kind: "file", type: "module", path: "src/a.ts" }], edges: [] };
  const comparison = compareStructuralProjection(graph, { nodes: [], edges: [] });
  assert.equal(comparison.status, "mismatch");
  assert.deepEqual(comparison.mismatch, {
    field: "nodes",
    index: 0,
    expected: { id: "file:src/a.ts", kind: "file", nodeType: "module", path: "src/a.ts" },
    actual: null,
  });
});
