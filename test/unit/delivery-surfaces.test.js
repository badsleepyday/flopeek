"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { startServer } = require("../../src/server");
const { createMcpServer } = require("../../src/mcp");
const { createContextRef } = require("../../src/context-card");
const { scanRepository, writeGraphCache } = require("../../src/scanner");
const { createWorkRecord } = require("../../src/graph-service");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("local HTTP delivery surfaces share project identity and enforce workflow evidence gates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-delivery-surfaces-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "delivery-surfaces" }));
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const workflows = await (await fetch(`${baseUrl}/api/workflows`)).json();
    assert.equal(workflows.workflows[0].id, "agile-default");
    const flow = (await (await fetch(`${baseUrl}/api/flows`)).json())[0];
    const context = (await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(flow.id)}`)).json()).card.contextRef;
    const created = await post(baseUrl, "/api/work-records", {
      operationId: "surface-create-record",
      id: "task.surface-workflow",
      kind: "task",
      title: "Exercise local delivery surfaces",
      contextRefs: [context],
      createdBy: "local developer",
      createdAt: "2026-07-18T10:00:00.000Z",
    });
    assert.equal(created.status, 201);
    const assigned = await post(baseUrl, "/api/workflow-assignments", {
      operationId: "surface-assign-agile",
      recordId: "task.surface-workflow",
      workflowId: "agile-default",
      actor: "local developer",
      observedAt: "2026-07-18T10:01:00.000Z",
    });
    assert.equal(assigned.status, 201);
    const firstTransition = await post(baseUrl, "/api/workflow-transitions", {
      operationId: "surface-backlog-planned",
      recordId: "task.surface-workflow",
      workflowId: "agile-default",
      expectedState: "backlog",
      targetState: "planned",
      actor: "local developer",
      actorRole: "developer",
      observedAt: "2026-07-18T10:02:00.000Z",
    });
    assert.equal(firstTransition.status, 201);
    const dependencyStatus = await (await fetch(`${baseUrl}/api/work-dependency-status?recordId=task.surface-workflow`)).json();
    assert.equal(dependencyStatus.summary.readyToStart, true);
    assert.match(dependencyStatus.limitation, /does not prove source implementation/);
    const dependencyStatuses = await (await fetch(`${baseUrl}/api/work-dependency-statuses?limit=10`)).json();
    assert.equal(dependencyStatuses.statuses[0].record.id, "task.surface-workflow");
    const workflow = await (await fetch(`${baseUrl}/api/work-record-workflow?recordId=task.surface-workflow`)).json();
    assert.equal(workflow.state.state, "planned");
    const timeline = await (await fetch(`${baseUrl}/api/work-timeline?recordId=task.surface-workflow`)).json();
    assert.equal(timeline.actualEvents.length, 3);
    assert.match(timeline.limitation, /append-only/);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP exposes the same local delivery workflow inventory without source bodies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-delivery-mcp-"));
  let instance;
  let client;
  try {
    write(root, "package.json", JSON.stringify({ name: "delivery-mcp" }));
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
    instance = await createMcpServer({ root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "delivery-surface-test", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "list_workflows", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.workflows[0].id, "agile-default");
    assert.equal(payload.workflows[1].id, "waterfall-default");
    assert.equal(JSON.stringify(payload).includes("export async function"), false);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_work_dependency_status"));
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI workflow inventory does not scan a repository or create Flopeek metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-workflow-cli-"));
  try {
    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "..", "src", "cli.js"), "work", "workflows", root, "--format", "json"], { encoding: "utf8" });
    assert.equal(JSON.parse(output).workflows[0].id, "agile-default");
    assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI reports one bounded dependency-readiness projection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-work-dependencies-cli-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "dependency-cli" }));
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
    const graph = scanRepository(root, { persistIdentity: true });
    createWorkRecord(graph, {
      operationId: "dependency-cli-record",
      id: "task.dependency-cli",
      kind: "task",
      title: "Inspect dependency readiness",
      createdBy: "developer",
      createdAt: "2026-07-18T10:00:00.000Z",
    });
    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "..", "src", "cli.js"), "work", "dependencies", root, "--record", "task.dependency-cli", "--format", "json"], { encoding: "utf8" });
    const result = JSON.parse(output);
    assert.equal(result.schemaVersion, "flopeek-work-dependency-status/v1");
    assert.equal(result.summary.readyToStart, true);
    assert.match(result.limitation, /does not prove source implementation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI work timeline reuses a current persistent graph for same-version Context Refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-work-timeline-cache-cli-"));
  try {
    write(root, ".gitignore", ".flopeek/\n");
    write(root, "package.json", JSON.stringify({ name: "timeline-cache-cli" }));
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
    execFileSync("git", ["config", "user.email", "flopeek@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Flopeek Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

    const graph = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, graph);
    const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
    createWorkRecord(graph, {
      operationId: "timeline-cache-cli-record",
      id: "task.timeline-cache-cli",
      kind: "task",
      title: "Read the current delivery timeline",
      contextRefs: [contextRef],
      createdBy: "developer",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    const cachePath = path.join(root, ".flopeek", "graph.json");
    const before = fs.readFileSync(cachePath, "utf8");

    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "..", "src", "cli.js"), "work", "timeline", root, "--record", "task.timeline-cache-cli", "--format", "json"], { encoding: "utf8" });
    const timeline = JSON.parse(output);

    assert.equal(timeline.project.graphVersion, graph.state.graphVersion);
    assert.equal(timeline.records[0].contextRefs[0].status, "current");
    assert.equal(timeline.records[0].staleContextCount, 0);
    assert.equal(fs.readFileSync(cachePath, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
