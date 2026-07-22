"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { createContinuationCheckpoint } = require("../../src/continuation-checkpoint");
const { createPlannedOverlay } = require("../../src/planned-overlay");
const { listPlanReconciliations, readPlanReconciliationStore, recordPlanReconciliation } = require("../../src/plan-reconciliation");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function fixture(root) {
  write(root, "package.json", JSON.stringify({ name: "plan-reconciliation" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
}

function setupPlan(root, graph) {
  const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
  createContinuationCheckpoint(root, graph, {
    operationId: "reconciliation-checkpoint-v1",
    id: "checkpoint.reconciliation-v1",
    expectedGraphVersion: graph.state.graphVersion,
    selectedContextRefs: [contextRef],
    createdBy: "local developer",
    createdByKind: "human",
  }, { now: "2026-07-18T00:00:00.000Z" });
  const overlay = createPlannedOverlay(root, graph, {
    operationId: "reconciliation-overlay-v1",
    id: "overlay.reconciliation-v1",
    expectedGraphVersion: graph.state.graphVersion,
    checkpointId: "checkpoint.reconciliation-v1",
    nodes: [{
      id: "planned.order-audit",
      kind: "service",
      title: "Order audit projection",
      responsibility: "Record a manually reconciled planned boundary.",
      acceptanceCriteria: ["A human must explicitly reconcile the planned boundary."],
      anchors: [contextRef],
      candidatePath: "src/orders/order-audit.ts",
    }],
    edges: [{ relationship: "planned_after", source: { kind: "context-ref", contextRef }, target: { kind: "planned-node", plannedNodeId: "planned.order-audit" } }],
    createdBy: "local developer",
    createdByKind: "human",
  }, { now: "2026-07-18T00:01:00.000Z" }).overlay;
  return { contextRef, planRef: `fpp://local/${encodeURIComponent(graph.project.projectId)}/checkpoint.reconciliation-v1/planned.order-audit@${overlay.overlayVersion}` };
}

function input(graph, planRef, overrides = {}) {
  return {
    operationId: "reconciliation-record-v1",
    id: "reconciliation.order-audit-v1",
    planRef,
    actualContextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion)],
    outcome: "confirmed-implemented",
    actor: "local developer",
    actorKind: "human",
    evidenceReferences: [{ kind: "manual-review", reference: "review:order-audit", evidenceClass: "human-observation" }],
    ...overrides,
  };
}

test("plan reconciliations are append-only and preserve planned metadata as distinct from parser facts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-plan-reconciliation-"));
  try {
    fixture(root);
    const graph = scanRepository(root, { persistIdentity: true });
    const { contextRef, planRef } = setupPlan(root, graph);
    const beforeOverlay = fs.readFileSync(path.join(root, ".flowpeek", "delivery", "planned-overlays.json"), "utf8");
    const created = recordPlanReconciliation(root, graph, input(graph, planRef), { now: "2026-07-18T00:02:00.000Z" });
    assert.equal(created.created, true);
    assert.equal(created.reconciliation.outcome, "confirmed-implemented");
    assert.equal(created.reconciliation.knowledgeClass, "human-assertion");
    assert.deepEqual(created.reconciliation.actualContextRefs, [contextRef]);
    assert.equal(fs.readFileSync(path.join(root, ".flowpeek", "delivery", "planned-overlays.json"), "utf8"), beforeOverlay);
    const superseding = recordPlanReconciliation(root, graph, input(graph, planRef, {
      operationId: "reconciliation-record-v2",
      id: "reconciliation.order-audit-v2",
      outcome: "implemented-differently",
      supersedes: "reconciliation.order-audit-v1",
    }), { now: "2026-07-18T00:03:00.000Z" });
    assert.equal(superseding.reconciliation.supersedes, "reconciliation.order-audit-v1");
    const listed = listPlanReconciliations(root, graph, { planRef });
    assert.equal(listed.records.length, 2);
    assert.equal(listed.records[0].planResolution.status, "current");
    assert.deepEqual(listed.records[0].actualContextStatuses.map((item) => item.status), ["current"]);
    assert.match(listed.limitation, /remains an assertion/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("positive reconciliation requires a human and current actual Context Refs while nonpositive agent proposals remain explicit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-plan-reconciliation-policy-"));
  try {
    fixture(root);
    const graph = scanRepository(root, { persistIdentity: true });
    const { planRef } = setupPlan(root, graph);
    assert.throws(() => recordPlanReconciliation(root, graph, input(graph, planRef, { actorKind: "agent" })), { code: "positive-outcome-requires-human" });
    assert.throws(() => recordPlanReconciliation(root, graph, input(graph, planRef, {
      operationId: "reconciliation-future-v1",
      id: "reconciliation.future-v1",
      actualContextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion + 1)],
    })), { code: "actual-context-not-current" });
    const proposal = recordPlanReconciliation(root, graph, input(graph, planRef, {
      operationId: "reconciliation-agent-unresolved-v1",
      id: "reconciliation.agent-unresolved-v1",
      actualContextRefs: [],
      outcome: "unresolved",
      actor: "agent session",
      actorKind: "agent",
    }), { now: "2026-07-18T00:04:00.000Z" });
    assert.equal(proposal.reconciliation.knowledgeClass, "agent-proposal");
    assert.equal(proposal.reconciliation.outcome, "unresolved");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid plan-reconciliation storage remains unavailable and is never overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-plan-reconciliation-invalid-"));
  try {
    fixture(root);
    const graph = scanRepository(root, { persistIdentity: true });
    const target = path.join(root, ".flowpeek", "delivery", "reconciliations.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ invalid", "utf8");
    const before = fs.readFileSync(target, "utf8");
    const read = readPlanReconciliationStore(root, graph.project.projectId);
    assert.equal(read.status, "invalid");
    assert.throws(() => recordPlanReconciliation(root, graph, {}), { code: "invalid-plan-reconciliation-store" });
    assert.equal(fs.readFileSync(target, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
