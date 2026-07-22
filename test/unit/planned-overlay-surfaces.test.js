"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { createContinuationCheckpoint } = require("../../src/continuation-checkpoint");
const { createMcpServer } = require("../../src/mcp");
const { createPlannedOverlay } = require("../../src/planned-overlay");
const { scanRepository, writeGraphCache } = require("../../src/scanner");
const { startServer } = require("../../src/server");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function fixture(root, name) {
  write(root, "package.json", JSON.stringify({ name }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
}

async function post(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function checkpointInput(graph, contextRef) {
  return {
    operationId: "planned-surface-checkpoint-v1",
    id: "checkpoint.planned-surface-v1",
    expectedGraphVersion: graph.state.graphVersion,
    selectedContextRefs: [contextRef],
    createdBy: "local developer",
    createdByKind: "human",
  };
}

function overlayInput(graph, contextRef, overrides = {}) {
  return {
    operationId: "planned-surface-overlay-v1",
    id: "overlay.planned-surface-v1",
    expectedGraphVersion: graph.state.graphVersion,
    checkpointId: "checkpoint.planned-surface-v1",
    nodes: [{
      id: "planned.order-audit",
      kind: "service",
      title: "Order audit projection",
      responsibility: "Record one planned order audit boundary.",
      acceptanceCriteria: ["The planned audit boundary has an explicit static anchor."],
      anchors: [contextRef],
      candidatePath: "src/orders/order-audit.ts",
    }],
    edges: [{
      relationship: "planned_after",
      source: { kind: "context-ref", contextRef },
      target: { kind: "planned-node", plannedNodeId: "planned.order-audit" },
    }],
    createdBy: "local developer",
    createdByKind: "human",
    ...overrides,
  };
}

function mcpPayload(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function connectMcp(root) {
  const instance = await createMcpServer({ root, cache: true });
  const [{ Client }, { InMemoryTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "planned-overlay-surface-test", version: "1.0.0" });
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { instance, client };
}

test("HTTP planned-overlay surfaces expose exact Plan Refs and keep stale anchors explicit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-planned-http-"));
  let app;
  try {
    fixture(root, "planned-http");
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
    const flow = (await (await fetch(`${baseUrl}/api/flows`)).json())[0];
    const contextRef = (await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(flow.id)}`)).json()).card.contextRef;
    const checkpoint = await post(baseUrl, "/api/continuation-checkpoints", checkpointInput(graph, contextRef));
    assert.equal(checkpoint.status, 201);
    const denied = await post(baseUrl, "/api/planned-overlays", overlayInput(graph, contextRef), { origin: "https://example.invalid" });
    assert.equal(denied.status, 403);
    const created = await post(baseUrl, "/api/planned-overlays", overlayInput(graph, contextRef));
    assert.equal(created.status, 201);
    assert.equal(created.body.overlay.id, "overlay.planned-surface-v1");
    assert.equal(created.body.overlay.nodes[0].planRef.startsWith("fpp://local/"), true);
    const planRef = created.body.overlay.nodes[0].planRef;
    const listed = await (await fetch(`${baseUrl}/api/planned-overlays`)).json();
    assert.equal(listed.records[0].id, "overlay.planned-surface-v1");
    assert.equal(listed.records[0].checkpointFreshnessStatus, "current");
    const shown = await (await fetch(`${baseUrl}/api/planned-overlay?id=overlay.planned-surface-v1`)).json();
    assert.equal(shown.overlay.nodes[0].planRef, planRef);
    const resolved = await (await fetch(`${baseUrl}/api/plan/resolve?ref=${encodeURIComponent(planRef)}`)).json();
    assert.equal(resolved.status, "current");
    assert.equal(resolved.resolvedRef, planRef);
    assert.equal(resolved.plan.node.id, "planned.order-audit");
    const factual = await (await fetch(`${baseUrl}/api/context/resolve?ref=${encodeURIComponent(planRef)}`)).json();
    assert.equal(factual.status, "unresolved");
    assert.equal(factual.code, "unsupported-context-ref");
    const wrongPlanKind = await (await fetch(`${baseUrl}/api/plan/resolve?ref=${encodeURIComponent(contextRef)}`)).json();
    assert.equal(wrongPlanKind.status, "unresolved");
    assert.equal(wrongPlanKind.code, "invalid-plan-ref");

    write(root, "src/app/api/orders/route.ts", "export async function POST() { return { ok: true }; }\n");
    assert.equal((await post(baseUrl, "/api/scan", {})).status, 200);
    const stale = await (await fetch(`${baseUrl}/api/plan/resolve?ref=${encodeURIComponent(planRef)}`)).json();
    assert.equal(stale.status, "stale");
    assert.equal(stale.resolvedRef, planRef);
    assert.equal(stale.plan.node.planRef, planRef);
    assert.match(stale.reason, /No current source or Context Ref replacement is inferred/u);
    const refreshedGraph = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.equal(refreshedGraph.nodes.some((node) => node.id === "planned.order-audit"), false);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP planned-overlay tools expose strict metadata-only contracts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-planned-mcp-"));
  let instance;
  let client;
  try {
    fixture(root, "planned-mcp");
    const graph = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, graph, { reason: "planned-overlay-mcp-test" });
    const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
    createContinuationCheckpoint(root, graph, checkpointInput(graph, contextRef));
    ({ instance, client } = await connectMcp(root));
    const tools = await client.listTools();
    for (const name of ["list_planned_overlays", "get_planned_overlay", "resolve_plan_ref", "create_planned_overlay"]) assert.ok(tools.tools.some((tool) => tool.name === name));
    const createTool = tools.tools.find((tool) => tool.name === "create_planned_overlay");
    assert.equal(createTool.annotations.readOnlyHint, false);
    assert.equal(createTool.annotations.destructiveHint, false);
    assert.equal(createTool.annotations.idempotentHint, true);
    const created = mcpPayload(await client.callTool({ name: "create_planned_overlay", arguments: overlayInput(graph, contextRef, { createdByKind: "agent" }) }));
    const planRef = created.overlay.nodes[0].planRef;
    const listed = mcpPayload(await client.callTool({ name: "list_planned_overlays", arguments: {} }));
    assert.equal(listed.records[0].id, created.overlay.id);
    const shown = mcpPayload(await client.callTool({ name: "get_planned_overlay", arguments: { overlayId: created.overlay.id } }));
    assert.equal(shown.overlay.nodes[0].planRef, planRef);
    const resolved = mcpPayload(await client.callTool({ name: "resolve_plan_ref", arguments: { planRef } }));
    assert.equal(resolved.status, "current");
    const unsafe = await client.callTool({ name: "create_planned_overlay", arguments: { ...overlayInput(graph, contextRef, { operationId: "planned-mcp-unsafe", id: "overlay.planned-mcp-unsafe" }), rawLog: "not allowed" } });
    assert.equal(unsafe.isError, true);
    const invalidRef = mcpPayload(await client.callTool({ name: "resolve_plan_ref", arguments: { planRef: contextRef } }));
    assert.equal(invalidRef.status, "unresolved");
    assert.equal(invalidRef.code, "invalid-plan-ref");
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI planned-overlay list, show, create, and resolve preserve one overlay identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-planned-cli-"));
  try {
    fixture(root, "planned-cli");
    const graph = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, graph, { reason: "planned-overlay-cli-test" });
    const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
    createContinuationCheckpoint(root, graph, checkpointInput(graph, contextRef));
    const inputPath = path.join(root, "planned-overlay-input.json");
    fs.writeFileSync(inputPath, JSON.stringify(overlayInput(graph, contextRef)), "utf8");
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const created = JSON.parse(execFileSync(process.execPath, [cli, "continue", "plan", "create", root, "--input", inputPath, "--format", "json"], { encoding: "utf8" }));
    const planRef = created.overlay.nodes[0].planRef;
    const listed = JSON.parse(execFileSync(process.execPath, [cli, "continue", "plan", "list", root, "--format", "json"], { encoding: "utf8" }));
    const shown = JSON.parse(execFileSync(process.execPath, [cli, "continue", "plan", "show", root, "--overlay", created.overlay.id, "--format", "json"], { encoding: "utf8" }));
    const resolved = JSON.parse(execFileSync(process.execPath, [cli, "continue", "plan", "resolve", root, "--plan-ref", planRef, "--format", "json"], { encoding: "utf8" }));
    assert.equal(listed.records[0].id, created.overlay.id);
    assert.equal(shown.overlay.nodes[0].planRef, planRef);
    assert.equal(resolved.resolvedRef, planRef);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP, MCP, and CLI return the same planned-overlay projection for one repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-planned-parity-"));
  let app;
  let instance;
  let client;
  try {
    fixture(root, "planned-parity");
    const graph = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, graph, { reason: "planned-overlay-parity-test" });
    const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
    createContinuationCheckpoint(root, graph, checkpointInput(graph, contextRef));
    createPlannedOverlay(root, graph, overlayInput(graph, contextRef));
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const http = await (await fetch(`http://127.0.0.1:${app.port}/api/planned-overlays`)).json();
    ({ instance, client } = await connectMcp(root));
    const mcp = mcpPayload(await client.callTool({ name: "list_planned_overlays", arguments: {} }));
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const command = JSON.parse(execFileSync(process.execPath, [cli, "continue", "plan", "list", root, "--format", "json"], { encoding: "utf8" }));
    assert.deepEqual(mcp, http);
    assert.deepEqual(command, http);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
