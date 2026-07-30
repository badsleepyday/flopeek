"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CORE_CLIENT_METHODS, CORE_CLIENT_SCHEMA, assertCoreClient } = require("../../src/core-client");
const { createJsCoreClient } = require("../../src/js-core-client");
const { createNativeCoreClient, materializePatchedPublicGraph } = require("../../src/native-core-client");
const { createNativeCoreExtensionAdapter } = require("../../src/native-core-extension-adapter");
const { NativeProtocolClient } = require("../../src/native-protocol-client");
const { scanRepository } = require("../../src/scanner");
const { createCoreCompatibilityDigest, createCoreCompatibilityProjection } = require("../../src/core-compatibility");
const { COLLATION_LOCALE } = require("../../src/collation");
const { getAgentBootstrap, getChangedContexts, getEntryFlows, getNodeDetails, getRelatedTests, projectView } = require("../../src/graph-service");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");
const CORE_BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "js-core-baseline.json"), "utf8"));

function nativeClient() {
  return new NativeProtocolClient({
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", MANIFEST, "--"],
    cwd: ROOT,
    // `cargo run` may need a first-source build while other Node test files
    // exercise the release binary in parallel. Product clients still retain
    // their normal timeout; this source-backed harness must include compile
    // time before the native process can consume its first JSONL request.
    requestTimeoutMs: 120_000,
  });
}

function observedNativeClient(methods) {
  const client = nativeClient();
  return {
    get child() { return client.child; },
    get closed() { return client.closed; },
    start: (...args) => client.start(...args),
    request: async (...args) => {
      methods.push(args[0]);
      return client.request(...args);
    },
    close: (...args) => client.close(...args),
    getLastResponseStats: () => client.getLastResponseStats(),
  };
}

function extensionsThatRejectCoreFallback() {
  const extensions = createNativeCoreExtensionAdapter();
  const reject = (name) => () => { throw new Error(`Native core query reached extension fallback: ${name}`); };
  return {
    ...extensions,
    getNonApplicationFlowProjection: reject("getNonApplicationFlowProjection"),
    getEphemeralChangedContexts: reject("getEphemeralChangedContexts"),
    getFormattedContextCard: reject("getFormattedContextCard"),
    resolveUnsupportedContextRef: reject("resolveUnsupportedContextRef"),
  };
}

function observedNativeRequests(requests) {
  const client = nativeClient();
  return {
    get child() { return client.child; },
    get closed() { return client.closed; },
    start: (...args) => client.start(...args),
    request: async (...args) => {
      const observed = { method: args[0], params: args[1], responseStats: null };
      requests.push(observed);
      const result = await client.request(...args);
      observed.result = result;
      observed.responseStats = client.getLastResponseStats();
      return result;
    },
    close: (...args) => client.close(...args),
    getLastResponseStats: () => client.getLastResponseStats(),
  };
}

test("JavaScript core client declares the complete v6 core boundary", () => {
  const client = createJsCoreClient();
  assert.equal(client.schemaVersion, CORE_CLIENT_SCHEMA);
  assert.equal(client.implementation, "javascript");
  assert.doesNotThrow(() => assertCoreClient(client));
  for (const method of CORE_CLIENT_METHODS) assert.equal(typeof client[method], "function", method);
});

test("NativeCoreClient forwards nativeOptions to the session rather than treating them as a binary", async () => {
  const client = createNativeCoreClient({ nativeOptions: { requestTimeoutMs: 17 } });
  assert.equal(client.implementation, "native-experimental");
  assert.equal(client.backendAuthority, "rust-sqlite");
  assert.equal(client.parserHost, "javascript-structural-fact-batch/v1");
  await client.close();
});

test("NativeCoreClient rejects a JavaScript core authority at its backend boundary", () => {
  assert.throws(
    () => createNativeCoreClient({ javascript: createJsCoreClient() }),
    /does not accept a JavaScript core authority/,
  );
});

test("Rust source authority has no JavaScript source-fact host dependency", () => {
  const implementation = fs.readFileSync(path.join(ROOT, "src", "native-core-client.js"), "utf8");
  assert.equal(implementation.includes("native-source-fact-host"), false);
  assert.equal(implementation.includes("createPublicGraphEnvelope"), false);
  assert.equal(implementation.includes("createFlowContextCard"), false);
});

test("JavaScript core client preserves current core scan and query semantics", () => {
  const client = createJsCoreClient();
  const direct = scanRepository(FIXTURE, { persistIdentity: false });
  const throughClient = client.scan(FIXTURE, { persistIdentity: false });
  assert.equal(createCoreCompatibilityDigest(throughClient), createCoreCompatibilityDigest(direct));
  assert.deepEqual(client.getScanStatus(throughClient), getAgentBootstrap(throughClient));

  const flow = direct.flows[0];
  assert.ok(flow);
  assert.deepEqual(client.getEntryFlows(throughClient), getEntryFlows(throughClient));
  assert.deepEqual(client.getFlowProjection(throughClient, flow.id), require("../../src/graph-service").getFlowProjection(throughClient, flow.id));
  assert.deepEqual(client.getFlowContextCard(throughClient, flow.id), require("../../src/graph-service").getFlowContextCard(throughClient, flow.id));

  const node = direct.nodes.find((candidate) => candidate.type === "function") || direct.nodes[0];
  assert.ok(node);
  assert.deepEqual(client.getNode(throughClient, node.id), getNodeDetails(throughClient, node.id));
  assert.deepEqual(client.getRelatedTests(throughClient, node.id), getRelatedTests(throughClient, node.id));
  assert.deepEqual(client.getChangedContexts(throughClient), getChangedContexts(throughClient));
});

test("JavaScript CoreClient scan primes the same persistent scanner used by refresh", async () => {
  const client = createJsCoreClient();
  const first = client.scan(FIXTURE, { persistIdentity: false });
  const second = client.refresh(FIXTURE, { persistIdentity: false, changedPaths: [] });
  assert.equal(first.analysis.refresh.mode, "initial");
  assert.equal(second.analysis.refresh.mode, "incremental");
  assert.equal(second.analysis.refresh.analyzedFiles, 0);
  assert.equal(second.analysis.refresh.reusedFiles, second.stats.scannedFiles);
  await client.close();
});

test("native public collection patches reconstruct the exact public graph", () => {
  const previous = {
    project: { projectId: "project:fixture" },
    state: { graphVersion: 1 },
    nodes: [{ id: "file:a", label: "a" }, { id: "file:b", label: "b" }],
    edges: [{ source: "file:a", target: "file:b", type: "imports" }],
    flows: [{ id: "flow:a", title: "before" }],
    diagnosticFlows: [{ id: "diagnostic:a", title: "before" }],
  };
  const patch = {
    schemaVersion: "flopeek-native-public-graph-patch/v1",
    envelope: { project: { projectId: "project:fixture" }, state: { graphVersion: 2 } },
    collections: {
      nodes: { remove: ["id:file:a"], upsert: [{ id: "file:c", label: "c" }], insert: [{ key: "id:file:c", index: 1 }], order: null },
      edges: { remove: [], upsert: [], insert: [], order: null },
      flows: { remove: [], upsert: [{ id: "flow:a", title: "after" }], insert: [], order: null },
      diagnosticFlows: { remove: [], upsert: [{ id: "diagnostic:a", title: "after" }], insert: [], order: null },
    },
  };
  assert.deepEqual(materializePatchedPublicGraph(previous, patch), {
    project: { projectId: "project:fixture" },
    state: { graphVersion: 2 },
    nodes: [{ id: "file:b", label: "b" }, { id: "file:c", label: "c" }],
    edges: [{ source: "file:a", target: "file:b", type: "imports" }],
    flows: [{ id: "flow:a", title: "after" }],
    diagnosticFlows: [{ id: "diagnostic:a", title: "after" }],
  });
});

