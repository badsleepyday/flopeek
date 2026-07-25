"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef, parseContextRef } = require("../../src/context-card");
const { createContinuationCheckpoint } = require("../../src/continuation-checkpoint");
const {
  PLANNED_OVERLAY_STORE_RELATIVE_PATH,
  PlannedOverlayError,
  createPlanRef,
  createPlannedOverlay,
  getPlannedOverlay,
  listPlannedOverlays,
  parsePlanRef,
  readPlannedOverlayStore,
} = require("../../src/planned-overlay");
const { createRepositoryScanner } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function graphFixture(root) {
  write(root, "package.json", JSON.stringify({ name: "planned-overlay-fixture" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
  return createRepositoryScanner(root).scan();
}

function checkpoint(root, graph) {
  const contextRef = createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
  const result = createContinuationCheckpoint(root, graph, {
    operationId: "overlay-checkpoint-v1",
    id: "checkpoint.overlay-v1",
    expectedGraphVersion: graph.state.graphVersion,
    selectedContextRefs: [contextRef],
    createdBy: "delivery team",
    createdByKind: "human",
  }, { now: "2026-07-18T12:00:00.000Z" });
  return { id: result.checkpoint.id, contextRef };
}

function overlayInput(graph, checkpointId, contextRef, overrides = {}) {
  return {
    operationId: "overlay-reviewer-v1",
    id: "overlay.reviewer-v1",
    expectedGraphVersion: graph.state.graphVersion,
    checkpointId,
    nodes: [
      {
        id: "planned.reviewer-session",
        kind: "service",
        title: "Reviewer session",
        responsibility: "Manage temporary reviewer access.",
        acceptanceCriteria: ["Access can be revoked."],
        anchors: [contextRef],
        candidatePath: "src/reviewer/reviewer-session.ts",
      },
      {
        id: "planned.reviewer-view",
        kind: "module",
        title: "Reviewer view",
        anchors: [contextRef],
      },
    ],
    edges: [
      {
        relationship: "planned_after",
        source: { kind: "context-ref", contextRef },
        target: { kind: "planned-node", plannedNodeId: "planned.reviewer-session" },
      },
      {
        relationship: "planned_to_use",
        source: { kind: "planned-node", plannedNodeId: "planned.reviewer-view" },
        target: { kind: "planned-node", plannedNodeId: "planned.reviewer-session" },
      },
    ],
    createdBy: "delivery team",
    createdByKind: "human",
    ...overrides,
  };
}

test("planned overlays are immutable delivery-plan metadata with separate Plan Refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-planned-overlay-"));
  try {
    const graph = graphFixture(root);
    const handoff = checkpoint(root, graph);
    const input = overlayInput(graph, handoff.id, handoff.contextRef);
    const created = createPlannedOverlay(root, graph, input, { now: "2026-07-18T12:01:00.000Z" });
    assert.equal(created.created, true);
    assert.equal(created.overlay.overlayVersion, 1);
    assert.equal(created.overlay.evidenceClass, "delivery-plan");
    assert.equal(created.overlay.nodes[0].candidatePath, "src/reviewer/reviewer-session.ts");
    assert.equal(createPlannedOverlay(root, graph, input).created, false);
    assert.equal(graph.nodes.some((node) => node.id === "planned.reviewer-session"), false);
    assert.equal(graph.edges.some((edge) => edge.relationship === "planned_after"), false);
    const rescanned = createRepositoryScanner(root).scan();
    assert.equal(rescanned.nodes.some((node) => node.id === "planned.reviewer-session"), false);
    assert.equal(rescanned.edges.some((edge) => edge.relationship === "planned_after"), false);

    const planRef = createPlanRef(graph.project.projectId, handoff.id, "planned.reviewer-session", 1);
    assert.deepEqual(parsePlanRef(planRef), {
      schemaVersion: "flopeek-plan-ref/v1",
      planRef,
      projectId: graph.project.projectId,
      checkpointId: handoff.id,
      plannedNodeId: "planned.reviewer-session",
      overlayVersion: 1,
    });
    assert.throws(() => parseContextRef(planRef));
    assert.throws(() => parsePlanRef(handoff.contextRef), (error) => error instanceof PlannedOverlayError && error.code === "invalid-plan-ref");

    const second = createPlannedOverlay(root, graph, overlayInput(graph, handoff.id, handoff.contextRef, {
      operationId: "overlay-reviewer-v2",
      id: "overlay.reviewer-v2",
      nodes: [{ id: "planned.reviewer-audit", kind: "other", title: "Reviewer audit", anchors: [handoff.contextRef] }],
      edges: [],
    }), { now: "2026-07-18T12:02:00.000Z" });
    assert.equal(second.overlay.overlayVersion, 2);
    const listed = listPlannedOverlays(root, graph);
    assert.equal(listed.records.length, 2);
    assert.equal(listed.records.find((record) => record.id === created.overlay.id).checkpointFreshnessStatus, "current");
    assert.equal(getPlannedOverlay(root, graph, created.overlay.id).overlay.id, created.overlay.id);
    const stored = fs.readFileSync(path.join(root, PLANNED_OVERLAY_STORE_RELATIVE_PATH), "utf8");
    assert.equal(stored.includes("export async function"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planned overlays reject factual edges, unselected anchors, unsafe paths, stale graphs, and invalid stores", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-planned-overlay-invalid-"));
  try {
    const graph = graphFixture(root);
    const handoff = checkpoint(root, graph);
    const input = overlayInput(graph, handoff.id, handoff.contextRef);
    const otherRef = createContextRef(graph.project.projectId, "node", graph.nodes[0].id, graph.state.graphVersion);
    assert.throws(() => createPlannedOverlay(root, graph, overlayInput(graph, handoff.id, handoff.contextRef, { expectedGraphVersion: graph.state.graphVersion + 1 })), (error) => error instanceof PlannedOverlayError && error.code === "stale-graph-version");
    assert.throws(() => createPlannedOverlay(root, graph, overlayInput(graph, handoff.id, handoff.contextRef, { edges: [{ relationship: "calls", source: { kind: "context-ref", contextRef: handoff.contextRef }, target: { kind: "planned-node", plannedNodeId: "planned.reviewer-session" } }] })), (error) => error instanceof PlannedOverlayError && error.code === "invalid-planned-relationship");
    assert.throws(() => createPlannedOverlay(root, graph, overlayInput(graph, handoff.id, handoff.contextRef, { nodes: [{ id: "planned.unselected", kind: "service", title: "Unselected anchor", anchors: [otherRef] }], edges: [] })), (error) => error instanceof PlannedOverlayError && error.code === "unselected-checkpoint-context");
    assert.throws(() => createPlannedOverlay(root, graph, overlayInput(graph, handoff.id, handoff.contextRef, { nodes: [{ id: "planned.absolute", kind: "service", title: "Absolute path", anchors: [handoff.contextRef], candidatePath: "C:\\workspace\\secret.ts" }], edges: [] })), (error) => error instanceof PlannedOverlayError && ["invalid-candidate-path", "unsafe-machine-path"].includes(error.code));
    assert.throws(() => createPlannedOverlay(root, graph, overlayInput(graph, handoff.id, handoff.contextRef, { nodes: [{ id: "planned.source", kind: "service", title: "Unsafe source", responsibility: "const source = 'not allowed';", anchors: [handoff.contextRef] }], edges: [] })), (error) => error instanceof PlannedOverlayError && error.code === "unsafe-source-body-like-text");

    const created = createPlannedOverlay(root, graph, input, { now: "2026-07-18T12:03:00.000Z" });
    const target = path.join(root, PLANNED_OVERLAY_STORE_RELATIVE_PATH);
    const injected = JSON.parse(fs.readFileSync(target, "utf8"));
    injected.records[0].nodes[0].anchors = [otherRef];
    fs.writeFileSync(target, JSON.stringify(injected), "utf8");
    const before = fs.readFileSync(target, "utf8");
    assert.equal(readPlannedOverlayStore(root, graph.project.projectId).status, "invalid");
    assert.equal(listPlannedOverlays(root, graph).status, "unavailable");
    assert.throws(() => createPlannedOverlay(root, graph, overlayInput(graph, handoff.id, handoff.contextRef, { operationId: "overlay-must-not-overwrite", id: "overlay.must-not-overwrite" })), (error) => error instanceof PlannedOverlayError && error.code === "invalid-planned-overlay-store");
    assert.equal(fs.readFileSync(target, "utf8"), before);
    assert.equal(created.overlay.id, "overlay.reviewer-v1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
