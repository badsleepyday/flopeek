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

function checkpointInput(graph, contextRef, overrides = {}) {
  return {
    operationId: "surface-checkpoint-v1",
    id: "checkpoint.surface-v1",
    expectedGraphVersion: graph.state.graphVersion,
    selectedContextRefs: [contextRef],
    constraints: ["Keep the selected static boundary explicit."],
    acceptanceCriteria: ["The next worker receives the current Flow Context Ref."],
    unresolvedQuestions: ["Who confirms the next delivery plan?"],
    createdBy: "local developer",
    createdByKind: "human",
    ...overrides,
  };
}

function mcpPayload(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

test("HTTP continuation checkpoint surfaces share one graph identity and trusted local mutation gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-http-"));
  let app;
  try {
    fixture(root, "continuation-http");
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const storage = path.join(root, ".flopeek", "delivery", "continuation-checkpoints.json");
    const initial = await (await fetch(`${baseUrl}/api/continuation-checkpoints`)).json();
    assert.equal(initial.status, "available");
    assert.equal(initial.records.length, 0);
    assert.equal(fs.existsSync(storage), false);

    const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
    const flow = (await (await fetch(`${baseUrl}/api/flows`)).json())[0];
    const context = (await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(flow.id)}`)).json()).card.contextRef;
    const input = checkpointInput(graph, context);
    const denied = await post(baseUrl, "/api/continuation-checkpoints", input, { origin: "https://example.invalid" });
    assert.equal(denied.status, 403);
    assert.equal(fs.existsSync(storage), false);

    const created = await post(baseUrl, "/api/continuation-checkpoints", input);
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.body.checkpoint.baseline.graphVersion, graph.state.graphVersion);
    assert.equal(created.body.checkpoint.projectIdentity.projectId, graph.project.projectId);
    assert.equal(created.body.checkpoint.selectedContextRefs[0].contextRef, context);

    const listed = await (await fetch(`${baseUrl}/api/continuation-checkpoints`)).json();
    assert.equal(listed.project.projectId, graph.project.projectId);
    assert.equal(listed.project.graphVersion, graph.state.graphVersion);
    assert.equal(listed.records[0].freshnessStatus, "current");
    const shown = await (await fetch(`${baseUrl}/api/continuation-checkpoint?id=checkpoint.surface-v1`)).json();
    assert.equal(shown.checkpoint.id, "checkpoint.surface-v1");
    assert.equal(JSON.stringify(shown).includes("export async function"), false);
    const replay = await post(baseUrl, "/api/continuation-checkpoints", input);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
    const unsafe = await post(baseUrl, "/api/continuation-checkpoints", { ...input, operationId: "surface-checkpoint-unsafe", id: "checkpoint.surface-unsafe", sourceBody: "export async function secret() {}" });
    assert.equal(unsafe.status, 400);
    assert.equal((await (await fetch(`${baseUrl}/api/graph`)).json()).nodes.some((node) => node.id === "checkpoint.surface-v1"), false);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP continuation checkpoint tools expose strict bounded metadata contracts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-mcp-"));
  let instance;
  let client;
  try {
    fixture(root, "continuation-mcp");
    instance = await createMcpServer({ root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "continuation-surface-test", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    for (const name of ["list_continuation_checkpoints", "get_continuation_checkpoint", "create_continuation_checkpoint"]) assert.ok(tools.tools.some((tool) => tool.name === name));
    const createTool = tools.tools.find((tool) => tool.name === "create_continuation_checkpoint");
    assert.equal(createTool.annotations.readOnlyHint, false);
    assert.equal(createTool.annotations.destructiveHint, false);
    assert.equal(createTool.annotations.idempotentHint, true);

    const bootstrap = mcpPayload(await client.callTool({ name: "get_agent_bootstrap", arguments: {} }));
    const flow = mcpPayload(await client.callTool({ name: "get_request_flows", arguments: {} })).flows[0];
    const card = mcpPayload(await client.callTool({ name: "get_flow_context_card", arguments: { flowId: flow.id } }));
    const input = checkpointInput({ state: bootstrap.graph }, card.card.contextRef, { operationId: "mcp-checkpoint-v1", id: "checkpoint.mcp-v1", createdByKind: "agent" });
    const created = mcpPayload(await client.callTool({ name: "create_continuation_checkpoint", arguments: input }));
    assert.equal(created.created, true);
    const listed = mcpPayload(await client.callTool({ name: "list_continuation_checkpoints", arguments: {} }));
    assert.equal(listed.records[0].id, "checkpoint.mcp-v1");
    assert.equal(listed.records[0].freshnessStatus, "current");
    const shown = mcpPayload(await client.callTool({ name: "get_continuation_checkpoint", arguments: { checkpointId: "checkpoint.mcp-v1" } }));
    assert.equal(shown.checkpoint.contextRef, undefined);
    assert.equal(shown.checkpoint.id, "checkpoint.mcp-v1");
    const unsafe = await client.callTool({ name: "create_continuation_checkpoint", arguments: { ...input, operationId: "mcp-checkpoint-unsafe", id: "checkpoint.mcp-unsafe", rawLog: "not allowed" } });
    assert.equal(unsafe.isError, true);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI continuation list, show, and checkpoint share the persisted graph state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-cli-"));
  try {
    fixture(root, "continuation-cli");
    const graph = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, graph, { reason: "continuation-surface-test" });
    const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
    const input = checkpointInput(graph, contextRef, { operationId: "cli-checkpoint-v1", id: "checkpoint.cli-v1" });
    const inputPath = path.join(root, "checkpoint-input.json");
    fs.writeFileSync(inputPath, JSON.stringify(input), "utf8");
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const created = JSON.parse(execFileSync(process.execPath, [cli, "continue", "checkpoint", root, "--input", inputPath, "--format", "json"], { encoding: "utf8" }));
    assert.equal(created.created, true);
    const listed = JSON.parse(execFileSync(process.execPath, [cli, "continue", "list", root, "--format", "json"], { encoding: "utf8" }));
    assert.equal(listed.records[0].id, "checkpoint.cli-v1");
    assert.equal(listed.records[0].freshnessStatus, "current");
    const shown = JSON.parse(execFileSync(process.execPath, [cli, "continue", "show", root, "--checkpoint", "checkpoint.cli-v1", "--format", "json"], { encoding: "utf8" }));
    assert.equal(shown.checkpoint.id, "checkpoint.cli-v1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP, MCP, and CLI return the same continuation checkpoint projection for one repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-parity-"));
  let app;
  let instance;
  let client;
  try {
    fixture(root, "continuation-parity");
    const graph = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, graph, { reason: "continuation-parity-test" });
    const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
    createContinuationCheckpoint(root, graph, checkpointInput(graph, contextRef, { operationId: "parity-checkpoint-v1", id: "checkpoint.parity-v1" }));

    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const http = await (await fetch(`http://127.0.0.1:${app.port}/api/continuation-checkpoints`)).json();
    instance = await createMcpServer({ root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "continuation-parity-test", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const mcp = mcpPayload(await client.callTool({ name: "list_continuation_checkpoints", arguments: {} }));
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const command = JSON.parse(execFileSync(process.execPath, [cli, "continue", "list", root, "--format", "json"], { encoding: "utf8" }));
    assert.deepEqual(mcp, http);
    assert.deepEqual(command, http);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
