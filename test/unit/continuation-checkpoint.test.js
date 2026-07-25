"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { createWorkRecord } = require("../../src/delivery-graph");
const { saveHandoffWorkspace } = require("../../src/handoff-workspace");
const {
  CONTINUATION_CHECKPOINT_STORE_RELATIVE_PATH,
  ContinuationCheckpointError,
  createContinuationCheckpoint,
  getContinuationCheckpoint,
  listContinuationCheckpoints,
  readContinuationCheckpointStore,
  sourceBaseline,
} = require("../../src/continuation-checkpoint");
const { createRepositoryScanner } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function graphFixture(root) {
  write(root, "package.json", JSON.stringify({ name: "continuation-checkpoint-fixture" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
  return createRepositoryScanner(root).scan();
}

function currentFlowRef(graph) {
  return createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion);
}

function workRecordInput(graph) {
  return {
    operationId: "work-order-orientation",
    id: "task.order-orientation",
    kind: "task",
    title: "Orient the order flow",
    contextRefs: [currentFlowRef(graph)],
    createdBy: "Delivery team",
    createdAt: "2026-07-18T08:00:00.000Z",
  };
}

function checkpointInput(graph, overrides = {}) {
  return {
    operationId: "checkpoint-order-v1",
    id: "checkpoint.order-v1",
    expectedGraphVersion: graph.state.graphVersion,
    workRecordIds: ["task.order-orientation"],
    completedWorkRecordIds: [],
    remainingWorkRecordIds: ["task.order-orientation"],
    selectedContextRefs: [currentFlowRef(graph)],
    constraints: ["Preserve the existing request boundary."],
    acceptanceCriteria: ["The selected Flow Context Ref remains inspectable."],
    unresolvedQuestions: ["Which owner confirms the later plan?"],
    createdBy: "Delivery team",
    createdByKind: "human",
    ...overrides,
  };
}

test("continuation checkpoints compose immutable current graph, handoff, work, and context metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-"));
  try {
    const graph = graphFixture(root);
    createWorkRecord(root, graph, workRecordInput(graph));
    const handoff = saveHandoffWorkspace(root, graph, {
      operationId: "handoff-order-v1",
      author: "Delivery team",
      purpose: "Continue order-flow work from the selected static context.",
      criticalFlowIds: [graph.flows[0].id],
    }, { now: "2026-07-18T08:05:00.000Z" });

    const input = checkpointInput(graph, { handoffWorkspaceId: handoff.workspace.id });
    const first = createContinuationCheckpoint(root, graph, input, { now: "2026-07-18T08:10:00.000Z" });
    assert.equal(first.created, true);
    assert.equal(first.checkpoint.evidenceClass, "delivery-plan");
    assert.equal(first.checkpoint.baseline.graphVersion, graph.state.graphVersion);
    assert.equal(first.checkpoint.baseline.sourceFingerprint, graph.state.sourceFingerprint);
    assert.equal(first.checkpoint.handoffWorkspaceId, handoff.workspace.id);
    assert.equal(first.checkpoint.selectedContextRefs[0].contextRef, currentFlowRef(graph));
    assert.equal(first.checkpoint.policy.sourceBodies, "excluded");
    assert.equal(createContinuationCheckpoint(root, graph, input, { now: "2026-07-18T08:11:00.000Z" }).created, false);

    const second = createContinuationCheckpoint(root, graph, checkpointInput(graph, {
      operationId: "checkpoint-order-v2",
      id: "checkpoint.order-v2",
      handoffWorkspaceId: handoff.workspace.id,
      supersedes: first.checkpoint.id,
      completedWorkRecordIds: ["task.order-orientation"],
      remainingWorkRecordIds: [],
    }), { now: "2026-07-18T08:20:00.000Z" });
    assert.equal(second.checkpoint.supersedes, first.checkpoint.id);

    const listed = listContinuationCheckpoints(root, graph);
    assert.equal(listed.status, "available");
    assert.equal(listed.records.find((record) => record.id === first.checkpoint.id).lifecycleStatus, "superseded");
    assert.equal(listed.records.find((record) => record.id === second.checkpoint.id).freshnessStatus, "current");
    assert.equal(getContinuationCheckpoint(root, graph, second.checkpoint.id).checkpoint.id, second.checkpoint.id);
    const laterGraph = { ...graph, state: { ...graph.state, graphVersion: graph.state.graphVersion + 1 } };
    assert.equal(listContinuationCheckpoints(root, laterGraph).records.find((record) => record.id === second.checkpoint.id).freshnessStatus, "stale");
    assert.equal(graph.nodes.some((node) => node.id === first.checkpoint.id), false);
    const stored = fs.readFileSync(path.join(root, CONTINUATION_CHECKPOINT_STORE_RELATIVE_PATH), "utf8");
    assert.equal(stored.includes("export async function"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("continuation checkpoints reject stale, unsafe, unknown, overlapping, and invalid persisted inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-invalid-"));
  try {
    const graph = graphFixture(root);
    createWorkRecord(root, graph, workRecordInput(graph));
    assert.throws(() => createContinuationCheckpoint(root, graph, checkpointInput(graph, { expectedGraphVersion: graph.state.graphVersion + 1 })), (error) => error instanceof ContinuationCheckpointError && error.code === "stale-graph-version");
    assert.throws(() => createContinuationCheckpoint(root, graph, checkpointInput(graph, { selectedContextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion + 1)] })), (error) => error instanceof ContinuationCheckpointError && error.code === "stale-context-ref");
    assert.throws(() => createContinuationCheckpoint(root, graph, checkpointInput(graph, { workRecordIds: ["task.unknown"], completedWorkRecordIds: [], remainingWorkRecordIds: [] })), (error) => error instanceof ContinuationCheckpointError && error.code === "unknown-work-record");
    assert.throws(() => createContinuationCheckpoint(root, graph, checkpointInput(graph, { completedWorkRecordIds: ["task.order-orientation"], remainingWorkRecordIds: ["task.order-orientation"] })), (error) => error instanceof ContinuationCheckpointError && error.code === "overlapping-work-record-state");
    assert.throws(() => createContinuationCheckpoint(root, graph, checkpointInput(graph, { handoffWorkspaceId: "handoff-workspace:missing" })), (error) => error instanceof ContinuationCheckpointError && error.code === "unknown-handoff-workspace");
    assert.throws(() => createContinuationCheckpoint(root, graph, checkpointInput(graph, { constraints: ["const source = 'must not enter checkpoint';"] })), (error) => error instanceof ContinuationCheckpointError && error.code === "unsafe-source-body-like-text");

    const created = createContinuationCheckpoint(root, graph, checkpointInput(graph), { now: "2026-07-18T08:30:00.000Z" });
    const target = path.join(root, CONTINUATION_CHECKPOINT_STORE_RELATIVE_PATH);
    const injected = JSON.parse(fs.readFileSync(target, "utf8"));
    injected.records[0].constraints = ["const source = 'must-not-be-served';"];
    injected.records[0].policy.privateReasoning = "must-not-be-served";
    fs.writeFileSync(target, JSON.stringify(injected), "utf8");
    const before = fs.readFileSync(target, "utf8");
    assert.equal(readContinuationCheckpointStore(root, graph.project.projectId).status, "invalid");
    assert.equal(listContinuationCheckpoints(root, graph).status, "unavailable");
    assert.throws(() => createContinuationCheckpoint(root, graph, checkpointInput(graph, { operationId: "checkpoint-must-not-overwrite", id: "checkpoint.must-not-overwrite" })), (error) => error instanceof ContinuationCheckpointError && error.code === "invalid-continuation-checkpoint-store");
    assert.equal(fs.readFileSync(target, "utf8"), before);
    assert.equal(created.checkpoint.id, "checkpoint.order-v1");

    const noSourceBasis = { ...graph, state: { ...graph.state, sourceFingerprint: null, sourceRevision: null } };
    assert.throws(() => sourceBaseline(noSourceBasis), (error) => error instanceof ContinuationCheckpointError && error.code === "baseline-unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
