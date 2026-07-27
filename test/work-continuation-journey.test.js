"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { saveHandoffWorkspace } = require("../src/handoff-workspace");
const { scanRepository } = require("../src/scanner");

function write(root, file, content) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, "utf8"); }
function payload(result) { assert.equal(result.isError, undefined); return JSON.parse(result.content.find((item) => item.type === "text").text); }
async function waitForMcpGraph(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = payload(await client.callTool({ name: "get_scan_status", arguments: {} }));
    if (status.status === "complete") return status;
    assert.ok(["idle", "running"].includes(status.status), `Unexpected MCP scan status: ${status.status}`);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error("Timed out waiting for the continuation MCP graph.");
}

test("stdio MCP supports the bounded continuation handoff journey without source-write authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-journey-"));
  let client;
  let transport;
  try {
    write(root, "package.json", JSON.stringify({ name: "continuation-journey" }));
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
    const initial = scanRepository(root, { persistIdentity: true });
    const handoff = saveHandoffWorkspace(root, initial, { operationId: "journey-handoff", author: "developer", purpose: "Continue one bounded order flow." });
    const [{ Client }, { StdioClientTransport }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/stdio.js")]);
    transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, "..", "src", "cli.js"), "mcp", root], cwd: path.join(__dirname, ".."), stderr: "pipe" });
    client = new Client({ name: "continuation-journey", version: "1.0.0" });
    await client.connect(transport);
    await waitForMcpGraph(client);
    const bootstrap = payload(await client.callTool({ name: "get_agent_bootstrap", arguments: {} }));
    const flow = payload(await client.callTool({ name: "get_flow_context_card", arguments: { flowId: initial.flows[0].id } }));
    const contextRef = flow.card.contextRef;
    const work = payload(await client.callTool({ name: "create_work_record", arguments: { operationId: "journey-work", id: "task.order-audit", kind: "task", title: "Add order audit", contextRefs: [contextRef], createdBy: "developer", createdAt: "2026-07-19T00:00:00.000Z" } }));
    assert.equal(work.record.id, "task.order-audit");
    const checkpoint = payload(await client.callTool({ name: "create_continuation_checkpoint", arguments: { operationId: "journey-checkpoint", id: "checkpoint.order-audit", expectedGraphVersion: bootstrap.graph.graphVersion, handoffWorkspaceId: handoff.workspace.id, workRecordIds: ["task.order-audit"], remainingWorkRecordIds: ["task.order-audit"], selectedContextRefs: [contextRef], acceptanceCriteria: ["Refresh after source edit."], createdBy: "developer", createdByKind: "human" } }));
    const overlay = payload(await client.callTool({ name: "create_planned_overlay", arguments: { operationId: "journey-overlay", id: "overlay.order-audit", expectedGraphVersion: bootstrap.graph.graphVersion, checkpointId: checkpoint.checkpoint.id, nodes: [{ id: "planned.order-audit", kind: "service", title: "Order audit", anchors: [contextRef], acceptanceCriteria: ["Human review remains required."] }], edges: [], createdBy: "developer", createdByKind: "human" } }));
    const before = payload(await client.callTool({ name: "get_continuation_context", arguments: { checkpointId: checkpoint.checkpoint.id, overlayId: overlay.overlay.id, tokenBudget: 2048 } }));
    assert.equal(before.status, "ready");
    assert.equal(before.divergence.status, "non-git");
    assert.equal(before.work.records[0].dependencyReadiness.readyToStart, true);
    assert.equal(JSON.stringify(before).includes(root), false);
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true, audit: true }; }\n");
    const refresh = payload(await client.callTool({ name: "refresh_graph", arguments: { paths: ["src/app/api/orders/route.ts"] } }));
    assert.ok(refresh.graphState.graphVersion > bootstrap.graph.graphVersion);
    const changed = payload(await client.callTool({ name: "get_changed_contexts", arguments: { fromVersion: bootstrap.graph.graphVersion, toVersion: refresh.graphState.graphVersion } }));
    assert.equal(changed.available, true);
    const after = payload(await client.callTool({ name: "get_continuation_context", arguments: { checkpointId: checkpoint.checkpoint.id, overlayId: overlay.overlay.id, tokenBudget: 2048 } }));
    assert.equal(after.status, "requires-source-fallback");
    assert.equal(after.divergence.status, "non-git");
    const currentFlow = payload(await client.callTool({ name: "get_flow_context_card", arguments: { flowId: initial.flows[0].id } }));
    const reconciliation = payload(await client.callTool({ name: "record_plan_reconciliation", arguments: { operationId: "journey-reconciliation", id: "reconciliation.order-audit", planRef: overlay.overlay.nodes[0].planRef, actualContextRefs: [currentFlow.card.contextRef], outcome: "confirmed-implemented", actor: "developer", actorKind: "human", evidenceReferences: [] } }));
    assert.equal(reconciliation.reconciliation.outcome, "confirmed-implemented");
    const comparison = payload(await client.callTool({ name: "get_continuation_comparison", arguments: { checkpointId: checkpoint.checkpoint.id, overlayId: overlay.overlay.id } }));
    assert.equal(comparison.plans[0].status, "reconciled");
  } finally { if (client) await client.close(); else if (transport) await transport.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
