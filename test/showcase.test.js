"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_SHOWCASE_ROOT,
  SHOWCASE_STATE_FILE,
  ShowcaseError,
  applyShowcaseChange,
  cleanupShowcase,
  prepareShowcase,
  resetShowcase,
  showcaseStatus,
  startShowcase,
} = require("../src/showcase");

const PRIMARY_FLOW_ID = "flow:endpoint:src/app/api/checkout/route.ts:POST:/api/checkout";
const RISK_STEP_ID = "symbol:src/checkout/risk.ts:function:reviewRisk";

async function waitForGraphVersion(baseUrl, minimumVersion) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/view?mode=overview&scope=application`);
    const view = await response.json();
    if (view.aiContext?.graphState?.graphVersion >= minimumVersion) return view;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for showcase graph version ${minimumVersion}.`);
}

function mcpPayload(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function waitForMcpGraph(client, timeoutMs = 30_000) {
  for (let attempt = 0; attempt < timeoutMs / 35; attempt += 1) {
    const status = mcpPayload(await client.callTool({ name: "get_scan_status", arguments: {} }));
    if (status.status === "complete") return status;
    assert.ok(["idle", "running"].includes(status.status), `Unexpected MCP scan status: ${status.status}`);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error("Timed out waiting for the showcase MCP graph.");
}

test("showcase preparation, apply, reset, and cleanup are confined to a marked temporary copy", () => {
  const baselineSource = path.join(DEFAULT_SHOWCASE_ROOT, "src", "checkout", "payment.ts");
  const original = fs.readFileSync(baselineSource, "utf8");
  const prepared = prepareShowcase();
  try {
    assert.notEqual(prepared.workspaceRoot, DEFAULT_SHOWCASE_ROOT);
    assert.equal(fs.existsSync(path.join(prepared.workspaceRoot, SHOWCASE_STATE_FILE)), true);
    assert.equal(fs.existsSync(path.join(DEFAULT_SHOWCASE_ROOT, ".flopeek")), false);
    assert.equal(showcaseStatus(prepared.workspaceRoot).status, "baseline");
    const cliStatus = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "..", "src", "cli.js"), "showcase", "status", prepared.workspaceRoot, "--format", "json"], { encoding: "utf8" }));
    assert.equal(cliStatus.status, "baseline");
    assert.equal(cliStatus.showcaseId, "commerce-checkout");

    const applied = applyShowcaseChange(prepared.workspaceRoot);
    assert.equal(applied.status, "changed");
    assert.equal(applied.changed, true);
    assert.equal(applyShowcaseChange(prepared.workspaceRoot).changed, false);

    const reset = resetShowcase(prepared.workspaceRoot);
    assert.equal(reset.status, "baseline");
    assert.equal(reset.changed, true);
    assert.equal(resetShowcase(prepared.workspaceRoot).changed, false);

    fs.appendFileSync(path.join(prepared.workspaceRoot, "src", "checkout", "payment.ts"), "\n// local divergence\n");
    assert.equal(showcaseStatus(prepared.workspaceRoot).status, "diverged");
    assert.throws(() => applyShowcaseChange(prepared.workspaceRoot), (error) => error instanceof ShowcaseError && error.code === "showcase-source-diverged");
    assert.throws(() => resetShowcase(prepared.workspaceRoot), (error) => error instanceof ShowcaseError && error.code === "showcase-source-diverged");
    assert.equal(fs.readFileSync(baselineSource, "utf8"), original);
  } finally {
    cleanupShowcase(prepared.workspaceRoot);
  }
  assert.equal(fs.existsSync(prepared.workspaceRoot), false);
  assert.equal(fs.readFileSync(baselineSource, "utf8"), original);
});

