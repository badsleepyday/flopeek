"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMcpServer } = require("../../src/mcp");
const { projectView } = require("../../src/graph-service");
const { scanRepository } = require("../../src/scanner");
const { startServer } = require("../../src/server");

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function mcpPayload(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

test("semantic zoom retains every selected ancestor and never promotes root files into invented domains", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-semantic-zoom-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "semantic-zoom" }));
    write(root, "src/orders/api.ts", "import { processOrder } from './service';\nexport const order = () => processOrder();\n");
    write(root, "src/orders/service.ts", "export function processOrder() { return true; }\n");
    write(root, "src/users/api.ts", "import { loadUser } from './service';\nexport const user = () => loadUser();\n");
    write(root, "src/users/service.ts", "export function loadUser() { return true; }\n");
    write(root, "src/cli.ts", "export const cli = true;\n");
    const graph = scanRepository(root, { persistIdentity: false });
    const factualIds = graph.nodes.map((node) => node.id).sort();
    const domain = projectView(graph, { level: "domain" });
    assert.equal(domain.view.level, "domain");
    assert.ok(domain.nodes.every((node) => node.kind === "summary" && node.hierarchy.level === "domain"));
    assert.deepEqual(domain.nodes.map((node) => node.label).sort(), ["Orders", "Project", "Users"]);
    const selectedDomain = domain.nodes.find((node) => node.label === "Orders");
    assert.ok(selectedDomain);
    assert.equal(selectedDomain.id, "domain:Orders");
    const feature = projectView(graph, { level: "feature", focus: selectedDomain.id });
    assert.equal(feature.view.hierarchy.parentFocusId, selectedDomain.id);
    assert.ok(feature.nodes.every((node) => node.hierarchy.level === "feature"));
    assert.ok(feature.nodes.every((node) => node.hierarchy.parentId === selectedDomain.id));
    assert.ok(feature.nodes.every((node) => node.id.startsWith("feature:Orders:")));
    const selectedFeature = feature.nodes[0];
    const component = projectView(graph, { level: "component", focus: selectedFeature.id });
    assert.ok(component.nodes.every((node) => node.hierarchy.level === "component"));
    assert.ok(component.nodes.every((node) => node.hierarchy.parentId === selectedFeature.id));
    assert.ok(component.nodes.every((node) => node.id.startsWith("component:Orders:orders:")));
    const selectedComponent = component.nodes[0];
    const symbol = projectView(graph, { level: "symbol", focus: selectedComponent.id });
    assert.equal(symbol.view.level, "symbol");
    assert.ok(symbol.nodes.every((node) => node.kind !== "summary"));
    assert.ok(symbol.nodes.every((node) => node.domain === "Orders" && node.hierarchy.parentId === selectedComponent.id));
    assert.deepEqual(projectView(graph, { level: "component", focus: selectedFeature.id }).nodes.map((node) => node.id), component.nodes.map((node) => node.id));
    assert.deepEqual(graph.nodes.map((node) => node.id).sort(), factualIds);
    assert.equal(symbol.aiContext.level, "symbol");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semantic hierarchy projection has the same constrained result through HTTP and MCP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-semantic-surfaces-"));
  let app;
  let instance;
  let client;
  try {
    write(root, "package.json", JSON.stringify({ name: "semantic-surfaces" }));
    write(root, "src/orders/api.ts", "export const order = true;\n");
    write(root, "src/orders/service.ts", "export const processOrder = true;\n");
    write(root, "src/users/api.ts", "export const user = true;\n");
    const graph = scanRepository(root, { persistIdentity: true });
    const domain = projectView(graph, { level: "domain" }).nodes.find((node) => node.label === "Orders");
    const expected = projectView(graph, { level: "feature", focus: domain.id });
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const http = await (await fetch(`http://127.0.0.1:${app.port}/api/view?level=feature&focus=${encodeURIComponent(domain.id)}`)).json();
    instance = await createMcpServer({ root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "semantic-zoom-surface-test", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const mcp = mcpPayload(await client.callTool({ name: "get_view_projection", arguments: { level: "feature", focus: domain.id } }));
    for (const actual of [http, mcp]) {
      assert.deepEqual(actual.nodes.map((node) => node.id), expected.nodes.map((node) => node.id));
      assert.deepEqual(actual.nodes.map((node) => node.hierarchy.parentId), expected.nodes.map((node) => node.hierarchy.parentId));
      assert.equal(actual.view.hierarchy.parentFocusId, domain.id);
    }
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
