"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepositoryScanner } = require("../../src/scanner");
const { createContextRef } = require("../../src/context-card");
const { createWorkRecord, getWorkTimeline } = require("../../src/delivery-graph");
const {
  WORKFLOW_STORE_RELATIVE_PATH,
  WorkflowEngineError,
  assignWorkflow,
  getWorkDependencyStatus,
  getWorkRecordWorkflow,
  listWorkflows,
  saveWorkflow,
  transitionWorkRecord,
} = require("../../src/workflow-engine");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-workflow-"));
  write(root, "package.json", JSON.stringify({ name: "workflow-fixture" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
  const graph = createRepositoryScanner(root).scan();
  const record = createWorkRecord(root, graph, {
    operationId: "create-workflow-story",
    id: "story.workflow-flow",
    kind: "task",
    title: "Verify workflow evidence gates",
    owner: "developer",
    contextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion)],
    createdBy: "developer",
    createdAt: "2026-07-18T08:00:00.000Z",
  }).record;
  return { root, graph, record };
}

function transition(root, graph, record, operationId, expectedState, targetState, evidence = []) {
  const minuteByState = { backlog: 10, planned: 11, implementing: 12, verifying: 13, reviewing: 14, released: 15 };
  return transitionWorkRecord(root, graph, {
    operationId,
    recordId: record.id,
    workflowId: "agile-default",
    expectedState,
    targetState,
    actor: "developer",
    actorRole: "developer",
    observedAt: `2026-07-18T08:${String(minuteByState[expectedState]).padStart(2, "0")}:00.000Z`,
    evidence,
  });
}

