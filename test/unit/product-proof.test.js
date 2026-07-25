"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProductProof, loadOrientationProofEvidence, loadPublicProofEvidence, validateOrientationReport, validatePublicEvidence } = require("../../src/product-proof");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("public proof evidence matches its pinned relationship manifest and timing formulas", () => {
  const evidence = loadPublicProofEvidence();
  assert.equal(evidence.relationshipAudit.repositories, 5);
  assert.equal(evidence.relationshipAudit.auditedScopes, 14);
  assert.equal(evidence.relationshipAudit.expectedRelationships, 92);
  assert.equal(evidence.relationshipAudit.truePositives, 92);
  assert.equal(evidence.relationshipAudit.falsePositives, 0);
  assert.equal(evidence.relationshipAudit.falseNegatives, 0);
  assert.equal(evidence.relationshipAudit.precision, 1);
  assert.equal(evidence.relationshipAudit.recall, 1);
  assert.deepEqual(evidence.incrementalPerformance.rows.map((row) => row.speedup), [4.21, 1.67, 1.69, 54.53]);
});

test("public proof validation rejects claim drift and unpinned performance evidence", () => {
  const evidence = loadPublicProofEvidence();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "real-repository-corpus.json"), "utf8"));
  const wrongCount = structuredClone(evidence);
  wrongCount.relationshipAudit.expectedRelationships += 1;
  assert.throws(() => validatePublicEvidence(wrongCount, manifest), /totals do not match/);
  const wrongFormula = structuredClone(evidence);
  wrongFormula.incrementalPerformance.rows[0].speedup = 99;
  assert.throws(() => validatePublicEvidence(wrongFormula, manifest), /speedup does not match/);
  const unpinnedRevision = structuredClone(evidence);
  unpinnedRevision.incrementalPerformance.rows[0].revision = "unreviewed";
  assert.throws(() => validatePublicEvidence(unpinnedRevision, manifest), /not present in the pinned manifest/);
});

test("orientation proof validates raw per-case totals and keeps human and agent studies unrun", () => {
  const evidence = loadOrientationProofEvidence();
  assert.equal(evidence.suite.caseCount, 3);
  assert.equal(evidence.baseline.summary.correctTargetRetrieval.matched, 10);
  assert.equal(evidence.baseline.summary.flowSteps.status, "unavailable");
  assert.equal(evidence.flowpeek.summary.flowSteps.matchedInExpectedOrder, 14);
  assert.equal(evidence.flowpeek.summary.relatedTests.matched, 3);
  assert.equal(evidence.flowpeek.summary.staleContextDetection.detected, 3);
  assert.equal(evidence.evidenceClasses.humanStudy, "not-run");
  assert.equal(evidence.evidenceClasses.agentStudy, "not-run");

  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "orientation-flowpeek.json"), "utf8"));
  raw.summary.correctTargetRetrieval.matched -= 1;
  assert.throws(() => validateOrientationReport(raw, "flowpeek"), /target totals are inconsistent/);

  const flowDrift = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "orientation-flowpeek.json"), "utf8"));
  flowDrift.summary.flowSteps.matchedInExpectedOrder -= 1;
  assert.throws(() => validateOrientationReport(flowDrift, "flowpeek"), /flow totals are inconsistent/);

  const claimDrift = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "orientation-flowpeek.json"), "utf8"));
  claimDrift.studyEvidence.agentStudy.status = "measured";
  assert.throws(() => validateOrientationReport(claimDrift, "flowpeek"), /must not imply an executed human or agent study/);
});

test("product proof combines bounded public evidence with current repository facts and explicit non-claims", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-product-proof-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "product-proof-fixture" }));
    write(root, "src/health.routes.ts", "router.get('/health', () => ({ ok: true }));");
    const graph = scanRepository(root);
    const proof = createProductProof(graph, { generatedAt: "2026-07-15T00:00:00.000Z" });
    assert.equal(proof.schemaVersion, "flowpeek-product-proof/v1");
    assert.equal(proof.headlineMetrics.auditedRelationships, 92);
    assert.deepEqual(proof.headlineMetrics.measuredIncrementalSpeedup, { minimum: 1.67, maximum: 54.53, repositories: 4 });
    assert.deepEqual(proof.headlineMetrics.orientationRetrieval, { cases: 3, expectedTargets: 10, matchedTargets: 10, expectedFlowSteps: 14, matchedFlowSteps: 14, expectedRelatedTests: 3, matchedRelatedTests: 3, staleRefsRequested: 3, staleRefsDetected: 3, evidenceClass: "deterministic-retrieval" });
    assert.equal(proof.currentRepository.projectId, graph.project.projectId);
    assert.equal(proof.currentRepository.structuralParseRatio, 1);
    assert.equal(proof.localBenchmark.status, "not-run");
    assert.match(proof.localBenchmark.command, /^flowpeek proof/);
    assert.ok(proof.capabilityShowcase.some((feature) => feature.id === "shared-human-agent-context"));
    assert.equal(proof.claimBoundary.globalAccuracy, false);
    assert.equal(proof.claimBoundary.universalSpeedup, false);
    assert.equal(proof.claimBoundary.runtimeCorrectness, false);
    assert.equal(proof.claimBoundary.humanProductivityImprovement, false);
    assert.equal(proof.claimBoundary.agentOutcomeImprovement, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proof CLI returns the versioned report with an opt-in local benchmark", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-proof-cli-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "proof-cli-fixture" }));
    write(root, "src/example.ts", "export const example = true;");
    const stdout = execFileSync(process.execPath, [path.join(__dirname, "..", "..", "src", "cli.js"), "proof", root, "--iterations", "1", "--format", "json"], { encoding: "utf8" });
    const proof = JSON.parse(stdout);
    assert.equal(proof.schemaVersion, "flowpeek-product-proof/v1");
    assert.equal(proof.localBenchmark.status, "available");
    assert.equal(proof.localBenchmark.result.iterations, 1);
    assert.equal(proof.localBenchmark.result.project.name, "proof-cli-fixture");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
