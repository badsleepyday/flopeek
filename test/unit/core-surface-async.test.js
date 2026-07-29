"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createJsCoreClient } = require("../../src/js-core-client");
const { createMcpServer } = require("../../src/mcp");
const { createNativeCoreClient } = require("../../src/native-core-client");
const { createScanCoordinator } = require("../../src/scan-coordinator");
const { startServer } = require("../../src/server");

test("HTTP core routes await an asynchronous CoreClient query", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-core-surface-async-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "core-surface-async" }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export function asyncSurfaceTarget() { return true; }\n");
  const javascript = createJsCoreClient();
  let findCalls = 0;
  const coreClient = {
    ...javascript,
    findNodes: async (...args) => {
      findCalls += 1;
      return javascript.findNodes(...args);
    },
    getNode: async (...args) => javascript.getNode(...args),
  };
  const app = await startServer({ root, port: 0, cache: false, registerServeWorkspace: false, coreClient });
  let instance;
  let client;
  context.after(async () => {
    if (client) await client.close();
    if (instance) await instance.server.close();
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${app.port}/api/search?query=asyncSurfaceTarget`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.results.some((node) => node.label === "asyncSurfaceTarget"));
  assert.equal(findCalls, 1);

  instance = await createMcpServer({ root, cache: false, coreClient });
  const [{ Client }, { InMemoryTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "flopeek-core-surface-async-test", version: "1.0.0" });
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  const nodeId = result.results.find((node) => node.label === "asyncSurfaceTarget").id;
  const toolResult = await client.callTool({ name: "get_node", arguments: { id: nodeId } });
  assert.equal(toolResult.isError, undefined);
  const detail = JSON.parse(toolResult.content.find((item) => item.type === "text").text);
  assert.equal(detail.node.id, nodeId);
});

test("owned configured core clients close with their MCP and HTTP hosts", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-owned-core-close-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "owned-core-close" }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export const ownedCoreClose = true;\n");
  let serverClosed = 0;
  let mcpClosed = 0;
  const makeCore = (onClose) => ({ ...createJsCoreClient(), close: async () => { onClose(); } });
  let app;
  let instance;
  context.after(async () => {
    if (app?.server.listening) await app.close();
    if (instance) await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  app = await startServer({ root, port: 0, cache: false, registerServeWorkspace: false, mode: "js", javascript: makeCore(() => { serverClosed += 1; }) });
  await app.close();
  assert.equal(serverClosed, 1, "configured HTTP CoreClient closes exactly once");

  instance = await createMcpServer({ root, cache: false, mode: "js", javascript: makeCore(() => { mcpClosed += 1; }) });
  await instance.close();
  assert.equal(mcpClosed, 1, "configured MCP CoreClient closes exactly once");
});

test("native CoreClient coordinator does not dual-write graph.json beside SQLite", async (context) => {
  const source = path.join(__dirname, "..", "fixtures", "typescript-order-flow");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-authority-"));
  fs.cpSync(source, root, { recursive: true, filter: (entry) => path.basename(entry) !== ".flopeek" });
  const coreClient = createNativeCoreClient();
  const coordinator = createScanCoordinator(root, { cache: true, coreClient });
  let app;
  let instance;
  let client;
  context.after(async () => {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    await coreClient.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = await coordinator.refresh(null, "native-authority");
  assert.equal(result.outcome.status, "complete");
  assert.equal(result.graph.analysis.cacheState.status, "native-sqlite");
  assert.equal(result.graph.analysis.cacheState.reason, "native-core-authoritative");
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "native-core.sqlite3")), true);
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "graph.json")), false);

  app = await startServer({ root, port: 0, cache: true, registerServeWorkspace: false, coreClient });
  const knownNode = result.graph.nodes.find((node) => node.kind === "symbol" && node.type === "function");
  assert.ok(knownNode);
  const response = await fetch(`http://127.0.0.1:${app.port}/api/search?query=${encodeURIComponent(knownNode.label)}`);
  assert.equal(response.status, 200);
  const query = await response.json();
  assert.ok(query.results.length > 0);
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "graph.json")), false);

  instance = await createMcpServer({ root, cache: true, coreClient });
  const [{ Client }, { InMemoryTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "flopeek-native-core-surface-test", version: "1.0.0" });
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  const toolResult = await client.callTool({ name: "get_node", arguments: { id: knownNode.id } });
  assert.equal(toolResult.isError, undefined);
  const detail = JSON.parse(toolResult.content.find((item) => item.type === "text").text);
  assert.equal(detail.node.id, knownNode.id);
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "graph.json")), false);
});

test("native coordinator serves SQLite last-complete graph after refresh failure", async (context) => {
  const source = path.join(__dirname, "..", "fixtures", "typescript-order-flow");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-last-complete-"));
  fs.cpSync(source, root, { recursive: true, filter: (entry) => path.basename(entry) !== ".flopeek" });
  const writer = createNativeCoreClient();
  const writerCoordinator = createScanCoordinator(root, { cache: true, coreClient: writer });
  context.after(async () => {
    await writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const promoted = await writerCoordinator.refresh(null, "initial-native-promotion");
  assert.equal(promoted.outcome.status, "complete");
  await writer.close();

  const reader = createNativeCoreClient();
  const failingCore = {
    ...reader,
    refresh: async () => {
      const error = new Error("forced refresh failure after native process restart");
      error.code = "forced-refresh-failure";
      throw error;
    },
  };
  const fallbackCoordinator = createScanCoordinator(root, { cache: true, coreClient: failingCore });
  const fallback = await fallbackCoordinator.refresh(null, "forced-failure");
  await reader.close();
  assert.equal(fallback.outcome.status, "failed");
  assert.equal(fallback.outcome.activeGraph.source, "last-complete-native-sqlite");
  assert.equal(fallback.graph.state.status, "native-last-complete");
  assert.equal(fallback.graph.analysis.graphState.status, "last-complete");
  assert.equal(fallback.graph.analysis.cacheState.status, "native-sqlite");
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "native-core.sqlite3")), true);
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "graph.json")), false);
});