test("Agile workflow permits only evidence-gated transitions and leaves graph facts unchanged", () => {
  const { root, graph, record } = setup();
  try {
    const available = listWorkflows(root);
    assert.equal(available.status, "available");
    assert.deepEqual(available.workflows.slice(0, 2).map((workflow) => workflow.id), ["agile-default", "waterfall-default"]);
    assert.match(available.limitation, /do not execute work/);

    const assigned = assignWorkflow(root, graph, {
      operationId: "assign-agile-workflow",
      recordId: record.id,
      workflowId: "agile-default",
      actor: "developer",
      observedAt: "2026-07-18T08:01:00.000Z",
    });
    assert.equal(assigned.state, "backlog");
    transition(root, graph, record, "agile-backlog-planned", "backlog", "planned");
    transition(root, graph, record, "agile-planned-implementing", "planned", "implementing");
    assert.throws(() => transition(root, graph, record, "agile-missing-evidence", "implementing", "verifying"), (error) => error instanceof WorkflowEngineError && error.code === "missing-transition-evidence");
    transition(root, graph, record, "agile-implementing-verifying", "implementing", "verifying", [
      { kind: "implementation-graph", reference: `graph:${graph.project.projectId}@${graph.state.graphVersion}`, evidenceClass: "static-graph" },
      { kind: "change-impact", reference: "impact:local-static", evidenceClass: "static-context" },
    ]);
    transition(root, graph, record, "agile-verifying-reviewing", "verifying", "reviewing", [
      { kind: "test-result", reference: "declared:test-result:1", evidenceClass: "declared-observation" },
    ]);
    transition(root, graph, record, "agile-reviewing-released", "reviewing", "released", [
      { kind: "human-approval", reference: "approval:review-1", evidenceClass: "human-verified" },
      { kind: "release-evidence", reference: "release:local-1", evidenceClass: "declared-observation" },
    ]);
    const state = getWorkRecordWorkflow(root, graph, record.id);
    assert.equal(state.state.state, "released");
    assert.equal(state.state.workflowId, "agile-default");
    assert.match(state.limitation, /separate from repository parser facts/);
    assert.equal(graph.nodes.some((node) => node.id === record.id), false);
    assert.deepEqual(getWorkTimeline(root, graph, record.id).actualEvents.filter((event) => event.eventType === "workflow-transition").map((event) => event.workflow.toState), ["planned", "implementing", "verifying", "reviewing", "released"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("built-in implementation entry is blocked by declared dependency readiness without treating readiness as source proof", () => {
  const { root, graph, record: dependency } = setup();
  try {
    const consumer = createWorkRecord(root, graph, {
      operationId: "create-dependent-workflow-story",
      id: "task.dependent-workflow-flow",
      kind: "task",
      title: "Begin only after local dependency readiness",
      dependencies: [dependency.id],
      contextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion)],
      createdBy: "developer",
      createdAt: "2026-07-18T08:00:00.000Z",
    }).record;
    assignWorkflow(root, graph, { operationId: "assign-dependent-agile", recordId: consumer.id, workflowId: "agile-default", actor: "developer", observedAt: "2026-07-18T08:01:00.000Z" });
    transition(root, graph, consumer, "dependent-backlog-planned", "backlog", "planned");
    const initial = getWorkDependencyStatus(root, graph, consumer.id);
    assert.equal(initial.summary.readyToStart, false);
    assert.equal(initial.dependencies[0].status, "unknown");
    assert.match(initial.limitation, /does not prove source implementation/);
    assert.throws(() => transition(root, graph, consumer, "dependent-planned-implementing-blocked", "planned", "implementing"), (error) => error instanceof WorkflowEngineError && error.code === "work-dependencies-blocked");

    assignWorkflow(root, graph, { operationId: "assign-dependency-agile", recordId: dependency.id, workflowId: "agile-default", actor: "developer", observedAt: "2026-07-18T08:02:00.000Z" });
    transition(root, graph, dependency, "dependency-backlog-planned", "backlog", "planned");
    transition(root, graph, dependency, "dependency-planned-implementing", "planned", "implementing");
    transition(root, graph, dependency, "dependency-implementing-verifying", "implementing", "verifying", [
      { kind: "implementation-graph", reference: `graph:${graph.project.projectId}@${graph.state.graphVersion}`, evidenceClass: "static-graph" },
      { kind: "change-impact", reference: "impact:local-static", evidenceClass: "static-context" },
    ]);
    transition(root, graph, dependency, "dependency-verifying-reviewing", "verifying", "reviewing", [
      { kind: "test-result", reference: "declared:test-result:dependency", evidenceClass: "declared-observation" },
    ]);
    transition(root, graph, dependency, "dependency-reviewing-released", "reviewing", "released", [
      { kind: "human-approval", reference: "approval:dependency", evidenceClass: "human-verified" },
      { kind: "release-evidence", reference: "release:dependency", evidenceClass: "declared-observation" },
    ]);
    const ready = getWorkDependencyStatus(root, graph, consumer.id);
    assert.equal(ready.dependencies[0].status, "ready");
    assert.equal(ready.summary.readyToStart, true);
    transition(root, graph, consumer, "dependent-planned-implementing", "planned", "implementing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("custom workflows are validated, persisted, and cannot replace built-in templates", () => {
  const { root } = setup();
  try {
    const saved = saveWorkflow(root, {
      id: "team-lite",
      title: "Team Lite",
      initialState: "ready",
      states: ["ready", "done"],
      transitions: [{ from: "ready", to: "done", requiredEvidence: ["current-context"], roles: ["maintainer"] }],
    });
    assert.equal(saved.created, true);
    assert.equal(listWorkflows(root).workflows.find((workflow) => workflow.id === "team-lite").source, "local-custom");
    assert.ok(fs.existsSync(path.join(root, WORKFLOW_STORE_RELATIVE_PATH)));
    assert.throws(() => saveWorkflow(root, {
      id: "agile-default",
      title: "Override",
      initialState: "a",
      states: ["a", "b"],
      transitions: [{ from: "a", to: "b", requiredEvidence: [], roles: [] }],
    }), (error) => error instanceof WorkflowEngineError && error.code === "builtin-workflow-immutable");
    assert.throws(() => saveWorkflow(root, {
      id: "invalid-workflow",
      title: "Invalid",
      initialState: "ready",
      states: ["ready", "ready"],
      transitions: [],
    }), (error) => error instanceof WorkflowEngineError && error.code === "invalid-workflow");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