test("showcase demonstrates one shared Viewer, HTTP, and MCP context before and after a live static change", async () => {
  const original = fs.readFileSync(path.join(DEFAULT_SHOWCASE_ROOT, "src", "checkout", "payment.ts"), "utf8");
  const instance = await startShowcase({ port: 0 });
  const baseUrl = `http://127.0.0.1:${instance.port}`;
  let client;
  let transport;
  try {
    assert.equal(instance.targetApplicationExecuted, false);
    assert.equal(instance.demonstrationOnly, true);
    assert.match(instance.url, /showcase=commerce-checkout/);
    assert.match(instance.url, /flow=flow%3Aendpoint/);

    const page = await (await fetch(instance.url)).text();
    assert.match(page, /Flopeek showcase walkthrough/);
    assert.match(page, /The target application is not executed/);

    const view = await waitForGraphVersion(baseUrl, 1);
    const graphVersion = view.aiContext.graphState.graphVersion;
    const projectId = view.project.projectId;
    assert.equal(view.flows.some((flow) => flow.id === PRIMARY_FLOW_ID), true);
    assert.equal(view.aiContext.evidencePolicy.codeInterpretation, "AST-only for registered language adapters");

    const lens = await (await fetch(`${baseUrl}/api/flow-lens?flow=${encodeURIComponent(PRIMARY_FLOW_ID)}`)).json();
    assert.equal(lens.project.projectId, projectId);
    assert.equal(lens.project.graphVersion, graphVersion);
    assert.equal(lens.steps.some((step) => step.node.id === RISK_STEP_ID), false);
    assert.equal(lens.steps.some((step) => step.node.id === "runtime:src/orders/repository.ts:database:prisma"), true);
    assert.match(lens.limitations.join(" "), /not a runtime trace/);

    const flowPacket = await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(PRIMARY_FLOW_ID)}`)).json();
    assert.equal(flowPacket.card.flow.id, PRIMARY_FLOW_ID);
    assert.equal(flowPacket.card.project.graphVersion, graphVersion);
    assert.match(flowPacket.card.contextRef, /^fp:\/\/local\//);
    assert.ok(flowPacket.card.relatedTests.some((item) => item.test.path === "test/checkout.test.ts"));

    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "src", "cli.js"), "mcp", instance.workspaceRoot],
      cwd: path.join(__dirname, ".."),
      stderr: "pipe",
    });
    client = new Client({ name: "flopeek-showcase-test", version: "1.0.0" });
    await client.connect(transport);
    await waitForMcpGraph(client);
    const bootstrap = mcpPayload(await client.callTool({ name: "get_agent_bootstrap", arguments: {} }));
    const mcpLens = mcpPayload(await client.callTool({ name: "get_flow_projection", arguments: { flowId: PRIMARY_FLOW_ID } }));
    const mcpPacket = mcpPayload(await client.callTool({ name: "get_flow_context_card", arguments: { flowId: PRIMARY_FLOW_ID } }));
    assert.equal(bootstrap.project.projectId, projectId);
    assert.equal(bootstrap.graph.graphVersion, graphVersion);
    assert.equal(mcpLens.project.graphVersion, graphVersion);
    assert.deepEqual(mcpLens.steps.map((step) => step.node.id), lens.steps.map((step) => step.node.id));
    assert.equal(mcpPacket.card.contextRef, flowPacket.card.contextRef);
    await client.close();
    client = null;
    transport = null;

    const applied = applyShowcaseChange(instance.workspaceRoot);
    assert.equal(applied.status, "changed");
    const refreshedView = await waitForGraphVersion(baseUrl, graphVersion + 1);
    assert.equal(refreshedView.project.projectId, projectId);

    const changedContexts = await (await fetch(`${baseUrl}/api/changed-contexts`)).json();
    assert.equal(changedContexts.available, true);
    assert.deepEqual(changedContexts.delta.changedPaths, ["src/checkout/payment.ts"]);
    const changedFlow = changedContexts.flows.find((flow) => flow.id === PRIMARY_FLOW_ID);
    assert.equal(changedFlow.flowComparisonAvailable, true);
    assert.ok(changedFlow.changedStepIds.includes("symbol:src/checkout/payment.ts:function:authorizePayment"));

    const comparison = await (await fetch(`${baseUrl}/api/flow-comparison?flow=${encodeURIComponent(PRIMARY_FLOW_ID)}`)).json();
    assert.equal(comparison.available, true);
    assert.equal(comparison.comparison.status, "changed");
    assert.ok(comparison.comparison.changes.addedStepIds.includes(RISK_STEP_ID));
    assert.equal(comparison.comparison.before.project.graphVersion, graphVersion);
    assert.equal(comparison.comparison.current.project.graphVersion, refreshedView.aiContext.graphState.graphVersion);
    assert.match(comparison.limitation, /do not prove runtime order/);

    const resolution = await (await fetch(`${baseUrl}/api/context/resolve?ref=${encodeURIComponent(flowPacket.card.contextRef)}`)).json();
    assert.equal(resolution.status, "stale");
    const impact = await (await fetch(`${baseUrl}/api/impact?path=${encodeURIComponent("src/checkout/payment.ts")}`)).json();
    assert.ok(impact.recommendedTests.some((item) => item.path === "test/checkout.test.ts"));

    resetShowcase(instance.workspaceRoot);
    await waitForGraphVersion(baseUrl, refreshedView.aiContext.graphState.graphVersion + 1);
  } finally {
    if (client) await client.close();
    else if (transport) await transport.close();
    await instance.close();
  }
  assert.equal(fs.existsSync(instance.workspaceRoot), false);
  assert.equal(fs.readFileSync(path.join(DEFAULT_SHOWCASE_ROOT, "src", "checkout", "payment.ts"), "utf8"), original);
});
