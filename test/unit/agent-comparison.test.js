"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { evaluateAgentComparison, loadAgentComparisonRuns, normalizeRuns } = require("../../src/agent-comparison");
const { createContextRef } = require("../../src/context-card");
const { loadOrientationCases } = require("../../src/orientation-benchmark");

const ROOT = path.resolve(__dirname, "..", "..");
const CASES_FILE = path.join(ROOT, "benchmarks", "orientation-cases.json");
const TEMPLATE_FILE = path.join(ROOT, "benchmarks", "agent-comparison-runs.template.json");
const CASES = loadOrientationCases(CASES_FILE);

function execution(condition, overrides = {}) {
  const flopeek = condition === "flopeek" ? {
    projectId: "project:test-agent-comparison",
    graphVersion: 2,
    contextRefs: [createContextRef("project:test-agent-comparison", "flow", "example", 2)],
    toolsUsed: ["get_agent_bootstrap", "get_flow_projection", "get_related_tests"],
  } : null;
  return {
    id: `${condition}-run`,
    pairId: "pair-1",
    caseId: "locate-legacy-account-listing",
    condition,
    provider: { name: "provider-a", model: "model-1", sessionId: `${condition}-private-session` },
    durationMilliseconds: condition === "flopeek" ? 900 : 1200,
    context: { inspectedPaths: condition === "flopeek" ? ["src/app/api/accounts/route.ts", "src/legacy/manager.ts", "src/legacy/helper.ts", "test/accounts.test.ts"] : ["src/app/api/accounts/route.ts", "src/legacy/manager.ts"], estimatedCharacters: condition === "flopeek" ? 1200 : 2400, flopeek },
    answer: {
      targetPaths: condition === "flopeek" ? ["src/app/api/accounts/route.ts", "src/legacy/manager.ts", "src/legacy/helper.ts"] : ["src/app/api/accounts/route.ts", "src/legacy/manager.ts"],
      flowStepIds: condition === "flopeek" ? ["endpoint:src/app/api/accounts/route.ts:GET:/api/accounts", "symbol:src/app/api/accounts/route.ts:function:GET", "symbol:src/legacy/manager.ts:function:listAccounts", "symbol:src/legacy/helper.ts:function:loadAccounts"] : null,
      relatedTestPaths: condition === "flopeek" ? ["test/accounts.test.ts"] : [],
      staleContextStatuses: condition === "flopeek" ? ["stale"] : [],
      claimReviews: [{ id: "claim-1", category: "static-flow", outcome: "supported", evidenceRefs: condition === "flopeek" ? flopeek.contextRefs : ["oracle:locate-legacy-account-listing"] }],
    },
    verification: { status: condition === "flopeek" ? "passed" : "not-run", evidenceRefs: condition === "flopeek" ? ["test:test/accounts.test.ts"] : [] },
    cost: { currency: "USD", amount: condition === "flopeek" ? 0.02 : 0.03 },
    ...overrides,
  };
}

function completedRuns() {
  return {
    schemaVersion: "flopeek-agent-comparison-runs/v1",
    studyId: "test-study",
    status: "completed",
    consent: { explicit: true, privacyReviewed: true, source: "operator-supplied" },
    executions: [execution("direct-repository"), execution("flopeek")],
  };
}

test("checked agent comparison template remains explicitly not run", () => {
  const report = evaluateAgentComparison(ROOT, CASES, loadAgentComparisonRuns(TEMPLATE_FILE));
  assert.equal(report.status, "not-run");
  assert.equal(report.summary, null);
  assert.equal(report.providerExecutionInvokedByFlopeek, false);
  assert.match(report.conclusionBoundary, /not evidence/);
  assert.deepEqual(report, JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "agent-comparison-report.json"), "utf8")));
});

test("paired supplied provider outcomes are scored against the committed oracle without becoming graph truth", () => {
  const report = evaluateAgentComparison(ROOT, CASES, completedRuns());
  assert.equal(report.status, "measured-from-supplied-provider-executions");
  assert.equal(report.suite.pairsMeasured, 1);
  assert.equal(report.summary.directRepository.targets.recall, 0.666667);
  assert.equal(report.summary.flopeek.targets.recall, 1);
  assert.equal(report.summary.directRepository.flowSteps.status, "unavailable");
  assert.equal(report.summary.flopeek.flowSteps.recall, 1);
  assert.equal(report.summary.pairedDelta.relatedTestRecall, 1);
  assert.equal(report.summary.pairedDelta.meanDurationMilliseconds, -300);
  assert.equal(report.summary.flopeek.claimReview.unsupportedRate, 0);
  assert.equal(report.providerExecutionInvokedByFlopeek, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("flopeek-private-session"), false);
  assert.equal(serialized.includes(ROOT), false);
  assert.equal(serialized.includes("export async function GET"), false);
});

test("agent comparison rejects contaminated, unpaired, unsafe, and unconsented records", () => {
  const contaminated = completedRuns();
  contaminated.executions[0].context.flopeek = completedRuns().executions[1].context.flopeek;
  assert.throws(() => normalizeRuns(contaminated), /cannot declare Flopeek context/);
  const reused = completedRuns();
  reused.executions[1].provider.sessionId = reused.executions[0].provider.sessionId;
  assert.throws(() => evaluateAgentComparison(ROOT, CASES, reused), /distinct provider sessions/);
  const unsafe = completedRuns();
  unsafe.executions[0].context.inspectedPaths = ["C:\\private\\source.ts"];
  assert.throws(() => normalizeRuns(unsafe), /repository-relative/);
  const unconsented = completedRuns();
  unconsented.consent.explicit = false;
  assert.throws(() => normalizeRuns(unconsented), /explicit operator-supplied consent/);
  const sourceBody = completedRuns();
  sourceBody.executions[0].answer.source = "private source";
  assert.throws(() => normalizeRuns(sourceBody), /unknown fields: source/);
  const wrongProject = completedRuns();
  wrongProject.executions[1].context.flopeek.contextRefs = [createContextRef("another-project", "flow", "example", 2)];
  assert.throws(() => normalizeRuns(wrongProject), /different Flopeek project/);
  const futureRef = completedRuns();
  futureRef.executions[1].context.flopeek.contextRefs = [createContextRef("project:test-agent-comparison", "flow", "example", 3)];
  assert.throws(() => normalizeRuns(futureRef), /newer than the declared run graph/);
  const duplicateClaims = completedRuns();
  duplicateClaims.executions[0].answer.claimReviews.push(structuredClone(duplicateClaims.executions[0].answer.claimReviews[0]));
  assert.throws(() => normalizeRuns(duplicateClaims), /unique claim IDs/);
});

test("agent comparison CLI validates the template without invoking a provider", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "cli.js"), "evaluate", "agent-comparison", ROOT, "--cases", CASES_FILE, "--runs", TEMPLATE_FILE, "--format", "json"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "not-run");
  assert.equal(report.providerExecutionInvokedByFlopeek, false);
});
