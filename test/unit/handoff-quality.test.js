"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { getFlowProjection, getHandoffQuality } = require("../../src/graph-service");
const { createRepositoryScanner, scanRepository, writeGraphCache } = require("../../src/scanner");

const FIXTURE = path.join(__dirname, "..", "fixtures", "legacy-handoff");
const BENCHMARK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "handoff-quality.json"), "utf8"));

function benchmarkCases(staleContextRef) {
  return { ...BENCHMARK, cases: BENCHMARK.cases.map((item, index) => index === 0 ? { ...item, staleContextRefs: [staleContextRef] } : item) };
}

test("legacy handoff quality gate measures bounded retrieval, stale detection, traceability, and honest outcome limits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-quality-"));
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    const scanner = createRepositoryScanner(root);
    const before = scanner.scan();
    writeGraphCache(root, before, { reason: "initial-quality-benchmark" });
    const endpoint = before.nodes.find((node) => node.kind === "endpoint" && node.label === "GET /api/accounts");
    const staleContextRef = createContextRef(before.project.projectId, "node", endpoint.id, before.state.graphVersion);
    fs.appendFileSync(path.join(root, "src", "legacy", "manager.ts"), "\n// topology-neutral handoff benchmark change\n");
    const current = scanner.scan(["src/legacy/manager.ts"]);
    writeGraphCache(root, current, { reason: "quality-benchmark-change", changedPaths: ["src/legacy/manager.ts"] });
    const report = getHandoffQuality(current, benchmarkCases(staleContextRef));

    assert.equal(report.schemaVersion, "flowpeek-handoff-quality/v1");
    assert.equal(report.qualityGate.status, "passed");
    assert.equal(report.summary.retrievalOutcomes.passed, 2);
    assert.equal(report.summary.contextSize.withinBudget, true);
    assert.equal(report.summary.sourceEvidenceTraceability.rate, 1);
    assert.equal(report.summary.staleContextDetection.requested, 1);
    assert.equal(report.summary.staleContextDetection.detected, 1);
    assert.equal(report.summary.agentTaskOutcomes.unavailable, 2);
    assert.equal(report.cases[0].location.deterministicInspectionStages, 3);
    assert.ok(report.cases.every((item) => item.contextSize.estimatedTokenCount <= item.contextSize.requestedTokenBudget));
    assert.ok(report.cases.every((item) => item.retrievalOutcome.runtimeClaim === false));
    assert.match(report.summary.retrievalOutcomes.limitation, /not whether an AI changed code correctly/);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("topology-neutral handoff benchmark change"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("handoff quality distinguishes declared agent outcomes from independent proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-outcome-"));
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    const graph = scanRepository(root);
    const report = getHandoffQuality(graph, {
      cases: [{
        id: "declared-agent-result",
        request: { taskIntent: "Locate account creation.", targetFlow: "POST /api/accounts", tokenBudget: 4096 },
        expected: { flowTitles: ["POST /api/accounts"] },
        agentTaskOutcome: { result: "passed", evidenceClass: "agent-declared" },
      }],
    });
    assert.equal(report.qualityGate.status, "passed");
    assert.equal(report.cases[0].agentTaskOutcome.status, "declared");
    assert.match(report.cases[0].agentTaskOutcome.limitation, /not independent proof/);
    assert.equal(report.summary.agentTaskOutcomes.declared, 1);
    assert.equal(report.summary.agentTaskOutcomes.suppliedEvidence, 0);
    assert.throws(() => getHandoffQuality(graph, {
      cases: [{
        id: "unsupported-human-claim",
        request: { taskIntent: "Locate account creation.", targetFlow: "POST /api/accounts", tokenBudget: 4096 },
        agentTaskOutcome: { result: "passed", evidenceClass: "human-verified" },
      }],
    }), /require a resolvable evidenceRef/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("handoff quality measures a consented privacy-minimized human locating observation without promoting it to verification", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-human-observation-"));
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    const graph = scanRepository(root);
    const flow = graph.flows.find((item) => item.title === "POST /api/accounts");
    const lens = getFlowProjection(graph, flow.id);
    const observation = {
      result: "located",
      evidenceClass: "human-observation",
      consent: "confirmed",
      participantRole: "inheriting-developer",
      observedDurationMs: 1850,
      evidenceRef: lens.flow.contextRef,
    };
    const report = getHandoffQuality(graph, {
      requireHumanHandoffObservation: true,
      cases: [{
        id: "consented-human-locating-result",
        request: { taskIntent: "Locate account creation.", targetFlow: "POST /api/accounts", tokenBudget: 4096 },
        expected: { flowTitles: ["POST /api/accounts"] },
        humanHandoffObservation: observation,
      }],
    });
    assert.equal(report.qualityGate.status, "passed");
    assert.equal(report.cases[0].humanHandoffObservation.status, "observed");
    assert.equal(report.cases[0].humanHandoffObservation.evidenceClass, "human-observation");
    assert.equal(report.summary.humanHandoffObservations.located, 1);
    assert.equal(report.summary.humanHandoffObservations.timeToLocate.medianObservedMilliseconds, 1850);
    assert.match(report.cases[0].humanHandoffObservation.limitation, /not flow verification/);
    assert.equal(JSON.stringify(report).includes(root), false);
    assert.throws(() => getHandoffQuality(graph, {
      cases: [{
        id: "unconsented-human-result",
        request: { taskIntent: "Locate account creation.", targetFlow: "POST /api/accounts", tokenBudget: 4096 },
        humanHandoffObservation: { ...observation, consent: "missing" },
      }],
    }), /consent: confirmed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
