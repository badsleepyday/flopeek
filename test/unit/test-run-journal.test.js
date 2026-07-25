"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepositoryScanner, writeGraphCache } = require("../../src/scanner");
const { getFlowProjection, getTestRuns, recordTestRunEvent } = require("../../src/graph-service");
const { TestRunJournalError } = require("../../src/test-run-journal");

const RUNNER_FIXTURE = path.join(__dirname, "..", "fixtures", "runner-adapter", "failing-flow-sequence.json");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function event(lens, sequence, eventType, overrides = {}) {
  return {
    operationId: `run-1:${sequence}`,
    expectedFlowContextRef: lens.flow.contextRef,
    runId: "run-1",
    sequence,
    eventType,
    summary: `${eventType} observation`,
    runner: "fixture-adapter",
    actor: "CI runner",
    observedAt: new Date(Date.UTC(2026, 6, 15, 8, 0, sequence)).toISOString(),
    ...overrides,
  };
}

function fixtureEvent(lens, fixture, entry, sequence) {
  const overrides = {
    operationId: `${fixture.runId}:${sequence}`,
    runId: fixture.runId,
    summary: entry.summary,
    runner: fixture.runner,
    actor: fixture.actor,
  };
  if (entry.stepSelector === "last-flow-step") overrides.stepId = lens.steps.at(-1).id;
  return event(lens, sequence, entry.eventType, overrides);
}

test("test-run journal reports current and failing Flow Lens step without executing a command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-test-run-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "test-run-example" }));
    write(root, "src/app/api/orders/route.ts", "import { submit } from '../../../service';\nexport async function POST() { return submit(); }");
    write(root, "src/service.ts", "export function submit() { return true; }");
    const graph = createRepositoryScanner(root).scan();
    writeGraphCache(root, graph, { reason: "initial" });
    const flowId = graph.flows[0].id;
    const lens = getFlowProjection(graph, flowId);
    const stepId = lens.steps.at(-1).id;
    assert.equal(lens.flowInterface.request.status, "unavailable");
    assert.equal(lens.flowInterface.execution.status, "observation-only");
    assert.equal(lens.flowInterface.boundary.handler.status, "available");

    recordTestRunEvent(graph, flowId, event(lens, 0, "run-started"));
    const running = recordTestRunEvent(graph, flowId, event(lens, 1, "step-started", { stepId }));
    assert.equal(running.run.status, "running");
    assert.equal(running.run.currentStepId, stepId);
    const failed = recordTestRunEvent(graph, flowId, event(lens, 2, "step-failed", { stepId, summary: "Assertion failed before the service boundary." }));
    assert.equal(failed.run.status, "failed");
    assert.equal(failed.run.stoppedAtStepId, stepId);
    assert.throws(() => recordTestRunEvent(graph, flowId, event(lens, 3, "run-failed")), (error) => error instanceof TestRunJournalError && error.code === "test-run-terminal");

    const listed = getTestRuns(graph, { flowId });
    assert.equal(listed.runs[0].status, "failed");
    assert.equal(listed.runs[0].events.length, 3);
    assert.match(listed.limitation, /does not execute commands/);
    const stored = fs.readFileSync(path.join(root, ".flowpeek", "test-runs", "events.json"), "utf8");
    assert.equal(stored.includes("export function submit"), false);
    const target = path.join(root, ".flowpeek", "test-runs", "events.json");
    const injected = JSON.parse(stored);
    injected.events[0].policy.hiddenPayload = "must-not-be-served";
    fs.writeFileSync(target, JSON.stringify(injected), "utf8");
    assert.equal(getTestRuns(graph).status, "unavailable");
    assert.equal(fs.readFileSync(target, "utf8").includes("must-not-be-served"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("test-run journal rejects stale flow context and invalid step transitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-test-run-stale-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "test-run-stale" }));
    write(root, "src/route.ts", "router.get('/health', () => true);");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    const flowId = first.flows[0].id;
    const firstLens = getFlowProjection(first, flowId);
    assert.throws(() => recordTestRunEvent(first, flowId, event(firstLens, 0, "step-started", { stepId: firstLens.steps[0].id })), /begin with sequence 0/);

    write(root, "src/route.ts", "router.get('/health', () => false);");
    const second = scanner.scan(["src/route.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/route.ts"] });
    assert.throws(() => recordTestRunEvent(second, flowId, event(firstLens, 0, "run-started", { operationId: "stale-run" })), (error) => error.code === "stale-test-run-context" && error.statusCode === 409);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("published runner-adapter fixture reports a current and failing Flow Lens step", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-runner-fixture-"));
  try {
    const fixture = JSON.parse(fs.readFileSync(RUNNER_FIXTURE, "utf8"));
    assert.equal(fixture.schemaVersion, "flowpeek-runner-adapter-fixture/v1");
    assert.equal(Object.hasOwn(fixture, "command"), false);
    write(root, "package.json", JSON.stringify({ name: "runner-fixture-example" }));
    write(root, "src/app/api/reports/route.ts", "import { prepare } from '../../../report';\nexport async function GET() { return prepare(); }");
    write(root, "src/report.ts", "export function prepare() { return true; }");
    const graph = createRepositoryScanner(root).scan();
    writeGraphCache(root, graph, { reason: "initial" });
    const flowId = graph.flows[0].id;
    const lens = getFlowProjection(graph, flowId);
    let result;
    fixture.events.forEach((entry, sequence) => { result = recordTestRunEvent(graph, flowId, fixtureEvent(lens, fixture, entry, sequence)); });
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.stoppedAtStepId, lens.steps.at(-1).id);
    assert.equal(getTestRuns(graph, { flowId }).runs[0].currentStepId, lens.steps.at(-1).id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
