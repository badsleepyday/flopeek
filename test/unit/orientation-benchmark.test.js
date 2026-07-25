"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { evaluateOrientation, loadOrientationCases, normalizeDefinition, treeSha256 } = require("../../src/orientation-benchmark");

const ROOT = path.resolve(__dirname, "..", "..");
const CASES_FILE = path.join(ROOT, "benchmarks", "orientation-cases.json");
const DEFINITION = loadOrientationCases(CASES_FILE);
let report;

test.before(() => {
  report = evaluateOrientation(ROOT, DEFINITION, { condition: "both" });
});

test("orientation benchmark separates direct retrieval, Flopeek evidence, and unrun studies", () => {
  assert.equal(report.schemaVersion, "flopeek-orientation-comparison/v2");
  assert.equal(report.suite.caseCount, 3);
  assert.equal(report.baseline.evidenceClass, "deterministic-retrieval");
  assert.equal(report.flopeek.evidenceClass, "deterministic-retrieval");
  assert.equal(report.baseline.studyEvidence.humanStudy.status, "not-run");
  assert.equal(report.baseline.studyEvidence.agentStudy.status, "not-run");
  assert.equal(report.flopeek.studyEvidence.humanStudy.status, "not-run");
  assert.equal(report.flopeek.studyEvidence.agentStudy.status, "not-run");
  assert.match(report.conclusionBoundary, /does not prove/);
});

test("pinned initial suite retrieves targets, ordered Flopeek steps, tests, and stale refs without inventing baseline flow order", () => {
  assert.equal(report.baseline.summary.correctTargetRetrieval.recall, 1);
  assert.equal(report.flopeek.summary.correctTargetRetrieval.recall, 1);
  assert.equal(report.baseline.summary.relatedTests.recall, 1);
  assert.equal(report.flopeek.summary.relatedTests.recall, 1);
  assert.equal(report.baseline.summary.flowSteps.status, "unavailable");
  assert.equal(report.flopeek.summary.flowSteps.recall, 1);
  assert.equal(report.flopeek.summary.flowSteps.exactCaseMatches, 3);
  assert.equal(report.baseline.summary.staleContextDetection.status, "unavailable");
  assert.equal(report.flopeek.summary.staleContextDetection.rate, 1);
  assert.equal(report.comparison.flowStepComparison.status, "not-comparable");
  assert.ok(report.baseline.repositories.every((repository) => repository.sourcePin.verified));
  assert.ok(report.baseline.repositories.every((repository) => repository.retrievalExclusions.includes("expectations.json")));
  assert.ok(report.baseline.repositories.every((repository) => repository.cases.every((item) => !item.metrics.context.paths.includes("expectations.json"))));
});

test("orientation reports disclose context accounting and return no source bodies or machine roots", () => {
  assert.equal(report.baseline.summary.context.tokenizerId, "flopeek-char4-estimator/v1");
  assert.equal(report.flopeek.summary.context.tokenizerId, "flopeek-char4-estimator/v1");
  assert.equal(report.baseline.summary.unsupportedClaims.status, "no-claims-emitted");
  assert.equal(report.flopeek.summary.unsupportedClaims.status, "no-claims-emitted");
  assert.equal(report.baseline.summary.timing.gating, false);
  assert.equal(report.flopeek.summary.timing.gating, false);
  assert.equal(report.flopeek.summary.timing.processStartupAndModuleLoad.status, "unavailable");
  assert.equal(report.flopeek.summary.timing.totalTimeToUsefulContextMilliseconds, Number((report.flopeek.summary.timing.repositoryPreparationMilliseconds + report.flopeek.summary.timing.caseRetrievalMilliseconds).toFixed(3)));
  assert.ok(report.flopeek.summary.timing.separateValidationMilliseconds > 0);
  assert.deepEqual(report.flopeek.summary.timing.preparationPhases.map((item) => item.phase), ["scope-and-identity", "source-analysis", "resolver-context", "graph-assembly"]);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(ROOT), false);
  assert.equal(serialized.includes("export async function GET"), false);
  assert.equal(serialized.includes("from payments.service import"), false);
  for (const repository of DEFINITION.repositories) assert.equal(fs.existsSync(path.join(ROOT, ...repository.path.split("/"), ".flopeek")), false);
});

test("orientation case validation rejects source drift and paths outside the suite", () => {
  const drifted = structuredClone(DEFINITION);
  drifted.repositories[0].sourcePin.value = "0".repeat(64);
  assert.throws(() => evaluateOrientation(ROOT, drifted, { condition: "baseline" }), /tree-sha256 mismatch/);
  const escaped = structuredClone(DEFINITION);
  escaped.repositories[0].path = "../outside";
  assert.throws(() => normalizeDefinition(escaped, ROOT), /outside the selected suite root/);
  assert.equal(treeSha256(path.join(ROOT, "test", "fixtures", "legacy-handoff")), DEFINITION.repositories[0].sourcePin.value);
});

test("orientation CLI emits the versioned Flopeek report", () => {
  const cli = path.join(ROOT, "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "evaluate", "orientation", ROOT, "--cases", CASES_FILE, "--condition", "flopeek", "--format", "json"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, "flopeek-orientation-benchmark/v2");
  assert.equal(payload.condition, "flopeek");
  assert.equal(payload.summary.caseCount, 3);
  assert.equal(payload.summary.flowSteps.recall, 1);
});
