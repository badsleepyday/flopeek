"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepositoryScanner } = require("../../src/scanner");
const { createContextRef } = require("../../src/context-card");
const {
  DELIVERY_STORE_RELATIVE_PATH,
  DeliveryGraphError,
  createWorkRecord,
  getWorkTimeline,
  listWorkRecords,
  readDeliveryStore,
  recordWorkEvent,
  updateWorkPlan,
} = require("../../src/delivery-graph");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function buildGraph(root) {
  write(root, "package.json", JSON.stringify({ name: "delivery-graph-fixture" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
  return createRepositoryScanner(root).scan();
}

function fixtureRecord(graph) {
  return {
    operationId: "delivery-create-order-story",
    id: "story.order-orientation",
    kind: "requirement",
    title: "Orient the order request flow",
    owner: "developer",
    contextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion)],
    plannedStart: "2026-07-18T08:00:00.000Z",
    plannedEnd: "2026-07-18T12:00:00.000Z",
    createdBy: "local developer",
    createdAt: "2026-07-18T07:30:00.000Z",
  };
}

test("Delivery Graph stores editable plans and append-only actual evidence without changing parser facts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-delivery-"));
  try {
    const graph = buildGraph(root);
    const created = createWorkRecord(root, graph, fixtureRecord(graph));
    assert.equal(created.record.kind, "requirement");
    assert.equal(created.event.eventType, "record-created");
    assert.equal(created.record.contextRefs[0].graphVersion, graph.state.graphVersion);
    assert.equal(createWorkRecord(root, graph, fixtureRecord(graph)).created, false);

    const updated = updateWorkPlan(root, graph, {
      operationId: "delivery-plan-order-story-v2",
      recordId: created.record.id,
      owner: "reviewer",
      plannedEnd: "2026-07-18T13:00:00.000Z",
      actor: "delivery planner",
      observedAt: "2026-07-18T08:15:00.000Z",
    });
    assert.equal(updated.record.planRevision, 2);
    assert.equal(updated.record.owner, "reviewer");
    assert.equal(updated.event.eventType, "plan-updated");
    assert.equal(updateWorkPlan(root, graph, {
      operationId: "delivery-plan-order-story-v2",
      recordId: created.record.id,
      owner: "reviewer",
      plannedEnd: "2026-07-18T13:00:00.000Z",
      actor: "delivery planner",
      observedAt: "2026-07-18T08:15:00.000Z",
    }).updated, false);

    const actual = recordWorkEvent(root, graph, {
      operationId: "delivery-evidence-order-story",
      recordId: created.record.id,
      eventType: "evidence-recorded",
      summary: "Static request context inspected.",
      actor: "developer",
      observedAt: "2026-07-18T08:20:00.000Z",
      evidence: [{ kind: "context-ref", reference: created.record.contextRefs[0].contextRef, evidenceClass: "static-context" }],
    });
    assert.equal(actual.created, true);
    assert.equal(recordWorkEvent(root, graph, {
      operationId: "delivery-evidence-order-story",
      recordId: created.record.id,
      eventType: "evidence-recorded",
      summary: "Static request context inspected.",
      actor: "developer",
      observedAt: "2026-07-18T08:20:00.000Z",
      evidence: [{ kind: "context-ref", reference: created.record.contextRefs[0].contextRef, evidenceClass: "static-context" }],
    }).created, false);

    const timeline = getWorkTimeline(root, graph, created.record.id);
    assert.equal(timeline.records[0].plan.plannedEnd, "2026-07-18T13:00:00.000Z");
    assert.deepEqual(timeline.actualEvents.map((event) => event.eventType), ["record-created", "plan-updated", "evidence-recorded"]);
    assert.match(timeline.limitation, /append-only/);
    const laterGraph = { ...graph, state: { ...graph.state, graphVersion: graph.state.graphVersion + 1 } };
    assert.equal(listWorkRecords(root, laterGraph).records[0].staleContextCount, 1);
    assert.equal(graph.nodes.some((node) => node.id === created.record.id), false);
    const stored = fs.readFileSync(path.join(root, DELIVERY_STORE_RELATIVE_PATH), "utf8");
    assert.equal(stored.includes("export async function"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Delivery Graph rejects wrong-project Context Refs, circular plans, and invalid persisted stores", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-delivery-invalid-"));
  try {
    const graph = buildGraph(root);
    const wrongProjectRef = createContextRef("another-project", "flow", "flow:other", 1);
    assert.throws(() => createWorkRecord(root, graph, { ...fixtureRecord(graph), contextRefs: [wrongProjectRef] }), (error) => error instanceof DeliveryGraphError && error.code === "wrong-project-id");

    const created = createWorkRecord(root, graph, fixtureRecord(graph));
    assert.throws(() => updateWorkPlan(root, graph, {
      operationId: "delivery-self-dependency",
      recordId: created.record.id,
      dependencies: [created.record.id],
      actor: "planner",
      observedAt: "2026-07-18T08:30:00.000Z",
    }), (error) => error instanceof DeliveryGraphError && error.code === "self-dependency");

    createWorkRecord(root, graph, {
      ...fixtureRecord(graph),
      operationId: "delivery-create-dependency-a",
      id: "task.dependency-a",
      dependencies: ["task.dependency-b"],
    });
    assert.throws(() => createWorkRecord(root, graph, {
      ...fixtureRecord(graph),
      operationId: "delivery-create-dependency-b",
      id: "task.dependency-b",
      dependencies: ["task.dependency-a"],
    }), (error) => error instanceof DeliveryGraphError && error.code === "circular-dependency");

    const target = path.join(root, DELIVERY_STORE_RELATIVE_PATH);
    const injected = JSON.parse(fs.readFileSync(target, "utf8"));
    injected.events[0].policy.privateReasoning = "must-not-be-served";
    fs.writeFileSync(target, JSON.stringify(injected), "utf8");
    assert.equal(readDeliveryStore(root, graph.project.projectId).status, "invalid");
    assert.equal(listWorkRecords(root, graph).status, "unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