test("experimental native core assembles the public graph without JavaScript topology", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-public-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const client = createNativeCoreClient({ native: nativeClient(), extensions: extensionsThatRejectCoreFallback() });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(client.implementation, "native-experimental");
  const graph = await client.scan(root, { persistIdentity: true });
  const javascript = createJsCoreClient();
  const oracle = javascript.scan(root, { persistIdentity: true });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));

  const node = graph.nodes.find((candidate) => candidate.type === "function") || graph.nodes[0];
  assert.deepEqual(await client.findNodes(graph, { q: "validation" }), javascript.findNodes(graph, { q: "validation" }));
  assert.deepEqual(await client.getNode(graph, node.id), javascript.getNode(graph, node.id));
  assert.deepEqual(await client.getRelatedTests(graph, node.id), javascript.getRelatedTests(oracle, node.id));
  assert.deepEqual(await client.getChangeImpact(graph, [node.path]), javascript.getChangeImpact(oracle, [node.path]));
  assert.deepEqual(await client.getContextCard(graph, node.id), javascript.getContextCard(graph, node.id));
  const flow = graph.flows[0];
  assert.ok(flow);
  assert.deepEqual(await client.getEntryFlows(graph), javascript.getEntryFlows(graph));
  assert.deepEqual(await client.getEntryFlows(graph, "", "all"), javascript.getEntryFlows(graph, "", "all"));
  assert.deepEqual(await client.getRequestFlows(graph, flow.title), javascript.getRequestFlows(graph, flow.title));
  assert.deepEqual(await client.getFlowProjection(graph, flow.id), javascript.getFlowProjection(graph, flow.id));
  assert.deepEqual(await client.getFlowContextCard(graph, flow.id), javascript.getFlowContextCard(graph, flow.id));
});

test("persistent native queries use verified fact-cache references instead of full JSONL batches", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-query-cache-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const requests = [];
  const client = createNativeCoreClient({ native: observedNativeRequests(requests) });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await client.scan(root);
  requests.length = 0;
  const result = await client.findNodes(graph, { q: "validation" });
  assert.deepEqual(result, createJsCoreClient().findNodes(graph, { q: "validation" }));
  const request = requests.find((entry) => entry.method === "findNodes");
  assert.ok(request);
  assert.equal(Object.hasOwn(request.params, "batch"), false);
  assert.equal(request.params.projectId, graph.project.projectId);
  assert.match(request.params.factsDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    fs.realpathSync(request.params.projectRoot),
    fs.realpathSync(root),
    "persistent query roots must identify the same filesystem directory even when macOS expands /var to /private/var",
  );
});

test("persistent native query retries its exact historical batch after a cache-reference miss", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-query-fallback-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const requests = [];
  const client = createNativeCoreClient({ native: observedNativeRequests(requests) });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = await client.scan(root);
  const changedPath = first.nodes.find((node) => node.kind === "file")?.path;
  assert.ok(changedPath);
  fs.appendFileSync(path.join(root, ...changedPath.split("/")), "\n");
  await client.refresh(root, { changedPaths: [changedPath] });
  requests.length = 0;
  const result = await client.findNodes(first, { q: "validation" });
  assert.deepEqual(result, createJsCoreClient().findNodes(first, { q: "validation" }));
  const queries = requests.filter((entry) => entry.method === "findNodes");
  assert.equal(queries.length, 2);
  assert.equal(Object.hasOwn(queries[0].params, "batch"), false);
  assert.equal(Object.hasOwn(queries[1].params, "batch"), true);
});

test("experimental native core preserves Go package nodes, edges, and call evidence", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-go-package-"));
  fs.mkdirSync(path.join(root, "cmd"), { recursive: true });
  fs.mkdirSync(path.join(root, "pkg", "helper"), { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/native\n\ngo 1.23\n");
  fs.writeFileSync(path.join(root, "cmd", "main.go"), [
    "package main",
    "",
    'import "example.test/native/pkg/helper"',
    "",
    "func main() { helper.Ping() }",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "pkg", "helper", "helper.go"), [
    "package helper",
    "",
    "func Ping() {}",
    "",
  ].join("\n"));
  const native = createNativeCoreClient({ native: nativeClient(), sessionId: "native-go-package" });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const javascript = createJsCoreClient();
  const oracle = javascript.scan(root, { persistIdentity: false });
  const graph = await native.scan(root, { persistIdentity: false });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));

  const packageId = "go-package:example.test/native/pkg/helper";
  const fileId = "file:pkg/helper/helper.go";
  const mainId = "file:cmd/main.go";
  const callSource = "symbol:cmd/main.go:function:main";
  const callTarget = "symbol:pkg/helper/helper.go:function:Ping";
  for (const edge of [
    { source: packageId, target: fileId, type: "contains" },
    { source: mainId, target: packageId, type: "imports" },
    { source: callSource, target: callTarget, type: "calls" },
  ]) {
    assert.deepEqual(
      graph.edges.find((candidate) => candidate.source === edge.source && candidate.target === edge.target && candidate.type === edge.type),
      oracle.edges.find((candidate) => candidate.source === edge.source && candidate.target === edge.target && candidate.type === edge.type),
      `${edge.type}:${edge.source}->${edge.target}`,
    );
  }
});

