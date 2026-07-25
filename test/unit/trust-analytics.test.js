"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanRepository } = require("../../src/scanner");
const { TRUST_ANALYTICS_SCHEMA, buildTrustAnalytics, ratio } = require("../../src/trust-analytics");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("trust analytics reports independent evidence signals without inventing a truth score", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-trust-analytics-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "trust-analytics-fixture" }));
    write(root, "src/orders/orders.routes.ts", "import { OrdersService } from './orders.service';\nrouter.post('/orders', () => OrdersService.create());");
    write(root, "src/orders/orders.service.ts", "export class OrdersService { static create() {} }");
    write(root, "src/orders/orders.service.spec.ts", "import { OrdersService } from './orders.service';\ntest('creates', () => OrdersService.create());");
    const graph = scanRepository(root);
    const report = buildTrustAnalytics(graph, {
      artifactCache: { status: "available", counts: { hits: 2, misses: 1, invalidated: 0, retainedUnaffected: 0 }, records: [{ freshnessStatus: "current" }], eventCatalog: { total: 3, returned: 3, omitted: 0, truncated: false } },
      runtimeEvidence: { status: "available", current: 1, stale: 0, retained: 1 },
      reviewImpact: { status: "available", counts: { current: 1, compatible: 0, stale: 0, detached: 0, unavailable: 0, missing: 0 } },
      semanticFeedback: { status: "available", totalMatched: 2, returned: 2, truncated: false, records: [{ decision: "accepted" }, { decision: "rejected" }] },
      agentEvidenceTraces: { status: "available", totalMatched: 1, returned: 1, truncated: false, records: [{ verification: { status: "passed" } }] },
      testRuns: { status: "available", totalMatched: 1, returned: 1, truncated: false, runs: [{ status: "passed" }] },
    }, { generatedAt: "2026-07-15T00:00:00.000Z" });

    assert.equal(report.schemaVersion, TRUST_ANALYTICS_SCHEMA);
    assert.equal(report.generatedAt, "2026-07-15T00:00:00.000Z");
    assert.equal(report.parserCoverage.structuralParseRatio, 1);
    assert.equal(report.flowEvidence.applicationFlows, 1);
    assert.equal(report.flowEvidence.evaluatedFlows, 1);
    assert.equal(report.flowEvidence.catalog.truncated, false);
    assert.ok(report.flowEvidence.displayedTransitions > 0);
    assert.ok(report.flowEvidence.directParserEvidenceTransitions > 0);
    assert.equal(report.freshness.humanVerification.reusableCoverageRatio, 1);
    assert.equal(report.evidenceAvailability.semanticFeedback.byDecision.accepted, 1);
    assert.equal(report.evidenceAvailability.testRuns.byStatus.passed, 1);
    assert.equal(report.readiness.completedTestEvidenceAvailable, true);
    assert.equal(report.qualityEvidence.liveRepositoryAccuracy.status, "unavailable");
    assert.equal(report.qualityEvidence.liveRepositoryAccuracy.precision, null);
    assert.equal(report.qualityEvidence.liveRepositoryAccuracy.recall, null);
    assert.equal(report.overallScore, null);
    assert.equal(report.claimBoundary.compositeTruthScore, false);
    assert.equal(report.claimBoundary.runtimeCorrectness, false);
    assert.equal(report.claimBoundary.businessIntentCorrectness, false);
    assert.doesNotMatch(JSON.stringify(report), /Azka|Bono|Cuna|Dana|Fara/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trust analytics uses null for ratios with no evidence denominator", () => {
  assert.equal(ratio(0, 0), null);
  const report = buildTrustAnalytics({
    project: { projectId: "project:test" },
    state: { graphVersion: 0, status: "unpersisted" },
    stats: {},
    analysis: { coverage: { summary: { scannedFiles: 0, parsedFiles: 0 } } },
    nodes: [],
    edges: [],
    flows: [],
  }, {}, { generatedAt: "2026-07-15T00:00:00.000Z" });
  assert.equal(report.parserCoverage.structuralParseRatio, null);
  assert.equal(report.flowEvidence.directEvidenceRatio, null);
  assert.equal(report.flowEvidence.directRelatedTestAvailabilityRatio, null);
  assert.equal(report.freshness.humanVerification.reusableCoverageRatio, null);
  assert.equal(report.readiness.structuralGraphAvailable, false);
  assert.equal(report.overallScore, null);
});

test("trust analytics discloses its application-flow evaluation bound", () => {
  const endpoint = { id: "endpoint:src/health.js:GET:/health", kind: "endpoint", type: "endpoint", label: "GET /health", path: "src/health.js", layer: "application", evidence: { parser: "fixture", file: "src/health.js" } };
  const flows = Array.from({ length: 205 }, (_, index) => ({
    id: `flow:${index}`,
    title: `GET /health/${index}`,
    entryId: endpoint.id,
    steps: [{ id: endpoint.id, label: endpoint.label, type: endpoint.type, depth: 0 }],
  }));
  const report = buildTrustAnalytics({
    project: { projectId: "project:bounded" },
    state: { graphVersion: 3, status: "current" },
    stats: { nodes: 1, edges: 0, endpoints: 1 },
    analysis: { coverage: { summary: { scannedFiles: 1, parsedFiles: 1 } } },
    nodes: [endpoint],
    edges: [],
    flows,
  }, {}, { generatedAt: "2026-07-15T00:00:00.000Z" });

  assert.deepEqual(report.flowEvidence.catalog, { total: 205, returned: 200, omitted: 5, truncated: true, maximumEvaluatedFlows: 200 });
  assert.equal(report.flowEvidence.evaluatedFlows, 200);
  assert.equal(report.flowEvidence.directEvidenceRatio, null);
});
