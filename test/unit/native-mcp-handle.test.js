"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMcpServer } = require("../../src/mcp");
const { createNativeCoreClient } = require("../../src/native-core-client");
const { NativeProtocolClient } = require("../../src/native-protocol-client");
const { nativeTestCommand } = require("../helpers/native-test-command");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
const NATIVE = nativeTestCommand(ROOT);
const payload = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);

test("MCP keeps the primary native graph handle-only in Node", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-mcp-handle-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const native = createNativeCoreClient({
    native: new NativeProtocolClient({
      ...NATIVE,
      requestTimeoutMs: 120_000,
    }),
    sourceAuthority: "rust",
  });
  let client;
  let instance;
  let receivedOptions = null;
  let materializations = 0;
  const observed = {
    ...native,
    refresh: (targetRoot, options) => {
      receivedOptions = { ...options };
      return native.refresh(targetRoot, options);
    },
    materializeGraph: async (graph) => {
      materializations += 1;
      return native.materializeGraph(graph);
    },
  };
  instance = await createMcpServer({ root, cache: true, coreClient: observed });
  const [{ Client }, { InMemoryTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "native-handle-matrix", version: "1.0.0" });
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client?.close();
    await instance?.close();
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = instance.coordinator.currentGraph();
  assert.equal(receivedOptions.nativeGraphHandle, true);
  assert.equal(graph.analysis.graphState.transport, "handle-only");
  assert.equal(Object.hasOwn(graph, "nodes"), false);
  assert.equal(Object.hasOwn(graph, "edges"), false);
  assert.equal(Object.hasOwn(graph, "flows"), false);
  const overview = await native.getProjectOverview(graph, { mode: "overview", scope: "application" });
  assert.ok(overview.display.catalog.nodes.total > 0);
  assert.equal(materializations, 0);

  const tools = await client.listTools();
  for (const name of ["get_handoff_context", "get_product_proof", "get_flow_verification", "get_related_implementations", "create_work_record", "refresh_graph", "get_graph_delta"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `${name} must be registered`);
  }
  const matches = payload(await client.callTool({ name: "find_nodes", arguments: { query: "order" } })).results;
  const node = matches.find((candidate) => candidate.kind === "file");
  assert.ok(node, "fixture query must return a source-file node");
  assert.equal(materializations, 0, "native-safe tools must not materialize the graph");
  const card = payload(await client.callTool({ name: "get_context_card", arguments: { id: node.id } }));
  const contextRef = card.card.contextRef;
  const flows = payload(await client.callTool({ name: "get_entry_flows", arguments: {} }));
  const flow = Array.isArray(flows) ? flows[0] : flows.items?.[0] || flows.flows?.[0];
  assert.ok(flow);

  for (const request of [
    { name: "get_handoff_context", arguments: { taskIntent: "Review order validation flow" } },
    { name: "get_product_proof", arguments: {} },
    { name: "get_flow_verification", arguments: { flowId: flow.id } },
    { name: "get_related_implementations", arguments: { contextRef } },
    { name: "create_work_record", arguments: {
      id: "native-handle-metadata",
      operationId: "native-handle-metadata-create",
      kind: "task",
      title: "Native handle metadata smoke",
      createdAt: "2026-07-30T00:00:00.000Z",
      createdBy: "native-handle-test",
      contextRefs: [contextRef],
    } },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, undefined, `${request.name}: ${result.content?.[0]?.text}`);
  }
  assert.equal(materializations, 1, "legacy tools must share one lazy materialization for the current handle");

  fs.appendFileSync(path.join(root, "src", "orders", "orders.service.ts"), "\n");
  const refreshed = payload(await client.callTool({ name: "refresh_graph", arguments: { paths: ["src/orders/orders.service.ts"] } }));
  assert.equal(refreshed.graphState.graphVersion, 2);
  assert.equal(materializations, 1, "refresh and delta stay handle-safe");
  const delta = payload(await client.callTool({ name: "get_graph_delta", arguments: { fromVersion: 1, toVersion: 2 } }));
  assert.equal(delta.schemaVersion, "flopeek-delta/v1");
  assert.equal(materializations, 1);
  const postRefreshProof = await client.callTool({ name: "get_product_proof", arguments: {} });
  assert.equal(postRefreshProof.isError, undefined);
  assert.equal(materializations, 2, "a new handle receives its own verified lazy materialization");
});

test("cache-disabled MCP lazily materializes from the owning native session without SQLite", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-mcp-session-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  const native = createNativeCoreClient({
    native: new NativeProtocolClient({
      ...NATIVE,
      requestTimeoutMs: 120_000,
    }),
    sourceAuthority: "rust",
  });
  const instance = await createMcpServer({ root, cache: false, coreClient: native });
  const [{ Client }, { InMemoryTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "native-session-materialization", version: "1.0.0" });
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await instance.close();
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const graph = instance.coordinator.currentGraph();
  assert.equal(graph.analysis.graphState.transport, "handle-only");
  assert.equal(graph.analysis.graphState.persistence, "session-memory");
  const result = await client.callTool({ name: "get_handoff_context", arguments: { taskIntent: "Inspect order flow" } });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});