test("strict Rust source authority owns Go parsing, module resolution, and direct calls", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-go-package-"));
  fs.mkdirSync(path.join(root, "cmd"), { recursive: true });
  fs.mkdirSync(path.join(root, "internal", "helper"), { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/native\n\ngo 1.23\n");
  fs.writeFileSync(path.join(root, "cmd", "main.go"), [
    "package main",
    'import helper "example.test/native/internal/helper"',
    "func validate() {}",
    "func main() { validate(); helper.Ping() }",
    "func Typed(value helper.Type) { helper.Ping() }",
    "func Generic[T helper.Constraint](value T) { helper.Ping() }",
    "func Result() helper.Type { helper.Ping(); return helper.Type{} }",
    "func Shadowed(helper helper.Type) { helper.Ping() }",
    "func NamedResult() (helper helper.Type) { helper.Ping(); return }",
    "func Local() { helper := struct{}{}; helper.Ping() }",
    "func Assigned() { type local struct{}; var helper local; helper = local{}; helper.Ping() }",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "internal", "helper", "helper.go"), [
    "package helper",
    "type Type struct{}",
    "type Constraint interface{ ~int }",
    "func Ping() {}",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "internal", "helper", "other.go"), "package helper\nfunc Other() {}\n");
  const native = createNativeCoreClient({
    native: nativeClient(),
    sessionId: "strict-rust-go-package",
    sourceAuthority: "rust",
  });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const graph = await native.scan(root, { persistIdentity: false });
  const oracle = createJsCoreClient().scan(root, {
    persistIdentity: false,
    sessionProjectId: graph.project.projectId,
  });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  const main = graph.nodes.find((node) => node.id === "symbol:cmd/main.go:function:main");
  const validate = graph.nodes.find((node) => node.id === "symbol:cmd/main.go:function:validate");
  const ping = graph.nodes.find((node) => node.id === "symbol:internal/helper/helper.go:function:Ping");
  const packageNode = graph.nodes.find((node) => node.id === "go-package:internal/helper");
  assert.equal(graph.nodes.find((node) => node.id === "file:cmd/main.go").analysis.parser, "go-parser");
  assert.ok(main && validate && ping && packageNode);
  assert.ok(graph.edges.some((edge) => edge.source === main.id && edge.target === validate.id && edge.type === "calls"));
  assert.ok(graph.edges.some((edge) => edge.source === main.id && edge.target === ping.id && edge.type === "calls"));
  for (const caller of ["Typed", "Generic", "Result"]) {
    assert.ok(
      graph.edges.some((edge) => edge.source === `symbol:cmd/main.go:function:${caller}`
        && edge.target === ping.id && edge.type === "calls"),
      `${caller} must retain its imported call when helper only occurs in a type expression`,
    );
  }
  for (const caller of ["Shadowed", "NamedResult", "Local", "Assigned"]) {
    assert.equal(
      graph.edges.some((edge) => edge.source === `symbol:cmd/main.go:function:${caller}`
        && edge.target === ping.id && edge.type === "calls"),
      false,
      `${caller} must suppress the imported call after helper is bound as a value`,
    );
  }
  assert.equal(graph.nodes.some((node) => node.id === "external:example.test"), false);
});

test("strict Rust Go parity survives malformed input and add, rename, and delete refreshes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-go-refresh-"));
  fs.mkdirSync(path.join(root, "cmd"), { recursive: true });
  fs.mkdirSync(path.join(root, "pkg", "helper"), { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/refresh\n\ngo 1.23\n");
  const mainPath = path.join(root, "cmd", "main.go");
  const brokenPath = path.join(root, "cmd", "broken.go");
  const helperPath = path.join(root, "pkg", "helper", "helper.go");
  fs.writeFileSync(mainPath, [
    "package main",
    'import "example.test/refresh/pkg/helper"',
    "func main() { helper.Ping() }",
    "",
  ].join("\n"));
  fs.writeFileSync(brokenPath, "package main\nfunc First( {\nfunc Second( {\n");
  fs.writeFileSync(helperPath, "package helper\nfunc Ping() {}\n");

  const native = createNativeCoreClient({
    native: nativeClient(),
    sessionId: "strict-rust-go-refresh",
    sourceAuthority: "rust",
  });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const assertParity = (graph, label) => {
    const oracle = createJsCoreClient().scan(root, {
      persistIdentity: false,
      sessionProjectId: graph.project.projectId,
    });
    assert.deepEqual(createCoreCompatibilityProjection(graph), createCoreCompatibilityProjection(oracle), label);
  };

  const first = await native.scan(root, { persistIdentity: false });
  assertParity(first, "cold malformed scan");
  const broken = first.nodes.find((node) => node.id === "file:cmd/broken.go");
  assert.equal(broken.analysis.status, "parsed-with-diagnostics");
  assert.equal(broken.analysis.diagnostics, 1, "all parser recovery nodes normalize to one diagnostic");

  const extraPath = path.join(root, "pkg", "helper", "extra.go");
  fs.writeFileSync(extraPath, "package helper\nfunc Extra() {}\n");
  fs.writeFileSync(mainPath, [
    "package main",
    'import "example.test/refresh/pkg/helper"',
    "func main() { helper.Ping(); helper.Extra() }",
    "",
  ].join("\n"));
  const second = await native.refresh(root, { changedPaths: ["cmd/main.go", "pkg/helper/extra.go"] });
  assertParity(second, "added Go file");
  assert.ok(second.edges.some((edge) => edge.source === "symbol:cmd/main.go:function:main"
    && edge.target === "symbol:pkg/helper/extra.go:function:Extra" && edge.type === "calls"));

  const renamedPath = path.join(root, "pkg", "helper", "renamed.go");
  fs.renameSync(extraPath, renamedPath);
  const third = await native.refresh(root, {
    changedPaths: ["pkg/helper/extra.go", "pkg/helper/renamed.go"],
  });
  assertParity(third, "renamed Go file");
  assert.equal(third.nodes.some((node) => node.id.includes("pkg/helper/extra.go")), false);
  assert.ok(third.nodes.some((node) => node.id === "symbol:pkg/helper/renamed.go:function:Extra"));

  fs.rmSync(renamedPath);
  fs.writeFileSync(mainPath, [
    "package main",
    'import "example.test/refresh/pkg/helper"',
    "func main() { helper.Ping() }",
    "",
  ].join("\n"));
  const fourth = await native.refresh(root, {
    changedPaths: ["cmd/main.go", "pkg/helper/renamed.go"],
  });
  assertParity(fourth, "deleted Go file");
  assert.equal(fourth.nodes.some((node) => node.id.includes("pkg/helper/renamed.go")), false);
});

test("experimental native core owns persistent public graph versions", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-client-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const client = createNativeCoreClient({ native: nativeClient() });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = await client.scan(root);
  const second = await client.refresh(root);
  assert.equal(first.state.graphVersion, 1);
  assert.equal(second.state.graphVersion, 1);
  const node = first.nodes.find((candidate) => candidate.type === "function") || first.nodes[0];
  const flow = first.flows[0];
  assert.ok(flow);
  const nodeRef = (await client.getContextCard(first, node.id)).card.contextRef;
  const flowRef = (await client.getFlowProjection(first, flow.id)).flow.contextRef;
  const changedPath = second.nodes.find((node) => node.kind === "file").path;
  fs.appendFileSync(path.join(root, changedPath), "\n");
  const third = await client.refresh(root, { changedPaths: [changedPath] });
  assert.equal(third.state.graphVersion, 2);
  assert.equal(third.analysis.latestDelta?.fromGraphVersion, 1);
  assert.equal(third.analysis.latestDelta?.toGraphVersion, 2);
  assert.deepEqual(await client.getChangedContexts(third), createJsCoreClient().getChangedContexts(third));
  assert.deepEqual(await client.resolveContextRef(third, nodeRef), createJsCoreClient().resolveContextRef(third, nodeRef));
  assert.deepEqual(await client.resolveContextRef(third, flowRef), createJsCoreClient().resolveContextRef(third, flowRef));
});

