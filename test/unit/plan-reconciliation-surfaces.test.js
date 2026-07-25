"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

function fixture(root) {
  write(root, "package.json", JSON.stringify({ name: "plan-reconciliation-surfaces" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
}

function reconciliationInput(graph, planRef, overrides = {}) {
  return {
    operationId: "reconciliation-surface-v1",
    id: "reconciliation.surface-v1",
    planRef,
    actualContextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion)],
    outcome: "confirmed-implemented",
    actor: "local developer",
    actorKind: "human",
    evidenceReferences: [{ kind: "manual-review", reference: "review:surface", evidenceClass: "human-observation" }],
    ...overrides,
  };
}

function plan(root, graph) {
  const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
  createContinuationCheckpoint(root, graph, {
    operationId: "reconciliation-surface-checkpoint-v1",
    id: "checkpoint.reconciliation-surface-v1",
    expectedGraphVersion: graph.state.graphVersion,
    selectedContextRefs: [contextRef],
    createdBy: "local developer",
    createdByKind: "human",
  });
  const overlay = createPlannedOverlay(root, graph, {
    operationId: "reconciliation-surface-overlay-v1",
    id: "overlay.reconciliation-surface-v1",
    expectedGraphVersion: graph.state.graphVersion,
    checkpointId: "checkpoint.reconciliation-surface-v1",
    nodes: [{ id: "planned.order-audit", kind: "service", title: "Order audit", responsibility: null, acceptanceCriteria: [], anchors: [contextRef], candidatePath: null }],
    edges: [],
    createdBy: "local developer",
    createdByKind: "human",
  }).overlay;
  return {
    checkpointId: "checkpoint.reconciliation-surface-v1",
    overlayId: overlay.id,
    planRef: `fpp://local/${encodeURIComponent(graph.project.projectId)}/checkpoint.reconciliation-surface-v1/planned.order-audit@${overlay.overlayVersion}`,
  };
}

async function post(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function payload(result) {
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
  const client = new Client({ name: "plan-reconciliation-surface-test", version: "1.0.0" });
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { instance, client };
}

test("HTTP, MCP, and CLI expose the same append-only plan-reconciliation projection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-plan-reconciliation-surfaces-"));
  let app;
  let instance;
  let client;
  try {
    fixture(root);
    const graph = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, graph, { reason: "plan-reconciliation-surface-test" });
    const continuation = plan(root, graph);
    const { checkpointId, overlayId, planRef } = continuation;
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const denied = await post(baseUrl, "/api/plan-reconciliations", reconciliationInput(graph, planRef), { origin: "https://example.invalid" });
    assert.equal(denied.status, 403);
    const created = await post(baseUrl, "/api/plan-reconciliations", reconciliationInput(graph, planRef));
    assert.equal(created.status, 201);
    assert.equal(created.body.reconciliation.outcome, "confirmed-implemented");
    const http = await (await fetch(`${baseUrl}/api/plan-reconciliations?planRef=${encodeURIComponent(planRef)}`)).json();
    assert.equal(http.records.length, 1);
    assert.equal((await (await fetch(`${baseUrl}/api/plan-reconciliation?id=reconciliation.surface-v1`)).json()).reconciliation.id, "reconciliation.surface-v1");
    ({ instance, client } = await connectMcp(root));
    const toolList = await client.listTools();
    assert.ok(toolList.tools.some((tool) => tool.name === "list_plan_reconciliations"));
    assert.ok(toolList.tools.some((tool) => tool.name === "record_plan_reconciliation"));
    const mcp = payload(await client.callTool({ name: "list_plan_reconciliations", arguments: { planRef } }));
    const httpComparison = await (await fetch(`${baseUrl}/api/continuation-comparison?checkpointId=${encodeURIComponent(checkpointId)}&overlayId=${encodeURIComponent(overlayId)}`)).json();
    assert.equal(httpComparison.status, "available");
    assert.equal(httpComparison.plans[0].status, "reconciled");
    assert.ok(toolList.tools.some((tool) => tool.name === "get_continuation_comparison"));
    const mcpComparison = payload(await client.callTool({ name: "get_continuation_comparison", arguments: { checkpointId, overlayId } }));
    const httpDivergence = await (await fetch(`${baseUrl}/api/checkpoint-divergence?checkpointId=${encodeURIComponent(checkpointId)}`)).json();
    assert.equal(httpDivergence.status, "non-git");
    assert.ok(toolList.tools.some((tool) => tool.name === "get_checkpoint_divergence"));
    const mcpDivergence = payload(await client.callTool({ name: "get_checkpoint_divergence", arguments: { checkpointId } }));
    const httpContinuationContext = await (await fetch(`${baseUrl}/api/continuation-context?checkpointId=${encodeURIComponent(checkpointId)}&overlayId=${encodeURIComponent(overlayId)}&tokenBudget=2048`)).json();
    assert.equal(httpContinuationContext.schemaVersion, "flowpeek-continuation-context/v1");
    assert.ok(toolList.tools.some((tool) => tool.name === "get_continuation_context"));
    const mcpContinuationContext = payload(await client.callTool({ name: "get_continuation_context", arguments: { checkpointId, overlayId, tokenBudget: 2048 } }));
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const cliResult = JSON.parse(execFileSync(process.execPath, [cli, "continue", "reconcile", "list", root, "--plan-ref", planRef, "--format", "json"], { encoding: "utf8" }));
    assert.deepEqual(mcp.records, http.records);
    assert.deepEqual(cliResult.records, http.records);
    assert.deepEqual(mcpComparison, httpComparison);
    assert.deepEqual(mcpDivergence, httpDivergence);
    assert.deepEqual(mcpContinuationContext, httpContinuationContext);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
