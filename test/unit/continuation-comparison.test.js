"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { compareContinuation } = require("../../src/continuation-comparison");
const { createContextRef } = require("../../src/context-card");
const { createContinuationCheckpoint } = require("../../src/continuation-checkpoint");
const { createPlannedOverlay } = require("../../src/planned-overlay");
const { recordPlanReconciliation } = require("../../src/plan-reconciliation");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function fixture(root) {
  write(root, "package.json", JSON.stringify({ name: "continuation-comparison" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
}

function plan(root, graph) {
  const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
  createContinuationCheckpoint(root, graph, {
    operationId: "comparison-checkpoint-v1",
    id: "checkpoint.comparison-v1",
    expectedGraphVersion: graph.state.graphVersion,
    selectedContextRefs: [contextRef],
    createdBy: "local developer",
    createdByKind: "human",
  });
  const ids = ["reconciled", "partial", "different", "superseded", "unresolved", "anchor-stale"];
  const overlay = createPlannedOverlay(root, graph, {
    operationId: "comparison-overlay-v1",
    id: "overlay.comparison-v1",
    expectedGraphVersion: graph.state.graphVersion,
    checkpointId: "checkpoint.comparison-v1",
    nodes: ids.map((id) => ({ id: `planned.${id}`, kind: "service", title: id, responsibility: null, acceptanceCriteria: [], anchors: [contextRef], candidatePath: null })),
    edges: [],
    createdBy: "local developer",
    createdByKind: "human",
  }).overlay;
  const planRefs = Object.fromEntries(ids.map((id) => [id, `fpp://local/${encodeURIComponent(graph.project.projectId)}/checkpoint.comparison-v1/planned.${id}@${overlay.overlayVersion}`]));
  return { overlayId: overlay.id, planRefs };
}

function input(graph, planRef, id, outcome, overrides = {}) {
  return {
    operationId: `comparison-${id}-operation`,
    id: `comparison.${id}`,
    planRef,
    actualContextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion)],
    outcome,
    actor: "local developer",
    actorKind: "human",
    evidenceReferences: [],
    ...overrides,
  };
}

test("continuation comparison keeps baseline, plan, reconciliation, and unavailable evidence explicit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-comparison-"));
  try {
    fixture(root);
    const baselineGraph = scanRepository(root, { persistIdentity: true });
    const { overlayId, planRefs } = plan(root, baselineGraph);
    const initial = compareContinuation(root, baselineGraph, { checkpointId: "checkpoint.comparison-v1", overlayId });
    assert.equal(initial.status, "available");
    assert.equal(initial.plans.every((item) => item.status === "planned-only"), true);

    const currentGraph = structuredClone(baselineGraph);
    currentGraph.state.graphVersion += 1;
    currentGraph.state.sourceFingerprint = "sha256:changed-source";
    recordPlanReconciliation(root, currentGraph, input(currentGraph, planRefs.reconciled, "reconciled", "confirmed-implemented"));
    recordPlanReconciliation(root, currentGraph, input(currentGraph, planRefs.partial, "partial", "partially-implemented"));
    recordPlanReconciliation(root, currentGraph, input(currentGraph, planRefs.different, "different", "implemented-differently"));
    recordPlanReconciliation(root, currentGraph, input(currentGraph, planRefs.superseded, "superseded", "superseded", { actualContextRefs: [] }));
    recordPlanReconciliation(root, currentGraph, input(currentGraph, planRefs.unresolved, "unresolved", "unresolved", { actualContextRefs: [], actor: "agent session", actorKind: "agent" }));
    const comparison = compareContinuation(root, currentGraph, { checkpointId: "checkpoint.comparison-v1", overlayId });
    const statuses = Object.fromEntries(comparison.plans.map((item) => [item.plannedNode.id, item.status]));
    assert.deepEqual(statuses, {
      "planned.reconciled": "reconciled",
      "planned.partial": "partial",
      "planned.different": "implemented-differently",
      "planned.superseded": "superseded",
      "planned.unresolved": "unresolved",
      "planned.anchor-stale": "anchor-stale",
    });
    assert.equal(comparison.baseline.freshnessStatus, "stale");
    assert.match(comparison.limitation, /Missing or unavailable retained evidence is unknown or unavailable/u);

    const reconciliationStore = path.join(root, ".flopeek", "delivery", "reconciliations.json");
    fs.writeFileSync(reconciliationStore, "{ invalid", "utf8");
    const reconciliationUnavailable = compareContinuation(root, currentGraph, { checkpointId: "checkpoint.comparison-v1", overlayId });
    assert.equal(reconciliationUnavailable.status, "available");
    assert.equal(reconciliationUnavailable.summary.reconciliationAvailability, "unavailable");
    assert.equal(reconciliationUnavailable.plans.every((item) => item.status === "unresolved"), true);

    const overlayStore = path.join(root, ".flopeek", "delivery", "planned-overlays.json");
    fs.writeFileSync(overlayStore, "{ invalid", "utf8");
    const unavailable = compareContinuation(root, currentGraph, { checkpointId: "checkpoint.comparison-v1", overlayId });
    assert.equal(unavailable.status, "unavailable");
    assert.match(unavailable.limitation, /does not infer missing implementation/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