test("experimental native core uses integrity-checked fact patches for edit, deletion, and resolver-context refresh", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-patch-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const methods = [];
  const profile = [];
  const client = createNativeCoreClient({ native: observedNativeClient(methods) });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = await client.scan(root, { onProfile: (event) => profile.push(event) });
  const changedPath = first.nodes.find((node) => node.kind === "file")?.path;
  assert.ok(changedPath);
  fs.appendFileSync(path.join(root, ...changedPath.split("/")), "\n");
  const second = await client.refresh(root, { changedPaths: [changedPath], onProfile: (event) => profile.push(event) });
  assert.equal(second.state.graphVersion, 2);
  assert.equal(createCoreCompatibilityDigest(second), createCoreCompatibilityDigest(createJsCoreClient().scan(root)));

  const removedPath = second.nodes.find((node) => node.kind === "file" && node.path.endsWith("validation.ts"))?.path;
  assert.ok(removedPath);
  fs.rmSync(path.join(root, ...removedPath.split("/")));
  const third = await client.refresh(root, { changedPaths: [removedPath], onProfile: (event) => profile.push(event) });
  assert.equal(third.state.graphVersion, 3);
  assert.equal(createCoreCompatibilityDigest(third), createCoreCompatibilityDigest(createJsCoreClient().scan(root)));

  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.private = true;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const fourth = await client.refresh(root, { changedPaths: ["package.json"], onProfile: (event) => profile.push(event) });
  assert.equal(fourth.state.graphVersion, 3, "resolver context may refresh without a material graph change");
  assert.equal(createCoreCompatibilityDigest(fourth), createCoreCompatibilityDigest(createJsCoreClient().scan(root)));
  assert.equal(methods.filter((method) => method === "persistNativePublicGraph").length, 1);
  assert.equal(methods.filter((method) => method === "persistNativePublicGraphPatch").length, 3);
  const requests = profile.filter((event) => event.phase === "native-core-jsonl-request");
  assert.equal(requests.length, 4);
  assert.ok(requests.slice(1).every((event) => event.factPatch && event.requestBytes < requests[0].requestBytes));
  const sessionStarts = profile.filter((event) => event.phase === "native-core-session-start");
  assert.equal(sessionStarts.length, 4);
  assert.deepEqual(
    sessionStarts.map((event) => event.overlappedWithFactPreparation),
    [true, false, false, false],
    "the cold native process must launch while JavaScript prepares structural facts",
  );
  assert.deepEqual(
    profile.filter((event) => event.phase === "native-core-fact-batch").map((event) => event.materialized),
    [true, false, false, false],
    "incremental patches must not materialize a full JSONL batch before native validation",
  );
});

test("experimental native core keeps cache-disabled lifecycle in one JSONL session without SQLite", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-session-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const client = createNativeCoreClient({ native: nativeClient(), sessionId: "native-test-session" });
  context.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = await client.scan(root, { persistIdentity: false });
  const second = await client.refresh(root, { persistIdentity: false });
  assert.equal(first.project.projectId, second.project.projectId);
  assert.match(first.project.projectId, /^session:/);
  assert.equal(first.state.graphVersion, 1);
  assert.equal(second.state.graphVersion, 1);
  assert.equal(second.state.status, "session-current");
  assert.equal(second.analysis.graphState.persistence, "session-memory");

  const node = first.nodes.find((candidate) => candidate.type === "function") || first.nodes[0];
  const before = await client.getNativeNodeContextCard(first, node.id);
  assert.ok(before.contextRef);
  fs.appendFileSync(path.join(root, node.path), "\n");
  const third = await client.refresh(root, { persistIdentity: false, changedPaths: [node.path] });
  assert.equal(third.state.graphVersion, 2);
  assert.equal(third.state.status, "session-advanced");
  assert.equal(third.analysis.latestDelta?.fromGraphVersion, 1);
  assert.equal(third.analysis.latestDelta?.toGraphVersion, 2);
  const resolution = await client.resolveContextRef(third, before.contextRef);
  assert.equal(resolution.status, "stale");
  assert.match(resolution.resolvedRef, /@2$/);
  const flow = third.flows[0];
  assert.ok(flow);
  assert.deepEqual(await client.getFlowProjection(third, flow.id), createJsCoreClient().getFlowProjection(third, flow.id));
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("NativeCoreClient normalizes a terminated JSONL request as an explicit cancellation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-cancel-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  let rejectRequest;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const protocol = {
    child: null,
    closed: false,
    start: async function start() { this.child = {}; },
    request: async () => new Promise((_resolve, reject) => {
      rejectRequest = reject;
      requestStarted();
    }),
    abort: async () => {
      const error = new Error("child terminated");
      error.code = "native-request-cancelled";
      rejectRequest(error);
      protocol.child = null;
      protocol.closed = true;
      return true;
    },
    close: async () => {},
  };
  const client = createNativeCoreClient({ native: protocol });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const pending = client.scan(root, { persistIdentity: false, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: "FLOPEEK_NATIVE_SCAN_CANCELLED" });
});

test("experimental NativeCoreClient preserves graph, core-query, and stale-context parity across the compatibility corpus", async (context) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-corpus-"));
  const native = createNativeCoreClient({ native: nativeClient() });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  for (const fixture of CORE_BASELINE.cases) {
    const root = path.join(sandbox, fixture.id);
    fs.cpSync(path.join(ROOT, fixture.fixture), root, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".flopeek",
    });
    const first = await native.scan(root);
    const oracle = javascript.scan(root);
    assert.equal(createCoreCompatibilityDigest(first), createCoreCompatibilityDigest(oracle), `${fixture.id}: graph`);

    const node = first.nodes.find((candidate) => candidate.kind === "symbol") || first.nodes[0];
    assert.ok(node, `${fixture.id}: needs one node`);
    const query = node.label.slice(0, Math.max(1, Math.min(node.label.length, 32)));
    assert.deepEqual(await native.findNodes(first, { query }), javascript.findNodes(first, { query }), `${fixture.id}: findNodes`);
    assert.deepEqual(await native.getNode(first, node.id), javascript.getNode(first, node.id), `${fixture.id}: getNode`);
    assert.deepEqual(await native.getRelatedTests(first, node.id), javascript.getRelatedTests(first, node.id), `${fixture.id}: relatedTests`);
    assert.deepEqual(await native.getContextCard(first, node.id), javascript.getContextCard(first, node.id), `${fixture.id}: nodeContextCard`);
    assert.deepEqual(await native.getEntryFlows(first, "", "application"), javascript.getEntryFlows(first, "", "application"), `${fixture.id}: entryFlows`);
    assert.deepEqual(await native.getRequestFlows(first, "", "application"), javascript.getRequestFlows(first, "", "application"), `${fixture.id}: requestFlows`);
    const changedPath = first.nodes.find((candidate) => candidate.kind === "file" && candidate.sourceScope !== "test")?.path;
    assert.ok(changedPath, `${fixture.id}: needs one application file`);
    assert.deepEqual(await native.getChangeImpact(first, [changedPath], { maxDepth: 4 }), javascript.getChangeImpact(first, [changedPath], { maxDepth: 4 }), `${fixture.id}: impact`);
    for (const flow of first.flows) {
      const lens = await native.getFlowProjection(first, flow.id, "application", { maxSteps: 3 });
      assert.deepEqual(lens, javascript.getFlowProjection(first, flow.id, "application", { maxSteps: 3 }), `${fixture.id}:${flow.id}: flowLens`);
      const contextRef = (await native.getFlowProjection(first, flow.id, "application", { maxSteps: 3 })).flow.contextRef;
      assert.deepEqual(await native.resolveContextRef(first, contextRef), javascript.resolveContextRef(first, contextRef), `${fixture.id}:${flow.id}: currentFlowRef`);
    }
    const nodeRef = (await native.getContextCard(first, node.id)).card.contextRef;
    fs.appendFileSync(path.join(root, ...changedPath.split("/")), "\n");
    const second = await native.refresh(root, { changedPaths: [changedPath] });
    const refreshedOracle = javascript.scan(root);
    assert.equal(createCoreCompatibilityDigest(second), createCoreCompatibilityDigest(refreshedOracle), `${fixture.id}: refreshedGraph`);
    assert.deepEqual(await native.getChangedContexts(second), javascript.getChangedContexts(second), `${fixture.id}: changedContexts`);
    assert.deepEqual(await native.resolveContextRef(second, nodeRef), javascript.resolveContextRef(second, nodeRef), `${fixture.id}: staleNodeRef`);
  }
  assert.equal(CORE_BASELINE.cases.length, 11);
});

