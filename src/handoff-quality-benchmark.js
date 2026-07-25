#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createContextRef } = require("./context-card");
const { getHandoffQuality } = require("./graph-service");
const { createRepositoryScanner, writeGraphCache } = require("./scanner");

function runHandoffQualityBenchmark(projectRoot = path.join(__dirname, "..")) {
  const definition = JSON.parse(fs.readFileSync(path.join(projectRoot, "benchmarks", "handoff-quality.json"), "utf8"));
  const fixtureRoot = path.join(projectRoot, ...definition.fixture.split("/"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-handoff-quality-benchmark-"));
  try {
    fs.cpSync(fixtureRoot, temporaryRoot, { recursive: true });
    const scanner = createRepositoryScanner(temporaryRoot);
    const before = scanner.scan();
    writeGraphCache(temporaryRoot, before, { reason: "handoff-quality-baseline" });
    const endpoint = before.nodes.find((node) => node.kind === "endpoint" && node.label === definition.cases[0].expected.flowTitles[0]);
    if (!endpoint) throw new Error("The handoff quality fixture does not contain its declared first endpoint.");
    const staleContextRef = createContextRef(before.project.projectId, "node", endpoint.id, before.state.graphVersion);
    const changedPath = definition.cases.find((item) => item.request.changedPaths?.length)?.request.changedPaths[0];
    if (!changedPath) throw new Error("The handoff quality benchmark requires one declared changed path.");
    fs.appendFileSync(path.join(temporaryRoot, ...changedPath.split("/")), "\n// handoff quality stale-context probe\n");
    const current = scanner.scan([changedPath]);
    writeGraphCache(temporaryRoot, current, { reason: "handoff-quality-stale-probe", changedPaths: [changedPath] });
    const input = { ...definition, cases: definition.cases.map((item, index) => index === 0 ? { ...item, staleContextRefs: [staleContextRef] } : item) };
    return getHandoffQuality(current, input);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function humanSummary(report) {
  return [
    `Handoff quality gate: ${report.qualityGate.status}`,
    `Retrieval outcomes: ${report.summary.retrievalOutcomes.passed}/${report.summary.caseCount} passed`,
    `Context budget: ${report.summary.contextSize.estimatedTokens}/${report.summary.contextSize.requestedTokens} estimated tokens`,
    `Evidence traceability: ${report.summary.sourceEvidenceTraceability.resolvedRefs}/${report.summary.sourceEvidenceTraceability.totalRefs} refs resolved`,
    `Stale detection: ${report.summary.staleContextDetection.detected}/${report.summary.staleContextDetection.requested}`,
    `Observed composition time: ${report.summary.timing.observedCompositionMilliseconds} ms (non-gating)`,
    `Agent outcomes: ${report.summary.agentTaskOutcomes.declared} declared, ${report.summary.agentTaskOutcomes.suppliedEvidence} supplied evidence, ${report.summary.agentTaskOutcomes.unavailable} unavailable`,
    "Retrieval success is not an AI coding-task outcome or runtime proof.",
  ].join("\n");
}

if (require.main === module) {
  try {
    const report = runHandoffQualityBenchmark();
    process.stdout.write(process.argv.includes("--format=json") ? `${JSON.stringify(report, null, 2)}\n` : `${humanSummary(report)}\n`);
    if (report.qualityGate.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { humanSummary, runHandoffQualityBenchmark };