test("strict Rust source authority parses and resolves a TypeScript graph without the JavaScript parser host", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-authority-"));
  fs.cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(native.sourceAuthority, "rust");
  assert.equal(native.parserHost, "rust-tree-sitter-source/v19");
  assert.equal(native.factEnvelopeHost, "rust-native-structural-batch/v1");
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.deepEqual(await native.getScanStatus(graph), getAgentBootstrap(graph));
  assert.deepEqual(graph.stats, oracle.stats);
  assert.deepEqual(graph.analysis.refresh, oracle.analysis.refresh);
  assert.equal(graph.analysis.graphState.persistence, "sqlite");
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "graph.json")), false);
  const changedPath = graph.nodes.find((node) => node.kind === "file" && node.sourceScope !== "test").path;
  fs.appendFileSync(path.join(root, ...changedPath.split("/")), "\n");
  const refreshed = await native.refresh(root, { changedPaths: [changedPath] });
  const refreshedOracle = javascript.refresh(root, { changedPaths: [changedPath] });
  assert.equal(createCoreCompatibilityDigest(refreshed), createCoreCompatibilityDigest(refreshedOracle));
  assert.deepEqual(refreshed.stats, refreshedOracle.stats);
  assert.equal(refreshed.analysis.refresh.mode, "incremental");
  assert.equal(refreshed.analysis.refresh.analyzedFiles, 1);
  assert.deepEqual(refreshed.analysis.refresh.changedPaths, [changedPath]);
  const unchanged = await native.refresh(root, { changedPaths: [] });
  const unchangedOracle = javascript.refresh(root, { changedPaths: [] });
  assert.equal(createCoreCompatibilityDigest(unchanged), createCoreCompatibilityDigest(unchangedOracle));
  assert.equal(unchanged.state.graphVersion, refreshed.state.graphVersion);
  assert.deepEqual(unchanged.analysis.refresh, unchangedOracle.analysis.refresh);
});

test("strict Rust source authority preserves registered inventory-only files in mixed repositories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-inventory-only-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "inventory-only-source-example" }));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const run = () => true;\n");
  fs.writeFileSync(path.join(root, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
  fs.writeFileSync(path.join(root, "Makefile"), "build:\n\techo build\n");
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.deepEqual(graph.stats, oracle.stats);
  const shell = graph.nodes.find((node) => node.kind === "file" && node.path === "scripts/deploy.sh");
  assert.equal(shell.analysis.parser, "inventory");
  assert.equal(shell.analysis.status, "inventory-only");
  assert.equal(shell.analysis.confidence, "not-analyzed");
  assert.equal(shell.analysis.reason, "No structural adapter registered for .sh.");
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
});

test("strict Rust ephemeral session incrementally updates inventory-only files without reconciliation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-inventory-only-events-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const run = () => true;\n");
  const shellPath = "scripts/deploy.sh";
  fs.writeFileSync(path.join(root, ...shellPath.split("/")), "#!/usr/bin/env bash\necho deploy\n");
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust", sessionId: "inventory-only-events" });
  const javascript = createJsCoreClient();
  const sessionOptions = { persistIdentity: false, sessionProjectId: "session:inventory-only-events" };
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await native.scan(root, { persistIdentity: false });
  javascript.scan(root, sessionOptions);

  fs.appendFileSync(path.join(root, ...shellPath.split("/")), "echo changed\n");
  let graph = await native.refresh(root, { persistIdentity: false, changedPaths: [shellPath] });
  let oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [shellPath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.equal(graph.analysis.refresh.analyzedFiles, 1);
  assert.equal(graph.nodes.find((node) => node.path === shellPath).analysis.status, "inventory-only");

  const makefilePath = "Makefile";
  fs.writeFileSync(path.join(root, makefilePath), "build:\n\techo build\n");
  graph = await native.refresh(root, { persistIdentity: false, changedPaths: [makefilePath] });
  oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [makefilePath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.equal(graph.analysis.refresh.analyzedFiles, 1);
  assert.equal(graph.nodes.find((node) => node.path === makefilePath).language, "makefile");

  fs.rmSync(path.join(root, ...shellPath.split("/")));
  graph = await native.refresh(root, { persistIdentity: false, changedPaths: [shellPath] });
  oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [shellPath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.equal(graph.analysis.refresh.removedFiles, 1);
  assert.equal(graph.nodes.some((node) => node.path === shellPath), false);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("strict Rust persistent session incrementally updates inventory-only files through the native SQLite lifecycle", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-persistent-inventory-only-events-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const run = () => true;\n");
  const shellPath = "scripts/deploy.sh";
  fs.writeFileSync(path.join(root, ...shellPath.split("/")), "#!/usr/bin/env bash\necho deploy\n");
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await native.scan(root);
  javascript.scan(root);

  fs.appendFileSync(path.join(root, ...shellPath.split("/")), "echo changed\n");
  let graph = await native.refresh(root, { changedPaths: [shellPath] });
  let oracle = javascript.refresh(root, { changedPaths: [shellPath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.equal(graph.analysis.refresh.analyzedFiles, 1);
  assert.equal(graph.nodes.find((node) => node.path === shellPath).analysis.status, "inventory-only");

  const makefilePath = "Makefile";
  fs.writeFileSync(path.join(root, makefilePath), "build:\n\techo build\n");
  graph = await native.refresh(root, { changedPaths: [makefilePath] });
  oracle = javascript.refresh(root, { changedPaths: [makefilePath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.equal(graph.nodes.find((node) => node.path === makefilePath).language, "makefile");

  fs.rmSync(path.join(root, ...shellPath.split("/")));
  graph = await native.refresh(root, { changedPaths: [shellPath] });
  oracle = javascript.refresh(root, { changedPaths: [shellPath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.equal(graph.analysis.refresh.removedFiles, 1);
  assert.equal(graph.nodes.some((node) => node.path === shellPath), false);
  assert.ok(requests.filter((request) => request.method === "refreshNativePersistentProject").length >= 4);
});

test("strict Rust source authority preserves JavaScript Unicode file ordering", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-unicode-order-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const filename of ["Ångström.ts", "ábc.ts", "emoji-😀.ts", "e\u0301clair.ts", "Éclair.ts"]) {
    fs.writeFileSync(path.join(root, "src", filename), `export const value = ${JSON.stringify(filename)};\n`);
  }
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(COLLATION_LOCALE, "en");
  assert.deepEqual(graph.nodes, oracle.nodes);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  // This exercises the Rust query authority against the JavaScript public
  // query implementation. The matches include both precomposed and
  // decomposed Unicode file names, so their result order must not come from
  // the host machine's ambient locale.
  const query = { query: "clair", scope: "all" };
  assert.deepEqual(await native.findNodes(graph, query), javascript.findNodes(oracle, query));
});

test("strict Rust persistent lifecycle keeps the fact batch inside the native session", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-persistent-handle-"));
  fs.cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
  assert.equal(requests.some((request) => request.method === "persistNativePublicGraph"), false);
  assert.equal(native.extensionAdapterMethods.includes("getScanStatus"), false);
  assert.equal(native.extensionAdapterMethods.includes("getProjectOverview"), false);
  await native.getScanStatus(graph);
  assert.ok(requests.some((request) => request.method === "getNativeScanStatus"));
  const viewOptions = [
    { mode: "overview", scope: "application", level: "domain" },
    { mode: "overview", scope: "application", level: "feature" },
    { mode: "requests", scope: "application", level: "symbol" },
    { mode: "dependencies", scope: "application", focus: graph.nodes.find((node) => node.kind === "file").id, maxNodes: 8, maxEdges: 8 },
  ];
  for (const options of viewOptions) {
    const actual = await native.getProjectOverview(graph, options);
    const expected = projectView(graph, options);
    // Projection authority must be byte-for-byte compatible. The derived
    // cache audit is deliberately invocation-local: each request appends its
    // own hit/miss event, so sequentially invoking both implementations would
    // make that audit timeline differ by exactly one event.
    assert.deepEqual({ ...actual, aiContext: { ...actual.aiContext, derivedCache: null } }, { ...expected, aiContext: { ...expected.aiContext, derivedCache: null } });
  }
  assert.ok(requests.some((request) => request.method === "getNativeProjectOverviewCore"));
  await native.findNodes(graph, { query: "submit" });
  assert.equal(requests.some((request) => request.method === "getNativeCurrentPublicGraph"), false);
});

test("strict Rust handle-only scan keeps public graph collections out of Node", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-handle-only-"));
  fs.cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const graph = await native.scan(root, { nativeGraphHandle: true });
  assert.equal(graph.analysis.graphState.transport, "handle-only");
  assert.equal(Object.hasOwn(graph, "nodes"), false);
  assert.equal(Object.hasOwn(graph, "edges"), false);
  const refresh = requests.find((request) => request.method === "refreshNativePersistentProject");
  assert.equal(refresh.params.returnPublicGraph, false);
  assert.equal(Object.hasOwn(refresh.result, "graph"), false);
  assert.equal(Object.hasOwn(refresh.result, "publicGraphEnvelope"), true);
  assert.equal(Object.hasOwn(refresh.result.publicGraphEnvelope, "nodes"), false);

  const matches = await native.findNodes(graph, { query: "validation" });
  assert.ok(matches.results.length > 0);
  const query = requests.find((request) => request.method === "findNodes");
  assert.equal(Object.hasOwn(query.params, "batch"), false);
  const overview = await native.getProjectOverview(graph, { mode: "overview", scope: "application", level: "feature" });
  assert.ok(overview?.nodes?.length >= 0);
  const node = matches.results[0];
  assert.equal((await native.getNode(graph, node.id)).node.id, node.id);
  assert.ok((await native.getContextCard(graph, node.id))?.card);
  const flows = await native.getEntryFlows(graph);
  const flow = Array.isArray(flows) ? flows[0] : flows.items?.[0] || flows.flows?.[0];
  assert.ok(flow, "fixture must expose an application flow");
  const lens = await native.getFlowProjection(graph, flow.id);
  assert.equal(lens.flow.id, flow.id);
  assert.ok((await native.getFlowContextCard(graph, flow.id))?.card);
  const resolved = await native.resolveContextRef(graph, lens.flow.contextRef);
  assert.equal(resolved.status, "current");
  assert.equal(resolved.card?.kind, "flow");

  const materialized = await native.materializeGraph(graph);
  assert.ok(Array.isArray(materialized.nodes));
  assert.equal(materialized.project.projectId, graph.project.projectId);
  assert.equal(materialized.state.graphVersion, graph.state.graphVersion);
  assert.ok(requests.some((request) => request.method === "materializeNativeGraph"));
});

test("native last-complete recovery keeps the StructuralFactBatch in Rust", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-last-complete-handle-"));
  fs.cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const writer = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust" });
  const requests = [];
  const reader = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  context.after(async () => {
    await writer.close();
    await reader.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const expected = await writer.scan(root);
  const restored = await reader.getLastCompleteGraph(root);
  assert.ok(restored);
  assert.equal(createCoreCompatibilityDigest(restored), createCoreCompatibilityDigest(expected));
  const recovery = requests.find((request) => request.method === "getNativeCurrentPublicGraph");
  assert.ok(recovery);
  assert.equal(Object.hasOwn(recovery.result, "batch"), false);
  assert.equal(recovery.result.graphHandle.schemaVersion, "flopeek-native-graph-handle/v1");
  await reader.findNodes(restored, { query: "submit" });
  const query = requests.find((request) => request.method === "findNodes");
  assert.equal(Object.hasOwn(query.params, "batch"), false);
  assert.equal(query.params.factsDigest, recovery.result.graphHandle.factsDigest);
});

test("strict Rust no-cache handle-only scan keeps its public graph inside the native session", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-ephemeral-handle-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  context.after(async () => { await native.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const graph = await native.scan(root, { persistIdentity: false, nativeGraphHandle: true });
  assert.equal(graph.analysis.graphState.transport, "handle-only");
  assert.equal(Object.hasOwn(graph, "nodes"), false);
  const refresh = requests.find((request) => request.method === "refreshNativeJsSessionGraph");
  assert.equal(refresh.params.returnPublicGraph, false);
  assert.equal(Object.hasOwn(refresh.result, "graph"), false);
  assert.equal(Object.hasOwn(refresh.result.publicGraphEnvelope, "nodes"), false);
  await native.findNodes(graph, { query: "validation" });
  const query = requests.find((request) => request.method === "findNodes");
  assert.equal(query.params.sessionGraph.schemaVersion, "flopeek-native-session-graph-handle/v1");
  const materialized = await native.materializeGraph(graph);
  assert.ok(Array.isArray(materialized.nodes));
  assert.equal(materialized.project.projectId, graph.project.projectId);
  assert.equal(materialized.state.graphVersion, graph.state.graphVersion);
  const materialization = requests.find((request) => request.method === "materializeNativeGraph");
  assert.equal(materialization.params.sessionGraph.schemaVersion, "flopeek-native-session-graph-handle/v1");
  assert.equal(Object.hasOwn(materialization.params, "projectRoot"), false);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("strict Rust source authority supports a no-cache session without repository metadata", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-ephemeral-"));
  fs.cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root, { persistIdentity: false });
  const oracle = javascript.scan(root, { persistIdentity: false, sessionProjectId: graph.project.projectId });
  assert.deepEqual(graph.analysis.refresh, oracle.analysis.refresh);
  assert.equal(graph.analysis.graphState.persistence, "session-memory");
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
  assert.ok(requests.some((request) => request.method === "refreshNativeJsSessionGraph"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
  const firstRefresh = requests.find((request) => request.method === "refreshNativeJsSessionGraph");
  const coldResponseBytes = firstRefresh.responseStats.responseBytes;
  const repeated = await native.refresh(root, { persistIdentity: false, changedPaths: [] });
  const noOpRefresh = requests.filter((request) => request.method === "refreshNativeJsSessionGraph").at(-1);
  const noOpResponseBytes = noOpRefresh.responseStats.responseBytes;
  assert.equal(repeated.state.graphVersion, graph.state.graphVersion);
  assert.deepEqual(repeated.analysis.refresh, {
    strategy: "incremental-content-analysis",
    mode: "incremental",
    analyzedFiles: 0,
    reusedFiles: graph.stats.scannedFiles,
    removedFiles: 0,
    changedPaths: [],
  });
  assert.equal(requests.filter((request) => request.method === "refreshNativeJsSessionGraph").length, 2);
  assert.equal(requests.filter((request) => request.method === "refreshNativeSessionGraph").length, 0);
  assert.ok(noOpResponseBytes < coldResponseBytes, "no-op session refresh must omit immutable public graph collections from JSONL");
  await native.findNodes(repeated, { query: "submit" });
  const nativeQuery = requests.find((request) => request.method === "findNodes");
  assert.ok(nativeQuery);
  assert.equal(nativeQuery.params.batch, undefined);
  assert.equal(nativeQuery.params.sessionGraph.schemaVersion, "flopeek-native-session-graph-handle/v1");
  assert.equal(nativeQuery.params.sessionGraph.projectId, repeated.project.projectId);
  assert.match(nativeQuery.params.sessionGraph.factsDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(nativeQuery.params.sessionGraph.persistence, "session-memory");
  assert.equal(nativeQuery.params.sessionGraph.publicGraphVersion, repeated.state.graphVersion);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("strict Rust ephemeral refresh reparses only a declared changed JS/TS path", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-ephemeral-changed-path-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust", sessionId: "changed-path" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await native.scan(root, { persistIdentity: false });
  javascript.scan(root, { persistIdentity: false, sessionProjectId: "session:changed-path" });
  const changedPath = "src/orders/orders.service.ts";
  fs.appendFileSync(path.join(root, ...changedPath.split("/")), "\n");
  const refreshed = await native.refresh(root, { persistIdentity: false, changedPaths: [changedPath] });
  const oracle = javascript.refresh(root, { persistIdentity: false, sessionProjectId: "session:changed-path", changedPaths: [changedPath] });
  assert.equal(createCoreCompatibilityDigest(refreshed), createCoreCompatibilityDigest(oracle));
  assert.equal(refreshed.analysis.refresh.mode, "incremental");
  assert.equal(refreshed.analysis.refresh.analyzedFiles, 1);
  assert.equal(refreshed.analysis.refresh.changedPaths[0], changedPath);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("strict Rust ephemeral session handles declared JS/TS add, delete, and rename events", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-ephemeral-file-events-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust", sessionId: "file-events" });
  const javascript = createJsCoreClient();
  const sessionOptions = { persistIdentity: false, sessionProjectId: "session:file-events" };
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await native.scan(root, { persistIdentity: false });
  javascript.scan(root, sessionOptions);
  const addedPath = "src/orders/session-added.ts";
  const renamedPath = "src/orders/session-renamed.ts";
  fs.writeFileSync(path.join(root, ...addedPath.split("/")), "export const sessionAdded = () => 1;\n");
  let graph = await native.refresh(root, { persistIdentity: false, changedPaths: [addedPath] });
  let oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [addedPath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  fs.renameSync(path.join(root, ...addedPath.split("/")), path.join(root, ...renamedPath.split("/")));
  graph = await native.refresh(root, { persistIdentity: false, changedPaths: [addedPath, renamedPath] });
  oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [addedPath, renamedPath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  fs.rmSync(path.join(root, ...renamedPath.split("/")));
  graph = await native.refresh(root, { persistIdentity: false, changedPaths: [renamedPath] });
  oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [renamedPath] });
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.equal(graph.analysis.refresh.removedFiles, 1);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("strict Rust ephemeral refresh ignores watcher events from excluded directories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-ignored-event-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust", sessionId: "ignored-event" });
  const javascript = createJsCoreClient();
  const sessionOptions = { persistIdentity: false, sessionProjectId: "session:ignored-event" };
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const initial = await native.scan(root, { persistIdentity: false });
  javascript.scan(root, sessionOptions);
  const ignoredPath = "node_modules/transient/index.ts";
  fs.mkdirSync(path.join(root, "node_modules", "transient"), { recursive: true });
  fs.writeFileSync(path.join(root, ...ignoredPath.split("/")), "export const transient = true;\n");
  const refreshed = await native.refresh(root, { persistIdentity: false, changedPaths: [ignoredPath] });
  const oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [ignoredPath] });
  assert.equal(createCoreCompatibilityDigest(refreshed), createCoreCompatibilityDigest(initial));
  assert.equal(createCoreCompatibilityDigest(refreshed), createCoreCompatibilityDigest(oracle));
  assert.equal(refreshed.nodes.some((node) => node.path === ignoredPath), false);
  assert.deepEqual(refreshed.analysis.refresh.changedPaths, []);
  assert.equal(refreshed.analysis.refresh.analyzedFiles, 0);
});

test("strict Rust excluded add and delete events reconcile repository-scope counts immediately", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-excluded-membership-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated"), { recursive: true });
  fs.mkdirSync(path.join(root, ".flopeek"), { recursive: true });
  fs.writeFileSync(path.join(root, ".flopeek", "config.json"), JSON.stringify({
    schemaVersion: 1,
    exclude: ["generated/**"],
  }));
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export const main = true;\n");
  const native = createNativeCoreClient({
    native: nativeClient(),
    sourceAuthority: "rust",
    sessionId: "excluded-membership",
  });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  let graph = await native.scan(root, { persistIdentity: false });
  assert.equal(graph.analysis.repositoryScope.counts.excluded, 0);
  const excludedPath = "generated/new-client.ts";
  fs.writeFileSync(path.join(root, ...excludedPath.split("/")), "export const generated = true;\n");
  graph = await native.refresh(root, { persistIdentity: false, changedPaths: [excludedPath] });
  assert.equal(graph.analysis.repositoryScope.counts.excluded, 1);
  assert.equal(graph.nodes.some((node) => node.path === excludedPath), false);
  fs.rmSync(path.join(root, ...excludedPath.split("/")));
  graph = await native.refresh(root, { persistIdentity: false, changedPaths: [excludedPath] });
  assert.equal(graph.analysis.repositoryScope.counts.excluded, 0);
});

test("strict Rust ephemeral session reconciles explicitly after scope configuration changes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-ephemeral-scope-reconcile-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust", sessionId: "scope-reconcile" });
  const javascript = createJsCoreClient();
  const sessionOptions = { persistIdentity: false, sessionProjectId: "session:scope-reconcile" };
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await native.scan(root, { persistIdentity: false });
  javascript.scan(root, sessionOptions);
  fs.mkdirSync(path.join(root, ".flopeek"), { recursive: true });
  fs.writeFileSync(path.join(root, ".flopeek", "config.json"), JSON.stringify({ schemaVersion: 1, projectId: "project:scope-reconcile" }));
  const refreshed = await native.refresh(root, { persistIdentity: false, changedPaths: [".flopeek/config.json"] });
  const oracle = javascript.refresh(root, { ...sessionOptions, changedPaths: [".flopeek/config.json"] });
  assert.equal(createCoreCompatibilityDigest(refreshed), createCoreCompatibilityDigest(oracle));
  assert.equal(refreshed.project.projectId, "session:scope-reconcile");
  assert.equal(refreshed.project.identity.canonicalProjectId, "project:scope-reconcile");
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "project.json")), false);
});

test("strict Rust ephemeral identity matches JavaScript session identity when a configured projectId exists", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-ephemeral-configured-id-"));
  fs.cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  fs.mkdirSync(path.join(root, ".flopeek"), { recursive: true });
  fs.writeFileSync(path.join(root, ".flopeek", "config.json"), JSON.stringify({ schemaVersion: 1, projectId: "project:configured" }));
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust", sessionId: "identity-parity" });
  const javascript = createJsCoreClient({ sessionId: "identity-parity" });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nativeGraph = await native.scan(root, { persistIdentity: false });
  const javascriptGraph = javascript.scan(root, { persistIdentity: false, sessionProjectId: "session:identity-parity" });
  assert.equal(nativeGraph.project.projectId, "session:identity-parity");
  assert.equal(nativeGraph.project.projectId, javascriptGraph.project.projectId);
  assert.equal(nativeGraph.project.identity.canonicalProjectId, "project:configured");
  assert.equal(nativeGraph.project.identity.canonicalProjectId, javascriptGraph.project.identity.canonicalProjectId);
  assert.equal(nativeGraph.project.identity.status, "session-only");
  assert.equal(nativeGraph.project.identity.status, javascriptGraph.project.identity.status);
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "project.json")), false);
});

test("strict Rust source authority preserves cold graph parity across every eligible baseline fixture", async (context) => {
  const eligible = new Set([
    "commonjs-call-flow",
    "django-management-command-flow",
    "framework-command-flow",
    "legacy-handoff",
    "monorepo-package-selection",
    "next-request-flow",
    "node-cron-schedule-flow",
    "package-script-flow",
    "php-package-flow",
    "python-payment-flow",
    "typescript-order-flow",
  ]);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-corpus-"));
  const native = createNativeCoreClient({ native: nativeClient(), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  let compared = 0;
  for (const fixture of CORE_BASELINE.cases.filter((candidate) => eligible.has(candidate.id))) {
    const root = path.join(sandbox, fixture.id);
    fs.cpSync(path.join(ROOT, fixture.fixture), root, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".flopeek",
    });
    const graph = await native.scan(root);
    const oracle = javascript.scan(root);
    assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle), fixture.id);
    assert.deepEqual(graph.stats, oracle.stats, fixture.id);
    compared += 1;
  }
  assert.equal(compared, 11);
});

test("strict Rust source authority uses its Python adapter rather than the JavaScript parser host", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-python-"));
  fs.cpSync(path.join(ROOT, "test", "fixtures", "python-payment-flow"), root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
});

test("strict Rust source authority uses its PHP adapter rather than the JavaScript parser host", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-php-"));
  fs.cpSync(path.join(ROOT, "test", "fixtures", "php-package-flow"), root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
});

test("strict Rust source authority resolves Rust crate, self, and super imports without the JavaScript parser host", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-rust-"));
  fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"rust-source-example\"\nversion = \"0.1.0\"\n");
  fs.mkdirSync(path.join(root, "src", "area", "child"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "lib.rs"), "mod helpers;\nmod area;\nuse crate::helpers::{parse as parse_value};\nuse crate::helpers::parse as parse_direct;\n\npub fn execute_root() { parse_value(); }\npub fn execute_direct() { parse_direct(); }\n");
  fs.writeFileSync(path.join(root, "src", "helpers.rs"), "pub fn parse() {}\n");
  fs.writeFileSync(path.join(root, "src", "area", "mod.rs"), "pub mod child;\npub mod shared;\n");
  fs.writeFileSync(path.join(root, "src", "area", "child.rs"), "mod local;\nuse super::shared::normalize;\nuse self::local::normalize as normalize_local;\n\npub fn execute_child() { normalize(); }\npub fn execute_self() { normalize_local(); }\n");
  fs.writeFileSync(path.join(root, "src", "area", "shared.rs"), "pub fn normalize() {}\n");
  fs.writeFileSync(path.join(root, "src", "area", "child", "local.rs"), "pub fn normalize() {}\n");
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.deepEqual(graph.stats, oracle.stats);
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
});

test("strict Rust source authority uses its Java adapter without turning Java standard imports into externals", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-java-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "java-source-example" }));
  fs.writeFileSync(path.join(root, "src", "OrdersService.java"), "import java.util.List;\nimport com.acme.audit.Audit;\n\nclass OrdersService {\n  static boolean submit(String id) { return validate(id); }\n  static boolean validate(String id) { return id != null; }\n  void helper() {}\n}\n");
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.deepEqual(graph.stats, oracle.stats);
  assert.ok(graph.nodes.some((node) => node.id === "external:com.acme.audit.Audit"));
  assert.equal(graph.nodes.some((node) => node.id === "external:java.util.List"), false);
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
});

test("strict Rust source authority uses its Svelte adapter without the JavaScript parser host", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-svelte-"));
  fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "svelte-source-example" }));
  fs.writeFileSync(path.join(root, "src", "routes", "+page.svelte"), "<script context=\"module\">\n  import meta from '../lib/meta.js';\n</script>\n<script lang=\"ts\">\n  import Card from '../lib/Card.svelte';\n</script>\n<Card />\n");
  fs.writeFileSync(path.join(root, "src", "lib", "Card.svelte"), "<h1>Card</h1>\n");
  fs.writeFileSync(path.join(root, "src", "lib", "meta.js"), "export default { title: 'Card' };\n");
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  const oracle = javascript.scan(root);
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(oracle));
  assert.deepEqual(graph.stats, oracle.stats);
  assert.equal(graph.nodes.find((node) => node.path === "src/routes/+page.svelte").analysis.parser, "svelte-static-ast");
  assert.ok(graph.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/routes/+page.svelte" && edge.target === "file:src/lib/Card.svelte"));
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
});

test("strict Rust source authority uses its bundled C# adapter without the JavaScript parser host", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-source-csharp-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "csharp-source-example" }));
  fs.writeFileSync(path.join(root, "src", "OrdersService.cs"), "using System;\nusing Acme.Data;\nnamespace Acme; public class OrdersService { public void Submit() {} private int Count() => 1; }");
  const requests = [];
  const native = createNativeCoreClient({ native: observedNativeRequests(requests), sourceAuthority: "rust" });
  context.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = await native.scan(root);
  assert.equal(graph.nodes.find((node) => node.path === "src/OrdersService.cs").analysis.parser, "csharp-static-ast");
  assert.deepEqual(graph.nodes.find((node) => node.id === "symbol:src/OrdersService.cs:class:OrdersService").methods, ["Submit", "Count"]);
  const compatibilityCsharp = graph.analysis.adapterCapabilities.adapters.find((adapter) => adapter.id === "csharp");
  const executionCsharp = graph.analysis.executionAdapterCapabilities.adapters.find((adapter) => adapter.id === "csharp");
  assert.equal(compatibilityCsharp.parser, "csharp-roslyn");
  assert.equal(compatibilityCsharp.availability, "toolchain-conditional");
  assert.equal(compatibilityCsharp.requiredToolchain, ".NET SDK");
  assert.equal(executionCsharp.parser, "csharp-static-ast");
  assert.equal(executionCsharp.availability, "bundled");
  assert.equal(executionCsharp.requiredToolchain, null);
  assert.ok(graph.nodes.some((node) => node.id === "external:System"));
  assert.ok(graph.nodes.some((node) => node.id === "external:Acme.Data"));
  assert.ok(requests.some((request) => request.method === "refreshNativePersistentProject"));
  assert.equal(requests.some((request) => request.method === "nativeJsStructuralFacts"), false);
});
